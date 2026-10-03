import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { type HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';
import { APP_CONFIG, type AppConfig } from '@hotella/platform-config';
import { Pool } from 'pg';

/**
 * Readiness probe for PostgreSQL. Uses a tiny dedicated pool; Sprint 0.2.1 replaces it with the
 * shared client from @hotella/platform-database.
 */
@Injectable()
export class PostgresHealthIndicator implements OnModuleDestroy {
  private readonly pool: Pool;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly indicators: HealthIndicatorService,
  ) {
    this.pool = new Pool({
      connectionString: config.database.url,
      max: 1,
      connectionTimeoutMillis: 2_000,
      query_timeout: 2_000,
    });
    this.pool.on('error', () => undefined); // surfaced through the probe, never crashes the process
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const indicator = this.indicators.check(key);
    try {
      await this.pool.query('SELECT 1');
      return indicator.up();
    } catch (err) {
      return indicator.down({ message: err instanceof Error ? err.message : 'unreachable' });
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
