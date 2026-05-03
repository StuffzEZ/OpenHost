const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');
const http = require('http');
const socketIo = require('socket.io');
require('dotenv').config();

const { initDatabase } = require('./services/database');
const logger = require('./utils/logger');
const authRoutes = require('./routes/auth');
const deploymentRoutes = require('./routes/deployments');
const projectRoutes = require('./routes/projects');
const databaseRoutes = require('./routes/databases');
const settingsRoutes = require('./routes/settings');
const cdnRoutes = require('./routes/cdn');
const sharingRoutes = require('./routes/sharing');
const statusRoutes = require('./routes/status');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

const PORT = process.env.PORT || 3000;

// Make io accessible to routes
app.set('io', io);

// Middleware
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    originAgentCluster: false
}));
app.use(cors());

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per windowMs
    message: { error: 'Too many requests, please try again later.' }
});
app.use('/api/', limiter);

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Session configuration
app.use(session({
    secret: process.env.SESSION_SECRET || 'openhost-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));

// Serve static files
app.use(express.static(path.join(__dirname, '../public')));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/deployments', deploymentRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/databases', databaseRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/cdn', cdnRoutes);
app.use('/api/sharing', sharingRoutes);
app.use('/api/status', statusRoutes);

// Public status page route
app.get('/status/:slug', async (req, res) => {
    try {
        const { query } = require('./services/database');
        const pageResult = await query('SELECT * FROM status_pages WHERE slug = $1', [req.params.slug]);
        
        if (pageResult.rows.length === 0) {
            return res.status(404).send('Status page not found');
        }

        const page = pageResult.rows[0];
        if (!page.is_public) {
            return res.status(403).send('This status page is private');
        }

        const itemsResult = await query(`
            SELECT si.*, 
            CASE 
                WHEN si.resource_type = 'project' THEN (SELECT status FROM projects WHERE id = si.resource_id)
                WHEN si.resource_type = 'database' THEN (SELECT status FROM databases WHERE id = si.resource_id)
            END as status,
            CASE 
                WHEN si.resource_type = 'project' AND $2 = true THEN (
                    SELECT created_at FROM deployments 
                    WHERE project_id = si.resource_id AND status = 'success' 
                    ORDER BY created_at DESC LIMIT 1
                )
                ELSE NULL
            END as last_deployment
            FROM status_page_items si
            WHERE si.status_page_id = $1
        `, [page.id, page.show_last_deployment]);

        res.send(\`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>\${page.title} - OpenHost Status</title>
    <link rel="stylesheet" href="/css/tailwind.min.css">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
    <style>
        .dark { background-color: #0f172a; color: #f8fafc; }
        .dark .card { background-color: #1e293b; border-color: #334155; }
        .dark h1, .dark h3 { color: white; }
    </style>
    <script>
        if (localStorage.getItem('oh_dark_mode') === 'true') {
            document.documentElement.classList.add('dark');
        }
    </script>
</head>
<body class="bg-gray-50 min-h-screen py-12 transition-colors duration-200">
    <div class="max-w-3xl mx-auto px-4">
        <div class="text-center mb-12">
            <h1 class="text-4xl font-bold mb-4 text-gray-900">\${page.title}</h1>
            \${page.description ? \`<p class="text-gray-500 dark:text-gray-400 text-lg">\${page.description}</p>\` : ''}
        </div>

        <div class="space-y-4">
            \${itemsResult.rows.map(item => \`
                <div class="card bg-white p-6 rounded-2xl border border-gray-200 shadow-sm flex items-center justify-between">
                    <div>
                        <div class="flex items-center gap-3">
                            <i class="fas \${item.resource_type === 'project' ? 'fa-rocket text-blue-500' : 'fa-database text-purple-500'}"></i>
                            <h3 class="font-bold text-xl text-gray-800">\${item.display_name}</h3>
                        </div>
                        \${item.last_deployment ? \`
                            <p class="text-xs text-gray-400 mt-1 uppercase font-bold tracking-widest">
                                Last Deployed: \${new Date(item.last_deployment).toLocaleString()}
                            </p>
                        \` : ''}
                    </div>
                    <div class="flex items-center gap-2">
                        <span class="w-3 h-3 rounded-full \${item.status === 'active' || item.status === 'success' ? 'bg-green-500' : 'bg-red-500'} animate-pulse"></span>
                        <span class="font-bold uppercase tracking-tighter text-sm \${item.status === 'active' || item.status === 'success' ? 'text-green-600' : 'text-red-600'}">
                            \${item.status === 'active' || item.status === 'success' ? 'Operational' : 'Outage'}
                        </span>
                    </div>
                </div>
            \`).join('')}
            \${itemsResult.rows.length === 0 ? '<p class="text-center text-gray-400 italic">No items monitored on this page.</p>' : ''}
        </div>

        <div class="mt-12 pt-8 border-t border-gray-200 dark:border-gray-800 text-center">
            <p class="text-gray-400 text-sm">Powered by <span class="font-bold text-black dark:text-white">OpenHost</span></p>
        </div>
    </div>
</body>
</html>
        \`);
    } catch (error) {
        console.error('Public status page error:', error);
        res.status(500).send('Internal Server Error');
    }
});

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Serve dashboard for all other routes
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/index.html'));
});

// WebSocket for real-time build logs
io.on('connection', (socket) => {
    logger.info('Client connected to WebSocket');
    
    socket.on('disconnect', () => {
        logger.info('Client disconnected from WebSocket');
    });
});

// Error handling
app.use((err, req, res, next) => {
    logger.error('Server error:', err);
    res.status(500).json({ 
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
});

// Initialize database and start server
async function start() {
    try {
        await initDatabase();
        logger.info('Database initialized successfully');
        
        server.listen(PORT, '0.0.0.0', () => {
            logger.info(`OpenHost server running on port ${PORT}`);
            logger.info(`Environment: ${process.env.NODE_ENV}`);
        });
    } catch (error) {
        logger.error('Failed to start server:', error);
        process.exit(1);
    }
}

start();

module.exports = { app, io };