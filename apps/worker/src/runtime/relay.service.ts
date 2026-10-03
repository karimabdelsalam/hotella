import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '@hotella/platform-config';
import { OutboxRelay } from '@hotella/platform-events';
import { InjectLogger, type Logger } from '@hotella/platform-observability';

/** Polls the outbox on a fixed cadence. Several replicas are safe (SKIP LOCKED). */
@Injectable()
export class RelayService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;
  lastResult = { claimed: 0, published: 0, failed: 0 };

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly relay: OutboxRelay,
    @InjectLogger() private readonly logger: Logger,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.tick(), this.config.worker.relayIntervalMs);
    this.timer.unref();
  }

  async tick(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      this.lastResult = await this.relay.relayOnce(this.config.worker.relayBatch);
      if (this.lastResult.claimed > 0) this.logger.debug(this.lastResult, 'outbox relayed');
    } catch (err) {
      this.logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'outbox relay tick failed',
      );
    } finally {
      this.running = false;
    }
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }
}
