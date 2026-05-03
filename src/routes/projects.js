const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../services/database');
const { authenticateToken } = require('../middleware/auth');
const logger = require('../utils/logger');

const router = express.Router();

// Get all projects
router.get('/', authenticateToken, async (req, res) => {
    try {
        let sql;
        let params;

        if (req.user.isAdmin) {
            // Admins see everything
            sql = `
                SELECT p.*, u.email as owner_email, 
                CASE WHEN p.user_id = $1 THEN true ELSE false END as is_owner
                FROM projects p
                JOIN users u ON p.user_id = u.id
                ORDER BY p.created_at DESC
            `;
            params = [req.user.userId];
        } else {
            // Users see their own + shared projects
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
router.post('/', authenticateToken, async (req, res) => {
    try {
        const { name, type, subdomain, git_url, branch, build_command, start_command, env_vars, duckdns_subdomain, cpu_limit, memory_limit } = req.body;

        // SANITIZATION: Force limits to strings and validate values to prevent injection or bypass
        const safeCpu = ['0.1', '0.25', '0.5', '1.0', '2.0'].includes(String(cpu_limit)) ? String(cpu_limit) : '0.5';
        const safeMem = ['128m', '256m', '512m', '1024m', '2048m'].includes(String(memory_limit)) ? String(memory_limit) : '512m';

        // Check user quota
        const userQuota = await query(`
            SELECT p.max_projects, p.can_use_duckdns, COUNT(pr.id) as current_count
            FROM users u
            JOIN plans p ON u.plan_id = p.id
            LEFT JOIN projects pr ON u.id = pr.user_id
            WHERE u.id = $1
            GROUP BY p.max_projects, p.can_use_duckdns
        `, [req.user.userId]);

        if (userQuota.rows.length > 0) {
            const { max_projects, can_use_duckdns, current_count } = userQuota.rows[0];
            
            // STRICT QUOTA CHECK: prevent bypass by checking current count against plan limit
            if (parseInt(current_count) >= max_projects) {
                return res.status(403).json({ error: `Project limit reached (${max_projects}). Upgrade your plan for more.` });
            }
            if (duckdns_subdomain && !can_use_duckdns) {
                return res.status(403).json({ error: 'DuckDNS is not available on your current plan.' });
            }
        }

        const result = await query(
            `INSERT INTO projects 
            (user_id, name, type, subdomain, duckdns_subdomain, git_url, branch, build_command, start_command, env_vars, cpu_limit, memory_limit, deploy_token) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) 
            RETURNING *`,
            [req.user.userId, name, type, subdomain, duckdns_subdomain, git_url, branch || 'main', build_command, start_command, env_vars || {}, safeCpu, safeMem, uuidv4()]
        );

        res.status(201).json({ project: result.rows[0] });
    } catch (error) {
        logger.error('Create project error:', error);
        if (error.code === '23505') { // Unique constraint violation
            return res.status(400).json({ error: 'Subdomain or DuckDNS subdomain already taken' });
        }
        res.status(500).json({ error: 'Failed to create project' });
    }
});

// Get single project
router.get('/:id', authenticateToken, async (req, res) => {
    try {
        let sql;
        let params;

        if (req.user.isAdmin) {
            sql = 'SELECT * FROM projects WHERE id = $1';
            params = [req.params.id];
        } else {
            sql = `
                SELECT * FROM projects 
                WHERE id = $1 AND (user_id = $2 
                OR id IN (SELECT resource_id FROM shared_access WHERE resource_type = 'project' AND user_id = $2))
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

// Delete project
router.delete('/:id', authenticateToken, async (req, res) => {
    try {
        let sql;
        let params;

        if (req.user.isAdmin) {
            sql = 'DELETE FROM projects WHERE id = $1 RETURNING *';
            params = [req.params.id];
        } else {
            sql = 'DELETE FROM projects WHERE id = $1 AND user_id = $2 RETURNING *';
            params = [req.params.id, req.user.userId];
        }

        const result = await query(sql, params);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Project not found or unauthorized' });
        }
        res.json({ message: 'Project deleted successfully' });
    } catch (error) {
        logger.error('Delete project error:', error);
        res.status(500).json({ error: 'Failed to delete project' });
    }
});

module.exports = router;
