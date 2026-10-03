import { Injectable } from '@nestjs/common';
import { type EventEnvelope, ReplyDraftUsed } from '@hotella/contracts-events';
import { newId, TransactionRunner } from '@hotella/platform-database';
import { AiRepositories } from '../infrastructure/repositories';

/**
 * Feedback on AI work (Spec §40): when staff send an AI draft, how much they changed it is recorded against the
 * execution that wrote it (worker consumer of `comms.reply_draft.used.v1`; a draft counts once).
 */
@Injectable()
export class FeedbackRecorder {
  constructor(
    private readonly repo: AiRepositories,
    private readonly tx: TransactionRunner,
  ) {}

  async onDraftUsed(envelope: EventEnvelope): Promise<boolean> {
    const e = ReplyDraftUsed.parse(envelope);
    if (!envelope.tenant_id || !e.payload.execution_id) return false;
    return this.tx.run(async () => {
      const scope = { tenantId: envelope.tenant_id! };
      if (!(await this.repo.execution(scope, e.payload.execution_id!))) return false;
      return this.repo.insertFeedback({
        id: newId(),
        tenantId: scope.tenantId,
        propertyId: envelope.property_id,
        executionId: e.payload.execution_id!,
        kind: 'DRAFT_EDIT',
        editDistance: e.payload.edit_distance,
        details: { draft_length: e.payload.draft_length, sent_length: e.payload.sent_length },
        actorType: 'USER',
        actorId: e.payload.used_by,
        sourceRef: e.payload.draft_id,
      });
    });
  }
}
