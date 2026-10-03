import { Inject, Injectable } from '@nestjs/common';
import { GUEST_API, type GuestPrincipal, type GuestPublicApi } from '@hotella/domain-guest/public';
import { ORGANIZATION_API, type OrganizationPublicApi } from '@hotella/domain-organization/public';

/** What an activated guest sees about themself (Spec §19.3: never asked again for room or name). */
@Injectable()
export class GuestPortalService {
  constructor(
    @Inject(GUEST_API) private readonly guests: GuestPublicApi,
    @Inject(ORGANIZATION_API) private readonly org: OrganizationPublicApi,
  ) {}

  async me(p: GuestPrincipal, locale: string) {
    const [stay, property] = await Promise.all([
      p.stayId ? this.guests.getStay(p.tenantId, p.stayId) : Promise.resolve(null),
      this.org.getProperty(p.tenantId, p.propertyId),
    ]);
    const member = p.stayId
      ? (await this.guests.stayParty(p.tenantId, p.stayId)).find((m) => m.guestId === p.guestId)
      : undefined;
    const room =
      stay?.currentRoomId && stay.status === 'IN_HOUSE'
        ? await this.org.getRoom(p.tenantId, p.propertyId, stay.currentRoomId)
        : null;
    return {
      guest: { givenName: member?.givenName ?? null, locale: member?.primaryLocale ?? null },
      stay: stay
        ? {
            id: stay.id,
            status: stay.status,
            expectedArrival: stay.expectedArrival,
            expectedDeparture: stay.expectedDeparture,
            room: room ? { number: room.roomNumber } : null,
          }
        : null,
      scopes: p.scopes,
      property: property
        ? { id: property.id, name: property.name, timezone: property.timezone }
        : null,
      branding: await this.org.resolveBranding(p.propertyId, 'GUEST_WEB', locale),
    };
  }
}
