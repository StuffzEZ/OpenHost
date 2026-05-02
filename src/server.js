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
    crossOriginOpenerPolicy: false
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