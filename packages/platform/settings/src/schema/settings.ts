import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { baseColumns, classify, newId, platform, versioned } from '@hotella/platform-database';

const { platformSchema } = platform;
const tz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** Spec §73 scopes. DEPARTMENT and MODULE are reserved until the operations phases introduce departments. */
export const configScope = platformSchema.enum('config_scope', [
  'PLATFORM',
  'TENANT',
  'PROPERTY',
  'DEPARTMENT',
  'MODULE',
]);
export const dataClassEnum = platformSchema.enum('data_class', [
  'PUBLIC',
  'INTERNAL',
  'CONFIDENTIAL',
  'SENSITIVE',
  'RESTRICTED',
]);
export const retentionAction = platformSchema.enum('retention_action', [
  'DELETE',
  'ANONYMIZE',
  'ARCHIVE',
]);

/** One stored value per (scope, scope_id, key). The effective value is resolved most-specific-first. */
export const configuration = classify(
  platformSchema.table(
    'configuration',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id'),
      scope: configScope('scope').notNull(),
      scopeId: uuid('scope_id'),
      key: varchar('key', { length: 128 }).notNull(),
      value: jsonb('value').notNull(),
      changedBy: varchar('changed_by', { length: 64 }),
      ...versioned(),
    },
    (t) => [
      unique('configuration_scope_key_uq').on(t.scope, t.scopeId, t.key).nullsNotDistinct(),
      index('configuration_tenant_key_idx').on(t.tenantId, t.key),
      check(
        'configuration_scope_id_ck',
        sql`(${t.scope} = 'PLATFORM') = (${t.scopeId} IS NULL AND ${t.tenantId} IS NULL)`,
      ),
    ],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    scope: 'INTERNAL',
    scopeId: 'INTERNAL',
    key: 'INTERNAL',
    value: 'INTERNAL',
    changedBy: 'INTERNAL',
    version: 'INTERNAL',
  },
);

/** Append-only history of every change (old → new), including removals. */
export const configurationHistory = classify(
  platformSchema.table(
    'configuration_history',
    {
      id: uuid('id').primaryKey().$defaultFn(newId),
      changedAt: tz('changed_at').notNull().defaultNow(),
      tenantId: uuid('tenant_id'),
      scope: configScope('scope').notNull(),
      scopeId: uuid('scope_id'),
      key: varchar('key', { length: 128 }).notNull(),
      oldValue: jsonb('old_value'),
      newValue: jsonb('new_value'),
      version: integer('version').notNull(),
      changedBy: varchar('changed_by', { length: 64 }),
      reason: text('reason'),
      correlationId: varchar('correlation_id', { length: 128 }),
    },
    (t) => [index('configuration_history_key_idx').on(t.scope, t.scopeId, t.key, t.changedAt)],
  ),
  {
    id: 'INTERNAL',
    changedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    scope: 'INTERNAL',
    scopeId: 'INTERNAL',
    key: 'INTERNAL',
    oldValue: 'INTERNAL',
    newValue: 'INTERNAL',
    version: 'INTERNAL',
    changedBy: 'INTERNAL',
    reason: 'INTERNAL',
    correlationId: 'INTERNAL',
  },
);

/**
 * Spec §69 retention framework: platform defaults (tenant null) and tenant overrides per data class, optionally per
 * entity type. Each module implements the purge/anonymize job for its tables (Definition of Done §12.15).
 */
export const retentionPolicies = classify(
  platformSchema.table(
    'retention_policies',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id'),
      dataClass: dataClassEnum('data_class').notNull(),
      entityType: varchar('entity_type', { length: 64 }),
      retainDays: integer('retain_days').notNull(),
      action: retentionAction('action').notNull(),
      legalHold: boolean('legal_hold').notNull().default(false),
      ...versioned(),
    },
    (t) => [
      unique('retention_policies_scope_uq')
        .on(t.tenantId, t.dataClass, t.entityType)
        .nullsNotDistinct(),
      check('retention_policies_days_ck', sql`${t.retainDays} >= 1`),
    ],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    dataClass: 'INTERNAL',
    entityType: 'INTERNAL',
    retainDays: 'INTERNAL',
    action: 'INTERNAL',
    legalHold: 'INTERNAL',
    version: 'INTERNAL',
  },
);

/**
 * Spec invariant 33: the "Powered by Planova" attribution. Not editable through brand profiles; hiding it requires
 * an entitlement reference (white-label licence, Phase 11) — enforced by a CHECK constraint, not only by code.
 */
export const attributionPolicies = classify(
  platformSchema.table(
    'attribution_policies',
    {
      tenantId: uuid('tenant_id').primaryKey(),
      showPoweredBy: boolean('show_powered_by').notNull().default(true),
      overrideEntitlementRef: varchar('override_entitlement_ref', { length: 128 }),
      updatedBy: varchar('updated_by', { length: 64 }),
      createdAt: tz('created_at').notNull().defaultNow(),
      updatedAt: tz('updated_at')
        .notNull()
        .defaultNow()
        .$onUpdateFn(() => new Date()),
      ...versioned(),
    },
    (t) => [
      check(
        'attribution_policies_override_ck',
        sql`${t.showPoweredBy} OR ${t.overrideEntitlementRef} IS NOT NULL`,
      ),
    ],
  ),
  {
    tenantId: 'INTERNAL',
    showPoweredBy: 'INTERNAL',
    overrideEntitlementRef: 'INTERNAL',
    updatedBy: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    version: 'INTERNAL',
  },
);

export type ConfigurationRow = typeof configuration.$inferSelect;
export type RetentionPolicyRow = typeof retentionPolicies.$inferSelect;
export type AttributionPolicyRow = typeof attributionPolicies.$inferSelect;
