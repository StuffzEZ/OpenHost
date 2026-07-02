const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
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
        // Roles table (RBAC)
        await client.query(`
            CREATE TABLE IF NOT EXISTS roles (
                id SERIAL PRIMARY KEY,
                name VARCHAR(50) UNIQUE NOT NULL,
                display_name VARCHAR(100) NOT NULL,
                color VARCHAR(7) DEFAULT '#6b7280',
                is_system BOOLEAN DEFAULT false,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Permissions table
        await client.query(`
            CREATE TABLE IF NOT EXISTS permissions (
                id SERIAL PRIMARY KEY,
                name VARCHAR(100) UNIQUE NOT NULL,
                description TEXT,
                category VARCHAR(50) DEFAULT 'general'
            )
        `);

        // Role-permission mapping
        await client.query(`
            CREATE TABLE IF NOT EXISTS role_permissions (
                role_id INTEGER REFERENCES roles(id) ON DELETE CASCADE,
                permission_id INTEGER REFERENCES permissions(id) ON DELETE CASCADE,
                PRIMARY KEY (role_id, permission_id)
            )
        `);

        // Plans table
        await client.query(`
            CREATE TABLE IF NOT EXISTS plans (
                id SERIAL PRIMARY KEY,
                name VARCHAR(100) UNIQUE NOT NULL,
                max_projects INTEGER DEFAULT 3,
                max_databases INTEGER DEFAULT 2,
                max_storage_mb INTEGER DEFAULT 500,
                max_cpu_cores DECIMAL(3,2) DEFAULT 1.0,
                max_memory_mb INTEGER DEFAULT 1024,
                max_bandwidth_gb INTEGER DEFAULT 10,
                can_use_custom_domains BOOLEAN DEFAULT false,
                can_use_custom_env BOOLEAN DEFAULT true,
                can_use_cron_jobs BOOLEAN DEFAULT false,
                can_use_docker BOOLEAN DEFAULT false,
                priority INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Users table
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                email VARCHAR(255) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                role_id INTEGER REFERENCES roles(id) ON DELETE SET NULL,
                plan_id INTEGER REFERENCES plans(id) ON DELETE SET NULL,
                suspended BOOLEAN DEFAULT false,
                suspended_reason TEXT,
                disk_usage_bytes BIGINT DEFAULT 0,
                last_login_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Projects table
        await client.query(`
            CREATE TABLE IF NOT EXISTS projects (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                name VARCHAR(255) NOT NULL,
                type VARCHAR(50) NOT NULL,
                subdomain VARCHAR(100) UNIQUE,
                custom_domain VARCHAR(255),
                git_url TEXT,
                branch VARCHAR(100) DEFAULT 'main',
                build_command TEXT,
                start_command TEXT,
                env_vars JSONB DEFAULT '{}',
                cpu_limit VARCHAR(50) DEFAULT '0.5',
                memory_limit VARCHAR(50) DEFAULT '512m',
                disk_limit_mb INTEGER DEFAULT 1024,
                deploy_token VARCHAR(255) UNIQUE,
                status VARCHAR(50) DEFAULT 'inactive',
                port INTEGER,
                container_name VARCHAR(255),
                auto_deploy BOOLEAN DEFAULT true,
                last_deployed_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Databases table
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

        // Deployments table
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

        // CDN assets table
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

        // Shared access table
        await client.query(`
            CREATE TABLE IF NOT EXISTS shared_access (
                id SERIAL PRIMARY KEY,
                resource_id INTEGER NOT NULL,
                resource_type VARCHAR(50) NOT NULL,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                permission_level VARCHAR(20) DEFAULT 'read',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(resource_id, resource_type, user_id)
            )
        `);

        // Status pages table
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

        // Status page items
        await client.query(`
            CREATE TABLE IF NOT EXISTS status_page_items (
                id SERIAL PRIMARY KEY,
                status_page_id INTEGER REFERENCES status_pages(id) ON DELETE CASCADE,
                resource_id INTEGER NOT NULL,
                resource_type VARCHAR(50) NOT NULL,
                display_name VARCHAR(255),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Custom domains
        await client.query(`
            CREATE TABLE IF NOT EXISTS custom_domains (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                domain VARCHAR(255) UNIQUE NOT NULL,
                project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
                verified BOOLEAN DEFAULT false,
                verification_token VARCHAR(255),
                ssl_enabled BOOLEAN DEFAULT true,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Platform settings (stored in DB instead of env vars)
        await client.query(`
            CREATE TABLE IF NOT EXISTS platform_settings (
                key VARCHAR(100) PRIMARY KEY,
                value TEXT,
                type VARCHAR(20) DEFAULT 'string',
                category VARCHAR(50) DEFAULT 'general',
                description TEXT,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Admin approvals for container creation
        await client.query(`
            CREATE TABLE IF NOT EXISTS admin_approvals (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                resource_type VARCHAR(50) NOT NULL,
                resource_name VARCHAR(255),
                request_data JSONB DEFAULT '{}',
                status VARCHAR(20) DEFAULT 'pending',
                reviewed_by INTEGER REFERENCES users(id),
                review_note TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                reviewed_at TIMESTAMP
            )
        `);

        // Audit log
        await client.query(`
            CREATE TABLE IF NOT EXISTS audit_log (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                action VARCHAR(100) NOT NULL,
                resource_type VARCHAR(50),
                resource_id INTEGER,
                details JSONB DEFAULT '{}',
                ip_address VARCHAR(45),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Cron jobs
        await client.query(`
            CREATE TABLE IF NOT EXISTS cron_jobs (
                id SERIAL PRIMARY KEY,
                project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                name VARCHAR(255) NOT NULL,
                schedule VARCHAR(100) NOT NULL,
                command TEXT NOT NULL,
                enabled BOOLEAN DEFAULT true,
                last_run_at TIMESTAMP,
                last_status VARCHAR(20),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Migrations for existing tables
        try {
            await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS role_id INTEGER REFERENCES roles(id) ON DELETE SET NULL');
            await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended BOOLEAN DEFAULT false');
            await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_reason TEXT');
            await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS disk_usage_bytes BIGINT DEFAULT 0');
            await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMP');
            await client.query('ALTER TABLE projects ADD COLUMN IF NOT EXISTS custom_domain VARCHAR(255)');
            await client.query('ALTER TABLE projects ADD COLUMN IF NOT EXISTS disk_limit_mb INTEGER DEFAULT 1024');
            await client.query('ALTER TABLE projects ADD COLUMN IF NOT EXISTS container_name VARCHAR(255)');
            await client.query('ALTER TABLE projects ADD COLUMN IF NOT EXISTS auto_deploy BOOLEAN DEFAULT true');
            await client.query('ALTER TABLE projects ADD COLUMN IF NOT EXISTS last_deployed_at TIMESTAMP');
            await client.query('ALTER TABLE plans ADD COLUMN IF NOT EXISTS max_cpu_cores DECIMAL(3,2) DEFAULT 1.0');
            await client.query('ALTER TABLE plans ADD COLUMN IF NOT EXISTS max_memory_mb INTEGER DEFAULT 1024');
            await client.query('ALTER TABLE plans ADD COLUMN IF NOT EXISTS max_bandwidth_gb INTEGER DEFAULT 10');
            await client.query('ALTER TABLE plans ADD COLUMN IF NOT EXISTS can_use_custom_domains BOOLEAN DEFAULT false');
            await client.query('ALTER TABLE plans ADD COLUMN IF NOT EXISTS can_use_cron_jobs BOOLEAN DEFAULT false');
            await client.query('ALTER TABLE plans ADD COLUMN IF NOT EXISTS can_use_docker BOOLEAN DEFAULT false');
            await client.query('ALTER TABLE plans ADD COLUMN IF NOT EXISTS priority INTEGER DEFAULT 0');
            await client.query('ALTER TABLE shared_access ADD COLUMN IF NOT EXISTS permission_level VARCHAR(20) DEFAULT \'read\'');
        } catch (e) {
            logger.info('Migrations: some columns might already exist');
        }

        // Seed default roles
        const defaultRoles = [
            ['user', 'User', '#6b7280', true],
            ['moderator', 'Moderator', '#3b82f6', true],
            ['admin', 'Administrator', '#8b5cf6', true],
            ['superadmin', 'Super Admin', '#ef4444', true],
        ];

        for (const [name, display_name, color, is_system] of defaultRoles) {
            await client.query(
                'INSERT INTO roles (name, display_name, color, is_system) VALUES ($1, $2, $3, $4) ON CONFLICT (name) DO NOTHING',
                [name, display_name, color, is_system]
            );
        }

        // Seed default permissions
        const defaultPermissions = [
            ['projects.create', 'Create projects', 'projects'],
            ['projects.view', 'View projects', 'projects'],
            ['projects.edit', 'Edit projects', 'projects'],
            ['projects.delete', 'Delete projects', 'projects'],
            ['projects.deploy', 'Deploy projects', 'projects'],
            ['databases.create', 'Create databases', 'databases'],
            ['databases.view', 'View databases', 'databases'],
            ['databases.delete', 'Delete databases', 'databases'],
            ['cdn.upload', 'Upload to CDN', 'cdn'],
            ['cdn.delete', 'Delete CDN files', 'cdn'],
            ['users.view', 'View users', 'users'],
            ['users.create', 'Create users', 'users'],
            ['users.edit', 'Edit users', 'users'],
            ['users.delete', 'Delete users', 'users'],
            ['plans.manage', 'Manage plans', 'admin'],
            ['settings.manage', 'Manage platform settings', 'admin'],
            ['approvals.review', 'Review admin approvals', 'admin'],
            ['domains.manage', 'Manage custom domains', 'admin'],
            ['audit.view', 'View audit logs', 'admin'],
            ['roles.manage', 'Manage roles and permissions', 'admin'],
        ];

        for (const [name, description, category] of defaultPermissions) {
            await client.query(
                'INSERT INTO permissions (name, description, category) VALUES ($1, $2, $3) ON CONFLICT (name) DO NOTHING',
                [name, description, category]
            );
        }

        // Assign all permissions to admin and superadmin roles
        const adminRoles = await client.query("SELECT id FROM roles WHERE name IN ('admin', 'superadmin')");
        const allPerms = await client.query('SELECT id FROM permissions');
        for (const role of adminRoles.rows) {
            for (const perm of allPerms.rows) {
                await client.query(
                    'INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                    [role.id, perm.id]
                );
            }
        }

        // Assign moderator permissions (view + deploy + moderate)
        const modRole = await client.query("SELECT id FROM roles WHERE name = 'moderator'");
        if (modRole.rows.length > 0) {
            const modPerms = await client.query("SELECT id FROM permissions WHERE name IN ('projects.view','projects.deploy','databases.view','cdn.upload','users.view','approvals.review')");
            for (const perm of modPerms.rows) {
                await client.query(
                    'INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                    [modRole.rows[0].id, perm.id]
                );
            }
        }

        // Assign basic user permissions
        const userRole = await client.query("SELECT id FROM roles WHERE name = 'user'");
        if (userRole.rows.length > 0) {
            const userPerms = await client.query("SELECT id FROM permissions WHERE name IN ('projects.create','projects.view','projects.edit','projects.delete','projects.deploy','databases.create','databases.view','databases.delete','cdn.upload','cdn.delete')");
            for (const perm of userPerms.rows) {
                await client.query(
                    'INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                    [userRole.rows[0].id, perm.id]
                );
            }
        }

        // Seed default plans
        const defaultPlans = [
            ['Free', 2, 1, 250, 0.5, 512, 10, false, true, false, false, 0],
            ['Pro', 10, 5, 2000, 2.0, 2048, 100, true, true, true, false, 1],
            ['Unlimited', 999, 999, 50000, 4.0, 8192, 1000, true, true, true, true, 2],
        ];

        for (const p of defaultPlans) {
            await client.query(
                `INSERT INTO plans (name, max_projects, max_databases, max_storage_mb, max_cpu_cores, max_memory_mb, max_bandwidth_gb, can_use_custom_domains, can_use_custom_env, can_use_cron_jobs, can_use_docker, priority)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (name) DO NOTHING`,
                p
            );
        }

        // Seed default platform settings
        const defaultSettings = [
            ['platform_name', 'OpenHost', 'string', 'general', 'Platform display name'],
            ['platform_url', '', 'string', 'general', 'Platform base URL (e.g. https://openhost.com)'],
            ['default_domain', 'openhost.com', 'string', 'domains', 'Default subdomain suffix for projects'],
            ['cdn_domain', '', 'string', 'domains', 'CDN domain for uploaded files (e.g. cdn.openhost.com). Leave empty to use platform URL'],
            ['allow_registration', 'true', 'boolean', 'auth', 'Allow public user registration'],
            ['require_approval', 'false', 'boolean', 'admin', 'Require admin approval for new containers'],
            ['duckdns_enabled', 'false', 'boolean', 'domains', 'Enable DuckDNS integration'],
            ['duckdns_token', '', 'string', 'domains', 'DuckDNS API token'],
            ['duckdns_root_domain', '', 'string', 'domains', 'DuckDNS root domain'],
            ['smtp_host', '', 'string', 'email', 'SMTP server host'],
            ['smtp_port', '587', 'string', 'email', 'SMTP server port'],
            ['smtp_user', '', 'string', 'email', 'SMTP username'],
            ['smtp_pass', '', 'string', 'email', 'SMTP password'],
            ['smtp_from', '', 'string', 'email', 'Sender email address'],
            ['max_upload_size_mb', '50', 'number', 'limits', 'Max file upload size in MB'],
            ['maintenance_mode', 'false', 'boolean', 'general', 'Enable maintenance mode'],
            ['postgres_host', process.env.POSTGRES_HOST || 'postgres', 'string', 'database', 'PostgreSQL host for user databases'],
            ['postgres_port', String(process.env.POSTGRES_PORT || 5432), 'string', 'database', 'PostgreSQL port for user databases'],
            ['redis_host', process.env.REDIS_HOST || 'redis', 'string', 'database', 'Redis host for user databases'],
            ['redis_port', String(process.env.REDIS_PORT || 6379), 'string', 'database', 'Redis port for user databases'],
            ['redis_password', process.env.REDIS_PASSWORD || '', 'string', 'database', 'Redis password for user databases'],
        ];

        for (const [key, value, type, category, description] of defaultSettings) {
            await client.query(
                'INSERT INTO platform_settings (key, value, type, category, description) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (key) DO NOTHING',
                [key, value, type, category, description]
            );
        }

        // Assign Free plan to users without one
        const freePlan = await client.query('SELECT id FROM plans WHERE name = $1', ['Free']);
        if (freePlan.rows.length > 0) {
            await client.query('UPDATE users SET plan_id = $1 WHERE plan_id IS NULL', [freePlan.rows[0].id]);
        }

        // Assign 'user' role to users without a role
        const userRoleForMigration = await client.query("SELECT id FROM roles WHERE name = 'user'");
        if (userRoleForMigration.rows.length > 0) {
            await client.query('UPDATE users SET role_id = $1 WHERE role_id IS NULL', [userRoleForMigration.rows[0].id]);
        }

        // Create default admin user
        const adminEmail = process.env.ADMIN_EMAIL || 'admin@openhost.local';
        const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';

        const existingAdmin = await client.query('SELECT * FROM users WHERE email = $1', [adminEmail]);

        if (existingAdmin.rows.length === 0) {
            const hashedPassword = await bcrypt.hash(adminPassword, 10);
            const superadminRole = await client.query("SELECT id FROM roles WHERE name = 'superadmin'");
            const roleId = superadminRole.rows.length > 0 ? superadminRole.rows[0].id : null;

            await client.query(
                'INSERT INTO users (email, password, role_id) VALUES ($1, $2, $3)',
                [adminEmail, hashedPassword, roleId]
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

async function getClient() {
    return pool.connect();
}

module.exports = {
    pool,
    query,
    getClient,
    initDatabase
};
