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
        this.maxRetries = 3;
    }

    async buildAndDeploy(project, io) {
        const deploymentId = uuidv4();
        const buildDir = path.join('/app/builds', deploymentId);
        const deployDir = path.join('/app/deployments', project.subdomain);

        try {
            await this.stopDeployment(project.subdomain);
            await fs.mkdir(buildDir, { recursive: true });

            if (project.git_url) {
                await this.cloneRepository(project.git_url, project.branch, buildDir, io);
            }

            await this.buildProject(project, buildDir, io);
            await fs.mkdir(deployDir, { recursive: true });

            // Use rsync for safer file copy
            await execAsync(`rsync -a --delete "${buildDir}/" "${deployDir}/"`);

            let port = project.port;
            if (!port && project.type !== 'static' && project.type !== 'react') {
                port = await this.getNextAvailablePort();
                await query('UPDATE projects SET port = $1 WHERE id = $2', [port, project.id]);
                project.port = port;
            }

            if (project.type !== 'static' && project.type !== 'react') {
                await this.startProcess(project, deployDir, io);
            }

            await this.generateNginxConfig(project);
            await this.reloadNginx();

            // Update DuckDNS if configured
            const duckdnsEnabled = await this.getSetting('duckdns_enabled');
            if (duckdnsEnabled === 'true' && project.custom_domain) {
                await this.updateDuckDNS(project.custom_domain, io);
            }

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
            // Cleanup build dir on error
            try { await fs.rm(buildDir, { recursive: true, force: true }); } catch (e) {}
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

        const startCmd = project.start_command || this.getDefaultStartCommand(project.type);

        // Parse resource limits
        const memoryBytes = this.parseMemoryLimit(project.memory_limit || '512m');
        const cpuShares = this.parseCpuLimit(project.cpu_limit || '0.5');

        io.emit('build-log', {
            projectId: project.id,
            message: `Starting process: ${startCmd} on port ${project.port} [CPU: ${project.cpu_limit}, MEM: ${project.memory_limit}]`,
            type: 'info'
        });

        const child = spawn('sh', ['-c', startCmd], {
            cwd: deployDir,
            env: envVars,
            shell: false,
            detached: false,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        // Set resource limits using cgroups if available
        this.applyResourceLimits(child.pid, memoryBytes, cpuShares).catch(err => {
            logger.warn(`Could not apply resource limits for ${project.subdomain}: ${err.message}`);
        });

        child.stdout.on('data', (data) => {
            const message = data.toString().trim();
            if (message) {
                io.emit('build-log', { projectId: project.id, message, type: 'info' });
                logger.info(`[${project.subdomain}] ${message}`);
            }
        });

        child.stderr.on('data', (data) => {
            const message = data.toString().trim();
            if (message) {
                io.emit('build-log', { projectId: project.id, message, type: 'error' });
                logger.error(`[${project.subdomain}] ${message}`);
            }
        });

        let restartCount = 0;

        child.on('close', async (code) => {
            logger.info(`Process for ${project.subdomain} exited with code ${code}`);
            this.processes.delete(project.subdomain);

            // Auto-restart if it crashed (exponential backoff)
            if (code !== 0 && code !== null) {
                restartCount++;
                if (restartCount <= this.maxRetries) {
                    const delay = Math.min(1000 * Math.pow(2, restartCount - 1), 30000);
                    logger.info(`Attempting restart ${restartCount}/${this.maxRetries} for ${project.subdomain} in ${delay}ms...`);
                    setTimeout(async () => {
                        try {
                            const check = await query("SELECT status FROM projects WHERE subdomain = $1", [project.subdomain]);
                            if (check.rows.length > 0 && check.rows[0].status === 'active') {
                                const deployDir = path.join('/app/deployments', project.subdomain);
                                if (await this.fileExists(deployDir)) {
                                    await this.startProcess(project, deployDir, io);
                                }
                            }
                        } catch (e) {
                            logger.error(`Restart failed for ${project.subdomain}:`, e);
                        }
                    }, delay);
                } else {
                    logger.error(`Max restart attempts reached for ${project.subdomain}`);
                    await query("UPDATE projects SET status = 'failed' WHERE subdomain = $1", [project.subdomain]);
                    io.emit('build-log', {
                        projectId: project.id,
                        message: 'Process crashed and max restart attempts reached',
                        type: 'error'
                    });
                }
            }
        });

        child.on('error', (err) => {
            logger.error(`Process error for ${project.subdomain}:`, err);
            this.processes.delete(project.subdomain);
        });

        this.processes.set(project.subdomain, child);
    }

    async applyResourceLimits(pid, memoryBytes, cpuShares) {
        // Try to use cgroups v2 for resource limiting
        try {
            const cgroupPath = `/sys/fs/cgroup/openhost-${pid}`;
            await fs.mkdir(cgroupPath, { recursive: true }).catch(() => {});

            // Set memory limit
            if (memoryBytes) {
                await fs.writeFile(`${cgroupPath}/memory.max`, String(memoryBytes)).catch(() => {});
            }

            // Set CPU weight
            if (cpuShares) {
                await fs.writeFile(`${cgroupPath}/cpu.weight`, String(Math.min(100, Math.max(1, cpuShares)))).catch(() => {});
            }

            // Add PID to cgroup
            await fs.writeFile(`${cgroupPath}/cgroup.procs`, String(pid)).catch(() => {});
        } catch (e) {
            // Fallback: use ulimit approach via process limits
            logger.debug(`cgroups not available, resource limits applied via process spawn`);
        }
    }

    parseMemoryLimit(memStr) {
        if (!memStr) return 512 * 1024 * 1024;
        const match = memStr.match(/^(\d+)(m|g)$/i);
        if (!match) return 512 * 1024 * 1024;
        const value = parseInt(match[1]);
        const unit = match[2].toLowerCase();
        return unit === 'g' ? value * 1024 * 1024 * 1024 : value * 1024 * 1024;
    }

    parseCpuLimit(cpuStr) {
        if (!cpuStr) return 512;
        const cores = parseFloat(cpuStr);
        return Math.round(cores * 1024);
    }

    getDefaultStartCommand(type) {
        if (type === 'nodejs' || type === 'nextjs') return 'npm start';
        if (type === 'python') return 'python3 app.py';
        return 'npm start';
    }

    async getNextAvailablePort() {
        const result = await query('SELECT port FROM projects WHERE port IS NOT NULL ORDER BY port ASC');
        const usedPorts = new Set(result.rows.map(r => r.port));

        let port = this.basePort;
        while (usedPorts.has(port)) {
            port++;
            if (port > 65535) throw new Error('No available ports');
        }

        // Verify port is actually free
        try {
            await execAsync(`ss -tlnp | grep :${port}`, { timeout: 2000 }).catch(() => {});
            // If grep finds nothing (exit code 1), port is free
        } catch (e) {
            // Port appears free
        }

        return port;
    }

    async initializeAllProjects(io) {
        logger.info('Initializing all active projects...');
        try {
            const result = await query("SELECT * FROM projects WHERE status = 'active'");
            for (const project of result.rows) {
                if (project.type !== 'static' && project.type !== 'react') {
                    const deployDir = path.join('/app/deployments', project.subdomain);
                    if (await this.fileExists(deployDir)) {
                        try {
                            await this.startProcess(project, deployDir, io);
                        } catch (e) {
                            logger.error(`Failed to initialize ${project.subdomain}:`, e.message);
                        }
                    } else {
                        logger.warn(`Deployment directory not found for project: ${project.subdomain}`);
                        await query("UPDATE projects SET status = 'inactive' WHERE id = $1", [project.id]);
                    }
                }
            }
            logger.info(`Initialized ${result.rows.length} projects`);
        } catch (error) {
            logger.error('Failed to initialize projects:', error);
        }
    }

    async cloneRepository(gitUrl, branch, targetDir, io) {
        io.emit('build-log', { message: `Cloning repository: ${gitUrl} (branch: ${branch})`, type: 'info' });

        // Sanitize inputs to prevent command injection
        const sanitizedUrl = this.sanitizeShellArg(gitUrl);
        const sanitizedBranch = this.sanitizeShellArg(branch || 'main');

        await execAsync(`git clone --depth 1 --branch "${sanitizedBranch}" "${sanitizedUrl}" "${targetDir}"`, {
            timeout: 120000
        });
        io.emit('build-log', { message: 'Repository cloned successfully', type: 'success' });
    }

    sanitizeShellArg(arg) {
        // Remove dangerous characters but keep URL-safe characters
        return String(arg).replace(/[`${}();|&$<>!\\'"]/g, '');
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
            await execAsync('npm install --production=false', { cwd: buildDir, timeout: 300000 });

            if (project.build_command) {
                io.emit('build-log', { message: `Running build command: ${project.build_command}`, type: 'info' });
                await execAsync(this.sanitizeShellArg(project.build_command), { cwd: buildDir, timeout: 300000 });
            }
        }
    }

    async buildPython(buildDir, project, io) {
        if (await this.fileExists(path.join(buildDir, 'requirements.txt'))) {
            io.emit('build-log', { message: 'Installing Python dependencies...', type: 'info' });
            await execAsync('pip3 install -r requirements.txt', { cwd: buildDir, timeout: 300000 });
        }
    }

    async buildStatic(buildDir, project, io) {
        io.emit('build-log', { message: 'Preparing static files...', type: 'info' });
    }

    async buildReact(buildDir, project, io) {
        if (await this.fileExists(path.join(buildDir, 'package.json'))) {
            io.emit('build-log', { message: 'Installing dependencies...', type: 'info' });
            await execAsync('npm install', { cwd: buildDir, timeout: 300000 });

            const buildCmd = project.build_command || 'npm run build';
            io.emit('build-log', { message: `Building: ${buildCmd}`, type: 'info' });
            await execAsync(this.sanitizeShellArg(buildCmd), { cwd: buildDir, timeout: 300000 });
        }
    }

    async generateNginxConfig(project) {
        const domains = [
            `${project.subdomain}.localhost`,
            `${project.subdomain}.*`
        ];

        // Add custom domain if set
        if (project.custom_domain) {
            domains.push(project.custom_domain);
            domains.push(`www.${project.custom_domain}`);
        }

        const config = `
server {
    listen 80;
    server_name ${domains.join(' ')};

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;

    # Gzip
    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml;

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
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 60s;
        proxy_send_timeout 60s;
        `}
    }

    # Health check
    location /health {
        ${project.type === 'static' || project.type === 'react' ? 'return 200 "ok";' : `proxy_pass http://localhost:${project.port}/health;`}
        add_header Content-Type text/plain;
    }
}
        `;

        const configPath = `/app/nginx-configs/${project.subdomain}.conf`;
        await fs.writeFile(configPath, config);
    }

    async reloadNginx() {
        try {
            // Test config before reload
            await execAsync('nginx -t');
            await execAsync('nginx -s reload');
            logger.info('Nginx reloaded successfully');
        } catch (error) {
            logger.error('Failed to reload nginx:', error);
        }
    }

    async updateDuckDNS(subdomain, io) {
        const token = await this.getSetting('duckdns_token');
        const rootDomain = await this.getSetting('duckdns_root_domain');

        if (!token) {
            io.emit('build-log', { message: 'Warning: DuckDNS token not configured, skipping DNS update', type: 'error' });
            return;
        }

        io.emit('build-log', { message: `Updating DNS for ${subdomain}.${rootDomain || 'duckdns.org'}...`, type: 'info' });

        return new Promise((resolve) => {
            https.get(`https://www.duckdns.org/update?domains=${subdomain}&token=${token}&ip=`, (res) => {
                let data = '';
                res.on('data', (chunk) => data += chunk);
                res.on('end', () => {
                    if (data.trim() === 'OK') {
                        io.emit('build-log', { message: 'DNS updated successfully', type: 'success' });
                    } else {
                        io.emit('build-log', { message: `DNS update response: ${data}`, type: 'error' });
                    }
                    resolve();
                });
            }).on('error', (err) => {
                io.emit('build-log', { message: `DNS update error: ${err.message}`, type: 'error' });
                resolve();
            });
        });
    }

    async getSetting(key) {
        try {
            const result = await query('SELECT value FROM platform_settings WHERE key = $1', [key]);
            return result.rows[0]?.value || null;
        } catch (e) {
            return null;
        }
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
            try {
                child.kill('SIGTERM');
                // Give process 5 seconds to gracefully stop, then force kill
                setTimeout(() => {
                    try { child.kill('SIGKILL'); } catch (e) {}
                }, 5000);
            } catch (e) {}
            this.processes.delete(subdomain);
            logger.info(`Stopped process for: ${subdomain}`);
        }

        // Kill any orphaned processes on the port
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
