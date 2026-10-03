import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ActionGate } from '@hotella/platform-auth';
import { isUuid, type PropertyScope, TransactionRunner } from '@hotella/platform-database';
import { AppError } from '@hotella/platform-i18n';
import { AiRepositories } from '../infrastructure/repositories';
import { AgentCatalog } from './agent-catalog';

export const executionsQuerySchema = z.object({
  conversationId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/**
 * What the AI did, for the people responsible for it (Spec §34, `ai.execution.read`): executions of a property with
 * their steps, model calls (cost, latency, outcome — never content), proposals and feedback.
 */
@Injectable()
export class ExecutionAuditService {
  constructor(
    private readonly repo: AiRepositories,
    private readonly agents: AgentCatalog,
    private readonly gate: ActionGate,
    private readonly tx: TransactionRunner,
  ) {}

  list(scope: PropertyScope, query: z.infer<typeof executionsQuerySchema>) {
    return this.read(scope, () =>
      this.repo.listExecutions(scope, {
        limit: query.limit,
        ...(query.conversationId ? { conversationId: query.conversationId } : {}),
      }),
    );
  }

  detail(scope: PropertyScope, id: string) {
    return this.read(scope, async () => {
      const execution = isUuid(id) ? await this.repo.execution(scope, id) : undefined;
      if (!execution || execution.propertyId !== scope.propertyId)
        throw AppError.notFound('ai.execution.not_found');
      return {
        ...execution,
        steps: await this.repo.steps(scope, id),
        modelCalls: await this.repo.callsOfExecution(scope, id),
        proposals: await this.repo.proposalsOfExecution(scope, id),
        feedback: await this.repo.feedbackOfExecution(scope, id),
      };
    });
  }

  /** The agents and their versions (platform definitions; any tenant member with `ai.execution.read`). */
  agentsList(scope: PropertyScope) {
    return this.gate.execute(
      { action: 'ai.execution.read', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () => this.agents.list(),
    );
  }

  private read<T>(scope: PropertyScope, fn: () => Promise<T>): Promise<T> {
    return this.gate.execute(
      { action: 'ai.execution.read', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () => this.tx.read(fn),
    );
  }
}
