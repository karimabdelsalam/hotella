import { boolean, pgSchema, text, unique, uuid, varchar } from 'drizzle-orm/pg-core';
import { baseColumns } from '../columns';
import { classify } from '../data-class';

/** The `platform` schema: cross-cutting infrastructure tables (not a bounded context). */
export const platformSchema = pgSchema('platform');

export const featureFlagScope = platformSchema.enum('feature_flag_scope', [
  'PLATFORM',
  'TENANT',
  'PROPERTY',
]);

/**
 * Feature flags (Spec §73): release control only — beta, canary, experiments, emergency disable.
 * They are NOT licensing (Spec §60); entitlements live in the `license` schema.
 */
export const featureFlags = classify(
  platformSchema.table(
    'feature_flags',
    {
      ...baseColumns(),
      key: varchar('key', { length: 128 }).notNull(),
      scope: featureFlagScope('scope').notNull().default('PLATFORM'),
      scopeId: uuid('scope_id'),
      enabled: boolean('enabled').notNull().default(false),
      description: text('description'),
    },
    (t) => [unique('feature_flags_key_scope_uq').on(t.key, t.scope, t.scopeId).nullsNotDistinct()],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    key: 'INTERNAL',
    scope: 'INTERNAL',
    scopeId: 'INTERNAL',
    enabled: 'INTERNAL',
    description: 'INTERNAL',
  },
);

export type FeatureFlagRow = typeof featureFlags.$inferSelect;
export type NewFeatureFlagRow = typeof featureFlags.$inferInsert;
