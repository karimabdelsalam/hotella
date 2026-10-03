import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { type HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';
import { APP_CONFIG, type AppConfig } from '@hotella/platform-config';
import { Redis } from 'ioredis';

/** Readiness probe for Valkey (RESP). Sprint 0.3.5 replaces it with the shared client from @hotella/platform-queue. */
@Injectable()
export class ValkeyHealthIndicator implements OnModuleDestroy {
  private readonly client: Redis;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly indicators: HealthIndicatorService,
  ) {
    this.client = new Redis(config.valkey.url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 2_000,
      enableOfflineQueue: false,
      retryStrategy: () => null, // the probe reconnects on demand; no background retry storm
    });
    this.client.on('error', () => undefined);
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const indicator = this.indicators.check(key);
    try {
      if (this.client.status !== 'ready') await this.client.connect();
      const pong = await this.client.ping();
      return pong === 'PONG'
        ? indicator.up()
        : indicator.down({ message: `unexpected reply ${pong}` });
    } catch (err) {
      this.client.disconnect(false);
      return indicator.down({ message: err instanceof Error ? err.message : 'unreachable' });
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.client.disconnect(false);
  }
}
