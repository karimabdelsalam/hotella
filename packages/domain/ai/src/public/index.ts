/** The ONLY surface other bounded contexts may import from this package (ADR-0001). */

export type DataClass = 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'SENSITIVE' | 'RESTRICTED';
export type Capability =
  | 'REASONING_HIGH'
  | 'FAST_CLASSIFICATION'
  | 'VISION'
  | 'TRANSLATION'
  | 'EMBEDDING'
  | 'AUDIO'
  | 'STRUCTURED_OUTPUT';

/** A piece of context labelled with the class of data it contains (ADR-0018 egress policy). */
export interface ClassifiedText {
  readonly text: string;
  readonly dataClass: DataClass;
}

export interface GatewayToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

export type GatewayMessage =
  | { readonly role: 'user'; readonly content: string; readonly dataClass: DataClass }
  | {
      readonly role: 'assistant';
      readonly content: string | null;
      readonly toolCalls?: readonly GatewayToolCall[];
      readonly dataClass: DataClass;
    }
  | {
      readonly role: 'tool';
      readonly toolCallId: string;
      readonly content: string;
      readonly dataClass: DataClass;
    };

export interface GatewayCompletionInput {
  readonly tenantId: string;
  readonly propertyId?: string | null;
  readonly capability: Capability;
  /** Instructions and context parts; parts a provider may not receive are left out. */
  readonly system: readonly ClassifiedText[];
  readonly messages: readonly GatewayMessage[];
  readonly tools?: ReadonlyArray<{
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  }>;
  readonly jsonSchema?: { readonly name: string; readonly schema: Record<string, unknown> } | null;
  readonly maxTokens?: number;
  readonly executionId?: string | null;
  readonly agentCode?: string | null;
}

export interface GatewayCompletion {
  readonly content: string | null;
  readonly toolCalls: readonly GatewayToolCall[];
  readonly finishReason: 'stop' | 'tool_calls' | 'length' | 'other';
  readonly provider: string;
  readonly model: string;
  readonly modelCallId: string;
  readonly costMinor: number;
  readonly fallbackFrom: string | null;
}

/** The one way to call a model (Spec §28): capabilities, routing, fallback, egress policy, cost, kill switches. */
export interface ModelGatewayApi {
  complete(input: GatewayCompletionInput): Promise<GatewayCompletion>;
  embed(input: {
    readonly tenantId: string;
    readonly propertyId?: string | null;
    readonly texts: readonly ClassifiedText[];
  }): Promise<{ readonly vectors: readonly (readonly number[])[]; readonly model: string }>;
}

/** Registered symbol: stays identical even if a bundler or test runner loads this entry twice. */
export const MODEL_GATEWAY = Symbol.for('hotella.domain.ai.gateway');

export { AI_MANIFEST } from '../manifest';
