const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { query } = require('../services/database');
const { authenticateToken, requirePermission } = require('../middleware/auth');
const logger = require('../utils/logger');

const router = express.Router();

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const userDir = path.join(__dirname, '../../public/cdn', String(req.user.userId));
        if (!fs.existsSync(userDir)) {
            fs.mkdirSync(userDir, { recursive: true });
        }
        cb(null, userDir);
    },
    filename: (req, file, cb) => {
        const hash = crypto.randomBytes(8).toString('hex');
        const ext = path.extname(file.originalname);
        cb(null, `${hash}-${Date.now()}${ext}`);
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const blocked = ['.exe', '.bat', '.cmd', '.sh', '.ps1', '.msi', '.com', '.scr'];
        const ext = path.extname(file.originalname).toLowerCase();
        if (blocked.includes(ext)) {
            return cb(new Error('File type not allowed'));
        }
        cb(null, true);
    }
});

// Helper to build CDN URL using platform settings
async function getCdnUrl(userId, filename) {
    try {
        // Try cdn_domain first, then platform_url, then fall back to relative path
        const cdnDomainResult = await query("SELECT value FROM platform_settings WHERE key = 'cdn_domain'");
        let cdnDomain = cdnDomainResult.rows[0]?.value;

        if (!cdnDomain) {
            const platformUrlResult = await query("SELECT value FROM platform_settings WHERE key = 'platform_url'");
            cdnDomain = platformUrlResult.rows[0]?.value;
        }

        if (cdnDomain) {
            // Ensure no trailing slash
            cdnDomain = cdnDomain.replace(/\/+$/, '');
            return `${cdnDomain}/cdn/${userId}/${filename}`;
        }
    } catch (e) {
        // Fall through to relative URL
    }
    return `/cdn/${userId}/${filename}`;
}

// Get all files
router.get('/', authenticateToken, async (req, res) => {
    try {
        let sql, params;

        if (req.user.isAdmin || req.user.isModerator) {
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

        // Build URLs using the configured CDN domain
        const files = [];
        for (const row of result.rows) {
            const url = await getCdnUrl(row.user_id, row.filename);
            files.push({
                id: row.id,
                name: row.filename,
                original_name: row.original_name,
                size: row.size,
                type: row.mime_type,
                url,
                owner_email: row.owner_email,
                is_owner: row.is_owner
            });
        }

        res.json({ files });
    } catch (error) {
        logger.error('Fetch CDN files error:', error);
        res.status(500).json({ error: 'Failed to fetch files' });
    }
});

// Upload file
router.post('/upload', authenticateToken, requirePermission('cdn.upload'), upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        const serverFilename = `${req.user.userId}/${req.file.filename}`;

        const result = await query(
            'INSERT INTO cdn_assets (user_id, filename, original_name, size, mime_type) VALUES ($1, $2, $3, $4, $5) RETURNING *',
            [req.user.userId, serverFilename, req.file.originalname, req.file.size, req.file.mimetype]
        );

        const url = await getCdnUrl(req.user.userId, req.file.filename);

        res.json({
            message: 'File uploaded successfully',
            file: {
                id: result.rows[0].id,
                name: req.file.filename,
                size: req.file.size,
                type: req.file.mimetype,
                url
            }
        });
    } catch (error) {
        logger.error('CDN upload error:', error);
        res.status(500).json({ error: 'Failed to upload file' });
    }
});

// Delete file
router.delete('/:id', authenticateToken, requirePermission('cdn.delete'), async (req, res) => {
    try {
        const { id } = req.params;

        let sql, params;
        if (req.user.isAdmin || req.user.isModerator) {
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
        // filename is stored as "userId/actualFilename"
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
