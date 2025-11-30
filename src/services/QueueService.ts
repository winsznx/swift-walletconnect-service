import { Logger } from '../utils/Logger';
import { EventEmitter } from 'events';

/**
 * Job status enum
 */
export enum JobStatus {
    PENDING = 'pending',
    PROCESSING = 'processing',
    COMPLETED = 'completed',
    FAILED = 'failed',
    RETRYING = 'retrying'
}

/**
 * Job priority levels
 */
export enum JobPriority {
    LOW = 0,
    NORMAL = 1,
    HIGH = 2,
    CRITICAL = 3
}

/**
 * Job interface
 */
export interface Job<T = any> {
    id: string;
    type: string;
    data: T;
    priority: JobPriority;
    status: JobStatus;
    attempts: number;
    maxAttempts: number;
    createdAt: number;
    updatedAt: number;
    processedAt?: number;
    error?: string;
}

/**
 * Job processor function type
 */
export type JobProcessor<T = any> = (job: Job<T>) => Promise<void>;

/**
 * Queue configuration
 */
export interface QueueConfig {
    maxConcurrent?: number;
    retryAttempts?: number;
    retryDelay?: number;
    processInterval?: number;
}

/**
 * QueueService
 * Manages job queues with priority, retry logic, and concurrency control
 */
export class QueueService extends EventEmitter {
    private static instance: QueueService;
    private logger: Logger;
    private queues: Map<string, Job[]>;
    private processors: Map<string, JobProcessor>;
    private processing: Set<string>;
    private activeJobs: Map<string, Job>;
    private config: Required<QueueConfig>;
    private intervalId?: NodeJS.Timeout;

    private constructor(config: QueueConfig = {}) {
        super();
        this.logger = new Logger('QueueService');
        this.queues = new Map();
        this.processors = new Map();
        this.processing = new Set();
        this.activeJobs = new Map();

        this.config = {
            maxConcurrent: config.maxConcurrent || 5,
            retryAttempts: config.retryAttempts || 3,
            retryDelay: config.retryDelay || 1000,
            processInterval: config.processInterval || 100
        };

        this.startProcessing();
    }

    /**
     * Get singleton instance
     */
    public static getInstance(config?: QueueConfig): QueueService {
        if (!QueueService.instance) {
            QueueService.instance = new QueueService(config);
        }
        return QueueService.instance;
    }

    /**
     * Register a job processor for a specific job type
     */
    public registerProcessor<T = any>(
        type: string,
        processor: JobProcessor<T>
    ): void {
        this.processors.set(type, processor);
        this.logger.info('Job processor registered', { type });
    }

    /**
     * Add a job to the queue
     */
    public async addJob<T = any>(
        type: string,
        data: T,
        priority: JobPriority = JobPriority.NORMAL
    ): Promise<string> {
        const jobId = this.generateJobId();
        const now = Date.now();

        const job: Job<T> = {
            id: jobId,
            type,
            data,
            priority,
            status: JobStatus.PENDING,
            attempts: 0,
            maxAttempts: this.config.retryAttempts,
            createdAt: now,
            updatedAt: now
        };

        // Get or create queue for this job type
        if (!this.queues.has(type)) {
            this.queues.set(type, []);
        }

        const queue = this.queues.get(type)!;
        queue.push(job);

        // Sort by priority (highest first)
        queue.sort((a, b) => b.priority - a.priority);

        this.logger.debug('Job added to queue', {
            jobId,
            type,
            priority,
            queueSize: queue.length
        });

        this.emit('job:added', job);
        return jobId;
    }

    /**
     * Get job status
     */
    public getJobStatus(jobId: string): Job | undefined {
        // Check active jobs first
        if (this.activeJobs.has(jobId)) {
            return this.activeJobs.get(jobId);
        }

        // Check all queues
        for (const queue of this.queues.values()) {
            const job = queue.find(j => j.id === jobId);
            if (job) return job;
        }

        return undefined;
    }

    /**
     * Start processing jobs
     */
    private startProcessing(): void {
        if (this.intervalId) {
            return;
        }

        this.intervalId = setInterval(() => {
            this.processJobs();
        }, this.config.processInterval);

        this.logger.info('Queue processing started', {
            maxConcurrent: this.config.maxConcurrent
        });
    }

    /**
     * Stop processing jobs
     */
    public stopProcessing(): void {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = undefined;
            this.logger.info('Queue processing stopped');
        }
    }

    /**
     * Process jobs from all queues
     */
    private async processJobs(): Promise<void> {
        // Check if we can process more jobs
        if (this.activeJobs.size >= this.config.maxConcurrent) {
            return;
        }

        // Get next job from all queues (prioritized)
        const job = this.getNextJob();
        if (!job) {
            return;
        }

        // Get processor for this job type
        const processor = this.processors.get(job.type);
        if (!processor) {
            this.logger.warn('No processor for job type', { type: job.type });
            this.removeJobFromQueue(job);
            return;
        }

        // Process the job
        await this.processJob(job, processor);
    }

    /**
     * Get next job to process (highest priority across all queues)
     */
    private getNextJob(): Job | undefined {
        let highestPriorityJob: Job | undefined;
        let highestPriority = -1;

        for (const [type, queue] of this.queues) {
            if (queue.length === 0 || this.processing.has(type)) {
                continue;
            }

            const job = queue[0];
            if (job.priority > highestPriority) {
                highestPriority = job.priority;
                highestPriorityJob = job;
            }
        }

        return highestPriorityJob;
    }

    /**
     * Process a single job
     */
    private async processJob(job: Job, processor: JobProcessor): Promise<void> {
        this.processing.add(job.type);
        this.removeJobFromQueue(job);
        this.activeJobs.set(job.id, job);

        job.status = JobStatus.PROCESSING;
        job.attempts++;
        job.updatedAt = Date.now();

        this.logger.debug('Processing job', {
            jobId: job.id,
            type: job.type,
            attempt: job.attempts
        });

        this.emit('job:processing', job);

        try {
            await processor(job);

            job.status = JobStatus.COMPLETED;
            job.processedAt = Date.now();
            job.updatedAt = Date.now();

            this.logger.debug('Job completed', { jobId: job.id, type: job.type });
            this.emit('job:completed', job);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            job.error = errorMessage;
            job.updatedAt = Date.now();

            this.logger.error('Job failed', {
                jobId: job.id,
                type: job.type,
                attempt: job.attempts,
                error: errorMessage
            });

            // Retry logic
            if (job.attempts < job.maxAttempts) {
                job.status = JobStatus.RETRYING;
                this.logger.info('Retrying job', {
                    jobId: job.id,
                    attempt: job.attempts,
                    maxAttempts: job.maxAttempts
                });

                this.emit('job:retrying', job);

                // Re-add to queue after delay
                setTimeout(() => {
                    const queue = this.queues.get(job.type);
                    if (queue) {
                        queue.push(job);
                        queue.sort((a, b) => b.priority - a.priority);
                    }
                    this.activeJobs.delete(job.id);
                }, this.config.retryDelay * job.attempts);
            } else {
                job.status = JobStatus.FAILED;
                this.logger.error('Job permanently failed', {
                    jobId: job.id,
                    type: job.type
                });
                this.emit('job:failed', job);
                this.activeJobs.delete(job.id);
            }
        } finally {
            this.processing.delete(job.type);
        }
    }

    /**
     * Remove job from its queue
     */
    private removeJobFromQueue(job: Job): void {
        const queue = this.queues.get(job.type);
        if (queue) {
            const index = queue.findIndex(j => j.id === job.id);
            if (index !== -1) {
                queue.splice(index, 1);
            }
        }
    }

    /**
     * Generate unique job ID
     */
    private generateJobId(): string {
        return `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    /**
     * Get queue statistics
     */
    public getStats() {
        const queueStats = Array.from(this.queues.entries()).map(([type, queue]) => ({
            type,
            pending: queue.length,
            processing: this.processing.has(type) ? 1 : 0
        }));

        return {
            queues: queueStats,
            activeJobs: this.activeJobs.size,
            totalPending: Array.from(this.queues.values()).reduce(
                (sum, queue) => sum + queue.length,
                0
            ),
            config: this.config
        };
    }

    /**
     * Clear all queues
     */
    public clearQueues(): void {
        for (const queue of this.queues.values()) {
            queue.length = 0;
        }
        this.logger.info('All queues cleared');
    }
}
