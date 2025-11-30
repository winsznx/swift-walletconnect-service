import { Router, Request, Response } from 'express';
import { Logger } from '../utils/Logger';
import { SessionManager } from '../services/SessionManager';
import { NotificationService } from '../services/NotificationService';
import { validateWebhook } from '../utils/validators';

const router = Router();
const logger = new Logger('WebhookRoute');
const sessionManager = SessionManager.getInstance();
const notificationService = NotificationService.getInstance();

/**
 * WalletConnect webhook endpoint
 * Handles incoming webhook events from WalletConnect
 */
router.post('/', async (req: Request, res: Response) => {
    try {
        const webhookData = req.body;

        // Validate webhook signature
        const signature = req.headers['x-walletconnect-signature'] as string;
        if (!signature || !validateWebhook(webhookData, signature)) {
            logger.warn('Invalid webhook signature');
            return res.status(401).json({ error: 'Invalid signature' });
        }

        logger.info('Received webhook event', { type: webhookData.type });

        // Handle different webhook event types
        switch (webhookData.type) {
            case 'session_proposal':
                await handleSessionProposal(webhookData);
                break;

            case 'session_request':
                await handleSessionRequest(webhookData);
                break;

            case 'session_delete':
                await handleSessionDelete(webhookData);
                break;

            case 'session_update':
                await handleSessionUpdate(webhookData);
                break;

            case 'session_ping':
                await handleSessionPing(webhookData);
                break;

            default:
                logger.warn('Unknown webhook type', { type: webhookData.type });
        }

        res.status(200).json({ success: true });
    } catch (error) {
        logger.error('Error processing webhook', error);
        res.status(500).json({ error: 'Failed to process webhook' });
    }
});

/**
 * Handle session proposal webhook
 */
async function handleSessionProposal(data: any): Promise<void> {
    const { topic, params } = data;

    logger.info('Processing session proposal', { topic });

    // Notify connected clients about new session proposal
    await notificationService.sendNotification({
        type: 'session_proposal',
        topic,
        data: params
    });
}

/**
 * Handle session request webhook
 */
async function handleSessionRequest(data: any): Promise<void> {
    const { topic, params } = data;

    logger.info('Processing session request', { topic, method: params.request.method });

    // Forward request to appropriate handler
    await notificationService.sendNotification({
        type: 'session_request',
        topic,
        data: params
    });
}

/**
 * Handle session delete webhook
 */
async function handleSessionDelete(data: any): Promise<void> {
    const { topic } = data;

    logger.info('Processing session delete', { topic });

    // Clean up session data
    await sessionManager.deleteSession(topic);

    // Notify clients about session deletion
    await notificationService.sendNotification({
        type: 'session_delete',
        topic,
        data: {}
    });
}

/**
 * Handle session update webhook
 */
async function handleSessionUpdate(data: any): Promise<void> {
    const { topic, params } = data;

    logger.info('Processing session update', { topic });

    // Update session data
    await sessionManager.updateSession(topic, params);

    // Notify clients about session update
    await notificationService.sendNotification({
        type: 'session_update',
        topic,
        data: params
    });
}

/**
 * Handle session ping webhook
 */
async function handleSessionPing(data: any): Promise<void> {
    const { topic } = data;

    logger.debug('Processing session ping', { topic });

    // Update last activity timestamp
    await sessionManager.updateLastActivity(topic);
}

/**
 * Test webhook endpoint (development only)
 */
router.post('/test', async (req: Request, res: Response) => {
    if (process.env.NODE_ENV === 'production') {
        return res.status(404).json({ error: 'Not found' });
    }

    try {
        logger.info('Test webhook triggered', { data: req.body });
        res.status(200).json({ success: true, echo: req.body });
    } catch (error) {
        logger.error('Error in test webhook', error);
        res.status(500).json({ error: 'Test failed' });
    }
});

export default router;
