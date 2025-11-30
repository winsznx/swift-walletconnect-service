import { Router, Request, Response } from 'express';
import { Logger } from '../utils/Logger';
import { AnalyticsService } from '../services/AnalyticsService';
import { SessionManager } from '../services/SessionManager';
import { CacheService } from '../services/CacheService';

const router = Router();
const logger = new Logger('MetricsRoute');
const analyticsService = AnalyticsService.getInstance();
const sessionManager = SessionManager.getInstance();
const cacheService = CacheService.getInstance();

/**
 * Get service metrics in Prometheus format
 */
router.get('/prometheus', async (req: Request, res: Response) => {
    try {
        const metrics = await gatherPrometheusMetrics();
        res.set('Content-Type', 'text/plain; version=0.0.4');
        res.status(200).send(metrics);
    } catch (error) {
        logger.error('Failed to gather Prometheus metrics', error);
        res.status(500).send('# Error gathering metrics\n');
    }
});

/**
 * Get service metrics in JSON format
 */
router.get('/', async (req: Request, res: Response) => {
    try {
        const metrics = await gatherMetrics();
        res.status(200).json(metrics);
    } catch (error) {
        logger.error('Failed to gather metrics', error);
        res.status(500).json({ error: 'Failed to gather metrics' });
    }
});

/**
 * Get session-specific metrics
 */
router.get('/sessions', async (req: Request, res: Response) => {
    try {
        const sessions = await sessionManager.getAllSessions();

        const metrics = {
            total: sessions.length,
            active: sessions.filter((s: any) => s.active).length,
            byChain: groupSessionsByChain(sessions),
            byDuration: getSessionDurationStats(sessions)
        };

        res.status(200).json(metrics);
    } catch (error) {
        logger.error('Failed to get session metrics', error);
        res.status(500).json({ error: 'Failed to get session metrics' });
    }
});

/**
 * Get analytics metrics
 */
router.get('/analytics', async (req: Request, res: Response) => {
    try {
        const timeRange = req.query.range as string || '1h';
        const stats = await analyticsService.getStats(timeRange);

        res.status(200).json(stats);
    } catch (error) {
        logger.error('Failed to get analytics metrics', error);
        res.status(500).json({ error: 'Failed to get analytics metrics' });
    }
});

/**
 * Get system metrics
 */
router.get('/system', (req: Request, res: Response) => {
    try {
        const memUsage = process.memoryUsage();
        const cpuUsage = process.cpuUsage();

        const metrics = {
            uptime: process.uptime(),
            memory: {
                rss: memUsage.rss,
                heapTotal: memUsage.heapTotal,
                heapUsed: memUsage.heapUsed,
                external: memUsage.external,
                arrayBuffers: memUsage.arrayBuffers
            },
            cpu: {
                user: cpuUsage.user,
                system: cpuUsage.system
            },
            platform: process.platform,
            nodeVersion: process.version,
            pid: process.pid
        };

        res.status(200).json(metrics);
    } catch (error) {
        logger.error('Failed to get system metrics', error);
        res.status(500).json({ error: 'Failed to get system metrics' });
    }
});

/**
 * Reset metrics (admin only)
 */
router.post('/reset', async (req: Request, res: Response) => {
    try {
        // In production, this should be protected by authentication
        if (process.env.NODE_ENV === 'production') {
            return res.status(403).json({ error: 'Not allowed in production' });
        }

        // Reset analytics
        // await analyticsService.reset();

        res.status(200).json({ success: true, message: 'Metrics reset' });
    } catch (error) {
        logger.error('Failed to reset metrics', error);
        res.status(500).json({ error: 'Failed to reset metrics' });
    }
});

/**
 * Gather metrics in Prometheus format
 */
async function gatherPrometheusMetrics(): Promise<string> {
    const sessions = await sessionManager.getAllSessions();
    const memUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage();

    let output = '';

    // Process metrics
    output += '# HELP process_uptime_seconds Process uptime in seconds\n';
    output += '# TYPE process_uptime_seconds gauge\n';
    output += `process_uptime_seconds ${process.uptime()}\n\n`;

    // Memory metrics
    output += '# HELP process_memory_bytes Process memory usage in bytes\n';
    output += '# TYPE process_memory_bytes gauge\n';
    output += `process_memory_bytes{type="rss"} ${memUsage.rss}\n`;
    output += `process_memory_bytes{type="heap_total"} ${memUsage.heapTotal}\n`;
    output += `process_memory_bytes{type="heap_used"} ${memUsage.heapUsed}\n`;
    output += `process_memory_bytes{type="external"} ${memUsage.external}\n\n`;

    // CPU metrics
    output += '# HELP process_cpu_microseconds Process CPU usage in microseconds\n';
    output += '# TYPE process_cpu_microseconds counter\n';
    output += `process_cpu_microseconds{type="user"} ${cpuUsage.user}\n`;
    output += `process_cpu_microseconds{type="system"} ${cpuUsage.system}\n\n`;

    // Session metrics
    output += '# HELP walletconnect_sessions_total Total number of WalletConnect sessions\n';
    output += '# TYPE walletconnect_sessions_total gauge\n';
    output += `walletconnect_sessions_total ${sessions.length}\n\n`;

    output += '# HELP walletconnect_sessions_active Number of active WalletConnect sessions\n';
    output += '# TYPE walletconnect_sessions_active gauge\n';
    output += `walletconnect_sessions_active ${sessions.filter((s: any) => s.active).length}\n\n`;

    return output;
}

/**
 * Gather all metrics in JSON format
 */
async function gatherMetrics() {
    const sessions = await sessionManager.getAllSessions();
    const memUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage();

    return {
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        sessions: {
            total: sessions.length,
            active: sessions.filter((s: any) => s.active).length,
            byChain: groupSessionsByChain(sessions)
        },
        memory: {
            rss: memUsage.rss,
            heapTotal: memUsage.heapTotal,
            heapUsed: memUsage.heapUsed,
            heapUsedPercent: (memUsage.heapUsed / memUsage.heapTotal) * 100,
            external: memUsage.external
        },
        cpu: {
            user: cpuUsage.user,
            system: cpuUsage.system
        }
    };
}

/**
 * Group sessions by chain
 */
function groupSessionsByChain(sessions: any[]): Record<string, number> {
    const byChain: Record<string, number> = {};

    sessions.forEach(session => {
        const chains = session.namespaces?.eip155?.chains || [];
        chains.forEach((chain: string) => {
            byChain[chain] = (byChain[chain] || 0) + 1;
        });
    });

    return byChain;
}

/**
 * Get session duration statistics
 */
function getSessionDurationStats(sessions: any[]) {
    const now = Date.now();
    const durations = sessions.map(s => {
        const created = s.createdAt ? new Date(s.createdAt).getTime() : now;
        return now - created;
    });

    if (durations.length === 0) {
        return { min: 0, max: 0, avg: 0 };
    }

    return {
        min: Math.min(...durations),
        max: Math.max(...durations),
        avg: durations.reduce((a, b) => a + b, 0) / durations.length
    };
}

export default router;
