import { Inject, Injectable } from '@nestjs/common';
import { asc, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import {
  DATABASE,
  type Database,
  executor,
  type PropertyScope,
  propertyWhere,
  type TenantScope,
  tenantWhere,
} from '@hotella/platform-database';
import {
  connectorDefinitions,
  externalReferences,
  integrationCommands,
  integrationExceptions,
  integrationHealth,
  integrationInstances,
  integrationMappings,
  integrationMessages,
  type ConnectorDefinitionRow,
  type ExternalReferenceRow,
  type IntegrationCommandRow,
  type IntegrationExceptionRow,
  type IntegrationHealthRow,
  type IntegrationInstanceRow,
  type IntegrationMappingRow,
  type IntegrationMessageRow,
} from './schema';

type MessageStatus = IntegrationMessageRow['status'];
type MappingType = IntegrationMappingRow['mappingType'];

/** Repositories never accept a query on tenant data without a tenant/property scope (CLAUDE.md rule 1). */
@Injectable()
export class IntegrationRepositories {
  constructor(@Inject(DATABASE) private readonly db: Database) {}
  private get x() {
    return executor(this.db);
  }

  // ---- connector catalog (platform-wide) ----
  async upsertConnector(values: typeof connectorDefinitions.$inferInsert): Promise<void> {
    await this.x
      .insert(connectorDefinitions)
      .values(values)
      .onConflictDoUpdate({
        target: connectorDefinitions.code,
        set: {
          version: values.version,
          category: values.category,
          description: values.description,
          capabilities: values.capabilities,
          messageTypes: values.messageTypes,
          commands: values.commands,
          configSchema: values.configSchema,
          credentialSchema: values.credentialSchema,
          syncedAt: new Date(),
        },
      });
  }
  listConnectors(): Promise<ConnectorDefinitionRow[]> {
    return this.x.select().from(connectorDefinitions).orderBy(asc(connectorDefinitions.code));
  }

  // ---- instances ----
  async insertInstance(
    values: typeof integrationInstances.$inferInsert,
  ): Promise<IntegrationInstanceRow> {
    const [row] = await this.x.insert(integrationInstances).values(values).returning();
    return row!;
  }
  instance(scope: TenantScope, id: string): Promise<IntegrationInstanceRow | undefined> {
    return this.x
      .select()
      .from(integrationInstances)
      .where(tenantWhere(integrationInstances, scope, eq(integrationInstances.id, id)))
      .then((r) => r[0]);
  }
  /** Platform-level lookup by id for the agent link, which authenticates the instance itself (ADR-0017). */
  instanceUnscoped(id: string): Promise<IntegrationInstanceRow | undefined> {
    return this.x
      .select()
      .from(integrationInstances)
      .where(eq(integrationInstances.id, id))
      .then((r) => r[0]);
  }
  listInstances(scope: PropertyScope): Promise<IntegrationInstanceRow[]> {
    return this.x
      .select()
      .from(integrationInstances)
      .where(propertyWhere(integrationInstances, scope))
      .orderBy(asc(integrationInstances.name));
  }
  /** Optimistic update: `null` when the version moved on (concurrent change). */
  async updateInstance(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    values: Partial<typeof integrationInstances.$inferInsert>,
  ): Promise<IntegrationInstanceRow | null> {
    const [row] = await this.x
      .update(integrationInstances)
      .set({ ...values, version: expectedVersion + 1 })
      .where(
        tenantWhere(
          integrationInstances,
          scope,
          eq(integrationInstances.id, id),
          eq(integrationInstances.version, expectedVersion),
        ),
      )
      .returning();
    return row ?? null;
  }

  // ---- health ----
  async insertHealth(values: typeof integrationHealth.$inferInsert): Promise<void> {
    await this.x.insert(integrationHealth).values(values).onConflictDoNothing();
  }
  health(scope: TenantScope, instanceId: string): Promise<IntegrationHealthRow | undefined> {
    return this.x
      .select()
      .from(integrationHealth)
      .where(tenantWhere(integrationHealth, scope, eq(integrationHealth.instanceId, instanceId)))
      .then((r) => r[0]);
  }
  /** Row-locked read for counter updates. */
  healthForUpdate(
    scope: TenantScope,
    instanceId: string,
  ): Promise<IntegrationHealthRow | undefined> {
    return this.x
      .select()
      .from(integrationHealth)
      .where(tenantWhere(integrationHealth, scope, eq(integrationHealth.instanceId, instanceId)))
      .for('update')
      .then((r) => r[0]);
  }
  async updateHealth(
    scope: TenantScope,
    instanceId: string,
    values: Partial<typeof integrationHealth.$inferInsert>,
  ): Promise<void> {
    await this.x
      .update(integrationHealth)
      .set({ ...values, updatedAt: new Date() })
      .where(tenantWhere(integrationHealth, scope, eq(integrationHealth.instanceId, instanceId)));
  }

  // ---- messages ----
  /** Inserts the raw message unless (instance, source_message_id) exists; returns null for a duplicate. */
  async insertMessage(
    values: typeof integrationMessages.$inferInsert,
  ): Promise<IntegrationMessageRow | null> {
    const [row] = await this.x
      .insert(integrationMessages)
      .values(values)
      .onConflictDoNothing({
        target: [integrationMessages.instanceId, integrationMessages.sourceMessageId],
      })
      .returning();
    return row ?? null;
  }
  messageBySource(
    scope: TenantScope,
    instanceId: string,
    sourceMessageId: string,
  ): Promise<IntegrationMessageRow | undefined> {
    return this.x
      .select()
      .from(integrationMessages)
      .where(
        tenantWhere(
          integrationMessages,
          scope,
          eq(integrationMessages.instanceId, instanceId),
          eq(integrationMessages.sourceMessageId, sourceMessageId),
        ),
      )
      .then((r) => r[0]);
  }
  messageForUpdate(scope: TenantScope, id: string): Promise<IntegrationMessageRow | undefined> {
    return this.x
      .select()
      .from(integrationMessages)
      .where(tenantWhere(integrationMessages, scope, eq(integrationMessages.id, id)))
      .for('update')
      .then((r) => r[0]);
  }
  async updateMessage(
    scope: TenantScope,
    id: string,
    values: Partial<typeof integrationMessages.$inferInsert>,
  ): Promise<IntegrationMessageRow> {
    const [row] = await this.x
      .update(integrationMessages)
      .set(values)
      .where(tenantWhere(integrationMessages, scope, eq(integrationMessages.id, id)))
      .returning();
    return row!;
  }
  listMessages(
    scope: TenantScope,
    instanceId: string,
    filter: { status?: MessageStatus; limit: number },
  ): Promise<IntegrationMessageRow[]> {
    return this.x
      .select()
      .from(integrationMessages)
      .where(
        tenantWhere(
          integrationMessages,
          scope,
          eq(integrationMessages.instanceId, instanceId),
          filter.status ? eq(integrationMessages.status, filter.status) : undefined,
        ),
      )
      .orderBy(desc(integrationMessages.id))
      .limit(filter.limit);
  }
  /** Is an earlier message sharing an ordering key still blocked? Then this one must wait (Spec §50 ordering). */
  async hasBlockedPredecessor(
    scope: TenantScope,
    message: { id: string; instanceId: string; orderingKeys: readonly string[] },
  ): Promise<boolean> {
    if (message.orderingKeys.length === 0) return false;
    const r = await this.x
      .select({ id: integrationMessages.id })
      .from(integrationMessages)
      .where(
        tenantWhere(
          integrationMessages,
          scope,
          eq(integrationMessages.instanceId, message.instanceId),
          lt(integrationMessages.id, message.id),
          inArray(integrationMessages.status, ['PENDING_MAPPING', 'HELD']),
          sql`${integrationMessages.orderingKeys} && ${toTextArray(message.orderingKeys)}`,
        ),
      )
      .limit(1);
    return r.length > 0;
  }
  /** Held successors sharing a key with `keys`, oldest first. */
  heldSuccessors(
    scope: TenantScope,
    instanceId: string,
    afterId: string,
    keys: readonly string[],
  ): Promise<IntegrationMessageRow[]> {
    if (keys.length === 0) return Promise.resolve([]);
    return this.x
      .select()
      .from(integrationMessages)
      .where(
        tenantWhere(
          integrationMessages,
          scope,
          eq(integrationMessages.instanceId, instanceId),
          eq(integrationMessages.status, 'HELD'),
          sql`${integrationMessages.id} > ${afterId}`,
          sql`${integrationMessages.orderingKeys} && ${toTextArray(keys)}`,
        ),
      )
      .orderBy(asc(integrationMessages.id));
  }
  pendingMappingMessages(scope: TenantScope, instanceId: string): Promise<IntegrationMessageRow[]> {
    return this.x
      .select()
      .from(integrationMessages)
      .where(
        tenantWhere(
          integrationMessages,
          scope,
          eq(integrationMessages.instanceId, instanceId),
          eq(integrationMessages.status, 'PENDING_MAPPING'),
        ),
      )
      .orderBy(asc(integrationMessages.id));
  }

  // ---- mappings ----
  mappingsFor(
    scope: TenantScope,
    instanceId: string,
    needs: ReadonlyArray<{ type: MappingType; code: string }>,
  ): Promise<IntegrationMappingRow[]> {
    if (needs.length === 0) return Promise.resolve([]);
    return this.x
      .select()
      .from(integrationMappings)
      .where(
        tenantWhere(
          integrationMappings,
          scope,
          eq(integrationMappings.instanceId, instanceId),
          inArray(integrationMappings.externalCode, [...new Set(needs.map((n) => n.code))]),
        ),
      );
  }
  listMappings(
    scope: TenantScope,
    instanceId: string,
    type?: MappingType,
  ): Promise<IntegrationMappingRow[]> {
    return this.x
      .select()
      .from(integrationMappings)
      .where(
        tenantWhere(
          integrationMappings,
          scope,
          eq(integrationMappings.instanceId, instanceId),
          type ? eq(integrationMappings.mappingType, type) : undefined,
        ),
      )
      .orderBy(asc(integrationMappings.mappingType), asc(integrationMappings.externalCode));
  }
  mapping(
    scope: TenantScope,
    instanceId: string,
    type: MappingType,
    code: string,
  ): Promise<IntegrationMappingRow | undefined> {
    return this.x
      .select()
      .from(integrationMappings)
      .where(
        tenantWhere(
          integrationMappings,
          scope,
          eq(integrationMappings.instanceId, instanceId),
          eq(integrationMappings.mappingType, type),
          eq(integrationMappings.externalCode, code),
        ),
      )
      .then((r) => r[0]);
  }
  async insertMapping(
    values: typeof integrationMappings.$inferInsert,
  ): Promise<IntegrationMappingRow | null> {
    const [row] = await this.x
      .insert(integrationMappings)
      .values(values)
      .onConflictDoNothing()
      .returning();
    return row ?? null;
  }
  async updateMapping(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    values: Partial<typeof integrationMappings.$inferInsert>,
  ): Promise<IntegrationMappingRow | null> {
    const [row] = await this.x
      .update(integrationMappings)
      .set({ ...values, version: expectedVersion + 1 })
      .where(
        tenantWhere(
          integrationMappings,
          scope,
          eq(integrationMappings.id, id),
          eq(integrationMappings.version, expectedVersion),
        ),
      )
      .returning();
    return row ?? null;
  }

  // ---- exceptions ----
  /** Records an unknown code once; repeats bump `occurrences` on the open exception. */
  async upsertUnknownCode(values: {
    tenantId: string;
    propertyId: string;
    instanceId: string;
    messageId: string;
    mappingType: MappingType;
    externalCode: string;
    detail: Record<string, unknown>;
  }): Promise<string | null> {
    const [row] = await this.x
      .insert(integrationExceptions)
      .values({ ...values, kind: 'UNKNOWN_MAPPING' })
      .onConflictDoUpdate({
        target: [
          integrationExceptions.instanceId,
          integrationExceptions.mappingType,
          integrationExceptions.externalCode,
        ],
        targetWhere: sql`${integrationExceptions.status} = 'OPEN' AND ${integrationExceptions.kind} = 'UNKNOWN_MAPPING'`,
        set: {
          occurrences: sql`${integrationExceptions.occurrences} + 1`,
          lastSeenAt: new Date(),
          messageId: values.messageId,
          updatedAt: new Date(),
        },
      })
      // `xmax = 0` only for a freshly inserted row: lets the caller announce new exceptions once (dedup).
      .returning({ id: integrationExceptions.id, inserted: sql<boolean>`(xmax = 0)` });
    return row?.inserted ? row.id : null;
  }
  async insertException(values: typeof integrationExceptions.$inferInsert): Promise<string> {
    const [row] = await this.x
      .insert(integrationExceptions)
      .values(values)
      .returning({ id: integrationExceptions.id });
    return row!.id;
  }
  exception(scope: TenantScope, id: string): Promise<IntegrationExceptionRow | undefined> {
    return this.x
      .select()
      .from(integrationExceptions)
      .where(tenantWhere(integrationExceptions, scope, eq(integrationExceptions.id, id)))
      .then((r) => r[0]);
  }
  listExceptions(
    scope: PropertyScope,
    filter: { instanceId?: string; status?: IntegrationExceptionRow['status']; limit: number },
  ): Promise<IntegrationExceptionRow[]> {
    return this.x
      .select()
      .from(integrationExceptions)
      .where(
        propertyWhere(
          integrationExceptions,
          scope,
          filter.instanceId ? eq(integrationExceptions.instanceId, filter.instanceId) : undefined,
          filter.status ? eq(integrationExceptions.status, filter.status) : undefined,
        ),
      )
      .orderBy(desc(integrationExceptions.lastSeenAt))
      .limit(filter.limit);
  }
  /** Resolves the open unknown-code exception for a code once a mapping has been confirmed. */
  async resolveUnknownCode(
    scope: TenantScope,
    instanceId: string,
    type: MappingType,
    code: string,
    resolvedBy: string | null,
  ): Promise<IntegrationExceptionRow[]> {
    return this.x
      .update(integrationExceptions)
      .set({
        status: 'RESOLVED',
        resolvedAt: new Date(),
        resolvedBy,
        resolution: 'MAPPING_CONFIRMED',
        version: sql`${integrationExceptions.version} + 1`,
      })
      .where(
        tenantWhere(
          integrationExceptions,
          scope,
          eq(integrationExceptions.instanceId, instanceId),
          eq(integrationExceptions.kind, 'UNKNOWN_MAPPING'),
          eq(integrationExceptions.status, 'OPEN'),
          eq(integrationExceptions.mappingType, type),
          eq(integrationExceptions.externalCode, code),
        ),
      )
      .returning();
  }
  async closeException(
    scope: TenantScope,
    id: string,
    expectedVersion: number,
    values: {
      status: 'RESOLVED' | 'IGNORED';
      resolvedBy: string | null;
      resolution: string;
    },
  ): Promise<IntegrationExceptionRow | null> {
    const [row] = await this.x
      .update(integrationExceptions)
      .set({ ...values, resolvedAt: new Date(), version: expectedVersion + 1 })
      .where(
        tenantWhere(
          integrationExceptions,
          scope,
          eq(integrationExceptions.id, id),
          eq(integrationExceptions.version, expectedVersion),
          eq(integrationExceptions.status, 'OPEN'),
        ),
      )
      .returning();
    return row ?? null;
  }

  // ---- external references ----
  externalReference(
    scope: TenantScope,
    instanceId: string,
    externalEntityType: string,
    externalId: string,
  ): Promise<ExternalReferenceRow | undefined> {
    return this.x
      .select()
      .from(externalReferences)
      .where(
        tenantWhere(
          externalReferences,
          scope,
          eq(externalReferences.integrationInstanceId, instanceId),
          eq(externalReferences.externalEntityType, externalEntityType),
          eq(externalReferences.externalId, externalId),
        ),
      )
      .then((r) => r[0]);
  }
  referencesForInternal(
    scope: TenantScope,
    internalEntityType: string,
    internalEntityId: string,
  ): Promise<ExternalReferenceRow[]> {
    return this.x
      .select()
      .from(externalReferences)
      .where(
        tenantWhere(
          externalReferences,
          scope,
          eq(externalReferences.internalEntityType, internalEntityType),
          eq(externalReferences.internalEntityId, internalEntityId),
        ),
      )
      .orderBy(asc(externalReferences.firstSeenAt));
  }
  /**
   * Links an external id to an internal entity; an existing link for the same external id wins (first writer) and
   * is returned so concurrent consumers converge on one internal entity.
   */
  async linkReference(
    values: typeof externalReferences.$inferInsert,
  ): Promise<ExternalReferenceRow> {
    const [row] = await this.x
      .insert(externalReferences)
      .values(values)
      .onConflictDoUpdate({
        target: [
          externalReferences.integrationInstanceId,
          externalReferences.externalEntityType,
          externalReferences.externalId,
        ],
        set: { lastSeenAt: new Date() },
      })
      .returning();
    return row!;
  }
  async repointReferences(
    scope: TenantScope,
    internalEntityType: string,
    fromId: string,
    toId: string,
  ): Promise<number> {
    const rows = await this.x
      .update(externalReferences)
      .set({ internalEntityId: toId, updatedAt: new Date() })
      .where(
        tenantWhere(
          externalReferences,
          scope,
          eq(externalReferences.internalEntityType, internalEntityType),
          eq(externalReferences.internalEntityId, fromId),
        ),
      )
      .returning({ id: externalReferences.id });
    return rows.length;
  }

  // ---- commands ----
  async insertCommand(
    values: typeof integrationCommands.$inferInsert,
  ): Promise<IntegrationCommandRow | null> {
    const [row] = await this.x
      .insert(integrationCommands)
      .values(values)
      .onConflictDoNothing({
        target: [integrationCommands.instanceId, integrationCommands.idempotencyKey],
      })
      .returning();
    return row ?? null;
  }
  commandByKey(
    scope: TenantScope,
    instanceId: string,
    key: string,
  ): Promise<IntegrationCommandRow | undefined> {
    return this.x
      .select()
      .from(integrationCommands)
      .where(
        tenantWhere(
          integrationCommands,
          scope,
          eq(integrationCommands.instanceId, instanceId),
          eq(integrationCommands.idempotencyKey, key),
        ),
      )
      .then((r) => r[0]);
  }
}

/** A `text[]` literal bound as one parameter. */
function toTextArray(values: readonly string[]) {
  return sql`${`{${values.map((v) => `"${v.replace(/(["\\])/g, '\\$1')}"`).join(',')}}`}::text[]`;
}
