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
        selectedProject: null,
        buildLogs: [],
        toasts: [],
        
        authForm: { email: '', password: '' },
        projectForm: { name: '', subdomain: '', type: 'nodejs', git_url: '', build_command: '', start_command: '' },
        dbForm: { name: '', type: 'postgres' },

        init() {
            this.token = localStorage.getItem('oh_token');
            if (this.token) {
                this.isLoggedIn = true;
                this.user = JSON.parse(localStorage.getItem('oh_user'));
                this.fetchData();
            }
            this.initSocket();
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

        async createProject() {
            this.loading = true;
            try {
                const res = await fetch('/api/projects', {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${this.token}`
                    },
                    body: JSON.stringify(this.projectForm)
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
            // Fetch existing logs if any
            fetch(`/api/deployments/project/${project.id}`, {
                headers: { 'Authorization': `Bearer ${this.token}` }
            })
            .then(res => res.json())
            .then(data => {
                if (data.deployments && data.deployments.length > 0) {
                    const latest = data.deployments[0];
                    if (latest.build_logs) {
                        this.buildLogs = [{
                            timestamp: latest.deployed_at || latest.created_at,
                            message: latest.build_logs,
                            type: 'info'
                        }];
                    }
                }
            });
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
