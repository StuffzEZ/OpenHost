const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { authenticateToken } = require('../middleware/auth');
const logger = require('../utils/logger');

const router = express.Router();

// Configure storage
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(__dirname, '../../public/cdn');
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + '-' + file.originalname);
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 50 * 1024 * 1024 } // 50MB
});

// Get all files
router.get('/', authenticateToken, async (req, res) => {
    try {
        const uploadDir = path.join(__dirname, '../../public/cdn');
        if (!fs.existsSync(uploadDir)) {
            return res.json({ files: [] });
        }

        const files = fs.readdirSync(uploadDir).map(filename => {
            const stats = fs.statSync(path.join(uploadDir, filename));
            return {
                name: filename,
                size: stats.size,
                type: path.extname(filename).substring(1),
                url: `${req.protocol}://${req.get('host')}/cdn/${filename}`
            };
        });

        res.json({ files });
    } catch (error) {
        logger.error('Fetch CDN files error:', error);
        res.status(500).json({ error: 'Failed to fetch files' });
    }
});

// Upload file
router.post('/upload', authenticateToken, upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        res.json({
            message: 'File uploaded successfully',
            file: {
                name: req.file.filename,
                size: req.file.size,
                type: path.extname(req.file.filename).substring(1),
                url: `${req.protocol}://${req.get('host')}/cdn/${req.file.filename}`
            }
        });
    } catch (error) {
        logger.error('CDN upload error:', error);
        res.status(500).json({ error: 'Failed to upload file' });
    }
});

// Delete file
router.delete('/:filename', authenticateToken, async (req, res) => {
    try {
        const { filename } = req.params;
        const filePath = path.join(__dirname, '../../public/cdn', filename);

        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            res.json({ message: 'File deleted successfully' });
        } else {
            res.status(404).json({ error: 'File not found' });
        }
    } catch (error) {
        logger.error('CDN delete error:', error);
        res.status(500).json({ error: 'Failed to delete file' });
    }
});

module.exports = router;
