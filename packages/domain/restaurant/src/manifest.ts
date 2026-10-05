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
  ],
  events: [
    RestaurantReservationCreated.name,
    RestaurantReservationCancelled.name,
    RestaurantReservationStatusChanged.name,
  ],
  entitlements: ['RESTAURANT'],
  entitlement: 'RESTAURANT',
  localeNamespaces: ['restaurant'],
});
