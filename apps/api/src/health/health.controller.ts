import { Controller, Get } from '@nestjs/common';
import { Public } from '@hotella/platform-auth';
import { SkipRateLimit } from '@hotella/platform-http';
import { HealthCheck, HealthCheckService, type HealthCheckResult } from '@nestjs/terminus';
import { PostgresHealthIndicator } from './postgres.health';
import { ValkeyHealthIndicator } from './valkey.health';

/** Probes are never rate limited: an orchestrator polling them must not depend on the limiter store. */
@Public()
@SkipRateLimit()
@Controller()
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly postgres: PostgresHealthIndicator,
    private readonly valkey: ValkeyHealthIndicator,
  ) {}

  /** Liveness: the process is up. Never touches dependencies. */
  @Get('health')
  liveness(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Readiness: dependencies reachable. 503 with details otherwise (Terminus semantics). */
  @Get('ready')
  @HealthCheck()
  readiness(): Promise<HealthCheckResult> {
    return this.health.check([
      () => this.postgres.isHealthy('postgres'),
      () => this.valkey.isHealthy('valkey'),
    ]);
  }
}
