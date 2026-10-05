import {
  callModelApi,
  type CompletionRequest,
  type CompletionResult,
  type EmbeddingResult,
  type FetchLike,
  MODEL_TIMEOUT_MS,
  type ModelProvider,
  ModelProviderError,
  parseArguments,
  type ProviderContext,
  type SpeechResult,
  type TranscriptionResult,
} from './types';

const DEFAULT_BASE = 'https://api.openai.com/v1';

interface OaiResponse {
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: string | null;
      tool_calls?: Array<{ id: string; function?: { name?: string; arguments?: string } }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

/**
 * The OpenAI Chat Completions / Embeddings wire format (ADR-0018): OpenAI itself and on-prem servers that speak it
 * (vLLM, Ollama, LM Studio, text-generation-inference). The base URL decides which; a local server may need no key.
 */
export class OpenAiCompatibleProvider implements ModelProvider {
  readonly kind = 'OPENAI_COMPATIBLE' as const;
  constructor(private readonly fetchFn: FetchLike = (u, i) => fetch(u, i)) {}

  private async headers(ctx: ProviderContext): Promise<Record<string, string>> {
    const key = await ctx.credential();
    return {
      'content-type': 'application/json',
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    };
  }

  async complete(ctx: ProviderContext, req: CompletionRequest): Promise<CompletionResult> {
    const body = {
      model: req.model,
      messages: req.messages.map((m) => {
        switch (m.role) {
          case 'tool':
            return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
          case 'assistant':
            return {
              role: 'assistant',
              content: m.content,
              ...(m.toolCalls?.length
                ? {
                    tool_calls: m.toolCalls.map((c) => ({
                      id: c.id,
                      type: 'function',
                      function: { name: c.name, arguments: JSON.stringify(c.arguments) },
                    })),
                  }
                : {}),
            };
          case 'user':
            return m.images?.length
              ? {
                  role: 'user',
                  content: [
                    ...m.images.map((image) => ({
                      type: 'image_url',
                      image_url: { url: `data:${image.mediaType};base64,${image.base64}` },
                    })),
                    { type: 'text', text: m.content },
                  ],
                }
              : { role: 'user', content: m.content };
          default:
            return { role: m.role, content: m.content };
        }
      }),
      ...(req.tools?.length
        ? {
            tools: req.tools.map((t) => ({
              type: 'function',
              function: { name: t.name, description: t.description, parameters: t.parameters },
            })),
          }
        : {}),
      ...(req.jsonSchema
        ? {
            response_format: {
              type: 'json_schema',
              json_schema: {
                name: req.jsonSchema.name,
                schema: req.jsonSchema.schema,
                strict: false,
              },
            },
          }
        : {}),
      ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    };
    const res = (await callModelApi(this.fetchFn, `${base(ctx)}/chat/completions`, {
      method: 'POST',
      headers: await this.headers(ctx),
      body: JSON.stringify(body),
    })) as OaiResponse;
    const choice = res?.choices?.[0];
    if (!choice?.message) throw new ModelProviderError('BAD_RESPONSE', true);
    const toolCalls = (choice.message.tool_calls ?? []).map((c) => ({
      id: c.id,
      name: c.function?.name ?? '',
      arguments: parseArguments(c.function?.arguments),
    }));
    return {
      content: choice.message.content ?? null,
      toolCalls,
      finishReason:
        choice.finish_reason === 'tool_calls' || toolCalls.length
          ? 'tool_calls'
          : choice.finish_reason === 'length'
            ? 'length'
            : choice.finish_reason === 'stop'
              ? 'stop'
              : 'other',
      usage: {
        input: res.usage?.prompt_tokens ?? 0,
        output: res.usage?.completion_tokens ?? 0,
        cached: res.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      },
    };
  }

  async embed(
    ctx: ProviderContext,
    req: { model: string; inputs: readonly string[] },
  ): Promise<EmbeddingResult> {
    const res = (await callModelApi(this.fetchFn, `${base(ctx)}/embeddings`, {
      method: 'POST',
      headers: await this.headers(ctx),
      body: JSON.stringify({ model: req.model, input: req.inputs }),
    })) as {
      data?: Array<{ index: number; embedding: number[] }>;
      usage?: { prompt_tokens?: number };
    };
    if (!res?.data) throw new ModelProviderError('BAD_RESPONSE', true);
    const vectors = [...res.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
    return { vectors, usage: { input: res.usage?.prompt_tokens ?? 0, output: 0, cached: 0 } };
  }

  /** `/audio/transcriptions` (what local Whisper servers expose): multipart, the audio never touches disk here. */
  async transcribe(
    ctx: ProviderContext,
    req: { model: string; audio: Uint8Array; mimeType: string; language: string | null },
  ): Promise<TranscriptionResult> {
    const form = new FormData();
    form.append('model', req.model);
    form.append('file', new Blob([req.audio], { type: req.mimeType }), 'utterance');
    if (req.language) form.append('language', req.language.slice(0, 2));
    const key = await ctx.credential();
    const res = (await callModelApi(this.fetchFn, `${base(ctx)}/audio/transcriptions`, {
      method: 'POST',
      headers: key ? { authorization: `Bearer ${key}` } : {},
      body: form,
    })) as { text?: string; language?: string };
    if (typeof res?.text !== 'string') throw new ModelProviderError('BAD_RESPONSE', true);
    return {
      text: res.text.trim(),
      language: res.language ?? req.language,
      usage: { input: 0, output: 0, cached: 0 },
    };
  }

  /** `/audio/speech`: the answer is the audio itself. */
  async synthesize(
    ctx: ProviderContext,
    req: { model: string; text: string; language: string | null; voice: string | null },
  ): Promise<SpeechResult> {
    const res = await fetchWithTimeout(this.fetchFn, `${base(ctx)}/audio/speech`, {
      method: 'POST',
      headers: await this.headers(ctx),
      body: JSON.stringify({
        model: req.model,
        input: req.text,
        voice: req.voice ?? 'alloy',
        response_format: 'mp3',
      }),
    });
    if (res.status === 401 || res.status === 403)
      throw new ModelProviderError('AUTH_FAILED', false);
    if (res.status === 429) throw new ModelProviderError('RATE_LIMITED', true);
    if (!res.ok)
      throw new ModelProviderError(
        res.status >= 500 ? 'UNAVAILABLE' : 'REJECTED',
        res.status >= 500,
      );
    return {
      audio: new Uint8Array(await res.arrayBuffer()),
      mimeType: res.headers.get('content-type') ?? 'audio/mpeg',
      usage: { input: req.text.length, output: 0, cached: 0 },
    };
  }
}

async function fetchWithTimeout(fetchFn: FetchLike, url: string, init: RequestInit) {
  try {
    return await fetchFn(url, { ...init, signal: AbortSignal.timeout(MODEL_TIMEOUT_MS) });
  } catch (e) {
    const name = (e as { name?: string }).name;
    throw new ModelProviderError(
      name === 'TimeoutError' || name === 'AbortError' ? 'TIMEOUT' : 'UNAVAILABLE',
      true,
    );
  }
}

function base(ctx: ProviderContext): string {
  return (ctx.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '');
}
