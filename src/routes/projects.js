const express = require('express');
const { query } = require('../services/database');
const { authenticateToken } = require('../middleware/auth');
const logger = require('../utils/logger');

const router = express.Router();

// Get all projects
router.get('/', authenticateToken, async (req, res) => {
    try {
        const result = await query(
            'SELECT * FROM projects WHERE user_id = $1 ORDER BY created_at DESC',
            [req.user.userId]
        );
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
            if (parseInt(current_count) >= max_projects) {
                return res.status(403).json({ error: `Project limit reached (${max_projects}). Upgrade your plan for more.` });
            }
            if (duckdns_subdomain && !can_use_duckdns) {
                return res.status(403).json({ error: 'DuckDNS is not available on your current plan.' });
            }
        }

        const result = await query(
            `INSERT INTO projects 
            (user_id, name, type, subdomain, duckdns_subdomain, git_url, branch, build_command, start_command, env_vars, cpu_limit, memory_limit) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) 
            RETURNING *`,
            [req.user.userId, name, type, subdomain, duckdns_subdomain, git_url, branch || 'main', build_command, start_command, env_vars || {}, cpu_limit || '0.5', memory_limit || '512m']
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
        const result = await query(
            'SELECT * FROM projects WHERE id = $1 AND user_id = $2',
            [req.params.id, req.user.userId]
        );
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
        const result = await query(
            'DELETE FROM projects WHERE id = $1 AND user_id = $2 RETURNING *',
            [req.params.id, req.user.userId]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Project not found' });
        }
        res.json({ message: 'Project deleted successfully' });
    } catch (error) {
        logger.error('Delete project error:', error);
        res.status(500).json({ error: 'Failed to delete project' });
    }
});

module.exports = router;
