/**
 * Model provider adapters (ADR-0018). Domain code never talks to a vendor: the Model Gateway resolves a capability to
 * a model, applies the egress policy and calls the model's provider through this interface. HTTP only (no vendor
 * SDK); credentials come from the provider row's SecretRef and are never logged or stored.
 */

export type ProviderKind = 'OPENAI_COMPATIBLE' | 'ANTHROPIC' | 'FAKE';

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  /** Parsed JSON arguments as the model produced them (validated by the tool registry, never trusted here). */
  readonly arguments: Record<string, unknown>;
}

export type ChatMessage =
  | { readonly role: 'system'; readonly content: string }
  | { readonly role: 'user'; readonly content: string }
  | {
      readonly role: 'assistant';
      readonly content: string | null;
      readonly toolCalls?: readonly ToolCall[];
    }
  | { readonly role: 'tool'; readonly toolCallId: string; readonly content: string };

export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  /** JSON Schema of the arguments. */
  readonly parameters: Record<string, unknown>;
}

export interface CompletionRequest {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly tools?: readonly ToolSpec[];
  /** Ask for a JSON object matching this JSON Schema (structured output). */
  readonly jsonSchema?: { readonly name: string; readonly schema: Record<string, unknown> } | null;
  readonly maxTokens?: number;
  readonly temperature?: number;
}

export interface Usage {
  readonly input: number;
  readonly output: number;
  readonly cached: number;
}

export interface CompletionResult {
  readonly content: string | null;
  readonly toolCalls: readonly ToolCall[];
  readonly finishReason: 'stop' | 'tool_calls' | 'length' | 'other';
  readonly usage: Usage;
}

export interface EmbeddingResult {
  readonly vectors: readonly (readonly number[])[];
  readonly usage: Usage;
}

/** What an adapter gets for one call: where the provider is and lazy access to its credential. */
export interface ProviderContext {
  readonly providerCode: string;
  readonly baseUrl: string | null;
  /** Resolves the provider's credential (SecretRef); null when the provider needs none (local servers, fake). */
  readonly credential: () => Promise<string | null>;
}

export class ModelProviderError extends Error {
  constructor(
    readonly code:
      | 'UNAVAILABLE'
      | 'TIMEOUT'
      | 'RATE_LIMITED'
      | 'AUTH_FAILED'
      | 'REJECTED'
      | 'CONTEXT_TOO_LONG'
      | 'BAD_RESPONSE',
    readonly retryable: boolean,
  ) {
    super(`model provider error: ${code}`);
    this.name = 'ModelProviderError';
  }
}

export interface ModelProvider {
  readonly kind: ProviderKind;
  complete(ctx: ProviderContext, request: CompletionRequest): Promise<CompletionResult>;
  embed?(
    ctx: ProviderContext,
    request: { model: string; inputs: readonly string[] },
  ): Promise<EmbeddingResult>;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Model calls may take a while (long answers, tool use); still bounded so a hung provider falls back. */
export const MODEL_TIMEOUT_MS = 60_000;

export async function callModelApi(
  fetchFn: FetchLike,
  url: string,
  init: RequestInit,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(MODEL_TIMEOUT_MS) });
  } catch (e) {
    const name = (e as { name?: string }).name;
    throw new ModelProviderError(
      name === 'TimeoutError' || name === 'AbortError' ? 'TIMEOUT' : 'UNAVAILABLE',
      true,
    );
  }
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) throw statusError(res.status, body);
  return body;
}

function statusError(status: number, body: unknown): ModelProviderError {
  const message = JSON.stringify(body ?? '').toLowerCase();
  if (status === 401 || status === 403) return new ModelProviderError('AUTH_FAILED', false);
  if (status === 429) return new ModelProviderError('RATE_LIMITED', true);
  if (status === 408 || status === 504) return new ModelProviderError('TIMEOUT', true);
  if (status >= 500 || status === 529) return new ModelProviderError('UNAVAILABLE', true);
  if (message.includes('context') && (message.includes('length') || message.includes('too long')))
    return new ModelProviderError('CONTEXT_TOO_LONG', false);
  return new ModelProviderError('REJECTED', false);
}

export function parseArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      const v = JSON.parse(raw) as unknown;
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      // fall through
    }
  }
  return {};
}
