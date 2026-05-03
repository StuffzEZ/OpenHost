const express = require('express');
const { query } = require('../services/database');
const { authenticateToken } = require('../middleware/auth');
const logger = require('../utils/logger');

const router = express.Router();

// Share a resource
router.post('/', authenticateToken, async (req, res) => {
    try {
        const { resourceId, resourceType, email } = req.body;

        if (!resourceId || !resourceType || !email) {
            return res.status(400).json({ error: 'resourceId, resourceType, and email are required' });
        }

        // Verify resource ownership
        let table = '';
        if (resourceType === 'project') table = 'projects';
        else if (resourceType === 'database') table = 'databases';
        else if (resourceType === 'cdn') table = 'cdn_assets';
        else return res.status(400).json({ error: 'Invalid resource type' });

        const ownership = await query(`SELECT * FROM ${table} WHERE id = $1 AND user_id = $2`, [resourceId, req.user.userId]);
        if (ownership.rows.length === 0 && !req.user.isAdmin) {
            return res.status(403).json({ error: 'Unauthorized to share this resource' });
        }

        // Find user to share with
        const userToShare = await query('SELECT id FROM users WHERE email = $1', [email]);
        if (userToShare.rows.length === 0) {
            return res.status(404).json({ error: 'User with this email not found' });
        }

        const sharedUserId = userToShare.rows[0].id;
        if (sharedUserId === req.user.userId) {
            return res.status(400).json({ error: 'Cannot share with yourself' });
        }

        // Add to shared_access
        await query(
            'INSERT INTO shared_access (resource_id, resource_type, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
            [resourceId, resourceType, sharedUserId]
        );

        res.json({ message: 'Resource shared successfully' });
    } catch (error) {
        logger.error('Share resource error:', error);
        res.status(500).json({ error: 'Failed to share resource' });
    }
});

// Get shared users for a resource
router.get('/:type/:id', authenticateToken, async (req, res) => {
    try {
        const { type, id } = req.params;

        const result = await query(`
            SELECT u.email, s.id as shared_id
            FROM shared_access s
            JOIN users u ON s.user_id = u.id
            WHERE s.resource_type = $1 AND s.resource_id = $2
        `, [type, id]);

        res.json({ shared_users: result.rows });
    } catch (error) {
        logger.error('Get shared users error:', error);
        res.status(500).json({ error: 'Failed to fetch shared users' });
    }
});

// Remove sharing
router.delete('/:sharedId', authenticateToken, async (req, res) => {
    try {
        const { sharedId } = req.params;
        
        // Only owner or admin can remove sharing
        // First get the resource info
        const shareInfo = await query('SELECT * FROM shared_access WHERE id = $1', [sharedId]);
        if (shareInfo.rows.length === 0) {
            return res.status(404).json({ error: 'Shared access not found' });
        }

        const { resource_id, resource_type } = shareInfo.rows[0];
        let table = '';
        if (resource_type === 'project') table = 'projects';
        else if (resource_type === 'database') table = 'databases';
        else if (resource_type === 'cdn') table = 'cdn_assets';

        const ownership = await query(`SELECT * FROM ${table} WHERE id = $1 AND user_id = $2`, [resource_id, req.user.userId]);
        if (ownership.rows.length === 0 && !req.user.isAdmin) {
            return res.status(403).json({ error: 'Unauthorized to manage sharing for this resource' });
        }

        await query('DELETE FROM shared_access WHERE id = $1', [sharedId]);
        res.json({ message: 'Sharing removed successfully' });
    } catch (error) {
        logger.error('Remove sharing error:', error);
        res.status(500).json({ error: 'Failed to remove sharing' });
    }
});

module.exports = router;
