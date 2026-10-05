import { z } from 'zod';
import { defineEvent } from './registry';

/**
 * Guest & Stay events (Spec §6). Downstream contexts (guest access grants in Phase 4, housekeeping in Phase 7) react
 * to these internal-id events rather than to vendor references. Payloads carry ids only, never names or contacts.
 */

const status = z.enum(['EXPECTED', 'IN_HOUSE', 'CHECKED_OUT', 'CANCELLED', 'NO_SHOW']);

export const StayCreated = defineEvent({
  type: 'guest.stay.created',
  version: 1,
  description: 'A stay became known from the PMS (future reservation or walk-in check-in).',
  payload: z.object({
    stay_id: z.uuid(),
    primary_guest_id: z.uuid(),
    status,
  }),
});

export const StayStatusChanged = defineEvent({
  type: 'guest.stay.status_changed',
  version: 1,
  delivery: 'critical-operational',
  description:
    'A stay changed status because of a PMS fact (check-in, check-out, cancellation, reinstatement). CHECKED_OUT revokes every stay-bound access.',
  payload: z.object({
    stay_id: z.uuid(),
    primary_guest_id: z.uuid(),
    from: status,
    to: status,
    at: z.iso.datetime({ offset: true }),
    room_id: z.uuid().nullable(),
  }),
});

export const GuestStayRoomChanged = defineEvent({
  type: 'guest.stay.room_changed',
  version: 1,
  delivery: 'critical-operational',
  description:
    'The room of a stay changed (assignment, move, upgrade); the old assignment is kept as history.',
  payload: z.object({
    stay_id: z.uuid(),
    from_room_id: z.uuid().nullable(),
    to_room_id: z.uuid().nullable(),
    reason: z.enum([
      'PRE_ASSIGNMENT',
      'INITIAL',
      'ROOM_MOVE',
      'UPGRADE',
      'MAINTENANCE',
      'CHECK_OUT',
    ]),
    at: z.iso.datetime({ offset: true }),
  }),
});

/**
 * A POS check was tied to a stay (BUILD_PLAN 13.5): the stay's spend facts grew. Internal ids and amounts only — the
 * POS's check and reservation ids stay in the integration context.
 */
export const StayChargeRecorded = defineEvent({
  type: 'guest.stay_charge.recorded',
  version: 1,
  delivery: 'normal',
  description:
    'A closed POS check was recorded against a stay (outlet category, total, settlement).',
  payload: z.object({
    charge_id: z.uuid(),
    stay_id: z.uuid(),
    room_id: z.uuid().nullable(),
    outlet_category: z.enum([
      'RESTAURANT',
      'BAR',
      'ROOM_SERVICE',
      'SPA',
      'MINIBAR',
      'SHOP',
      'OTHER',
    ]),
    settlement: z.enum(['ROOM_CHARGE', 'CASH', 'CARD', 'OTHER']),
    total_minor: z.number().int().min(0),
    currency: z.string().regex(/^[A-Z]{3}$/),
    covers: z.number().int().min(0).nullable(),
    closed_at: z.iso.datetime({ offset: true }),
  }),
});

export const GuestMerged = defineEvent({
  type: 'guest.guest.merged',
  version: 1,
  description:
    'A duplicate guest profile was merged into a surviving one; references to the merged id should follow the survivor.',
  payload: z.object({ merged_guest_id: z.uuid(), surviving_guest_id: z.uuid() }),
});

export const GuestAnonymized = defineEvent({
  type: 'guest.guest.anonymized',
  version: 1,
  description:
    'A guest was anonymized on request (Spec §69): identifying data is gone; operational history stays. Contexts holding copies of guest data must drop them.',
  payload: z.object({ guest_id: z.uuid() }),
});

const grantScopes = z.array(z.string().regex(/^[A-Z_]+$/)).max(20);

export const GuestGrantIssued = defineEvent({
  type: 'guest.grant.issued',
  version: 1,
  delivery: 'critical-operational',
  description:
    'A verified guest received access for a stay (activation, room QR, staff-assisted or pre-arrival). Spec §19.3.',
  payload: z.object({
    grant_id: z.uuid(),
    guest_id: z.uuid(),
    stay_id: z.uuid().nullable(),
    scopes: grantScopes,
    granted_via: z.enum(['ACTIVATION', 'QR', 'STAFF', 'PRE_ARRIVAL']),
    valid_until: z.iso.datetime({ offset: true }),
  }),
});

export const GuestGrantChanged = defineEvent({
  type: 'guest.grant.changed',
  version: 1,
  delivery: 'critical-operational',
  description:
    'A grant followed its stay: widened on arrival, narrowed to the post-stay scopes at check-out (Spec §21).',
  payload: z.object({
    grant_id: z.uuid(),
    guest_id: z.uuid(),
    stay_id: z.uuid().nullable(),
    change: z.enum(['WIDENED', 'NARROWED']),
    scopes: grantScopes,
    valid_until: z.iso.datetime({ offset: true }),
    reason: z.string().max(32),
  }),
});

export const GuestGrantRevoked = defineEvent({
  type: 'guest.grant.revoked',
  version: 1,
  delivery: 'critical-operational',
  description:
    'A grant and every guest session on it ended (check-out without post-stay scopes, cancellation, staff, anonymization).',
  payload: z.object({
    grant_id: z.uuid(),
    guest_id: z.uuid(),
    stay_id: z.uuid().nullable(),
    reason: z.string().max(32),
    sessions_revoked: z.number().int().min(0),
  }),
});
