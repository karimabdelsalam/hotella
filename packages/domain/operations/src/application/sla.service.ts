import { Inject, Injectable } from '@nestjs/common';
import { EscalationTriggered, SlaBreached } from '@hotella/contracts-events';
import { ORGANIZATION_API, type OrganizationPublicApi } from '@hotella/domain-organization/public';
import {
  newId,
  type PropertyScope,
  type TenantScope,
  TransactionRunner,
} from '@hotella/platform-database';
import { EventPublisher } from '@hotella/platform-events';
import { InjectLogger, type Logger } from '@hotella/platform-observability';
import {
  addBusinessMinutes,
  computeSlaDeadlines,
  type EscalationRule,
  escalationKey,
  evaluateSla,
  pickPolicy,
  type SlaCalendar,
  type SlaClock,
} from '../domain/sla';
import { isTerminal } from '../domain/task-lifecycle';
import { OperationsRepositories } from '../infrastructure/repositories';
import { SlaRepositories } from '../infrastructure/sla-repositories';
import type { SlaInstanceRow, TaskRow, WorkItemRow } from '../infrastructure/schema';
import { AlertService } from './alert.service';
import { OPS_SOURCE } from './constants';

const TRIGGER_ALERT_TYPE: Record<EscalationRule['trigger'], string> = {
  RESPONSE_BREACH: 'SLA_RESPONSE_BREACHED',
  RESOLUTION_WARNING: 'SLA_AT_RISK',
  RESOLUTION_BREACH: 'SLA_RESOLUTION_BREACHED',
};

/** One alert per SLA and trigger: higher ladder levels raise its severity instead of adding alerts. */
export function slaAlertKey(instanceId: string, trigger: EscalationRule['trigger']): string {
  return `sla:${instanceId}:${trigger}`;
}
const allAlertKeys = (instanceId: string) =>
  (Object.keys(TRIGGER_ALERT_TYPE) as Array<EscalationRule['trigger']>).map((t) =>
    slaAlertKey(instanceId, t),
  );

function clockOf(i: SlaInstanceRow): SlaClock {
  return {
    responseDueAt: i.responseDueAt,
    resolutionDueAt: i.resolutionDueAt,
    responseMetAt: i.responseMetAt,
    resolutionMetAt: i.resolutionMetAt,
    responseBreachedAt: i.responseBreachedAt,
    resolutionBreachedAt: i.resolutionBreachedAt,
  };
}

/**
 * SLA lifecycle of work items (Spec §8.3): the clock starts with the work item under the most specific policy, the
 * response target is met when someone takes a task on, the resolution clock pauses while every open task waits for a
 * pausing reason, and it stops when the work item is resolved or cancelled. Everything runs inside the caller's
 * transaction; the worker's `SlaMonitor` fires breaches and escalations.
 */
@Injectable()
export class SlaService {
  constructor(
    private readonly repo: SlaRepositories,
    private readonly ops: OperationsRepositories,
    private readonly alerts: AlertService,
    private readonly events: EventPublisher,
    @Inject(ORGANIZATION_API) private readonly org: OrganizationPublicApi,
  ) {}

  async start(
    scope: PropertyScope,
    item: WorkItemRow,
    now = new Date(),
  ): Promise<SlaInstanceRow | null> {
    const policy = pickPolicy(await this.repo.listPolicies(scope, true), {
      kind: item.kind,
      serviceCode: item.serviceCode,
      departmentCode: item.departmentCode,
      priority: item.priority,
    });
    if (!policy) return null;
    let calendar: SlaCalendar = { kind: 'ALWAYS' };
    if (policy.businessHoursId) {
      const hours = await this.repo.businessHours(scope, policy.businessHoursId);
      const property = await this.org.getProperty(scope.tenantId, scope.propertyId);
      if (hours && property)
        calendar = {
          kind: 'BUSINESS_HOURS',
          timeZone: property.timezone,
          schedule: hours.schedule,
        };
    }
    const due = computeSlaDeadlines(
      { responseMinutes: policy.responseMinutes, resolutionMinutes: policy.resolutionMinutes },
      calendar,
      now,
    );
    const clock: SlaClock = {
      ...due,
      responseMetAt: null,
      resolutionMetAt: null,
      responseBreachedAt: null,
      resolutionBreachedAt: null,
    };
    const instance = await this.repo.insertInstance({
      id: newId(),
      tenantId: scope.tenantId,
      propertyId: scope.propertyId,
      workItemId: item.id,
      policyId: policy.id,
      policyVersion: policy.version,
      calendar,
      responseMinutes: policy.responseMinutes,
      resolutionMinutes: policy.resolutionMinutes,
      pauseReasons: policy.pauseReasons,
      escalationRules: policy.escalationRules,
      startedAt: now,
      responseDueAt: due.responseDueAt,
      resolutionDueAt: due.resolutionDueAt,
      nextCheckAt: nextCheck(clock, policy.escalationRules, new Set(), now),
    });
    await this.ops.updateWorkItem(scope, item.id, { slaInstanceId: instance.id });
    return instance;
  }

  /** Brings the SLA in line with the work item and its tasks (after every task transition). */
  async sync(scope: TenantScope, workItemId: string, now = new Date()): Promise<void> {
    const instance = await this.repo.instanceOfWorkItemForUpdate(scope, workItemId);
    if (!instance || instance.status === 'COMPLETED' || instance.status === 'CANCELLED') return;
    const item = (await this.ops.workItem(scope, workItemId))!;
    const tasks = await this.ops.tasksOfWorkItems(scope, [workItemId]);
    const patch: Partial<SlaInstanceRow> = {};

    if (!instance.responseMetAt) {
      const met = firstTakenAt(tasks);
      if (met) {
        patch.responseMetAt = met;
        // "Nobody took it on" has ended: that alert closes; resolution alerts stay until the work is done.
        await this.alerts.resolveByKeys(
          scope,
          [slaAlertKey(instance.id, 'RESPONSE_BREACH')],
          'RESPONSE_MET',
        );
        if (
          instance.responseDueAt &&
          met > instance.responseDueAt &&
          !instance.responseBreachedAt
        ) {
          patch.responseBreachedAt = instance.responseDueAt;
          await this.breached(instance, 'RESPONSE', instance.responseDueAt);
        }
      }
    }

    if (item.status === 'RESOLVED' || item.status === 'CANCELLED') {
      const resolved = item.status === 'RESOLVED';
      const metAt = item.resolvedAt ?? now;
      if (resolved) {
        patch.resolutionMetAt = metAt;
        if (metAt > instance.resolutionDueAt && !instance.resolutionBreachedAt) {
          patch.resolutionBreachedAt = instance.resolutionDueAt;
          await this.breached(instance, 'RESOLUTION', instance.resolutionDueAt);
        }
      }
      await this.repo.closeOpenPause(scope, instance.id, now);
      await this.repo.updateInstance(scope, instance.id, {
        ...patch,
        status: resolved ? 'COMPLETED' : 'CANCELLED',
        closedAt: now,
        nextCheckAt: null,
      });
      await this.alerts.resolveByKeys(
        scope,
        allAlertKeys(instance.id),
        resolved ? 'WORK_RESOLVED' : 'WORK_CANCELLED',
      );
      return;
    }

    const open = tasks.filter((t) => !isTerminal(t.status));
    const waiting =
      open.length > 0 &&
      open.every(
        (t) =>
          t.status === 'PAUSED' &&
          t.pauseReason !== null &&
          instance.pauseReasons.includes(t.pauseReason),
      );
    let status = instance.status;
    if (waiting && status === 'RUNNING') {
      await this.repo.insertPause({
        id: newId(),
        tenantId: instance.tenantId,
        propertyId: instance.propertyId,
        slaInstanceId: instance.id,
        reason: open[0]!.pauseReason!,
        pausedAt: now,
      });
      status = 'PAUSED';
      patch.status = status;
      patch.nextCheckAt = null;
    } else if (!waiting && status === 'PAUSED') {
      await this.repo.closeOpenPause(scope, instance.id, now);
      const pauses = (await this.repo.pauses(scope, instance.id)).map((p) => ({
        start: p.pausedAt.getTime(),
        end: p.resumedAt?.getTime() ?? null,
      }));
      patch.resolutionDueAt = addBusinessMinutes(
        instance.startedAt,
        instance.resolutionMinutes,
        instance.calendar,
        pauses,
      );
      status = 'RUNNING';
      patch.status = status;
    }
    if (status === 'RUNNING') {
      const fired = new Set((await this.repo.escalations(scope, instance.id)).map(escalationKey));
      patch.nextCheckAt = nextCheck(
        { ...clockOf(instance), ...patch } as SlaClock,
        instance.escalationRules,
        fired,
        now,
      );
    }
    if (Object.keys(patch).length > 0) await this.repo.updateInstance(scope, instance.id, patch);
  }

  private breached(instance: SlaInstanceRow, target: 'RESPONSE' | 'RESOLUTION', dueAt: Date) {
    return publishBreach(this.events, instance, target, dueAt);
  }
}

/**
 * The worker side of SLAs: claims running SLAs whose next check is due, records breaches, fires the escalation ladder
 * (alert + `ops.escalation.triggered.v1`) and schedules the next check. Safe to run on several workers at once.
 */
@Injectable()
export class SlaMonitor {
  constructor(
    private readonly repo: SlaRepositories,
    private readonly alerts: AlertService,
    private readonly events: EventPublisher,
    private readonly tx: TransactionRunner,
    @InjectLogger() private readonly logger: Logger,
  ) {}

  /** Evaluates every due SLA; returns how many were looked at. */
  async sweep(now = new Date(), batch = 50): Promise<number> {
    let total = 0;
    for (;;) {
      const n = await this.tx.run(async () => {
        const due = await this.repo.claimDue(now, batch);
        for (const d of due) await this.evaluate({ tenantId: d.tenantId }, d.id, now);
        return due.length;
      });
      total += n;
      if (n < batch) break;
    }
    if (total > 0) this.logger.debug({ evaluated: total }, 'sla sweep');
    return total;
  }

  private async evaluate(scope: TenantScope, instanceId: string, now: Date): Promise<void> {
    const instance = (await this.repo.instanceForUpdate(scope, instanceId))!;
    const fired = new Set((await this.repo.escalations(scope, instance.id)).map(escalationKey));
    const result = evaluateSla(clockOf(instance), instance.escalationRules, fired, now);
    const patch: Partial<SlaInstanceRow> = {};
    if (result.responseBreached && instance.responseDueAt) {
      patch.responseBreachedAt = instance.responseDueAt;
      await publishBreach(this.events, instance, 'RESPONSE', instance.responseDueAt);
    }
    if (result.resolutionBreached) {
      patch.resolutionBreachedAt = instance.resolutionDueAt;
      await publishBreach(this.events, instance, 'RESOLUTION', instance.resolutionDueAt);
    }
    for (const rule of result.escalations) {
      const { alert } = await this.alerts.raise({
        tenantId: instance.tenantId,
        propertyId: instance.propertyId,
        type: TRIGGER_ALERT_TYPE[rule.trigger],
        severity: rule.severity,
        dedupeKey: slaAlertKey(instance.id, rule.trigger),
        subject: { type: 'work_item', id: instance.workItemId },
        evidence: {
          level: rule.level,
          response_due_at: instance.responseDueAt?.toISOString() ?? null,
          resolution_due_at: instance.resolutionDueAt.toISOString(),
        },
      });
      const escalation = await this.repo.insertEscalation({
        id: newId(),
        tenantId: instance.tenantId,
        propertyId: instance.propertyId,
        slaInstanceId: instance.id,
        trigger: rule.trigger,
        level: rule.level,
        severity: rule.severity,
        notifyRoles: [...rule.notifyRoles],
        alertId: alert.id,
        triggeredAt: now,
      });
      if (escalation)
        await this.events.publish(EscalationTriggered, {
          tenantId: instance.tenantId,
          propertyId: instance.propertyId,
          source: OPS_SOURCE,
          aggregate: { type: 'sla_instance', id: instance.id },
          payload: {
            escalation_id: escalation.id,
            sla_instance_id: instance.id,
            work_item_id: instance.workItemId,
            trigger: rule.trigger,
            level: rule.level,
            severity: rule.severity,
            notify_roles: [...rule.notifyRoles],
            alert_id: alert.id,
          },
        });
      fired.add(escalationKey(rule));
    }
    patch.nextCheckAt = nextCheck(
      { ...clockOf(instance), ...patch } as SlaClock,
      instance.escalationRules,
      fired,
      now,
    );
    await this.repo.updateInstance(scope, instance.id, patch);
  }
}

/** When to look at a running SLA next: now if something is already due, else its next deadline. */
function nextCheck(
  clock: SlaClock,
  rules: readonly EscalationRule[],
  fired: ReadonlySet<string>,
  now: Date,
): Date | null {
  const e = evaluateSla(clock, rules, fired, now);
  return e.responseBreached || e.resolutionBreached || e.escalations.length > 0
    ? now
    : e.nextCheckAt;
}

function firstTakenAt(tasks: readonly TaskRow[]): Date | null {
  const times = tasks
    .flatMap((t) => [t.acceptedAt, t.startedAt, t.completedAt])
    .filter((d): d is Date => d !== null)
    .map((d) => d.getTime());
  return times.length ? new Date(Math.min(...times)) : null;
}

function publishBreach(
  events: EventPublisher,
  instance: SlaInstanceRow,
  target: 'RESPONSE' | 'RESOLUTION',
  dueAt: Date,
) {
  return events.publish(SlaBreached, {
    tenantId: instance.tenantId,
    propertyId: instance.propertyId,
    source: OPS_SOURCE,
    aggregate: { type: 'sla_instance', id: instance.id },
    payload: {
      sla_instance_id: instance.id,
      work_item_id: instance.workItemId,
      target,
      due_at: dueAt.toISOString(),
    },
  });
}
