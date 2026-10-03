/** The ONLY surface other bounded contexts may import from this package (ADR-0001). */
import type { GuestPrincipal, GuestScope } from './tokens';

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

/** Who issues or changes a grant (audit actor). */
export interface GrantActor {
  readonly type: 'USER' | 'GUEST' | 'AI_AGENT' | 'SYSTEM' | 'INTEGRATION' | 'SUPPORT';
  readonly id: string | null;
}

export interface IssueGrantInput {
  readonly tenantId: string;
  readonly propertyId: string;
  readonly stayId: string;
  readonly guestId: string;
  /** How the guest was verified; a stay not yet in house always yields a PRE_ARRIVAL grant. */
  readonly via: 'ACTIVATION' | 'QR' | 'STAFF';
  readonly actor: GrantActor;
  /** Staff-assisted verification records why (audited). */
  readonly reason?: string;
  readonly now?: Date;
}

export interface GrantSummary {
  readonly id: string;
  readonly propertyId: string;
  readonly guestId: string;
  readonly stayId: string | null;
  readonly partyRole: 'PRIMARY' | 'ACCOMPANYING';
  readonly scopes: readonly string[];
  /** Scopes usable right now (none once revoked or expired). */
  readonly effectiveScopes: readonly GuestScope[];
  readonly grantedVia: 'ACTIVATION' | 'QR' | 'STAFF' | 'PRE_ARRIVAL';
  readonly validFrom: string;
  readonly validUntil: string;
  readonly revokedAt: string | null;
  readonly revokeReason: string | null;
}

export interface OpenedGuestSession {
  /** Opaque session token, returned once. */
  readonly token: string;
  readonly sessionId: string;
  readonly expiresAt: string;
}

/** A current member of a stay's party, for verification flows (names and PMS contact numbers are CONFIDENTIAL). */
export interface StayPartyMember {
  readonly guestId: string;
  readonly role: 'PRIMARY' | 'ACCOMPANYING';
  readonly givenName: string;
  readonly familyName: string | null;
  readonly primaryLocale: string | null;
  /** Phone numbers the PMS gave for this guest, as normalized by the guest context. */
  readonly phones: readonly string[];
}

export interface GuestPublicApi {
  getStay(tenantId: string, stayId: string): Promise<StaySummary | null>;
  /** In-house stays assigned to a room right now. */
  inHouseStaysInRoom(
    tenantId: string,
    propertyId: string,
    roomId: string,
  ): Promise<readonly StaySummary[]>;

  /** Current party of a stay (primary first); empty for an unknown stay. */
  stayParty(tenantId: string, stayId: string): Promise<readonly StayPartyMember[]>;

  // ---- guest access (Spec §19.3, §21) ----
  /** Grants access to a verified guest of an active stay (reuses a live grant of the same guest and stay). */
  issueGrant(input: IssueGrantInput): Promise<GrantSummary>;
  openGuestSession(
    tenantId: string,
    grantId: string,
    deviceInfo: string | null,
  ): Promise<OpenedGuestSession>;
  /** Null for an unknown, revoked or expired session, or a grant without usable scopes. */
  authenticateGuestSession(token: string): Promise<GuestPrincipal | null>;
  revokeGuestSession(tenantId: string, sessionId: string, reason: string): Promise<boolean>;
  /** The guest's live grant at a property (verified channel identities are routed with it). */
  liveGrantAtProperty(
    tenantId: string,
    propertyId: string,
    guestId: string,
  ): Promise<GrantSummary | null>;
}

export { GUEST_API } from './tokens';
export type { GuestPrincipal, GuestScope } from './tokens';

export { GUEST_MANIFEST } from '../manifest';
export {
  CurrentGuest,
  GUEST_SESSION_HEADER,
  GuestSessionGuard,
  RequireGuestScope,
} from './guest-session.guard';
