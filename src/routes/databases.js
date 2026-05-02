const express = require('express');
const { query } = require('../services/database');
const databaseService = require('../services/database_service');
const { authenticateToken } = require('../middleware/auth');
const logger = require('../utils/logger');

const router = express.Router();

// Get all databases
router.get('/', authenticateToken, async (req, res) => {
    try {
        const result = await query(
            'SELECT * FROM databases WHERE user_id = $1 ORDER BY created_at DESC',
            [req.user.userId]
        );
        res.json({ databases: result.rows });
    } catch (error) {
        logger.error('Get databases error:', error);
        res.status(500).json({ error: 'Failed to fetch databases' });
    }
});

// Create database
router.post('/', authenticateToken, async (req, res) => {
    try {
        const { name, type } = req.body;

        if (!name || !type) {
            return res.status(400).json({ error: 'Name and type are required' });
        }

        const dbResult = await databaseService.createDatabase(type, name);

        const result = await query(
            'INSERT INTO databases (user_id, name, type, connection_string) VALUES ($1, $2, $3, $4) RETURNING *',
            [req.user.userId, name, type, dbResult.connectionString]
        );

        res.status(201).json({ database: result.rows[0] });
    } catch (error) {
        logger.error('Create database error:', error);
        res.status(500).json({ error: error.message || 'Failed to create database' });
    }
});

module.exports = router;
