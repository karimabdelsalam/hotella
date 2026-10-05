/** The ONLY surface other bounded contexts may import from this package (ADR-0001). */
import type { ZodType } from 'zod';

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

// ---- tools contributed by other contexts (Spec §31) ----

export type AiRisk = 'READ' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

/** Who and where a tool acts for: fixed by the execution, never chosen by the model. */
export interface ToolContext {
  readonly tenantId: string;
  readonly propertyId: string;
  readonly executionId: string;
  readonly agentCode: string;
  /** The language the guest (or staff member) is served in. */
  readonly locale: string;
  /** The guest an execution serves; guest-facing tools act only for them. */
  readonly guest: { readonly guestId: string; readonly stayId: string } | null;
  readonly conversationId: string | null;
}

/**
 * A registered AI tool: a schema the model fills in, a risk level, the permission it needs and a handler that acts only
 * through the owning context's application services (CLAUDE.md rule 12: AI never writes business tables). The tool
 * must also be declared in the owning module's manifest `aiTools`.
 */
export interface AiToolDefinition<I = unknown> {
  /** `<context>.<verb_noun>`. */
  readonly code: string;
  /** What the tool does, for the model (not shown to people). */
  readonly description: string;
  readonly risk: AiRisk;
  readonly requiredPermission: string;
  readonly input: ZodType<I>;
  readonly needs?: { readonly guest?: boolean; readonly conversation?: boolean };
  /** Checked before a proposal is made, so a person is never asked to approve something that cannot happen. */
  readonly precheck?: (args: I, ctx: ToolContext) => Promise<void>;
  readonly handle: (args: I, ctx: ToolContext) => Promise<unknown>;
}

/** Where owning contexts register their tools at module init (like work item kinds). */
export interface AiToolRegistrar {
  register<I>(tool: AiToolDefinition<I>): void;
}
export const AI_TOOL_REGISTRY = Symbol.for('hotella.domain.ai.tools');

// ---- staff-facing assistants (Spec §29, ASSIST) ----

export interface StaffAssistantInput {
  readonly tenantId: string;
  readonly propertyId: string;
  /** A built-in staff agent, e.g. `ENGINEERING_COPILOT`. */
  readonly agentCode: string;
  readonly question: string;
  /** The person's language; the question's script wins when it is clearly Arabic or English. */
  readonly locale: string;
  /** The staff member who asked (the execution is recorded on their behalf). */
  readonly userId: string;
  /** What the person is looking at (e.g. the asset), labelled with its data class. */
  readonly focus?: readonly ClassifiedText[];
}

export interface StaffAssistantAnswer {
  readonly executionId: string;
  readonly outcome: 'ANSWERED' | 'DISABLED' | 'FAILED';
  readonly answer: string | null;
  readonly locale: 'ar' | 'en' | 'it' | 'ru' | 'de';
  /** The documents the tools returned while answering (exact versions, Spec §38). */
  readonly sources: ReadonlyArray<{
    readonly documentId: string;
    readonly title: string;
    readonly versionNo: number;
  }>;
}

/** Asks a staff assistant a question; it may only read (its tools are READ) and answers in the person's language. */
export interface StaffAssistantApi {
  ask(input: StaffAssistantInput): Promise<StaffAssistantAnswer>;
}
export const STAFF_ASSISTANT_API = Symbol.for('hotella.domain.ai.staff-assistant');

export { AI_MANIFEST } from '../manifest';
