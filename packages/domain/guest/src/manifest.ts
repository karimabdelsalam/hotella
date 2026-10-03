import {
  GuestAnonymized,
  GuestMerged,
  GuestStayRoomChanged,
  StayCreated,
  StayStatusChanged,
} from '@hotella/contracts-events';
import { defineManifest } from '@hotella/platform-manifest';

export const GUEST_MANIFEST = defineManifest({
  code: 'guest',
  schema: 'guest',
  description:
    'Guest & Stay: guests, identifiers, stays driven by canonical PMS events, stay party, room-assignment history.',
  permissions: [
    { code: 'guest.read', descriptionKey: 'guest.permission.read', risk: 'READ' },
    { code: 'guest.manage', descriptionKey: 'guest.permission.manage', risk: 'MEDIUM' },
    { code: 'guest.merge', descriptionKey: 'guest.permission.merge', risk: 'HIGH' },
    {
      code: 'guest.data_request.manage',
      descriptionKey: 'guest.permission.data_request_manage',
      risk: 'HIGH',
    },
    { code: 'stay.read', descriptionKey: 'guest.permission.stay_read', risk: 'READ' },
    { code: 'stay.manage', descriptionKey: 'guest.permission.stay_manage', risk: 'MEDIUM' },
  ],
  events: [
    StayCreated.name,
    StayStatusChanged.name,
    GuestStayRoomChanged.name,
    GuestMerged.name,
    GuestAnonymized.name,
  ],
  localeNamespaces: ['guest'],
  integrationCapabilities: [
    'CHECKIN_EVENT',
    'CHECKOUT_EVENT',
    'ROOM_MOVE_EVENT',
    'RESERVATION_READ',
  ],
});
