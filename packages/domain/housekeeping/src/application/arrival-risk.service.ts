import { Inject, Injectable, Optional } from '@nestjs/common';
import type { InsightDetector } from '@hotella/domain-ai/public';
import { z } from 'zod';
import { ENGINEERING_API, type EngineeringPublicApi } from '@hotella/domain-engineering/public';
import { GUEST_API, type GuestPublicApi } from '@hotella/domain-guest/public';
import { INSPECTION_API, type InspectionPublicApi } from '@hotella/domain-inspection/public';
import { OPERATIONS_API, type OperationsPublicApi } from '@hotella/domain-operations/public';
import { ORGANIZATION_API, type OrganizationPublicApi } from '@hotella/domain-organization/public';
import { ActionGate } from '@hotella/platform-auth';
import { type PropertyScope, TransactionRunner } from '@hotella/platform-database';
import { AppError } from '@hotella/platform-i18n';
import { assessArrival } from '../domain/arrival-risk';
import { localDay } from '../domain/jobs';
import { HousekeepingRepositories } from '../infrastructure/repositories';

const ENGINEERING = 'ENG';
const URGENT = new Set(['HIGH', 'URGENT']);
/** Corrective work completed this recently on the room's equipment counts as a failure that may come back. */
const RECURRING_DAYS = 7;

export const arrivalRiskQuerySchema = z.object({
  day: z.enum(['today', 'tomorrow']).default('today'),
});

/**
 * Arrival risk for the front desk and the duty manager (BUILD_PLAN 8.B): each expected arrival of the day with its
 * room's state, open engineering work and restriction, the ETA and VIP flag, scored by the deterministic rules of
 * `assessArrival` and listed riskiest first, with the reasons. Reads only (`hk.arrivals.read`).
 */
@Injectable()
export class ArrivalRiskService {
  constructor(
    private readonly repo: HousekeepingRepositories,
    private readonly tx: TransactionRunner,
    private readonly gate: ActionGate,
    @Inject(ORGANIZATION_API) private readonly org: OrganizationPublicApi,
    @Inject(GUEST_API) private readonly guests: GuestPublicApi,
    @Inject(OPERATIONS_API) private readonly ops: OperationsPublicApi,
    @Optional() @Inject(ENGINEERING_API) private readonly engineering?: EngineeringPublicApi,
    @Optional() @Inject(INSPECTION_API) private readonly inspections?: InspectionPublicApi,
  ) {}

  list(scope: PropertyScope, query: z.infer<typeof arrivalRiskQuerySchema>, now = new Date()) {
    return this.gate.execute(
      { action: 'hk.arrivals.read', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () => this.assess(scope, query.day, now),
    );
  }

  /** The scored arrivals of a day (no permission check: callers gate, or are the insight engine's detector). */
  assess(scope: PropertyScope, dayOf: 'today' | 'tomorrow', now = new Date()) {
    return this.tx.read(async () => {
      const property = await this.org.getProperty(scope.tenantId, scope.propertyId);
      if (!property) throw AppError.notFound('org.property.not_found');
      const at = dayOf === 'tomorrow' ? new Date(now.getTime() + 86_400_000) : now;
      const day = localDay(at, property.timezone);
      const arrivals = await this.guests.expectedArrivals(scope.tenantId, scope.propertyId, day);
      const items = [];
      for (const stay of arrivals) {
        const roomId = stay.currentRoomId;
        const state = roomId ? await this.repo.state(scope, roomId) : undefined;
        const room = roomId
          ? await this.org.getRoom(scope.tenantId, scope.propertyId, roomId)
          : null;
        const work = roomId
          ? (
              await this.ops.openWorkItemsAtLocation(scope.tenantId, scope.propertyId, roomId)
            ).filter((w) => w.departmentCode === ENGINEERING)
          : [];
        const restriction =
          (roomId &&
            (await this.engineering?.activeRestriction(
              scope.tenantId,
              scope.propertyId,
              roomId,
            ))) ||
          null;
        const frontOfficeRestriction = state?.frontOffice ?? null;
        const inspection = roomId
          ? await this.inspections?.latestCompletedAt(scope.tenantId, scope.propertyId, roomId)
          : null;
        const inspectionFailedToday =
          inspection?.result === 'FAIL' &&
          !!inspection.completedAt &&
          localDay(new Date(inspection.completedAt), property.timezone) ===
            localDay(now, property.timezone);
        const repairs = roomId
          ? ((
              await this.engineering?.recentCorrectiveWork(
                scope.tenantId,
                scope.propertyId,
                roomId,
                RECURRING_DAYS,
              )
            )?.count ?? 0)
          : 0;
        const primary = (await this.guests.stayParty(scope.tenantId, stay.id)).find(
          (m) => m.guestId === stay.primaryGuestId,
        );
        const risk = assessArrival({
          roomAssigned: Boolean(roomId),
          housekeeping: state?.housekeeping ?? null,
          occupied: state?.occupancy === 'OCCUPIED',
          ready: state?.ready ?? false,
          restricted: Boolean(restriction) || Boolean(frontOfficeRestriction),
          openEngineeringWork: work.length,
          urgentEngineeringWork: work.some((w) => URGENT.has(w.priority)),
          inspectionFailedToday,
          recentRepairs: repairs,
          vip: stay.vip,
          minutesToEta: stay.eta
            ? Math.round((new Date(stay.eta).getTime() - now.getTime()) / 60_000)
            : null,
        });
        items.push({
          stayId: stay.id,
          guestName: primary
            ? [primary.givenName, primary.familyName].filter(Boolean).join(' ')
            : null,
          vip: stay.vip,
          eta: stay.eta,
          roomId,
          roomNumber: room?.roomNumber ?? null,
          housekeeping: state?.housekeeping ?? null,
          occupancy: state?.occupancy ?? null,
          ready: state?.ready ?? false,
          restriction: restriction?.kind ?? frontOfficeRestriction,
          openEngineeringWork: work.length,
          ...risk,
        });
      }
      items.sort(
        (a, b) =>
          b.score - a.score ||
          (a.eta ?? '9999').localeCompare(b.eta ?? '9999') ||
          (a.roomNumber ?? '').localeCompare(b.roomNumber ?? '', 'en', { numeric: true }),
      );
      return { day, arrivals: items };
    });
  }

  /**
   * The insight detector housekeeping contributes (BUILD_PLAN 12.4): tomorrow's arrivals the rules score HIGH, as one
   * insight per day with the stays as evidence and their rooms as what is affected. Deterministic, no names.
   */
  insightDetector(): InsightDetector {
    return {
      code: 'ARRIVAL_RISK_TOMORROW',
      detect: async ({ tenantId, propertyId, now }) => {
        const { day, arrivals } = await this.assess({ tenantId, propertyId }, 'tomorrow', now);
        const high = arrivals.filter((a) => a.level === 'HIGH');
        if (high.length === 0) return [];
        const meanScore = high.reduce((sum, a) => sum + a.score, 0) / high.length;
        return [
          {
            detector: 'ARRIVAL_RISK_TOMORROW',
            fingerprint: `day:${day}`,
            severity: high.length >= 3 || high.some((a) => a.vip) ? 'HIGH' : 'MEDIUM',
            confidence: Math.round(Math.min(1, meanScore / 100) * 1000) / 1000,
            reasonKey: 'ai.insight.reason.arrival_risk_tomorrow',
            reasonParams: { count: high.length, day },
            evidence: [
              {
                kind: 'HIGH_RISK_ARRIVALS',
                refType: 'STAY',
                refIds: high.map((a) => a.stayId).sort(),
                count: high.length,
                window: 'P1D',
              },
            ],
            affected: high.flatMap((a) => (a.roomId ? [{ type: 'LOCATION', id: a.roomId }] : [])),
            suggestedAction: { key: 'ai.insight.action.prepare_arrivals', params: {} },
          },
        ];
      },
    };
  }
}
