import { Inject, Injectable } from '@nestjs/common';
import { type HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';
import { VALKEY } from '@hotella/platform-queue';
import type { Redis } from 'ioredis';

/** Readiness probe for Valkey through the shared connection from @hotella/platform-queue. */
@Injectable()
export class ValkeyHealthIndicator {
  constructor(
    @Inject(VALKEY) private readonly client: Redis,
    private readonly indicators: HealthIndicatorService,
  ) {}

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const indicator = this.indicators.check(key);
    try {
      const pong = await Promise.race([
        this.client.ping(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('timeout after 2000ms')), 2_000).unref(),
        ),
      ]);
      return pong === 'PONG'
        ? indicator.up()
        : indicator.down({ message: `unexpected reply ${String(pong)}` });
    } catch (err) {
      return indicator.down({ message: err instanceof Error ? err.message : 'unreachable' });
    }
  }
}
