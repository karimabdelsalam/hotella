import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { Risk } from '../../domain/policy';

/** Who and where a tool acts for: fixed by the execution, never chosen by the model (Spec §31). */
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
 * A registered AI tool (Spec §31): a schema the model fills in, a risk level, the permission it needs and a handler
 * that acts only through the owning contexts' public APIs (CLAUDE.md rule 12: AI never writes business tables).
 */
export interface AiToolDefinition<I = unknown> {
  /** `<context>.<verb_noun>`, as declared in the AI manifest. */
  readonly code: string;
  /** What the tool does, for the model (not shown to people). */
  readonly description: string;
  readonly risk: Risk;
  readonly requiredPermission: string;
  readonly input: z.ZodType<I>;
  readonly needs?: { readonly guest?: boolean; readonly conversation?: boolean };
  /** Checked before a proposal is made, so a person is never asked to approve something that cannot happen. */
  readonly precheck?: (args: I, ctx: ToolContext) => Promise<void>;
  readonly handle: (args: I, ctx: ToolContext) => Promise<unknown>;
}

/** Model function names allow neither dots nor most punctuation: `catalog.list_services` → `catalog__list_services`. */
export const toModelName = (code: string) => code.replace('.', '__');

const CODE_RE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

@Injectable()
export class ToolRegistry {
  private readonly tools = new Map<string, AiToolDefinition>();

  register<I>(tool: AiToolDefinition<I>): void {
    if (!CODE_RE.test(tool.code)) throw new Error(`AI tool code "${tool.code}" is malformed`);
    if (this.tools.has(tool.code)) throw new Error(`AI tool "${tool.code}" registered twice`);
    this.tools.set(tool.code, tool as AiToolDefinition);
  }

  get(code: string): AiToolDefinition | undefined {
    return this.tools.get(code);
  }

  /** Resolves a model's function name back to the tool code. */
  fromModelName(name: string): AiToolDefinition | undefined {
    return this.tools.get(name.replace('__', '.'));
  }

  all(): AiToolDefinition[] {
    return [...this.tools.values()].sort((a, b) => a.code.localeCompare(b.code));
  }

  /** The function declarations the model sees for an agent's tools (JSON Schema from the zod input). */
  forModel(codes: readonly string[]) {
    return codes.flatMap((code) => {
      const tool = this.tools.get(code);
      if (!tool) return [];
      return [
        {
          name: toModelName(tool.code),
          description: tool.description,
          parameters: z.toJSONSchema(tool.input, { io: 'input' }) as Record<string, unknown>,
        },
      ];
    });
  }

  /** The permissions an agent holds: exactly what its tools require. */
  permissionsOf(codes: readonly string[]): Set<string> {
    return new Set(
      codes.flatMap((code) => {
        const tool = this.tools.get(code);
        return tool ? [tool.requiredPermission] : [];
      }),
    );
  }
}
