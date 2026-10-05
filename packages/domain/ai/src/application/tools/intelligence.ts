import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ORGANIZATION_API, type OrganizationPublicApi } from '@hotella/domain-organization/public';
import { PERMISSION_RESOLVER, type PermissionResolver } from '@hotella/platform-auth';
import { newId, TransactionRunner } from '@hotella/platform-database';
import { AppError } from '@hotella/platform-i18n';
import { ENGINEERING_COPILOT, MANAGER_ASSIST } from '../../domain/agents';
import { neighbourhood, TWIN_KINDS } from '../../domain/twin';
import { InsightRepositories } from '../../infrastructure/insight-repositories';
import { AiRepositories } from '../../infrastructure/repositories';
import { TwinRepositories } from '../../infrastructure/twin-repositories';
import { PulseService } from '../pulse.service';
import { StaffAssistantRuntime } from '../staff-assistant.runtime';
import { TwinLabelRegistry } from '../twin.service';
import type { AiToolDefinition, ToolContext, ToolRegistry } from './registry';

/** Who may be consulted, and what the person must be allowed to read for it (controlled collaboration, §43). */
const CONSULTABLE: Readonly<Record<string, readonly string[]>> = {
  [ENGINEERING_COPILOT.code]: ['eng.asset.read', 'eng.work_order.read'],
};

/**
 * The Manager assistant's tools (BUILD_PLAN 12.5), all READ: live numbers and insights come from deterministic code
 * (never retrieval, rule 12), the twin answers how things are connected, and one specialist may be consulted once.
 */
@Injectable()
export class IntelligenceTools {
  constructor(
    private readonly insights: InsightRepositories,
    private readonly twin: TwinRepositories,
    private readonly labels: TwinLabelRegistry,
    private readonly pulse: PulseService,
    private readonly ai: AiRepositories,
    private readonly tx: TransactionRunner,
    private readonly assistant: StaffAssistantRuntime,
    @Inject(PERMISSION_RESOLVER) private readonly permissions: PermissionResolver,
    @Inject(ORGANIZATION_API) private readonly org: OrganizationPublicApi,
  ) {}

  registerInto(registry: ToolRegistry): void {
    registry.register(this.insightsTool());
    registry.register(this.pulseTool());
    registry.register(this.twinTool());
    registry.register(this.compareTool());
    registry.register(this.consultTool());
  }

  /** The staff member the execution serves (the person must hold what the answer reveals). */
  private async person(ctx: ToolContext) {
    const execution = await this.tx.read(() =>
      this.ai.execution({ tenantId: ctx.tenantId }, ctx.executionId),
    );
    if (!execution?.actorId || execution.actorType !== 'USER')
      throw AppError.forbidden('ai.tool.no_person');
    return {
      execution,
      actor: {
        type: 'USER' as const,
        id: execution.actorId,
        tenantId: ctx.tenantId,
        isPlatformAdmin: false,
      },
    };
  }
  private async requirePerson(
    ctx: ToolContext,
    permissions: readonly string[],
    propertyId: string | null,
  ) {
    const { execution, actor } = await this.person(ctx);
    for (const permission of permissions)
      if (
        !(await this.permissions.hasPermission(actor, permission, {
          tenantId: ctx.tenantId,
          propertyId,
        }))
      )
        throw AppError.forbidden('platform.forbidden', { permission });
    return { execution, actor };
  }

  private insightsTool(): AiToolDefinition<{ status?: 'OPEN' | 'ACKNOWLEDGED' }> {
    return {
      code: 'intelligence.insights',
      description:
        'The live insights of the hotel (what the deterministic detectors found): detector, severity, confidence, the reason as a key with its numbers, what is affected (ids) and the suggested action. HIGH first.',
      risk: 'READ',
      requiredPermission: 'ai.insight.read',
      input: z.object({ status: z.enum(['OPEN', 'ACKNOWLEDGED']).optional() }).strict(),
      handle: async (args, ctx) => {
        const scope = { tenantId: ctx.tenantId, propertyId: ctx.propertyId };
        const rows = await this.tx.read(() =>
          this.insights.list(scope, args.status ? [args.status] : ['OPEN', 'ACKNOWLEDGED'], 30),
        );
        return {
          insights: rows.map((i) => ({
            insight_id: i.id,
            detector: i.detector,
            status: i.status,
            severity: i.severity,
            confidence: i.confidence,
            reason: { key: i.reasonKey, params: i.reasonParams },
            affected: i.affected,
            suggested_action: i.suggestedAction,
            last_seen_at: i.lastSeenAt.toISOString(),
          })),
        };
      },
    };
  }

  private pulseTool(): AiToolDefinition<Record<string, never>> {
    return {
      code: 'intelligence.pulse',
      description:
        'Live counts of the hotel right now: open work by department, service-target breaches in the last 24 hours, open complaints, restricted rooms, arrivals tomorrow and live insights. Use these numbers exactly.',
      risk: 'READ',
      requiredPermission: 'ai.insight.read',
      input: z.object({}).strict(),
      handle: async (_args, ctx) =>
        this.pulse.pulse({ tenantId: ctx.tenantId, propertyId: ctx.propertyId }),
    };
  }

  private twinTool(): AiToolDefinition<{
    kind: (typeof TWIN_KINDS)[number];
    ref_id: string;
    depth?: number;
  }> {
    return {
      code: 'intelligence.twin',
      description:
        'How a thing in the hotel is connected right now (the operational twin): give its kind and id (from another tool result); answers the connected stays, rooms, equipment, work, complaints and staff with their states and codes, up to 2 hops.',
      risk: 'READ',
      requiredPermission: 'ai.twin.read',
      input: z
        .object({
          kind: z.enum(TWIN_KINDS),
          ref_id: z.uuid(),
          depth: z.number().int().min(1).max(2).optional(),
        })
        .strict(),
      handle: async (args, ctx) => {
        const at = new Date();
        const root = { kind: args.kind, id: args.ref_id };
        const graph = await this.tx.read(async () => {
          if (!(await this.twin.node(ctx.tenantId, ctx.propertyId, root)))
            throw AppError.notFound('ai.twin.not_found');
          const g = await neighbourhood(root, args.depth ?? 1, (refs) =>
            this.twin.edgesTouching(ctx.tenantId, ctx.propertyId, refs, at),
          );
          return { ...g, rows: await this.twin.nodes(ctx.tenantId, ctx.propertyId, g.nodes) };
        });
        // Only names every twin reader may see (rooms, staff); the rest stay ids.
        const names = new Map<string, string>();
        for (const kind of [...new Set(graph.nodes.map((n) => n.kind))])
          for (const labeler of this.labels.of(kind).filter((l) => !l.permission))
            for (const [id, label] of await labeler.labels(
              ctx.tenantId,
              ctx.propertyId,
              graph.nodes.filter((n) => n.kind === kind).map((n) => n.id),
            ))
              names.set(`${kind}:${id}`, label);
        const byRef = new Map(graph.rows.map((r) => [`${r.kind}:${r.refId}`, r]));
        return {
          nodes: graph.nodes.map((n) => ({
            kind: n.kind,
            ref_id: n.id,
            distance: n.distance,
            state: byRef.get(`${n.kind}:${n.id}`)?.state ?? null,
            codes: byRef.get(`${n.kind}:${n.id}`)?.attributes ?? {},
            label: names.get(`${n.kind}:${n.id}`) ?? null,
          })),
          edges: graph.edges.map((e) => ({
            from: `${e.from.kind}:${e.from.id}`,
            relation: e.relation,
            to: `${e.to.kind}:${e.to.id}`,
          })),
        };
      },
    };
  }

  private compareTool(): AiToolDefinition<Record<string, never>> {
    return {
      code: 'intelligence.compare',
      description:
        'The pulse of every hotel of the group side by side (only for a person allowed to compare properties).',
      risk: 'READ',
      requiredPermission: 'ai.intelligence.cross_property',
      input: z.object({}).strict(),
      handle: async (_args, ctx) => {
        // A tenant-level grant: the person must hold it for the whole group, not only this hotel.
        await this.requirePerson(ctx, ['ai.intelligence.cross_property'], null);
        return { properties: await this.comparison(ctx.tenantId) };
      },
    };
  }

  /** The pulse of each property of a tenant still in use (draft or active) (also the comparison report). */
  async comparison(tenantId: string, now = new Date()) {
    const properties = (await this.org.listProperties(tenantId)).filter(
      (p) => p.status !== 'INACTIVE',
    );
    const out = [];
    for (const p of [...properties].sort((a, b) => (a.code < b.code ? -1 : 1)))
      out.push({
        property_id: p.id,
        code: p.code,
        name: p.name,
        pulse: await this.pulse.pulse({ tenantId, propertyId: p.id }, now),
      });
    return out;
  }

  private consultTool(): AiToolDefinition<{ agent: string; question: string }> {
    return {
      code: 'agents.consult',
      description:
        'Ask one specialist assistant a question and get its answer (v1: ENGINEERING_COPILOT for equipment, faults and manuals). The specialist only reads; ask a precise question with the room number or asset id.',
      risk: 'READ',
      requiredPermission: 'ai.insight.read',
      input: z
        .object({
          agent: z.enum(Object.keys(CONSULTABLE) as [string, ...string[]]),
          question: z.string().trim().min(2).max(1000),
        })
        .strict(),
      handle: async (args, ctx) => {
        // Controlled collaboration (Spec §43): only the Manager assistant consults, one level deep, no swarms.
        if (ctx.agentCode !== MANAGER_ASSIST.code)
          throw AppError.forbidden('ai.consult.not_allowed');
        const { execution, actor } = await this.requirePerson(
          ctx,
          CONSULTABLE[args.agent] ?? [],
          ctx.propertyId,
        );
        if (execution.parentExecutionId) throw AppError.forbidden('ai.consult.too_deep');
        const answer = await this.assistant.ask({
          tenantId: ctx.tenantId,
          propertyId: ctx.propertyId,
          agentCode: args.agent,
          question: args.question,
          locale: ctx.locale,
          userId: actor.id,
          parentExecutionId: ctx.executionId,
        });
        await this.tx.run(() =>
          this.ai.insertStep({
            id: newId(),
            tenantId: ctx.tenantId,
            executionId: ctx.executionId,
            type: 'DECISION',
            name: 'consult',
            outcome: answer.outcome,
            summary: { agent: args.agent, child_execution_id: answer.executionId },
            latencyMs: 0,
          }),
        );
        return {
          agent: args.agent,
          outcome: answer.outcome,
          answer: answer.answer,
          sources: answer.sources,
          execution_id: answer.executionId,
        };
      },
    };
  }
}
