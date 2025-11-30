import { Router, Request, Response } from 'express';
import { Logger } from '../utils/Logger';
import { CacheService } from '../services/CacheService';
import { SessionManager } from '../services/SessionManager';

const router = Router();
const logger = new Logger('HealthRoute');
const cacheService = CacheService.getInstance();
const sessionManager = SessionManager.getInstance();

interface HealthStatus {
    status: 'healthy' | 'degraded' | 'unhealthy';
    timestamp: string;
    uptime: number;
    version: string;
    checks: {
        cache: boolean;
        sessions: boolean;
        memory: boolean;
    };
    metrics?: {
        activeSessions: number;
        cacheSize: number;
        memoryUsage: {
            rss: number;
            heapTotal: number;
            heapUsed: number;
            external: number;
        };
    };
}

/**
 * Basic health check endpoint
 * Returns 200 if service is running
 */
router.get('/', async (req: Request, res: Response) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * Detailed health check with dependency checks
 */
router.get('/detailed', async (req: Request, res: Response) => {
    try {
        const health = await performHealthChecks();

        const statusCode = health.status === 'healthy' ? 200 :
            health.status === 'degraded' ? 200 : 503;

        res.status(statusCode).json(health);
    } catch (error) {
        logger.error('Health check failed', error);
        res.status(503).json({
            status: 'unhealthy',
            timestamp: new Date().toISOString(),
            error: 'Health check failed'
        });
    }
});

/**
 * Liveness probe - for orchestrators like Kubernetes
 * Returns 200 if process is alive
 */
router.get('/live', (req: Request, res: Response) => {
    res.status(200).json({ alive: true });
});

/**
 * Readiness probe - for orchestrators like Kubernetes
 * Returns 200 if service is ready to accept traffic
 */
router.get('/ready', async (req: Request, res: Response) => {
    try {
        // Check if critical dependencies are available
        const cacheReady = await checkCacheHealth();
        const sessionsReady = await checkSessionsHealth();

        if (cacheReady && sessionsReady) {
            res.status(200).json({ ready: true });
        } else {
            res.status(503).json({
                ready: false,
                cache: cacheReady,
                sessions: sessionsReady
            });
        }
    } catch (error) {
        logger.error('Readiness check failed', error);
        res.status(503).json({ ready: false, error: 'Check failed' });
    }
});

/**
 * Perform comprehensive health checks
 */
async function performHealthChecks(): Promise<HealthStatus> {
    const checks = {
        cache: await checkCacheHealth(),
        sessions: await checkSessionsHealth(),
        memory: checkMemoryHealth()
    };

    const allHealthy = Object.values(checks).every(check => check === true);
    const someHealthy = Object.values(checks).some(check => check === true);

    const status = allHealthy ? 'healthy' :
        someHealthy ? 'degraded' : 'unhealthy';

    const metrics = await gatherMetrics();

    return {
        status,
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        version: process.env.npm_package_version || '1.0.0',
        checks,
        metrics
    };
}

/**
 * Check cache service health
 */
async function checkCacheHealth(): Promise<boolean> {
    try {
        const testKey = '__health_check__';
        const testValue = Date.now().toString();

        await cacheService.set(testKey, testValue, 5);
        const retrieved = await cacheService.get(testKey);
        await cacheService.delete(testKey);

        return retrieved === testValue;
    } catch (error) {
        logger.error('Cache health check failed', error);
        return false;
    }
}

/**
 * Check session manager health
 */
async function checkSessionsHealth(): Promise<boolean> {
    try {
        // Just verify we can access session manager
        const sessions = await sessionManager.getAllSessions();
        return Array.isArray(sessions);
    } catch (error) {
        logger.error('Sessions health check failed', error);
        return false;
    }
}

/**
 * Check memory health
 */
function checkMemoryHealth(): boolean {
    const memUsage = process.memoryUsage();
    const heapUsedPercent = (memUsage.heapUsed / memUsage.heapTotal) * 100;

    // Consider unhealthy if using more than 90% of heap
    return heapUsedPercent < 90;
}

/**
 * Gather service metrics
 */
async function gatherMetrics() {
    const sessions = await sessionManager.getAllSessions();
    const memUsage = process.memoryUsage();

    return {
        activeSessions: sessions.length,
        cacheSize: 0, // Would need to implement cache size tracking
        memoryUsage: {
            rss: Math.round(memUsage.rss / 1024 / 1024), // MB
            heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
            heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
            external: Math.round(memUsage.external / 1024 / 1024)
        }
    };
}

export default router;
