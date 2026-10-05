import { Inject, Injectable } from '@nestjs/common';
import {
  type ApprovalSummary,
  OPERATIONS_API,
  type OperationsPublicApi,
} from '@hotella/domain-operations/public';
import { ActionGate, ActorStore, type RequestActor } from '@hotella/platform-auth';
import { newId, TransactionRunner } from '@hotella/platform-database';
import { FeatureFlagService } from '@hotella/platform-flags';
import { AppError } from '@hotella/platform-i18n';
import { InjectLogger, type Logger, RequestContext } from '@hotella/platform-observability';
import { type AutonomyPolicy, decide } from '../../domain/policy';
import { killSwitch } from '../../domain/settings';
import { AiRepositories } from '../../infrastructure/repositories';
import type { ExecutionRow } from '../../infrastructure/schema';
import { type AiToolDefinition, type ToolContext, ToolRegistry } from './registry';
import { aiExecutionScope } from './scope';

/** The approval kind of AI proposals (Spec §33): approving it runs the proposed tool call. */
export const AI_ACTION_APPROVAL = 'AI_ACTION';

/** One running execution of an agent: who it serves and what it may use. */
export interface ExecutionHandle {
  readonly id: string;
  readonly tenantId: string;
  readonly propertyId: string;
  readonly agentCode: string;
  /** Tool codes of the agent version. */
  readonly tools: readonly string[];
  readonly autonomy: AutonomyPolicy;
  readonly locale: string;
  readonly guest: { readonly guestId: string; readonly stayId: string } | null;
  readonly conversationId: string | null;
}

export interface StartExecutionInput extends Omit<ExecutionHandle, 'id'> {
  readonly agentVersionId?: string | null;
  /** What started it: a guest message, a staff request, a schedule, an event. */
  readonly trigger: 'MESSAGE' | 'STAFF' | 'SCHEDULE' | 'EVENT' | 'EVALUATION';
  /** Who the agent acts for (the guest, a staff member) — not the AI itself. */
  readonly on: { readonly type: RequestActor['type']; readonly id: string | null };
}

/** What a tool call came to; the model reads it as the tool result. */
export type ToolOutcome =
  | { readonly status: 'OK'; readonly result: unknown }
  | { readonly status: 'PROPOSED'; readonly proposalId: string; readonly approvalId: string }
  | { readonly status: 'REFUSED'; readonly reason: string }
  | { readonly status: 'ERROR'; readonly code: string; readonly issues?: readonly string[] };

/** Context a proposal keeps so the approved call runs exactly as proposed. */
interface ProposalContext {
  readonly agent_code: string;
  readonly tools: readonly string[];
  readonly locale: string;
  readonly guest: { readonly guestId: string; readonly stayId: string } | null;
  readonly conversation_id: string | null;
}

/**
 * Runs AI tool calls (Spec §31–§34, CLAUDE.md rule 12). Deterministic policy decides — never the model: READ and
 * allowed actions run at once through the ActionGate as the `AI_AGENT` actor (authorized only for the agent's tools,
 * in its tenant and property); HIGH-risk or not-autonomous actions become an `ai.action_proposals` row and an
 * `AI_ACTION` approval that runs the call once a person approves; CRITICAL is refused. Every call is a step of the
 * execution (codes and decisions only, never guest text).
 */
@Injectable()
export class ToolExecutor {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly repo: AiRepositories,
    private readonly gate: ActionGate,
    private readonly actors: ActorStore,
    private readonly flags: FeatureFlagService,
    private readonly tx: TransactionRunner,
    private readonly ctx: RequestContext,
    @Inject(OPERATIONS_API) private readonly ops: OperationsPublicApi,
    @InjectLogger() private readonly logger: Logger,
  ) {}

  // ---- executions ----

  async start(input: StartExecutionInput): Promise<ExecutionHandle> {
    const id = newId();
    await this.tx.run(() =>
      this.repo.insertExecution({
        id,
        tenantId: input.tenantId,
        propertyId: input.propertyId,
        agentCode: input.agentCode,
        agentVersionId: input.agentVersionId ?? null,
        trigger: input.trigger,
        actorType: input.on.type,
        actorId: input.on.id,
        conversationId: input.conversationId,
        correlationId: this.ctx.correlationId,
      }),
    );
    const { agentVersionId: _v, trigger: _t, on: _o, ...handle } = input;
    return { id, ...handle };
  }

  /** Closes the execution with its status and the totals of its model calls. */
  async finish(
    handle: Pick<ExecutionHandle, 'id' | 'tenantId'>,
    status: Exclude<ExecutionRow['status'], 'RUNNING'>,
  ): Promise<void> {
    await this.tx.run(() =>
      this.repo.closeExecution({ tenantId: handle.tenantId }, handle.id, status),
    );
  }

  /**
   * Runs a public-API call as the agent (audit, approvals and events name the AI actor) — for what the runtime does
   * itself (saving a draft, handing off), which is not an action on business data.
   */
  actAs<T>(handle: ExecutionHandle, fn: () => Promise<T>): Promise<T> {
    return this.asActor(handle, fn);
  }

  /** Appends a step to the execution record (append-only; summaries carry codes, never guest text). */
  async step(
    handle: Pick<ExecutionHandle, 'id' | 'tenantId'>,
    step: {
      type:
        'CONTEXT' | 'MODEL_CALL' | 'TOOL_CALL' | 'RETRIEVAL' | 'DECISION' | 'APPROVAL' | 'RESPONSE';
      name: string;
      outcome: string;
      summary?: Record<string, unknown>;
      latencyMs?: number;
    },
  ): Promise<void> {
    await this.tx.run(() =>
      this.repo.insertStep({
        id: newId(),
        tenantId: handle.tenantId,
        executionId: handle.id,
        type: step.type,
        name: step.name,
        outcome: step.outcome,
        summary: step.summary ?? {},
        latencyMs: step.latencyMs ?? 0,
      }),
    );
  }

  // ---- tool calls ----

  async invoke(
    handle: ExecutionHandle,
    call: { readonly tool: string; readonly arguments: unknown; readonly reason?: string | null },
  ): Promise<ToolOutcome> {
    const started = Date.now();
    const def = handle.tools.includes(call.tool) ? this.registry.get(call.tool) : undefined;
    const outcome = def
      ? await this.decideAndRun(handle, def, call)
      : ({ status: 'REFUSED', reason: 'TOOL_NOT_ALLOWED' } as const);
    await this.step(handle, {
      type: 'TOOL_CALL',
      name: call.tool.slice(0, 128),
      outcome: outcome.status,
      summary: {
        risk: def?.risk ?? null,
        argument_keys:
          call.arguments && typeof call.arguments === 'object'
            ? Object.keys(call.arguments).slice(0, 20)
            : [],
        ...(outcome.status === 'REFUSED' ? { reason: outcome.reason } : {}),
        ...(outcome.status === 'ERROR' ? { code: outcome.code } : {}),
        ...(outcome.status === 'PROPOSED'
          ? { proposal_id: outcome.proposalId, approval_id: outcome.approvalId }
          : {}),
      },
      latencyMs: Date.now() - started,
    });
    this.logger.info(
      {
        execution_id: handle.id,
        agent: handle.agentCode,
        tool: call.tool,
        outcome: outcome.status,
      },
      'ai tool call',
    );
    return outcome;
  }

  private async decideAndRun(
    handle: ExecutionHandle,
    def: AiToolDefinition,
    call: { readonly arguments: unknown; readonly reason?: string | null },
  ): Promise<ToolOutcome> {
    const at = { tenantId: handle.tenantId, propertyId: handle.propertyId };
    if (
      (await this.flags.isEnabled(killSwitch.agent(handle.agentCode), at)) ||
      (await this.flags.isEnabled(killSwitch.tool(def.code), at))
    )
      return { status: 'REFUSED', reason: 'DISABLED' };
    const parsed = def.input.safeParse(call.arguments ?? {});
    if (!parsed.success)
      return {
        status: 'ERROR',
        code: 'ai.tool.invalid_arguments',
        // Paths and issue codes only: argument values may quote the guest.
        issues: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.code}`),
      };
    const ctx = this.toolContext(handle);
    if ((def.needs?.guest && !ctx.guest) || (def.needs?.conversation && !ctx.conversationId))
      return { status: 'ERROR', code: 'ai.tool.context_missing' };
    const { decision, reason } = decide({
      tool: def.code,
      risk: def.risk,
      autonomy: handle.autonomy,
      autoActionsKilled: await this.flags.isEnabled(killSwitch.autoActions, at),
    });
    try {
      if (decision === 'REFUSE') return { status: 'REFUSED', reason };
      if (decision === 'PROPOSE')
        return await this.propose(handle, def, parsed.data, ctx, call.reason ?? null, reason);
      const result = await this.asAgent(handle, def, 'AUTO', null, () =>
        def.handle(parsed.data, ctx),
      );
      return { status: 'OK', result };
    } catch (e) {
      if (e instanceof AppError && e.status < 500) return { status: 'ERROR', code: e.code };
      this.logger.error({ err: e, tool: def.code, execution_id: handle.id }, 'ai tool failed');
      return { status: 'ERROR', code: 'ai.tool.failed' };
    }
  }

  private async propose(
    handle: ExecutionHandle,
    def: AiToolDefinition,
    args: unknown,
    ctx: ToolContext,
    reason: string | null,
    policyReason: string,
  ): Promise<ToolOutcome> {
    const context: ProposalContext = {
      agent_code: handle.agentCode,
      tools: handle.tools,
      locale: handle.locale,
      guest: handle.guest,
      conversation_id: handle.conversationId,
    };
    // The requester is the AI actor (outside the gate: proposing is not acting); a person decides.
    return this.asActor(handle, async () => {
      await def.precheck?.(args, ctx);
      return this.tx.run(async () => {
        const proposalId = newId();
        const approval = await this.ops.requestApproval({
          tenantId: handle.tenantId,
          propertyId: handle.propertyId,
          kind: AI_ACTION_APPROVAL,
          riskLevel: def.risk === 'HIGH' ? 'HIGH' : 'MEDIUM',
          subject: { type: 'ai_action_proposal', id: proposalId },
          payload: {
            tool: def.code,
            arguments: args as Record<string, unknown>,
            agent: handle.agentCode,
            execution_id: handle.id,
            policy: policyReason,
          },
          reason,
        });
        await this.repo.insertProposal({
          id: proposalId,
          tenantId: handle.tenantId,
          propertyId: handle.propertyId,
          executionId: handle.id,
          toolCode: def.code,
          arguments: args as Record<string, unknown>,
          context,
          reason,
          evidence: { policy: policyReason },
          risk: def.risk,
          approvalId: approval.id,
          expiresAt: new Date(approval.expiresAt),
        });
        return { status: 'PROPOSED', proposalId, approvalId: approval.id } as const;
      });
    });
  }

  // ---- approvals ----

  /** `AI_ACTION` handler: runs the approved call as proposed, inside the approving transaction. */
  async executeApproved(approval: ApprovalSummary): Promise<void> {
    const scope = { tenantId: approval.tenantId };
    const proposal = await this.repo.proposalOfApproval(scope, approval.id);
    if (!proposal || proposal.status !== 'PENDING')
      throw AppError.conflict('ai.proposal.not_pending');
    const execution = await this.repo.execution(scope, proposal.executionId);
    const def = this.registry.get(proposal.toolCode);
    if (!execution || !def) throw AppError.conflict('ai.proposal.not_executable');
    const c = proposal.context as ProposalContext;
    const handle: ExecutionHandle = {
      id: execution.id,
      tenantId: proposal.tenantId,
      propertyId: proposal.propertyId,
      agentCode: c.agent_code,
      tools: c.tools,
      autonomy: { autoMediumTools: [] },
      locale: c.locale,
      guest: c.guest,
      conversationId: c.conversation_id,
    };
    const at = { tenantId: handle.tenantId, propertyId: handle.propertyId };
    if (
      (await this.flags.isEnabled(killSwitch.agent(handle.agentCode), at)) ||
      (await this.flags.isEnabled(killSwitch.tool(def.code), at))
    )
      throw AppError.forbidden('ai.tool.disabled', { tool: def.code });
    const args = def.input.parse(proposal.arguments);
    const result = await this.asAgent(handle, def, 'APPROVED', approval.id, () =>
      def.handle(args, this.toolContext(handle)),
    );
    await this.repo.updateProposal(scope, proposal.id, {
      status: 'EXECUTED',
      decidedAt: new Date(),
      result: (result ?? null) as Record<string, unknown> | null,
    });
    await this.step(handle, {
      type: 'APPROVAL',
      name: def.code,
      outcome: 'EXECUTED',
      summary: { proposal_id: proposal.id, approval_id: approval.id },
    });
  }

  // ---- acting as the agent ----

  private toolContext(handle: ExecutionHandle): ToolContext {
    return {
      tenantId: handle.tenantId,
      propertyId: handle.propertyId,
      executionId: handle.id,
      agentCode: handle.agentCode,
      locale: handle.locale,
      guest: handle.guest,
      conversationId: handle.conversationId,
    };
  }

  private actorOf(handle: ExecutionHandle): RequestActor {
    return { type: 'AI_AGENT', id: handle.id, tenantId: handle.tenantId, isPlatformAdmin: false };
  }

  /** A fresh request context whose actor is the agent (audit rows, approvals and events name it). */
  private asActor<T>(handle: ExecutionHandle, fn: () => Promise<T>): Promise<T> {
    const actor = this.actorOf(handle);
    return this.ctx.run(
      {
        ...(this.ctx.correlationId ? { correlation_id: this.ctx.correlationId } : {}),
        tenant_id: handle.tenantId,
        property_id: handle.propertyId,
        actor_type: 'AI_AGENT',
        actor_id: actor.id,
      },
      async () => {
        this.actors.set(actor);
        return fn();
      },
    );
  }

  /** Runs a tool handler as the agent, through the ActionGate, inside the cleared execution scope. */
  private asAgent<T>(
    handle: ExecutionHandle,
    def: AiToolDefinition,
    mode: 'AUTO' | 'APPROVED',
    approvalId: string | null,
    fn: () => Promise<T>,
  ): Promise<T> {
    return this.asActor(handle, () =>
      aiExecutionScope.run(
        {
          executionId: handle.id,
          agentCode: handle.agentCode,
          actorId: handle.id,
          tenantId: handle.tenantId,
          propertyId: handle.propertyId,
          permissions: this.registry.permissionsOf(handle.tools),
          tool: def.code,
          risk: def.risk,
          mode,
          approvalId,
        },
        () =>
          this.gate.execute(
            {
              action: def.requiredPermission,
              tenantId: handle.tenantId,
              propertyId: handle.propertyId,
              aiRisk: def.risk,
              actor: this.actorOf(handle),
            },
            fn,
          ),
      ),
    );
  }
}
