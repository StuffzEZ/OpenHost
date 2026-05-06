const { exec, spawn } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');
const https = require('https');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');
const { query } = require('./database');

const execAsync = promisify(exec);

class DeploymentService {
    constructor() {
        this.processes = new Map();
        this.basePort = 10000;
    }

    async buildAndDeploy(project, io) {
        const deploymentId = uuidv4();
        const buildDir = path.join('/app/builds', deploymentId);
        const deployDir = path.join('/app/deployments', project.subdomain);

        try {
            // Stop existing deployment
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

            let port = project.port;
            if (!port && project.type !== 'static' && project.type !== 'react') {
                port = await this.getNextAvailablePort();
                await query('UPDATE projects SET port = $1 WHERE id = $2', [port, project.id]);
                project.port = port;
            }

            // Start process for non-static project types
            if (project.type !== 'static' && project.type !== 'react') {
                await this.startProcess(project, deployDir, io);
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
                port: port
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

    async startProcess(project, deployDir, io) {
        const envVars = {
            ...process.env,
            ...project.env_vars,
            PORT: project.port,
            NODE_ENV: 'production'
        };

        let command, args;
        const startCmd = project.start_command || this.getDefaultStartCommand(project.type);
        
        if (project.type === 'nodejs' || project.type === 'nextjs') {
            command = 'sh';
            args = ['-c', startCmd];
        } else if (project.type === 'python') {
            command = 'sh';
            args = ['-c', startCmd];
        }

        io.emit('build-log', { projectId: project.id, message: `Starting process: ${startCmd} on port ${project.port}`, type: 'info' });

        const child = spawn(command, args, {
            cwd: deployDir,
            env: envVars,
            shell: true
        });

        child.stdout.on('data', (data) => {
            const message = data.toString();
            io.emit('build-log', { projectId: project.id, message, type: 'info' });
            logger.info(`[${project.subdomain}] ${message}`);
        });

        child.stderr.on('data', (data) => {
            const message = data.toString();
            io.emit('build-log', { projectId: project.id, message, type: 'error' });
            logger.error(`[${project.subdomain}] ${message}`);
        });

        child.on('close', (code) => {
            logger.info(`Process for ${project.subdomain} exited with code ${code}`);
            this.processes.delete(project.subdomain);
            
            // Auto-restart if it crashed and project is still active
            if (code !== 0 && code !== null) {
                logger.info(`Attempting to restart ${project.subdomain}...`);
                setTimeout(async () => {
                    try {
                        const check = await query("SELECT status FROM projects WHERE subdomain = $1", [project.subdomain]);
                        if (check.rows.length > 0 && check.rows[0].status === 'active') {
                            await this.startProcess(project, deployDir, io);
                        }
                    } catch (e) {
                        logger.error(`Restart failed for ${project.subdomain}:`, e);
                    }
                }, 5000);
            }
        });

        this.processes.set(project.subdomain, child);
    }

    getDefaultStartCommand(type) {
        if (type === 'nodejs' || type === 'nextjs') return 'npm start';
        if (type === 'python') return 'python3 app.py';
        return 'npm start';
    }

    async getNextAvailablePort() {
        const result = await query('SELECT MAX(port) as max_port FROM projects');
        const maxPort = result.rows[0].max_port || (this.basePort - 1);
        return maxPort + 1;
    }

    async initializeAllProjects(io) {
        logger.info('Initializing all active projects...');
        try {
            const result = await query("SELECT * FROM projects WHERE status = 'active'");
            for (const project of result.rows) {
                if (project.type !== 'static' && project.type !== 'react') {
                    const deployDir = path.join('/app/deployments', project.subdomain);
                    if (await this.fileExists(deployDir)) {
                        await this.startProcess(project, deployDir, io);
                    } else {
                        logger.warn(`Deployment directory not found for project: ${project.subdomain}`);
                    }
                }
            }
            logger.info(`Initialized ${result.rows.length} projects`);
        } catch (error) {
            logger.error('Failed to initialize projects:', error);
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

    async generateNginxConfig(project) {
        const domains = [
            `${project.subdomain}.localhost`,
            `${project.subdomain}.*`
        ];
        
        const rootDomain = process.env.URL || process.env.DUCKDNS_ROOT_DOMAIN;
        if (project.duckdns_subdomain && rootDomain) {
            domains.push(`${project.duckdns_subdomain}.${rootDomain}`);
        } else if (project.duckdns_subdomain) {
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
        proxy_pass http://localhost:${project.port};
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

    async reloadNginx() {
        try {
            await execAsync('nginx -s reload');
            logger.info('Nginx reloaded successfully');
        } catch (error) {
            logger.error('Failed to reload nginx:', error);
        }
    }

    async updateDuckDNS(duckdnsSubdomain, io) {
        const token = process.env.DUCKDNS_TOKEN;
        
        if (!token) {
            io.emit('build-log', { message: 'Warning: DUCKDNS_TOKEN not set, skipping DuckDNS update', type: 'error' });
            return;
        }

        io.emit('build-log', { message: `Updating DuckDNS for ${duckdnsSubdomain}.duckdns.org...`, type: 'info' });
        
        return new Promise((resolve, reject) => {
            https.get(`https://www.duckdns.org/update?domains=${duckdnsSubdomain}&token=${token}&ip=`, (res) => {
                let data = '';
                res.on('data', (chunk) => data += chunk);
                res.on('end', () => {
                    if (data.trim() === 'OK') {
                        io.emit('build-log', { message: `DuckDNS updated successfully`, type: 'success' });
                        resolve();
                    } else {
                        io.emit('build-log', { message: `DuckDNS update failed: ${data}`, type: 'error' });
                        resolve();
                    }
                });
            }).on('error', (err) => {
                io.emit('build-log', { message: `DuckDNS update error: ${err.message}`, type: 'error' });
                resolve();
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
        const child = this.processes.get(subdomain);
        if (child) {
            child.kill();
            this.processes.delete(subdomain);
            logger.info(`Stopped process for: ${subdomain}`);
        }

        // Also try to find and kill process using the port if it was leaked
        // This is a safety measure
        try {
            const projectResult = await query('SELECT port FROM projects WHERE subdomain = $1', [subdomain]);
            if (projectResult.rows.length > 0 && projectResult.rows[0].port) {
                const port = projectResult.rows[0].port;
                await execAsync(`fuser -k ${port}/tcp`).catch(() => {});
            }
        } catch (e) {}

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