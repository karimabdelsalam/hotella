import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { FeatureFlagService } from '@hotella/platform-flags';
import { AppError } from '@hotella/platform-i18n';
import { InjectLogger, type Logger } from '@hotella/platform-observability';
import { ENGINEERING_COPILOT, replyLocale } from '../domain/agents';
import { killSwitch } from '../domain/settings';
import {
  type ClassifiedText,
  MODEL_GATEWAY,
  type ModelGatewayApi,
  type StaffAssistantAnswer,
  type StaffAssistantApi,
  type StaffAssistantInput,
} from '../public';
import { AgentCatalog } from './agent-catalog';
import { parseJsonAnswer, runAgentLoop } from './agent-loop';
import { ContextEngine } from './context-engine';
import { ToolExecutor, type ToolOutcome } from './tools/executor';
import { ToolRegistry } from './tools/registry';

/** The staff agents this runtime serves. */
const STAFF_AGENTS = new Set([ENGINEERING_COPILOT.code]);

const LANGUAGE: Record<'ar' | 'en', string> = {
  ar: 'Answer in Arabic (Egyptian Arabic is fine); keep technical terms, codes and model numbers as written.',
  en: 'Answer in English.',
};

type Source = StaffAssistantAnswer['sources'][number];

/** The documents a tool result carries (`passages[]` with document id, title and version), if any. */
function sourcesOf(outcome: ToolOutcome): Source[] {
  if (outcome.status !== 'OK' || !outcome.result || typeof outcome.result !== 'object') return [];
  const passages = (outcome.result as { passages?: unknown }).passages;
  if (!Array.isArray(passages)) return [];
  return passages.flatMap((p: { document_id?: unknown; title?: unknown; version_no?: unknown }) =>
    typeof p.document_id === 'string' && typeof p.title === 'string'
      ? [{ documentId: p.document_id, title: p.title, versionNo: Number(p.version_no) || 0 }]
      : [],
  );
}

/**
 * Staff-facing assistants (Spec §29, BUILD_PLAN 8.B "Engineering Copilot v1"): one question, one bounded run, one
 * answer for the person who asked. ASSIST only — the agent's tools must all be READ, so nothing it does changes
 * business data; the execution is recorded on behalf of the staff member with every model call and tool call.
 */
@Injectable()
export class StaffAssistantRuntime implements StaffAssistantApi {
  constructor(
    private readonly agents: AgentCatalog,
    private readonly context: ContextEngine,
    private readonly executor: ToolExecutor,
    private readonly registry: ToolRegistry,
    private readonly flags: FeatureFlagService,
    @Inject(MODEL_GATEWAY) private readonly gateway: ModelGatewayApi,
    @InjectLogger() private readonly logger: Logger,
  ) {}

  async ask(input: StaffAssistantInput): Promise<StaffAssistantAnswer> {
    if (!STAFF_AGENTS.has(input.agentCode)) throw AppError.notFound('ai.agent.not_found');
    const agent = await this.agents.published(input.agentCode);
    // ASSIST: a staff assistant that could act would need the proposal flow; refuse such a definition outright.
    if (agent.tools.some((t) => this.registry.get(t) && this.registry.get(t)!.risk !== 'READ'))
      throw AppError.conflict('ai.agent.not_read_only');
    const locale = replyLocale(input.question, input.locale);
    const handle = await this.executor.start({
      tenantId: input.tenantId,
      propertyId: input.propertyId,
      agentCode: agent.code,
      agentVersionId: agent.versionId,
      tools: agent.tools,
      autonomy: agent.autonomy,
      locale,
      guest: null,
      conversationId: null,
      trigger: 'STAFF',
      on: { type: 'USER', id: input.userId },
    });
    const sources: Source[] = [];
    const result = (outcome: StaffAssistantAnswer['outcome'], answer: string | null = null) => ({
      executionId: handle.id,
      outcome,
      answer,
      locale,
      sources: [...new Map(sources.map((s) => [`${s.documentId}:${s.versionNo}`, s])).values()],
    });
    try {
      const at = { tenantId: input.tenantId, propertyId: input.propertyId };
      if (await this.flags.isEnabled(killSwitch.agent(agent.code), at)) {
        await this.executor.step(handle, {
          type: 'DECISION',
          name: 'kill_switch',
          outcome: 'DISABLED',
        });
        await this.executor.finish(handle, 'COMPLETED');
        return result('DISABLED');
      }
      const built = await this.context.build({
        tenantId: input.tenantId,
        propertyId: input.propertyId,
        guest: null,
        conversationId: null,
        locale,
        providers: agent.context.providers,
        recentMessages: 0,
      });
      await this.executor.step(handle, {
        type: 'CONTEXT',
        name: 'context',
        outcome: 'OK',
        summary: { providers: built.summary, focus: input.focus?.length ?? 0, locale },
      });
      const schema = z.object({ answer: z.string().min(1).max(agent.output.maxReplyChars) });
      const system: ClassifiedText[] = [
        ...agent.layers.map((l) => ({ text: l.text, dataClass: 'PUBLIC' as const })),
        { text: LANGUAGE[locale], dataClass: 'PUBLIC' },
        { text: 'Answer with JSON {"answer": string}.', dataClass: 'PUBLIC' },
        ...built.parts,
        ...(input.focus ?? []).map((f) => ({
          text: `<context name="focus">\n${f.text}\n</context>`,
          dataClass: f.dataClass,
        })),
      ];
      const output = await runAgentLoop(
        { gateway: this.gateway, executor: this.executor, registry: this.registry },
        {
          handle,
          agent,
          system,
          // The question may quote a guest.
          history: [{ role: 'user', content: input.question, dataClass: 'CONFIDENTIAL' }],
          output: { name: 'staff_answer', schema },
          // A model that answers in plain text is taken at its word.
          parse: (content) =>
            parseJsonAnswer(content, schema) ??
            (content && !content.trim().startsWith('{')
              ? { answer: content.trim().slice(0, agent.output.maxReplyChars) }
              : null),
          describe: (a) => ({ outcome: 'ANSWER', summary: { answer_chars: a.answer.length } }),
          onTool: (_tool, outcome) => sources.push(...sourcesOf(outcome)),
        },
      );
      await this.executor.step(handle, {
        type: 'RESPONSE',
        name: 'answer',
        outcome: output ? 'ANSWERED' : 'FAILED',
        summary: { locale, sources: sources.length },
      });
      await this.executor.finish(handle, output ? 'COMPLETED' : 'FAILED');
      return output ? result('ANSWERED', output.answer) : result('FAILED');
    } catch (e) {
      this.logger.error({ err: e, execution_id: handle.id }, 'staff assistant run failed');
      await this.executor.finish(handle, 'FAILED').catch(() => undefined);
      return result('FAILED');
    }
  }
}
