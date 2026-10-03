import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '@hotella/platform-config';
import { EventRetention } from '@hotella/platform-events';
import { InjectLogger, type Logger } from '@hotella/platform-observability';
import { EventConsumerRegistry, QueueRegistry } from '@hotella/platform-queue';

export const HEARTBEAT_JOB = 'platform.heartbeat';
/** Hourly retention of delivered events (published outbox rows, processed inbox rows). */
export const EVENTS_PURGE_JOB = 'platform.events.purge';

/**
 * Scheduler base (BUILD_PLAN 0.3.10): repeatable BullMQ jobs — the heartbeat and the retention of delivered events
 * here; contexts arm their own (operations: SLA sweep, approval expiry). Upserting a scheduler is idempotent across
 * replicas.
 */
@Injectable()
export class SchedulerService implements OnModuleInit {
  lastHeartbeatAt: Date | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly queues: QueueRegistry,
    private readonly consumers: EventConsumerRegistry,
    private readonly retention: EventRetention,
    @InjectLogger() private readonly logger: Logger,
  ) {}

  async onModuleInit(): Promise<void> {
    this.consumers.onJob<{ scheduledAt?: string }>(HEARTBEAT_JOB, async () => {
      this.lastHeartbeatAt = new Date();
      this.logger.debug({ at: this.lastHeartbeatAt.toISOString() }, 'heartbeat');
    });
    this.consumers.onJob(EVENTS_PURGE_JOB, async () => {
      const purged = await this.retention.purge(this.config.retention);
      if (purged.outbox + purged.inbox > 0) this.logger.info(purged, 'delivered events purged');
    });
    if (!this.config.worker.schedulerEnabled) return;
    await this.queues.queue('normal').upsertJobScheduler(
      EVENTS_PURGE_JOB,
      { every: 3600_000 },
      {
        name: EVENTS_PURGE_JOB,
        data: { data: {}, context: {}, enqueuedAt: new Date().toISOString() },
        opts: { removeOnComplete: 10, removeOnFail: 10 },
      },
    );
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
