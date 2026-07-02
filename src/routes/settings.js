const express = require('express');
const bcrypt = require('bcryptjs');
const { authenticateToken, requireAdmin, requirePermission } = require('../middleware/auth');
const { query } = require('../services/database');
const logger = require('../utils/logger');

const router = express.Router();

// ========== System Settings & User Profile ==========

router.get('/', authenticateToken, async (req, res) => {
    try {
        const userInfo = await query(`
            SELECT u.id, u.email, u.role_id, u.created_at, u.plan_id, u.disk_usage_bytes,
                   p.name as plan_name, p.max_projects, p.max_databases, p.max_storage_mb,
                   p.can_use_custom_domains, p.can_use_custom_env, p.can_use_cron_jobs, p.can_use_docker,
                   p.max_cpu_cores, p.max_memory_mb, p.max_bandwidth_gb,
                   r.name as role_name, r.display_name as role_display_name, r.color as role_color
            FROM users u
            LEFT JOIN plans p ON u.plan_id = p.id
            LEFT JOIN roles r ON u.role_id = r.id
            WHERE u.id = $1
        `, [req.user.userId]);

        const settingsResult = await query("SELECT value FROM platform_settings WHERE key = 'platform_name'");
        const domainResult = await query("SELECT value FROM platform_settings WHERE key = 'default_domain'");
        const cdnDomainResult = await query("SELECT value FROM platform_settings WHERE key = 'cdn_domain'");
        const platformUrlResult = await query("SELECT value FROM platform_settings WHERE key = 'platform_url'");

        let cdnDomain = cdnDomainResult.rows[0]?.value || '';
        if (!cdnDomain) {
            cdnDomain = platformUrlResult.rows[0]?.value || '';
        }

        res.json({
            stats: {
                version: '2.0.0',
                node_version: process.version,
                platform: process.platform,
                uptime: process.uptime(),
                platform_name: settingsResult.rows[0]?.value || 'OpenHost',
                default_domain: domainResult.rows[0]?.value || 'openhost.com',
                cdn_domain: cdnDomain.replace(/\/+$/, ''),
                platform_url: platformUrlResult.rows[0]?.value || '',
            },
            user: userInfo.rows[0]
        });
    } catch (error) {
        logger.error('Get settings error:', error);
        res.status(500).json({ error: 'Failed to fetch settings' });
    }
});

router.post('/change-password', authenticateToken, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;

        if (!currentPassword || !newPassword) {
            return res.status(400).json({ error: 'Both passwords are required' });
        }

        if (newPassword.length < 8) {
            return res.status(400).json({ error: 'New password must be at least 8 characters' });
        }

        const result = await query('SELECT password FROM users WHERE id = $1', [req.user.userId]);
        const user = result.rows[0];

        if (!user || !(await bcrypt.compare(currentPassword, user.password))) {
            return res.status(401).json({ error: 'Invalid current password' });
        }

        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await query('UPDATE users SET password = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [hashedPassword, req.user.userId]);

        res.json({ message: 'Password updated successfully' });
    } catch (error) {
        logger.error('Change password error:', error);
        res.status(500).json({ error: 'Failed to change password' });
    }
});

// ========== Plans Management ==========

router.get('/plans', authenticateToken, async (req, res) => {
    try {
        const result = await query('SELECT * FROM plans ORDER BY priority ASC, id ASC');
        res.json({ plans: result.rows });
    } catch (error) {
        logger.error('Fetch plans error:', error);
        res.status(500).json({ error: 'Failed to fetch plans' });
    }
});

router.post('/plans', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { name, max_projects, max_databases, max_storage_mb, max_cpu_cores, max_memory_mb, max_bandwidth_gb,
                can_use_custom_domains, can_use_custom_env, can_use_cron_jobs, can_use_docker, priority } = req.body;

        if (!name) return res.status(400).json({ error: 'Plan name is required' });

        const result = await query(
            `INSERT INTO plans (name, max_projects, max_databases, max_storage_mb, max_cpu_cores, max_memory_mb, max_bandwidth_gb,
             can_use_custom_domains, can_use_custom_env, can_use_cron_jobs, can_use_docker, priority)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
            [name, max_projects || 3, max_databases || 2, max_storage_mb || 500, max_cpu_cores || 0.5,
             max_memory_mb || 512, max_bandwidth_gb || 10, can_use_custom_domains || false,
             can_use_custom_env !== false, can_use_cron_jobs || false, can_use_docker || false, priority || 0]
        );

        await auditLog(req.user.userId, 'plan.created', 'plan', result.rows[0].id, { name });
        res.status(201).json({ plan: result.rows[0] });
    } catch (error) {
        logger.error('Create plan error:', error);
        if (error.code === '23505') return res.status(400).json({ error: 'Plan name already exists' });
        res.status(500).json({ error: 'Failed to create plan' });
    }
});

router.put('/plans/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { name, max_projects, max_databases, max_storage_mb, max_cpu_cores, max_memory_mb, max_bandwidth_gb,
                can_use_custom_domains, can_use_custom_env, can_use_cron_jobs, can_use_docker, priority } = req.body;

        const result = await query(
            `UPDATE plans SET name=$1, max_projects=$2, max_databases=$3, max_storage_mb=$4, max_cpu_cores=$5,
             max_memory_mb=$6, max_bandwidth_gb=$7, can_use_custom_domains=$8, can_use_custom_env=$9,
             can_use_cron_jobs=$10, can_use_docker=$11, priority=$12 WHERE id=$13 RETURNING *`,
            [name, max_projects, max_databases, max_storage_mb, max_cpu_cores, max_memory_mb, max_bandwidth_gb,
             can_use_custom_domains, can_use_custom_env, can_use_cron_jobs, can_use_docker, priority, req.params.id]
        );

        if (result.rows.length === 0) return res.status(404).json({ error: 'Plan not found' });

        await auditLog(req.user.userId, 'plan.updated', 'plan', parseInt(req.params.id), { name });
        res.json({ plan: result.rows[0] });
    } catch (error) {
        logger.error('Update plan error:', error);
        res.status(500).json({ error: 'Failed to update plan' });
    }
});

router.delete('/plans/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const count = await query('SELECT COUNT(*) FROM plans');
        if (parseInt(count.rows[0].count) <= 1) {
            return res.status(400).json({ error: 'Cannot delete the last remaining plan' });
        }

        const anotherPlan = await query('SELECT id FROM plans WHERE id <> $1 ORDER BY priority ASC LIMIT 1', [id]);
        if (anotherPlan.rows.length > 0) {
            await query('UPDATE users SET plan_id = $1 WHERE plan_id = $2', [anotherPlan.rows[0].id, id]);
        }

        await query('DELETE FROM plans WHERE id = $1', [id]);
        await auditLog(req.user.userId, 'plan.deleted', 'plan', parseInt(id), {});
        res.json({ message: 'Plan deleted successfully' });
    } catch (error) {
        logger.error('Delete plan error:', error);
        res.status(500).json({ error: 'Failed to delete plan' });
    }
});

// ========== User Management (Admin) ==========

router.get('/users', authenticateToken, requirePermission('users.view'), async (req, res) => {
    try {
        const result = await query(`
            SELECT u.id, u.email, u.role_id, u.created_at, u.plan_id, u.suspended, u.suspended_reason,
                   u.disk_usage_bytes, u.last_login_at,
                   p.name as plan_name, r.name as role_name, r.display_name as role_display_name, r.color as role_color,
                   (SELECT COUNT(*) FROM projects WHERE user_id = u.id) as project_count,
                   (SELECT COUNT(*) FROM databases WHERE user_id = u.id) as db_count
            FROM users u
            LEFT JOIN plans p ON u.plan_id = p.id
            LEFT JOIN roles r ON u.role_id = r.id
            ORDER BY u.created_at DESC
        `);
        res.json({ users: result.rows });
    } catch (error) {
        logger.error('Fetch users error:', error);
        res.status(500).json({ error: 'Failed to fetch users' });
    }
});

router.post('/users', authenticateToken, requirePermission('users.create'), async (req, res) => {
    try {
        const { email, password, roleId, planId } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }

        const existing = await query('SELECT * FROM users WHERE email = $1', [email]);
        if (existing.rows.length > 0) {
            return res.status(400).json({ error: 'User already exists' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const result = await query(
            'INSERT INTO users (email, password, role_id, plan_id) VALUES ($1, $2, $3, $4) RETURNING id, email, role_id, plan_id',
            [email, hashedPassword, roleId, planId]
        );

        await auditLog(req.user.userId, 'user.created', 'user', result.rows[0].id, { email });
        res.status(201).json({ user: result.rows[0] });
    } catch (error) {
        logger.error('Create user error:', error);
        res.status(500).json({ error: 'Failed to create user' });
    }
});

router.put('/users/:id', authenticateToken, requirePermission('users.edit'), async (req, res) => {
    try {
        const { roleId, planId, suspended, suspendedReason } = req.body;
        const userId = parseInt(req.params.id);

        if (userId === req.user.userId && suspended) {
            return res.status(400).json({ error: 'Cannot suspend yourself' });
        }

        await query(
            'UPDATE users SET role_id = $1, plan_id = $2, suspended = $3, suspended_reason = $4, updated_at = CURRENT_TIMESTAMP WHERE id = $5',
            [roleId, planId, suspended || false, suspendedReason || null, userId]
        );

        await auditLog(req.user.userId, 'user.updated', 'user', userId, { roleId, planId, suspended });
        res.json({ message: 'User updated successfully' });
    } catch (error) {
        logger.error('Update user error:', error);
        res.status(500).json({ error: 'Failed to update user' });
    }
});

router.delete('/users/:id', authenticateToken, requirePermission('users.delete'), async (req, res) => {
    try {
        const { id } = req.params;
        if (parseInt(id) === req.user.userId) {
            return res.status(400).json({ error: 'Cannot delete yourself' });
        }

        await query('DELETE FROM users WHERE id = $1', [id]);
        await auditLog(req.user.userId, 'user.deleted', 'user', parseInt(id), {});
        res.json({ message: 'User deleted successfully' });
    } catch (error) {
        logger.error('Delete user error:', error);
        res.status(500).json({ error: 'Failed to delete user' });
    }
});

// Admin view any user's resources
router.get('/users/:id/projects', authenticateToken, requirePermission('users.view'), async (req, res) => {
    try {
        const result = await query('SELECT * FROM projects WHERE user_id = $1 ORDER BY created_at DESC', [req.params.id]);
        res.json({ projects: result.rows });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch user projects' });
    }
});

router.get('/users/:id/databases', authenticateToken, requirePermission('users.view'), async (req, res) => {
    try {
        const result = await query('SELECT * FROM databases WHERE user_id = $1 ORDER BY created_at DESC', [req.params.id]);
        res.json({ databases: result.rows });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch user databases' });
    }
});

// ========== Roles & Permissions Management ==========

router.get('/roles', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const roles = await query('SELECT * FROM roles ORDER BY id ASC');
        res.json({ roles: roles.rows });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch roles' });
    }
});

router.get('/roles/:id/permissions', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const result = await query(
            `SELECT p.* FROM permissions p
             LEFT JOIN role_permissions rp ON p.id = rp.permission_id AND rp.role_id = $1
             ORDER BY p.category, p.name`,
            [req.params.id]
        );

        const assigned = await query(
            'SELECT permission_id FROM role_permissions WHERE role_id = $1',
            [req.params.id]
        );
        const assignedIds = new Set(assigned.rows.map(r => r.permission_id));

        const permissions = result.rows.map(p => ({
            ...p,
            assigned: assignedIds.has(p.id)
        }));

        res.json({ permissions });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch permissions' });
    }
});

router.post('/roles', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { name, display_name, color, permissionIds } = req.body;

        if (!name || !display_name) {
            return res.status(400).json({ error: 'Name and display_name are required' });
        }

        const result = await query(
            'INSERT INTO roles (name, display_name, color) VALUES ($1, $2, $3) RETURNING *',
            [name, display_name, color || '#6b7280']
        );

        const roleId = result.rows[0].id;

        if (permissionIds && Array.isArray(permissionIds)) {
            for (const permId of permissionIds) {
                await query('INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [roleId, permId]);
            }
        }

        await auditLog(req.user.userId, 'role.created', 'role', roleId, { name });
        res.status(201).json({ role: result.rows[0] });
    } catch (error) {
        if (error.code === '23505') return res.status(400).json({ error: 'Role name already exists' });
        res.status(500).json({ error: 'Failed to create role' });
    }
});

router.put('/roles/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { display_name, color, permissionIds } = req.body;
        const roleId = parseInt(req.params.id);

        await query('UPDATE roles SET display_name = $1, color = $2 WHERE id = $3', [display_name, color, roleId]);

        if (permissionIds && Array.isArray(permissionIds)) {
            await query('DELETE FROM role_permissions WHERE role_id = $1', [roleId]);
            for (const permId of permissionIds) {
                await query('INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [roleId, permId]);
            }
        }

        await auditLog(req.user.userId, 'role.updated', 'role', roleId, { display_name });
        res.json({ message: 'Role updated successfully' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to update role' });
    }
});

router.delete('/roles/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const roleId = parseInt(req.params.id);

        const role = await query('SELECT * FROM roles WHERE id = $1', [roleId]);
        if (role.rows.length === 0) return res.status(404).json({ error: 'Role not found' });
        if (role.rows[0].is_system) return res.status(400).json({ error: 'Cannot delete system roles' });

        // Reassign users to 'user' role
        const userRole = await query("SELECT id FROM roles WHERE name = 'user'");
        if (userRole.rows.length > 0) {
            await query('UPDATE users SET role_id = $1 WHERE role_id = $2', [userRole.rows[0].id, roleId]);
        }

        await query('DELETE FROM roles WHERE id = $1', [roleId]);
        await auditLog(req.user.userId, 'role.deleted', 'role', roleId, {});
        res.json({ message: 'Role deleted successfully' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete role' });
    }
});

// ========== Platform Settings (Admin) ==========

router.get('/platform-settings', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const result = await query('SELECT * FROM platform_settings ORDER BY category, key');
        const settings = {};
        for (const row of result.rows) {
            if (!settings[row.category]) settings[row.category] = {};
            settings[row.category][row.key] = {
                value: row.value,
                type: row.type,
                description: row.description
            };
        }
        res.json({ settings });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch platform settings' });
    }
});

router.put('/platform-settings', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { settings } = req.body;

        for (const [key, value] of Object.entries(settings)) {
            await query(
                'UPDATE platform_settings SET value = $1, updated_at = CURRENT_TIMESTAMP WHERE key = $2',
                [String(value), key]
            );
        }

        await auditLog(req.user.userId, 'settings.updated', 'platform', null, { keys: Object.keys(settings) });
        res.json({ message: 'Settings updated successfully' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to update settings' });
    }
});

// ========== Admin Approvals ==========

router.get('/approvals', authenticateToken, requirePermission('approvals.review'), async (req, res) => {
    try {
        const status = req.query.status || 'pending';
        const result = await query(
            `SELECT a.*, u.email as user_email, r.reviewed_by_email
             FROM admin_approvals a
             JOIN users u ON a.user_id = u.id
             LEFT JOIN (SELECT id, email as reviewed_by_email FROM users) r ON a.reviewed_by = r.id
             WHERE a.status = $1
             ORDER BY a.created_at DESC`,
            [status]
        );
        res.json({ approvals: result.rows });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch approvals' });
    }
});

router.post('/approvals/:id/approve', authenticateToken, requirePermission('approvals.review'), async (req, res) => {
    try {
        const { review_note } = req.body;
        const result = await query(
            `UPDATE admin_approvals SET status = 'approved', reviewed_by = $1, review_note = $2, reviewed_at = CURRENT_TIMESTAMP
             WHERE id = $3 AND status = 'pending' RETURNING *`,
            [req.user.userId, review_note || null, req.params.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Approval not found or already processed' });
        }

        await auditLog(req.user.userId, 'approval.approved', 'approval', parseInt(req.params.id), { resource_type: result.rows[0].resource_type });
        res.json({ approval: result.rows[0] });
    } catch (error) {
        res.status(500).json({ error: 'Failed to approve request' });
    }
});

router.post('/approvals/:id/reject', authenticateToken, requirePermission('approvals.review'), async (req, res) => {
    try {
        const { review_note } = req.body;
        const result = await query(
            `UPDATE admin_approvals SET status = 'rejected', reviewed_by = $1, review_note = $2, reviewed_at = CURRENT_TIMESTAMP
             WHERE id = $3 AND status = 'pending' RETURNING *`,
            [req.user.userId, review_note || null, req.params.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Approval not found or already processed' });
        }

        await auditLog(req.user.userId, 'approval.rejected', 'approval', parseInt(req.params.id), { resource_type: result.rows[0].resource_type });
        res.json({ approval: result.rows[0] });
    } catch (error) {
        res.status(500).json({ error: 'Failed to reject request' });
    }
});

// ========== Custom Domains ==========

router.get('/domains', authenticateToken, async (req, res) => {
    try {
        let sql, params;
        if (req.user.isAdmin) {
            sql = `SELECT cd.*, p.name as project_name, u.email as owner_email
                   FROM custom_domains cd
                   LEFT JOIN projects p ON cd.project_id = p.id
                   LEFT JOIN users u ON cd.user_id = u.id
                   ORDER BY cd.created_at DESC`;
            params = [];
        } else {
            sql = `SELECT cd.*, p.name as project_name
                   FROM custom_domains cd
                   LEFT JOIN projects p ON cd.project_id = p.id
                   WHERE cd.user_id = $1
                   ORDER BY cd.created_at DESC`;
            params = [req.user.userId];
        }
        const result = await query(sql, params);
        res.json({ domains: result.rows });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch domains' });
    }
});

router.post('/domains', authenticateToken, async (req, res) => {
    try {
        const { domain, projectId } = req.body;

        if (!domain) return res.status(400).json({ error: 'Domain is required' });

        // Check if user has permission for custom domains
        const userPlan = await query(
            'SELECT p.can_use_custom_domains FROM users u JOIN plans p ON u.plan_id = p.id WHERE u.id = $1',
            [req.user.userId]
        );
        if (userPlan.rows.length > 0 && !userPlan.rows[0].can_use_custom_domains) {
            return res.status(403).json({ error: 'Your plan does not support custom domains' });
        }

        const verificationToken = require('crypto').randomBytes(32).toString('hex');
        const result = await query(
            'INSERT INTO custom_domains (user_id, domain, project_id, verification_token) VALUES ($1, $2, $3, $4) RETURNING *',
            [req.user.userId, domain, projectId || null, verificationToken]
        );

        res.status(201).json({ domain: result.rows[0] });
    } catch (error) {
        if (error.code === '23505') return res.status(400).json({ error: 'Domain already registered' });
        res.status(500).json({ error: 'Failed to add domain' });
    }
});

router.delete('/domains/:id', authenticateToken, async (req, res) => {
    try {
        const sql = req.user.isAdmin
            ? 'DELETE FROM custom_domains WHERE id = $1 RETURNING *'
            : 'DELETE FROM custom_domains WHERE id = $1 AND user_id = $2 RETURNING *';
        const params = req.user.isAdmin
            ? [req.params.id]
            : [req.params.id, req.user.userId];

        const result = await query(sql, params);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Domain not found' });
        res.json({ message: 'Domain removed' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete domain' });
    }
});

// ========== Audit Log ==========

router.get('/audit-log', authenticateToken, requirePermission('audit.view'), async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 100, 500);
        const offset = parseInt(req.query.offset) || 0;

        const result = await query(
            `SELECT a.*, u.email as user_email
             FROM audit_log a
             LEFT JOIN users u ON a.user_id = u.id
             ORDER BY a.created_at DESC
             LIMIT $1 OFFSET $2`,
            [limit, offset]
        );

        const countResult = await query('SELECT COUNT(*) FROM audit_log');

        res.json({
            entries: result.rows,
            total: parseInt(countResult.rows[0].count),
            limit,
            offset
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch audit log' });
    }
});

// ========== All Permissions List ==========

router.get('/permissions', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const result = await query('SELECT * FROM permissions ORDER BY category, name');
        res.json({ permissions: result.rows });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch permissions' });
    }
});

// ========== Helper: Audit Log ==========

async function auditLog(userId, action, resourceType, resourceId, details) {
    try {
        await query(
            'INSERT INTO audit_log (user_id, action, resource_type, resource_id, details) VALUES ($1, $2, $3, $4, $5)',
            [userId, action, resourceType, resourceId, JSON.stringify(details)]
        );
    } catch (error) {
        logger.error('Audit log error:', error);
    }
}

module.exports = router;
