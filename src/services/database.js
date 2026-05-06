const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const logger = require('../utils/logger');

const pool = new Pool({
    host: process.env.POSTGRES_HOST || 'postgres',
    port: process.env.POSTGRES_PORT || 5432,
    database: process.env.POSTGRES_DB || 'openhost',
    user: process.env.POSTGRES_USER || 'openhost',
    password: process.env.POSTGRES_PASSWORD || 'changeme123',
});

async function initDatabase() {
    const client = await pool.connect();
    try {
        // Create plans table
        await client.query(`
            CREATE TABLE IF NOT EXISTS plans (
                id SERIAL PRIMARY KEY,
                name VARCHAR(100) UNIQUE NOT NULL,
                max_projects INTEGER DEFAULT 3,
                max_databases INTEGER DEFAULT 2,
                max_storage_mb INTEGER DEFAULT 500,
                can_use_duckdns BOOLEAN DEFAULT false,
                can_use_custom_env BOOLEAN DEFAULT true,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Create users table
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                email VARCHAR(255) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                is_admin BOOLEAN DEFAULT false,
                plan_id INTEGER REFERENCES plans(id) ON DELETE SET NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Create default plans if they don't exist
        const defaultPlans = [
            ['Free', 2, 1, 250, false, true],
            ['Pro', 10, 5, 2000, true, true],
            ['Unlimited', 999, 999, 50000, true, true]
        ];

        for (const [name, proj, db, storage, duck, env] of defaultPlans) {
            await client.query(
                'INSERT INTO plans (name, max_projects, max_databases, max_storage_mb, can_use_duckdns, can_use_custom_env) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (name) DO NOTHING',
                [name, proj, db, storage, duck, env]
            );
        }

        // Create projects table
        await client.query(`
            CREATE TABLE IF NOT EXISTS projects (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                name VARCHAR(255) NOT NULL,
                type VARCHAR(50) NOT NULL,
                subdomain VARCHAR(100) UNIQUE,
                duckdns_subdomain VARCHAR(100) UNIQUE,
                git_url TEXT,
                branch VARCHAR(100) DEFAULT 'main',
                build_command TEXT,
                start_command TEXT,
                env_vars JSONB DEFAULT '{}',
                cpu_limit VARCHAR(50) DEFAULT '0.5',
                memory_limit VARCHAR(50) DEFAULT '512m',
                deploy_token VARCHAR(255) UNIQUE,
                status VARCHAR(50) DEFAULT 'inactive',
                port INTEGER,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Create databases table
        await client.query(`
            CREATE TABLE IF NOT EXISTS databases (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                name VARCHAR(100) NOT NULL,
                type VARCHAR(50) NOT NULL,
                db_user VARCHAR(100),
                db_password TEXT,
                db_port INTEGER,
                container_name VARCHAR(255),
                connection_string TEXT,
                status VARCHAR(50) DEFAULT 'active',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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

        // Create cdn_assets table
        await client.query(`
            CREATE TABLE IF NOT EXISTS cdn_assets (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                filename VARCHAR(255) NOT NULL,
                original_name VARCHAR(255),
                size INTEGER,
                mime_type VARCHAR(100),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Create shared_access table
        await client.query(`
            CREATE TABLE IF NOT EXISTS shared_access (
                id SERIAL PRIMARY KEY,
                resource_id INTEGER NOT NULL,
                resource_type VARCHAR(50) NOT NULL, -- 'project', 'database', 'cdn'
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(resource_id, resource_type, user_id)
            )
        `);

        // Create status_pages table
        await client.query(`
            CREATE TABLE IF NOT EXISTS status_pages (
                id SERIAL PRIMARY KEY,
                slug VARCHAR(100) UNIQUE NOT NULL,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                title VARCHAR(255) NOT NULL,
                description TEXT,
                show_last_deployment BOOLEAN DEFAULT true,
                show_uptime BOOLEAN DEFAULT true,
                is_public BOOLEAN DEFAULT true,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Create status_page_items table
        await client.query(`
            CREATE TABLE IF NOT EXISTS status_page_items (
                id SERIAL PRIMARY KEY,
                status_page_id INTEGER REFERENCES status_pages(id) ON DELETE CASCADE,
                resource_id INTEGER NOT NULL,
                resource_type VARCHAR(50) NOT NULL, -- 'project', 'database'
                display_name VARCHAR(255),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Migrations
        try {
            await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_id INTEGER REFERENCES plans(id) ON DELETE SET NULL');
            await client.query("ALTER TABLE projects ADD COLUMN IF NOT EXISTS cpu_limit VARCHAR(50) DEFAULT '0.5'");
            await client.query("ALTER TABLE projects ADD COLUMN IF NOT EXISTS memory_limit VARCHAR(50) DEFAULT '512m'");
            await client.query('ALTER TABLE projects ADD COLUMN IF NOT EXISTS port INTEGER');
            await client.query('ALTER TABLE databases ADD COLUMN IF NOT EXISTS db_user VARCHAR(100)');
            await client.query('ALTER TABLE databases ADD COLUMN IF NOT EXISTS db_password TEXT');
            await client.query('ALTER TABLE databases ADD COLUMN IF NOT EXISTS db_port INTEGER');
            await client.query('ALTER TABLE databases ADD COLUMN IF NOT EXISTS container_name VARCHAR(255)');
            await client.query('ALTER TABLE projects ADD COLUMN IF NOT EXISTS deploy_token VARCHAR(255) UNIQUE');
            
            // Assign Free plan to existing users who don't have one
            const freePlan = await client.query('SELECT id FROM plans WHERE name = $1', ['Free']);
            if (freePlan.rows.length > 0) {
                await client.query('UPDATE users SET plan_id = $1 WHERE plan_id IS NULL', [freePlan.rows[0].id]);
            }
        } catch (e) {
            logger.info('Migrations: some columns or constraints might already exist');
        }

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