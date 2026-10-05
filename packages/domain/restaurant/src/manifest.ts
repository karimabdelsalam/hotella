import {
  RestaurantReservationCancelled,
  RestaurantReservationCreated,
  RestaurantReservationStatusChanged,
} from '@hotella/contracts-events';
import { defineManifest } from '@hotella/platform-manifest';

export const RESTAURANT_MANIFEST = defineManifest({
  code: 'restaurant',
  schema: 'restaurant',
  description:
    'Restaurant: à la carte restaurants with weekly sittings and seats, reservations by guests, staff and the concierge for the nights of a stay, one per restaurant per started block of 7 nights (configurable), seats counted atomically, cancelled when the PMS ends the stay.',
  permissions: [
    {
      code: 'restaurant.restaurant.read',
      descriptionKey: 'restaurant.permission.restaurant_read',
      risk: 'READ',
    },
    {
      code: 'restaurant.restaurant.manage',
      descriptionKey: 'restaurant.permission.restaurant_manage',
      risk: 'MEDIUM',
    },
    {
      code: 'restaurant.reservation.read',
      descriptionKey: 'restaurant.permission.reservation_read',
      risk: 'READ',
    },
    {
      code: 'restaurant.reservation.manage',
      descriptionKey: 'restaurant.permission.reservation_manage',
      risk: 'LOW',
    },
    {
      code: 'restaurant.reservation.override',
      descriptionKey: 'restaurant.permission.reservation_override',
      risk: 'HIGH',
    },
    // Held by the Guest Concierge for its own guest only (through its tools, never by staff roles).
    {
      code: 'restaurant.offer.read',
      descriptionKey: 'restaurant.permission.offer_read',
      risk: 'READ',
    },
    {
      code: 'restaurant.reservation.book_own',
      descriptionKey: 'restaurant.permission.reservation_book_own',
      risk: 'MEDIUM',
    },
  ],
  events: [
    RestaurantReservationCreated.name,
    RestaurantReservationCancelled.name,
    RestaurantReservationStatusChanged.name,
  ],
  aiTools: [
    { code: 'restaurant.find_tables', risk: 'READ', requiredPermission: 'restaurant.offer.read' },
    {
      code: 'restaurant.book_table',
      risk: 'MEDIUM',
      requiredPermission: 'restaurant.reservation.book_own',
    },
  ],
  entitlements: ['RESTAURANT'],
  entitlement: 'RESTAURANT',
  localeNamespaces: ['restaurant'],
});
