const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../services/database');
const { authenticateToken, requirePermission } = require('../middleware/auth');
const deploymentService = require('../services/deployment');
const logger = require('../utils/logger');

const router = express.Router();

// Get all projects
router.get('/', authenticateToken, async (req, res) => {
    try {
        let sql, params;

        if (req.user.isAdmin || req.user.isModerator) {
            sql = `
                SELECT p.*, u.email as owner_email,
                CASE WHEN p.user_id = $1 THEN true ELSE false END as is_owner
                FROM projects p
                JOIN users u ON p.user_id = u.id
                ORDER BY p.created_at DESC
            `;
            params = [req.user.userId];
        } else {
            sql = `
                SELECT p.*, u.email as owner_email,
                CASE WHEN p.user_id = $1 THEN true ELSE false END as is_owner
                FROM projects p
                JOIN users u ON p.user_id = u.id
                WHERE p.user_id = $1
                OR p.id IN (SELECT resource_id FROM shared_access WHERE resource_type = 'project' AND user_id = $1)
                ORDER BY p.created_at DESC
            `;
            params = [req.user.userId];
        }

        const result = await query(sql, params);
        res.json({ projects: result.rows });
    } catch (error) {
        logger.error('Get projects error:', error);
        res.status(500).json({ error: 'Failed to fetch projects' });
    }
});

// Create project
router.post('/', authenticateToken, requirePermission('projects.create'), async (req, res) => {
    try {
        const { name, type, subdomain, git_url, branch, build_command, start_command, env_vars,
                custom_domain, cpu_limit, memory_limit, disk_limit_mb } = req.body;

        if (!name || !type || !subdomain) {
            return res.status(400).json({ error: 'Name, type, and subdomain are required' });
        }

        // Validate subdomain format
        if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain)) {
            return res.status(400).json({ error: 'Invalid subdomain format (lowercase alphanumeric and hyphens only)' });
        }

        const safeCpu = ['0.1', '0.25', '0.5', '1.0', '2.0', '4.0'].includes(String(cpu_limit)) ? String(cpu_limit) : '0.5';
        const safeMem = ['128m', '256m', '512m', '1024m', '2048m', '4096m', '8192m'].includes(String(memory_limit)) ? String(memory_limit) : '512m';

        // Check user quota
        const userQuota = await query(`
            SELECT p.max_projects, p.can_use_custom_domains, p.max_cpu_cores, p.max_memory_mb, COUNT(pr.id) as current_count
            FROM users u
            JOIN plans p ON u.plan_id = p.id
            LEFT JOIN projects pr ON u.id = pr.user_id
            WHERE u.id = $1
            GROUP BY p.max_projects, p.can_use_custom_domains, p.max_cpu_cores, p.max_memory_mb
        `, [req.user.userId]);

        if (userQuota.rows.length > 0) {
            const { max_projects, can_use_custom_domains, current_count } = userQuota.rows[0];

            if (parseInt(current_count) >= max_projects) {
                return res.status(403).json({ error: `Project limit reached (${max_projects}). Upgrade your plan for more.` });
            }

            if (custom_domain && !can_use_custom_domains) {
                return res.status(403).json({ error: 'Custom domains are not available on your current plan.' });
            }
        }

        const result = await query(
            `INSERT INTO projects
            (user_id, name, type, subdomain, custom_domain, git_url, branch, build_command, start_command, env_vars, cpu_limit, memory_limit, disk_limit_mb, deploy_token)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
            RETURNING *`,
            [req.user.userId, name, type, subdomain, custom_domain || null, git_url, branch || 'main',
             build_command, start_command, env_vars || {}, safeCpu, safeMem, disk_limit_mb || 1024, uuidv4()]
        );

        res.status(201).json({ project: result.rows[0] });
    } catch (error) {
        logger.error('Create project error:', error);
        if (error.code === '23505') {
            return res.status(400).json({ error: 'Subdomain or custom domain already taken' });
        }
        res.status(500).json({ error: 'Failed to create project' });
    }
});

// Get single project
router.get('/:id', authenticateToken, async (req, res) => {
    try {
        let sql, params;

        if (req.user.isAdmin || req.user.isModerator) {
            sql = 'SELECT p.*, u.email as owner_email FROM projects p JOIN users u ON p.user_id = u.id WHERE p.id = $1';
            params = [req.params.id];
        } else {
            sql = `
                SELECT p.*, u.email as owner_email FROM projects p
                JOIN users u ON p.user_id = u.id
                WHERE p.id = $1 AND (p.user_id = $2
                OR p.id IN (SELECT resource_id FROM shared_access WHERE resource_type = 'project' AND user_id = $2))
            `;
            params = [req.params.id, req.user.userId];
        }

        const result = await query(sql, params);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Project not found' });
        }
        res.json({ project: result.rows[0] });
    } catch (error) {
        logger.error('Get project error:', error);
        res.status(500).json({ error: 'Failed to fetch project' });
    }
});

// Update project
router.put('/:id', authenticateToken, requirePermission('projects.edit'), async (req, res) => {
    try {
        const { name, build_command, start_command, env_vars, cpu_limit, memory_limit, auto_deploy } = req.body;
        const projectId = parseInt(req.params.id);

        let sql, params;
        if (req.user.isAdmin || req.user.isModerator) {
            sql = 'SELECT * FROM projects WHERE id = $1';
            params = [projectId];
        } else {
            sql = 'SELECT * FROM projects WHERE id = $1 AND user_id = $2';
            params = [projectId, req.user.userId];
        }

        const existing = await query(sql, params);
        if (existing.rows.length === 0) return res.status(404).json({ error: 'Project not found' });

        const safeCpu = cpu_limit && ['0.1', '0.25', '0.5', '1.0', '2.0', '4.0'].includes(String(cpu_limit)) ? String(cpu_limit) : existing.rows[0].cpu_limit;
        const safeMem = memory_limit && ['128m', '256m', '512m', '1024m', '2048m', '4096m', '8192m'].includes(String(memory_limit)) ? String(memory_limit) : existing.rows[0].memory_limit;

        await query(
            `UPDATE projects SET name=$1, build_command=$2, start_command=$3, env_vars=$4, cpu_limit=$5, memory_limit=$6,
             auto_deploy=$7, updated_at=CURRENT_TIMESTAMP WHERE id=$8`,
            [name || existing.rows[0].name, build_command, start_command, env_vars || existing.rows[0].env_vars,
             safeCpu, safeMem, auto_deploy !== undefined ? auto_deploy : existing.rows[0].auto_deploy, projectId]
        );

        res.json({ message: 'Project updated' });
    } catch (error) {
        logger.error('Update project error:', error);
        res.status(500).json({ error: 'Failed to update project' });
    }
});

// Delete project - with proper cleanup
router.delete('/:id', authenticateToken, requirePermission('projects.delete'), async (req, res) => {
    try {
        const projectId = parseInt(req.params.id);

        let sql, params;
        if (req.user.isAdmin || req.user.isModerator) {
            sql = 'SELECT * FROM projects WHERE id = $1';
            params = [projectId];
        } else {
            sql = 'SELECT * FROM projects WHERE id = $1 AND user_id = $2';
            params = [projectId, req.user.userId];
        }

        const result = await query(sql, params);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Project not found or unauthorized' });
        }

        const project = result.rows[0];

        // Stop running process and clean up nginx config
        await deploymentService.stopDeployment(project.subdomain);

        // Remove deployment files
        const fs = require('fs').promises;
        const deployDir = `/app/deployments/${project.subdomain}`;
        try { await fs.rm(deployDir, { recursive: true, force: true }); } catch (e) {}

        await query('DELETE FROM projects WHERE id = $1', [projectId]);
        res.json({ message: 'Project deleted successfully' });
    } catch (error) {
        logger.error('Delete project error:', error);
        res.status(500).json({ error: 'Failed to delete project' });
    }
});

module.exports = router;
