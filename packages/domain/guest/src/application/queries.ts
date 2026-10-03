import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ORGANIZATION_API, type OrganizationPublicApi } from '@hotella/domain-organization/public';
import { ActionGate } from '@hotella/platform-auth';
import { isUuid, type PropertyScope, TransactionRunner } from '@hotella/platform-database';
import { AppError } from '@hotella/platform-i18n';
import { maskIdentifier } from '../domain/identity';
import { GuestRepositories } from '../infrastructure/repositories';
import type { GuestRow, StayRow } from '../infrastructure/schema';

export const listStaysQuerySchema = z.object({
  status: z.enum(['EXPECTED', 'IN_HOUSE', 'CHECKED_OUT', 'CANCELLED', 'NO_SHOW']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListStaysQuery = z.infer<typeof listStaysQuerySchema>;

export const searchGuestsQuerySchema = z.object({
  q: z.string().trim().min(2).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type SearchGuestsQuery = z.infer<typeof searchGuestsQuerySchema>;

function guestName(g: GuestRow) {
  return {
    id: g.id,
    givenName: g.givenName,
    familyName: g.familyName,
    title: g.title,
    primaryLocale: g.primaryLocale,
    vipCode: g.vipCode,
    status: g.status,
  };
}

function staySummary(s: StayRow) {
  return {
    id: s.id,
    propertyId: s.propertyId,
    status: s.status,
    primaryGuestId: s.primaryGuestId,
    expectedArrival: s.expectedArrival,
    expectedDeparture: s.expectedDeparture,
    actualCheckinAt: s.actualCheckinAt,
    actualCheckoutAt: s.actualCheckoutAt,
    eta: s.eta,
    adults: s.adults,
    children: s.children,
  };
}

/** Staff read side of stays (Spec §6). There is deliberately no write side: the PMS owns stay state. */
@Injectable()
export class StayQueryService {
  constructor(
    private readonly repo: GuestRepositories,
    private readonly gate: ActionGate,
    private readonly tx: TransactionRunner,
    @Inject(ORGANIZATION_API) private readonly org: OrganizationPublicApi,
  ) {}

  list(scope: PropertyScope, query: ListStaysQuery) {
    return this.read(scope, 'stay.read', async () => {
      const rows = await this.repo.listStays(scope, query);
      const guests = new Map(
        (await this.repo.guestsByIds(scope, [...new Set(rows.map((s) => s.primaryGuestId))])).map(
          (g) => [g.id, g],
        ),
      );
      return rows.map((s) => ({
        ...staySummary(s),
        primaryGuest: guests.has(s.primaryGuestId)
          ? guestName(guests.get(s.primaryGuestId)!)
          : null,
      }));
    });
  }

  /** A stay with its party, current room, full room-assignment history and source references. */
  get(scope: PropertyScope, stayId: string) {
    return this.read(scope, 'stay.read', async () => {
      const stay = await this.load(scope, stayId);
      // Sequential: one transaction = one connection, which runs one query at a time.
      const party = await this.repo.party(scope, stay.id);
      const assignments = await this.repo.assignments(scope, stay.id);
      const references = await this.repo.reservationReferences(scope, stay.id);
      const guests = new Map(
        (
          await this.repo.guestsByIds(
            scope,
            party.map((m) => m.guestId),
          )
        ).map((g) => [g.id, g]),
      );
      const roomNumbers = await this.roomNumbers(
        scope,
        assignments.map((a) => a.roomId),
      );
      const history = assignments.map((a) => ({
        roomId: a.roomId,
        roomNumber: roomNumbers.get(a.roomId) ?? null,
        assignedAt: a.assignedAt,
        unassignedAt: a.unassignedAt,
        reason: a.reason,
      }));
      return {
        ...staySummary(stay),
        rateCode: stay.rateCode,
        marketCode: stay.marketCode,
        currentRoom: history.find((a) => a.unassignedAt === null) ?? null,
        party: party.map((m) => ({
          guest: guests.has(m.guestId) ? guestName(guests.get(m.guestId)!) : null,
          role: m.role,
          joinedAt: m.joinedAt,
          leftAt: m.leftAt,
        })),
        roomAssignments: history,
        references: references.map((r) => ({
          integrationInstanceId: r.integrationInstanceId,
          confirmationNumber: r.confirmationNumber,
          lastEventType: r.lastEventType,
          lastEventAt: r.lastEventAt,
        })),
      };
    });
  }

  /** The in-house stay in a room right now (several only when the PMS shares a room between reservations). */
  currentStayForRoom(scope: PropertyScope, roomId: string) {
    return this.read(scope, 'stay.read', async () => {
      const room = isUuid(roomId)
        ? await this.org.getRoom(scope.tenantId, scope.propertyId, roomId)
        : null;
      if (!room) throw AppError.notFound('org.room.not_found');
      const stays = await this.repo.inHouseStaysInRoom(scope, room.id);
      if (stays.length === 0) throw AppError.notFound('guest.stay.not_in_room');
      const [current, ...others] = stays;
      const primary = await this.repo.guest(scope, current!.primaryGuestId);
      return {
        room: { id: room.id, roomNumber: room.roomNumber },
        ...staySummary(current!),
        primaryGuest: primary ? guestName(primary) : null,
        sharedWithStayIds: others.map((s) => s.id),
      };
    });
  }

  private async load(scope: PropertyScope, id: string): Promise<StayRow> {
    const stay = isUuid(id) ? await this.repo.stay(scope, id) : undefined;
    if (!stay || stay.propertyId !== scope.propertyId)
      throw AppError.notFound('guest.stay.not_found');
    return stay;
  }

  private async roomNumbers(scope: PropertyScope, ids: readonly string[]) {
    const out = new Map<string, string>();
    for (const id of new Set(ids)) {
      const room = await this.org.getRoom(scope.tenantId, scope.propertyId, id);
      if (room) out.set(id, room.roomNumber);
    }
    return out;
  }

  private read<T>(scope: PropertyScope, action: string, fn: () => Promise<T>): Promise<T> {
    return this.gate.execute(
      { action, tenantId: scope.tenantId, propertyId: scope.propertyId },
      () => this.tx.read(fn),
    );
  }
}

/** Staff read side of guests, limited to guests who stayed at the property in scope. */
@Injectable()
export class GuestQueryService {
  constructor(
    private readonly repo: GuestRepositories,
    private readonly gate: ActionGate,
    private readonly tx: TransactionRunner,
  ) {}

  search(scope: PropertyScope, query: SearchGuestsQuery) {
    return this.gate.execute(
      { action: 'guest.read', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () =>
        this.tx.read(async () =>
          (await this.repo.searchGuestsAtProperty(scope, query)).map(guestName),
        ),
    );
  }

  get(scope: PropertyScope, guestId: string) {
    return this.gate.execute(
      { action: 'guest.read', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () =>
        this.tx.read(async () => {
          const guest = isUuid(guestId) ? await this.repo.guest(scope, guestId) : undefined;
          const stays = guest ? await this.repo.staysOfGuest(scope, guest.id) : [];
          // A guest is visible at a property only through a stay there (no tenant-wide guest browsing).
          if (!guest || stays.length === 0) throw AppError.notFound('guest.guest.not_found');
          const identifiers = await this.repo.identifiers(scope, guest.id);
          return {
            ...guestName(guest),
            mergedIntoGuestId: guest.mergedIntoGuestId,
            // Contact values are SENSITIVE: staff see them masked; full values are used by the channels (Phase 4).
            identifiers: identifiers.map((i) => ({
              kind: i.kind,
              value: maskIdentifier(i.kind, i.valueNormalized),
              verified: i.verifiedAt !== null,
            })),
            stays: stays.map(staySummary),
          };
        }),
    );
  }
}
