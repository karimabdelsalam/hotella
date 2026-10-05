import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  type EventEnvelope,
  IntegrationTelemetryReceived,
  TELEMETRY_QUANTITIES,
  TELEMETRY_RULE_KINDS,
  TelemetryAlarmCleared,
  TelemetryAlarmRaised,
} from '@hotella/contracts-events';
import { INTEGRATIONS_API, type IntegrationsPublicApi } from '@hotella/domain-integrations/public';
import { OPERATIONS_API, type OperationsPublicApi } from '@hotella/domain-operations/public';
import { ORGANIZATION_API, type OrganizationPublicApi } from '@hotella/domain-organization/public';
import { AuditWriter } from '@hotella/platform-audit';
import { ActionGate, ActorStore } from '@hotella/platform-auth';
import { isUuid, newId, type PropertyScope, TransactionRunner } from '@hotella/platform-database';
import { EventPublisher } from '@hotella/platform-events';
import { AppError } from '@hotella/platform-i18n';
import { InjectLogger, type Logger, RequestContext } from '@hotella/platform-observability';
import {
  acceptableSampleTime,
  aggregate,
  evaluate,
  lookbackMinutes,
  MINUTE_MS,
  minuteOf,
  missingVerdict,
  ruleParamsSchemas,
  type Verdict,
} from '../domain/telemetry';
import { EngineeringRepositories } from '../infrastructure/repositories';
import type {
  TelemetryAlarmRow,
  TelemetryPointRow,
  TelemetryRuleRow,
} from '../infrastructure/schema';
import { TelemetryRepositories } from '../infrastructure/telemetry-repositories';
import { WorkOrderService } from './work-order.service';

const ENG = 'eng';

export const createPointSchema = z
  .object({
    instanceId: z.uuid(),
    externalCode: z.string().trim().min(1).max(64),
    name: z.string().trim().min(1).max(200).optional(),
    assetId: z.uuid().optional(),
    locationId: z.uuid().optional(),
    quantity: z.enum(TELEMETRY_QUANTITIES),
    unit: z.string().trim().min(1).max(16),
    status: z.enum(['ACTIVE', 'IGNORED']).default('ACTIVE'),
  })
  .refine((p) => p.status === 'IGNORED' || p.assetId || p.locationId, {
    message: 'an asset or a location',
    path: ['locationId'],
  });
export const updatePointSchema = z.object({
  version: z.number().int().min(1),
  status: z.enum(['ACTIVE', 'IGNORED']).optional(),
  name: z.string().trim().min(1).max(200).optional(),
  assetId: z.uuid().nullable().optional(),
  locationId: z.uuid().nullable().optional(),
});
export const createRuleSchema = z.object({
  pointId: z.uuid(),
  kind: z.enum(TELEMETRY_RULE_KINDS),
  params: z.record(z.string(), z.number()),
  severity: z.enum(['WARNING', 'CRITICAL']),
  action: z.enum(['ALERT', 'WORK_ORDER']).default('ALERT'),
});
export const versionSchema = z.object({ version: z.number().int().min(1) });
export const minutesQuerySchema = z.object({
  from: z.iso.datetime({ offset: true }).transform((v) => new Date(v)),
  to: z.iso.datetime({ offset: true }).transform((v) => new Date(v)),
});

/** Minutes a minutes query may span (a day of minute rows). */
const MAX_QUERY_MINUTES = 24 * 60;

/**
 * Building telemetry (ADR-0024, BUILD_PLAN 13.2): engineering's point registry (the point mapping), minute aggregates
 * of the samples integrations hand over as one event per message, deterministic rules (rule 11) that raise and clear
 * alarms with hysteresis, and the reactions — an operational alert per alarm, predictive work when the rule says so.
 */
@Injectable()
export class TelemetryService {
  constructor(
    private readonly repo: TelemetryRepositories,
    private readonly eng: EngineeringRepositories,
    private readonly orders: WorkOrderService,
    private readonly tx: TransactionRunner,
    private readonly gate: ActionGate,
    private readonly audit: AuditWriter,
    private readonly events: EventPublisher,
    private readonly actors: ActorStore,
    private readonly ctx: RequestContext,
    @Inject(ORGANIZATION_API) private readonly org: OrganizationPublicApi,
    @Inject(INTEGRATIONS_API) private readonly integrations: IntegrationsPublicApi,
    @Inject(OPERATIONS_API) private readonly ops: OperationsPublicApi,
    @InjectLogger() private readonly logger: Logger,
  ) {}

  // ---- points ----

  listPoints(scope: PropertyScope) {
    return this.read(scope, () => this.repo.pointsOf(scope));
  }

  createPoint(scope: PropertyScope, input: z.infer<typeof createPointSchema>) {
    return this.manage(scope, async () => {
      const instance = (
        await this.integrations.listInstances(scope.tenantId, scope.propertyId)
      ).find((i) => i.id === input.instanceId);
      if (!instance) throw AppError.notFound('integration.instance.not_found');
      await this.checkPlace(scope, input.assetId ?? null, input.locationId ?? null);
      const actor = this.actors.require();
      const row = await this.repo.insertPoint({
        id: newId(),
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        instanceId: instance.id,
        externalCode: input.externalCode,
        name: input.name ?? null,
        assetId: input.assetId ?? null,
        locationId: input.locationId ?? null,
        quantity: input.quantity,
        unit: input.unit,
        status: input.status,
        createdBy: isUuid(actor.id) ? actor.id : null,
      });
      if (!row) throw AppError.conflict('eng.telemetry.point_exists');
      // The point is now known: its unknown-code exception is settled where it was raised.
      await this.integrations.resolveUnknownCode(
        scope.tenantId,
        instance.id,
        'POINT',
        input.externalCode,
        isUuid(actor.id) ? actor.id : null,
      );
      await this.audit.record({
        action: 'eng.telemetry.point.create',
        entityType: 'telemetry_point',
        entityId: row.id,
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        after: { external_code: row.externalCode, quantity: row.quantity, status: row.status },
      });
      return row;
    });
  }

  updatePoint(scope: PropertyScope, pointId: string, input: z.infer<typeof updatePointSchema>) {
    return this.manage(scope, async () => {
      const point = await this.point(scope, pointId);
      const assetId = input.assetId === undefined ? point.assetId : input.assetId;
      const locationId = input.locationId === undefined ? point.locationId : input.locationId;
      const status = input.status ?? point.status;
      if (status === 'ACTIVE' && !assetId && !locationId)
        throw AppError.conflict('eng.telemetry.point_unplaced');
      await this.checkPlace(scope, assetId, locationId);
      const row = await this.repo.updatePoint(scope, point.id, input.version, {
        status,
        assetId,
        locationId,
        ...(input.name ? { name: input.name } : {}),
      });
      if (!row) throw AppError.conflict('eng.telemetry.version_conflict');
      await this.audit.record({
        action: 'eng.telemetry.point.update',
        entityType: 'telemetry_point',
        entityId: row.id,
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        before: { status: point.status, asset_id: point.assetId, location_id: point.locationId },
        after: { status: row.status, asset_id: row.assetId, location_id: row.locationId },
      });
      return row;
    });
  }

  minutes(scope: PropertyScope, pointId: string, query: z.infer<typeof minutesQuerySchema>) {
    return this.read(scope, async () => {
      const point = await this.point(scope, pointId);
      const span = (query.to.getTime() - query.from.getTime()) / MINUTE_MS;
      if (span < 0 || span > MAX_QUERY_MINUTES)
        throw new AppError('eng.telemetry.range_too_long', HttpStatus.BAD_REQUEST, {
          minutes: MAX_QUERY_MINUTES,
        });
      return (await this.repo.minutes(scope, point.id, query.from, query.to)).map((m) => ({
        minute: m.minute,
        min: m.min,
        max: m.max,
        avg: m.sum / m.samples,
        samples: m.samples,
        last: m.last,
      }));
    });
  }

  // ---- rules (immutable once created, rule 9) ----

  listRules(scope: PropertyScope, pointId?: string) {
    return this.read(scope, () => this.repo.rulesOf(scope, pointId));
  }

  createRule(scope: PropertyScope, input: z.infer<typeof createRuleSchema>) {
    return this.manage(scope, async () => {
      const point = await this.point(scope, input.pointId);
      const params = ruleParamsSchemas[input.kind].safeParse(input.params);
      if (!params.success)
        throw new AppError('eng.telemetry.rule_params_invalid', HttpStatus.BAD_REQUEST, {
          issues: params.error.issues.map((i) => i.path.join('.') || i.message).join(', '),
        });
      if (input.action === 'WORK_ORDER' && !point.assetId && !point.locationId)
        throw AppError.conflict('eng.telemetry.point_unplaced');
      const actor = this.actors.require();
      const row = await this.repo.insertRule({
        id: newId(),
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        pointId: point.id,
        kind: input.kind,
        params: params.data as Record<string, number>,
        severity: input.severity,
        action: input.action,
        createdBy: isUuid(actor.id) ? actor.id : null,
      });
      await this.audit.record({
        action: 'eng.telemetry.rule.create',
        entityType: 'telemetry_rule',
        entityId: row.id,
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        after: { point_id: point.id, kind: row.kind, params: row.params, severity: row.severity },
      });
      return row;
    });
  }

  retireRule(scope: PropertyScope, ruleId: string, version: number) {
    return this.manage(scope, async () => {
      const rule = isUuid(ruleId) ? await this.repo.rule(scope, ruleId) : undefined;
      if (!rule) throw AppError.notFound('eng.telemetry.rule_not_found');
      const actor = this.actors.require();
      const row = await this.repo.retireRule(
        scope,
        rule.id,
        version,
        isUuid(actor.id) ? actor.id : null,
      );
      if (!row) throw AppError.conflict('eng.telemetry.version_conflict');
      // A retired rule leaves no alarm behind.
      const [live] = await this.repo.liveAlarmsOf(scope, [rule.id]);
      if (live) await this.clear(scope, live, rule, new Date());
      await this.audit.record({
        action: 'eng.telemetry.rule.retire',
        entityType: 'telemetry_rule',
        entityId: row.id,
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        before: { status: rule.status },
        after: { status: row.status },
      });
      return row;
    });
  }

  // ---- alarms ----

  listAlarms(scope: PropertyScope, filter: { live?: boolean; pointId?: string }) {
    return this.read(scope, () => this.repo.alarmsOf(scope, { ...filter, limit: 200 }));
  }

  acknowledge(scope: PropertyScope, alarmId: string, version: number) {
    return this.gate.execute(
      {
        action: 'eng.telemetry.acknowledge',
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
      },
      () =>
        this.tx.run(async () => {
          const alarm = isUuid(alarmId) ? await this.repo.alarm(scope, alarmId) : undefined;
          if (!alarm) throw AppError.notFound('eng.telemetry.alarm_not_found');
          if (alarm.status !== 'OPEN') throw AppError.conflict('eng.telemetry.alarm_not_open');
          const actor = this.actors.require();
          const row = await this.repo.updateAlarm(scope, alarm.id, version, {
            status: 'ACKNOWLEDGED',
            acknowledgedAt: new Date(),
            acknowledgedBy: isUuid(actor.id) ? actor.id : null,
          });
          if (!row) throw AppError.conflict('eng.telemetry.version_conflict');
          await this.audit.record({
            action: 'eng.telemetry.alarm.acknowledge',
            entityType: 'telemetry_alarm',
            entityId: row.id,
            tenantId: scope.tenantId,
            propertyId: scope.propertyId,
            before: { status: alarm.status },
            after: { status: row.status },
          });
          return row;
        }),
    );
  }

  // ---- intake (worker consumer of integration.telemetry_batch.received.v1) ----

  async receive(envelope: EventEnvelope, now = new Date()): Promise<void> {
    const tenantId = envelope.tenant_id;
    const propertyId = envelope.property_id;
    if (!tenantId || !propertyId || envelope.event_type !== IntegrationTelemetryReceived.type)
      return;
    const e = IntegrationTelemetryReceived.parse(envelope).payload;
    await this.ctx.run({ tenant_id: tenantId, property_id: propertyId, actor_type: 'SYSTEM' }, () =>
      this.tx.run(() => this.intake({ tenantId, propertyId }, e, now)),
    );
  }

  private async intake(
    scope: PropertyScope,
    e: {
      instance_id: string;
      message_id: string;
      samples: { point: string; value: number; at: string }[];
    },
    now: Date,
  ) {
    const codes = [...new Set(e.samples.map((s) => s.point))];
    const points = new Map(
      (await this.repo.pointsByCode(scope, e.instance_id, codes)).map((p) => [p.externalCode, p]),
    );
    // Unknown points are reported, never guessed (rule 16); their samples are dropped.
    for (const code of codes.filter((c) => !points.has(c)))
      await this.integrations.reportUnknownCode({
        tenantId: scope.tenantId,
        integrationInstanceId: e.instance_id,
        messageId: e.message_id,
        mappingType: 'POINT',
        externalCode: code,
      });
    let dropped = 0;
    const touched: Array<{ point: TelemetryPointRow; latest: Date }> = [];
    for (const point of points.values()) {
      if (point.status !== 'ACTIVE' || point.propertyId !== scope.propertyId) continue;
      const samples = e.samples
        .filter((s) => s.point === point.externalCode)
        .map((s) => ({ value: s.value, at: new Date(s.at) }))
        .filter((s) => {
          const ok = acceptableSampleTime(s.at, now);
          if (!ok) dropped++;
          return ok;
        });
      if (samples.length === 0) continue;
      const minutes = aggregate(samples);
      for (const m of minutes) await this.repo.mergeMinute(point, m);
      const newest = minutes.reduce((a, m) => (m.lastAt > a.lastAt ? m : a));
      await this.repo.touchPoint(scope, point.id, newest.last, newest.lastAt);
      touched.push({ point, latest: minutes[minutes.length - 1]!.minute });
    }
    if (dropped > 0)
      this.logger.warn(
        { instance_id: e.instance_id, dropped },
        'telemetry samples outside the accepted time window dropped',
      );
    for (const t of touched) await this.evaluatePoint(scope, t.point, t.latest);
  }

  /** Threshold, rate and stuck rules of one point, on its minutes up to the newest minute of the batch. */
  private async evaluatePoint(scope: PropertyScope, point: TelemetryPointRow, latest: Date) {
    const allRules = await this.repo.activeRulesOf(scope, [point.id]);
    if (allRules.length === 0) return;
    const rules = allRules.filter((r) => r.kind !== 'MISSING');
    const missing = allRules.filter((r) => r.kind === 'MISSING');
    const live = new Map(
      (
        await this.repo.liveAlarmsOf(
          scope,
          allRules.map((r) => r.id),
        )
      ).map((a) => [a.ruleId, a]),
    );
    // Data arrived: a missing-data alarm of this point clears.
    for (const rule of missing) {
      const alarm = live.get(rule.id);
      if (alarm) await this.clear(scope, alarm, rule, latest);
    }
    if (rules.length === 0) return;
    const back = Math.max(...rules.map((r) => lookbackMinutes(r.kind, r.params)));
    const minutes = await this.repo.minutes(
      scope,
      point.id,
      new Date(latest.getTime() - back * MINUTE_MS),
      latest,
    );
    for (const rule of rules) {
      const verdict = evaluate(
        rule.kind as Exclude<typeof rule.kind, 'MISSING'>,
        rule.params,
        minutes,
        latest,
        live.has(rule.id),
      );
      await this.apply(scope, point, rule, live.get(rule.id), verdict, latest);
    }
  }

  private async apply(
    scope: PropertyScope,
    point: TelemetryPointRow,
    rule: TelemetryRuleRow,
    alarm: TelemetryAlarmRow | undefined,
    verdict: Verdict,
    at: Date,
  ) {
    if (verdict.kind === 'RAISE' && !alarm) await this.raise(scope, point, rule, verdict.value, at);
    else if (verdict.kind === 'CLEAR' && alarm) await this.clear(scope, alarm, rule, at);
    else if (verdict.kind === 'HOLD' && alarm && verdict.value !== null) {
      const worse =
        alarm.peak === null ||
        (rule.kind === 'THRESHOLD' && rule.params.below !== undefined
          ? verdict.value < alarm.peak
          : verdict.value > alarm.peak);
      if (worse)
        await this.repo.updateAlarm(scope, alarm.id, alarm.version, { peak: verdict.value });
    }
  }

  private async raise(
    scope: PropertyScope,
    point: TelemetryPointRow,
    rule: TelemetryRuleRow,
    value: number | null,
    at: Date,
  ) {
    const alarm = await this.repo.insertAlarm({
      id: newId(),
      tenantId: scope.tenantId,
      propertyId: scope.propertyId,
      pointId: point.id,
      ruleId: rule.id,
      raisedAt: at,
      value,
      peak: value,
    });
    if (!alarm) return; // raised concurrently
    const asset = point.assetId ? await this.eng.asset(scope, point.assetId) : undefined;
    const locationId = point.locationId ?? asset?.locationId ?? null;
    await this.events.publish(TelemetryAlarmRaised, {
      tenantId: scope.tenantId,
      propertyId: scope.propertyId,
      source: ENG,
      aggregate: { type: 'telemetry_alarm', id: alarm.id },
      occurredAt: at,
      payload: {
        alarm_id: alarm.id,
        point_id: point.id,
        rule_id: rule.id,
        rule_kind: rule.kind,
        quantity: point.quantity,
        severity: rule.severity,
        asset_id: point.assetId,
        location_id: locationId,
        value,
        raised_at: at.toISOString(),
      },
    });
    await this.ops.raiseAlert({
      tenantId: scope.tenantId,
      propertyId: scope.propertyId,
      type: 'TELEMETRY_ALARM',
      severity: rule.severity,
      dedupeKey: `telemetry:${alarm.id}`,
      subject: { type: 'telemetry_alarm', id: alarm.id },
      evidence: {
        point_id: point.id,
        quantity: point.quantity,
        rule_kind: rule.kind,
        value,
        unit: point.unit,
      },
    });
    if (rule.action === 'WORK_ORDER' && locationId) {
      const order = await this.orders.openFromTelemetry(scope, {
        assetId: point.assetId,
        locationId,
        severity: rule.severity,
      });
      await this.repo.updateAlarm(scope, alarm.id, alarm.version, { workOrderId: order.id });
    }
    await this.audit.record({
      action: 'eng.telemetry.alarm.raise',
      entityType: 'telemetry_alarm',
      entityId: alarm.id,
      tenantId: scope.tenantId,
      propertyId: scope.propertyId,
      actor: { type: 'SYSTEM', id: null },
      after: { point_id: point.id, rule_id: rule.id, value, severity: rule.severity },
    });
  }

  private async clear(
    scope: PropertyScope,
    alarm: TelemetryAlarmRow,
    rule: TelemetryRuleRow,
    at: Date,
  ) {
    const clearedAt = at < alarm.raisedAt ? alarm.raisedAt : at;
    const row = await this.repo.updateAlarm(scope, alarm.id, alarm.version, {
      status: 'CLEARED',
      clearedAt,
    });
    if (!row) return;
    const point = await this.repo.point(scope, alarm.pointId);
    const asset = point?.assetId ? await this.eng.asset(scope, point.assetId) : undefined;
    await this.events.publish(TelemetryAlarmCleared, {
      tenantId: scope.tenantId,
      propertyId: scope.propertyId,
      source: ENG,
      aggregate: { type: 'telemetry_alarm', id: alarm.id },
      occurredAt: clearedAt,
      payload: {
        alarm_id: alarm.id,
        point_id: alarm.pointId,
        rule_id: rule.id,
        asset_id: point?.assetId ?? null,
        location_id: point?.locationId ?? asset?.locationId ?? null,
        cleared_at: clearedAt.toISOString(),
        duration_s: Math.round((clearedAt.getTime() - alarm.raisedAt.getTime()) / 1000),
      },
    });
  }

  // ---- sweep (worker job): missing data and partitions ----

  /** Raises and clears missing-data alarms; keeps the aggregate partitions. Returns the alarms raised. */
  async sweep(now = new Date()): Promise<number> {
    try {
      const dropped = await this.tx.run(() => this.repo.maintainPartitions());
      if (dropped > 0) this.logger.info({ dropped }, 'telemetry partitions past retention dropped');
    } catch (err) {
      this.logger.warn({ err }, 'telemetry partition maintenance failed');
    }
    const candidates = await this.tx.read(() => this.repo.missingCandidates());
    let raised = 0;
    for (const { point, rule } of candidates) {
      const scope = { tenantId: point.tenantId, propertyId: point.propertyId };
      try {
        await this.ctx.run(
          { tenant_id: scope.tenantId, property_id: scope.propertyId, actor_type: 'SYSTEM' },
          () =>
            this.tx.run(async () => {
              const [alarm] = await this.repo.liveAlarmsOf(scope, [rule.id]);
              const verdict = missingVerdict(
                rule.params,
                point.lastAt,
                rule.createdAt,
                minuteOf(now),
                alarm !== undefined,
              );
              if (verdict.kind === 'RAISE' && !alarm) {
                await this.raise(scope, point, rule, null, minuteOf(now));
                raised++;
              } else if (verdict.kind === 'CLEAR' && alarm)
                await this.clear(scope, alarm, rule, now);
            }),
        );
      } catch (err) {
        this.logger.warn({ err, rule_id: rule.id }, 'missing-data rule not evaluated');
      }
    }
    return raised;
  }

  // ---- helpers ----

  private read<T>(scope: PropertyScope, fn: () => Promise<T>): Promise<T> {
    return this.gate.execute(
      { action: 'eng.telemetry.read', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () => this.tx.read(fn),
    );
  }

  private manage<T>(scope: PropertyScope, fn: () => Promise<T>): Promise<T> {
    return this.gate.execute(
      { action: 'eng.telemetry.manage', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () => this.tx.run(fn),
    );
  }

  private async point(scope: PropertyScope, id: string): Promise<TelemetryPointRow> {
    const p = isUuid(id) ? await this.repo.point(scope, id) : undefined;
    if (!p) throw AppError.notFound('eng.telemetry.point_not_found');
    return p;
  }

  private async checkPlace(
    scope: PropertyScope,
    assetId: string | null,
    locationId: string | null,
  ) {
    if (assetId) {
      const asset = isUuid(assetId) ? await this.eng.asset(scope, assetId) : undefined;
      if (!asset || asset.propertyId !== scope.propertyId)
        throw AppError.notFound('eng.asset.not_found');
    }
    if (locationId && !(await this.org.getLocation(scope.tenantId, scope.propertyId, locationId)))
      throw AppError.notFound('org.location.not_found');
  }
}
