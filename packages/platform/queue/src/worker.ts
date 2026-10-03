import { type Job, Worker, type WorkerOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import type { EventEnvelope } from '@hotella/contracts-events';
import type { IdempotentConsumer } from '@hotella/platform-events';
import type { Logger, RequestContext } from '@hotella/platform-observability';
import type { JobEnvelope } from './job';
import { DEFAULT_CONCURRENCY, QUEUE_PREFIX, type QueueName } from './queues';

export type EventHandler = (envelope: EventEnvelope) => Promise<void>;

/** Subscriptions: event name → consumer-tagged handlers. Each consumer is idempotent via the inbox. */
export class EventConsumerRegistry {
  private readonly handlers = new Map<string, Array<{ consumer: string; handler: EventHandler }>>();

  on(eventName: string, consumer: string, handler: EventHandler): void {
    const list = this.handlers.get(eventName) ?? [];
    if (list.some((h) => h.consumer === consumer))
      throw new Error(`Consumer "${consumer}" already subscribed to ${eventName}`);
    list.push({ consumer, handler });
    this.handlers.set(eventName, list);
  }

  for(eventName: string): ReadonlyArray<{ consumer: string; handler: EventHandler }> {
    return this.handlers.get(eventName) ?? [];
  }

  eventNames(): string[] {
    return [...this.handlers.keys()];
  }
}

export interface QueueWorkerDeps {
  readonly connection: Redis;
  readonly ctx: RequestContext;
  readonly logger: Logger;
  readonly consumers: EventConsumerRegistry;
  readonly idempotency: IdempotentConsumer;
}

/**
 * One BullMQ Worker per queue. Each job runs inside the request context that travelled with it, and
 * event jobs are dispatched to every subscribed consumer through the inbox (exactly-once effect).
 */
export function createQueueWorker(
  name: QueueName,
  deps: QueueWorkerDeps,
  options: Partial<WorkerOptions> = {},
): Worker {
  const worker = new Worker<JobEnvelope>(
    name,
    async (job: Job<JobEnvelope>) => {
      const seed = job.data.context ?? {};
      await deps.ctx.run(seed, async () => {
        const subscribers = deps.consumers.for(job.name);
        if (subscribers.length === 0) {
          deps.logger.debug(
            { queue: name, job: job.name, job_id: job.id },
            'no consumer for job; acknowledged',
          );
          return;
        }
        const envelope = job.data.data as EventEnvelope;
        for (const { consumer, handler } of subscribers) {
          const outcome = await deps.idempotency.once(consumer, envelope, handler);
          deps.logger.info(
            { queue: name, event: job.name, event_id: envelope.event_id, consumer, outcome },
            'event consumed',
          );
        }
      });
    },
    {
      connection: deps.connection,
      prefix: QUEUE_PREFIX,
      concurrency: DEFAULT_CONCURRENCY[name],
      ...options,
    },
  );
  worker.on('failed', (job, err) =>
    deps.logger.error(
      {
        queue: name,
        job: job?.name,
        job_id: job?.id,
        attempts: job?.attemptsMade,
        err: err.message,
      },
      'job failed',
    ),
  );
  worker.on('error', (err) => deps.logger.error({ queue: name, err: err.message }, 'worker error'));
  return worker;
}
