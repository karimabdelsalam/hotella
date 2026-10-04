import { Inject, Injectable, Optional } from '@nestjs/common';
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
      () =>
        this.tx.read(async () => {
          const property = await this.org.getProperty(scope.tenantId, scope.propertyId);
          if (!property) throw AppError.notFound('org.property.not_found');
          const at = query.day === 'tomorrow' ? new Date(now.getTime() + 86_400_000) : now;
          const day = localDay(at, property.timezone);
          const arrivals = await this.guests.expectedArrivals(
            scope.tenantId,
            scope.propertyId,
            day,
          );
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
        }),
    );
  }
}
