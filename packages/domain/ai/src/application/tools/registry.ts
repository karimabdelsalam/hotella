import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { AiToolDefinition, AiToolRegistrar, ToolContext } from '../../public';

export type { AiToolDefinition, ToolContext };

/** Model function names allow neither dots nor most punctuation: `catalog.list_services` → `catalog__list_services`. */
export const toModelName = (code: string) => code.replace('.', '__');

const CODE_RE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

@Injectable()
export class ToolRegistry implements AiToolRegistrar {
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
