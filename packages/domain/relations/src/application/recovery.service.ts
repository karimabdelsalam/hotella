import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  type ApprovalSummary,
  OPERATIONS_API,
  type OperationsPublicApi,
} from '@hotella/domain-operations/public';
import { ORGANIZATION_API, type OrganizationPublicApi } from '@hotella/domain-organization/public';
import { AuditWriter } from '@hotella/platform-audit';
import { ActionGate, ActorStore } from '@hotella/platform-auth';
import { isUuid, newId, type PropertyScope, TransactionRunner } from '@hotella/platform-database';
import { AppError } from '@hotella/platform-i18n';
import { SettingsReader } from '@hotella/platform-settings';
import { needsAmount, RECOVERY_KINDS, recoveryApproval } from '../domain/complaints';
import { RECOVERY_HIGH_FROM_MINOR } from '../domain/settings';
import { RelationsRepositories } from '../infrastructure/repositories';
import { ComplaintService } from './complaint.service';

/** The approval kind for service recovery that costs the hotel money (Spec §8.4, BUILD_PLAN 9.B). */
export const RECOVERY_ACTION_APPROVAL = 'RECOVERY_ACTION';

export const addRecoverySchema = z.object({
  kind: z.enum(RECOVERY_KINDS),
  /** Minor units of the property's currency (e.g. piastres). */
  amountMinor: z.number().int().min(1).max(100_000_000).optional(),
  note: z.string().trim().max(1000).optional(),
});

/**
 * Service recovery (Spec §12): an apology, an amenity or a room move is recorded as done; a meal, discount or refund
 * waits for a person's approval (HIGH from the property's threshold) and becomes DONE only when approved. Nothing is
 * posted to the PMS folio in Phase 9.
 */
@Injectable()
export class RecoveryService {
  constructor(
    private readonly repo: RelationsRepositories,
    private readonly tx: TransactionRunner,
    private readonly gate: ActionGate,
    private readonly audit: AuditWriter,
    private readonly actors: ActorStore,
    private readonly settings: SettingsReader,
    private readonly complaints: ComplaintService,
    @Inject(OPERATIONS_API) private readonly ops: OperationsPublicApi,
    @Inject(ORGANIZATION_API) private readonly org: OrganizationPublicApi,
  ) {}

  add(scope: PropertyScope, complaintId: string, input: z.infer<typeof addRecoverySchema>) {
    return this.gate.execute(
      {
        action: 'complaint.recovery.manage',
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
      },
      () =>
        this.tx.run(async () => {
          const complaint = await this.complaints.find(scope, complaintId);
          if (complaint.status === 'CLOSED') throw AppError.conflict('relations.complaint.closed');
          if (needsAmount(input.kind) && input.amountMinor === undefined)
            throw new AppError('relations.recovery.amount_required', HttpStatus.BAD_REQUEST, {
              kind: input.kind,
            });
          const property = await this.org.getProperty(scope.tenantId, scope.propertyId);
          const amountMinor = input.amountMinor ?? null;
          const currency = amountMinor === null ? null : (property?.currency ?? null);
          const approval = recoveryApproval(
            input.kind,
            amountMinor,
            await this.settings.value(RECOVERY_HIGH_FROM_MINOR, scope),
          );
          const actor = this.actors.require();
          let row = await this.repo.insertRecovery({
            id: newId(),
            tenantId: scope.tenantId,
            propertyId: scope.propertyId,
            complaintId: complaint.id,
            kind: input.kind,
            amountMinor,
            currency,
            note: input.note ?? null,
            status: approval.required ? 'PENDING_APPROVAL' : 'DONE',
            createdByType: actor.type,
            createdById: isUuid(actor.id) ? actor.id : null,
            decidedAt: approval.required ? null : new Date(),
          });
          if (approval.required) {
            const requested = await this.ops.requestApproval({
              tenantId: scope.tenantId,
              propertyId: scope.propertyId,
              kind: RECOVERY_ACTION_APPROVAL,
              riskLevel: approval.risk,
              subject: { type: 'recovery_action', id: row.id },
              payload: {
                complaint_id: complaint.id,
                complaint_number: complaint.number,
                kind: input.kind,
                amount_minor: amountMinor,
                currency,
              },
              reason: input.note ?? null,
            });
            row = await this.repo.updateRecovery(scope, row.id, { approvalId: requested.id });
          }
          await this.audit.record({
            action: 'relations.recovery.add',
            entityType: 'recovery_action',
            entityId: row.id,
            tenantId: scope.tenantId,
            propertyId: scope.propertyId,
            after: { complaint: complaint.id, kind: row.kind, amountMinor, status: row.status },
            ...(row.approvalId ? { approvalRef: row.approvalId } : {}),
          });
          return row;
        }),
    );
  }

  /** The approval handler: runs inside the approving transaction once a person approved. */
  async approved(approval: ApprovalSummary): Promise<void> {
    const scope = { tenantId: approval.tenantId };
    const row = await this.repo.recoveryOfApproval(scope, approval.id);
    if (!row || row.status !== 'PENDING_APPROVAL') return;
    await this.repo.updateRecovery(scope, row.id, { status: 'DONE', decidedAt: new Date() });
    await this.audit.record({
      action: 'relations.recovery.approved',
      entityType: 'recovery_action',
      entityId: row.id,
      tenantId: row.tenantId,
      propertyId: row.propertyId,
      before: { status: row.status },
      after: { status: 'DONE' },
      approvalRef: approval.id,
    });
  }

  /** A rejected or expired approval leaves the recovery REJECTED (worker, idempotent). */
  settle(tenantId: string, approvalId: string, outcome: 'REJECTED' | 'EXPIRED'): Promise<void> {
    return this.tx.run(async () => {
      const scope = { tenantId };
      const row = await this.repo.recoveryOfApproval(scope, approvalId);
      if (!row || row.status !== 'PENDING_APPROVAL') return;
      await this.repo.updateRecovery(scope, row.id, { status: 'REJECTED', decidedAt: new Date() });
      await this.audit.record({
        action: 'relations.recovery.rejected',
        entityType: 'recovery_action',
        entityId: row.id,
        tenantId: row.tenantId,
        propertyId: row.propertyId,
        before: { status: row.status },
        after: { status: 'REJECTED', outcome },
        approvalRef: approvalId,
      });
    });
  }
}
