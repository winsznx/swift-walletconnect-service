import { Logger } from '../utils/Logger';
import { EventEmitter } from 'events';

/**
 * Notification types
 */
export type NotificationType =
    | 'session_proposal'
    | 'session_request'
    | 'session_update'
    | 'session_delete'
    | 'session_expire'
    | 'connection_update'
    | 'error';

/**
 * Notification payload structure
 */
export interface NotificationPayload {
    type: NotificationType;
    topic: string;
    data: any;
    timestamp?: number;
    priority?: 'low' | 'normal' | 'high';
}

/**
 * Notification channel configuration
 */
export interface NotificationChannel {
    id: string;
    type: 'websocket' | 'webhook' | 'push' | 'email';
    endpoint?: string;
    enabled: boolean;
    filters?: NotificationType[];
}

/**
 * NotificationService
 * Manages notification delivery across multiple channels
 */
export class NotificationService extends EventEmitter {
    private static instance: NotificationService;
    private logger: Logger;
    private channels: Map<string, NotificationChannel>;
    private queue: NotificationPayload[];
    private processing: boolean;
    private webhookEndpoints: Set<string>;

    private constructor() {
        super();
        this.logger = new Logger('NotificationService');
        this.channels = new Map();
        this.queue = [];
        this.processing = false;
        this.webhookEndpoints = new Set();

        this.initializeDefaultChannels();
    }

    /**
     * Get singleton instance
     */
    public static getInstance(): NotificationService {
        if (!NotificationService.instance) {
            NotificationService.instance = new NotificationService();
        }
        return NotificationService.instance;
    }

    /**
     * Initialize default notification channels
     */
    private initializeDefaultChannels(): void {
        // WebSocket channel (enabled by default)
        this.addChannel({
            id: 'websocket',
            type: 'websocket',
            enabled: true
        });

        // Webhook channel (configurable)
        if (process.env.WEBHOOK_URL) {
            this.addChannel({
                id: 'webhook',
                type: 'webhook',
                endpoint: process.env.WEBHOOK_URL,
                enabled: true
            });
        }
    }

    /**
     * Add a notification channel
     */
    public addChannel(channel: NotificationChannel): void {
        this.channels.set(channel.id, channel);
        this.logger.info('Notification channel added', {
            id: channel.id,
            type: channel.type
        });
    }

    /**
     * Remove a notification channel
     */
    public removeChannel(channelId: string): void {
        this.channels.delete(channelId);
        this.logger.info('Notification channel removed', { id: channelId });
    }

    /**
     * Send a notification through all enabled channels
     */
    public async sendNotification(payload: NotificationPayload): Promise<void> {
        try {
            // Add timestamp if not present
            if (!payload.timestamp) {
                payload.timestamp = Date.now();
            }

            // Set default priority
            if (!payload.priority) {
                payload.priority = 'normal';
            }

            this.logger.debug('Sending notification', {
                type: payload.type,
                topic: payload.topic
            });

            // Add to queue
            this.queue.push(payload);

            // Start processing if not already running
            if (!this.processing) {
                await this.processQueue();
            }

            // Emit event for real-time listeners
            this.emit('notification', payload);
        } catch (error) {
            this.logger.error('Failed to send notification', error);
            throw error;
        }
    }

    /**
     * Process notification queue
     */
    private async processQueue(): Promise<void> {
        if (this.processing || this.queue.length === 0) {
            return;
        }

        this.processing = true;

        try {
            while (this.queue.length > 0) {
                const notification = this.queue.shift();
                if (!notification) continue;

                await this.deliverNotification(notification);
            }
        } finally {
            this.processing = false;
        }
    }

    /**
     * Deliver notification to all channels
     */
    private async deliverNotification(notification: NotificationPayload): Promise<void> {
        const deliveryPromises: Promise<void>[] = [];

        for (const [channelId, channel] of this.channels) {
            if (!channel.enabled) continue;

            // Check if channel has filters and notification type matches
            if (channel.filters && !channel.filters.includes(notification.type)) {
                continue;
            }

            const promise = this.deliverToChannel(channel, notification)
                .catch(error => {
                    this.logger.error('Failed to deliver to channel', {
                        channelId,
                        error
                    });
                });

            deliveryPromises.push(promise);
        }

        await Promise.allSettled(deliveryPromises);
    }

    /**
     * Deliver notification to specific channel
     */
    private async deliverToChannel(
        channel: NotificationChannel,
        notification: NotificationPayload
    ): Promise<void> {
        switch (channel.type) {
            case 'websocket':
                await this.sendViaWebSocket(notification);
                break;

            case 'webhook':
                await this.sendViaWebhook(channel.endpoint!, notification);
                break;

            case 'push':
                await this.sendViaPush(notification);
                break;

            case 'email':
                await this.sendViaEmail(notification);
                break;

            default:
                this.logger.warn('Unknown channel type', { type: channel.type });
        }
    }

    /**
     * Send notification via WebSocket
     */
    private async sendViaWebSocket(notification: NotificationPayload): Promise<void> {
        // Emit to WebSocket clients (would integrate with actual WebSocket server)
        this.emit('websocket', notification);
        this.logger.debug('Sent via WebSocket', { type: notification.type });
    }

    /**
     * Send notification via webhook
     */
    private async sendViaWebhook(
        endpoint: string,
        notification: NotificationPayload
    ): Promise<void> {
        try {
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Notification-Type': notification.type,
                    'X-Notification-Priority': notification.priority || 'normal'
                },
                body: JSON.stringify(notification)
            });

            if (!response.ok) {
                throw new Error(`Webhook returned ${response.status}`);
            }

            this.logger.debug('Sent via webhook', {
                endpoint,
                type: notification.type
            });
        } catch (error) {
            this.logger.error('Webhook delivery failed', { endpoint, error });
            throw error;
        }
    }

    /**
     * Send notification via push notification
     */
    private async sendViaPush(notification: NotificationPayload): Promise<void> {
        // Placeholder for push notification integration
        this.logger.debug('Push notification not implemented', {
            type: notification.type
        });
    }

    /**
     * Send notification via email
     */
    private async sendViaEmail(notification: NotificationPayload): Promise<void> {
        // Placeholder for email notification integration
        this.logger.debug('Email notification not implemented', {
            type: notification.type
        });
    }

    /**
     * Subscribe to notifications
     */
    public subscribe(
        types: NotificationType[],
        callback: (notification: NotificationPayload) => void
    ): () => void {
        const listener = (notification: NotificationPayload) => {
            if (types.includes(notification.type)) {
                callback(notification);
            }
        };

        this.on('notification', listener);

        // Return unsubscribe function
        return () => {
            this.off('notification', listener);
        };
    }

    /**
     * Get notification statistics
     */
    public getStats() {
        return {
            queueSize: this.queue.length,
            channels: Array.from(this.channels.values()).map(c => ({
                id: c.id,
                type: c.type,
                enabled: c.enabled
            })),
            processing: this.processing
        };
    }

    /**
     * Clear notification queue
     */
    public clearQueue(): void {
        this.queue = [];
        this.logger.info('Notification queue cleared');
    }
}
