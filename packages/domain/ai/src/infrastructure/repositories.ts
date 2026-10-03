import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  DATABASE,
  type Database,
  executor,
  newId,
  type TenantScope,
  tenantWhere,
} from '@hotella/platform-database';
import {
  type ActionProposalRow,
  actionProposals,
  agents,
  type AgentVersionRow,
  agentVersions,
  feedback,
  prompts,
  type PromptVersionRow,
  promptVersions,
  type ExecutionRow,
  executions,
  executionSteps,
  type ModelRow,
  modelCalls,
  models,
  type ProviderRow,
  providers,
  type RoutingRuleRow,
  routingRules,
} from './schema';

@Injectable()
export class AiRepositories {
  constructor(@Inject(DATABASE) private readonly db: Database) {}
  private get x() {
    return executor(this.db);
  }

  // ---- providers and models (platform configuration) ----
  async insertProvider(values: typeof providers.$inferInsert): Promise<ProviderRow> {
    const [row] = await this.x.insert(providers).values(values).returning();
    return row!;
  }
  provider(id: string): Promise<ProviderRow | undefined> {
    return this.x
      .select()
      .from(providers)
      .where(eq(providers.id, id))
      .then((r) => r[0]);
  }
  listProviders(): Promise<ProviderRow[]> {
    return this.x.select().from(providers).orderBy(asc(providers.code));
  }
  async updateProvider(
    id: string,
    version: number,
    values: Partial<typeof providers.$inferInsert>,
  ): Promise<ProviderRow | undefined> {
    const [row] = await this.x
      .update(providers)
      .set({ ...values, version: sql`${providers.version} + 1` })
      .where(and(eq(providers.id, id), eq(providers.version, version)))
      .returning();
    return row;
  }
  async insertModel(values: typeof models.$inferInsert): Promise<ModelRow> {
    const [row] = await this.x.insert(models).values(values).returning();
    return row!;
  }
  model(id: string): Promise<ModelRow | undefined> {
    return this.x
      .select()
      .from(models)
      .where(eq(models.id, id))
      .then((r) => r[0]);
  }
  listModels(): Promise<ModelRow[]> {
    return this.x.select().from(models).orderBy(asc(models.code));
  }
  modelsWithProviders(ids: readonly string[]) {
    if (ids.length === 0) return Promise.resolve([]);
    return this.x
      .select({ model: models, provider: providers })
      .from(models)
      .innerJoin(providers, eq(providers.id, models.providerId))
      .where(inArray(models.id, [...ids]));
  }
  async updateModel(
    id: string,
    version: number,
    values: Partial<typeof models.$inferInsert>,
  ): Promise<ModelRow | undefined> {
    const [row] = await this.x
      .update(models)
      .set({ ...values, version: sql`${models.version} + 1` })
      .where(and(eq(models.id, id), eq(models.version, version)))
      .returning();
    return row;
  }

  // ---- routing ----
  /** Rules that may apply to a tenant (and property): the platform's, the tenant's and the property's. */
  rulesFor(tenantId: string, propertyId: string | null): Promise<RoutingRuleRow[]> {
    return this.x
      .select()
      .from(routingRules)
      .where(
        or(
          isNull(routingRules.tenantId),
          and(
            eq(routingRules.tenantId, tenantId),
            propertyId
              ? or(isNull(routingRules.propertyId), eq(routingRules.propertyId, propertyId))
              : isNull(routingRules.propertyId),
          ),
        ),
      );
  }
  /** Inserts or replaces the rule of one scope and capability. */
  async putRule(values: {
    tenantId: string | null;
    propertyId: string | null;
    capability: string;
    modelIds: string[];
    id: string;
  }): Promise<RoutingRuleRow> {
    const existing = await this.x
      .select()
      .from(routingRules)
      .where(
        and(
          eq(routingRules.capability, values.capability),
          values.tenantId
            ? eq(routingRules.tenantId, values.tenantId)
            : isNull(routingRules.tenantId),
          values.propertyId
            ? eq(routingRules.propertyId, values.propertyId)
            : isNull(routingRules.propertyId),
        ),
      )
      .for('update')
      .then((r) => r[0]);
    if (existing) {
      const [row] = await this.x
        .update(routingRules)
        .set({ modelIds: values.modelIds, version: sql`${routingRules.version} + 1` })
        .where(eq(routingRules.id, existing.id))
        .returning();
      return row!;
    }
    const [row] = await this.x.insert(routingRules).values(values).returning();
    return row!;
  }
  listRules(tenantId: string | null): Promise<RoutingRuleRow[]> {
    return this.x
      .select()
      .from(routingRules)
      .where(tenantId ? eq(routingRules.tenantId, tenantId) : isNull(routingRules.tenantId))
      .orderBy(asc(routingRules.capability));
  }

  // ---- calls ----
  async insertCall(values: typeof modelCalls.$inferInsert): Promise<void> {
    await this.x.insert(modelCalls).values(values);
  }
  /** External spend of the tenant since `from` (minor units). */
  async externalSpendSince(scope: TenantScope, from: Date): Promise<number> {
    const [row] = await this.x
      .select({ n: sql<number>`coalesce(sum(${modelCalls.costMinor}), 0)::int` })
      .from(modelCalls)
      .where(
        tenantWhere(
          modelCalls,
          scope,
          eq(modelCalls.egress, 'EXTERNAL'),
          gte(modelCalls.createdAt, from),
        ),
      );
    return row?.n ?? 0;
  }
  usage(scope: TenantScope, from: Date) {
    return this.x
      .select({
        capability: modelCalls.capability,
        providerCode: modelCalls.providerCode,
        modelCode: modelCalls.modelCode,
        currency: modelCalls.currency,
        calls: sql<number>`count(*)::int`,
        failures: sql<number>`count(*) filter (where ${modelCalls.outcome} <> 'OK')::int`,
        tokensIn: sql<number>`coalesce(sum(${modelCalls.tokensIn}), 0)::int`,
        tokensOut: sql<number>`coalesce(sum(${modelCalls.tokensOut}), 0)::int`,
        costMinor: sql<number>`coalesce(sum(${modelCalls.costMinor}), 0)::int`,
        avgLatencyMs: sql<number>`coalesce(avg(${modelCalls.latencyMs}), 0)::int`,
      })
      .from(modelCalls)
      .where(tenantWhere(modelCalls, scope, gte(modelCalls.createdAt, from)))
      .groupBy(
        modelCalls.capability,
        modelCalls.providerCode,
        modelCalls.modelCode,
        modelCalls.currency,
      )
      .orderBy(asc(modelCalls.capability));
  }

  // ---- executions (Spec §34) ----
  async insertExecution(values: typeof executions.$inferInsert): Promise<ExecutionRow> {
    const [row] = await this.x.insert(executions).values(values).returning();
    return row!;
  }
  async execution(scope: TenantScope, id: string): Promise<ExecutionRow | undefined> {
    const [row] = await this.x
      .select()
      .from(executions)
      .where(tenantWhere(executions, scope, eq(executions.id, id)));
    return row;
  }
  async updateExecution(
    scope: TenantScope,
    id: string,
    patch: Partial<Pick<ExecutionRow, 'status' | 'finishedAt'>>,
  ): Promise<void> {
    await this.x
      .update(executions)
      .set(patch)
      .where(tenantWhere(executions, scope, eq(executions.id, id)));
  }
  async insertStep(values: typeof executionSteps.$inferInsert): Promise<void> {
    await this.x.insert(executionSteps).values(values);
  }
  steps(scope: TenantScope, executionId: string) {
    return this.x
      .select()
      .from(executionSteps)
      .where(tenantWhere(executionSteps, scope, eq(executionSteps.executionId, executionId)))
      .orderBy(asc(executionSteps.id));
  }

  // ---- action proposals (Spec §33) ----
  async insertProposal(values: typeof actionProposals.$inferInsert): Promise<ActionProposalRow> {
    const [row] = await this.x.insert(actionProposals).values(values).returning();
    return row!;
  }
  async proposal(scope: TenantScope, id: string): Promise<ActionProposalRow | undefined> {
    const [row] = await this.x
      .select()
      .from(actionProposals)
      .where(tenantWhere(actionProposals, scope, eq(actionProposals.id, id)));
    return row;
  }
  async proposalForUpdate(scope: TenantScope, id: string): Promise<ActionProposalRow | undefined> {
    const [row] = await this.x
      .select()
      .from(actionProposals)
      .where(tenantWhere(actionProposals, scope, eq(actionProposals.id, id)))
      .for('update');
    return row;
  }
  async proposalOfApproval(
    scope: TenantScope,
    approvalId: string,
  ): Promise<ActionProposalRow | undefined> {
    const [row] = await this.x
      .select()
      .from(actionProposals)
      .where(tenantWhere(actionProposals, scope, eq(actionProposals.approvalId, approvalId)))
      .for('update');
    return row;
  }
  async updateProposal(
    scope: TenantScope,
    id: string,
    patch: Partial<Pick<ActionProposalRow, 'approvalId' | 'status' | 'decidedAt' | 'result'>>,
  ): Promise<ActionProposalRow> {
    const [row] = await this.x
      .update(actionProposals)
      .set({ ...patch, updatedAt: new Date(), version: sql`${actionProposals.version} + 1` })
      .where(tenantWhere(actionProposals, scope, eq(actionProposals.id, id)))
      .returning();
    return row!;
  }

  // ---- agents and prompts (platform definitions) ----
  async ensureAgent(code: string): Promise<string> {
    await this.x.insert(agents).values({ id: newId(), code }).onConflictDoNothing();
    const [row] = await this.x.select({ id: agents.id }).from(agents).where(eq(agents.code, code));
    return row!.id;
  }
  async ensurePrompt(code: string): Promise<string> {
    await this.x.insert(prompts).values({ id: newId(), code }).onConflictDoNothing();
    const [row] = await this.x
      .select({ id: prompts.id })
      .from(prompts)
      .where(eq(prompts.code, code));
    return row!.id;
  }
  async promptVersion(promptId: string, versionNo: number): Promise<PromptVersionRow | undefined> {
    const [row] = await this.x
      .select()
      .from(promptVersions)
      .where(and(eq(promptVersions.promptId, promptId), eq(promptVersions.versionNo, versionNo)));
    return row;
  }
  async promptVersionById(id: string): Promise<PromptVersionRow | undefined> {
    const [row] = await this.x.select().from(promptVersions).where(eq(promptVersions.id, id));
    return row;
  }
  /** Publishes a new prompt version, superseding the published one (one transaction). */
  async publishPromptVersion(
    values: Omit<typeof promptVersions.$inferInsert, 'status' | 'publishedAt'>,
  ): Promise<void> {
    await this.x
      .update(promptVersions)
      .set({ status: 'SUPERSEDED', updatedAt: new Date() })
      .where(
        and(eq(promptVersions.promptId, values.promptId), eq(promptVersions.status, 'PUBLISHED')),
      );
    await this.x
      .insert(promptVersions)
      .values({ ...values, status: 'PUBLISHED', publishedAt: new Date() })
      .onConflictDoNothing();
  }
  async agentVersion(agentId: string, versionNo: number): Promise<AgentVersionRow | undefined> {
    const [row] = await this.x
      .select()
      .from(agentVersions)
      .where(and(eq(agentVersions.agentId, agentId), eq(agentVersions.versionNo, versionNo)));
    return row;
  }
  async publishedAgentVersion(agentId: string): Promise<AgentVersionRow | undefined> {
    const [row] = await this.x
      .select()
      .from(agentVersions)
      .where(and(eq(agentVersions.agentId, agentId), eq(agentVersions.status, 'PUBLISHED')));
    return row;
  }
  async publishAgentVersion(
    values: Omit<typeof agentVersions.$inferInsert, 'status' | 'publishedAt'>,
  ): Promise<void> {
    await this.x
      .update(agentVersions)
      .set({ status: 'SUPERSEDED', updatedAt: new Date() })
      .where(and(eq(agentVersions.agentId, values.agentId), eq(agentVersions.status, 'PUBLISHED')));
    await this.x
      .insert(agentVersions)
      .values({ ...values, status: 'PUBLISHED', publishedAt: new Date() })
      .onConflictDoNothing();
  }
  listAgents() {
    return this.x
      .select({
        code: agents.code,
        status: agents.status,
        versionId: agentVersions.id,
        versionNo: agentVersions.versionNo,
        versionStatus: agentVersions.status,
        capability: agentVersions.capability,
        toolCodes: agentVersions.toolCodes,
        maxSteps: agentVersions.maxSteps,
        publishedAt: agentVersions.publishedAt,
      })
      .from(agents)
      .innerJoin(agentVersions, eq(agentVersions.agentId, agents.id))
      .orderBy(asc(agents.code), asc(agentVersions.versionNo));
  }

  // ---- execution audit (read side) ----
  listExecutions(
    scope: TenantScope & { propertyId: string },
    filter: { conversationId?: string; limit: number },
  ) {
    return this.x
      .select()
      .from(executions)
      .where(
        tenantWhere(
          executions,
          scope,
          eq(executions.propertyId, scope.propertyId),
          filter.conversationId ? eq(executions.conversationId, filter.conversationId) : undefined,
        ),
      )
      .orderBy(sql`${executions.id} desc`)
      .limit(filter.limit);
  }
  callsOfExecution(scope: TenantScope, executionId: string) {
    return this.x
      .select()
      .from(modelCalls)
      .where(tenantWhere(modelCalls, scope, eq(modelCalls.executionId, executionId)))
      .orderBy(asc(modelCalls.id));
  }
  async proposalsOfExecution(scope: TenantScope, executionId: string) {
    return this.x
      .select({
        id: actionProposals.id,
        toolCode: actionProposals.toolCode,
        risk: actionProposals.risk,
        status: actionProposals.status,
        approvalId: actionProposals.approvalId,
        expiresAt: actionProposals.expiresAt,
        decidedAt: actionProposals.decidedAt,
      })
      .from(actionProposals)
      .where(tenantWhere(actionProposals, scope, eq(actionProposals.executionId, executionId)))
      .orderBy(asc(actionProposals.id));
  }
  /** Sums the execution's model calls into its totals. */
  async closeExecution(
    scope: TenantScope,
    id: string,
    status: ExecutionRow['status'],
  ): Promise<void> {
    await this.x
      .update(executions)
      .set({
        status,
        finishedAt: new Date(),
        tokensIn: sql`(select coalesce(sum(${modelCalls.tokensIn}), 0)::int from ${modelCalls} where ${modelCalls.executionId} = ${id})`,
        tokensOut: sql`(select coalesce(sum(${modelCalls.tokensOut}), 0)::int from ${modelCalls} where ${modelCalls.executionId} = ${id})`,
        costMinor: sql`(select coalesce(sum(${modelCalls.costMinor}), 0)::int from ${modelCalls} where ${modelCalls.executionId} = ${id})`,
      })
      .where(tenantWhere(executions, scope, eq(executions.id, id)));
  }

  // ---- feedback (Spec §40) ----
  async insertFeedback(values: typeof feedback.$inferInsert): Promise<boolean> {
    const rows = await this.x
      .insert(feedback)
      .values(values)
      .onConflictDoNothing()
      .returning({ id: feedback.id });
    return rows.length > 0;
  }
  feedbackOfExecution(scope: TenantScope, executionId: string) {
    return this.x
      .select()
      .from(feedback)
      .where(tenantWhere(feedback, scope, eq(feedback.executionId, executionId)))
      .orderBy(asc(feedback.createdAt));
  }
}
