import type { DryOutcome, ToolFixtures } from '../../domain/evaluation';
import { decide } from '../../domain/policy';
import type { LoopExecutor } from '../agent-loop';
import type { ExecutionHandle, ToolExecutor, ToolOutcome } from './executor';
import type { ToolRegistry } from './registry';

/**
 * The evaluation's tool executor (BUILD_PLAN 12.1): the same allow-list, argument schema and policy decision as the
 * real executor, but nothing runs — READ and allowed actions are answered from the case's fixtures, actions a person
 * would approve come back PROPOSED without a proposal, CRITICAL is refused. It writes no business data and requests no
 * approval; it only records the call (as a step of the evaluation execution) for grading.
 */
export class DryRunExecutor implements LoopExecutor {
  readonly calls: Array<{ tool: string; args: Record<string, unknown>; outcome: DryOutcome }> = [];

  constructor(
    private readonly real: Pick<ToolExecutor, 'step'>,
    private readonly registry: ToolRegistry,
    private readonly fixtures: ToolFixtures,
  ) {}

  step(...args: Parameters<ToolExecutor['step']>): ReturnType<ToolExecutor['step']> {
    return this.real.step(...args);
  }

  async invoke(
    handle: ExecutionHandle,
    call: { readonly tool: string; readonly arguments: unknown },
  ): Promise<ToolOutcome> {
    const def = handle.tools.includes(call.tool) ? this.registry.get(call.tool) : undefined;
    const raw =
      call.arguments && typeof call.arguments === 'object'
        ? (call.arguments as Record<string, unknown>)
        : {};
    let outcome: ToolOutcome;
    let args = raw;
    if (!def) outcome = { status: 'REFUSED', reason: 'TOOL_NOT_ALLOWED' };
    else {
      const parsed = def.input.safeParse(call.arguments ?? {});
      if (!parsed.success)
        outcome = {
          status: 'ERROR',
          code: 'ai.tool.invalid_arguments',
          issues: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.code}`),
        };
      else {
        args = (parsed.data ?? {}) as Record<string, unknown>;
        const { decision, reason } = decide({
          tool: def.code,
          risk: def.risk,
          autonomy: handle.autonomy,
          autoActionsKilled: false,
        });
        const fixture = this.fixtures[def.code];
        outcome =
          decision === 'REFUSE'
            ? { status: 'REFUSED', reason }
            : decision === 'PROPOSE'
              ? { status: 'PROPOSED', proposalId: 'dry-run', approvalId: 'dry-run' }
              : !fixture
                ? { status: 'ERROR', code: 'ai.evaluation.no_fixture' }
                : fixture.status === 'OK'
                  ? { status: 'OK', result: fixture.result }
                  : { status: 'ERROR', code: fixture.code };
      }
    }
    this.calls.push({ tool: call.tool, args, outcome: outcome.status });
    await this.step(handle, {
      type: 'TOOL_CALL',
      name: call.tool.slice(0, 128),
      outcome: outcome.status,
      summary: {
        dry_run: true,
        risk: def?.risk ?? null,
        argument_keys: Object.keys(raw).slice(0, 20),
        ...(outcome.status === 'REFUSED' ? { reason: outcome.reason } : {}),
        ...(outcome.status === 'ERROR' ? { code: outcome.code } : {}),
      },
    });
    return outcome;
  }
}
