import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  COMMUNICATIONS_API,
  type CommunicationsPublicApi,
} from '@hotella/domain-communications/public';
import { GUEST_API, type GuestPublicApi } from '@hotella/domain-guest/public';
import { FeatureFlagService } from '@hotella/platform-flags';
import { AppError } from '@hotella/platform-i18n';
import { InjectLogger, type Logger } from '@hotella/platform-observability';
import {
  GUEST_CONCIERGE,
  HANDOFF_REASONS,
  type HandoffReason,
  replyLocale,
} from '../domain/agents';
import { killSwitch } from '../domain/settings';
import {
  type ClassifiedText,
  type GatewayCompletion,
  type GatewayMessage,
  MODEL_GATEWAY,
  type ModelGatewayApi,
} from '../public';
import { AgentCatalog, type PublishedAgent } from './agent-catalog';
import { ContextEngine } from './context-engine';
import { type ExecutionHandle, ToolExecutor } from './tools/executor';
import { ToolRegistry } from './tools/registry';

export type ConciergeOutcome = 'SKIPPED' | 'REPLIED' | 'DRAFTED' | 'HANDED_OFF' | 'FAILED';

const LANGUAGE: Record<'ar' | 'en', string> = {
  ar: 'Reply in Arabic, in the same dialect and tone the guest used (Egyptian Arabic is fine).',
  en: 'Reply in English.',
};

/** Tool results and messages are capped before they go back to the model. */
const MAX_TOOL_RESULT_CHARS = 6000;

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

    const agent = await this.agents.published(GUEST_CONCIERGE.code);
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
    try {
      const at = { tenantId: input.tenantId, propertyId: conversation.propertyId };
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
      const output = await this.converse(handle, agent, locale);
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
  }

  /** The bounded loop: model → tools → model, until a structured answer or the step budget runs out. */
  private async converse(
    handle: ExecutionHandle,
    agent: PublishedAgent,
    locale: 'ar' | 'en',
  ): Promise<{ reply: string; handoff: HandoffReason | null } | null> {
    const built = await this.context.build({
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
      summary: { providers: built.summary, history: built.history.length, locale },
    });
    const outputSchema = z.object({
      reply: z.string().max(agent.output.maxReplyChars),
      handoff: z.enum(HANDOFF_REASONS).nullable(),
    });
    const system: ClassifiedText[] = [
      ...agent.layers.map((l) => ({ text: l.text, dataClass: 'PUBLIC' as const })),
      { text: LANGUAGE[locale], dataClass: 'PUBLIC' },
      {
        text: `Answer with JSON {"reply": string, "handoff": null | one of ${agent.output.handoffReasons.join(', ')}}. Use "handoff" when a person must take over; "reply" may then tell the guest that a colleague will help.`,
        dataClass: 'PUBLIC',
      },
      ...built.parts,
    ];
    const tools = this.registry.forModel(
      agent.tools.filter((t) => !agent.output.runtimeTools.includes(t)),
    );
    const turns: GatewayMessage[] = [];
    for (let step = 0; step < agent.maxSteps; step++) {
      let completion: GatewayCompletion;
      const started = Date.now();
      try {
        completion = await this.gateway.complete({
          tenantId: handle.tenantId,
          propertyId: handle.propertyId,
          capability: agent.capability,
          system,
          messages: [...built.history, ...turns],
          tools,
          jsonSchema: {
            name: 'concierge_reply',
            schema: z.toJSONSchema(outputSchema) as Record<string, unknown>,
          },
          executionId: handle.id,
          agentCode: agent.code,
        });
      } catch (e) {
        await this.executor.step(handle, {
          type: 'MODEL_CALL',
          name: agent.capability,
          outcome: e instanceof AppError ? e.code : 'ERROR',
          latencyMs: Date.now() - started,
        });
        return null;
      }
      await this.executor.step(handle, {
        type: 'MODEL_CALL',
        name: agent.capability,
        outcome: completion.finishReason.toUpperCase(),
        summary: {
          provider: completion.provider,
          model: completion.model,
          model_call_id: completion.modelCallId,
          fallback_from: completion.fallbackFrom,
          tool_calls: completion.toolCalls.length,
          cost_minor: completion.costMinor,
        },
        latencyMs: Date.now() - started,
      });
      if (completion.toolCalls.length > 0) {
        turns.push({
          role: 'assistant',
          content: completion.content,
          toolCalls: completion.toolCalls,
          dataClass: 'CONFIDENTIAL',
        });
        for (const call of completion.toolCalls) {
          const tool = this.registry.fromModelName(call.name);
          const outcome = await this.executor.invoke(handle, {
            tool: tool?.code ?? call.name,
            arguments: call.arguments,
          });
          turns.push({
            role: 'tool',
            toolCallId: call.id,
            content: JSON.stringify(outcome).slice(0, MAX_TOOL_RESULT_CHARS),
            dataClass: 'CONFIDENTIAL',
          });
        }
        continue;
      }
      const parsed = parseOutput(completion.content, outputSchema);
      await this.executor.step(handle, {
        type: 'DECISION',
        name: 'output',
        outcome: parsed ? (parsed.handoff ? 'HANDOFF' : 'ANSWER') : 'UNPARSEABLE',
        summary: parsed ? { handoff: parsed.handoff, reply_chars: parsed.reply.length } : {},
      });
      return parsed;
    }
    await this.executor.step(handle, {
      type: 'DECISION',
      name: 'step_budget',
      outcome: 'EXHAUSTED',
      summary: { max_steps: agent.maxSteps },
    });
    return null;
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

/** The structured answer; a model that answers in plain text is taken at its word (no hand-off). */
function parseOutput<T extends { reply: string; handoff: HandoffReason | null }>(
  content: string | null,
  schema: z.ZodType<T>,
): T | null {
  const text = (content ?? '').trim();
  if (!text) return null;
  const json = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/, '')
    .trim();
  try {
    const parsed = schema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return json.startsWith('{') ? null : ({ reply: text.slice(0, 1000), handoff: null } as T);
  }
}
