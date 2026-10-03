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
