const Docker = require('dockerode');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

class DatabaseService {
    async createDatabase(type, name, customUser, customPassword, customPort) {
        const dbId = uuidv4().substring(0, 8);
        const containerName = `openhost-db-${name}-${dbId}`;
        const password = customPassword || uuidv4();
        const dbUser = customUser || 'openhost';
        
        let image = '';
        let env = [];
        let port = customPort || 0;
        let connectionString = '';

        switch (type.toLowerCase()) {
            case 'postgres':
                image = 'postgres:15-alpine';
                port = port || 5432;
                env = [`POSTGRES_DB=${name}`, `POSTGRES_PASSWORD=${password}`, `POSTGRES_USER=${dbUser}` ];
                connectionString = `postgres://${dbUser}:${password}@${containerName}:${port}/${name}`;
                break;
            case 'redis':
                image = 'redis:7-alpine';
                port = port || 6379;
                connectionString = `redis://:${password}@${containerName}:${port}`;
                break;
            case 'mongodb':
                image = 'mongo:6';
                port = port || 27017;
                env = [`MONGO_INITDB_DATABASE=${name}`, `MONGO_INITDB_ROOT_USERNAME=${dbUser}`, `MONGO_INITDB_ROOT_PASSWORD=${password}`];
                connectionString = `mongodb://${dbUser}:${password}@${containerName}:${port}/${name}`;
                break;
            default:
                throw new Error(`Unsupported database type: ${type}`);
        }

        try {
            // Pull image
            const stream = await docker.pull(image);
            await new Promise((resolve, reject) => {
                docker.modem.followProgress(stream, (err, res) => err ? reject(err) : resolve(res));
            });

            const container = await docker.createContainer({
                name: containerName,
                Image: image,
                Env: env,
                HostConfig: {
                    NetworkMode: 'openhost-network',
                    RestartPolicy: { Name: 'unless-stopped' }
                }
            });

            await container.start();

            return {
                containerId: container.id,
                connectionString,
                containerName,
                dbUser,
                dbPassword: password,
                dbPort: port
            };
        } catch (error) {
            logger.error(`Failed to create database container: ${error.message}`);
            throw error;
        }
    }

    async stopDatabase(containerName) {
        try {
            const container = docker.getContainer(containerName);
            await container.stop();
            await container.remove();
        } catch (error) {
            logger.warn(`Failed to stop database container ${containerName}: ${error.message}`);
        }
    }
}

module.exports = new DatabaseService();
