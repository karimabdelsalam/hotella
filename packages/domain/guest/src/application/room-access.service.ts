import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { localDateTimeToUtc } from '@hotella/contracts-connectors';
import {
  ACCESS_API,
  type AccessKind,
  type AccessPublicApi,
} from '@hotella/domain-integrations/public';
import { ORGANIZATION_API, type OrganizationPublicApi } from '@hotella/domain-organization/public';
import { ActionGate, ActorStore } from '@hotella/platform-auth';
import { isUuid, type PropertyScope, TransactionRunner } from '@hotella/platform-database';
import { AppError } from '@hotella/platform-i18n';
import { GUEST_API, type GuestPublicApi } from '../public';

export const issueRoomAccessSchema = z.object({ kind: z.enum(['KEY', 'MOBILE_KEY', 'WIFI']) });

/** Keys and Wi-Fi last until the departure day's latest check-out (property time), unless revoked first. */
const VALID_UNTIL_LOCAL = { hour: 14, minute: 0 };

const permissionFor = (kind: AccessKind) =>
  kind === 'WIFI' ? 'access.wifi.issue' : 'access.key.issue';

/**
 * Room keys and Wi-Fi for an in-house stay (BUILD_PLAN 13.3, rule 19): the stay's owner checks the stay and the
 * person, the Integration Platform asks the lock or Wi-Fi system. Check-out and room moves revoke on their own.
 */
@Injectable()
export class RoomAccessService {
  constructor(
    @Inject(GUEST_API) private readonly stays: GuestPublicApi,
    private readonly gate: ActionGate,
    private readonly actors: ActorStore,
    private readonly tx: TransactionRunner,
    @Inject(ACCESS_API) private readonly access: AccessPublicApi,
    @Inject(ORGANIZATION_API) private readonly org: OrganizationPublicApi,
  ) {}

  list(scope: PropertyScope, stayId: string) {
    return this.gate.execute(
      { action: 'access.read', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () =>
        this.tx.read(async () => {
          await this.stay(scope, stayId);
          const kinds: AccessKind[] = ['KEY', 'MOBILE_KEY', 'WIFI'];
          const available = await Promise.all(
            kinds.map((k) => this.access.available(scope.tenantId, scope.propertyId, k)),
          );
          return {
            available: kinds.filter((_, i) => available[i]),
            grants: await this.access.listForStay(scope.tenantId, stayId),
          };
        }),
    );
  }

  issue(scope: PropertyScope, stayId: string, kind: AccessKind) {
    return this.gate.execute(
      { action: permissionFor(kind), tenantId: scope.tenantId, propertyId: scope.propertyId },
      () =>
        this.tx.run(async () => {
          const stay = await this.stay(scope, stayId);
          // Rule 19: access only for a stay the PMS has checked in.
          if (stay.status !== 'IN_HOUSE') throw AppError.conflict('guest.access.stay_not_in_house');
          if (!stay.currentRoomId) throw AppError.conflict('guest.access.no_room');
          const room = await this.org.getRoom(scope.tenantId, scope.propertyId, stay.currentRoomId);
          if (!room) throw AppError.conflict('guest.access.no_room');
          const property = await this.org.getProperty(scope.tenantId, scope.propertyId);
          const [year, month, day] = stay.expectedDeparture.split('-').map(Number) as [
            number,
            number,
            number,
          ];
          const actor = this.actors.require();
          return this.access.issue({
            tenantId: scope.tenantId,
            propertyId: scope.propertyId,
            stayId: stay.id,
            kind,
            roomId: room.id,
            roomNumber: room.roomNumber,
            validUntil: localDateTimeToUtc(
              { year, month, day, ...VALID_UNTIL_LOCAL },
              property?.timezone ?? 'UTC',
            ),
            requestedBy: { type: actor.type, id: actor.id },
          });
        }),
    );
  }

  /** Staff revoke one grant (a lost card, a guest who leaves early); the gate checks the kind's permission. */
  async revoke(scope: PropertyScope, stayId: string, grantId: string) {
    const grant = await this.tx.read(async () => {
      await this.stay(scope, stayId);
      return (await this.access.listForStay(scope.tenantId, stayId)).find((g) => g.id === grantId);
    });
    if (!grant) throw AppError.notFound('guest.access.grant_not_found');
    return this.gate.execute(
      { action: permissionFor(grant.kind), tenantId: scope.tenantId, propertyId: scope.propertyId },
      () =>
        this.tx.run(async () => {
          const actor = this.actors.require();
          const revoked = await this.access.revoke(scope.tenantId, grant.id, 'STAFF', {
            type: actor.type,
            id: actor.id,
          });
          if (!revoked) throw AppError.notFound('guest.access.grant_not_found');
          return revoked;
        }),
    );
  }

  private async stay(scope: PropertyScope, stayId: string) {
    const stay = isUuid(stayId) ? await this.stays.getStay(scope.tenantId, stayId) : null;
    if (!stay || stay.propertyId !== scope.propertyId)
      throw new AppError('guest.stay.not_found', HttpStatus.NOT_FOUND);
    return stay;
  }
}
