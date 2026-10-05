import { z } from 'zod';
import { defineEvent } from './registry';

/**
 * Restaurant events (Spec Appendix B.1). Ids and facts only — never a guest's name, notes or allergies.
 */
const status = z.enum(['CONFIRMED', 'SEATED', 'COMPLETED', 'CANCELLED', 'NO_SHOW']);

export const RestaurantReservationCreated = defineEvent({
  type: 'restaurant.reservation.created',
  version: 1,
  description: 'An à la carte reservation was made by a guest, by staff or by the concierge.',
  payload: z.object({
    reservation_id: z.uuid(),
    restaurant_id: z.uuid(),
    stay_id: z.uuid(),
    service_date: z.iso.date(),
    starts_at: z.string(),
    party_size: z.number().int().min(1),
    channel: z.enum(['GUEST_APP', 'STAFF', 'AI']),
    overridden: z.boolean(),
  }),
});

export const RestaurantReservationCancelled = defineEvent({
  type: 'restaurant.reservation.cancelled',
  version: 1,
  description: 'A reservation was cancelled (guest, staff, or the stay left the house).',
  payload: z.object({
    reservation_id: z.uuid(),
    restaurant_id: z.uuid(),
    stay_id: z.uuid(),
    service_date: z.iso.date(),
    by: z.enum(['GUEST', 'STAFF', 'STAY_ENDED']),
  }),
});

export const RestaurantReservationStatusChanged = defineEvent({
  type: 'restaurant.reservation.status_changed',
  version: 1,
  description: 'A reservation was seated, completed or marked as a no-show.',
  payload: z.object({
    reservation_id: z.uuid(),
    restaurant_id: z.uuid(),
    from: status,
    to: status,
  }),
});
