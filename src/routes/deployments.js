const express = require('express');
const { query } = require('../services/database');
const deploymentService = require('../services/deployment');
const { authenticateToken } = require('../middleware/auth');
const logger = require('../utils/logger');

const router = express.Router();

// Get all deployments for a project
router.get('/project/:projectId', authenticateToken, async (req, res) => {
    try {
        const { projectId } = req.params;
        
        const result = await query(
            `SELECT d.* FROM deployments d
             JOIN projects p ON d.project_id = p.id
             WHERE p.id = $1 AND p.user_id = $2
             ORDER BY d.created_at DESC`,
            [projectId, req.user.userId]
        );

        res.json({ deployments: result.rows });
    } catch (error) {
        logger.error('Get deployments error:', error);
        res.status(500).json({ error: 'Failed to fetch deployments' });
    }
});

// Create new deployment
router.post('/', authenticateToken, async (req, res) => {
    try {
        const { projectId } = req.body;

        // Get project
        const projectResult = await query(
            'SELECT * FROM projects WHERE id = $1 AND user_id = $2',
            [projectId, req.user.userId]
        );

        if (projectResult.rows.length === 0) {
            return res.status(404).json({ error: 'Project not found' });
        }

        const project = projectResult.rows[0];

        // Create deployment record
        const deploymentResult = await query(
            `INSERT INTO deployments (project_id, version, status) 
             VALUES ($1, $2, $3) RETURNING *`,
            [projectId, new Date().toISOString(), 'building']
        );

        const deployment = deploymentResult.rows[0];

        // Start deployment process asynchronously
        const io = req.app.get('io');
        
        deploymentService.buildAndDeploy(project, io)
            .then(async (result) => {
                await query(
                    `UPDATE deployments SET status = $1, deploy_url = $2, deployed_at = NOW() 
                     WHERE id = $3`,
                    ['success', result.url, deployment.id]
                );
                
                await query(
                    'UPDATE projects SET status = $1, updated_at = NOW() WHERE id = $2',
                    ['active', projectId]
                );

                io.emit('deployment-complete', {
                    deploymentId: deployment.id,
                    projectId,
                    status: 'success',
                    url: result.url
                });
            })
            .catch(async (error) => {
                await query(
                    `UPDATE deployments SET status = $1, build_logs = $2 WHERE id = $3`,
                    ['failed', error.message, deployment.id]
                );

                io.emit('deployment-complete', {
                    deploymentId: deployment.id,
                    projectId,
                    status: 'failed',
                    error: error.message
                });
            });

        res.status(202).json({ 
            message: 'Deployment started',
            deployment: deployment
        });
    } catch (error) {
        logger.error('Create deployment error:', error);
        res.status(500).json({ error: 'Failed to create deployment' });
    }
});

// Get deployment logs
router.get('/:id/logs', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;

        const result = await query(
            `SELECT d.build_logs FROM deployments d
             JOIN projects p ON d.project_id = p.id
             WHERE d.id = $1 AND p.user_id = $2`,
            [id, req.user.userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Deployment not found' });
        }

        res.json({ logs: result.rows[0].build_logs || '' });
    } catch (error) {
        logger.error('Get logs error:', error);
        res.status(500).json({ error: 'Failed to fetch logs' });
    }
});

module.exports = router;