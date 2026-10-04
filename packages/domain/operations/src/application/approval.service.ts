import { HttpStatus, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ApprovalDecided, ApprovalRequested } from '@hotella/contracts-events';
import { AuditWriter } from '@hotella/platform-audit';
import { ActionGate, ActorStore, type RequestActor } from '@hotella/platform-auth';
import {
  isUuid,
  newId,
  type PropertyScope,
  type TenantScope,
  TransactionRunner,
} from '@hotella/platform-database';
import { EventPublisher } from '@hotella/platform-events';
import { AppError } from '@hotella/platform-i18n';
import { InjectLogger, type Logger } from '@hotella/platform-observability';
import { decisionProblem, defaultTtlMinutes, requestProblem } from '../domain/approval';
import { WorkflowRepositories } from '../infrastructure/workflow-repositories';
import type { ApprovalRequestRow } from '../infrastructure/schema';
import type { ApprovalKindDefinition, ApprovalSummary, RequestApprovalInput } from '../public';
import { OPS_SOURCE } from './constants';

const MINUTE = 60_000;
export type ApprovalOutcome = 'APPROVED' | 'REJECTED' | 'EXPIRED';
type SettledListener = (approval: ApprovalRequestRow, outcome: ApprovalOutcome) => Promise<void>;

export function approvalSummary(a: ApprovalRequestRow): ApprovalSummary {
  return {
    id: a.id,
    tenantId: a.tenantId,
    propertyId: a.propertyId,
    kind: a.kind,
    status: a.status,
    riskLevel: a.riskLevel,
    subject: { type: a.subjectType, id: a.subjectId },
    workItemId: a.workItemId,
    payload: a.payload,
    reason: a.reason,
    requestedBy: { type: a.requestedByType, id: a.requestedById },
    expiresAt: a.expiresAt.toISOString(),
    decidedBy: a.decidedByType ? { type: a.decidedByType, id: a.decidedById } : null,
    decidedAt: a.decidedAt?.toISOString() ?? null,
    decisionReason: a.decisionReason,
    executedAt: a.executedAt?.toISOString() ?? null,
  };
}

const PROBLEM_ERROR: Record<string, () => AppError> = {
  not_pending: () => AppError.conflict('ops.approval.not_pending'),
  expired: () => AppError.conflict('ops.approval.expired'),
  human_required: () => AppError.forbidden('ops.approval.human_required'),
  four_eyes: () => AppError.forbidden('ops.approval.four_eyes'),
};

/**
 * The generic approval engine (Spec §8.4, CLAUDE.md rule 12). Modules register a kind with the handler that performs
 * the sensitive action; the handler runs only when a person other than the requester approves, inside the deciding
 * transaction (a failing handler rolls the approval back). Undecided requests expire.
 */
@Injectable()
export class ApprovalService {
  private readonly kinds = new Map<string, ApprovalKindDefinition>();
  private readonly listeners: SettledListener[] = [];

  constructor(
    private readonly repo: WorkflowRepositories,
    private readonly tx: TransactionRunner,
    private readonly events: EventPublisher,
    private readonly audit: AuditWriter,
    private readonly actors: ActorStore,
    @InjectLogger() private readonly logger: Logger,
  ) {}

  registerKind(kind: ApprovalKindDefinition): void {
    if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(kind.code))
      throw new Error(`Approval kind "${kind.code}" must be UPPER_SNAKE_CASE`);
    const existing = this.kinds.get(kind.code);
    if (existing && existing.module !== kind.module)
      throw new Error(
        `Approval kind "${kind.code}" is already registered by module "${existing.module}"`,
      );
    this.kinds.set(kind.code, kind);
  }

  find(scope: TenantScope, id: string): Promise<ApprovalRequestRow | undefined> {
    return isUuid(id) ? this.repo.approval(scope, id) : Promise.resolve(undefined);
  }

  /** Called once per settled request (approved, rejected, expired), inside its transaction. */
  onSettled(listener: SettledListener): void {
    this.listeners.push(listener);
  }

  request(input: RequestApprovalInput): Promise<ApprovalRequestRow> {
    return this.tx.run(async () => {
      if (!this.kinds.has(input.kind))
        throw new AppError('ops.approval.kind_unknown', HttpStatus.UNPROCESSABLE_ENTITY, {
          kind: input.kind,
        });
      const actor = this.actors.get();
      const requesterType = actor?.type ?? 'SYSTEM';
      const problem = requestProblem(input.riskLevel, requesterType);
      if (problem) throw AppError.forbidden(`ops.approval.${problem}`);
      const now = new Date();
      const row = await this.repo.insertApproval({
        id: newId(),
        tenantId: input.tenantId,
        propertyId: input.propertyId,
        kind: input.kind,
        subjectType: input.subject.type,
        subjectId: input.subject.id ?? null,
        workItemId: input.workItemId ?? null,
        payload: input.payload ?? {},
        riskLevel: input.riskLevel,
        requestedByType: requesterType,
        requestedById: actor?.id ?? null,
        reason: input.reason ?? null,
        expiresAt: new Date(
          now.getTime() + (input.ttlMinutes ?? defaultTtlMinutes(input.riskLevel)) * MINUTE,
        ),
      });
      await this.events.publish(ApprovalRequested, {
        tenantId: row.tenantId,
        propertyId: row.propertyId,
        source: OPS_SOURCE,
        aggregate: { type: 'approval_request', id: row.id },
        payload: {
          approval_id: row.id,
          kind: row.kind,
          risk_level: row.riskLevel,
          subject_type: row.subjectType,
          subject_id: row.subjectId,
          work_item_id: row.workItemId,
          requested_by_type: row.requestedByType,
          expires_at: row.expiresAt.toISOString(),
        },
      });
      await this.audit.record({
        action: 'ops.approval.request',
        entityType: 'approval_request',
        entityId: row.id,
        tenantId: row.tenantId,
        propertyId: row.propertyId,
        after: {
          kind: row.kind,
          riskLevel: row.riskLevel,
          subject: input.subject,
          expiresAt: row.expiresAt,
        },
        approvalRef: row.id,
      });
      return row;
    });
  }

  /** A person's decision (inside the caller's gated transaction). */
  async decide(
    scope: TenantScope,
    approvalId: string,
    approve: boolean,
    reason: string | null,
    decider: RequestActor,
  ): Promise<ApprovalRequestRow> {
    const request = isUuid(approvalId)
      ? await this.repo.approvalForUpdate(scope, approvalId)
      : undefined;
    if (!request) throw AppError.notFound('ops.approval.not_found');
    const now = new Date();
    const problem = decisionProblem(request, decider, now);
    if (problem)
      throw (PROBLEM_ERROR[problem] ?? (() => AppError.conflict('ops.approval.not_pending')))();
    let executedAt: Date | null = null;
    if (approve) {
      // The sensitive action runs now, in this transaction: if it fails, the approval is not recorded either.
      await this.kinds.get(request.kind)?.handler?.(approvalSummary(request));
      executedAt = new Date();
    }
    const outcome: ApprovalOutcome = approve ? 'APPROVED' : 'REJECTED';
    const updated = await this.repo.updateApproval(scope, request.id, {
      status: outcome,
      decidedByType: decider.type,
      decidedById: decider.id,
      decidedAt: now,
      decisionReason: reason,
      executedAt,
    });
    await this.settled(updated, outcome, { type: decider.type, id: decider.id }, reason);
    return updated;
  }

  /**
   * Expires undecided requests past their deadline (worker sweep: every tenant); returns how many. `tenantId` limits
   * the sweep to one tenant (tests that move the clock forward must not expire other tenants' requests).
   */
  async expireDue(now = new Date(), batch = 50, tenantId?: string): Promise<number> {
    let total = 0;
    for (;;) {
      const n = await this.tx.run(async () => {
        const due = await this.repo.claimExpired(now, batch, tenantId);
        for (const d of due) {
          const scope = { tenantId: d.tenantId };
          const updated = await this.repo.updateApproval(scope, d.id, {
            status: 'EXPIRED',
            decidedAt: now,
          });
          await this.settled(updated, 'EXPIRED', { type: 'SYSTEM', id: null }, 'expired undecided');
        }
        return due.length;
      });
      total += n;
      if (n < batch) break;
    }
    if (total > 0) this.logger.info({ expired: total }, 'approval requests expired');
    return total;
  }

  private async settled(
    approval: ApprovalRequestRow,
    outcome: ApprovalOutcome,
    actor: { type: RequestActor['type']; id: string | null },
    reason: string | null,
  ) {
    await this.events.publish(ApprovalDecided, {
      tenantId: approval.tenantId,
      propertyId: approval.propertyId,
      source: OPS_SOURCE,
      aggregate: { type: 'approval_request', id: approval.id },
      payload: {
        approval_id: approval.id,
        kind: approval.kind,
        outcome,
        work_item_id: approval.workItemId,
        decided_by_type: outcome === 'EXPIRED' ? null : actor.type,
      },
    });
    await this.audit.record({
      action: `ops.approval.${outcome.toLowerCase()}`,
      entityType: 'approval_request',
      entityId: approval.id,
      tenantId: approval.tenantId,
      propertyId: approval.propertyId,
      before: { status: 'PENDING' },
      after: { status: outcome, executed: approval.executedAt !== null },
      reason,
      approvalRef: approval.id,
      actor,
    });
    for (const listener of this.listeners) await listener(approval, outcome);
  }
}

export const listApprovalsQuerySchema = z.object({
  status: z
    .string()
    .transform((s) =>
      s
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.enum(['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED'])).max(5))
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export const decideApprovalSchema = z.object({
  decision: z.enum(['APPROVE', 'REJECT']),
  reason: z.string().trim().min(1).max(1000).optional(),
});

/** The approvals inbox of a property (`approval.read`) and decisions (`approval.decide`). */
@Injectable()
export class ApprovalAdminService {
  constructor(
    private readonly repo: WorkflowRepositories,
    private readonly approvals: ApprovalService,
    private readonly gate: ActionGate,
    private readonly tx: TransactionRunner,
    private readonly actors: ActorStore,
  ) {}

  list(scope: PropertyScope, query: z.infer<typeof listApprovalsQuerySchema>) {
    return this.gate.execute(
      { action: 'approval.read', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () =>
        this.tx.read(async () =>
          (await this.repo.listApprovals(scope, query)).map(approvalSummary),
        ),
    );
  }

  get(scope: PropertyScope, id: string) {
    return this.gate.execute(
      { action: 'approval.read', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () =>
        this.tx.read(async () => {
          const a = isUuid(id) ? await this.repo.approval(scope, id) : undefined;
          if (!a || a.propertyId !== scope.propertyId)
            throw AppError.notFound('ops.approval.not_found');
          return approvalSummary(a);
        }),
    );
  }

  decide(scope: PropertyScope, id: string, input: z.infer<typeof decideApprovalSchema>) {
    return this.gate.execute(
      { action: 'approval.decide', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () =>
        this.tx.run(async () => {
          const existing = isUuid(id) ? await this.repo.approval(scope, id) : undefined;
          if (!existing || existing.propertyId !== scope.propertyId)
            throw AppError.notFound('ops.approval.not_found');
          const decided = await this.approvals.decide(
            scope,
            id,
            input.decision === 'APPROVE',
            input.reason ?? null,
            this.actors.require(),
          );
          return approvalSummary(decided);
        }),
    );
  }
}
