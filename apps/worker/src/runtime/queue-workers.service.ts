import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import type { Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { APP_CONFIG, type AppConfig } from '@hotella/platform-config';
import { IdempotentConsumer } from '@hotella/platform-events';
import { InjectLogger, type Logger, RequestContext } from '@hotella/platform-observability';
import {
  createQueueWorker,
  EventConsumerRegistry,
  isQueueName,
  QUEUE_NAMES,
  type QueueName,
  VALKEY,
} from '@hotella/platform-queue';

/** Starts one BullMQ Worker per queue selected by WORKER_QUEUES (Spec §71 isolation by workload). */
@Injectable()
export class QueueWorkersService implements OnModuleInit, OnApplicationShutdown {
  private readonly workers: Worker[] = [];
  readonly queues: QueueName[];

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(VALKEY) private readonly connection: Redis,
    private readonly ctx: RequestContext,
    private readonly consumers: EventConsumerRegistry,
    private readonly idempotency: IdempotentConsumer,
    @InjectLogger() private readonly logger: Logger,
  ) {
    const selected = config.worker.queues === 'all' ? [...QUEUE_NAMES] : config.worker.queues;
    const unknown = selected.filter((q) => !isQueueName(q));
    if (unknown.length > 0)
      throw new Error(`WORKER_QUEUES contains unknown queues: ${unknown.join(', ')}`);
    this.queues = selected.filter(isQueueName);
  }

  onModuleInit(): void {
    for (const name of this.queues) {
      this.workers.push(
        createQueueWorker(name, {
          connection: this.connection,
          ctx: this.ctx,
          logger: this.logger,
          consumers: this.consumers,
          idempotency: this.idempotency,
        }),
      );
    }
    this.logger.info({ queues: this.queues }, 'queue workers started');
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.close()));
  }
}
