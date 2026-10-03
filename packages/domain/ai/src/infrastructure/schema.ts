import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  pgSchema,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { baseColumns, classify, versioned } from '@hotella/platform-database';

/**
 * AI platform (Spec §27–§42, BUILD_PLAN Phase 6, schema `ai`). Providers and models are platform configuration (no
 * tenant); routing rules may be platform, tenant or property scoped; model calls are tenant data. Credentials are
 * SecretRefs only (rule 13).
 */
export const ai = pgSchema('ai');

const tz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const providerKind = ai.enum('provider_kind', ['OPENAI_COMPATIBLE', 'ANTHROPIC', 'FAKE']);
export const egress = ai.enum('egress', ['ON_PREM', 'EXTERNAL']);
export const dataClass = ai.enum('data_class', [
  'PUBLIC',
  'INTERNAL',
  'CONFIDENTIAL',
  'SENSITIVE',
  'RESTRICTED',
]);
export const activeStatus = ai.enum('active_status', ['ACTIVE', 'DISABLED']);

/** A model provider endpoint: a cloud API or an on-prem model server (ADR-0018). */
export const providers = classify(
  ai.table(
    'providers',
    {
      ...baseColumns(),
      code: varchar('code', { length: 64 }).notNull(),
      kind: providerKind('kind').notNull(),
      baseUrl: varchar('base_url', { length: 512 }),
      credentialRef: varchar('credential_ref', { length: 256 }),
      egress: egress('egress').notNull(),
      maxDataClass: dataClass('max_data_class').notNull().default('INTERNAL'),
      status: activeStatus('status').notNull().default('ACTIVE'),
      ...versioned(),
    },
    (t) => [unique('providers_code_uq').on(t.code)],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    code: 'INTERNAL',
    kind: 'INTERNAL',
    baseUrl: 'INTERNAL',
    credentialRef: 'CONFIDENTIAL',
    egress: 'INTERNAL',
    maxDataClass: 'INTERNAL',
    status: 'INTERNAL',
    version: 'INTERNAL',
  },
);

/** A model of a provider, the capabilities it serves and its prices (minor units per million tokens). */
export const models = classify(
  ai.table(
    'models',
    {
      ...baseColumns(),
      providerId: uuid('provider_id')
        .notNull()
        .references(() => providers.id, { onDelete: 'restrict' }),
      code: varchar('code', { length: 128 }).notNull(),
      capabilities: text('capabilities').array().notNull(),
      contextWindow: integer('context_window').notNull().default(8192),
      inputPerMillionMinor: integer('input_per_million_minor').notNull().default(0),
      outputPerMillionMinor: integer('output_per_million_minor').notNull().default(0),
      cachedPerMillionMinor: integer('cached_per_million_minor').notNull().default(0),
      currency: varchar('currency', { length: 3 }).notNull().default('USD'),
      status: activeStatus('status').notNull().default('ACTIVE'),
      ...versioned(),
    },
    (t) => [unique('models_provider_code_uq').on(t.providerId, t.code)],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    providerId: 'INTERNAL',
    code: 'INTERNAL',
    capabilities: 'INTERNAL',
    contextWindow: 'INTERNAL',
    inputPerMillionMinor: 'INTERNAL',
    outputPerMillionMinor: 'INTERNAL',
    cachedPerMillionMinor: 'INTERNAL',
    currency: 'INTERNAL',
    status: 'INTERNAL',
    version: 'INTERNAL',
  },
);

/** Capability → ordered models; the platform default, overridden per tenant and per property. */
export const routingRules = classify(
  ai.table(
    'routing_rules',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id'),
      propertyId: uuid('property_id'),
      capability: varchar('capability', { length: 32 }).notNull(),
      modelIds: uuid('model_ids').array().notNull(),
      ...versioned(),
    },
    (t) => [
      uniqueIndex('routing_rules_platform_uq')
        .on(t.capability)
        .where(sql`${t.tenantId} is null`),
      uniqueIndex('routing_rules_tenant_uq')
        .on(t.tenantId, t.capability)
        .where(sql`${t.tenantId} is not null and ${t.propertyId} is null`),
      uniqueIndex('routing_rules_property_uq')
        .on(t.tenantId, t.propertyId, t.capability)
        .where(sql`${t.propertyId} is not null`),
    ],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    capability: 'INTERNAL',
    modelIds: 'INTERNAL',
    version: 'INTERNAL',
  },
);

/** One model call (Spec §41): what it cost, how long it took, what happened; never the content. */
export const modelCalls = classify(
  ai.table(
    'model_calls',
    {
      id: uuid('id').primaryKey(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id'),
      executionId: uuid('execution_id'),
      agentCode: varchar('agent_code', { length: 64 }),
      capability: varchar('capability', { length: 32 }).notNull(),
      providerCode: varchar('provider_code', { length: 64 }).notNull(),
      modelCode: varchar('model_code', { length: 128 }).notNull(),
      egress: egress('egress').notNull(),
      tokensIn: integer('tokens_in').notNull().default(0),
      tokensOut: integer('tokens_out').notNull().default(0),
      tokensCached: integer('tokens_cached').notNull().default(0),
      latencyMs: integer('latency_ms').notNull(),
      costMinor: integer('cost_minor').notNull().default(0),
      currency: varchar('currency', { length: 3 }).notNull(),
      /** Model code tried before this one in the same request (fallback). */
      fallbackFrom: varchar('fallback_from', { length: 128 }),
      /** OK or the provider error code. */
      outcome: varchar('outcome', { length: 32 }).notNull(),
      droppedParts: integer('dropped_parts').notNull().default(0),
      correlationId: varchar('correlation_id', { length: 128 }),
      createdAt: tz('created_at').notNull().defaultNow(),
    },
    (t) => [
      index('model_calls_tenant_time_idx').on(t.tenantId, t.createdAt),
      index('model_calls_execution_idx').on(t.executionId),
    ],
  ),
  {
    id: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    executionId: 'INTERNAL',
    agentCode: 'INTERNAL',
    capability: 'INTERNAL',
    providerCode: 'INTERNAL',
    modelCode: 'INTERNAL',
    egress: 'INTERNAL',
    tokensIn: 'INTERNAL',
    tokensOut: 'INTERNAL',
    tokensCached: 'INTERNAL',
    latencyMs: 'INTERNAL',
    costMinor: 'INTERNAL',
    currency: 'INTERNAL',
    fallbackFrom: 'INTERNAL',
    outcome: 'INTERNAL',
    droppedParts: 'INTERNAL',
    correlationId: 'INTERNAL',
    createdAt: 'INTERNAL',
  },
);

export type ProviderRow = typeof providers.$inferSelect;
export type ModelRow = typeof models.$inferSelect;
export type RoutingRuleRow = typeof routingRules.$inferSelect;
export type ModelCallRow = typeof modelCalls.$inferSelect;
