const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query } = require('../services/database');
const { authenticateToken, JWT_SECRET } = require('../middleware/auth');
const logger = require('../utils/logger');

const router = express.Router();

// Login
router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }

        const result = await query(
            `SELECT u.*, r.name as role_name FROM users u
             LEFT JOIN roles r ON u.role_id = r.id
             WHERE u.email = $1`,
            [email]
        );
        const user = result.rows[0];

        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        if (user.suspended) {
            return res.status(403).json({ error: 'Account suspended: ' + (user.suspended_reason || 'Contact administrator') });
        }

        // Update last login
        await query('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = $1', [user.id]);

        // Get permissions
        let permissions = [];
        if (user.role_id) {
            const perms = await query(
                'SELECT p.name FROM permissions p JOIN role_permissions rp ON p.id = rp.permission_id WHERE rp.role_id = $1',
                [user.role_id]
            );
            permissions = perms.rows.map(r => r.name);
        }

        const token = jwt.sign(
            { userId: user.id, email: user.email },
            JWT_SECRET,
            { expiresIn: '24h' }
        );

        res.json({
            token,
            user: {
                id: user.id,
                email: user.email,
                roleId: user.role_id,
                roleName: user.role_name,
                planId: user.plan_id,
                isAdmin: user.role_name === 'admin' || user.role_name === 'superadmin',
                isSuperAdmin: user.role_name === 'superadmin',
                permissions
            }
        });
    } catch (error) {
        logger.error('Login error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Register - only if allow_registration is enabled in platform settings
router.post('/register', async (req, res) => {
    try {
        const settingsResult = await query("SELECT value FROM platform_settings WHERE key = 'allow_registration'");
        const allowRegistration = settingsResult.rows.length > 0 ? settingsResult.rows[0].value === 'true' : true;

        if (!allowRegistration) {
            return res.status(403).json({ error: 'Registration is currently disabled. Contact an administrator.' });
        }

        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }

        if (password.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters' });
        }

        const existing = await query('SELECT * FROM users WHERE email = $1', [email]);
        if (existing.rows.length > 0) {
            return res.status(400).json({ error: 'User already exists' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        // Get default role
        const userRole = await query("SELECT id FROM roles WHERE name = 'user' LIMIT 1");
        const roleId = userRole.rows.length > 0 ? userRole.rows[0].id : null;

        // Get default plan
        const freePlan = await query("SELECT id FROM plans ORDER BY priority ASC LIMIT 1");
        const planId = freePlan.rows.length > 0 ? freePlan.rows[0].id : null;

        const result = await query(
            'INSERT INTO users (email, password, role_id, plan_id) VALUES ($1, $2, $3, $4) RETURNING id, email',
            [email, hashedPassword, roleId, planId]
        );

        res.status(201).json({ user: result.rows[0] });
    } catch (error) {
        logger.error('Registration error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Verify token
router.get('/verify', authenticateToken, async (req, res) => {
    res.json({ valid: true, user: req.user });
});

module.exports = router;
