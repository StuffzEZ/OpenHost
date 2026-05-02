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
        
        const userInfo = await query('SELECT id, email, is_admin, created_at FROM users WHERE id = $1', [req.user.userId]);
        
        res.json({
            stats,
            user: userInfo.rows[0]
        });
    } catch (error) {
        logger.error('Get settings error:', error);
        res.status(500).json({ error: 'Failed to fetch settings' });
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

// User management (Admin only)
router.get('/users', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const result = await query('SELECT id, email, is_admin, created_at FROM users ORDER BY created_at DESC');
        res.json({ users: result.rows });
    } catch (error) {
        logger.error('Fetch users error:', error);
        res.status(500).json({ error: 'Failed to fetch users' });
    }
});

router.post('/users', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { email, password, isAdmin } = req.body;
        
        const existing = await query('SELECT * FROM users WHERE email = $1', [email]);
        if (existing.rows.length > 0) {
            return res.status(400).json({ error: 'User already exists' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const result = await query(
            'INSERT INTO users (email, password, is_admin) VALUES ($1, $2, $3) RETURNING id, email, is_admin',
            [email, hashedPassword, isAdmin || false]
        );

        res.status(201).json({ user: result.rows[0] });
    } catch (error) {
        logger.error('Create user error:', error);
        res.status(500).json({ error: 'Failed to create user' });
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
