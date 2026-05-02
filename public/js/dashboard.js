document.addEventListener('alpine:init', () => {
    Alpine.data('openHost', () => ({
        isLoggedIn: false,
        user: null,
        token: null,
        view: 'projects',
        showModal: null,
        loading: false,
        projects: [],
        databases: [],
        cdnFiles: [],
        allUsers: [],
        selectedProject: null,
        projectTab: 'logs',
        projectDeployments: [],
        buildLogs: [],
        toasts: [],
        systemStats: null,
        
        authForm: { email: '', password: '' },
        projectForm: { 
            name: '', 
            subdomain: '', 
            type: 'nodejs', 
            git_url: '', 
            build_command: '', 
            start_command: '',
            env_vars_raw: '',
            duckdns_subdomain: ''
        },
        dbForm: { name: '', type: 'postgres' },
        passwordForm: { current: '', new: '', confirm: '' },
        userForm: { email: '', password: '', isAdmin: false },

        init() {
            this.token = localStorage.getItem('oh_token');
            if (this.token) {
                this.isLoggedIn = true;
                this.user = JSON.parse(localStorage.getItem('oh_user'));
                this.fetchData();
            }
            this.initSocket();

            this.$watch('view', (value) => {
                if (value === 'settings') this.fetchSettings();
                if (value === 'cdn') this.fetchCdnFiles();
            });
        },

        initSocket() {
            const socket = io();
            socket.on('build-log', (data) => {
                if (this.selectedProject && data.projectId === this.selectedProject.id) {
                    this.buildLogs.push({
                        timestamp: new Date(),
                        message: data.message,
                        type: data.type || 'info'
                    });
                    this.$nextTick(() => {
                        const container = document.getElementById('log-container');
                        if (container) container.scrollTop = container.scrollHeight;
                    });
                }
            });

            socket.on('deployment-complete', (data) => {
                this.showToast(`Deployment ${data.status}: ${data.projectId}`, data.status);
                this.fetchProjects();
            });
        },

        async login() {
            this.loading = true;
            try {
                const res = await fetch('/api/auth/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(this.authForm)
                });
                const data = await res.json();
                if (data.error) throw new Error(data.error);

                this.token = data.token;
                this.user = data.user;
                localStorage.setItem('oh_token', this.token);
                localStorage.setItem('oh_user', JSON.stringify(this.user));
                this.isLoggedIn = true;
                this.fetchData();
                this.showToast('Successfully signed in!', 'success');
            } catch (err) {
                this.showToast(err.message, 'error');
            } finally {
                this.loading = false;
            }
        },

        logout() {
            localStorage.removeItem('oh_token');
            localStorage.removeItem('oh_user');
            this.isLoggedIn = false;
            this.token = null;
            this.user = null;
        },

        async fetchData() {
            await Promise.all([this.fetchProjects(), this.fetchDatabases()]);
        },

        async fetchProjects() {
            try {
                const res = await fetch('/api/projects', {
                    headers: { 'Authorization': `Bearer ${this.token}` }
                });
                const data = await res.json();
                this.projects = data.projects || [];
            } catch (err) {
                console.error('Failed to fetch projects', err);
            }
        },

        async fetchDatabases() {
            try {
                const res = await fetch('/api/databases', {
                    headers: { 'Authorization': `Bearer ${this.token}` }
                });
                const data = await res.json();
                this.databases = data.databases || [];
            } catch (err) {
                console.error('Failed to fetch databases', err);
            }
        },

        async fetchCdnFiles() {
            try {
                const res = await fetch('/api/cdn', {
                    headers: { 'Authorization': `Bearer ${this.token}` }
                });
                const data = await res.json();
                this.cdnFiles = data.files || [];
            } catch (err) {
                console.error('Failed to fetch CDN files', err);
            }
        },

        async fetchSettings() {
            try {
                const res = await fetch('/api/settings', {
                    headers: { 'Authorization': `Bearer ${this.token}` }
                });
                const data = await res.json();
                this.systemStats = data.stats;
                if (this.user.isAdmin) {
                    this.fetchUsers();
                }
            } catch (err) {
                console.error('Failed to fetch settings', err);
            }
        },

        async fetchUsers() {
            try {
                const res = await fetch('/api/settings/users', {
                    headers: { 'Authorization': `Bearer ${this.token}` }
                });
                const data = await res.json();
                this.allUsers = data.users || [];
            } catch (err) {
                console.error('Failed to fetch users', err);
            }
        },

        async createProject() {
            this.loading = true;
            try {
                // Parse env vars
                const env_vars = {};
                if (this.projectForm.env_vars_raw) {
                    this.projectForm.env_vars_raw.split('\n').forEach(line => {
                        const [key, ...valueParts] = line.split('=');
                        if (key && valueParts.length > 0) {
                            env_vars[key.trim()] = valueParts.join('=').trim();
                        }
                    });
                }

                const payload = { ...this.projectForm, env_vars };
                delete payload.env_vars_raw;

                const res = await fetch('/api/projects', {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${this.token}`
                    },
                    body: JSON.stringify(payload)
                });
                const data = await res.json();
                if (data.error) throw new Error(data.error);

                // Trigger initial deployment
                await fetch('/api/deployments', {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${this.token}`
                    },
                    body: JSON.stringify({ projectId: data.project.id })
                });

                this.showModal = null;
                this.fetchProjects();
                this.showToast('Project created and deployment started!', 'success');
                this.selectProject(data.project);
            } catch (err) {
                this.showToast(err.message, 'error');
            } finally {
                this.loading = false;
            }
        },

        async redeployProject(project) {
            try {
                const res = await fetch('/api/deployments', {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${this.token}`
                    },
                    body: JSON.stringify({ projectId: project.id })
                });
                if (!res.ok) throw new Error('Failed to start deployment');
                this.showToast('Redeployment started!', 'success');
                this.buildLogs = [];
                this.projectTab = 'logs';
            } catch (err) {
                this.showToast(err.message, 'error');
            }
        },

        async createDb() {
            this.loading = true;
            try {
                const res = await fetch('/api/databases', {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${this.token}`
                    },
                    body: JSON.stringify(this.dbForm)
                });
                const data = await res.json();
                if (data.error) throw new Error(data.error);

                this.showModal = null;
                this.fetchDatabases();
                this.showToast('Database provisioned successfully!', 'success');
            } catch (err) {
                this.showToast(err.message, 'error');
            } finally {
                this.loading = false;
            }
        },

        async changePassword() {
            if (this.passwordForm.new !== this.passwordForm.confirm) {
                return this.showToast('Passwords do not match', 'error');
            }
            try {
                const res = await fetch('/api/settings/change-password', {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${this.token}`
                    },
                    body: JSON.stringify({
                        currentPassword: this.passwordForm.current,
                        newPassword: this.passwordForm.new
                    })
                });
                const data = await res.json();
                if (data.error) throw new Error(data.error);

                this.showToast('Password updated successfully', 'success');
                this.passwordForm = { current: '', new: '', confirm: '' };
            } catch (err) {
                this.showToast(err.message, 'error');
            }
        },

        async createUser() {
            this.loading = true;
            try {
                const res = await fetch('/api/settings/users', {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${this.token}`
                    },
                    body: JSON.stringify(this.userForm)
                });
                const data = await res.json();
                if (data.error) throw new Error(data.error);

                this.showToast('User created successfully', 'success');
                this.showModal = null;
                this.fetchUsers();
                this.userForm = { email: '', password: '', isAdmin: false };
            } catch (err) {
                this.showToast(err.message, 'error');
            } finally {
                this.loading = false;
            }
        },

        async deleteUser(user) {
            if (!confirm(`Delete user ${user.email}?`)) return;
            try {
                const res = await fetch(`/api/settings/users/${user.id}`, {
                    method: 'DELETE',
                    headers: { 'Authorization': `Bearer ${this.token}` }
                });
                if (!res.ok) throw new Error('Failed to delete user');
                this.showToast('User deleted', 'success');
                this.fetchUsers();
            } catch (err) {
                this.showToast(err.message, 'error');
            }
        },

        async uploadFile(event) {
            const file = event.target.files[0];
            if (!file) return;

            const formData = new FormData();
            formData.append('file', file);

            this.loading = true;
            try {
                const res = await fetch('/api/cdn/upload', {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${this.token}` },
                    body: formData
                });
                const data = await res.json();
                if (data.error) throw new Error(data.error);

                this.showToast('File uploaded successfully', 'success');
                this.showModal = null;
                this.fetchCdnFiles();
            } catch (err) {
                this.showToast(err.message, 'error');
            } finally {
                this.loading = false;
            }
        },

        async deleteCdnFile(filename) {
            if (!confirm(`Delete ${filename}?`)) return;
            try {
                const res = await fetch(`/api/cdn/${filename}`, {
                    method: 'DELETE',
                    headers: { 'Authorization': `Bearer ${this.token}` }
                });
                if (!res.ok) throw new Error('Failed to delete file');
                this.showToast('File deleted', 'success');
                this.fetchCdnFiles();
            } catch (err) {
                this.showToast(err.message, 'error');
            }
        },

        async deleteProject(project) {
            if (!confirm(`Are you sure you want to delete ${project.name}? This will stop all containers and delete all files.`)) return;
            
            try {
                const res = await fetch(`/api/projects/${project.id}`, {
                    method: 'DELETE',
                    headers: { 'Authorization': `Bearer ${this.token}` }
                });
                if (!res.ok) throw new Error('Failed to delete project');
                
                this.selectedProject = null;
                this.fetchProjects();
                this.showToast('Project deleted', 'success');
            } catch (err) {
                this.showToast(err.message, 'error');
            }
        },

        selectProject(project) {
            this.selectedProject = project;
            this.buildLogs = [];
            this.projectTab = 'logs';
            this.fetchProjectDeployments(project.id);
        },

        async fetchProjectDeployments(projectId) {
            try {
                const res = await fetch(`/api/deployments/project/${projectId}`, {
                    headers: { 'Authorization': `Bearer ${this.token}` }
                });
                const data = await res.json();
                this.projectDeployments = data.deployments || [];
                
                if (this.projectDeployments.length > 0) {
                    const latest = this.projectDeployments[0];
                    if (latest.build_logs) {
                        this.buildLogs = [{
                            timestamp: latest.deployed_at || latest.created_at,
                            message: latest.build_logs,
                            type: 'info'
                        }];
                    }
                }
            } catch (err) {
                console.error('Failed to fetch deployments', err);
            }
        },

        viewDeploymentLogs(deployment) {
            this.buildLogs = [{
                timestamp: deployment.deployed_at || deployment.created_at,
                message: deployment.build_logs || 'No logs available for this deployment',
                type: 'info'
            }];
            this.projectTab = 'logs';
        },

        getProjectIcon(type) {
            const icons = {
                'nodejs': 'fab fa-node-js',
                'python': 'fab fa-python',
                'static': 'fas fa-file-code',
                'react': 'fab fa-react',
                'nextjs': 'fas fa-n'
            };
            return icons[type] || 'fas fa-code';
        },

        getDbIcon(type) {
            const icons = {
                'postgres': 'fas fa-elephant',
                'redis': 'fas fa-bolt',
                'mongodb': 'fas fa-leaf'
            };
            return icons[type.toLowerCase()] || 'fas fa-database';
        },

        getStatusClass(status) {
            const classes = {
                'active': 'bg-green-100 text-green-700',
                'building': 'bg-blue-100 text-blue-700 animate-pulse',
                'failed': 'bg-red-100 text-red-700',
                'inactive': 'bg-gray-100 text-gray-700'
            };
            return classes[status] || 'bg-gray-100 text-gray-700';
        },

        formatDate(date) {
            if (!date) return 'Never';
            return new Date(date).toLocaleDateString() + ' ' + new Date(date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        },

        formatSize(bytes) {
            if (bytes === 0) return '0 Bytes';
            const k = 1024;
            const sizes = ['Bytes', 'KB', 'MB', 'GB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
        },

        formatUptime(seconds) {
            if (!seconds) return '0s';
            const h = Math.floor(seconds / 3600);
            const m = Math.floor((seconds % 3600) / 60);
            const s = Math.floor(seconds % 60);
            return `${h}h ${m}m ${s}s`;
        },

        showToast(message, type = 'success') {
            const id = Date.now();
            this.toasts.push({ id, message, type });
            setTimeout(() => {
                this.toasts = this.toasts.filter(t => t.id !== id);
            }, 5000);
        },

        copy(text) {
            navigator.clipboard.writeText(text);
            this.showToast('Copied to clipboard!', 'success');
        }
    }));
});
