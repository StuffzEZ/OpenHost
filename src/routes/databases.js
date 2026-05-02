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
        const { name, type, dbUser, dbPassword, dbPort } = req.body;

        if (!name || !type) {
            return res.status(400).json({ error: 'Name and type are required' });
        }

        // SANITIZATION: Prevent illegal characters in DB names/users that could bypass SQL quoting
        if (!/^[a-zA-Z0-9_-]+$/.test(name) || (dbUser && !/^[a-zA-Z0-9_-]+$/.test(dbUser))) {
            return res.status(400).json({ error: 'Database and User names must be alphanumeric (underscores allowed)' });
        }

        // Check user quota
        const userQuota = await query(`
            SELECT p.max_databases, COUNT(d.id) as current_count
            FROM users u
            JOIN plans p ON u.plan_id = p.id
            LEFT JOIN databases d ON u.id = d.user_id
            WHERE u.id = $1
            GROUP BY p.max_databases
        `, [req.user.userId]);

        if (userQuota.rows.length > 0) {
            const { max_databases, current_count } = userQuota.rows[0];
            
            // STRICT QUOTA CHECK
            if (parseInt(current_count) >= max_databases) {
                return res.status(403).json({ error: `Database limit reached (${max_databases}). Upgrade your plan for more.` });
            }
        }

        const dbResult = await databaseService.createDatabase(type, name, dbUser, dbPassword, dbPort);

        const result = await query(
            'INSERT INTO databases (user_id, name, type, db_user, db_password, db_port, container_name, connection_string) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *',
            [req.user.userId, name, type, dbResult.dbUser, dbResult.dbPassword, dbResult.dbPort, dbResult.containerName, dbResult.connectionString]
        );

        res.status(201).json({ database: result.rows[0] });
    } catch (error) {
        logger.error('Create database error:', error);
        res.status(500).json({ error: error.message || 'Failed to create database' });
    }
});

// Delete database
router.delete('/:id', authenticateToken, async (req, res) => {
    try {
        const result = await query(
            'SELECT * FROM databases WHERE id = $1 AND user_id = $2',
            [req.params.id, req.user.userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Database not found' });
        }

        const db = result.rows[0];
        await databaseService.stopDatabase(db.container_name, db.type, db.name, db.db_user);

        await query('DELETE FROM databases WHERE id = $1', [req.params.id]);

        res.json({ message: 'Database deleted successfully' });
    } catch (error) {
        logger.error('Delete database error:', error);
        res.status(500).json({ error: 'Failed to delete database' });
    }
});

module.exports = router;
