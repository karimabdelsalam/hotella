import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  ActionRequest,
  AiAgentAuthorizer,
  GateStage,
  PermissionScope,
  RequestActor,
} from '@hotella/platform-auth';
import { AppError } from '@hotella/platform-i18n';
import { type Risk, riskRank } from '../../domain/policy';

/**
 * What an AI agent is doing right now (Spec §31–§32): one tool call of one execution, in one tenant and property,
 * already cleared by the deterministic policy — on its own (`AUTO`) or because a person approved it (`APPROVED`).
 * The ActionGate reads it through the authorizer and the AI policy stage below; without it an AI actor can do nothing.
 */
export interface AiExecutionScope {
  readonly executionId: string;
  readonly agentCode: string;
  /** The AI actor's id (the execution id): the gate only honours the scope for that actor. */
  readonly actorId: string;
  readonly tenantId: string;
  readonly propertyId: string;
  /** The permissions the agent's registered tools require — and nothing else. */
  readonly permissions: ReadonlySet<string>;
  readonly tool: string;
  readonly risk: Risk;
  readonly mode: 'AUTO' | 'APPROVED';
  readonly approvalId: string | null;
}

const storage = new AsyncLocalStorage<AiExecutionScope>();

export const aiExecutionScope = {
  run<T>(scope: AiExecutionScope, fn: () => Promise<T>): Promise<T> {
    return storage.run(scope, fn);
  },
  current(): AiExecutionScope | undefined {
    return storage.getStore();
  },
};

function scopeFor(actor: RequestActor): AiExecutionScope | undefined {
  const scope = storage.getStore();
  return actor.type === 'AI_AGENT' && scope && scope.actorId === actor.id ? scope : undefined;
}

/** ActionGate step 1 for AI agents: only the permissions of the agent's tools, only in its tenant and property. */
export class ScopedAgentAuthorizer implements AiAgentAuthorizer {
  async hasPermission(
    actor: RequestActor,
    permission: string,
    scope: PermissionScope,
  ): Promise<boolean> {
    const s = scopeFor(actor);
    if (!s || !s.permissions.has(permission)) return false;
    if (scope.tenantId !== s.tenantId) return false;
    return scope.propertyId == null || scope.propertyId === s.propertyId;
  }
}

/**
 * ActionGate step 6 (Spec §32, CLAUDE.md rule 12): an AI agent acts only inside a tool call the policy cleared;
 * CRITICAL never; HIGH only once a person approved it; and never something riskier than the tool declares.
 */
export class AiPolicyStage implements GateStage {
  readonly name = 'aiPolicy';
  async check(request: ActionRequest, actor: RequestActor): Promise<void> {
    const s = scopeFor(actor);
    if (!s) throw AppError.forbidden('ai.policy.no_execution');
    if (s.risk === 'CRITICAL') throw AppError.forbidden('ai.policy.critical');
    if (s.risk === 'HIGH' && s.mode !== 'APPROVED')
      throw AppError.forbidden('ai.policy.approval_required');
    if (request.aiRisk && riskRank(request.aiRisk) > riskRank(s.risk))
      throw AppError.forbidden('ai.policy.risk_exceeded', { tool: s.tool });
  }
}
