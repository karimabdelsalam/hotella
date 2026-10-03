import { z } from 'zod';
import { defineEvent } from './registry';

/** Platform-level events (schema `platform`). Domain contexts define theirs in their own contract files. */
export const PlatformPing = defineEvent({
  type: 'platform.ping.requested',
  version: 1,
  description:
    'Smoke event used by Phase 0 acceptance: proves outbox → relay → queue → idempotent consumer.',
  payload: z.object({ message: z.string().min(1).max(200) }),
});

export const FeatureFlagChanged = defineEvent({
  type: 'platform.feature_flag.changed',
  version: 1,
  description: 'A feature flag was created, enabled, disabled or deleted.',
  payload: z.object({
    key: z.string().min(1),
    scope: z.enum(['PLATFORM', 'TENANT', 'PROPERTY']),
    scope_id: z.uuid().nullable(),
    enabled: z.boolean(),
  }),
});

export const ConfigurationChanged = defineEvent({
  type: 'platform.configuration.changed',
  version: 1,
  description:
    'A configuration value was set or removed at a scope; consumers re-read the effective value (Spec §73).',
  payload: z.object({
    key: z.string().min(1),
    scope: z.enum(['PLATFORM', 'TENANT', 'PROPERTY', 'DEPARTMENT', 'MODULE']),
    scope_id: z.uuid().nullable(),
    tenant_id: z.uuid().nullable(),
    version: z.number().int().min(0),
    removed: z.boolean(),
  }),
});
