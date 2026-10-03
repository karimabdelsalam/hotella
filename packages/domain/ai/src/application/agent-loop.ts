import { z } from 'zod';
import { AppError } from '@hotella/platform-i18n';
import type { ClassifiedText, GatewayCompletion, GatewayMessage, ModelGatewayApi } from '../public';
import type { PublishedAgent } from './agent-catalog';
import type { ExecutionHandle, ToolExecutor, ToolOutcome } from './tools/executor';
import type { ToolRegistry } from './tools/registry';

/** Tool results are capped before they go back to the model. */
const MAX_TOOL_RESULT_CHARS = 6000;

export interface AgentLoopDeps {
  readonly gateway: ModelGatewayApi;
  readonly executor: ToolExecutor;
  readonly registry: ToolRegistry;
}

export interface AgentLoopInput<T> {
  readonly handle: ExecutionHandle;
  readonly agent: PublishedAgent;
  readonly system: readonly ClassifiedText[];
  readonly history: readonly GatewayMessage[];
  /** The structured answer the agent must end with. */
  readonly output: { readonly name: string; readonly schema: z.ZodType<T> };
  /** Reads the final content; null when it is not a usable answer. */
  readonly parse: (content: string | null) => T | null;
  /** Summary of the answer for the execution record (codes and sizes, never content). */
  readonly describe: (answer: T) => { outcome: string; summary: Record<string, unknown> };
  /** Called with every tool outcome (e.g. to collect the documents an answer drew on). */
  readonly onTool?: (tool: string, outcome: ToolOutcome) => void;
}

/**
 * The bounded agent loop (Spec §24): model → tool calls → model, until a structured answer or the step budget runs out.
 * Tools are offered from the agent's published version only (runtime tools excluded) and every call goes through the
 * executor (policy, ActionGate, audit); every model call and decision is a step of the execution.
 */
export async function runAgentLoop<T>(
  deps: AgentLoopDeps,
  input: AgentLoopInput<T>,
): Promise<T | null> {
  const { handle, agent } = input;
  const tools = deps.registry.forModel(
    agent.tools.filter((t) => !agent.output.runtimeTools.includes(t)),
  );
  const turns: GatewayMessage[] = [];
  for (let step = 0; step < agent.maxSteps; step++) {
    let completion: GatewayCompletion;
    const started = Date.now();
    try {
      completion = await deps.gateway.complete({
        tenantId: handle.tenantId,
        propertyId: handle.propertyId,
        capability: agent.capability,
        system: input.system,
        messages: [...input.history, ...turns],
        tools,
        jsonSchema: {
          name: input.output.name,
          schema: z.toJSONSchema(input.output.schema) as Record<string, unknown>,
        },
        executionId: handle.id,
        agentCode: agent.code,
      });
    } catch (e) {
      await deps.executor.step(handle, {
        type: 'MODEL_CALL',
        name: agent.capability,
        outcome: e instanceof AppError ? e.code : 'ERROR',
        latencyMs: Date.now() - started,
      });
      return null;
    }
    await deps.executor.step(handle, {
      type: 'MODEL_CALL',
      name: agent.capability,
      outcome: completion.finishReason.toUpperCase(),
      summary: {
        provider: completion.provider,
        model: completion.model,
        model_call_id: completion.modelCallId,
        fallback_from: completion.fallbackFrom,
        tool_calls: completion.toolCalls.length,
        cost_minor: completion.costMinor,
      },
      latencyMs: Date.now() - started,
    });
    if (completion.toolCalls.length > 0) {
      turns.push({
        role: 'assistant',
        content: completion.content,
        toolCalls: completion.toolCalls,
        dataClass: 'CONFIDENTIAL',
      });
      for (const call of completion.toolCalls) {
        const tool = deps.registry.fromModelName(call.name);
        const code = tool?.code ?? call.name;
        const outcome = await deps.executor.invoke(handle, {
          tool: code,
          arguments: call.arguments,
        });
        input.onTool?.(code, outcome);
        turns.push({
          role: 'tool',
          toolCallId: call.id,
          content: JSON.stringify(outcome).slice(0, MAX_TOOL_RESULT_CHARS),
          dataClass: 'CONFIDENTIAL',
        });
      }
      continue;
    }
    const parsed = input.parse(completion.content);
    const described = parsed ? input.describe(parsed) : { outcome: 'UNPARSEABLE', summary: {} };
    await deps.executor.step(handle, {
      type: 'DECISION',
      name: 'output',
      outcome: described.outcome,
      summary: described.summary,
    });
    return parsed;
  }
  await deps.executor.step(handle, {
    type: 'DECISION',
    name: 'step_budget',
    outcome: 'EXHAUSTED',
    summary: { max_steps: agent.maxSteps },
  });
  return null;
}

/** The JSON answer with code fences tolerated; null when it does not match the schema. */
export function parseJsonAnswer<T>(content: string | null, schema: z.ZodType<T>): T | null {
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
    return null;
  }
}
