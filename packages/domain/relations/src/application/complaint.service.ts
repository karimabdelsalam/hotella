import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ComplaintOpened, ComplaintResolved } from '@hotella/contracts-events';
import { GUEST_API, type GuestPublicApi } from '@hotella/domain-guest/public';
import { ORGANIZATION_API, type OrganizationPublicApi } from '@hotella/domain-organization/public';
import { AuditWriter } from '@hotella/platform-audit';
import { ActionGate, ActorStore } from '@hotella/platform-auth';
import {
  isUuid,
  newId,
  type PropertyScope,
  type TenantScope,
  TransactionRunner,
} from '@hotella/platform-database';
import { EventPublisher } from '@hotella/platform-events';
import { AppError } from '@hotella/platform-i18n';
import {
  canMove,
  COMPLAINT_SEVERITIES,
  type ComplaintSeverity,
  type ComplaintStatus,
} from '../domain/complaints';
import { STARTER_CATEGORIES } from '../domain/starter';
import { RelationsRepositories } from '../infrastructure/repositories';
import type { ComplaintRow } from '../infrastructure/schema';

const locale = z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/);
export const createCategorySchema = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/),
  defaultSeverity: z.enum(COMPLAINT_SEVERITIES).default('MEDIUM'),
  departmentCode: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{1,31}$/)
    .nullish(),
  names: z
    .array(z.object({ locale, name: z.string().trim().min(1).max(120) }))
    .min(1)
    .max(10),
});
export const openComplaintSchema = z.object({
  categoryId: z.uuid(),
  severity: z.enum(COMPLAINT_SEVERITIES).optional(),
  summary: z.string().trim().min(3).max(500),
  description: z.string().trim().max(4000).optional(),
  stayId: z.uuid().optional(),
  roomId: z.uuid().optional(),
  links: z
    .array(
      z.object({
        kind: z.enum(['SERVICE_REQUEST', 'TASK', 'ASSET', 'WORK_ORDER', 'USER']),
        ref: z.uuid(),
      }),
    )
    .max(20)
    .default([]),
});
export const moveComplaintSchema = z.object({
  to: z.enum(['IN_PROGRESS', 'RESOLVED', 'CLOSED']),
  version: z.number().int().min(1),
  note: z.string().trim().max(1000).optional(),
});
export const noteSchema = z.object({ text: z.string().trim().min(1).max(4000) });
export const listComplaintsSchema = z.object({
  status: z
    .string()
    .transform((v) => v.split(',').filter(Boolean))
    .pipe(z.array(z.enum(['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'])))
    .optional(),
});

/** The name in the person's language, else English, else any, else the code. */
export function nameIn(
  list: ReadonlyArray<{ locale: string; name: string }> | undefined,
  lang: string,
  code: string,
): string {
  return (
    list?.find((n) => n.locale === lang)?.name ??
    list?.find((n) => n.locale === 'en')?.name ??
    list?.[0]?.name ??
    code
  );
}

export interface OpenInput {
  readonly categoryId: string;
  readonly severity?: ComplaintSeverity;
  readonly summary: string;
  readonly description?: string;
  readonly stayId?: string | null;
  readonly guestId?: string | null;
  readonly roomId?: string | null;
  readonly links: ReadonlyArray<{ kind: string; ref: string }>;
  readonly source: ComplaintRow['source'];
}

/**
 * Complaints (Spec §12): recorded by staff or confirmed from an AI candidate, never a service request. Every status
 * change is kept; resolving publishes how long it took and what recovery was given.
 */
@Injectable()
export class ComplaintService {
  constructor(
    private readonly repo: RelationsRepositories,
    private readonly tx: TransactionRunner,
    private readonly gate: ActionGate,
    private readonly audit: AuditWriter,
    private readonly events: EventPublisher,
    private readonly actors: ActorStore,
    @Inject(ORGANIZATION_API) private readonly org: OrganizationPublicApi,
    @Inject(GUEST_API) private readonly guests: GuestPublicApi,
  ) {}

  // ---- categories (tenant-wide) ----

  createCategory(scope: TenantScope, input: z.infer<typeof createCategorySchema>) {
    return this.gate.execute(
      { action: 'complaint.category.manage', tenantId: scope.tenantId },
      () =>
        this.tx.run(async () => {
          const row = await this.repo.insertCategory({
            id: newId(),
            tenantId: scope.tenantId,
            code: input.code,
            defaultSeverity: input.defaultSeverity,
            departmentCode: input.departmentCode ?? null,
          });
          if (!row) throw AppError.conflict('relations.category.code_taken');
          await this.repo.putCategoryNames(row.id, input.names);
          return { ...row, names: input.names };
        }),
    );
  }

  /** The starter categories in English and Arabic; codes the tenant already has are left alone. */
  importStarter(scope: TenantScope) {
    return this.gate.execute(
      { action: 'complaint.category.manage', tenantId: scope.tenantId },
      () =>
        this.tx.run(async () => {
          let created = 0;
          for (const c of STARTER_CATEGORIES) {
            const row = await this.repo.insertCategory({
              id: newId(),
              tenantId: scope.tenantId,
              code: c.code,
              defaultSeverity: c.severity,
              departmentCode: c.department,
            });
            if (!row) continue;
            created++;
            await this.repo.putCategoryNames(row.id, c.names);
          }
          await this.audit.record({
            action: 'relations.category.starter',
            entityType: 'tenant',
            entityId: scope.tenantId,
            tenantId: scope.tenantId,
            after: { created },
          });
          return { created };
        }),
    );
  }

  listCategories(scope: TenantScope, lang: string) {
    return this.gate.execute({ action: 'complaint.read', tenantId: scope.tenantId }, () =>
      this.tx.read(async () => {
        const rows = await this.repo.categoriesOf(scope);
        const names = await this.repo.categoryNames(rows.map((r) => r.id));
        return rows.map((r) => ({ ...r, name: nameIn(names.get(r.id), lang, r.code) }));
      }),
    );
  }

  // ---- complaints ----

  open(scope: PropertyScope, input: z.infer<typeof openComplaintSchema>) {
    return this.gate.execute(
      { action: 'complaint.manage', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () =>
        this.tx.run(async () => {
          let guestId: string | null = null;
          if (input.stayId) {
            const stay = await this.guests.getStay(scope.tenantId, input.stayId);
            if (!stay || stay.propertyId !== scope.propertyId)
              throw AppError.notFound('guest.stay.not_found');
            guestId = stay.primaryGuestId;
          }
          return this.record(scope, { ...input, guestId, source: 'STAFF' });
        }),
    );
  }

  /** Records a complaint inside the caller's transaction (staff, or a confirmed candidate). */
  async record(scope: PropertyScope, input: OpenInput): Promise<ComplaintRow> {
    const category = await this.repo.category(scope, input.categoryId);
    if (!category || !category.active) throw AppError.notFound('relations.category.not_found');
    if (input.roomId && !(await this.org.getRoom(scope.tenantId, scope.propertyId, input.roomId)))
      throw AppError.notFound('org.room.not_found');
    const actor = this.actors.require();
    const now = new Date();
    const row = await this.repo.insertComplaint({
      id: newId(),
      tenantId: scope.tenantId,
      propertyId: scope.propertyId,
      number: await this.repo.nextNumber(scope),
      guestId: input.guestId ?? null,
      stayId: input.stayId ?? null,
      categoryId: category.id,
      severity: input.severity ?? category.defaultSeverity,
      source: input.source,
      summary: input.summary,
      description: input.description ?? null,
      openedAt: now,
      openedByType: actor.type,
      openedById: isUuid(actor.id) ? actor.id : null,
    });
    await this.repo.insertHistory({
      id: newId(),
      tenantId: scope.tenantId,
      complaintId: row.id,
      fromStatus: null,
      toStatus: 'OPEN',
      actorType: actor.type,
      actorId: isUuid(actor.id) ? actor.id : null,
    });
    if (input.roomId)
      await this.repo.insertLink({
        id: newId(),
        tenantId: scope.tenantId,
        complaintId: row.id,
        kind: 'ROOM',
        ref: input.roomId,
      });
    for (const l of input.links)
      await this.repo.insertLink({
        id: newId(),
        tenantId: scope.tenantId,
        complaintId: row.id,
        kind: l.kind as 'TASK',
        ref: l.ref,
      });
    await this.events.publish(ComplaintOpened, {
      tenantId: scope.tenantId,
      propertyId: scope.propertyId,
      source: 'relations',
      aggregate: { type: 'complaint', id: row.id },
      payload: {
        complaint_id: row.id,
        number: row.number,
        category_code: category.code,
        severity: row.severity,
        source: row.source,
        stay_id: row.stayId,
      },
    });
    await this.audit.record({
      action: 'relations.complaint.open',
      entityType: 'complaint',
      entityId: row.id,
      tenantId: scope.tenantId,
      propertyId: scope.propertyId,
      after: {
        number: row.number,
        category: category.code,
        severity: row.severity,
        source: row.source,
      },
    });
    return row;
  }

  move(scope: PropertyScope, id: string, input: z.infer<typeof moveComplaintSchema>) {
    return this.gate.execute(
      { action: 'complaint.manage', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () =>
        this.tx.run(async () => {
          const current = await this.find(scope, id, true);
          if (current.version !== input.version)
            throw AppError.conflict('relations.complaint.version_conflict');
          if (!canMove(current.status, input.to))
            throw new AppError('relations.complaint.invalid_move', HttpStatus.CONFLICT, {
              from: current.status,
              to: input.to,
            });
          const now = new Date();
          const row = await this.repo.updateComplaint(scope, current.id, {
            status: input.to,
            ...(input.to === 'RESOLVED' ? { resolvedAt: now } : {}),
            ...(input.to === 'IN_PROGRESS' && current.status === 'RESOLVED'
              ? { resolvedAt: null }
              : {}),
            ...(input.to === 'CLOSED' ? { closedAt: now } : {}),
          });
          const actor = this.actors.require();
          await this.repo.insertHistory({
            id: newId(),
            tenantId: scope.tenantId,
            complaintId: row.id,
            fromStatus: current.status as ComplaintStatus,
            toStatus: input.to,
            note: input.note ?? null,
            actorType: actor.type,
            actorId: isUuid(actor.id) ? actor.id : null,
          });
          if (input.to === 'RESOLVED') {
            const category = (await this.repo.category(scope, row.categoryId))!;
            const recovery = await this.repo.recoveryOf(scope, row.id);
            await this.events.publish(ComplaintResolved, {
              tenantId: scope.tenantId,
              propertyId: scope.propertyId,
              source: 'relations',
              aggregate: { type: 'complaint', id: row.id },
              payload: {
                complaint_id: row.id,
                category_code: category.code,
                severity: row.severity,
                open_minutes: Math.max(
                  0,
                  Math.round((now.getTime() - row.openedAt.getTime()) / 60_000),
                ),
                recovery_kinds: [
                  ...new Set(recovery.filter((r) => r.status === 'DONE').map((r) => r.kind)),
                ],
              },
            });
          }
          await this.audit.record({
            action: `relations.complaint.${input.to.toLowerCase()}`,
            entityType: 'complaint',
            entityId: row.id,
            tenantId: scope.tenantId,
            propertyId: scope.propertyId,
            before: { status: current.status },
            after: { status: row.status },
            ...(input.note ? { reason: input.note } : {}),
          });
          return row;
        }),
    );
  }

  addNote(scope: PropertyScope, id: string, input: z.infer<typeof noteSchema>) {
    return this.gate.execute(
      { action: 'complaint.manage', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () =>
        this.tx.run(async () => {
          const complaint = await this.find(scope, id);
          const actor = this.actors.require();
          return this.repo.insertEvidence({
            id: newId(),
            tenantId: scope.tenantId,
            complaintId: complaint.id,
            kind: 'NOTE',
            text: input.text,
            addedByType: actor.type,
            addedById: isUuid(actor.id) ? actor.id : null,
          });
        }),
    );
  }

  list(scope: PropertyScope, query: z.infer<typeof listComplaintsSchema>, lang: string) {
    return this.read(scope, async () => {
      const rows = await this.repo.complaintsOf(
        scope,
        query.status ? { statuses: query.status } : {},
      );
      const cats = new Map((await this.repo.categoriesOf(scope)).map((c) => [c.id, c]));
      const names = await this.repo.categoryNames([...cats.keys()]);
      return rows.map((r) => ({
        ...r,
        categoryCode: cats.get(r.categoryId)?.code ?? null,
        categoryName: nameIn(names.get(r.categoryId), lang, cats.get(r.categoryId)?.code ?? ''),
      }));
    });
  }

  get(scope: PropertyScope, id: string, lang: string) {
    return this.read(scope, async () => {
      const row = await this.find(scope, id);
      const category = (await this.repo.category(scope, row.categoryId))!;
      const names = await this.repo.categoryNames([category.id]);
      const linkRows = await this.repo.linksOf(scope, row.id);
      const roomLink = linkRows.find((l) => l.kind === 'ROOM');
      const room = roomLink
        ? await this.org.getRoom(scope.tenantId, scope.propertyId, roomLink.ref)
        : null;
      return {
        ...row,
        categoryCode: category.code,
        categoryName: nameIn(names.get(category.id), lang, category.code),
        roomNumber: room?.roomNumber ?? null,
        links: linkRows.map((l) => ({ kind: l.kind, ref: l.ref })),
        evidence: await this.repo.evidenceOf(scope, row.id),
        history: await this.repo.historyOf(scope, row.id),
        recovery: await this.repo.recoveryOf(scope, row.id),
      };
    });
  }

  async find(scope: PropertyScope, id: string, lock = false): Promise<ComplaintRow> {
    const row = isUuid(id)
      ? lock
        ? await this.repo.complaintForUpdate(scope, id)
        : await this.repo.complaint(scope, id)
      : undefined;
    if (!row || row.propertyId !== scope.propertyId)
      throw AppError.notFound('relations.complaint.not_found');
    return row;
  }

  private read<T>(scope: PropertyScope, fn: () => Promise<T>): Promise<T> {
    return this.gate.execute(
      { action: 'complaint.read', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () => this.tx.read(fn),
    );
  }
}
