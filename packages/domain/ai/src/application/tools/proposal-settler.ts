import { Injectable } from '@nestjs/common';
import { newId, TransactionRunner } from '@hotella/platform-database';
import { AiRepositories } from '../../infrastructure/repositories';

/**
 * Closes the proposal of a rejected or expired `AI_ACTION` approval (worker consumer of `ops.approval.decided`;
 * idempotent: a settled proposal is left alone). Approved ones are executed by the approval handler instead.
 */
@Injectable()
export class ProposalSettler {
  constructor(
    private readonly repo: AiRepositories,
    private readonly tx: TransactionRunner,
  ) {}

  settle(tenantId: string, approvalId: string, outcome: 'REJECTED' | 'EXPIRED'): Promise<boolean> {
    return this.tx.run(async () => {
      const scope = { tenantId };
      const proposal = await this.repo.proposalOfApproval(scope, approvalId);
      if (!proposal || proposal.status !== 'PENDING') return false;
      await this.repo.updateProposal(scope, proposal.id, {
        status: outcome,
        decidedAt: new Date(),
      });
      await this.repo.insertStep({
        id: newId(),
        tenantId,
        executionId: proposal.executionId,
        type: 'APPROVAL',
        name: proposal.toolCode,
        outcome,
        summary: { proposal_id: proposal.id, approval_id: approvalId },
      });
      return true;
    });
  }
}
