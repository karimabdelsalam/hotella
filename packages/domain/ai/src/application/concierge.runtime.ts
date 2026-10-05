import { Inject, Injectable, Optional } from '@nestjs/common';
import { ENTITLEMENT_API, type EntitlementPublicApi } from '@hotella/domain-licensing/public';
import {
  COMMUNICATIONS_API,
  type CommunicationsPublicApi,
} from '@hotella/domain-communications/public';
import { GUEST_API, type GuestPublicApi } from '@hotella/domain-guest/public';
import { newId, TransactionRunner } from '@hotella/platform-database';
import { FeatureFlagService } from '@hotella/platform-flags';
import { InjectLogger, type Logger } from '@hotella/platform-observability';
import {
  AGENT_ENTITLEMENTS,
  GUEST_CONCIERGE,
  type HandoffReason,
  type ReplyLocale,
  replyLocale,
} from '../domain/agents';
import { compareRuns } from '../domain/release';
import { killSwitch } from '../domain/settings';
import { EvaluationRepositories } from '../infrastructure/evaluation-repositories';
import {
  type ClassifiedText,
  type GatewayMessage,
  MODEL_GATEWAY,
  type ModelGatewayApi,
} from '../public';
import { AgentCatalog, type PublishedAgent } from './agent-catalog';
import { runAgentLoop } from './agent-loop';
import { ContextEngine } from './context-engine';
import { type ExecutionHandle, ToolExecutor } from './tools/executor';
import { DryRunExecutor } from './tools/dry-run.executor';
import { ToolRegistry } from './tools/registry';
import { conversationContract } from './agent-contracts';
import { type CallerAssurance, toolsFor } from '../domain/caller-assurance';

export type ConciergeOutcome = 'SKIPPED' | 'REPLIED' | 'DRAFTED' | 'HANDED_OFF' | 'FAILED';

/** The agent the concierge runtime runs (tests run their own agent through the same runtime). */
export const CONCIERGE_AGENT = Symbol.for('hotella.domain.ai.concierge-agent');

interface Conversed {
  readonly output: { reply: string; handoff: HandoffReason | null } | null;
  readonly system: readonly ClassifiedText[];
  readonly history: readonly GatewayMessage[];
  readonly tools: readonly string[];
}

/**
 * The Guest Concierge v1 runtime (Spec §23–§24, BUILD_PLAN 6.B): triggered by a guest message in a verified stay
 * conversation whose AI mode is AUTO (reply) or ASSIST (draft for staff). A bounded loop of model call → tool calls →
 * model call; the reply is structured output `{ reply, handoff }`. The language follows the guest's message. Every
 * step is recorded on the execution; replies go out through the `communication.send_message` tool (ActionGate), drafts
 * and hand-offs through the comms public API as the AI actor — the runtime writes no business table.
 */
@Injectable()
export class ConciergeRuntime {
  constructor(
    private readonly agents: AgentCatalog,
    private readonly context: ContextEngine,
    private readonly executor: ToolExecutor,
    private readonly registry: ToolRegistry,
    private readonly flags: FeatureFlagService,
    @Inject(MODEL_GATEWAY) private readonly gateway: ModelGatewayApi,
    @Inject(COMMUNICATIONS_API) private readonly comms: CommunicationsPublicApi,
    @Inject(GUEST_API) private readonly guests: GuestPublicApi,
    @InjectLogger() private readonly logger: Logger,
    private readonly tx: TransactionRunner,
    @Optional()
    @Inject(ENTITLEMENT_API)
    private readonly entitlements?: EntitlementPublicApi,
    @Optional() @Inject(CONCIERGE_AGENT) private readonly agentCode: string = GUEST_CONCIERGE.code,
    @Optional() private readonly evaluations?: EvaluationRepositories,
  ) {}

  async onGuestMessage(input: {
    readonly tenantId: string;
    readonly conversationId: string;
    readonly messageId: string;
  }): Promise<ConciergeOutcome> {
    const conversation = await this.comms.conversationForAi(input.tenantId, input.conversationId);
    if (
      !conversation ||
      conversation.aiMode === 'OFF' ||
      !conversation.stayId ||
      !conversation.guestId ||
      conversation.status === 'HANDED_OFF' ||
      conversation.status === 'CLOSED'
    )
      return 'SKIPPED';
    // Only the latest guest message is answered: a newer one has its own run.
    const recent = await this.comms.recentMessages(input.tenantId, conversation.id, 5);
    const latestInbound = [...recent].reverse().find((m) => m.direction === 'INBOUND');
    if (!latestInbound || latestInbound.id !== input.messageId) return 'SKIPPED';

    // The version that answers this conversation (a canary takes a fixed share), and a shadow to try beside it. A
    // room-context caller (ADR-0025, Q27) gets the room-context tools only — the allowlist binds, not the prompt.
    const assurance: CallerAssurance = latestInbound.assurance;
    const selected = await this.agents.select(this.agentCode, conversation.id);
    const agent = { ...selected.agent, tools: toolsFor(selected.agent.tools, assurance) };
    const shadow = selected.shadow
      ? { ...selected.shadow, tools: toolsFor(selected.shadow.tools, assurance) }
      : null;
    const member = (await this.guests.stayParty(input.tenantId, conversation.stayId)).find(
      (m) => m.guestId === conversation.guestId,
    );
    const locale = replyLocale(latestInbound.body ?? '', member?.primaryLocale ?? 'ar');
    const handle = await this.executor.start({
      tenantId: input.tenantId,
      propertyId: conversation.propertyId,
      agentCode: agent.code,
      agentVersionId: agent.versionId,
      tools: agent.tools,
      autonomy: agent.autonomy,
      locale,
      guest: { guestId: conversation.guestId, stayId: conversation.stayId },
      conversationId: conversation.id,
      trigger: 'MESSAGE',
      on: { type: 'GUEST', id: conversation.guestId },
    });
    const assist = conversation.aiMode === 'ASSIST';
    let conversed: Conversed | null = null;
    const outcome = await (async (): Promise<ConciergeOutcome> => {
      try {
        const at = { tenantId: input.tenantId, propertyId: conversation.propertyId };
        const entitlement = AGENT_ENTITLEMENTS[agent.code];
        if (
          entitlement &&
          this.entitlements &&
          !(await this.entitlements.can(at.tenantId, at.propertyId, entitlement))
        ) {
          // Not in the hotel's licence (Spec §59): a person answers, exactly as with a disabled guest AI.
          await this.executor.step(handle, {
            type: 'DECISION',
            name: 'entitlement',
            outcome: 'NOT_ENTITLED',
          });
          return await this.finish(
            handle,
            assist ? 'SKIPPED' : await this.handOff(handle, 'AI_FAILURE'),
          );
        }
        if (
          (await this.flags.isEnabled(killSwitch.guestAi, at)) ||
          (await this.flags.isEnabled(killSwitch.agent(agent.code), at))
        ) {
          await this.executor.step(handle, {
            type: 'DECISION',
            name: 'kill_switch',
            outcome: 'DISABLED',
          });
          // A disabled guest AI hands the guest to a person (auto mode); in assist mode staff already have it.
          return await this.finish(
            handle,
            assist ? 'SKIPPED' : await this.handOff(handle, 'AI_FAILURE'),
          );
        }
        conversed = await this.converse(handle, agent, locale, assurance);
        const output = conversed.output;
        if (!output) return await this.finish(handle, await this.handOff(handle, 'AI_FAILURE'));
        if (assist) {
          if (output.reply) {
            const { draftId } = await this.executor.actAs(handle, () =>
              this.comms.saveDraft({
                tenantId: handle.tenantId,
                conversationId: conversation.id,
                agentCode: agent.code,
                executionId: handle.id,
                body: output.reply,
              }),
            );
            await this.executor.step(handle, {
              type: 'RESPONSE',
              name: 'draft',
              outcome: 'DRAFTED',
              summary: { draft_id: draftId, locale, handoff: output.handoff },
            });
          }
          return await this.finish(
            handle,
            output.handoff ? await this.handOff(handle, output.handoff) : 'DRAFTED',
          );
        }
        if (output.reply) {
          const sent = await this.executor.invoke(handle, {
            tool: 'communication.send_message',
            arguments: { body: output.reply },
          });
          await this.executor.step(handle, {
            type: 'RESPONSE',
            name: 'reply',
            outcome: sent.status,
            summary: { locale, handoff: output.handoff },
          });
          if (sent.status !== 'OK')
            return await this.finish(handle, await this.handOff(handle, 'AI_FAILURE'));
        }
        return await this.finish(
          handle,
          output.handoff ? await this.handOff(handle, output.handoff) : 'REPLIED',
        );
      } catch (e) {
        this.logger.error(
          { err: e, execution_id: handle.id, conversation_id: conversation.id },
          'concierge run failed',
        );
        await this.handOff(handle, 'AI_FAILURE').catch(() => undefined);
        await this.executor.finish(handle, 'FAILED');
        return 'FAILED';
      }
    })();
    // After the guest was answered: the shadow version runs on the same input, never answering or acting.
    if (shadow && conversed)
      await this.runShadow(handle, shadow, locale, conversed).catch((err: unknown) =>
        this.logger.warn({ err, execution_id: handle.id }, 'shadow run failed'),
      );
    return outcome;
  }

  /**
   * A shadow run (BUILD_PLAN 12.2): the candidate version sees exactly what the active one saw; READ tools run for real,
   * anything else comes back as the policy would decide without being performed; no reply, draft or hand-off. What it
   * did is compared with the active run and kept as a SHADOW result.
   */
  private async runShadow(
    active: ExecutionHandle,
    shadow: PublishedAgent,
    locale: ReplyLocale,
    conversed: Conversed,
  ): Promise<void> {
    if (!this.evaluations) return;
    const handle = await this.executor.start({
      tenantId: active.tenantId,
      propertyId: active.propertyId,
      agentCode: shadow.code,
      agentVersionId: shadow.versionId,
      tools: shadow.tools,
      autonomy: shadow.autonomy,
      locale,
      guest: active.guest,
      conversationId: active.conversationId,
      trigger: 'SHADOW',
      on: { type: 'GUEST', id: active.guest?.guestId ?? null },
    });
    const contract = conversationContract(shadow, locale);
    const dry = new DryRunExecutor(this.executor, this.registry, {}, this.executor);
    let answer: { reply: string; handoff: HandoffReason | null } | null = null;
    try {
      answer = await runAgentLoop(
        { gateway: this.gateway, executor: dry, registry: this.registry },
        {
          handle,
          agent: shadow,
          system: [...contract.system, ...conversed.system],
          history: conversed.history,
          output: contract.output,
          parse: contract.parse,
          describe: contract.describe,
        },
      );
    } finally {
      await this.executor.finish(handle, answer ? 'COMPLETED' : 'FAILED');
    }
    const runtimeTools = new Set(shadow.output.runtimeTools);
    const compared = compareRuns(
      {
        tools: conversed.tools.filter((t) => !runtimeTools.has(t)),
        handoff: conversed.output?.handoff ?? null,
        answered: conversed.output !== null,
      },
      {
        tools: dry.calls.map((c) => c.tool).filter((t) => !runtimeTools.has(t)),
        handoff: answer?.handoff ?? null,
        answered: answer !== null,
      },
    );
    const repo = this.evaluations;
    await this.tx.run(async () => {
      const run =
        (await repo.openShadowRun(shadow.versionId, active.tenantId)) ??
        (await repo.insertRun({
          id: newId(),
          tenantId: active.tenantId,
          propertyId: active.propertyId,
          setId: null,
          agentCode: shadow.code,
          agentVersionId: shadow.versionId,
          mode: 'SHADOW',
          requestedByType: 'SYSTEM',
          requestedById: null,
        }));
      await repo.insertResult({
        id: newId(),
        tenantId: active.tenantId,
        runId: run.id,
        caseId: null,
        outcome: compared.outcome,
        checks: [...compared.checks],
        executionId: handle.id,
        comparedExecutionId: active.id,
      });
      await repo.refreshShadowTotals(run.id);
    });
  }

  /** The bounded loop: model → tools → model, until a structured answer or the step budget runs out. */
  private async converse(
    handle: ExecutionHandle,
    agent: PublishedAgent,
    locale: ReplyLocale,
    assurance: CallerAssurance,
  ): Promise<Conversed> {
    const built = await this.context.build({
      assurance,
      tenantId: handle.tenantId,
      propertyId: handle.propertyId,
      guest: handle.guest,
      conversationId: handle.conversationId,
      locale,
      providers: agent.context.providers,
      recentMessages: agent.context.recentMessages,
    });
    await this.executor.step(handle, {
      type: 'CONTEXT',
      name: 'context',
      outcome: 'OK',
      // Who was speaking (ADR-0025): a room-context caller ran with the room-context tools only.
      summary: {
        providers: built.summary,
        history: built.history.length,
        locale,
        assurance,
        tools: agent.tools.length,
      },
    });
    const contract = conversationContract(agent, locale);
    const system: ClassifiedText[] = [...contract.system, ...built.parts];
    const tools: string[] = [];
    const output = await runAgentLoop(
      { gateway: this.gateway, executor: this.executor, registry: this.registry },
      {
        handle,
        agent,
        system,
        history: built.history,
        output: contract.output,
        parse: contract.parse,
        describe: contract.describe,
        onTool: (tool) => tools.push(tool),
      },
    );
    // What the shadow sees: the same context parts and history (its own instructions replace the agent's).
    return { output, system: built.parts, history: built.history, tools };
  }

  private async handOff(handle: ExecutionHandle, reason: HandoffReason): Promise<'HANDED_OFF'> {
    await this.executor.actAs(handle, () =>
      this.comms.handOff({
        tenantId: handle.tenantId,
        conversationId: handle.conversationId!,
        reason,
      }),
    );
    await this.executor.step(handle, {
      type: 'DECISION',
      name: 'handoff',
      outcome: 'HANDED_OFF',
      summary: { reason },
    });
    return 'HANDED_OFF';
  }

  private async finish(
    handle: ExecutionHandle,
    outcome: ConciergeOutcome,
  ): Promise<ConciergeOutcome> {
    await this.executor.finish(
      handle,
      outcome === 'HANDED_OFF' ? 'HANDED_OFF' : outcome === 'FAILED' ? 'FAILED' : 'COMPLETED',
    );
    return outcome;
  }
}
