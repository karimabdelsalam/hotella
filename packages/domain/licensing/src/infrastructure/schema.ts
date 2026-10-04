import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  pgSchema,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import {
  baseColumns,
  classify,
  translationColumns,
  translationUnique,
  versioned,
} from '@hotella/platform-database';
import { CAPABILITY_KINDS, METRIC_KINDS, METRIC_UNITS } from '../domain/catalog';

/**
 * Licensing & entitlements (Spec §58–§62, BUILD_PLAN Phase 11, schema `license`). The catalog and plans are
 * platform-level (no tenant); subscriptions, grants, overrides and usage are tenant-owned (rule 1). Published plan
 * versions are immutable (trigger, rule 9); subscription history is append-only and grants are revoked, never deleted
 * (rule 10). Entitlement ≠ billing: no prices or invoices live here (Spec §58).
 */
export const license = pgSchema('license');

const tz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const catalogStatus = license.enum('catalog_status', ['ACTIVE', 'RETIRED']);
export const capabilityKind = license.enum('capability_kind', CAPABILITY_KINDS);
export const metricUnit = license.enum('metric_unit', METRIC_UNITS);
export const metricKind = license.enum('metric_kind', METRIC_KINDS);
export const planVersionStatus = license.enum('plan_version_status', [
  'DRAFT',
  'PUBLISHED',
  'RETIRED',
]);
export const limitScope = license.enum('limit_scope', ['TENANT', 'PROPERTY']);
export const limitPeriod = license.enum('limit_period', ['NONE', 'DAY', 'MONTH']);
export const enforcement = license.enum('enforcement', ['SOFT', 'HARD']);
export const subscriptionScope = license.enum('subscription_scope', ['TENANT', 'PROPERTIES']);
export const subscriptionStatus = license.enum('subscription_status', [
  'TRIAL',
  'ACTIVE',
  'PAST_DUE',
  'SUSPENDED',
  'CANCELLED',
  'EXPIRED',
]);
export const grantSource = license.enum('grant_source', ['MANUAL', 'TRIAL', 'PROMO']);
export const granularity = license.enum('granularity', ['DAY', 'MONTH']);

const internal = <const K extends string>(keys: readonly K[]) =>
  Object.fromEntries(keys.map((k) => [k, 'INTERNAL'])) as Record<K, 'INTERNAL'>;

// ---- catalog (code-defined, synchronised at boot) ----

export const products = classify(
  license.table('products', {
    ...baseColumns(),
    code: varchar('code', { length: 64 }).notNull().unique('products_code_uq'),
    status: catalogStatus('status').notNull().default('ACTIVE'),
  }),
  internal(['id', 'createdAt', 'updatedAt', 'code', 'status']),
);

/** Modules, AI and connector entitlements, add-ons and features: the codes `EntitlementEngine.can` answers for. */
export const capabilities = classify(
  license.table('capabilities', {
    ...baseColumns(),
    code: varchar('code', { length: 64 }).notNull().unique('capabilities_code_uq'),
    productCode: varchar('product_code', { length: 64 }).notNull(),
    kind: capabilityKind('kind').notNull(),
    moduleCode: varchar('module_code', { length: 64 }),
    defaultIncluded: boolean('default_included').notNull().default(false),
    status: catalogStatus('status').notNull().default('ACTIVE'),
  }),
  internal([
    'id',
    'createdAt',
    'updatedAt',
    'code',
    'productCode',
    'kind',
    'moduleCode',
    'defaultIncluded',
    'status',
  ]),
);

export const metrics = classify(
  license.table('metrics', {
    ...baseColumns(),
    code: varchar('code', { length: 64 }).notNull().unique('metrics_code_uq'),
    unit: metricUnit('unit').notNull(),
    kind: metricKind('kind').notNull(),
    status: catalogStatus('status').notNull().default('ACTIVE'),
  }),
  internal(['id', 'createdAt', 'updatedAt', 'code', 'unit', 'kind', 'status']),
);

// ---- plans (administrator data) ----

export const plans = classify(
  license.table('plans', {
    ...baseColumns(),
    code: varchar('code', { length: 64 }).notNull().unique('plans_code_uq'),
    status: catalogStatus('status').notNull().default('ACTIVE'),
    ...versioned(),
  }),
  internal(['id', 'createdAt', 'updatedAt', 'code', 'status', 'version']),
);
export const planTranslations = classify(
  license.table(
    'plan_translations',
    {
      ...translationColumns(() => plans.id),
      name: text('name').notNull(),
      description: text('description'),
    },
    (t) => [translationUnique('plan_translations', t)],
  ),
  internal(['entityId', 'locale', 'name', 'description', 'createdAt', 'updatedAt']),
);

export const planVersions = classify(
  license.table(
    'plan_versions',
    {
      ...baseColumns(),
      planId: uuid('plan_id')
        .notNull()
        .references(() => plans.id, { onDelete: 'restrict' }),
      versionNo: integer('version_no').notNull(),
      status: planVersionStatus('status').notNull().default('DRAFT'),
      notes: text('notes'),
      createdById: uuid('created_by_id'),
      publishedAt: tz('published_at'),
      publishedById: uuid('published_by_id'),
      retiredAt: tz('retired_at'),
      ...versioned(),
    },
    (t) => [
      uniqueIndex('plan_versions_no_uq').on(t.planId, t.versionNo),
      uniqueIndex('plan_versions_one_draft_uq')
        .on(t.planId)
        .where(sql`${t.status} = 'DRAFT'`),
    ],
  ),
  internal([
    'id',
    'createdAt',
    'updatedAt',
    'planId',
    'versionNo',
    'status',
    'notes',
    'createdById',
    'publishedAt',
    'publishedById',
    'retiredAt',
    'version',
  ]),
);

export const planVersionItems = classify(
  license.table(
    'plan_version_items',
    {
      ...baseColumns(),
      planVersionId: uuid('plan_version_id')
        .notNull()
        .references(() => planVersions.id, { onDelete: 'restrict' }),
      capabilityCode: varchar('capability_code', { length: 64 })
        .notNull()
        .references(() => capabilities.code, { onDelete: 'restrict' }),
    },
    (t) => [uniqueIndex('plan_version_items_uq').on(t.planVersionId, t.capabilityCode)],
  ),
  internal(['id', 'createdAt', 'updatedAt', 'planVersionId', 'capabilityCode']),
);

export const planVersionLimits = classify(
  license.table(
    'plan_version_limits',
    {
      ...baseColumns(),
      planVersionId: uuid('plan_version_id')
        .notNull()
        .references(() => planVersions.id, { onDelete: 'restrict' }),
      metricCode: varchar('metric_code', { length: 64 })
        .notNull()
        .references(() => metrics.code, { onDelete: 'restrict' }),
      scope: limitScope('scope').notNull(),
      period: limitPeriod('period').notNull(),
      limitValue: bigint('limit_value', { mode: 'number' }).notNull(),
      enforcement: enforcement('enforcement').notNull(),
    },
    (t) => [
      uniqueIndex('plan_version_limits_uq').on(t.planVersionId, t.metricCode, t.scope, t.period),
    ],
  ),
  internal([
    'id',
    'createdAt',
    'updatedAt',
    'planVersionId',
    'metricCode',
    'scope',
    'period',
    'limitValue',
    'enforcement',
  ]),
);

// ---- tenant-owned ----

export const subscriptions = classify(
  license.table(
    'subscriptions',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      planVersionId: uuid('plan_version_id')
        .notNull()
        .references(() => planVersions.id, { onDelete: 'restrict' }),
      scope: subscriptionScope('scope').notNull(),
      status: subscriptionStatus('status').notNull(),
      startsAt: tz('starts_at').notNull(),
      endsAt: tz('ends_at'),
      graceDays: smallint('grace_days').notNull().default(0),
      /** The billing system's reference; opaque to Hotella. */
      externalRef: varchar('external_ref', { length: 128 }),
      ...versioned(),
    },
    (t) => [index('subscriptions_tenant_idx').on(t.tenantId, t.status)],
  ),
  {
    ...internal([
      'id',
      'createdAt',
      'updatedAt',
      'tenantId',
      'planVersionId',
      'scope',
      'status',
      'startsAt',
      'endsAt',
      'graceDays',
      'version',
    ]),
    externalRef: 'CONFIDENTIAL',
  },
);

export const subscriptionProperties = classify(
  license.table(
    'subscription_properties',
    {
      subscriptionId: uuid('subscription_id')
        .notNull()
        .references(() => subscriptions.id, { onDelete: 'restrict' }),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      createdAt: tz('created_at').notNull().defaultNow(),
    },
    (t) => [
      primaryKey({ name: 'subscription_properties_pk', columns: [t.subscriptionId, t.propertyId] }),
      index('subscription_properties_property_idx').on(t.tenantId, t.propertyId),
    ],
  ),
  internal(['subscriptionId', 'tenantId', 'propertyId', 'createdAt']),
);

/** Every status, plan-version or scope change of a subscription, in order (append-only). */
export const subscriptionHistory = classify(
  license.table(
    'subscription_history',
    {
      ...baseColumns(),
      subscriptionId: uuid('subscription_id')
        .notNull()
        .references(() => subscriptions.id, { onDelete: 'restrict' }),
      tenantId: uuid('tenant_id').notNull(),
      fromStatus: subscriptionStatus('from_status'),
      toStatus: subscriptionStatus('to_status').notNull(),
      planVersionId: uuid('plan_version_id').notNull(),
      change: varchar('change', { length: 32 }).notNull(),
      actorType: varchar('actor_type', { length: 16 }).notNull(),
      actorId: uuid('actor_id'),
      reason: text('reason'),
      at: tz('at').notNull().defaultNow(),
    },
    (t) => [index('subscription_history_idx').on(t.subscriptionId, t.at)],
  ),
  internal([
    'id',
    'createdAt',
    'updatedAt',
    'subscriptionId',
    'tenantId',
    'fromStatus',
    'toStatus',
    'planVersionId',
    'change',
    'actorType',
    'actorId',
    'reason',
    'at',
  ]),
);

/** Capabilities given outside a plan (trial, promotion, a negotiated extra); revoked, never deleted. */
export const entitlementGrants = classify(
  license.table(
    'entitlement_grants',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id'),
      capabilityCode: varchar('capability_code', { length: 64 })
        .notNull()
        .references(() => capabilities.code, { onDelete: 'restrict' }),
      source: grantSource('source').notNull(),
      validFrom: tz('valid_from').notNull(),
      validUntil: tz('valid_until'),
      reason: text('reason').notNull(),
      grantedById: uuid('granted_by_id'),
      revokedAt: tz('revoked_at'),
      revokedById: uuid('revoked_by_id'),
      revokeReason: text('revoke_reason'),
      ...versioned(),
    },
    (t) => [index('entitlement_grants_tenant_idx').on(t.tenantId, t.capabilityCode)],
  ),
  internal([
    'id',
    'createdAt',
    'updatedAt',
    'tenantId',
    'propertyId',
    'capabilityCode',
    'source',
    'validFrom',
    'validUntil',
    'reason',
    'grantedById',
    'revokedAt',
    'revokedById',
    'revokeReason',
    'version',
  ]),
);

export const limitOverrides = classify(
  license.table(
    'limit_overrides',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id'),
      metricCode: varchar('metric_code', { length: 64 })
        .notNull()
        .references(() => metrics.code, { onDelete: 'restrict' }),
      period: limitPeriod('period').notNull(),
      limitValue: bigint('limit_value', { mode: 'number' }).notNull(),
      enforcement: enforcement('enforcement').notNull(),
      validUntil: tz('valid_until'),
      reason: text('reason').notNull(),
      setById: uuid('set_by_id'),
      revokedAt: tz('revoked_at'),
      revokedById: uuid('revoked_by_id'),
      ...versioned(),
    },
    (t) => [index('limit_overrides_tenant_idx').on(t.tenantId, t.metricCode)],
  ),
  internal([
    'id',
    'createdAt',
    'updatedAt',
    'tenantId',
    'propertyId',
    'metricCode',
    'period',
    'limitValue',
    'enforcement',
    'validUntil',
    'reason',
    'setById',
    'revokedAt',
    'revokedById',
    'version',
  ]),
);

/** One measured occurrence; a repeated idempotency key is a no-op (Spec §61). No personal data. */
export const usageEvents = classify(
  license.table(
    'usage_events',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id'),
      metricCode: varchar('metric_code', { length: 64 })
        .notNull()
        .references(() => metrics.code, { onDelete: 'restrict' }),
      quantity: bigint('quantity', { mode: 'number' }).notNull(),
      occurredAt: tz('occurred_at').notNull(),
      source: varchar('source', { length: 64 }).notNull(),
      idempotencyKey: varchar('idempotency_key', { length: 200 }).notNull(),
    },
    (t) => [
      uniqueIndex('usage_events_idempotency_uq').on(t.tenantId, t.idempotencyKey),
      index('usage_events_metric_idx').on(t.tenantId, t.metricCode, t.occurredAt),
    ],
  ),
  internal([
    'id',
    'createdAt',
    'updatedAt',
    'tenantId',
    'propertyId',
    'metricCode',
    'quantity',
    'occurredAt',
    'source',
    'idempotencyKey',
  ]),
);

/**
 * DAY and MONTH totals (COUNTER: sum; GAUGE: maximum) per tenant and per property; `property_key` is the property id,
 * or the tenant id for the tenant-wide row, so one unique key covers both.
 */
export const usageAggregates = classify(
  license.table(
    'usage_aggregates',
    {
      tenantId: uuid('tenant_id').notNull(),
      propertyKey: uuid('property_key').notNull(),
      metricCode: varchar('metric_code', { length: 64 })
        .notNull()
        .references(() => metrics.code, { onDelete: 'restrict' }),
      granularity: granularity('granularity').notNull(),
      periodStart: tz('period_start').notNull(),
      quantity: bigint('quantity', { mode: 'number' }).notNull(),
      updatedAt: tz('updated_at').notNull().defaultNow(),
    },
    (t) => [
      primaryKey({
        name: 'usage_aggregates_pk',
        columns: [t.tenantId, t.propertyKey, t.metricCode, t.granularity, t.periodStart],
      }),
    ],
  ),
  internal([
    'tenantId',
    'propertyKey',
    'metricCode',
    'granularity',
    'periodStart',
    'quantity',
    'updatedAt',
  ]),
);

/** Where each pull collector stopped (per tenant or platform-wide). */
export const usageCollectorCursors = classify(
  license.table('usage_collector_cursors', {
    collector: varchar('collector', { length: 64 }).primaryKey(),
    cursor: text('cursor').notNull(),
    updatedAt: tz('updated_at').notNull().defaultNow(),
  }),
  internal(['collector', 'cursor', 'updatedAt']),
);

export type CapabilityRow = typeof capabilities.$inferSelect;
export type MetricRow = typeof metrics.$inferSelect;
export type PlanRow = typeof plans.$inferSelect;
export type PlanTranslationRow = typeof planTranslations.$inferSelect;
export type PlanVersionRow = typeof planVersions.$inferSelect;
export type PlanVersionItemRow = typeof planVersionItems.$inferSelect;
export type PlanVersionLimitRow = typeof planVersionLimits.$inferSelect;
export type SubscriptionRow = typeof subscriptions.$inferSelect;
export type SubscriptionHistoryRow = typeof subscriptionHistory.$inferSelect;
export type EntitlementGrantRow = typeof entitlementGrants.$inferSelect;
export type LimitOverrideRow = typeof limitOverrides.$inferSelect;
