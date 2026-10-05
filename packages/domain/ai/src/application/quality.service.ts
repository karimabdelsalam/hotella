import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ActionGate } from '@hotella/platform-auth';
import { type PropertyScope, TransactionRunner } from '@hotella/platform-database';
import { InjectLogger, type Logger, RequestContext } from '@hotella/platform-observability';
import { qualityMetrics } from '../domain/quality';
import { InsightRepositories } from '../infrastructure/insight-repositories';
import { QualityRepositories } from '../infrastructure/quality-repositories';

const DAY = 86_400_000;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export const qualityQuerySchema = z
  .object({ from: z.iso.date(), to: z.iso.date() })
  .refine((q) => q.from <= q.to, 'from must not be after to')
  .refine((q) => Date.parse(q.to) - Date.parse(q.from) <= 92 * DAY, 'at most 92 days');

export const qualityRecomputeSchema = z.object({ day: z.iso.date() });

/**
 * AI quality and cost per agent, version and day (Spec §41, BUILD_PLAN 12.6). Days are UTC days; a day is recomputed
 * whole (yesterday and today, every six hours), so late feedback and cancellations land on the day the AI acted.
 */
@Injectable()
export class QualityService {
  constructor(
    private readonly repo: QualityRepositories,
    private readonly properties: InsightRepositories,
    private readonly tx: TransactionRunner,
    private readonly gate: ActionGate,
    private readonly ctx: RequestContext,
    @InjectLogger() private readonly logger: Logger,
  ) {}

  /** Recomputes one UTC day of a property. */
  async compute(scope: PropertyScope, day: string): Promise<number> {
    const from = new Date(`${day}T00:00:00Z`);
    const metrics = qualityMetrics(
      await this.tx.read(() => this.repo.inputs(scope, from, new Date(from.getTime() + DAY))),
    );
    await this.tx.run(() => this.repo.replaceDay(scope, day, metrics));
    return metrics.length;
  }

  /** The scheduled job: yesterday and today of every property the AI context has seen. */
  async sweep(now = new Date()): Promise<void> {
    const days = [isoDay(new Date(now.getTime() - DAY)), isoDay(now)];
    for (const scope of await this.tx.read(() => this.properties.activeProperties()))
      try {
        await this.ctx.run(
          { tenant_id: scope.tenantId, property_id: scope.propertyId },
          async () => {
            for (const day of days) await this.compute(scope, day);
          },
        );
      } catch (err) {
        this.logger.warn(
          { err, tenant_id: scope.tenantId, property_id: scope.propertyId },
          'quality computation failed',
        );
      }
  }

  list(scope: PropertyScope, query: z.infer<typeof qualityQuerySchema>) {
    return this.gate.execute(
      {
        action: 'ai.quality.read',
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        entitlement: 'AI_INTELLIGENCE',
      },
      () =>
        this.tx.read(async () =>
          (await this.repo.list(scope, query.from, query.to)).map((r) => ({
            day: r.day,
            agentCode: r.agentCode,
            agentVersionId: r.agentVersionId,
            metric: r.metric,
            value: r.value,
            samples: r.samples,
          })),
        ),
    );
  }

  /** Recomputes a day now (people with `ai.quality.read`; the numbers come from code either way). */
  recompute(scope: PropertyScope, { day }: z.infer<typeof qualityRecomputeSchema>) {
    return this.gate.execute(
      {
        action: 'ai.quality.read',
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        entitlement: 'AI_INTELLIGENCE',
      },
      async () => ({ day, metrics: await this.compute(scope, day) }),
    );
  }
}
