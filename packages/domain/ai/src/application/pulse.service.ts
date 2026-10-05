import { Inject, Injectable } from '@nestjs/common';
import { GUEST_API, type GuestPublicApi } from '@hotella/domain-guest/public';
import { ORGANIZATION_API, type OrganizationPublicApi } from '@hotella/domain-organization/public';
import { type PropertyScope, TransactionRunner } from '@hotella/platform-database';
import { addDays, isoDate, wallClock } from '@hotella/platform-time';
import { InsightRepositories } from '../infrastructure/insight-repositories';

const DAY = 86_400_000;
const total = (counts: Record<string, number>) => Object.values(counts).reduce((a, b) => a + b, 0);

export interface Pulse {
  readonly at: string;
  readonly openWork: { readonly total: number; readonly byDepartment: Record<string, number> };
  readonly slaBreaches24h: {
    readonly total: number;
    readonly byDepartment: Record<string, number>;
  };
  readonly openComplaints: { readonly total: number; readonly bySeverity: Record<string, number> };
  readonly roomsRestricted: { readonly total: number; readonly byKind: Record<string, number> };
  readonly arrivalsTomorrow: { readonly day: string; readonly count: number };
  readonly liveInsights: { readonly total: number; readonly bySeverity: Record<string, number> };
}

/**
 * The property's pulse (BUILD_PLAN 12.5): live counts the Manager assistant and the comparison report read — from the
 * AI context's own projection (twin, signals, insights) and the guest context's expected arrivals. Deterministic: no
 * model is involved, and the same data gives the same numbers (rule 11).
 */
@Injectable()
export class PulseService {
  constructor(
    private readonly repo: InsightRepositories,
    private readonly tx: TransactionRunner,
    @Inject(GUEST_API) private readonly guests: GuestPublicApi,
    @Inject(ORGANIZATION_API) private readonly org: OrganizationPublicApi,
  ) {}

  async pulse(scope: PropertyScope, now = new Date()): Promise<Pulse> {
    const property = await this.org.getProperty(scope.tenantId, scope.propertyId);
    const clock = wallClock(now, property?.timezone ?? 'UTC');
    const tomorrow = isoDate(addDays(clock, 1));
    const counts = await this.tx.read(async () => ({
      work: await this.repo.openWorkByDepartment(scope),
      breaches: await this.repo.signalsBy(
        scope,
        'SLA_BREACHED',
        new Date(now.getTime() - DAY),
        'department',
      ),
      complaints: await this.repo.countBy(scope, 'COMPLAINT', { state: 'OPEN' }, 'severity'),
      rooms: await this.repo.countBy(
        scope,
        'LOCATION',
        { attributeSet: 'restriction' },
        'restriction',
      ),
      insights: (await this.repo.live(scope)).reduce<Record<string, number>>(
        (acc, i) => ({ ...acc, [i.severity]: (acc[i.severity] ?? 0) + 1 }),
        {},
      ),
    }));
    const arrivals = await this.guests.expectedArrivals(scope.tenantId, scope.propertyId, tomorrow);
    return {
      at: now.toISOString(),
      openWork: { total: total(counts.work), byDepartment: counts.work },
      slaBreaches24h: { total: total(counts.breaches), byDepartment: counts.breaches },
      openComplaints: { total: total(counts.complaints), bySeverity: counts.complaints },
      roomsRestricted: { total: total(counts.rooms), byKind: counts.rooms },
      arrivalsTomorrow: { day: tomorrow, count: arrivals.length },
      liveInsights: { total: total(counts.insights), bySeverity: counts.insights },
    };
  }
}
