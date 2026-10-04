import { HttpStatus, Injectable } from '@nestjs/common';
import { LimitReached } from '@hotella/contracts-events';
import {
  currentTransaction,
  type TenantScope,
  newId,
  TransactionRunner,
} from '@hotella/platform-database';
import { EventPublisher } from '@hotella/platform-events';
import { AppError } from '@hotella/platform-i18n';
import { InjectLogger, type Logger } from '@hotella/platform-observability';
import { METRICS } from '../domain/catalog';
import { periodStart, usageKey } from '../domain/usage';
import type {
  UsageGaugeProvider,
  UsageGaugeRegistrar,
  UsagePublicApi,
  UsageRecord,
} from '../public';
import { UsageRepositories } from '../infrastructure/usage-repositories';
import { EntitlementEngine } from './entitlement-engine';

const METRIC = new Map(METRICS.map((m) => [m.code, m]));
const RETENTION_DAYS = 400;

/**
 * Usage metering (Spec §61, BUILD_PLAN 11.3): idempotent events, DAY and MONTH aggregates per tenant and per property
 * (UTC periods; counters summed, gauges at their maximum) in the same transaction, and one
 * `license.limit.reached.v1` per limit and period when usage reaches it. Reports read aggregates only.
 */
@Injectable()
export class UsageService implements UsagePublicApi, UsageGaugeRegistrar {
  private readonly gauges = new Map<string, UsageGaugeProvider>();

  constructor(
    private readonly repo: UsageRepositories,
    private readonly engine: EntitlementEngine,
    private readonly tx: TransactionRunner,
    private readonly events: EventPublisher,
    @InjectLogger() private readonly logger: Logger,
  ) {}

  register(provider: UsageGaugeProvider): void {
    const metric = METRIC.get(provider.metric);
    if (!metric || metric.kind !== 'GAUGE')
      throw new Error(`usage gauge ${provider.metric} is not a gauge metric of the catalog`);
    this.gauges.set(provider.metric, provider);
  }

  async record(input: UsageRecord): Promise<boolean> {
    const metric = METRIC.get(input.metric);
    if (!metric)
      throw new AppError('license.metric.unknown', HttpStatus.UNPROCESSABLE_ENTITY, {
        code: input.metric,
      });
    if (!Number.isInteger(input.quantity) || input.quantity < 0)
      throw new AppError('platform.validation_failed', HttpStatus.BAD_REQUEST, { count: 1 });
    const run = async () => {
      const at = input.occurredAt ?? new Date();
      const fresh = await this.repo.insertEvent({
        id: newId(),
        tenantId: input.tenantId,
        propertyId: input.propertyId,
        metricCode: input.metric,
        quantity: input.quantity,
        occurredAt: at,
        source: input.source,
        idempotencyKey: input.idempotencyKey,
      });
      if (!fresh) return false;
      const gauge = metric.kind === 'GAUGE';
      const keys = [input.tenantId, ...(input.propertyId ? [input.propertyId] : [])];
      const totals = new Map<string, number>();
      for (const propertyKey of keys)
        for (const granularity of ['DAY', 'MONTH'] as const)
          totals.set(
            usageKey(propertyKey, granularity),
            await this.repo.bump({
              tenantId: input.tenantId,
              propertyKey,
              metricCode: input.metric,
              granularity,
              periodStart: periodStart(granularity, at),
              quantity: input.quantity,
              gauge,
            }),
          );
      await this.notice(input, at, totals);
      return true;
    };
    // Join the caller's transaction (the measurement commits with what it measures), else open one.
    return currentTransaction() ? run() : this.tx.run(run);
  }

  async withinLimit(tenantId: string, propertyId: string | null, metric: string): Promise<boolean> {
    const now = new Date();
    for (const scope of propertyId ? (['TENANT', 'PROPERTY'] as const) : (['TENANT'] as const)) {
      const limit = await this.engine.limit(tenantId, propertyId, metric, scope);
      if (!limit || limit.enforcement !== 'HARD' || limit.period === 'NONE') continue;
      const used = await this.repo.aggregate(
        { tenantId },
        scope === 'TENANT' ? tenantId : propertyId!,
        metric,
        limit.period,
        periodStart(limit.period, now),
      );
      if (used >= limit.limitValue) return false;
    }
    return true;
  }

  /** Usage by period for the control plane (aggregates only). */
  report(
    scope: TenantScope,
    filter: {
      readonly propertyId: string | null;
      readonly granularity: 'DAY' | 'MONTH';
      readonly from: Date;
      readonly to: Date;
      readonly metric?: string;
    },
  ) {
    return this.repo.report(scope, {
      propertyKey: filter.propertyId ?? scope.tenantId,
      granularity: filter.granularity,
      from: filter.from,
      to: filter.to,
      metricCode: filter.metric,
    });
  }

  /** Daily gauge samples for every licensed tenant; a metric already sampled today is skipped (any replica). */
  async sampleGauges(now = new Date()): Promise<number> {
    const day = periodStart('DAY', now).toISOString().slice(0, 10);
    let recorded = 0;
    for (const provider of this.gauges.values()) {
      const collector = `gauge:${provider.metric}`;
      if ((await this.repo.cursor(collector)) === day) continue;
      for (const tenantId of await this.repo.licensedTenants()) {
        try {
          for (const s of await provider.sample(tenantId))
            if (
              await this.record({
                tenantId,
                propertyId: s.propertyId,
                metric: provider.metric,
                quantity: s.value,
                occurredAt: now,
                source: 'license.gauges',
                idempotencyKey: `gauge:${provider.metric}:${s.propertyId ?? tenantId}:${day}`,
              })
            )
              recorded++;
        } catch (err) {
          this.logger.warn(
            { err, metric: provider.metric, tenant_id: tenantId },
            'gauge sample failed',
          );
        }
      }
      await this.repo.setCursor(collector, day);
    }
    return recorded;
  }

  purgeEvents(now = new Date()): Promise<number> {
    return this.repo.purgeEventsBefore(new Date(now.getTime() - RETENTION_DAYS * 86_400_000));
  }

  /** One notice (and event) per limit, scope and period once usage reaches the limit. */
  private async notice(input: UsageRecord, at: Date, totals: ReadonlyMap<string, number>) {
    for (const scope of input.propertyId
      ? (['TENANT', 'PROPERTY'] as const)
      : (['TENANT'] as const)) {
      const limit = await this.engine.limit(input.tenantId, input.propertyId, input.metric, scope);
      if (!limit) continue;
      const propertyKey = scope === 'TENANT' ? input.tenantId : input.propertyId!;
      // A gauge's limit has no period: its level is checked against the day it was sampled.
      const granularity = limit.period === 'NONE' ? 'DAY' : limit.period;
      const used = totals.get(usageKey(propertyKey, granularity)) ?? 0;
      if (used < limit.limitValue) continue;
      const start = periodStart(granularity, at);
      const first = await this.repo.insertNotice({
        tenantId: input.tenantId,
        propertyKey,
        metricCode: input.metric,
        periodStart: start,
        enforcement: limit.enforcement,
        limitValue: limit.limitValue,
        used,
      });
      if (!first) continue;
      await this.events.publish(LimitReached, {
        tenantId: input.tenantId,
        propertyId: scope === 'PROPERTY' ? input.propertyId : null,
        source: 'license',
        aggregate: { type: 'license_limit', id: `${input.metric}:${propertyKey}` },
        payload: {
          metric_code: input.metric,
          enforcement: limit.enforcement,
          period_start: limit.period === 'NONE' ? null : start.toISOString(),
          limit_value: limit.limitValue,
          used,
        },
      });
    }
  }
}
