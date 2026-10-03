/** The ONLY surface other bounded contexts may import from this package (ADR-0001). */

export type HousekeepingState =
  'DIRTY' | 'CLEANING' | 'CLEAN' | 'INSPECTING' | 'INSPECTED' | 'PICKUP';
export type RoomSignal = 'DND' | 'MAKE_UP_ROOM' | 'PRIVACY' | 'SERVICE_REQUESTED';

export interface RoomStateSummary {
  readonly roomId: string;
  readonly occupancy: 'VACANT' | 'OCCUPIED';
  readonly housekeeping: HousekeepingState;
  readonly frontOffice: string | null;
  readonly lastCleanedAt: string | null;
  readonly lastInspectedAt: string | null;
  readonly signals: readonly RoomSignal[];
}

/** What other contexts may ask of housekeeping (the guest web, the concierge, arrival readiness). */
export interface HousekeepingPublicApi {
  /** Null when the platform has not seen the room yet. */
  roomState(tenantId: string, propertyId: string, roomId: string): Promise<RoomStateSummary | null>;
  /**
   * A guest's own room signal (DND / make up room) through the guest web or the concierge; the caller has checked the
   * guest's stay and room. Joins the caller's transaction.
   */
  setGuestRoomSignal(input: {
    readonly tenantId: string;
    readonly propertyId: string;
    readonly roomId: string;
    readonly signal: 'DND' | 'MAKE_UP_ROOM';
    readonly active: boolean;
    readonly actor: { readonly type: 'GUEST' | 'AI_AGENT'; readonly id: string | null };
  }): Promise<{ readonly active: readonly RoomSignal[] }>;
}

/** Registered symbol: stays identical even if a bundler or test runner loads this entry twice. */
export const HOUSEKEEPING_API = Symbol.for('hotella.domain.housekeeping.api');

export { HOUSEKEEPING_MANIFEST } from '../manifest';
