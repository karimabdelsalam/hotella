import { Injectable } from '@nestjs/common';
import { IntegrationHealthChanged } from '@hotella/contracts-events';
import type { TenantScope } from '@hotella/platform-database';
import { EventPublisher } from '@hotella/platform-events';
import { classifyHealth, recordOutcome } from '../domain/instance';
import { IntegrationRepositories } from '../infrastructure/repositories';
import type { IntegrationHealthRow } from '../infrastructure/schema';

/**
 * Integration health (Spec §57): rolling success/failure counters from processed messages, agent liveness from
 * heartbeats, and a deterministic state. A state change publishes `integration.health.changed.v1` once (alerting
 * deduplicates on it). Must run inside a transaction.
 */
@Injectable()
export class HealthService {
  constructor(
    private readonly repo: IntegrationRepositories,
    private readonly events: EventPublisher,
  ) {}

  /** A message was processed (`failed` = parse error, rejection or crash). */
  async recordMessage(scope: TenantScope, instanceId: string, failed: boolean): Promise<void> {
    const h = await this.repo.healthForUpdate(scope, instanceId);
    if (!h) return;
    const now = new Date();
    const counters = recordOutcome(h, failed);
    await this.apply(scope, h, now, {
      ...counters,
      ...(failed ? { lastFailureAt: now } : { lastSuccessAt: now }),
    });
  }

  /** The agent is alive (connect or heartbeat); `queueDepth` is its local backlog. */
  async recordAgentSeen(
    scope: TenantScope,
    instanceId: string,
    queueDepth: number | null,
  ): Promise<void> {
    const h = await this.repo.healthForUpdate(scope, instanceId);
    if (!h) return;
    const now = new Date();
    await this.apply(scope, h, now, {
      agentLastSeenAt: now,
      ...(queueDepth !== null ? { queueDepth } : {}),
    });
  }

  private async apply(
    scope: TenantScope,
    h: IntegrationHealthRow,
    now: Date,
    values: Partial<IntegrationHealthRow>,
  ): Promise<void> {
    const next = { ...h, ...values };
    const status = classifyHealth({
      now,
      agentLastSeenAt: next.agentLastSeenAt,
      lastSuccessAt: next.lastSuccessAt,
      errorRatePermille: next.errorRatePermille,
    });
    await this.repo.updateHealth(scope, h.instanceId, { ...values, status });
    if (status !== h.status)
      await this.events.publish(IntegrationHealthChanged, {
        tenantId: h.tenantId,
        propertyId: h.propertyId,
        source: 'integration',
        aggregate: { type: 'integration_instance', id: h.instanceId },
        payload: { instance_id: h.instanceId, from: h.status, to: status },
      });
  }
}
