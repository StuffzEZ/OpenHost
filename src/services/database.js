const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const logger = require('../utils/logger');

const pool = new Pool({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: process.env.POSTGRES_PORT || 5432,
    database: process.env.POSTGRES_DB || 'openhost',
    user: process.env.POSTGRES_USER || 'openhost',
    password: process.env.POSTGRES_PASSWORD || 'changeme123',
});

async function initDatabase() {
    const client = await pool.connect();
    try {
        // Create users table
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                email VARCHAR(255) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                is_admin BOOLEAN DEFAULT false,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Create projects table
        await client.query(`
            CREATE TABLE IF NOT EXISTS projects (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                name VARCHAR(255) NOT NULL,
                type VARCHAR(50) NOT NULL,
                subdomain VARCHAR(100) UNIQUE,
                git_url TEXT,
                branch VARCHAR(100) DEFAULT 'main',
                build_command TEXT,
                start_command TEXT,
                env_vars JSONB DEFAULT '{}',
                status VARCHAR(50) DEFAULT 'inactive',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Create deployments table
        await client.query(`
            CREATE TABLE IF NOT EXISTS deployments (
                id SERIAL PRIMARY KEY,
                project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
                version VARCHAR(50),
                status VARCHAR(50) DEFAULT 'pending',
                build_logs TEXT,
                deploy_url TEXT,
                deployed_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Create databases table
        await client.query(`
            CREATE TABLE IF NOT EXISTS databases (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                name VARCHAR(100) NOT NULL,
                type VARCHAR(50) NOT NULL,
                connection_string TEXT,
                status VARCHAR(50) DEFAULT 'active',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Create default admin user if doesn't exist
        const adminEmail = process.env.ADMIN_EMAIL || 'admin@openhost.local';
        const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
        
        const existingAdmin = await client.query(
            'SELECT * FROM users WHERE email = $1',
            [adminEmail]
        );

        if (existingAdmin.rows.length === 0) {
            const hashedPassword = await bcrypt.hash(adminPassword, 10);
            await client.query(
                'INSERT INTO users (email, password, is_admin) VALUES ($1, $2, $3)',
                [adminEmail, hashedPassword, true]
            );
            logger.info(`Default admin user created: ${adminEmail}`);
            logger.warn('IMPORTANT: Change the default admin password immediately!');
        }

        logger.info('Database schema initialized');
    } catch (error) {
        logger.error('Database initialization error:', error);
        throw error;
    } finally {
        client.release();
    }
}

async function query(text, params) {
    const start = Date.now();
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    logger.debug('Executed query', { text, duration, rows: res.rowCount });
    return res;
}

module.exports = {
    pool,
    query,
    initDatabase
};