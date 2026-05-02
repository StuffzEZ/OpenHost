const Docker = require('dockerode');
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');
const https = require('https');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

const execAsync = promisify(exec);
const docker = new Docker({ socketPath: '/var/run/docker.sock' });

class DeploymentService {
    async buildAndDeploy(project, io) {
        const deploymentId = uuidv4();
        const buildDir = path.join('/app/builds', deploymentId);
        const deployDir = path.join('/app/deployments', project.subdomain);

        try {
            // Stop and remove existing deployment if any
            await this.stopDeployment(project.subdomain);

            // Create build directory
            await fs.mkdir(buildDir, { recursive: true });

            // Clone or copy code
            if (project.git_url) {
                await this.cloneRepository(project.git_url, project.branch, buildDir, io);
            }

            // Install dependencies and build
            await this.buildProject(project, buildDir, io);

            // Create deployment directory
            await fs.mkdir(deployDir, { recursive: true });

            // Copy built files to deployment directory
            await execAsync(`cp -r ${buildDir}/* ${deployDir}/`);

            let containerId = null;
            // Create and start container only for non-static project types
            if (project.type !== 'static' && project.type !== 'react') {
                const container = await this.createContainer(project, deployDir);
                await container.start();
                containerId = container.id;
            }

            // Generate nginx config
            await this.generateNginxConfig(project);
            await this.reloadNginx();

            // Update DuckDNS if configured
            if (project.duckdns_subdomain) {
                await this.updateDuckDNS(project.duckdns_subdomain, io);
            }

            // Cleanup build directory
            await fs.rm(buildDir, { recursive: true, force: true });

            return {
                success: true,
                deploymentId,
                url: `http://${project.subdomain}.localhost`,
                containerId: containerId
            };
        } catch (error) {
            logger.error('Deployment error:', error);
            io.emit('build-log', { 
                projectId: project.id, 
                message: `Error: ${error.message}`,
                type: 'error'
            });
            throw error;
        }
    }

    async cloneRepository(gitUrl, branch, targetDir, io) {
        io.emit('build-log', { message: `Cloning repository: ${gitUrl}`, type: 'info' });
        const command = `git clone --depth 1 --branch ${branch} ${gitUrl} ${targetDir}`;
        await execAsync(command);
        io.emit('build-log', { message: 'Repository cloned successfully', type: 'success' });
    }

    async buildProject(project, buildDir, io) {
        io.emit('build-log', { message: 'Installing dependencies...', type: 'info' });

        switch (project.type) {
            case 'nodejs':
                await this.buildNodeJS(buildDir, project, io);
                break;
            case 'python':
                await this.buildPython(buildDir, project, io);
                break;
            case 'static':
                await this.buildStatic(buildDir, project, io);
                break;
            case 'react':
            case 'nextjs':
                await this.buildReact(buildDir, project, io);
                break;
            default:
                throw new Error(`Unsupported project type: ${project.type}`);
        }
    }

    async buildNodeJS(buildDir, project, io) {
        if (await this.fileExists(path.join(buildDir, 'package.json'))) {
            io.emit('build-log', { message: 'Running npm install...', type: 'info' });
            await execAsync('npm install', { cwd: buildDir });
            
            if (project.build_command) {
                io.emit('build-log', { message: `Running build command: ${project.build_command}`, type: 'info' });
                await execAsync(project.build_command, { cwd: buildDir });
            }
        }
    }

    async buildPython(buildDir, project, io) {
        if (await this.fileExists(path.join(buildDir, 'requirements.txt'))) {
            io.emit('build-log', { message: 'Installing Python dependencies...', type: 'info' });
            await execAsync('pip3 install -r requirements.txt', { cwd: buildDir });
        }
    }

    async buildStatic(buildDir, project, io) {
        io.emit('build-log', { message: 'Preparing static files...', type: 'info' });
        // Static files don't need building
    }

    async buildReact(buildDir, project, io) {
        if (await this.fileExists(path.join(buildDir, 'package.json'))) {
            io.emit('build-log', { message: 'Installing dependencies...', type: 'info' });
            await execAsync('npm install', { cwd: buildDir });
            
            const buildCmd = project.build_command || 'npm run build';
            io.emit('build-log', { message: `Building: ${buildCmd}`, type: 'info' });
            await execAsync(buildCmd, { cwd: buildDir });
        }
    }

    async createContainer(project, deployDir) {
        const containerName = `openhost-${project.subdomain}`;
        const image = this.getDockerImage(project.type);

        // Ensure image exists
        try {
            const stream = await docker.pull(image);
            await new Promise((resolve, reject) => {
                docker.modem.followProgress(stream, (err, res) => err ? reject(err) : resolve(res));
            });
            logger.info(`Pulled image: ${image}`);
        } catch (error) {
            logger.warn(`Failed to pull image ${image}, attempting to use local:`, error.message);
        }

        const envVars = Object.entries(project.env_vars || {}).map(
            ([key, value]) => `${key}=${value}`
        );

        let containerConfig = {
            name: containerName,
            Image: this.getDockerImage(project.type),
            Env: envVars,
            HostConfig: {
                Binds: [`${deployDir}:/app`],
                NetworkMode: 'openhost-network',
                RestartPolicy: { Name: 'unless-stopped' }
            }
        };

        // Add command based on project type
        if (project.start_command) {
            containerConfig.Cmd = ['/bin/sh', '-c', project.start_command];
        } else {
            containerConfig.Cmd = this.getDefaultCommand(project.type);
        }

        return await docker.createContainer(containerConfig);
    }

    getDockerImage(projectType) {
        const images = {
            'nodejs': 'node:20-alpine',
            'python': 'python:3.11-alpine',
            'static': 'nginx:alpine',
            'react': 'nginx:alpine',
            'nextjs': 'node:20-alpine'
        };
        return images[projectType] || 'node:20-alpine';
    }

    getDefaultCommand(projectType) {
        const commands = {
            'nodejs': ['/bin/sh', '-c', 'cd /app && npm start'],
            'python': ['/bin/sh', '-c', 'cd /app && python3 app.py'],
            'static': null, // nginx runs automatically
            'react': null,  // nginx runs automatically
            'nextjs': ['/bin/sh', '-c', 'cd /app && npm start']
        };
        return commands[projectType];
    }

    async generateNginxConfig(project) {
        const domains = [
            `${project.subdomain}.localhost`,
            `${project.subdomain}.*`
        ];
        if (project.duckdns_subdomain) {
            domains.push(`${project.duckdns_subdomain}.duckdns.org`);
        }

        const config = `
server {
    listen 80;
    server_name ${domains.join(' ')};

    location / {
        ${project.type === 'static' || project.type === 'react' ? `
        root /app/deployments/${project.subdomain};
        index index.html;
        try_files $uri $uri/ /index.html;
        ` : `
        proxy_pass http://openhost-${project.subdomain}:${this.getPort(project.type)};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        `}
    }
}
        `;

        const configPath = `/app/nginx-configs/${project.subdomain}.conf`;
        await fs.writeFile(configPath, config);
    }

    getPort(projectType) {
        const ports = {
            'nodejs': 3000,
            'python': 8000,
            'nextjs': 3000
        };
        return ports[projectType] || 3000;
    }

    async reloadNginx() {
        try {
            await execAsync('nginx -s reload');
            logger.info('Nginx reloaded successfully');
        } catch (error) {
            logger.error('Failed to reload nginx:', error);
        }
    }

    async updateDuckDNS(subdomain, io) {
        const token = process.env.DUCKDNS_TOKEN;
        if (!token) {
            io.emit('build-log', { message: 'Warning: DUCKDNS_TOKEN not set, skipping DuckDNS update', type: 'error' });
            return;
        }

        io.emit('build-log', { message: `Updating DuckDNS for ${subdomain}...`, type: 'info' });
        
        return new Promise((resolve, reject) => {
            https.get(`https://www.duckdns.org/update?domains=${subdomain}&token=${token}&ip=`, (res) => {
                let data = '';
                res.on('data', (chunk) => data += chunk);
                res.on('end', () => {
                    if (data.trim() === 'OK') {
                        io.emit('build-log', { message: `DuckDNS updated successfully for ${subdomain}`, type: 'success' });
                        resolve();
                    } else {
                        io.emit('build-log', { message: `DuckDNS update failed: ${data}`, type: 'error' });
                        resolve(); // Don't fail the whole deployment
                    }
                });
            }).on('error', (err) => {
                io.emit('build-log', { message: `DuckDNS update error: ${err.message}`, type: 'error' });
                resolve(); // Don't fail the whole deployment
            });
        });
    }

    async fileExists(filePath) {
        try {
            await fs.access(filePath);
            return true;
        } catch {
            return false;
        }
    }

    async stopDeployment(subdomain) {
        const containerName = `openhost-${subdomain}`;
        try {
            const container = docker.getContainer(containerName);
            await container.stop();
            await container.remove();
            logger.info(`Stopped and removed container: ${containerName}`);
        } catch (error) {
            logger.warn(`Failed to stop container ${containerName}:`, error.message);
        }

        // Remove nginx config
        const configPath = `/app/nginx-configs/${subdomain}.conf`;
        try {
            await fs.unlink(configPath);
            await this.reloadNginx();
        } catch (error) {
            logger.warn(`Failed to remove nginx config:`, error.message);
        }
    }
}

module.exports = new DeploymentService();