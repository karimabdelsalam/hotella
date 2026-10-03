/** The ONLY surface other bounded contexts may import from this package (ADR-0001). */

export type StayStatus = 'EXPECTED' | 'IN_HOUSE' | 'CHECKED_OUT' | 'CANCELLED' | 'NO_SHOW';

export interface StaySummary {
  readonly id: string;
  readonly propertyId: string;
  readonly status: StayStatus;
  readonly primaryGuestId: string;
  readonly expectedArrival: string;
  readonly expectedDeparture: string;
  readonly currentRoomId: string | null;
  /** Guests currently in the party (primary first). */
  readonly partyGuestIds: readonly string[];
}

export interface GuestPublicApi {
  getStay(tenantId: string, stayId: string): Promise<StaySummary | null>;
  /** In-house stays assigned to a room right now. */
  inHouseStaysInRoom(
    tenantId: string,
    propertyId: string,
    roomId: string,
  ): Promise<readonly StaySummary[]>;
}

/** Registered symbol: stays identical even if a bundler or test runner loads this entry twice. */
export const GUEST_API = Symbol.for('hotella.domain.guest.api');

export { GUEST_MANIFEST } from '../manifest';
