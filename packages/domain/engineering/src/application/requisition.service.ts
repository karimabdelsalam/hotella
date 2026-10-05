import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { type EventEnvelope, RequisitionSettled } from '@hotella/contracts-events';
import { ERP_API, type ErpPublicApi } from '@hotella/domain-integrations/public';
import {
  type ApprovalSummary,
  OPERATIONS_API,
  type OperationsPublicApi,
} from '@hotella/domain-operations/public';
import { AuditWriter } from '@hotella/platform-audit';
import { ActionGate, ActorStore } from '@hotella/platform-auth';
import {
  currentTransaction,
  isUuid,
  newId,
  type PropertyScope,
  TransactionRunner,
} from '@hotella/platform-database';
import { AppError } from '@hotella/platform-i18n';
import { EngineeringRepositories } from '../infrastructure/repositories';
import { RequisitionRepositories } from '../infrastructure/requisition-repositories';
import type { RequisitionRow } from '../infrastructure/schema';

/** Approval kind of a part requisition: a person decides, always (BUILD_PLAN 13.5). */
export const ENG_REQUISITION_APPROVAL = 'ENG_REQUISITION';

export const createRequisitionSchema = z.object({
  partId: z.uuid(),
  quantity: z.number().positive().max(1e6),
  workOrderId: z.uuid().nullable().default(null),
  neededBy: z.iso.date().nullable().default(null),
  reason: z.string().trim().max(300).nullable().default(null),
});
export const linkErpItemSchema = z.object({ itemCode: z.string().trim().min(1).max(64) });

/**
 * Part requisitions (BUILD_PLAN 13.5): staff ask, a person approves (`ENG_REQUISITION`), the approved requisition goes
 * to the ERP as a command when a connector serves it (else it stays APPROVED for a manual purchase), and the ERP's
 * answer settles it. Stock at the ERP is read through `ERP_API`; ERP item codes never live in engineering (rule 3).
 */
@Injectable()
export class RequisitionService {
  static readonly consumes = [RequisitionSettled] as const;

  constructor(
    private readonly repo: RequisitionRepositories,
    private readonly eng: EngineeringRepositories,
    @Inject(ERP_API) private readonly erp: ErpPublicApi,
    @Inject(OPERATIONS_API) private readonly ops: OperationsPublicApi,
    private readonly gate: ActionGate,
    private readonly tx: TransactionRunner,
    private readonly audit: AuditWriter,
    private readonly actors: ActorStore,
  ) {}

  create(scope: PropertyScope, input: z.infer<typeof createRequisitionSchema>) {
    return this.gate.execute(
      { action: 'eng.requisition.request', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () =>
        this.tx.run(async () => {
          const part = await this.part(scope, input.partId);
          if (input.workOrderId) {
            const wo = await this.eng.workOrder(scope, input.workOrderId);
            if (!wo || wo.propertyId !== scope.propertyId)
              throw AppError.notFound('eng.work_order.not_found');
          }
          const actor = this.actors.require();
          let row = await this.repo.insert({
            id: newId(),
            tenantId: scope.tenantId,
            propertyId: scope.propertyId,
            partId: part.id,
            workOrderId: input.workOrderId,
            quantity: input.quantity,
            unit: part.unit,
            neededBy: input.neededBy,
            reason: input.reason,
            status: 'PENDING_APPROVAL',
            requestedByType: actor.type.slice(0, 16),
            requestedById: isUuid(actor.id) ? actor.id : null,
          });
          const approval = await this.ops.requestApproval({
            tenantId: scope.tenantId,
            propertyId: scope.propertyId,
            kind: ENG_REQUISITION_APPROVAL,
            riskLevel: 'MEDIUM',
            subject: { type: 'requisition', id: row.id },
            payload: {
              part_number: part.partNumber,
              part_name: part.name,
              quantity: input.quantity,
              unit: part.unit,
              on_hand: part.onHand,
              work_order_id: input.workOrderId,
              needed_by: input.neededBy,
            },
            reason: input.reason,
          });
          row = await this.repo.update(scope, row.id, { approvalId: approval.id });
          await this.audit.record({
            action: 'eng.requisition.request',
            entityType: 'requisition',
            entityId: row.id,
            tenantId: scope.tenantId,
            propertyId: scope.propertyId,
            after: { part_id: part.id, quantity: input.quantity, status: row.status },
            approvalRef: approval.id,
          });
          return view(row);
        }),
    );
  }

  list(scope: PropertyScope) {
    return this.gate.execute(
      { action: 'eng.work_order.read', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () => this.tx.read(async () => (await this.repo.list(scope, 200)).map(view)),
    );
  }

  /** The approval handler: runs inside the approving transaction once a person approved. */
  async approved(approval: ApprovalSummary): Promise<void> {
    const scope = { tenantId: approval.tenantId };
    const row = await this.repo.ofApproval(scope, approval.id);
    if (!row || row.status !== 'PENDING_APPROVAL') return;
    const sent = await this.erp.requestRequisition({
      tenantId: row.tenantId,
      propertyId: row.propertyId,
      requisitionId: row.id,
      lines: [{ partId: row.partId, quantity: row.quantity, unit: row.unit }],
      neededBy: row.neededBy,
      requestedBy: approval.decidedBy ?? { type: 'SYSTEM', id: null },
    });
    const now = new Date();
    const updated = await this.repo.update(
      scope,
      row.id,
      sent.status === 'SENT'
        ? { status: 'SENT', decidedAt: now, sentAt: now, commandId: sent.commandId }
        : { status: 'APPROVED', decidedAt: now, failure: sent.reason },
    );
    await this.audit.record({
      action: 'eng.requisition.approved',
      entityType: 'requisition',
      entityId: row.id,
      tenantId: row.tenantId,
      propertyId: row.propertyId,
      before: { status: row.status },
      after: { status: updated.status, erp: sent.status === 'SENT' ? 'SENT' : sent.reason },
      approvalRef: approval.id,
    });
  }

  /** A rejected or expired approval leaves the requisition REJECTED (worker, idempotent). */
  settleApproval(tenantId: string, approvalId: string, outcome: 'REJECTED' | 'EXPIRED') {
    return this.tx.run(async () => {
      const scope = { tenantId };
      const row = await this.repo.ofApproval(scope, approvalId);
      if (!row || row.status !== 'PENDING_APPROVAL') return;
      await this.repo.update(scope, row.id, {
        status: 'REJECTED',
        decidedAt: new Date(),
        failure: outcome,
      });
      await this.audit.record({
        action: 'eng.requisition.rejected',
        entityType: 'requisition',
        entityId: row.id,
        tenantId: row.tenantId,
        propertyId: row.propertyId,
        actor: { type: 'SYSTEM', id: null },
        before: { status: row.status },
        after: { status: 'REJECTED', outcome },
        approvalRef: approvalId,
      });
    });
  }

  /** The ERP's answer (worker consumer, inside the idempotent consumer's transaction). */
  async apply(envelope: EventEnvelope): Promise<void> {
    if (!currentTransaction())
      throw new Error('RequisitionService.apply must run inside a transaction');
    if (!envelope.tenant_id) return;
    const e = RequisitionSettled.parse(envelope);
    const scope = { tenantId: envelope.tenant_id };
    const row = await this.repo.forUpdate(scope, e.payload.requisition_id);
    if (!row || row.status !== 'SENT' || row.commandId !== e.payload.command_id) return;
    const confirmed = e.payload.status === 'ACKNOWLEDGED';
    await this.repo.update(scope, row.id, {
      status: confirmed ? 'CONFIRMED' : 'FAILED',
      settledAt: new Date(),
      failure: confirmed ? null : (e.payload.error ?? e.payload.status).slice(0, 200),
    });
    await this.audit.record({
      action: confirmed ? 'eng.requisition.confirmed' : 'eng.requisition.failed',
      entityType: 'requisition',
      entityId: row.id,
      tenantId: row.tenantId,
      propertyId: row.propertyId,
      actor: { type: 'INTEGRATION', id: null },
      before: { status: row.status },
      after: { status: confirmed ? 'CONFIRMED' : 'FAILED' },
    });
  }

  // ---- ERP item and stock of a part ----

  linkErpItem(scope: PropertyScope, partId: string, input: z.infer<typeof linkErpItemSchema>) {
    return this.gate.execute(
      { action: 'eng.parts.manage', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () =>
        this.tx.run(async () => {
          const part = await this.part(scope, partId);
          await this.erp.linkItem({
            tenantId: scope.tenantId,
            propertyId: scope.propertyId,
            partId: part.id,
            itemCode: input.itemCode,
          });
          await this.audit.record({
            action: 'eng.part.erp_item_link',
            entityType: 'part',
            entityId: part.id,
            tenantId: scope.tenantId,
            propertyId: scope.propertyId,
            after: { linked: true },
          });
          return { partId: part.id, itemCode: input.itemCode };
        }),
    );
  }

  /** The shelf here and the ERP's stock of a part (the ERP read waits for the agent, outside a transaction). */
  stock(scope: PropertyScope, partId: string) {
    return this.gate.execute(
      { action: 'eng.parts.manage', tenantId: scope.tenantId, propertyId: scope.propertyId },
      async () => {
        const { part, itemCode } = await this.tx.read(async () => {
          const p = isUuid(partId) ? await this.eng.part(scope, partId) : undefined;
          if (!p || p.propertyId !== scope.propertyId)
            throw AppError.notFound('eng.part.not_found');
          return { part: p, itemCode: await this.erp.itemOf(scope.tenantId, p.id) };
        });
        const actor = this.actors.require();
        const erp = itemCode
          ? await this.erp.stock({
              tenantId: scope.tenantId,
              propertyId: scope.propertyId,
              partIds: [part.id],
              requestedBy: { type: actor.type, id: isUuid(actor.id) ? actor.id : null },
            })
          : null;
        return {
          partId: part.id,
          onHand: part.onHand,
          unit: part.unit,
          erpItemCode: itemCode,
          erp: erp
            ? {
                outcome: erp.outcome,
                reason: erp.outcome === 'FAILED' ? erp.reason : null,
                levels: erp.outcome === 'OK' ? erp.levels : [],
              }
            : null,
        };
      },
    );
  }

  private async part(scope: PropertyScope, id: string) {
    const p = isUuid(id) ? await this.eng.partForUpdate(scope, id) : undefined;
    if (!p || p.propertyId !== scope.propertyId) throw AppError.notFound('eng.part.not_found');
    return p;
  }
}

function view(r: RequisitionRow) {
  return {
    id: r.id,
    partId: r.partId,
    workOrderId: r.workOrderId,
    quantity: r.quantity,
    unit: r.unit,
    neededBy: r.neededBy,
    reason: r.reason,
    status: r.status,
    approvalId: r.approvalId,
    failure: r.failure,
    createdAt: r.createdAt,
    decidedAt: r.decidedAt,
    sentAt: r.sentAt,
    settledAt: r.settledAt,
    version: r.version,
  };
}
