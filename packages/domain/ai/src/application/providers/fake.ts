import type {
  CompletionRequest,
  CompletionResult,
  EmbeddingResult,
  ModelProvider,
  ProviderContext,
} from './types';
import { ModelProviderError } from './types';

export type FakeReply =
  Partial<CompletionResult> | ((request: CompletionRequest) => Partial<CompletionResult>);

/**
 * Deterministic provider for tests, CI and local development (ADR-0018): answers from a script (in order, or by a
 * function of the request), records every request, and can be told to fail. Embeddings are a stable hash of the text,
 * so similar inputs are not similar — retrieval tests rely on keyword and metadata ranking, or provide their own.
 */
export class FakeModelProvider implements ModelProvider {
  readonly kind = 'FAKE' as const;
  readonly requests: Array<{ providerCode: string; request: CompletionRequest }> = [];
  private readonly script: FakeReply[] = [];
  failWith: ModelProviderError | null = null;
  /** Fail only for this provider code (fallback tests). */
  failFor: string | null = null;

  reply(...replies: FakeReply[]): this {
    this.script.push(...replies);
    return this;
  }
  reset(): void {
    this.requests.length = 0;
    this.script.length = 0;
    this.failWith = null;
    this.failFor = null;
  }

  async complete(ctx: ProviderContext, request: CompletionRequest): Promise<CompletionResult> {
    if (this.failWith && (!this.failFor || this.failFor === ctx.providerCode)) throw this.failWith;
    this.requests.push({ providerCode: ctx.providerCode, request });
    const next = this.script.shift();
    const partial = typeof next === 'function' ? next(request) : (next ?? {});
    const toolCalls = partial.toolCalls ?? [];
    return {
      content: partial.content ?? (toolCalls.length ? null : 'OK'),
      toolCalls,
      finishReason: partial.finishReason ?? (toolCalls.length ? 'tool_calls' : 'stop'),
      usage: partial.usage ?? { input: 100, output: 20, cached: 0 },
    };
  }

  async embed(
    _ctx: ProviderContext,
    req: { model: string; inputs: readonly string[] },
  ): Promise<EmbeddingResult> {
    return {
      vectors: req.inputs.map((t) => hashVector(t)),
      usage: { input: req.inputs.join(' ').length, output: 0, cached: 0 },
    };
  }
}

/** 16-dimensional, unit-length vector derived from the text (deterministic). */
export function hashVector(text: string, dims = 16): number[] {
  const v = new Array<number>(dims).fill(0);
  for (let i = 0; i < text.length; i++) v[i % dims]! += ((text.charCodeAt(i) * 31 + i) % 97) / 97;
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

export { ModelProviderError };
