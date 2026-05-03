const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { query } = require('../services/database');
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
        let sql;
        let params;

        if (req.user.isAdmin) {
            sql = `
                SELECT c.*, u.email as owner_email,
                CASE WHEN c.user_id = $1 THEN true ELSE false END as is_owner
                FROM cdn_assets c
                JOIN users u ON c.user_id = u.id
                ORDER BY c.created_at DESC
            `;
            params = [req.user.userId];
        } else {
            sql = `
                SELECT c.*, u.email as owner_email,
                CASE WHEN c.user_id = $1 THEN true ELSE false END as is_owner
                FROM cdn_assets c
                JOIN users u ON c.user_id = u.id
                WHERE c.user_id = $1
                OR c.id IN (SELECT resource_id FROM shared_access WHERE resource_type = 'cdn' AND user_id = $1)
                ORDER BY c.created_at DESC
            `;
            params = [req.user.userId];
        }

        const result = await query(sql, params);
        
        const files = result.rows.map(row => ({
            id: row.id,
            name: row.filename,
            original_name: row.original_name,
            size: row.size,
            type: row.mime_type,
            url: `${req.protocol}://${req.get('host')}/cdn/${row.filename}`,
            owner_email: row.owner_email,
            is_owner: row.is_owner
        }));

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

        // Save to DB
        const result = await query(
            'INSERT INTO cdn_assets (user_id, filename, original_name, size, mime_type) VALUES ($1, $2, $3, $4, $5) RETURNING *',
            [req.user.userId, req.file.filename, req.file.originalname, req.file.size, path.extname(req.file.filename).substring(1)]
        );

        res.json({
            message: 'File uploaded successfully',
            file: {
                id: result.rows[0].id,
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
router.delete('/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        
        let sql;
        let params;

        if (req.user.isAdmin) {
            sql = 'SELECT * FROM cdn_assets WHERE id = $1';
            params = [id];
        } else {
            sql = 'SELECT * FROM cdn_assets WHERE id = $1 AND user_id = $2';
            params = [id, req.user.userId];
        }

        const result = await query(sql, params);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'File not found or unauthorized' });
        }

        const file = result.rows[0];
        const filePath = path.join(__dirname, '../../public/cdn', file.filename);

        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
        
        await query('DELETE FROM cdn_assets WHERE id = $1', [id]);
        
        res.json({ message: 'File deleted successfully' });
    } catch (error) {
        logger.error('CDN delete error:', error);
        res.status(500).json({ error: 'Failed to delete file' });
    }
});

module.exports = router;
