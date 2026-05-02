const express = require('express');
const bcrypt = require('bcryptjs');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const { query } = require('../services/database');
const logger = require('../utils/logger');

const router = express.Router();

// Get system settings and current user info
router.get('/', authenticateToken, async (req, res) => {
    try {
        const stats = {
            version: '1.0.0',
            node_version: process.version,
            platform: process.platform,
            uptime: process.uptime(),
            duckdns_root: process.env.DUCKDNS_ROOT_DOMAIN || 'duckdns.org'
        };
        
        const userInfo = await query(`
            SELECT u.id, u.email, u.is_admin, u.created_at, u.plan_id, p.name as plan_name,
                   p.max_projects, p.max_databases, p.max_storage_mb, p.can_use_duckdns
            FROM users u 
            LEFT JOIN plans p ON u.plan_id = p.id 
            WHERE u.id = $1
        `, [req.user.userId]);
        
        res.json({
            stats,
            user: userInfo.rows[0]
        });
    } catch (error) {
        logger.error('Get settings error:', error);
        res.status(500).json({ error: 'Failed to fetch settings' });
    }
});

// Plans management (Admin only)
router.get('/plans', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const result = await query('SELECT * FROM plans ORDER BY id ASC');
        res.json({ plans: result.rows });
    } catch (error) {
        logger.error('Fetch plans error:', error);
        res.status(500).json({ error: 'Failed to fetch plans' });
    }
});

// Change password
router.post('/change-password', authenticateToken, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        
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

router.post('/plans', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { name, max_projects, max_databases, max_storage_mb, can_use_duckdns, can_use_custom_env } = req.body;
        const result = await query(
            'INSERT INTO plans (name, max_projects, max_databases, max_storage_mb, can_use_duckdns, can_use_custom_env) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
            [name, max_projects, max_databases, max_storage_mb, can_use_duckdns, can_use_custom_env]
        );
        res.status(201).json({ plan: result.rows[0] });
    } catch (error) {
        logger.error('Create plan error:', error);
        res.status(500).json({ error: 'Failed to create plan' });
    }
});

router.put('/plans/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { name, max_projects, max_databases, max_storage_mb, can_use_duckdns, can_use_custom_env } = req.body;
        const result = await query(
            'UPDATE plans SET name = $1, max_projects = $2, max_databases = $3, max_storage_mb = $4, can_use_duckdns = $5, can_use_custom_env = $6 WHERE id = $7 RETURNING *',
            [name, max_projects, max_databases, max_storage_mb, can_use_duckdns, can_use_custom_env, req.params.id]
        );
        res.json({ plan: result.rows[0] });
    } catch (error) {
        logger.error('Update plan error:', error);
        res.status(500).json({ error: 'Failed to update plan' });
    }
});

// User management (Admin only)
router.get('/users', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const result = await query(`
            SELECT u.id, u.email, u.is_admin, u.created_at, u.plan_id, p.name as plan_name 
            FROM users u 
            LEFT JOIN plans p ON u.plan_id = p.id 
            ORDER BY u.created_at DESC
        `);
        res.json({ users: result.rows });
    } catch (error) {
        logger.error('Fetch users error:', error);
        res.status(500).json({ error: 'Failed to fetch users' });
    }
});

router.post('/users', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { email, password, isAdmin, planId } = req.body;
        
        const existing = await query('SELECT * FROM users WHERE email = $1', [email]);
        if (existing.rows.length > 0) {
            return res.status(400).json({ error: 'User already exists' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const result = await query(
            'INSERT INTO users (email, password, is_admin, plan_id) VALUES ($1, $2, $3, $4) RETURNING id, email, is_admin, plan_id',
            [email, hashedPassword, isAdmin || false, planId]
        );

        res.status(201).json({ user: result.rows[0] });
    } catch (error) {
        logger.error('Create user error:', error);
        res.status(500).json({ error: 'Failed to create user' });
    }
});

router.put('/users/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { isAdmin, planId } = req.body;
        await query('UPDATE users SET is_admin = $1, plan_id = $2 WHERE id = $3', [isAdmin, planId, req.params.id]);
        res.json({ message: 'User updated successfully' });
    } catch (error) {
        logger.error('Update user error:', error);
        res.status(500).json({ error: 'Failed to update user' });
    }
});

router.delete('/users/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        if (parseInt(id) === req.user.userId) {
            return res.status(400).json({ error: 'Cannot delete yourself' });
        }
        
        await query('DELETE FROM users WHERE id = $1', [id]);
        res.json({ message: 'User deleted successfully' });
    } catch (error) {
        logger.error('Delete user error:', error);
        res.status(500).json({ error: 'Failed to delete user' });
    }
});

module.exports = router;
