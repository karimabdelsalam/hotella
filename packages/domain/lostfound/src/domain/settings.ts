import { z } from 'zod';
import { defineSetting } from '@hotella/platform-settings';

/** Lost & Found settings (BUILD_PLAN 9.B); registered by LostFoundModule. */
const SCOPES = ['PLATFORM', 'TENANT', 'PROPERTY'] as const;

/** How long an unclaimed found item is kept before it may be disposed of (days from when it was found). */
export const RETENTION_DAYS = defineSetting({
  key: 'lostfound.retention.days',
  scopes: SCOPES,
  schema: z.number().int().min(7).max(3650),
  default: 90,
  descriptionKey: 'lostfound.setting.retention_days',
});

/**
 * Whether a model derives attributes (object type, colours, brand) from the staff's description to help matching. The
 * Model Gateway's egress policy and the tenant's AI opt-in still apply; photos never leave the platform.
 */
export const AI_ATTRIBUTES = defineSetting({
  key: 'lostfound.ai.attributes',
  scopes: SCOPES,
  schema: z.boolean(),
  default: true,
  descriptionKey: 'lostfound.setting.ai_attributes',
});

export const LOSTFOUND_SETTINGS = [RETENTION_DAYS, AI_ATTRIBUTES];
