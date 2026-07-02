const express = require('express');
const { query } = require('../services/database');
const { authenticateToken } = require('../middleware/auth');
const logger = require('../utils/logger');

const router = express.Router();

// Get all status pages
router.get('/', authenticateToken, async (req, res) => {
    try {
        let sql, params;
        if (req.user.isAdmin || req.user.isModerator) {
            sql = 'SELECT sp.*, u.email as owner_email FROM status_pages sp JOIN users u ON sp.user_id = u.id ORDER BY sp.created_at DESC';
            params = [];
        } else {
            sql = 'SELECT * FROM status_pages WHERE user_id = $1 ORDER BY created_at DESC';
            params = [req.user.userId];
        }
        const result = await query(sql, params);
        res.json({ status_pages: result.rows });
    } catch (error) {
        logger.error('Get status pages error:', error);
        res.status(500).json({ error: 'Failed to fetch status pages' });
    }
});

// Create status page
router.post('/', authenticateToken, async (req, res) => {
    try {
        const { title, slug, description, show_last_deployment, show_uptime, is_public, items } = req.body;

        if (!title || !slug) {
            return res.status(400).json({ error: 'Title and slug are required' });
        }

        if (!/^[a-z0-9-]+$/.test(slug)) {
            return res.status(400).json({ error: 'Slug must be lowercase alphanumeric with hyphens only' });
        }

        const result = await query(
            `INSERT INTO status_pages (user_id, title, slug, description, show_last_deployment, show_uptime, is_public)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
            [req.user.userId, title, slug, description, show_last_deployment ?? true, show_uptime ?? true, is_public ?? true]
        );

        const pageId = result.rows[0].id;

        if (items && Array.isArray(items)) {
            for (const item of items) {
                const table = item.resource_type === 'project' ? 'projects' : 'databases';
                const resourceCheck = await query(`SELECT id FROM ${table} WHERE id = $1 AND (user_id = $2 OR $3 = true)`, [item.resource_id, req.user.userId, req.user.isAdmin]);
                if (resourceCheck.rows.length > 0) {
                    await query(
                        'INSERT INTO status_page_items (status_page_id, resource_id, resource_type, display_name) VALUES ($1, $2, $3, $4)',
                        [pageId, item.resource_id, item.resource_type, item.display_name]
                    );
                }
            }
        }

        res.status(201).json({ status_page: result.rows[0] });
    } catch (error) {
        logger.error('Create status page error:', error);
        if (error.code === '23505') return res.status(400).json({ error: 'Slug already taken' });
        res.status(500).json({ error: 'Failed to create status page' });
    }
});

// Update status page
router.put('/:id', authenticateToken, async (req, res) => {
    try {
        const { title, slug, description, show_last_deployment, show_uptime, is_public, items } = req.body;
        const pageId = parseInt(req.params.id);

        const ownership = await query('SELECT * FROM status_pages WHERE id = $1 AND user_id = $2', [pageId, req.user.userId]);
        if (ownership.rows.length === 0 && !req.user.isAdmin) {
            return res.status(403).json({ error: 'Unauthorized' });
        }

        await query(
            `UPDATE status_pages SET title=$1, slug=$2, description=$3, show_last_deployment=$4, show_uptime=$5, is_public=$6 WHERE id=$7`,
            [title, slug, description, show_last_deployment, show_uptime, is_public, pageId]
        );

        await query('DELETE FROM status_page_items WHERE status_page_id = $1', [pageId]);
        if (items && Array.isArray(items)) {
            for (const item of items) {
                const table = item.resource_type === 'project' ? 'projects' : 'databases';
                const resourceCheck = await query(`SELECT id FROM ${table} WHERE id = $1 AND (user_id = $2 OR $3 = true)`, [item.resource_id, req.user.userId, req.user.isAdmin]);
                if (resourceCheck.rows.length > 0) {
                    await query(
                        'INSERT INTO status_page_items (status_page_id, resource_id, resource_type, display_name) VALUES ($1, $2, $3, $4)',
                        [pageId, item.resource_id, item.resource_type, item.display_name]
                    );
                }
            }
        }

        res.json({ message: 'Status page updated' });
    } catch (error) {
        logger.error('Update status page error:', error);
        res.status(500).json({ error: 'Failed to update status page' });
    }
});

// Delete status page
router.delete('/:id', authenticateToken, async (req, res) => {
    try {
        const pageId = parseInt(req.params.id);
        const ownership = await query('SELECT * FROM status_pages WHERE id = $1 AND user_id = $2', [pageId, req.user.userId]);
        if (ownership.rows.length === 0 && !req.user.isAdmin) {
            return res.status(403).json({ error: 'Unauthorized' });
        }

        await query('DELETE FROM status_pages WHERE id = $1', [pageId]);
        res.json({ message: 'Status page deleted' });
    } catch (error) {
        logger.error('Delete status page error:', error);
        res.status(500).json({ error: 'Failed to delete status page' });
    }
});

// Get items
router.get('/:id/items', authenticateToken, async (req, res) => {
    try {
        const result = await query('SELECT * FROM status_page_items WHERE status_page_id = $1', [parseInt(req.params.id)]);
        res.json({ items: result.rows });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch items' });
    }
});

module.exports = router;
