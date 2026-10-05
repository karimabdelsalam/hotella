import {
  callModelApi,
  type ChatMessage,
  type CompletionRequest,
  type CompletionResult,
  type FetchLike,
  type ModelProvider,
  ModelProviderError,
  parseArguments,
  type ProviderContext,
} from './types';

const DEFAULT_BASE = 'https://api.anthropic.com';
const API_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 1024;

interface AnthropicResponse {
  stop_reason?: string;
  content?: Array<
    { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown }
  >;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
}

/**
 * The Anthropic Messages API (ADR-0018): system prompt apart from the turns, tool use as content blocks, tool results
 * as user turns. Structured output is asked for as a forced tool whose input is the JSON object.
 */
export class AnthropicProvider implements ModelProvider {
  readonly kind = 'ANTHROPIC' as const;
  constructor(private readonly fetchFn: FetchLike = (u, i) => fetch(u, i)) {}

  async complete(ctx: ProviderContext, req: CompletionRequest): Promise<CompletionResult> {
    const key = await ctx.credential();
    if (!key) throw new ModelProviderError('AUTH_FAILED', false);
    const system = req.messages
      .filter((m): m is Extract<ChatMessage, { role: 'system' }> => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const structured = req.jsonSchema
      ? {
          name: req.jsonSchema.name,
          description: 'Return the answer.',
          input_schema: req.jsonSchema.schema,
        }
      : null;
    const tools = [
      ...(req.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      })),
      ...(structured ? [structured] : []),
    ];
    const body = {
      model: req.model,
      max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(system ? { system } : {}),
      messages: turns(req.messages),
      ...(tools.length ? { tools } : {}),
      ...(structured && !req.tools?.length
        ? { tool_choice: { type: 'tool', name: structured.name } }
        : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    };
    const res = (await callModelApi(
      this.fetchFn,
      `${(ctx.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '')}/v1/messages`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': API_VERSION,
        },
        body: JSON.stringify(body),
      },
    )) as AnthropicResponse;
    if (!res?.content) throw new ModelProviderError('BAD_RESPONSE', true);
    const text = res.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const uses = res.content.filter(
      (b): b is { type: 'tool_use'; id: string; name: string; input: unknown } =>
        b.type === 'tool_use',
    );
    const answer = structured ? uses.find((u) => u.name === structured.name) : undefined;
    const toolCalls = uses
      .filter((u) => u !== answer)
      .map((u) => ({ id: u.id, name: u.name, arguments: parseArguments(u.input) }));
    return {
      content: answer ? JSON.stringify(answer.input) : text || null,
      toolCalls,
      finishReason: toolCalls.length
        ? 'tool_calls'
        : res.stop_reason === 'max_tokens'
          ? 'length'
          : res.stop_reason === 'end_turn' || answer
            ? 'stop'
            : 'other',
      usage: {
        input: res.usage?.input_tokens ?? 0,
        output: res.usage?.output_tokens ?? 0,
        cached: res.usage?.cache_read_input_tokens ?? 0,
      },
    };
  }
}

/** Conversation turns in Anthropic's shape: consecutive tool results become one user turn. */
function turns(messages: readonly ChatMessage[]): unknown[] {
  const out: Array<{ role: 'user' | 'assistant'; content: unknown[] }> = [];
  const push = (role: 'user' | 'assistant', block: unknown) => {
    const last = out.at(-1);
    if (last && last.role === role) last.content.push(block);
    else out.push({ role, content: [block] });
  };
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'user') {
      for (const image of m.images ?? [])
        push('user', {
          type: 'image',
          source: { type: 'base64', media_type: image.mediaType, data: image.base64 },
        });
      push('user', { type: 'text', text: m.content });
    } else if (m.role === 'tool')
      push('user', { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content });
    else {
      if (m.content) push('assistant', { type: 'text', text: m.content });
      for (const c of m.toolCalls ?? [])
        push('assistant', { type: 'tool_use', id: c.id, name: c.name, input: c.arguments });
    }
  }
  return out;
}
