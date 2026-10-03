import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AuditWriter } from '@hotella/platform-audit';
import { ActionGate, ActorStore } from '@hotella/platform-auth';
import { isUuid, newId, type PropertyScope, TransactionRunner } from '@hotella/platform-database';
import { AppError } from '@hotella/platform-i18n';
import {
  CANDIDATE_MIN_CONFIDENCE,
  COMPLAINT_SEVERITIES,
  type ComplaintSeverity,
} from '../domain/complaints';
import { RelationsRepositories } from '../infrastructure/repositories';
import type { CandidateRow } from '../infrastructure/schema';
import { ComplaintService, nameIn } from './complaint.service';

export const confirmCandidateSchema = z.object({
  version: z.number().int().min(1),
  /** The person may correct what the AI chose. */
  categoryId: z.uuid().optional(),
  severity: z.enum(COMPLAINT_SEVERITIES).optional(),
  summary: z.string().trim().min(3).max(500).optional(),
});
export const dismissCandidateSchema = z.object({
  version: z.number().int().min(1),
  note: z.string().trim().max(500).optional(),
});

export interface SuggestInput {
  readonly tenantId: string;
  readonly propertyId: string;
  readonly stayId: string;
  readonly guestId: string;
  readonly conversationId: string | null;
  readonly executionId: string;
  readonly categoryCode: string;
  readonly severity: ComplaintSeverity;
  readonly confidence: number;
  readonly summary: string;
  readonly reason: string;
  readonly guestWords: string | null;
}

export type SuggestOutcome =
  | { readonly recorded: true; readonly candidateId: string; readonly duplicate: boolean }
  | { readonly recorded: false; readonly why: 'LOW_CONFIDENCE' };

/**
 * Complaint candidates (BUILD_PLAN 9.B): what the concierge thinks it heard, kept apart from complaints until a
 * guest-relations person confirms (→ a complaint carrying the guest's words and the AI's reason as evidence) or
 * dismisses it. Below the confidence floor nothing is kept; the same stay and category is never suggested twice.
 */
@Injectable()
export class CandidateService {
  constructor(
    private readonly repo: RelationsRepositories,
    private readonly tx: TransactionRunner,
    private readonly gate: ActionGate,
    private readonly audit: AuditWriter,
    private readonly actors: ActorStore,
    private readonly complaints: ComplaintService,
  ) {}

  /** Called by the `relations.suggest_complaint` tool, which already passed the ActionGate as the AI agent. */
  suggest(input: SuggestInput): Promise<SuggestOutcome> {
    if (input.confidence < CANDIDATE_MIN_CONFIDENCE)
      return Promise.resolve({ recorded: false, why: 'LOW_CONFIDENCE' });
    return this.tx.run(async () => {
      const scope = { tenantId: input.tenantId, propertyId: input.propertyId };
      // A code the tenant does not use becomes OTHER (when it exists); the person confirming can correct it.
      const known = await this.repo.categoryByCode(scope, input.categoryCode);
      const code = known?.active
        ? known.code
        : ((await this.repo.categoryByCode(scope, 'OTHER'))?.code ?? input.categoryCode);
      const row = await this.repo.insertCandidate({
        id: newId(),
        tenantId: input.tenantId,
        propertyId: input.propertyId,
        stayId: input.stayId,
        guestId: input.guestId,
        conversationId: input.conversationId,
        categoryCode: code,
        severity: input.severity,
        confidence: input.confidence,
        summary: input.summary,
        reason: input.reason,
        guestWords: input.guestWords,
        executionId: input.executionId,
      });
      if (!row) {
        const existing = (await this.repo.pendingCandidateFor(scope, input.stayId, code))!;
        return { recorded: true, candidateId: existing.id, duplicate: true };
      }
      await this.audit.record({
        action: 'relations.candidate.suggest',
        entityType: 'complaint_candidate',
        entityId: row.id,
        tenantId: input.tenantId,
        propertyId: input.propertyId,
        after: { category: code, severity: row.severity, confidence: row.confidence },
      });
      return { recorded: true, candidateId: row.id, duplicate: false };
    });
  }

  list(scope: PropertyScope, lang: string) {
    return this.gate.execute(
      { action: 'complaint.read', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () =>
        this.tx.read(async () => {
          const rows = await this.repo.candidatesOf(scope, 'PENDING');
          const cats = new Map((await this.repo.categoriesOf(scope)).map((c) => [c.code, c]));
          const names = await this.repo.categoryNames([...cats.values()].map((c) => c.id));
          return rows.map((r) => {
            const cat = cats.get(r.categoryCode);
            return {
              ...r,
              categoryId: cat?.id ?? null,
              categoryName: cat ? nameIn(names.get(cat.id), lang, cat.code) : r.categoryCode,
            };
          });
        }),
    );
  }

  confirm(scope: PropertyScope, id: string, input: z.infer<typeof confirmCandidateSchema>) {
    return this.gate.execute(
      { action: 'complaint.manage', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () =>
        this.tx.run(async () => {
          const candidate = await this.pending(scope, id, input.version);
          const category = input.categoryId
            ? await this.repo.category(scope, input.categoryId)
            : await this.repo.categoryByCode(scope, candidate.categoryCode);
          if (!category) throw AppError.notFound('relations.category.not_found');
          const complaint = await this.complaints.record(scope, {
            categoryId: category.id,
            severity: input.severity ?? candidate.severity,
            summary: input.summary ?? candidate.summary,
            stayId: candidate.stayId,
            guestId: candidate.guestId,
            links: [],
            source: 'AI_CANDIDATE',
          });
          // The guest's words and the AI's reason travel with the complaint, as the AI recorded them.
          if (candidate.guestWords)
            await this.repo.insertEvidence({
              id: newId(),
              tenantId: scope.tenantId,
              complaintId: complaint.id,
              kind: 'MESSAGE',
              ref: candidate.conversationId ? `conversation:${candidate.conversationId}` : null,
              text: candidate.guestWords,
              addedByType: 'GUEST',
              addedById: candidate.guestId,
            });
          await this.repo.insertEvidence({
            id: newId(),
            tenantId: scope.tenantId,
            complaintId: complaint.id,
            kind: 'AI_REASON',
            ref: candidate.executionId ? `execution:${candidate.executionId}` : null,
            text: `${candidate.reason} (${Math.round(candidate.confidence * 100)}%)`,
            addedByType: 'AI_AGENT',
            addedById: candidate.executionId,
          });
          const decided = await this.decide(scope, candidate, 'CONFIRMED', complaint.id);
          await this.audit.record({
            action: 'relations.candidate.confirm',
            entityType: 'complaint_candidate',
            entityId: candidate.id,
            tenantId: scope.tenantId,
            propertyId: scope.propertyId,
            after: { complaint: complaint.id, category: category.code },
          });
          return { candidate: decided, complaint };
        }),
    );
  }

  dismiss(scope: PropertyScope, id: string, input: z.infer<typeof dismissCandidateSchema>) {
    return this.gate.execute(
      { action: 'complaint.manage', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () =>
        this.tx.run(async () => {
          const candidate = await this.pending(scope, id, input.version);
          const decided = await this.decide(scope, candidate, 'DISMISSED', null);
          await this.audit.record({
            action: 'relations.candidate.dismiss',
            entityType: 'complaint_candidate',
            entityId: candidate.id,
            tenantId: scope.tenantId,
            propertyId: scope.propertyId,
            ...(input.note ? { reason: input.note } : {}),
          });
          return decided;
        }),
    );
  }

  private async pending(scope: PropertyScope, id: string, version: number): Promise<CandidateRow> {
    const row = isUuid(id) ? await this.repo.candidateForUpdate(scope, id) : undefined;
    if (!row || row.propertyId !== scope.propertyId)
      throw AppError.notFound('relations.candidate.not_found');
    if (row.version !== version) throw AppError.conflict('relations.candidate.version_conflict');
    if (row.status !== 'PENDING') throw AppError.conflict('relations.candidate.already_decided');
    return row;
  }

  private decide(
    scope: PropertyScope,
    candidate: CandidateRow,
    status: 'CONFIRMED' | 'DISMISSED',
    complaintId: string | null,
  ) {
    const actor = this.actors.require();
    return this.repo.updateCandidate(scope, candidate.id, {
      status,
      decidedByType: actor.type,
      decidedById: isUuid(actor.id) ? actor.id : null,
      decidedAt: new Date(),
      complaintId,
    });
  }
}
