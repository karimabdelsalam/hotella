import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
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

export const executionStatus = ai.enum('execution_status', [
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'HANDED_OFF',
]);
export const stepType = ai.enum('step_type', [
  'CONTEXT',
  'MODEL_CALL',
  'TOOL_CALL',
  'RETRIEVAL',
  'DECISION',
  'APPROVAL',
  'RESPONSE',
]);
export const risk = ai.enum('risk', ['READ', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
export const proposalStatus = ai.enum('proposal_status', [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'EXPIRED',
  'EXECUTED',
  'FAILED',
]);

/** One AI execution (Spec §34): an agent handling a trigger, with its totals. */
export const executions = classify(
  ai.table(
    'executions',
    {
      id: uuid('id').primaryKey(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id'),
      agentCode: varchar('agent_code', { length: 64 }).notNull(),
      agentVersionId: uuid('agent_version_id'),
      trigger: varchar('trigger', { length: 16 }).notNull(),
      actorType: varchar('actor_type', { length: 16 }).notNull(),
      actorId: uuid('actor_id'),
      conversationId: uuid('conversation_id'),
      status: executionStatus('status').notNull().default('RUNNING'),
      tokensIn: integer('tokens_in').notNull().default(0),
      tokensOut: integer('tokens_out').notNull().default(0),
      costMinor: integer('cost_minor').notNull().default(0),
      correlationId: varchar('correlation_id', { length: 128 }),
      startedAt: tz('started_at').notNull().defaultNow(),
      finishedAt: tz('finished_at'),
    },
    (t) => [index('executions_tenant_time_idx').on(t.tenantId, t.startedAt)],
  ),
  {
    id: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    agentCode: 'INTERNAL',
    agentVersionId: 'INTERNAL',
    trigger: 'INTERNAL',
    actorType: 'INTERNAL',
    actorId: 'INTERNAL',
    conversationId: 'INTERNAL',
    status: 'INTERNAL',
    tokensIn: 'INTERNAL',
    tokensOut: 'INTERNAL',
    costMinor: 'INTERNAL',
    correlationId: 'INTERNAL',
    startedAt: 'INTERNAL',
    finishedAt: 'INTERNAL',
  },
);

/** What an execution did, step by step (append-only). Summaries hold codes and decisions; arguments are confidential. */
export const executionSteps = classify(
  ai.table(
    'execution_steps',
    {
      id: uuid('id').primaryKey(),
      tenantId: uuid('tenant_id').notNull(),
      executionId: uuid('execution_id')
        .notNull()
        .references(() => executions.id, { onDelete: 'restrict' }),
      type: stepType('type').notNull(),
      name: varchar('name', { length: 128 }).notNull(),
      outcome: varchar('outcome', { length: 32 }).notNull(),
      summary: jsonb('summary').notNull().default({}),
      latencyMs: integer('latency_ms').notNull().default(0),
      createdAt: tz('created_at').notNull().defaultNow(),
    },
    (t) => [index('execution_steps_execution_idx').on(t.executionId, t.id)],
  ),
  {
    id: 'INTERNAL',
    tenantId: 'INTERNAL',
    executionId: 'INTERNAL',
    type: 'INTERNAL',
    name: 'INTERNAL',
    outcome: 'INTERNAL',
    summary: 'CONFIDENTIAL',
    latencyMs: 'INTERNAL',
    createdAt: 'INTERNAL',
  },
);

/** A HIGH-risk (or not-autonomous) action an AI proposed; a person decides through the approval engine (Spec §33). */
export const actionProposals = classify(
  ai.table(
    'action_proposals',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      executionId: uuid('execution_id')
        .notNull()
        .references(() => executions.id, { onDelete: 'restrict' }),
      toolCode: varchar('tool_code', { length: 128 }).notNull(),
      arguments: jsonb('arguments').notNull(),
      /** Who the tool acts for and where (guest, stay, conversation, locale, permissions). */
      context: jsonb('context').notNull(),
      reason: text('reason'),
      evidence: jsonb('evidence').notNull().default({}),
      risk: risk('risk').notNull(),
      approvalId: uuid('approval_id'),
      status: proposalStatus('status').notNull().default('PENDING'),
      expiresAt: tz('expires_at').notNull(),
      decidedAt: tz('decided_at'),
      result: jsonb('result'),
      ...versioned(),
    },
    (t) => [
      index('action_proposals_tenant_status_idx').on(t.tenantId, t.status),
      uniqueIndex('action_proposals_approval_uq')
        .on(t.approvalId)
        .where(sql`${t.approvalId} is not null`),
    ],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    executionId: 'INTERNAL',
    toolCode: 'INTERNAL',
    arguments: 'CONFIDENTIAL',
    context: 'CONFIDENTIAL',
    reason: 'CONFIDENTIAL',
    evidence: 'CONFIDENTIAL',
    risk: 'INTERNAL',
    approvalId: 'INTERNAL',
    status: 'INTERNAL',
    expiresAt: 'INTERNAL',
    decidedAt: 'INTERNAL',
    result: 'CONFIDENTIAL',
    version: 'INTERNAL',
  },
);

export type ExecutionRow = typeof executions.$inferSelect;
export type ExecutionStepRow = typeof executionSteps.$inferSelect;
export type ActionProposalRow = typeof actionProposals.$inferSelect;
