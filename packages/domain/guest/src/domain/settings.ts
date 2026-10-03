import { z } from 'zod';
import { defineSetting } from '@hotella/platform-settings';
import { GUEST_SCOPES, type GrantPolicy, type GuestScope } from './access';

/** Settings owned by the guest context (Spec §21, §73); registered by GuestModule. */
const scopes = z.array(z.enum(GUEST_SCOPES)).max(GUEST_SCOPES.length);
const SCOPES = ['PLATFORM', 'TENANT', 'PROPERTY'] as const;

export const GUEST_GRANT_IN_STAY_SCOPES = defineSetting<GuestScope[]>({
  key: 'guest.grant.in_stay_scopes',
  scopes: SCOPES,
  schema: scopes,
  default: [
    'SERVICE_REQUEST',
    'CHAT',
    'DINING',
    'CONCIERGE',
    'ROOM_CONTROL',
    'VIEW_BILL',
    'LOST_FOUND',
    'FEEDBACK',
    'INVOICE',
    'SUPPORT',
  ],
  descriptionKey: 'guest.setting.grant_in_stay_scopes',
});
export const GUEST_GRANT_COMPANION_SCOPES = defineSetting<GuestScope[]>({
  key: 'guest.grant.companion_scopes',
  scopes: SCOPES,
  schema: scopes,
  default: [
    'SERVICE_REQUEST',
    'CHAT',
    'DINING',
    'CONCIERGE',
    'ROOM_CONTROL',
    'LOST_FOUND',
    'FEEDBACK',
    'SUPPORT',
  ],
  descriptionKey: 'guest.setting.grant_companion_scopes',
});
export const GUEST_GRANT_PRE_ARRIVAL_SCOPES = defineSetting<GuestScope[]>({
  key: 'guest.grant.pre_arrival_scopes',
  scopes: SCOPES,
  schema: scopes,
  default: ['SERVICE_REQUEST', 'CHAT', 'DINING', 'CONCIERGE', 'SUPPORT'],
  descriptionKey: 'guest.setting.grant_pre_arrival_scopes',
});
export const GUEST_GRANT_POST_STAY_SCOPES = defineSetting<GuestScope[]>({
  key: 'guest.grant.post_stay_scopes',
  scopes: SCOPES,
  schema: scopes,
  default: ['LOST_FOUND', 'FEEDBACK', 'INVOICE', 'SUPPORT'],
  descriptionKey: 'guest.setting.grant_post_stay_scopes',
});
export const GUEST_GRANT_POST_STAY_HOURS = defineSetting({
  key: 'guest.grant.post_stay_hours',
  scopes: SCOPES,
  schema: z
    .number()
    .int()
    .min(0)
    .max(24 * 90),
  default: 72,
  descriptionKey: 'guest.setting.grant_post_stay_hours',
});

export const GUEST_SETTINGS = [
  GUEST_GRANT_IN_STAY_SCOPES,
  GUEST_GRANT_COMPANION_SCOPES,
  GUEST_GRANT_PRE_ARRIVAL_SCOPES,
  GUEST_GRANT_POST_STAY_SCOPES,
  GUEST_GRANT_POST_STAY_HOURS,
];

export type { GrantPolicy };
