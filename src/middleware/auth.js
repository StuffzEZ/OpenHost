const jwt = require('jsonwebtoken');
const logger = require('../utils/logger');
const { query } = require('../services/database');

const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-key';

function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Access token required' });
    }

    jwt.verify(token, JWT_SECRET, async (err, decoded) => {
        if (err) {
            logger.warn('Invalid token attempt');
            return res.status(403).json({ error: 'Invalid or expired token' });
        }

        // Fetch fresh user data to check suspension and role
        try {
            const result = await query(
                `SELECT u.id, u.email, u.role_id, u.plan_id, u.suspended, r.name as role_name
                 FROM users u LEFT JOIN roles r ON u.role_id = r.id
                 WHERE u.id = $1`,
                [decoded.userId]
            );

            if (result.rows.length === 0) {
                return res.status(403).json({ error: 'User not found' });
            }

            const dbUser = result.rows[0];
            if (dbUser.suspended) {
                return res.status(403).json({ error: 'Account has been suspended' });
            }

            req.user = {
                userId: decoded.userId,
                email: decoded.email,
                roleId: dbUser.role_id,
                roleName: dbUser.role_name,
                planId: dbUser.plan_id,
                isAdmin: dbUser.role_name === 'admin' || dbUser.role_name === 'superadmin',
                isSuperAdmin: dbUser.role_name === 'superadmin',
                isModerator: dbUser.role_name === 'moderator' || dbUser.role_name === 'admin' || dbUser.role_name === 'superadmin'
            };

            // Attach permissions
            if (dbUser.role_id) {
                const perms = await query(
                    'SELECT p.name FROM permissions p JOIN role_permissions rp ON p.id = rp.permission_id WHERE rp.role_id = $1',
                    [dbUser.role_id]
                );
                req.user.permissions = perms.rows.map(r => r.name);
            } else {
                req.user.permissions = [];
            }

            next();
        } catch (error) {
            logger.error('Auth middleware error:', error);
            return res.status(500).json({ error: 'Authentication error' });
        }
    });
}

function requirePermission(...permissionNames) {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        // Superadmins bypass all permission checks
        if (req.user.isSuperAdmin) {
            return next();
        }

        const hasPermission = permissionNames.some(p => req.user.permissions.includes(p));
        if (!hasPermission) {
            return res.status(403).json({ error: 'Insufficient permissions' });
        }

        next();
    };
}

function requireAdmin(req, res, next) {
    if (!req.user || !req.user.isAdmin) {
        return res.status(403).json({ error: 'Admin access required' });
    }
    next();
}

module.exports = {
    authenticateToken,
    requireAdmin,
    requirePermission,
    JWT_SECRET
};
