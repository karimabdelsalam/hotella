import type { StayStatus } from '../public';

/** Guest access scopes (Spec §21, BUILD_PLAN §8.1). */
export const GUEST_SCOPES = [
  'SERVICE_REQUEST',
  'CHAT',
  'DINING',
  'CONCIERGE',
  'ROOM_CONTROL',
  'VIEW_BILL',
  'PAYMENT',
  'LOST_FOUND',
  'FEEDBACK',
  'INVOICE',
  'SUPPORT',
] as const;
export type GuestScope = (typeof GUEST_SCOPES)[number];

export type PartyRole = 'PRIMARY' | 'ACCOMPANYING';

/** Property policy, from configuration (`guest.grant.*`). */
export interface GrantPolicy {
  readonly inStayScopes: readonly GuestScope[];
  readonly companionScopes: readonly GuestScope[];
  readonly preArrivalScopes: readonly GuestScope[];
  readonly postStayScopes: readonly GuestScope[];
  readonly postStayHours: number;
}

/** A guest session slides for this long, never past its grant. */
export const GUEST_SESSION_TTL_MS = 7 * 24 * 3_600_000;
/** Safety cap of a grant after the expected departure; the PMS check-out is what really ends a stay. */
export const GRANT_DEPARTURE_GRACE_MS = 7 * 24 * 3_600_000;

export type GrantDecision =
  | { readonly kind: 'GRANT'; readonly scopes: readonly GuestScope[]; readonly validUntil: Date }
  | { readonly kind: 'REFUSE'; readonly reason: 'STAY_NOT_ACTIVE' | 'NOT_IN_PARTY' };

/**
 * Scopes a guest receives when verified for a stay: before arrival only the pre-arrival scopes, in house the primary
 * guest's or the narrower companion scopes. Ended stays get nothing (post-stay access only survives from a grant that
 * existed at check-out).
 */
export function decideGrant(input: {
  readonly status: StayStatus;
  readonly partyRole: PartyRole | null;
  readonly expectedDeparture: string;
  readonly policy: GrantPolicy;
}): GrantDecision {
  if (input.status !== 'EXPECTED' && input.status !== 'IN_HOUSE')
    return { kind: 'REFUSE', reason: 'STAY_NOT_ACTIVE' };
  if (!input.partyRole) return { kind: 'REFUSE', reason: 'NOT_IN_PARTY' };
  const scopes =
    input.status === 'EXPECTED'
      ? input.policy.preArrivalScopes
      : inStayScopes(input.partyRole, input.policy);
  return {
    kind: 'GRANT',
    scopes: normalize(scopes),
    validUntil: new Date(
      Date.parse(`${input.expectedDeparture}T00:00:00Z`) + GRANT_DEPARTURE_GRACE_MS,
    ),
  };
}

export type GrantChange =
  | {
      readonly kind: 'WIDENED' | 'NARROWED';
      readonly scopes: readonly GuestScope[];
      readonly validUntil: Date;
      readonly reason: string;
    }
  | { readonly kind: 'REVOKED'; readonly reason: string };

/**
 * How an unrevoked grant follows its stay (deterministic; CLAUDE.md rule 11): arrival widens pre-arrival access to the
 * in-stay scopes; check-out keeps only the post-stay scopes for the configured window (or revokes when none remain);
 * cancellation and no-show revoke.
 */
export function grantOnStayStatus(
  grant: {
    readonly scopes: readonly string[];
    readonly validUntil: Date;
    readonly partyRole: PartyRole;
  },
  to: StayStatus,
  at: Date,
  policy: GrantPolicy,
): GrantChange | null {
  switch (to) {
    case 'IN_HOUSE': {
      const scopes = normalize(inStayScopes(grant.partyRole, policy));
      if (sameScopes(scopes, grant.scopes)) return null;
      return { kind: 'WIDENED', scopes, validUntil: grant.validUntil, reason: 'CHECKED_IN' };
    }
    case 'CHECKED_OUT': {
      const keep = normalize(
        grant.scopes.filter((s): s is GuestScope =>
          policy.postStayScopes.includes(s as GuestScope),
        ),
      );
      if (keep.length === 0 || policy.postStayHours <= 0)
        return { kind: 'REVOKED', reason: 'CHECKOUT' };
      const end = new Date(at.getTime() + policy.postStayHours * 3_600_000);
      return {
        kind: 'NARROWED',
        scopes: keep,
        validUntil: end < grant.validUntil ? end : grant.validUntil,
        reason: 'CHECKOUT',
      };
    }
    case 'CANCELLED':
    case 'NO_SHOW':
      return { kind: 'REVOKED', reason: to === 'CANCELLED' ? 'STAY_CANCELLED' : 'NO_SHOW' };
    default:
      return null;
  }
}

/** Scopes usable right now: none once revoked or outside the validity window. */
export function effectiveScopes(
  grant: {
    readonly scopes: readonly string[];
    readonly validFrom: Date;
    readonly validUntil: Date;
    readonly revokedAt: Date | null;
  },
  now: Date,
): readonly GuestScope[] {
  if (grant.revokedAt || now < grant.validFrom || now >= grant.validUntil) return [];
  return grant.scopes.filter((s): s is GuestScope =>
    (GUEST_SCOPES as readonly string[]).includes(s),
  );
}

/** Sliding session expiry, capped at the grant's end. */
export function sessionExpiry(now: Date, grantValidUntil: Date): Date {
  const slide = new Date(now.getTime() + GUEST_SESSION_TTL_MS);
  return slide < grantValidUntil ? slide : grantValidUntil;
}

function inStayScopes(role: PartyRole, policy: GrantPolicy): readonly GuestScope[] {
  return role === 'PRIMARY' ? policy.inStayScopes : policy.companionScopes;
}

function normalize(scopes: readonly GuestScope[]): GuestScope[] {
  return GUEST_SCOPES.filter((s) => scopes.includes(s));
}

function sameScopes(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((s) => b.includes(s));
}
