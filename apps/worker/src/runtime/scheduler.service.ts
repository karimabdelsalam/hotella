import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '@hotella/platform-config';
import { InjectLogger, type Logger } from '@hotella/platform-observability';
import { EventConsumerRegistry, QueueRegistry } from '@hotella/platform-queue';

export const HEARTBEAT_JOB = 'platform.heartbeat';

/**
 * Scheduler base (BUILD_PLAN 0.3.10): repeatable BullMQ jobs. Phase 3 adds SLA timers, Phase 2 reconciliation,
 * Phase 8 PM generation on top of this. Upserting the scheduler is idempotent across replicas.
 */
@Injectable()
export class SchedulerService implements OnModuleInit {
  lastHeartbeatAt: Date | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly queues: QueueRegistry,
    private readonly consumers: EventConsumerRegistry,
    @InjectLogger() private readonly logger: Logger,
  ) {}

  async onModuleInit(): Promise<void> {
    this.consumers.onJob<{ scheduledAt?: string }>(HEARTBEAT_JOB, async () => {
      this.lastHeartbeatAt = new Date();
      this.logger.debug({ at: this.lastHeartbeatAt.toISOString() }, 'heartbeat');
    });
    if (!this.config.worker.schedulerEnabled) return;
    await this.queues.queue('normal').upsertJobScheduler(
      HEARTBEAT_JOB,
      { every: 60_000 },
      {
        name: HEARTBEAT_JOB,
        data: { data: {}, context: {}, enqueuedAt: new Date().toISOString() },
        opts: { removeOnComplete: 10, removeOnFail: 10 },
      },
    );
    this.logger.info({ job: HEARTBEAT_JOB, every_ms: 60_000 }, 'scheduler armed');
  }
}
