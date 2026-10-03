import { Injectable } from '@nestjs/common';
import { AnthropicProvider } from './providers/anthropic';
import { OpenAiCompatibleProvider } from './providers/openai-compatible';
import type { ModelProvider, ProviderKind } from './providers/types';

/** The adapters this process knows, by kind; tests replace one with a fake or a recorder. */
@Injectable()
export class ModelProviderRegistry {
  private readonly byKind = new Map<ProviderKind, ModelProvider>([
    ['OPENAI_COMPATIBLE', new OpenAiCompatibleProvider()],
    ['ANTHROPIC', new AnthropicProvider()],
  ]);

  register(provider: ModelProvider): void {
    this.byKind.set(provider.kind, provider);
  }
  get(kind: ProviderKind): ModelProvider | undefined {
    return this.byKind.get(kind);
  }
}
