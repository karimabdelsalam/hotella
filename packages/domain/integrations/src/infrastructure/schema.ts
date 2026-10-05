import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { baseColumns, classify, versioned } from '@hotella/platform-database';

/**
 * Integration Platform (Spec §45–§57, schema `integration`). External/PMS ids live ONLY here
 * (`external_references`, raw messages, mappings) — never as a primary key anywhere (CLAUDE.md rule 3). Foreign keys
 * to `org.tenants` / `org.properties` are added by hand in the migration.
 */
export const integration = pgSchema('integration');

const tz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const connectorCategory = integration.enum('connector_category', [
  'PMS',
  'POS',
  'ERP',
  'BMS',
  'PBX',
  'LOCK',
  'PAYMENT',
  'CRM',
  'IOT',
  'WIFI',
  'OTHER',
]);
export const instanceStatus = integration.enum('instance_status', [
  'DRAFT',
  'ACTIVE',
  'PAUSED',
  'DISABLED',
]);
export const messageDirection = integration.enum('message_direction', ['INBOUND', 'OUTBOUND']);
export const messageStatus = integration.enum('message_status', [
  'RECEIVED',
  'PROCESSED',
  'PENDING_MAPPING',
  'HELD',
  'FAILED',
  'REJECTED',
]);
export const mappingType = integration.enum('mapping_type', [
  'ROOM',
  'ROOM_TYPE',
  'RATE',
  'MARKET',
  'VIP',
  'ROOM_STATUS',
  'POINT',
]);
export const exceptionKind = integration.enum('exception_kind', [
  'UNKNOWN_MAPPING',
  'PARSE_ERROR',
  'UNSUPPORTED_MESSAGE',
  'CONFLICT',
]);
export const exceptionStatus = integration.enum('exception_status', [
  'OPEN',
  'RESOLVED',
  'IGNORED',
]);
export const commandStatus = integration.enum('command_status', [
  'PENDING',
  'SENT',
  'ACKNOWLEDGED',
  'FAILED',
  'EXPIRED',
]);
export const healthStatus = integration.enum('health_status', [
  'HEALTHY',
  'DEGRADED',
  'OFFLINE',
  'MISCONFIGURED',
  'AUTH_FAILED',
]);

/** Connector catalog, synced at boot from the code-defined manifests (Spec §56). Platform-wide, not tenant data. */
export const connectorDefinitions = classify(
  integration.table('connector_definitions', {
    code: varchar('code', { length: 48 }).primaryKey(),
    version: integer('version').notNull(),
    category: connectorCategory('category').notNull(),
    description: text('description').notNull(),
    capabilities: text('capabilities').array().notNull(),
    messageTypes: jsonb('message_types').notNull(),
    commands: jsonb('commands').notNull(),
    /** Predefined reads over link protocol 2 (ADR-0019). */
    queries: jsonb('queries').notNull().default([]),
    configSchema: jsonb('config_schema').notNull(),
    credentialSchema: jsonb('credential_schema').notNull(),
    syncedAt: tz('synced_at').notNull().defaultNow(),
  }),
  {
    code: 'PUBLIC',
    version: 'PUBLIC',
    category: 'PUBLIC',
    description: 'PUBLIC',
    capabilities: 'PUBLIC',
    messageTypes: 'PUBLIC',
    commands: 'PUBLIC',
    queries: 'PUBLIC',
    configSchema: 'PUBLIC',
    credentialSchema: 'PUBLIC',
    syncedAt: 'INTERNAL',
  },
);

/** One actual connection of a property to an external system (Spec §46). */
export const integrationInstances = classify(
  integration.table(
    'integration_instances',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      connectorCode: varchar('connector_code', { length: 48 })
        .notNull()
        .references(() => connectorDefinitions.code),
      name: text('name').notNull(),
      status: instanceStatus('status').notNull().default('DRAFT'),
      config: jsonb('config').notNull().default({}),
      /** SecretRefs by credential name (never secret material, CLAUDE.md rule 13). */
      credentialRefs: jsonb('credential_refs').notNull().default({}),
      /** Capabilities the administrator enabled for this hotel (subset of the connector's). */
      enabledCapabilities: text('enabled_capabilities').array().notNull(),
      /** Capabilities the connected agent reported it can serve; null until an agent has connected (Spec §47). */
      reportedCapabilities: text('reported_capabilities').array(),
      /**
       * Commissioning sign-off (guide §16.5). Until then the instance is in commissioning: reads and events run
       * unverified, writes never do; afterwards every capability must be verified to be offered (ADR-0019).
       */
      commissionedAt: tz('commissioned_at'),
      commissionedBy: uuid('commissioned_by'),
      ...versioned(),
    },
    (t) => [
      unique('integration_instances_property_name_uq').on(t.propertyId, t.name),
      index('integration_instances_tenant_idx').on(t.tenantId, t.propertyId),
    ],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    connectorCode: 'INTERNAL',
    name: 'INTERNAL',
    status: 'INTERNAL',
    config: 'CONFIDENTIAL',
    credentialRefs: 'CONFIDENTIAL',
    enabledCapabilities: 'INTERNAL',
    reportedCapabilities: 'INTERNAL',
    commissionedAt: 'INTERNAL',
    commissionedBy: 'INTERNAL',
    version: 'INTERNAL',
  },
);

/** Internal entity ↔ external id, per integration instance (Spec §6, CLAUDE.md rule 3). */
export const externalReferences = classify(
  integration.table(
    'external_references',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      integrationInstanceId: uuid('integration_instance_id')
        .notNull()
        .references(() => integrationInstances.id),
      internalEntityType: varchar('internal_entity_type', { length: 64 }).notNull(),
      internalEntityId: uuid('internal_entity_id').notNull(),
      externalEntityType: varchar('external_entity_type', { length: 64 }).notNull(),
      externalId: varchar('external_id', { length: 128 }).notNull(),
      firstSeenAt: tz('first_seen_at').notNull().defaultNow(),
      lastSeenAt: tz('last_seen_at').notNull().defaultNow(),
    },
    (t) => [
      unique('external_references_external_uq').on(
        t.integrationInstanceId,
        t.externalEntityType,
        t.externalId,
      ),
      index('external_references_internal_idx').on(
        t.tenantId,
        t.internalEntityType,
        t.internalEntityId,
      ),
    ],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    integrationInstanceId: 'INTERNAL',
    internalEntityType: 'INTERNAL',
    internalEntityId: 'INTERNAL',
    externalEntityType: 'INTERNAL',
    externalId: 'CONFIDENTIAL',
    firstSeenAt: 'INTERNAL',
    lastSeenAt: 'INTERNAL',
  },
);

/**
 * Raw integration inbox (Spec §50): every vendor message is stored before it is interpreted, keyed by
 * (instance, source_message_id) so a replayed message is a no-op. Raw payloads carry guest data (SENSITIVE).
 */
export const integrationMessages = classify(
  integration.table(
    'integration_messages',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      instanceId: uuid('instance_id')
        .notNull()
        .references(() => integrationInstances.id),
      direction: messageDirection('direction').notNull().default('INBOUND'),
      messageType: varchar('message_type', { length: 64 }).notNull(),
      sourceMessageId: varchar('source_message_id', { length: 200 }).notNull(),
      sequenceNo: bigint('sequence_no', { mode: 'number' }),
      receivedAt: tz('received_at').notNull().defaultNow(),
      occurredAt: tz('occurred_at'),
      payload: jsonb('payload').notNull(),
      status: messageStatus('status').notNull().default('RECEIVED'),
      /** Reservation/room keys the parsed records touch; successors with a shared key wait behind a blocked one. */
      orderingKeys: text('ordering_keys')
        .array()
        .notNull()
        .default(sql`'{}'::text[]`),
      attempts: integer('attempts').notNull().default(0),
      processedAt: tz('processed_at'),
      canonicalEventIds: uuid('canonical_event_ids')
        .array()
        .notNull()
        .default(sql`'{}'::uuid[]`),
      error: text('error'),
    },
    (t) => [
      unique('integration_messages_source_uq').on(t.instanceId, t.sourceMessageId),
      index('integration_messages_status_idx').on(t.instanceId, t.status),
      index('integration_messages_ordering_idx').using('gin', t.orderingKeys),
    ],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    instanceId: 'INTERNAL',
    direction: 'INTERNAL',
    messageType: 'INTERNAL',
    sourceMessageId: 'INTERNAL',
    sequenceNo: 'INTERNAL',
    receivedAt: 'INTERNAL',
    occurredAt: 'INTERNAL',
    payload: 'SENSITIVE',
    status: 'INTERNAL',
    orderingKeys: 'CONFIDENTIAL',
    attempts: 'INTERNAL',
    processedAt: 'INTERNAL',
    canonicalEventIds: 'INTERNAL',
    error: 'INTERNAL',
  },
);

/** Confirmed external code → internal value (Spec §52). Only confirmed rows are ever used by the mapper. */
export const integrationMappings = classify(
  integration.table(
    'integration_mappings',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      instanceId: uuid('instance_id')
        .notNull()
        .references(() => integrationInstances.id),
      mappingType: mappingType('mapping_type').notNull(),
      externalCode: varchar('external_code', { length: 64 }).notNull(),
      /** Internal id (ROOM → room location id) or canonical code (RATE, MARKET, VIP …). */
      internalValue: varchar('internal_value', { length: 128 }).notNull(),
      confirmedBy: uuid('confirmed_by'),
      confirmedAt: tz('confirmed_at').notNull().defaultNow(),
      ...versioned(),
    },
    (t) => [unique('integration_mappings_code_uq').on(t.instanceId, t.mappingType, t.externalCode)],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    instanceId: 'INTERNAL',
    mappingType: 'INTERNAL',
    externalCode: 'INTERNAL',
    internalValue: 'INTERNAL',
    confirmedBy: 'INTERNAL',
    confirmedAt: 'INTERNAL',
    version: 'INTERNAL',
  },
);

/** Work queue for integration problems; never silently fixed (Spec §52). Details carry codes, never guest data. */
export const integrationExceptions = classify(
  integration.table(
    'integration_exceptions',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      instanceId: uuid('instance_id')
        .notNull()
        .references(() => integrationInstances.id),
      messageId: uuid('message_id').references(() => integrationMessages.id),
      kind: exceptionKind('kind').notNull(),
      mappingType: mappingType('mapping_type'),
      externalCode: varchar('external_code', { length: 64 }),
      detail: jsonb('detail').notNull().default({}),
      status: exceptionStatus('status').notNull().default('OPEN'),
      occurrences: integer('occurrences').notNull().default(1),
      lastSeenAt: tz('last_seen_at').notNull().defaultNow(),
      resolvedBy: uuid('resolved_by'),
      resolvedAt: tz('resolved_at'),
      resolution: text('resolution'),
      ...versioned(),
    },
    (t) => [
      // One open "unknown code" exception per code; repeats bump `occurrences` (deduplicated work queue).
      uniqueIndex('integration_exceptions_open_code_uq')
        .on(t.instanceId, t.mappingType, t.externalCode)
        .where(sql`${t.status} = 'OPEN' AND ${t.kind} = 'UNKNOWN_MAPPING'`),
      index('integration_exceptions_status_idx').on(t.tenantId, t.propertyId, t.status),
    ],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    instanceId: 'INTERNAL',
    messageId: 'INTERNAL',
    kind: 'INTERNAL',
    mappingType: 'INTERNAL',
    externalCode: 'INTERNAL',
    detail: 'INTERNAL',
    status: 'INTERNAL',
    occurrences: 'INTERNAL',
    lastSeenAt: 'INTERNAL',
    resolvedBy: 'INTERNAL',
    resolvedAt: 'INTERNAL',
    resolution: 'INTERNAL',
    version: 'INTERNAL',
  },
);

/** Durable outbound commands (Spec §53). First real use: room restrictions (Phase 8). */
export const integrationCommands = classify(
  integration.table(
    'integration_commands',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      instanceId: uuid('instance_id')
        .notNull()
        .references(() => integrationInstances.id),
      commandType: varchar('command_type', { length: 64 }).notNull(),
      payload: jsonb('payload').notNull(),
      idempotencyKey: varchar('idempotency_key', { length: 200 }).notNull(),
      status: commandStatus('status').notNull().default('PENDING'),
      attempts: integer('attempts').notNull().default(0),
      sentAt: tz('sent_at'),
      acknowledgedAt: tz('acknowledged_at'),
      expiresAt: tz('expires_at'),
      error: text('error'),
      correlationId: varchar('correlation_id', { length: 128 }),
      requestedByType: varchar('requested_by_type', { length: 16 }).notNull(),
      requestedById: varchar('requested_by_id', { length: 64 }),
      /** How the Unified OPERA Adapter chose this connector: operation, candidates, chosen, reason (guide §4.3). */
      routing: jsonb('routing'),
      ...versioned(),
    },
    (t) => [
      unique('integration_commands_idempotency_uq').on(t.instanceId, t.idempotencyKey),
      index('integration_commands_pending_idx').on(t.instanceId, t.status),
    ],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    instanceId: 'INTERNAL',
    commandType: 'INTERNAL',
    payload: 'CONFIDENTIAL',
    idempotencyKey: 'INTERNAL',
    status: 'INTERNAL',
    attempts: 'INTERNAL',
    sentAt: 'INTERNAL',
    acknowledgedAt: 'INTERNAL',
    expiresAt: 'INTERNAL',
    error: 'INTERNAL',
    correlationId: 'INTERNAL',
    requestedByType: 'INTERNAL',
    requestedById: 'INTERNAL',
    routing: 'INTERNAL',
    version: 'INTERNAL',
  },
);

/** Simple operational health per instance (Spec §57). One row per instance, updated in place. */
export const integrationHealth = classify(
  integration.table(
    'integration_health',
    {
      instanceId: uuid('instance_id').primaryKey(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      status: healthStatus('status').notNull().default('OFFLINE'),
      lastSuccessAt: tz('last_success_at'),
      lastFailureAt: tz('last_failure_at'),
      latencyMsP95: integer('latency_ms_p95'),
      queueDepth: integer('queue_depth'),
      /** Failed / total messages over the recent window, 0..1 (stored as permille for exactness). */
      errorRatePermille: integer('error_rate_permille').notNull().default(0),
      recentTotal: integer('recent_total').notNull().default(0),
      recentFailed: integer('recent_failed').notNull().default(0),
      agentLastSeenAt: tz('agent_last_seen_at'),
      updatedAt: tz('updated_at').notNull().defaultNow(),
    },
    (t) => [
      foreignKey({
        name: 'integration_health_instance_fk',
        columns: [t.instanceId],
        foreignColumns: [integrationInstances.id],
      }).onDelete('cascade'),
    ],
  ),
  {
    instanceId: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    status: 'INTERNAL',
    lastSuccessAt: 'INTERNAL',
    lastFailureAt: 'INTERNAL',
    latencyMsP95: 'INTERNAL',
    queueDepth: 'INTERNAL',
    errorRatePermille: 'INTERNAL',
    recentTotal: 'INTERNAL',
    recentFailed: 'INTERNAL',
    agentLastSeenAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
  },
);

export type ConnectorDefinitionRow = typeof connectorDefinitions.$inferSelect;
export type IntegrationInstanceRow = typeof integrationInstances.$inferSelect;
export type ExternalReferenceRow = typeof externalReferences.$inferSelect;
export type IntegrationMessageRow = typeof integrationMessages.$inferSelect;
export type IntegrationMappingRow = typeof integrationMappings.$inferSelect;
export type IntegrationExceptionRow = typeof integrationExceptions.$inferSelect;
export type IntegrationCommandRow = typeof integrationCommands.$inferSelect;
export type IntegrationHealthRow = typeof integrationHealth.$inferSelect;

/**
 * The hotel agent behind an instance (ADR-0017): its current device certificate, link ordering state and
 * connection status. One row per instance; re-enrollment replaces the certificate (the old one stops working).
 */
export const agentLinks = classify(
  integration.table(
    'agent_links',
    {
      instanceId: uuid('instance_id').primaryKey(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      /** Highest sequence number durably received (cumulative acknowledgement). */
      lastSequenceNo: bigint('last_sequence_no', { mode: 'number' }).notNull().default(0),
      certFingerprint: varchar('cert_fingerprint', { length: 64 }),
      certSerial: varchar('cert_serial', { length: 64 }),
      certNotAfter: tz('cert_not_after'),
      enrolledAt: tz('enrolled_at'),
      revokedAt: tz('revoked_at'),
      agentVersion: varchar('agent_version', { length: 64 }),
      /** Link protocol the connected agent announced in hello (2 = predefined queries, ADR-0019). */
      agentProtocol: integer('agent_protocol'),
      sessionId: uuid('session_id'),
      lastConnectedAt: tz('last_connected_at'),
      lastDisconnectedAt: tz('last_disconnected_at'),
      updatedAt: tz('updated_at').notNull().defaultNow(),
      ...versioned(),
    },
    (t) => [
      foreignKey({
        name: 'agent_links_instance_fk',
        columns: [t.instanceId],
        foreignColumns: [integrationInstances.id],
      }).onDelete('cascade'),
      uniqueIndex('agent_links_fingerprint_uq').on(t.certFingerprint),
    ],
  ),
  {
    instanceId: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    lastSequenceNo: 'INTERNAL',
    certFingerprint: 'INTERNAL',
    certSerial: 'INTERNAL',
    certNotAfter: 'INTERNAL',
    enrolledAt: 'INTERNAL',
    revokedAt: 'INTERNAL',
    agentVersion: 'INTERNAL',
    agentProtocol: 'INTERNAL',
    sessionId: 'INTERNAL',
    lastConnectedAt: 'INTERNAL',
    lastDisconnectedAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    version: 'INTERNAL',
  },
);

/** Single-use enrollment tokens (ADR-0017 §2): only the SHA-256 hash is stored; valid 24 h by default. */
export const enrollmentTokens = classify(
  integration.table(
    'enrollment_tokens',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      instanceId: uuid('instance_id')
        .notNull()
        .references(() => integrationInstances.id),
      tokenHash: varchar('token_hash', { length: 64 }).notNull(),
      expiresAt: tz('expires_at').notNull(),
      usedAt: tz('used_at'),
      createdBy: uuid('created_by'),
    },
    (t) => [unique('enrollment_tokens_hash_uq').on(t.tokenHash)],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    instanceId: 'INTERNAL',
    tokenHash: 'RESTRICTED',
    expiresAt: 'INTERNAL',
    usedAt: 'INTERNAL',
    createdBy: 'INTERNAL',
  },
);

export type AgentLinkRow = typeof agentLinks.$inferSelect;
export type EnrollmentTokenRow = typeof enrollmentTokens.$inferSelect;

export const reconciliationStatus = integration.enum('reconciliation_status', [
  'RUNNING',
  'COMPLETED',
  'FAILED',
]);
export const reconciliationOutcome = integration.enum('reconciliation_outcome', [
  'MATCH',
  'MISSING_INTERNAL',
  'MISSING_EXTERNAL',
  'DIFFERENT',
]);

/**
 * Reconciliation runs (Spec §52): the PMS reports its in-house list (database sync) and the platform compares it
 * with its own stays. Differences become results and exceptions for a human — never silent fixes.
 */
export const reconciliationRuns = classify(
  integration.table(
    'reconciliation_runs',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      instanceId: uuid('instance_id')
        .notNull()
        .references(() => integrationInstances.id),
      status: reconciliationStatus('status').notNull().default('RUNNING'),
      requestedByType: varchar('requested_by_type', { length: 16 }).notNull(),
      requestedById: varchar('requested_by_id', { length: 64 }),
      commandId: uuid('command_id'),
      snapshotStartedAt: tz('snapshot_started_at'),
      snapshotCompletedAt: tz('snapshot_completed_at'),
      completedAt: tz('completed_at'),
      /** Counts by outcome. */
      summary: jsonb('summary').notNull().default({}),
      ...versioned(),
    },
    (t) => [index('reconciliation_runs_instance_idx').on(t.instanceId, t.status)],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    instanceId: 'INTERNAL',
    status: 'INTERNAL',
    requestedByType: 'INTERNAL',
    requestedById: 'INTERNAL',
    commandId: 'INTERNAL',
    snapshotStartedAt: 'INTERNAL',
    snapshotCompletedAt: 'INTERNAL',
    completedAt: 'INTERNAL',
    summary: 'INTERNAL',
    version: 'INTERNAL',
  },
);

/** The PMS side of a run: one row per in-house reservation the PMS reported. */
export const reconciliationEntries = classify(
  integration.table(
    'reconciliation_entries',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      runId: uuid('run_id')
        .notNull()
        .references(() => reconciliationRuns.id, { onDelete: 'cascade' }),
      externalId: varchar('external_id', { length: 128 }).notNull(),
      roomCode: varchar('room_code', { length: 64 }),
      /** Internal room, when the code has a confirmed mapping. */
      roomId: uuid('room_id'),
    },
    (t) => [unique('reconciliation_entries_uq').on(t.runId, t.externalId)],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    runId: 'INTERNAL',
    externalId: 'CONFIDENTIAL',
    roomCode: 'INTERNAL',
    roomId: 'INTERNAL',
  },
);

export const reconciliationResults = classify(
  integration.table(
    'reconciliation_results',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      runId: uuid('run_id')
        .notNull()
        .references(() => reconciliationRuns.id, { onDelete: 'cascade' }),
      entityType: varchar('entity_type', { length: 32 }).notNull(),
      externalId: varchar('external_id', { length: 128 }),
      internalId: uuid('internal_id'),
      outcome: reconciliationOutcome('outcome').notNull(),
      /** What differs (field, PMS value, platform value) — ids and codes only, no guest data. */
      details: jsonb('details').notNull().default({}),
    },
    (t) => [index('reconciliation_results_run_idx').on(t.runId, t.outcome)],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    runId: 'INTERNAL',
    entityType: 'INTERNAL',
    externalId: 'CONFIDENTIAL',
    internalId: 'INTERNAL',
    outcome: 'INTERNAL',
    details: 'INTERNAL',
  },
);

export type ReconciliationRunRow = typeof reconciliationRuns.$inferSelect;
export type ReconciliationEntryRow = typeof reconciliationEntries.$inferSelect;
export type ReconciliationResultRow = typeof reconciliationResults.$inferSelect;

// ---- outbound webhooks (Spec §74–§75, ADR-0012; BUILD_PLAN 11.5) ----

export const webhookEndpointStatus = integration.enum('webhook_endpoint_status', [
  'ACTIVE',
  'PAUSED',
]);
export const webhookDeliveryStatus = integration.enum('webhook_delivery_status', [
  'PENDING',
  'DELIVERED',
  'DEAD',
]);

/**
 * A tenant's receiver of domain events. Its signing secret is never stored: it is derived from the platform's
 * signing key (a SecretRef) and the endpoint id and `secret_version`, shown once at creation or rotation.
 */
export const webhookEndpoints = classify(
  integration.table(
    'webhook_endpoints',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id'),
      url: text('url').notNull(),
      eventTypes: text('event_types').array().notNull(),
      description: text('description'),
      status: webhookEndpointStatus('status').notNull().default('ACTIVE'),
      secretVersion: integer('secret_version').notNull().default(1),
      createdBy: uuid('created_by'),
      ...versioned(),
    },
    (t) => [index('webhook_endpoints_tenant_idx').on(t.tenantId, t.status)],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    url: 'CONFIDENTIAL',
    eventTypes: 'INTERNAL',
    description: 'INTERNAL',
    status: 'INTERNAL',
    secretVersion: 'INTERNAL',
    createdBy: 'INTERNAL',
    version: 'INTERNAL',
  },
);

/**
 * One event for one endpoint: retried with exponential back-off, then DEAD (the dead-letter state) until someone
 * replays it. The body is the event envelope (ids and codes only, Spec §51).
 */
export const webhookDeliveries = classify(
  integration.table(
    'webhook_deliveries',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      endpointId: uuid('endpoint_id')
        .notNull()
        .references(() => webhookEndpoints.id, { onDelete: 'restrict' }),
      eventId: uuid('event_id').notNull(),
      eventType: varchar('event_type', { length: 128 }).notNull(),
      body: jsonb('body').notNull(),
      status: webhookDeliveryStatus('status').notNull().default('PENDING'),
      attempts: integer('attempts').notNull().default(0),
      nextAttemptAt: tz('next_attempt_at').notNull(),
      lastStatusCode: integer('last_status_code'),
      lastError: varchar('last_error', { length: 300 }),
      deliveredAt: tz('delivered_at'),
      replays: integer('replays').notNull().default(0),
    },
    (t) => [
      uniqueIndex('webhook_deliveries_event_uq').on(t.endpointId, t.eventId),
      index('webhook_deliveries_due_idx').on(t.status, t.nextAttemptAt),
    ],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    endpointId: 'INTERNAL',
    eventId: 'INTERNAL',
    eventType: 'INTERNAL',
    body: 'INTERNAL',
    status: 'INTERNAL',
    attempts: 'INTERNAL',
    nextAttemptAt: 'INTERNAL',
    lastStatusCode: 'INTERNAL',
    lastError: 'INTERNAL',
    deliveredAt: 'INTERNAL',
    replays: 'INTERNAL',
  },
);

export type WebhookEndpointRow = typeof webhookEndpoints.$inferSelect;
export type WebhookDeliveryRow = typeof webhookDeliveries.$inferSelect;

// ---- per-property capability registry (ADR-0019, BUILD_PLAN 10.6; guide §5) ----

/**
 * Commissioning facts per instance and capability: whether it was proven at this hotel, by whom, with which evidence
 * (guide §16.5). Supported, enabled, reported, licence and health come from their own sources; only verification lives
 * here. Never deleted: un-verifying clears the fact and both changes are kept in `property_capability_history`.
 */
export const propertyCapabilities = classify(
  integration.table(
    'property_capabilities',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      instanceId: uuid('instance_id')
        .notNull()
        .references(() => integrationInstances.id, { onDelete: 'restrict' }),
      connectorCode: varchar('connector_code', { length: 48 }).notNull(),
      capability: varchar('capability', { length: 48 }).notNull(),
      verifiedAt: tz('verified_at'),
      verifiedBy: uuid('verified_by'),
      verificationRef: varchar('verification_ref', { length: 300 }),
      ...versioned(),
    },
    (t) => [
      uniqueIndex('property_capabilities_uq').on(t.instanceId, t.capability),
      index('property_capabilities_property_idx').on(t.tenantId, t.propertyId),
    ],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    instanceId: 'INTERNAL',
    connectorCode: 'INTERNAL',
    capability: 'INTERNAL',
    verifiedAt: 'INTERNAL',
    verifiedBy: 'INTERNAL',
    verificationRef: 'INTERNAL',
    version: 'INTERNAL',
  },
);

export const capabilityHistoryAction = integration.enum('capability_history_action', [
  'VERIFIED',
  'UNVERIFIED',
  'ENABLED',
  'DISABLED',
  'COMMISSIONED',
  'ROUTING_CHANGED',
]);

/** Append-only history of commissioning and enablement decisions (CLAUDE.md rule 10). */
export const propertyCapabilityHistory = classify(
  integration.table(
    'property_capability_history',
    {
      id: uuid('id').primaryKey(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      instanceId: uuid('instance_id'),
      capability: varchar('capability', { length: 48 }),
      action: capabilityHistoryAction('action').notNull(),
      actorType: varchar('actor_type', { length: 16 }).notNull(),
      actorId: varchar('actor_id', { length: 64 }),
      reference: varchar('reference', { length: 300 }),
      reason: varchar('reason', { length: 500 }),
      at: tz('at').notNull().defaultNow(),
    },
    (t) => [index('property_capability_history_idx').on(t.tenantId, t.propertyId, t.at)],
  ),
  {
    id: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    instanceId: 'INTERNAL',
    capability: 'INTERNAL',
    action: 'INTERNAL',
    actorType: 'INTERNAL',
    actorId: 'INTERNAL',
    reference: 'INTERNAL',
    reason: 'INTERNAL',
    at: 'INTERNAL',
  },
);

/**
 * The last published effective state per property and capability, so a change is announced once
 * (`integration.capability.changed.v1`). A cache of the deterministic rule, recomputed on every relevant change.
 */
export const propertyCapabilityStates = classify(
  integration.table(
    'property_capability_states',
    {
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      capability: varchar('capability', { length: 48 }).notNull(),
      effective: boolean('effective').notNull(),
      connectors: text('connectors').array().notNull(),
      changedAt: tz('changed_at').notNull().defaultNow(),
    },
    (t) => [
      primaryKey({
        name: 'property_capability_states_pk',
        columns: [t.propertyId, t.capability],
      }),
      index('property_capability_states_tenant_idx').on(t.tenantId),
    ],
  ),
  {
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    capability: 'INTERNAL',
    effective: 'INTERNAL',
    connectors: 'INTERNAL',
    changedAt: 'INTERNAL',
  },
);

/** A property's own connector order for one operation, within the operation's allowed connectors (guide §4.3). */
export const routingOverrides = classify(
  integration.table(
    'routing_overrides',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      operation: varchar('operation', { length: 48 }).notNull(),
      connectors: text('connectors').array().notNull(),
      updatedBy: uuid('updated_by'),
      ...versioned(),
    },
    (t) => [uniqueIndex('routing_overrides_uq').on(t.propertyId, t.operation)],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    operation: 'INTERNAL',
    connectors: 'INTERNAL',
    updatedBy: 'INTERNAL',
    version: 'INTERNAL',
  },
);

export type PropertyCapabilityRow = typeof propertyCapabilities.$inferSelect;
export type RoutingOverrideRow = typeof routingOverrides.$inferSelect;
export type PropertyCapabilityStateRow = typeof propertyCapabilityStates.$inferSelect;

// ---- predefined reads over link protocol 2 (ADR-0019, BUILD_PLAN 10.7; guide §4.4) ----

export const queryStatus = integration.enum('query_status', [
  'PENDING',
  'SENT',
  'ANSWERED',
  'FAILED',
  'EXPIRED',
]);

/**
 * One read asked of a hotel agent: who asked, through which routing decision, how it ended. The answer rows are kept
 * only until the asker takes them (cleared at once, and swept after minutes otherwise): this is a request log, not a
 * copy of the PMS.
 */
export const integrationQueries = classify(
  integration.table(
    'integration_queries',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      instanceId: uuid('instance_id')
        .notNull()
        .references(() => integrationInstances.id),
      queryType: varchar('query_type', { length: 64 }).notNull(),
      params: jsonb('params').notNull(),
      status: queryStatus('status').notNull().default('PENDING'),
      deadlineAt: tz('deadline_at').notNull(),
      sentAt: tz('sent_at'),
      answeredAt: tz('answered_at'),
      rowCount: integer('row_count'),
      truncated: boolean('truncated').notNull().default(false),
      /** The answer, until the asker reads it (then null). */
      result: jsonb('result'),
      error: varchar('error', { length: 1000 }),
      routing: jsonb('routing'),
      correlationId: varchar('correlation_id', { length: 128 }),
      requestedByType: varchar('requested_by_type', { length: 16 }).notNull(),
      requestedById: varchar('requested_by_id', { length: 64 }),
    },
    (t) => [
      index('integration_queries_pending_idx').on(t.instanceId, t.status),
      index('integration_queries_created_idx').on(t.createdAt),
    ],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    instanceId: 'INTERNAL',
    queryType: 'INTERNAL',
    params: 'CONFIDENTIAL',
    status: 'INTERNAL',
    deadlineAt: 'INTERNAL',
    sentAt: 'INTERNAL',
    answeredAt: 'INTERNAL',
    rowCount: 'INTERNAL',
    truncated: 'INTERNAL',
    result: 'SENSITIVE',
    error: 'INTERNAL',
    routing: 'INTERNAL',
    correlationId: 'INTERNAL',
    requestedByType: 'INTERNAL',
    requestedById: 'INTERNAL',
  },
);

export type IntegrationQueryRow = typeof integrationQueries.$inferSelect;

/**
 * What an instance's PMS actually delivers of the connector's interface profile (guide §7.3; Sprint 10.8): per record
 * id, how many were received, how often each field id appeared and how many lacked a mandatory field. Field ids and
 * counts only — never values. Compared with the profile, it shows a hotel's profile gaps for commissioning.
 */
export const profileObservations = classify(
  integration.table(
    'profile_observations',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      instanceId: uuid('instance_id')
        .notNull()
        .references(() => integrationInstances.id),
      profileCode: varchar('profile_code', { length: 64 }).notNull(),
      profileVersion: integer('profile_version').notNull(),
      record: varchar('record', { length: 8 }).notNull(),
      received: integer('received').notNull().default(0),
      /** `{ "RN": 120, "G#": 120, … }` — field id → messages that carried it. */
      fields: jsonb('fields').notNull().default({}),
      missingMandatory: integer('missing_mandatory').notNull().default(0),
      firstSeenAt: tz('first_seen_at').notNull().defaultNow(),
      lastSeenAt: tz('last_seen_at').notNull().defaultNow(),
    },
    (t) => [unique('profile_observations_record_uq').on(t.instanceId, t.profileCode, t.record)],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    instanceId: 'INTERNAL',
    profileCode: 'INTERNAL',
    profileVersion: 'INTERNAL',
    record: 'INTERNAL',
    received: 'INTERNAL',
    fields: 'INTERNAL',
    missingMandatory: 'INTERNAL',
    firstSeenAt: 'INTERNAL',
    lastSeenAt: 'INTERNAL',
  },
);

export type ProfileObservationRow = typeof profileObservations.$inferSelect;

export const commissioningSheetStatus = integration.enum('commissioning_sheet_status', [
  'MATCH',
  'GAP',
  'CHANGE_REQUIRED',
  'NOT_APPLICABLE',
]);

/**
 * The hotel's Interface Sheet compared with the standard (guide §16.2; BUILD_PLAN 10.9): one row per statement,
 * append-only — the latest row of a requirement is current, earlier ones are its history (rule 10). Interface settings
 * and notes, never guest data.
 */
export const commissioningSheetRows = classify(
  integration.table(
    'commissioning_sheet_rows',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      requirement: varchar('requirement', { length: 64 }).notNull(),
      status: commissioningSheetStatus('status').notNull(),
      hotelValue: varchar('hotel_value', { length: 500 }),
      note: varchar('note', { length: 1000 }),
      recordedByType: varchar('recorded_by_type', { length: 16 }).notNull(),
      recordedById: varchar('recorded_by_id', { length: 64 }),
    },
    (t) => [
      index('commissioning_sheet_rows_property_idx').on(t.propertyId, t.requirement, t.createdAt),
    ],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    requirement: 'INTERNAL',
    status: 'INTERNAL',
    hotelValue: 'INTERNAL',
    note: 'INTERNAL',
    recordedByType: 'INTERNAL',
    recordedById: 'INTERNAL',
  },
);

export type CommissioningSheetRow = typeof commissioningSheetRows.$inferSelect;

export const commissioningRunStatus = integration.enum('commissioning_run_status', [
  'PASSED',
  'FAILED',
]);

/** A verification run of one connector instance (guide §16.3–§16.4): its checks with counts and reasons only. */
export const commissioningRuns = classify(
  integration.table(
    'commissioning_runs',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      instanceId: uuid('instance_id')
        .notNull()
        .references(() => integrationInstances.id),
      connectorCode: varchar('connector_code', { length: 48 }).notNull(),
      status: commissioningRunStatus('status').notNull(),
      checks: jsonb('checks').notNull().default([]),
      startedAt: tz('started_at').notNull(),
      finishedAt: tz('finished_at').notNull(),
      requestedByType: varchar('requested_by_type', { length: 16 }).notNull(),
      requestedById: varchar('requested_by_id', { length: 64 }),
    },
    (t) => [index('commissioning_runs_instance_idx').on(t.instanceId, t.startedAt)],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    instanceId: 'INTERNAL',
    connectorCode: 'INTERNAL',
    status: 'INTERNAL',
    checks: 'INTERNAL',
    startedAt: 'INTERNAL',
    finishedAt: 'INTERNAL',
    requestedByType: 'INTERNAL',
    requestedById: 'INTERNAL',
  },
);

export type CommissioningRunRow = typeof commissioningRuns.$inferSelect;

export const inboundEndpointStatus = integration.enum('inbound_endpoint_status', [
  'ACTIVE',
  'REVOKED',
]);

/**
 * Where a cloud-hosted vendor system posts its messages for one integration instance (ADR-0024): signed with a secret
 * that is never stored — derived from the platform signing key, the endpoint id and `secret_version`, shown once.
 */
export const inboundEndpoints = classify(
  integration.table(
    'inbound_endpoints',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      instanceId: uuid('instance_id')
        .notNull()
        .references(() => integrationInstances.id, { onDelete: 'restrict' }),
      status: inboundEndpointStatus('status').notNull().default('ACTIVE'),
      secretVersion: integer('secret_version').notNull().default(1),
      lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' }),
      createdBy: uuid('created_by'),
      ...versioned(),
    },
    (t) => [index('inbound_endpoints_instance_idx').on(t.tenantId, t.instanceId)],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    instanceId: 'INTERNAL',
    status: 'INTERNAL',
    secretVersion: 'INTERNAL',
    lastUsedAt: 'INTERNAL',
    createdBy: 'INTERNAL',
    version: 'INTERNAL',
  },
);
export type InboundEndpointRow = typeof inboundEndpoints.$inferSelect;

// ---- stay-bound access (ADR-0024 §5, BUILD_PLAN 13.3, rule 19) ----

export const accessKind = integration.enum('access_kind', ['KEY', 'MOBILE_KEY', 'WIFI']);
export const accessGrantStatus = integration.enum('access_grant_status', [
  'REQUESTED',
  'ISSUED',
  'FAILED',
  'REVOKE_REQUESTED',
  'REVOKED',
]);

/**
 * A key or Wi-Fi session for an in-house stay, asked of the lock or Wi-Fi system through a command. No key material
 * is ever here: the vendor system holds it and gives it to the guest. Every transition is in `access_grant_events`.
 */
export const accessGrants = classify(
  integration.table(
    'access_grants',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      stayId: uuid('stay_id').notNull(),
      kind: accessKind('kind').notNull(),
      roomId: uuid('room_id'),
      roomNumber: varchar('room_number', { length: 16 }),
      instanceId: uuid('instance_id')
        .notNull()
        .references(() => integrationInstances.id, { onDelete: 'restrict' }),
      status: accessGrantStatus('status').notNull().default('REQUESTED'),
      validUntil: timestamp('valid_until', { withTimezone: true, mode: 'date' }).notNull(),
      issueCommandId: uuid('issue_command_id'),
      revokeCommandId: uuid('revoke_command_id'),
      requestedByType: varchar('requested_by_type', { length: 16 }).notNull(),
      requestedById: uuid('requested_by_id'),
      issuedAt: timestamp('issued_at', { withTimezone: true, mode: 'date' }),
      revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
      revokeReason: varchar('revoke_reason', { length: 32 }),
      failure: varchar('failure', { length: 500 }),
      ...versioned(),
    },
    (t) => [
      index('access_grants_stay_idx').on(t.tenantId, t.stayId),
      index('access_grants_issue_cmd_idx').on(t.issueCommandId),
      index('access_grants_revoke_cmd_idx').on(t.revokeCommandId),
    ],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    stayId: 'INTERNAL',
    kind: 'INTERNAL',
    roomId: 'INTERNAL',
    roomNumber: 'INTERNAL',
    instanceId: 'INTERNAL',
    status: 'INTERNAL',
    validUntil: 'CONFIDENTIAL',
    issueCommandId: 'INTERNAL',
    revokeCommandId: 'INTERNAL',
    requestedByType: 'INTERNAL',
    requestedById: 'INTERNAL',
    issuedAt: 'CONFIDENTIAL',
    revokedAt: 'CONFIDENTIAL',
    revokeReason: 'INTERNAL',
    failure: 'CONFIDENTIAL',
    version: 'INTERNAL',
  },
);

/** Append-only history of every grant (rule 10); a trigger refuses updates and deletes. */
export const accessGrantEvents = classify(
  integration.table(
    'access_grant_events',
    {
      id: uuid('id').primaryKey(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      grantId: uuid('grant_id')
        .notNull()
        .references(() => accessGrants.id, { onDelete: 'restrict' }),
      fromStatus: accessGrantStatus('from_status'),
      toStatus: accessGrantStatus('to_status').notNull(),
      actorType: varchar('actor_type', { length: 16 }).notNull(),
      actorId: uuid('actor_id'),
      reason: varchar('reason', { length: 32 }),
      at: timestamp('at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    },
    (t) => [index('access_grant_events_grant_idx').on(t.grantId, t.at)],
  ),
  {
    id: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    grantId: 'INTERNAL',
    fromStatus: 'INTERNAL',
    toStatus: 'INTERNAL',
    actorType: 'INTERNAL',
    actorId: 'INTERNAL',
    reason: 'INTERNAL',
    at: 'CONFIDENTIAL',
  },
);

export type AccessGrantRow = typeof accessGrants.$inferSelect;
export type AccessGrantEventRow = typeof accessGrantEvents.$inferSelect;
