import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
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
      /** The execution that consulted this one (controlled collaboration, BUILD_PLAN 12.5): depth 1 only. */
      parentExecutionId: uuid('parent_execution_id'),
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
    parentExecutionId: 'INTERNAL',
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

// ---- agents and prompts (Spec §29–§30): platform definitions, immutable once published ----

export const versionStatus = ai.enum('version_status', ['DRAFT', 'PUBLISHED', 'SUPERSEDED']);

/** A prompt (Spec §30): its versions are ordered layers of instructions. */
export const prompts = classify(
  ai.table(
    'prompts',
    {
      ...baseColumns(),
      code: varchar('code', { length: 64 }).notNull(),
    },
    (t) => [unique('prompts_code_uq').on(t.code)],
  ),
  { id: 'INTERNAL', createdAt: 'INTERNAL', updatedAt: 'INTERNAL', code: 'INTERNAL' },
);

export const promptVersions = classify(
  ai.table(
    'prompt_versions',
    {
      ...baseColumns(),
      promptId: uuid('prompt_id')
        .notNull()
        .references(() => prompts.id, { onDelete: 'restrict' }),
      versionNo: integer('version_no').notNull(),
      status: versionStatus('status').notNull().default('DRAFT'),
      /** Ordered `{ layer, text }` blocks (platform, agent…); instructions for the model, not guest-facing text. */
      layers: jsonb('layers').notNull(),
      publishedAt: tz('published_at'),
    },
    (t) => [unique('prompt_versions_no_uq').on(t.promptId, t.versionNo)],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    promptId: 'INTERNAL',
    versionNo: 'INTERNAL',
    status: 'INTERNAL',
    layers: 'INTERNAL',
    publishedAt: 'INTERNAL',
  },
);

/** A logical agent (Spec §29), e.g. `GUEST_CONCIERGE`. */
export const agents = classify(
  ai.table(
    'agents',
    {
      ...baseColumns(),
      code: varchar('code', { length: 64 }).notNull(),
      status: activeStatus('status').notNull().default('ACTIVE'),
    },
    (t) => [unique('agents_code_uq').on(t.code)],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    code: 'INTERNAL',
    status: 'INTERNAL',
  },
);

/** What an agent is at one version: prompt, tools, context policy, autonomy, output contract, step budget. */
export const agentVersions = classify(
  ai.table(
    'agent_versions',
    {
      ...baseColumns(),
      agentId: uuid('agent_id')
        .notNull()
        .references(() => agents.id, { onDelete: 'restrict' }),
      versionNo: integer('version_no').notNull(),
      status: versionStatus('status').notNull().default('DRAFT'),
      capability: varchar('capability', { length: 32 }).notNull(),
      promptVersionId: uuid('prompt_version_id')
        .notNull()
        .references(() => promptVersions.id, { onDelete: 'restrict' }),
      toolCodes: text('tool_codes').array().notNull(),
      contextPolicy: jsonb('context_policy').notNull(),
      autonomyPolicy: jsonb('autonomy_policy').notNull(),
      outputContract: jsonb('output_contract').notNull(),
      maxSteps: integer('max_steps').notNull(),
      publishedAt: tz('published_at'),
    },
    (t) => [unique('agent_versions_no_uq').on(t.agentId, t.versionNo)],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    agentId: 'INTERNAL',
    versionNo: 'INTERNAL',
    status: 'INTERNAL',
    capability: 'INTERNAL',
    promptVersionId: 'INTERNAL',
    toolCodes: 'INTERNAL',
    contextPolicy: 'INTERNAL',
    autonomyPolicy: 'INTERNAL',
    outputContract: 'INTERNAL',
    maxSteps: 'INTERNAL',
    publishedAt: 'INTERNAL',
  },
);

export const feedbackKind = ai.enum('feedback_kind', [
  'DRAFT_EDIT',
  'REASSIGNMENT',
  'GUEST_CORRECTION',
  'RATING',
  'RECOMMENDATION_ACCEPTED',
  'RECOMMENDATION_REJECTED',
]);

/** How people corrected or rated an AI execution (Spec §40), e.g. how much staff edited a draft before sending it. */
export const feedback = classify(
  ai.table(
    'feedback',
    {
      id: uuid('id').primaryKey(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id'),
      /** The execution the feedback is about; null when it is about an insight (BUILD_PLAN 12.4). */
      executionId: uuid('execution_id').references(() => executions.id, { onDelete: 'restrict' }),
      insightId: uuid('insight_id'),
      kind: feedbackKind('kind').notNull(),
      editDistance: integer('edit_distance'),
      details: jsonb('details').notNull().default({}),
      actorType: varchar('actor_type', { length: 16 }).notNull(),
      actorId: uuid('actor_id'),
      /** The source record (e.g. the draft) — the same source never counts twice. */
      sourceRef: varchar('source_ref', { length: 64 }).notNull(),
      createdAt: tz('created_at').notNull().defaultNow(),
    },
    (t) => [
      unique('feedback_source_uq').on(t.tenantId, t.kind, t.sourceRef),
      index('feedback_execution_idx').on(t.executionId),
    ],
  ),
  {
    id: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    executionId: 'INTERNAL',
    insightId: 'INTERNAL',
    kind: 'INTERNAL',
    editDistance: 'INTERNAL',
    details: 'INTERNAL',
    actorType: 'INTERNAL',
    actorId: 'INTERNAL',
    sourceRef: 'INTERNAL',
    createdAt: 'INTERNAL',
  },
);

export type PromptVersionRow = typeof promptVersions.$inferSelect;
export type AgentRow = typeof agents.$inferSelect;
export type AgentVersionRow = typeof agentVersions.$inferSelect;
export type FeedbackRow = typeof feedback.$inferSelect;

// ---- evaluation and releases (Spec §40, BUILD_PLAN 12.1) ----

export const evaluationSetStatus = ai.enum('evaluation_set_status', ['ACTIVE', 'RETIRED']);
export const evaluationRunStatus = ai.enum('evaluation_run_status', [
  'RUNNING',
  'PASSED',
  'FAILED',
  'ERROR',
]);
export const evaluationOutcome = ai.enum('evaluation_outcome', ['PASS', 'FAIL', 'ERROR']);
export const releaseStage = ai.enum('release_stage', ['SHADOW', 'CANARY', 'ACTIVE', 'ROLLED_BACK']);

/** A set of evaluation cases for one agent; `tenant_id` null is a platform set that applies to every tenant. */
export const evaluationSets = classify(
  ai.table(
    'evaluation_sets',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id'),
      agentCode: varchar('agent_code', { length: 64 }).notNull(),
      code: varchar('code', { length: 64 }).notNull(),
      name: varchar('name', { length: 160 }).notNull(),
      status: evaluationSetStatus('status').notNull().default('ACTIVE'),
      ...versioned(),
    },
    (t) => [
      uniqueIndex('evaluation_sets_platform_uq')
        .on(t.agentCode, t.code)
        .where(sql`${t.tenantId} is null`),
      uniqueIndex('evaluation_sets_tenant_uq')
        .on(t.tenantId, t.agentCode, t.code)
        .where(sql`${t.tenantId} is not null`),
    ],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    agentCode: 'INTERNAL',
    code: 'INTERNAL',
    name: 'INTERNAL',
    status: 'INTERNAL',
    version: 'INTERNAL',
  },
);

/** One case: synthetic input, what each tool answers in a dry run, and what must (not) happen. */
export const evaluationCases = classify(
  ai.table(
    'evaluation_cases',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id'),
      setId: uuid('set_id')
        .notNull()
        .references(() => evaluationSets.id, { onDelete: 'restrict' }),
      code: varchar('code', { length: 64 }).notNull(),
      critical: boolean('critical').notNull().default(false),
      input: jsonb('input').notNull(),
      toolFixtures: jsonb('tool_fixtures').notNull().default({}),
      expectations: jsonb('expectations').notNull(),
      dataClass: dataClass('data_class').notNull().default('INTERNAL'),
      status: evaluationSetStatus('status').notNull().default('ACTIVE'),
    },
    (t) => [uniqueIndex('evaluation_cases_code_uq').on(t.setId, t.code)],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    setId: 'INTERNAL',
    code: 'INTERNAL',
    critical: 'INTERNAL',
    // Synthetic conversations, at most CONFIDENTIAL (the case says which).
    input: 'CONFIDENTIAL',
    toolFixtures: 'CONFIDENTIAL',
    expectations: 'INTERNAL',
    dataClass: 'INTERNAL',
    status: 'INTERNAL',
  },
);

/** A run of one set on one agent version (REGRESSION now; SHADOW comparisons from 12.2). */
export const evaluationRuns = classify(
  ai.table(
    'evaluation_runs',
    {
      ...baseColumns(),
      /** The tenant whose routing, budget and property the model calls ran under. */
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      /** Null for a SHADOW run (live conversations, no set). */
      setId: uuid('set_id').references(() => evaluationSets.id, { onDelete: 'restrict' }),
      agentCode: varchar('agent_code', { length: 64 }).notNull(),
      agentVersionId: uuid('agent_version_id')
        .notNull()
        .references(() => agentVersions.id, { onDelete: 'restrict' }),
      mode: varchar('mode', { length: 16 }).notNull().default('REGRESSION'),
      status: evaluationRunStatus('status').notNull().default('RUNNING'),
      totals: jsonb('totals').notNull().default({}),
      costMinor: integer('cost_minor').notNull().default(0),
      requestedByType: varchar('requested_by_type', { length: 16 }).notNull(),
      requestedById: uuid('requested_by_id'),
      startedAt: tz('started_at').notNull().defaultNow(),
      finishedAt: tz('finished_at'),
    },
    (t) => [index('evaluation_runs_version_idx').on(t.agentVersionId, t.setId)],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    setId: 'INTERNAL',
    agentCode: 'INTERNAL',
    agentVersionId: 'INTERNAL',
    mode: 'INTERNAL',
    status: 'INTERNAL',
    totals: 'INTERNAL',
    costMinor: 'INTERNAL',
    requestedByType: 'INTERNAL',
    requestedById: 'INTERNAL',
    startedAt: 'INTERNAL',
    finishedAt: 'INTERNAL',
  },
);

/** One case's result in a run: the checks (codes) and the execution it ran as. */
export const evaluationResults = classify(
  ai.table(
    'evaluation_results',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      runId: uuid('run_id')
        .notNull()
        .references(() => evaluationRuns.id, { onDelete: 'restrict' }),
      caseId: uuid('case_id').references(() => evaluationCases.id, { onDelete: 'restrict' }),
      outcome: evaluationOutcome('outcome').notNull(),
      checks: jsonb('checks').notNull().default([]),
      executionId: uuid('execution_id'),
      /** SHADOW: the live execution the shadow was compared with. */
      comparedExecutionId: uuid('compared_execution_id'),
    },
    (t) => [index('evaluation_results_run_idx').on(t.runId)],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    runId: 'INTERNAL',
    caseId: 'INTERNAL',
    outcome: 'INTERNAL',
    checks: 'INTERNAL',
    executionId: 'INTERNAL',
    comparedExecutionId: 'INTERNAL',
  },
);

/** Which agent version runs, and how (append-only history, rule 10); `tenant_id` null for platform releases. */
export const agentReleases = classify(
  ai.table(
    'agent_releases',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id'),
      agentCode: varchar('agent_code', { length: 64 }).notNull(),
      agentVersionId: uuid('agent_version_id')
        .notNull()
        .references(() => agentVersions.id, { onDelete: 'restrict' }),
      stage: releaseStage('stage').notNull(),
      canaryPercent: integer('canary_percent'),
      previousVersionId: uuid('previous_version_id'),
      runIds: uuid('run_ids')
        .array()
        .notNull()
        .default(sql`'{}'::uuid[]`),
      actorType: varchar('actor_type', { length: 16 }).notNull(),
      actorId: uuid('actor_id'),
      reason: varchar('reason', { length: 500 }),
    },
    (t) => [index('agent_releases_agent_idx').on(t.agentCode, t.createdAt)],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    agentCode: 'INTERNAL',
    agentVersionId: 'INTERNAL',
    stage: 'INTERNAL',
    canaryPercent: 'INTERNAL',
    previousVersionId: 'INTERNAL',
    runIds: 'INTERNAL',
    actorType: 'INTERNAL',
    actorId: 'INTERNAL',
    reason: 'CONFIDENTIAL',
  },
);

export type EvaluationSetRow = typeof evaluationSets.$inferSelect;
export type EvaluationCaseRow = typeof evaluationCases.$inferSelect;
export type EvaluationRunRow = typeof evaluationRuns.$inferSelect;
export type EvaluationResultRow = typeof evaluationResults.$inferSelect;
export type AgentReleaseRow = typeof agentReleases.$inferSelect;

export const twinKind = ai.enum('twin_kind', [
  'LOCATION',
  'STAY',
  'GUEST',
  'ASSET',
  'WORK_ITEM',
  'WORK_ORDER',
  'SERVICE_REQUEST',
  'COMPLAINT',
  'CONVERSATION',
  'INSPECTION',
  'LOST_ITEM',
  'STAFF',
]);

/**
 * A thing in the operational twin (BUILD_PLAN 12.3): its id in the owning context, its latest state and codes — never
 * a name or free text. A projection of events, never the source of truth.
 */
export const twinNodes = classify(
  ai.table(
    'twin_nodes',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      kind: twinKind('kind').notNull(),
      refId: uuid('ref_id').notNull(),
      state: varchar('state', { length: 32 }),
      /** When the state was observed (an older event never overwrites a newer state). */
      stateAt: tz('state_at'),
      attributes: jsonb('attributes').notNull().default({}),
    },
    (t) => [uniqueIndex('twin_nodes_ref_uq').on(t.tenantId, t.kind, t.refId)],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    kind: 'INTERNAL',
    refId: 'INTERNAL',
    state: 'INTERNAL',
    stateAt: 'INTERNAL',
    attributes: 'INTERNAL',
  },
);

/** A connection between two things, valid from one moment until it ends (ended, never deleted — rule 10). */
export const twinEdges = classify(
  ai.table(
    'twin_edges',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      fromNode: uuid('from_node')
        .notNull()
        .references(() => twinNodes.id, { onDelete: 'restrict' }),
      relation: varchar('relation', { length: 32 }).notNull(),
      toNode: uuid('to_node')
        .notNull()
        .references(() => twinNodes.id, { onDelete: 'restrict' }),
      validFrom: tz('valid_from').notNull(),
      validTo: tz('valid_to'),
    },
    (t) => [
      uniqueIndex('twin_edges_open_uq')
        .on(t.fromNode, t.relation, t.toNode)
        .where(sql`${t.validTo} is null`),
      index('twin_edges_from_idx').on(t.fromNode, t.validFrom),
      index('twin_edges_to_idx').on(t.toNode, t.validFrom),
    ],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    fromNode: 'INTERNAL',
    relation: 'INTERNAL',
    toNode: 'INTERNAL',
    validFrom: 'INTERNAL',
    validTo: 'INTERNAL',
  },
);

export type TwinNodeRow = typeof twinNodes.$inferSelect;
export type TwinEdgeRow = typeof twinEdges.$inferSelect;

/**
 * A fact the insight engine keeps from a domain event (BUILD_PLAN 12.4): ids and codes, at the moment it happened.
 * Detectors count these; retention follows the longest detector window.
 */
export const signals = classify(
  ai.table(
    'signals',
    {
      id: uuid('id').primaryKey(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      signal: varchar('signal', { length: 40 }).notNull(),
      subjectKind: varchar('subject_kind', { length: 32 }).notNull(),
      subjectRef: uuid('subject_ref').notNull(),
      codes: jsonb('codes').notNull().default({}),
      occurredAt: tz('occurred_at').notNull(),
      sourceEventId: uuid('source_event_id').notNull(),
      createdAt: tz('created_at').notNull().defaultNow(),
    },
    (t) => [
      unique('signals_source_uq').on(t.tenantId, t.sourceEventId, t.signal),
      index('signals_property_idx').on(t.tenantId, t.propertyId, t.signal, t.occurredAt),
    ],
  ),
  {
    id: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    signal: 'INTERNAL',
    subjectKind: 'INTERNAL',
    subjectRef: 'INTERNAL',
    codes: 'INTERNAL',
    occurredAt: 'INTERNAL',
    sourceEventId: 'INTERNAL',
    createdAt: 'INTERNAL',
  },
);

export const insightSeverity = ai.enum('insight_severity', ['LOW', 'MEDIUM', 'HIGH']);
export const insightStatus = ai.enum('insight_status', [
  'OPEN',
  'ACKNOWLEDGED',
  'RESOLVED',
  'DISMISSED',
  'EXPIRED',
]);

/** What a detector found at a property, with its evidence (Spec §38): one live insight per detector and fingerprint. */
export const insights = classify(
  ai.table(
    'insights',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      detector: varchar('detector', { length: 64 }).notNull(),
      fingerprint: varchar('fingerprint', { length: 200 }).notNull(),
      severity: insightSeverity('severity').notNull(),
      confidence: numeric('confidence', { precision: 4, scale: 3, mode: 'number' }).notNull(),
      reasonKey: varchar('reason_key', { length: 128 }).notNull(),
      reasonParams: jsonb('reason_params').notNull().default({}),
      evidence: jsonb('evidence').notNull().default([]),
      affected: jsonb('affected').notNull().default([]),
      suggestedAction: jsonb('suggested_action'),
      status: insightStatus('status').notNull().default('OPEN'),
      firstSeenAt: tz('first_seen_at').notNull(),
      lastSeenAt: tz('last_seen_at').notNull(),
      occurrences: integer('occurrences').notNull().default(1),
      expiresAt: tz('expires_at').notNull(),
      ...versioned(),
    },
    (t) => [
      uniqueIndex('insights_live_uq')
        .on(t.tenantId, t.propertyId, t.detector, t.fingerprint)
        .where(sql`${t.status} in ('OPEN', 'ACKNOWLEDGED')`),
      index('insights_property_idx').on(t.tenantId, t.propertyId, t.status, t.lastSeenAt),
    ],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    detector: 'INTERNAL',
    fingerprint: 'INTERNAL',
    severity: 'INTERNAL',
    confidence: 'INTERNAL',
    reasonKey: 'INTERNAL',
    reasonParams: 'INTERNAL',
    evidence: 'INTERNAL',
    affected: 'INTERNAL',
    suggestedAction: 'INTERNAL',
    status: 'INTERNAL',
    firstSeenAt: 'INTERNAL',
    lastSeenAt: 'INTERNAL',
    occurrences: 'INTERNAL',
    expiresAt: 'INTERNAL',
    version: 'INTERNAL',
  },
);

/** Every status move of an insight (append-only, rule 10). */
export const insightHistory = classify(
  ai.table(
    'insight_history',
    {
      id: uuid('id').primaryKey(),
      tenantId: uuid('tenant_id').notNull(),
      insightId: uuid('insight_id')
        .notNull()
        .references(() => insights.id, { onDelete: 'restrict' }),
      fromStatus: insightStatus('from_status'),
      toStatus: insightStatus('to_status').notNull(),
      actorType: varchar('actor_type', { length: 16 }).notNull(),
      actorId: uuid('actor_id'),
      reason: varchar('reason', { length: 500 }),
      at: tz('at').notNull().defaultNow(),
    },
    (t) => [index('insight_history_insight_idx').on(t.insightId, t.at)],
  ),
  {
    id: 'INTERNAL',
    tenantId: 'INTERNAL',
    insightId: 'INTERNAL',
    fromStatus: 'INTERNAL',
    toStatus: 'INTERNAL',
    actorType: 'INTERNAL',
    actorId: 'INTERNAL',
    reason: 'CONFIDENTIAL',
    at: 'INTERNAL',
  },
);

export type SignalRow = typeof signals.$inferSelect;
export type InsightRow = typeof insights.$inferSelect;
export type InsightHistoryRow = typeof insightHistory.$inferSelect;
