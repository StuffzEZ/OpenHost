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
        const { name, type, subdomain, git_url, branch, build_command, start_command, env_vars } = req.body;

        const result = await query(
            `INSERT INTO projects 
            (user_id, name, type, subdomain, git_url, branch, build_command, start_command, env_vars) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) 
            RETURNING *`,
            [req.user.userId, name, type, subdomain, git_url, branch || 'main', build_command, start_command, env_vars || {}]
        );

        res.status(201).json({ project: result.rows[0] });
    } catch (error) {
        logger.error('Create project error:', error);
        if (error.code === '23505') { // Unique constraint violation
            return res.status(400).json({ error: 'Subdomain already taken' });
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
