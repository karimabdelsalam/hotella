import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AlertRaised } from '@hotella/contracts-events';
import { AuditWriter } from '@hotella/platform-audit';
import { ActionGate, ActorStore } from '@hotella/platform-auth';
import {
  isUuid,
  newId,
  type PropertyScope,
  type TenantScope,
  TransactionRunner,
} from '@hotella/platform-database';
import { EventPublisher } from '@hotella/platform-events';
import { AppError } from '@hotella/platform-i18n';
import { SlaRepositories } from '../infrastructure/sla-repositories';
import type { AlertRow } from '../infrastructure/schema';
import type { RaiseAlertInput } from '../public';
import { OPS_SOURCE } from './constants';

export const listAlertsQuerySchema = z.object({
  status: z
    .string()
    .transform((s) =>
      s
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.enum(['OPEN', 'ACKNOWLEDGED', 'RESOLVED'])).max(3))
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListAlertsQuery = z.infer<typeof listAlertsQuerySchema>;
export const resolveAlertSchema = z.object({ resolution: z.string().trim().min(1).max(500) });

export function alertView(a: AlertRow) {
  return {
    id: a.id,
    type: a.type,
    severity: a.severity,
    status: a.status,
    subject: a.subjectType && a.subjectId ? { type: a.subjectType, id: a.subjectId } : null,
    evidence: a.evidence,
    occurrences: a.occurrences,
    firstSeenAt: a.firstSeenAt,
    lastSeenAt: a.lastSeenAt,
    acknowledgedById: a.acknowledgedById,
    acknowledgedAt: a.acknowledgedAt,
    resolvedBy: a.resolvedByType ? { type: a.resolvedByType, id: a.resolvedById } : null,
    resolvedAt: a.resolvedAt,
    resolution: a.resolution,
    version: a.version,
  };
}

/**
 * Operational alerts (Spec §15): conditions needing attention, deduplicated by key. Raising runs inside the caller's
 * transaction; a new alert is announced once (`ops.alert.raised.v1`), repeats only count.
 */
@Injectable()
export class AlertService {
  constructor(
    private readonly repo: SlaRepositories,
    private readonly events: EventPublisher,
    private readonly audit: AuditWriter,
  ) {}

  async raise(input: RaiseAlertInput): Promise<{ alert: AlertRow; created: boolean }> {
    const now = new Date();
    const result = await this.repo.raiseAlert({
      id: newId(),
      tenantId: input.tenantId,
      propertyId: input.propertyId,
      type: input.type,
      severity: input.severity,
      dedupeKey: input.dedupeKey,
      subjectType: input.subject?.type ?? null,
      subjectId: input.subject?.id ?? null,
      evidence: input.evidence ?? {},
      firstSeenAt: now,
      lastSeenAt: now,
    });
    if (result.created)
      await this.events.publish(AlertRaised, {
        tenantId: input.tenantId,
        propertyId: input.propertyId,
        source: OPS_SOURCE,
        aggregate: { type: 'alert', id: result.alert.id },
        payload: {
          alert_id: result.alert.id,
          type: input.type,
          severity: input.severity,
          subject_type: input.subject?.type ?? null,
          subject_id: input.subject?.id ?? null,
        },
      });
    return result;
  }

  /** The condition ended by itself (e.g. the late work was done): its active alerts close as SYSTEM. */
  async resolveByKeys(
    scope: TenantScope,
    keys: readonly string[],
    resolution: string,
  ): Promise<void> {
    const now = new Date();
    for (const a of await this.repo.activeAlertsForKeys(scope, keys)) {
      await this.repo.updateAlert(scope, a.id, {
        status: 'RESOLVED',
        resolvedAt: now,
        resolvedByType: 'SYSTEM',
        resolvedById: null,
        resolution,
      });
      await this.audit.record({
        action: 'ops.alert.resolve',
        entityType: 'alert',
        entityId: a.id,
        tenantId: a.tenantId,
        propertyId: a.propertyId,
        before: { status: a.status },
        after: { status: 'RESOLVED' },
        reason: resolution,
        actor: { type: 'SYSTEM', id: null },
      });
    }
  }
}

/** Staff side of alerts: the board, acknowledgement and resolution. */
@Injectable()
export class AlertAdminService {
  constructor(
    private readonly repo: SlaRepositories,
    private readonly gate: ActionGate,
    private readonly tx: TransactionRunner,
    private readonly audit: AuditWriter,
    private readonly actors: ActorStore,
  ) {}

  list(scope: PropertyScope, query: ListAlertsQuery) {
    return this.gate.execute(
      { action: 'alert.read', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () =>
        this.tx.read(async () =>
          (await this.repo.listAlerts(scope, { status: query.status, limit: query.limit })).map(
            alertView,
          ),
        ),
    );
  }

  acknowledge(scope: PropertyScope, alertId: string) {
    return this.change(scope, alertId, 'ACKNOWLEDGED', null);
  }

  resolve(scope: PropertyScope, alertId: string, resolution: string) {
    return this.change(scope, alertId, 'RESOLVED', resolution);
  }

  private change(
    scope: PropertyScope,
    alertId: string,
    to: 'ACKNOWLEDGED' | 'RESOLVED',
    resolution: string | null,
  ) {
    return this.gate.execute(
      { action: 'alert.ack', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () =>
        this.tx.run(async () => {
          const actor = this.actors.require();
          const alert = isUuid(alertId)
            ? await this.repo.alertForUpdate(scope, alertId)
            : undefined;
          if (!alert || alert.propertyId !== scope.propertyId)
            throw AppError.notFound('ops.alert.not_found');
          if (alert.status === 'RESOLVED' || alert.status === to)
            throw AppError.conflict('ops.alert.transition_not_allowed', { status: alert.status });
          const now = new Date();
          const updated = await this.repo.updateAlert(
            scope,
            alert.id,
            to === 'ACKNOWLEDGED'
              ? { status: to, acknowledgedAt: now, acknowledgedById: actor.id }
              : {
                  status: to,
                  resolvedAt: now,
                  resolvedByType: actor.type,
                  resolvedById: actor.id,
                  resolution,
                },
          );
          await this.audit.record({
            action: to === 'ACKNOWLEDGED' ? 'ops.alert.acknowledge' : 'ops.alert.resolve',
            entityType: 'alert',
            entityId: alert.id,
            tenantId: scope.tenantId,
            propertyId: scope.propertyId,
            before: { status: alert.status },
            after: { status: to },
            reason: resolution,
          });
          return alertView(updated);
        }),
    );
  }
}
