const express = require('express');
const { query } = require('../services/database');
const deploymentService = require('../services/deployment');
const { authenticateToken, requirePermission } = require('../middleware/auth');
const logger = require('../utils/logger');

const router = express.Router();

// Get all deployments for a project
router.get('/project/:projectId', authenticateToken, async (req, res) => {
    try {
        const { projectId } = req.params;

        let sql, params;
        if (req.user.isAdmin || req.user.isModerator) {
            sql = `SELECT d.* FROM deployments d WHERE d.project_id = $1 ORDER BY d.created_at DESC`;
            params = [projectId];
        } else {
            sql = `SELECT d.* FROM deployments d
                   JOIN projects p ON d.project_id = p.id
                   WHERE p.id = $1 AND (p.user_id = $2
                   OR p.id IN (SELECT resource_id FROM shared_access WHERE resource_type = 'project' AND user_id = $2))
                   ORDER BY d.created_at DESC`;
            params = [projectId, req.user.userId];
        }

        const result = await query(sql, params);
        res.json({ deployments: result.rows });
    } catch (error) {
        logger.error('Get deployments error:', error);
        res.status(500).json({ error: 'Failed to fetch deployments' });
    }
});

// Webhook deployment trigger (CI/CD)
router.post('/webhook', async (req, res) => {
    try {
        const { projectId, token } = req.body;

        if (!projectId || !token) {
            return res.status(400).json({ error: 'Project ID and Token are required' });
        }

        const projectResult = await query(
            'SELECT * FROM projects WHERE id = $1 AND deploy_token = $2',
            [projectId, token]
        );

        if (projectResult.rows.length === 0) {
            return res.status(403).json({ error: 'Invalid Project ID or Deploy Token' });
        }

        const project = projectResult.rows[0];

        if (!project.auto_deploy) {
            return res.status(403).json({ error: 'Auto-deploy is disabled for this project' });
        }

        const deploymentResult = await query(
            `INSERT INTO deployments (project_id, version, status)
             VALUES ($1, $2, $3) RETURNING *`,
            [projectId, `CI-${new Date().toISOString()}`, 'building']
        );

        const deployment = deploymentResult.rows[0];
        const io = req.app.get('io');

        deploymentService.buildAndDeploy(project, io)
            .then(async (result) => {
                await query(
                    `UPDATE deployments SET status = $1, deploy_url = $2, deployed_at = NOW()
                     WHERE id = $3`,
                    ['success', result.url, deployment.id]
                );
                await query('UPDATE projects SET status = $1, last_deployed_at = NOW(), updated_at = NOW() WHERE id = $2', ['active', projectId]);
                io.emit('deployment-complete', { deploymentId: deployment.id, projectId, status: 'success' });
            })
            .catch(async (error) => {
                await query(`UPDATE deployments SET status = $1, build_logs = $2 WHERE id = $3`, ['failed', error.message, deployment.id]);
                io.emit('deployment-complete', { deploymentId: deployment.id, projectId, status: 'failed' });
            });

        res.status(202).json({ message: 'Deployment triggered via webhook', deploymentId: deployment.id });
    } catch (error) {
        logger.error('Webhook deployment error:', error);
        res.status(500).json({ error: 'Failed to trigger deployment' });
    }
});

// Create new deployment manually
router.post('/', authenticateToken, requirePermission('projects.deploy'), async (req, res) => {
    try {
        const { projectId } = req.body;

        let projectResult;
        if (req.user.isAdmin || req.user.isModerator) {
            projectResult = await query('SELECT * FROM projects WHERE id = $1', [projectId]);
        } else {
            projectResult = await query(
                'SELECT * FROM projects WHERE id = $1 AND user_id = $2',
                [projectId, req.user.userId]
            );
        }

        if (projectResult.rows.length === 0) {
            return res.status(404).json({ error: 'Project not found' });
        }

        const project = projectResult.rows[0];

        // Check if approval is required
        const approvalSetting = await query("SELECT value FROM platform_settings WHERE key = 'require_approval'");
        const requireApproval = approvalSetting.rows[0]?.value === 'true';

        if (requireApproval && !req.user.isAdmin) {
            // Create approval request
            const approvalResult = await query(
                `INSERT INTO admin_approvals (user_id, resource_type, resource_name, request_data, status)
                 VALUES ($1, 'deployment', $2, $3, 'pending') RETURNING *`,
                [req.user.userId, project.name, JSON.stringify({ projectId, projectName: project.name })]
            );

            return res.status(202).json({
                message: 'Deployment submitted for admin approval',
                approvalId: approvalResult.rows[0].id
            });
        }

        const deploymentResult = await query(
            `INSERT INTO deployments (project_id, version, status)
             VALUES ($1, $2, $3) RETURNING *`,
            [projectId, new Date().toISOString(), 'building']
        );

        const deployment = deploymentResult.rows[0];
        const io = req.app.get('io');

        await query('UPDATE projects SET status = $1 WHERE id = $2', ['building', projectId]);

        deploymentService.buildAndDeploy(project, io)
            .then(async (result) => {
                await query(
                    `UPDATE deployments SET status = $1, deploy_url = $2, deployed_at = NOW()
                     WHERE id = $3`,
                    ['success', result.url, deployment.id]
                );
                await query(
                    'UPDATE projects SET status = $1, last_deployed_at = NOW(), updated_at = NOW() WHERE id = $2',
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
                await query('UPDATE projects SET status = $1 WHERE id = $2', ['failed', projectId]);
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

        let sql, params;
        if (req.user.isAdmin || req.user.isModerator) {
            sql = 'SELECT d.build_logs FROM deployments d WHERE d.id = $1';
            params = [id];
        } else {
            sql = `SELECT d.build_logs FROM deployments d
                   JOIN projects p ON d.project_id = p.id
                   WHERE d.id = $1 AND (p.user_id = $2
                   OR p.id IN (SELECT resource_id FROM shared_access WHERE resource_type = 'project' AND user_id = $2))`;
            params = [id, req.user.userId];
        }

        const result = await query(sql, params);
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
