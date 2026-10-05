import { z } from 'zod';
import {
  type BuiltInAgent,
  ENGINEERING_COPILOT,
  HANDOFF_REASONS,
  type HandoffReason,
  type ReplyLocale,
  SHIFT_HANDOVER,
} from '../domain/agents';
import type { ClassifiedText } from '../public';
import type { PublishedAgent } from './agent-catalog';
import { parseJsonAnswer } from './agent-loop';

/**
 * How an agent is spoken to and how its answer is read: the runtimes and the evaluation runner use the same contract,
 * so an evaluated version sees exactly the instructions and answer schema it will see in production (BUILD_PLAN 12.1).
 * CONVERSATION agents (the Guest Concierge) answer `{ reply, handoff }`; ASSIST agents (staff assistants) `{ answer }`.
 */
export type AgentKind = 'CONVERSATION' | 'ASSIST';

/** The staff assistants (ASSIST, read-only tools). */
export const STAFF_AGENT_CODES: ReadonlySet<string> = new Set([
  ENGINEERING_COPILOT.code,
  SHIFT_HANDOVER.code,
]);

export function agentKind(code: string, def?: BuiltInAgent): AgentKind {
  return def?.kind ?? (STAFF_AGENT_CODES.has(code) ? 'ASSIST' : 'CONVERSATION');
}

const CONVERSATION_LANGUAGE: Record<ReplyLocale, string> = {
  ar: 'Reply in Arabic, in the same dialect and tone the guest used (Egyptian Arabic is fine).',
  en: 'Reply in English.',
  it: 'Reply in Italian, politely (Lei).',
  ru: 'Reply in Russian, politely (Вы).',
  de: 'Reply in German, politely (Sie).',
};

const ASSIST_LANGUAGE: Record<ReplyLocale, string> = {
  ar: 'Answer in Arabic (Egyptian Arabic is fine); keep technical terms, codes and model numbers as written.',
  en: 'Answer in English.',
  it: 'Answer in Italian; keep technical terms, codes and model numbers as written.',
  ru: 'Answer in Russian; keep technical terms, codes and model numbers as written.',
  de: 'Answer in German; keep technical terms, codes and model numbers as written.',
};

export interface AgentContract<T> {
  /** The agent's instructions, language and answer format (context parts are added by the caller). */
  readonly system: readonly ClassifiedText[];
  readonly output: { readonly name: string; readonly schema: z.ZodType<T> };
  readonly parse: (content: string | null) => T | null;
  readonly describe: (answer: T) => { outcome: string; summary: Record<string, unknown> };
  /** The answer as an evaluation reads it. */
  readonly answerOf: (answer: T) => { text: string; handoff: HandoffReason | null };
}

export type ConversationAnswer = { reply: string; handoff: HandoffReason | null };

export function conversationContract(
  agent: PublishedAgent,
  locale: ReplyLocale,
): AgentContract<ConversationAnswer> {
  const schema = z.object({
    reply: z.string().max(agent.output.maxReplyChars),
    handoff: z.enum(HANDOFF_REASONS).nullable(),
  });
  return {
    system: [
      ...agent.layers.map((l) => ({ text: l.text, dataClass: 'PUBLIC' as const })),
      { text: CONVERSATION_LANGUAGE[locale], dataClass: 'PUBLIC' },
      {
        text: `Answer with JSON {"reply": string, "handoff": null | one of ${agent.output.handoffReasons.join(', ')}}. Use "handoff" when a person must take over; "reply" may then tell the guest that a colleague will help.`,
        dataClass: 'PUBLIC',
      },
    ],
    output: { name: 'concierge_reply', schema },
    parse: (content) => parseConversation(content, schema),
    describe: (answer) => ({
      outcome: answer.handoff ? 'HANDOFF' : 'ANSWER',
      summary: { handoff: answer.handoff, reply_chars: answer.reply.length },
    }),
    answerOf: (answer) => ({ text: answer.reply, handoff: answer.handoff }),
  };
}

export type AssistAnswer = { answer: string };

export function assistContract(
  agent: PublishedAgent,
  locale: ReplyLocale,
): AgentContract<AssistAnswer> {
  const schema = z.object({ answer: z.string().min(1).max(agent.output.maxReplyChars) });
  return {
    system: [
      ...agent.layers.map((l) => ({ text: l.text, dataClass: 'PUBLIC' as const })),
      { text: ASSIST_LANGUAGE[locale], dataClass: 'PUBLIC' },
      { text: 'Answer with JSON {"answer": string}.', dataClass: 'PUBLIC' },
    ],
    output: { name: 'staff_answer', schema },
    // A model that answers in plain text is taken at its word.
    parse: (content) =>
      parseJsonAnswer(content, schema) ??
      (content && !content.trim().startsWith('{')
        ? { answer: content.trim().slice(0, agent.output.maxReplyChars) }
        : null),
    describe: (a) => ({ outcome: 'ANSWER', summary: { answer_chars: a.answer.length } }),
    answerOf: (a) => ({ text: a.answer, handoff: null }),
  };
}

/** The structured answer; a model that answers in plain text is taken at its word (no hand-off). */
function parseConversation(
  content: string | null,
  schema: z.ZodType<ConversationAnswer>,
): ConversationAnswer | null {
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
    return json.startsWith('{') ? null : { reply: text.slice(0, 1000), handoff: null };
  }
}
