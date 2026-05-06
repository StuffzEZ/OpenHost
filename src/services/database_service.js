const { Pool } = require('pg');
const { MongoClient } = require('mongodb');
const { createClient } = require('redis');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

class DatabaseService {
    constructor() {
        // Platform's shared Postgres instance (already used for platform data)
        this.pgPool = new Pool({
            host: process.env.POSTGRES_HOST || 'postgres',
            port: process.env.POSTGRES_PORT || 5432,
            database: 'postgres', // Connect to default postgres db for management
            user: process.env.POSTGRES_USER || 'openhost',
            password: process.env.POSTGRES_PASSWORD || 'changeme123',
        });

        // Platform's shared MongoDB instance
        this.mongoUri = `mongodb://admin:adminpassword@${process.env.MONGO_HOST || 'mongodb'}:27017`;
        
        // Redis config
        this.redisHost = process.env.REDIS_HOST || 'redis';
        this.redisPort = process.env.REDIS_PORT || 6379;
        this.redisPassword = process.env.REDIS_PASSWORD || '';
    }

    async createDatabase(type, name, customUser, customPassword, customPort, dbId) {
        const password = customPassword || uuidv4();
        const dbUser = customUser || 'openhost';
        let connectionString = '';

        try {
            switch (type.toLowerCase()) {
                case 'postgres':
                    await this.createPostgresDb(name, dbUser, password);
                    connectionString = `postgres://${dbUser}:${password}@${process.env.POSTGRES_HOST || 'postgres'}:${process.env.POSTGRES_PORT || 5432}/${name}`;
                    break;
                case 'mongodb':
                    await this.createMongoDb(name, dbUser, password);
                    connectionString = `mongodb://${dbUser}:${password}@${process.env.MONGO_HOST || 'mongodb'}:27017/${name}?authSource=admin`;
                    break;
                case 'redis':
                    // Redis "databases" are just numbered slots (0-15 by default)
                    // We'll use a hash of the name or just a default slot for now.
                    // In a production environment, you'd use ACLs or separate instances.
                    const redisDb = (dbId % 16) || 0;
                    connectionString = `redis://:${this.redisPassword}@${this.redisHost}:${this.redisPort}/${redisDb}`;
                    break;
                default:
                    throw new Error(`Unsupported database type: ${type}`);
            }

            return {
                connectionString,
                dbUser,
                dbPassword: password,
                dbPort: customPort || (type === 'postgres' ? 5432 : type === 'mongodb' ? 27017 : 6379),
                containerName: null // No container per DB anymore
            };
        } catch (error) {
            logger.error(`Failed to create database: ${error.message}`);
            throw error;
        }
    }

    async createPostgresDb(name, user, password) {
        const client = await this.pgPool.connect();
        try {
            // Note: Postgres doesn't support parameterized identifiers (db/user names)
            // We use standard identifiers but carefully since they come from trusted dashboard input
            // and we sanitize them by quoting.
            const sanitizedDbName = `"${name.replace(/"/g, '""')}"`;
            const sanitizedUserName = `"${user.replace(/"/g, '""')}"`;

            // Check if user exists, if not create
            const userExists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [user]);
            if (userExists.rows.length === 0) {
                await client.query(`CREATE USER ${sanitizedUserName} WITH PASSWORD $1`, [password]);
            }

            // Create database
            await client.query(`CREATE DATABASE ${sanitizedDbName} OWNER ${sanitizedUserName}`);
            logger.info(`Shared Postgres: Created database ${name} for user ${user}`);
        } finally {
            client.release();
        }
    }

    async createMongoDb(name, user, password) {
        const client = new MongoClient(this.mongoUri);
        try {
            await client.connect();
            const adminDb = client.db('admin');
            
            // Create user for the new database
            await adminDb.command({
                createUser: user,
                pwd: password,
                roles: [{ role: 'dbOwner', db: name }]
            });

            logger.info(`Shared MongoDB: Created database ${name} and user ${user}`);
        } finally {
            await client.close();
        }
    }

    async stopDatabase(containerName, dbType, dbName, dbUser) {
        // containerName is null for shared DBs, but we use other params for cleanup
        if (dbType === 'postgres') {
            await this.dropPostgresDb(dbName, dbUser);
        } else if (dbType === 'mongodb') {
            await this.dropMongoDb(dbName, dbUser);
        }
    }

    async dropPostgresDb(name, user) {
        const client = await this.pgPool.connect();
        try {
            const sanitizedDbName = `"${name.replace(/"/g, '""')}"`;
            const sanitizedUserName = `"${user.replace(/"/g, '""')}"`;
            
            // Disconnect users
            await client.query(`
                SELECT pg_terminate_backend(pg_stat_activity.pid)
                FROM pg_stat_activity
                WHERE pg_stat_activity.datname = $1 AND pid <> pg_backend_pid()
            `, [name]);

            await client.query(`DROP DATABASE IF EXISTS ${sanitizedDbName}`);
            // We don't drop the user because they might have other dbs, 
            // but in this platform 1:1 is common. For simplicity we leave the user.
            logger.info(`Shared Postgres: Dropped database ${name}`);
        } finally {
            client.release();
        }
    }

    async dropMongoDb(name, user) {
        const client = new MongoClient(this.mongoUri);
        try {
            await client.connect();
            const db = client.db(name);
            await db.dropDatabase();
            
            const adminDb = client.db('admin');
            await adminDb.removeUser(user);
            
            logger.info(`Shared MongoDB: Dropped database ${name} and user ${user}`);
        } finally {
            await client.close();
        }
    }
}

module.exports = new DatabaseService();
