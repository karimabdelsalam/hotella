import { Controller, Get } from '@nestjs/common';
import { OutboxRelay } from '@hotella/platform-events';
import { QueueRegistry } from '@hotella/platform-queue';
import { QueueWorkersService } from './queue-workers.service';
import { RelayService } from './relay.service';
import { SchedulerService } from './scheduler.service';

@Controller()
export class WorkerHealthController {
  constructor(
    private readonly workers: QueueWorkersService,
    private readonly relay: RelayService,
    private readonly outbox: OutboxRelay,
    private readonly scheduler: SchedulerService,
    private readonly queues: QueueRegistry,
  ) {}

  @Get('health')
  liveness(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Operational snapshot: queues served, outbox lag, last relay result, heartbeat. */
  @Get('ready')
  async readiness(): Promise<Record<string, unknown>> {
    const counts: Record<string, Record<string, number>> = {};
    for (const q of this.workers.queues) counts[q] = await this.queues.counts(q);
    return {
      status: 'ok',
      queues: this.workers.queues,
      outbox_lag_seconds: await this.outbox.lagSeconds(),
      last_relay: this.relay.lastResult,
      last_heartbeat_at: this.scheduler.lastHeartbeatAt?.toISOString() ?? null,
      counts,
    };
  }
}
