import { Inject, Injectable } from '@nestjs/common';
import { type HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';
import { PG_POOL } from '@hotella/platform-database';
import type { Pool } from 'pg';

/** Readiness probe for PostgreSQL through the shared pool from @hotella/platform-database. */
@Injectable()
export class PostgresHealthIndicator {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly indicators: HealthIndicatorService,
  ) {}

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const indicator = this.indicators.check(key);
    try {
      await Promise.race([
        this.pool.query('SELECT 1'),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('timeout after 2000ms')), 2_000).unref(),
        ),
      ]);
      return indicator.up();
    } catch (err) {
      return indicator.down({ message: err instanceof Error ? err.message : 'unreachable' });
    }
  }
}
