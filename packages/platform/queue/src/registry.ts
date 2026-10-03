import { type JobsOptions, Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { RequestContext } from '@hotella/platform-observability';
import { DEFAULT_JOB_OPTIONS, type JobEnvelope } from './job';
import { QUEUE_PREFIX, type QueueName } from './queues';

/** Lazily creates one BullMQ Queue per name on the shared connection and enqueues context-carrying jobs. */
export class QueueRegistry {
  private readonly queues = new Map<QueueName, Queue>();

  constructor(
    private readonly connection: Redis,
    private readonly ctx: RequestContext,
  ) {}

  queue(name: QueueName): Queue {
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, {
        connection: this.connection,
        prefix: QUEUE_PREFIX,
        defaultJobOptions: DEFAULT_JOB_OPTIONS,
      });
      this.queues.set(name, q);
    }
    return q;
  }

  /** Enqueue a job wrapped in a JobEnvelope with the current request context. */
  async enqueue<T>(
    name: QueueName,
    jobName: string,
    data: T,
    options: JobsOptions = {},
  ): Promise<string> {
    const envelope: JobEnvelope<T> = {
      data,
      context: this.ctx.snapshot(),
      enqueuedAt: new Date().toISOString(),
    };
    const job = await this.queue(name).add(jobName, envelope, options);
    return job.id ?? '';
  }

  async counts(name: QueueName): Promise<Record<string, number>> {
    return this.queue(name).getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
  }

  async close(): Promise<void> {
    await Promise.all([...this.queues.values()].map((q) => q.close()));
    this.queues.clear();
  }
}
