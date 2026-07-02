const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');
const { query } = require('./database');

class DatabaseService {
    constructor() {
        this.pgPool = new Pool({
            host: process.env.POSTGRES_HOST || 'postgres',
            port: process.env.POSTGRES_PORT || 5432,
            database: 'postgres',
            user: process.env.POSTGRES_USER || 'openhost',
            password: process.env.POSTGRES_PASSWORD || 'changeme123',
        });
    }

    async createDatabase(type, name, customUser, customPassword, customPort, dbId, userId) {
        const password = customPassword || uuidv4().replace(/-/g, '');
        const dbUser = customUser || `oh_${name.replace(/[^a-zA-Z0-9_]/g, '_')}`;
        let connectionString = '';

        try {
            switch (type.toLowerCase()) {
                case 'postgres':
                    await this.createPostgresDb(name, dbUser, password);
                    const pgHost = await this.getSetting('postgres_host') || process.env.POSTGRES_HOST || 'postgres';
                    const pgPort = await this.getSetting('postgres_port') || process.env.POSTGRES_PORT || 5432;
                    connectionString = `postgres://${dbUser}:${encodeURIComponent(password)}@${pgHost}:${pgPort}/${name}`;
                    break;
                case 'redis':
                    const redisHost = await this.getSetting('redis_host') || process.env.REDIS_HOST || 'redis';
                    const redisPort = await this.getSetting('redis_port') || process.env.REDIS_PORT || 6379;
                    const redisPassword = await this.getSetting('redis_password') || process.env.REDIS_PASSWORD || '';
                    const redisDb = (dbId % 16) || 0;
                    connectionString = redisPassword
                        ? `redis://:${redisPassword}@${redisHost}:${redisPort}/${redisDb}`
                        : `redis://${redisHost}:${redisPort}/${redisDb}`;
                    break;
                default:
                    throw new Error(`Unsupported database type: ${type}`);
            }

            return {
                connectionString,
                dbUser,
                dbPassword: password,
                dbPort: customPort || (type === 'postgres' ? 5432 : 6379),
                containerName: null
            };
        } catch (error) {
            logger.error(`Failed to create database: ${error.message}`);
            throw error;
        }
    }

    async createPostgresDb(name, user, password) {
        const client = await this.pgPool.connect();
        try {
            const sanitizedDbName = `"${name.replace(/"/g, '""')}"`;
            const sanitizedUserName = `"${user.replace(/"/g, '""')}"`;

            const userExists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [user]);
            if (userExists.rows.length === 0) {
                await client.query(`CREATE USER ${sanitizedUserName} WITH PASSWORD $1`, [password]);
            }

            await client.query(`CREATE DATABASE ${sanitizedDbName} OWNER ${sanitizedUserName}`);

            // Grant privileges
            await client.query(`GRANT ALL PRIVILEGES ON DATABASE ${sanitizedDbName} TO ${sanitizedUserName}`);

            logger.info(`Shared Postgres: Created database ${name} for user ${user}`);
        } finally {
            client.release();
        }
    }

    async stopDatabase(containerName, dbType, dbName, dbUser) {
        if (dbType === 'postgres') {
            await this.dropPostgresDb(dbName, dbUser);
        }
    }

    async dropPostgresDb(name, user) {
        const client = await this.pgPool.connect();
        try {
            const sanitizedDbName = `"${name.replace(/"/g, '""')}"`;

            await client.query(`
                SELECT pg_terminate_backend(pg_stat_activity.pid)
                FROM pg_stat_activity
                WHERE pg_stat_activity.datname = $1 AND pid <> pg_backend_pid()
            `, [name]);

            await client.query(`DROP DATABASE IF EXISTS ${sanitizedDbName}`);
            logger.info(`Shared Postgres: Dropped database ${name}`);
        } finally {
            client.release();
        }
    }

    async getSetting(key) {
        try {
            const result = await query('SELECT value FROM platform_settings WHERE key = $1', [key]);
            return result.rows[0]?.value || null;
        } catch (e) {
            return null;
        }
    }
}

module.exports = new DatabaseService();
