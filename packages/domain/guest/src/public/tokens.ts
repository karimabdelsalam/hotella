export type GuestScope =
  | 'SERVICE_REQUEST'
  | 'CHAT'
  | 'DINING'
  | 'CONCIERGE'
  | 'ROOM_CONTROL'
  | 'VIEW_BILL'
  | 'PAYMENT'
  | 'LOST_FOUND'
  | 'FEEDBACK'
  | 'INVOICE'
  | 'SUPPORT';

/** An authenticated guest request (resolved per request from the session token). */
export interface GuestPrincipal {
  readonly tenantId: string;
  readonly propertyId: string;
  readonly guestId: string;
  readonly stayId: string | null;
  readonly grantId: string;
  readonly sessionId: string;
  readonly scopes: readonly GuestScope[];
}

/** Registered symbol: stays identical even if a bundler or test runner loads this entry twice. */
export const GUEST_API = Symbol.for('hotella.domain.guest.api');
