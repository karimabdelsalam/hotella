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

/**
 * Whether a vision model reads the photos of found items into suggestions (owner decision 2026-10-04, BUILD_PLAN 9.5).
 * Off unless the property turns it on; it also needs the `AI_VISION` entitlement and a routed provider that may
 * receive SENSITIVE data. The photo leaves the platform re-encoded without metadata, with a fixed instruction only.
 */
export const AI_VISION = defineSetting({
  key: 'lostfound.ai.vision',
  scopes: SCOPES,
  schema: z.boolean(),
  default: false,
  descriptionKey: 'lostfound.setting.ai_vision',
});

export const LOSTFOUND_SETTINGS = [RETENTION_DAYS, AI_ATTRIBUTES, AI_VISION];
