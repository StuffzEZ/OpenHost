const express = require('express');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const logger = require('../utils/logger');

const router = express.Router();

// Get system settings (Admin only)
router.get('/', authenticateToken, requireAdmin, async (req, res) => {
    try {
        res.json({
            version: '1.0.0',
            node_version: process.version,
            platform: process.platform,
            uptime: process.uptime()
        });
    } catch (error) {
        logger.error('Get settings error:', error);
        res.status(500).json({ error: 'Failed to fetch settings' });
    }
});

module.exports = router;
