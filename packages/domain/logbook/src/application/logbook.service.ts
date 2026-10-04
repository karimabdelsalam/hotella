import { HttpStatus, Inject, Injectable, Optional } from '@nestjs/common';
import { z } from 'zod';
import { HandoverAcknowledged } from '@hotella/contracts-events';
import { STAFF_ASSISTANT_API, type StaffAssistantApi } from '@hotella/domain-ai/public';
import { ORGANIZATION_API, type OrganizationPublicApi } from '@hotella/domain-organization/public';
import { AuditWriter } from '@hotella/platform-audit';
import { ActionGate, ActorStore } from '@hotella/platform-auth';
import { isUuid, newId, type PropertyScope, TransactionRunner } from '@hotella/platform-database';
import { EventPublisher } from '@hotella/platform-events';
import { AppError } from '@hotella/platform-i18n';
import { SHIFTS, type Shift } from '../domain/shifts';
import { LogbookRepositories } from '../infrastructure/repositories';
import type { HandoverRow } from '../infrastructure/schema';
import { FactsService } from './facts.service';

/** The staff assistant that drafts handovers (READ tools only). */
export const SHIFT_HANDOVER_AGENT = 'SHIFT_HANDOVER';

const department = z.string().regex(/^[A-Z][A-Z0-9_]{1,31}$/);
const shiftRef = {
  shiftDate: z.iso.date().optional(),
  shift: z.enum(SHIFTS).optional(),
};
export const addEntrySchema = z.object({
  departmentCode: department,
  kind: z.enum(['NOTE', 'INCIDENT', 'HANDOVER_ITEM']).default('NOTE'),
  text: z.string().trim().min(2).max(4000),
  roomId: z.uuid().optional(),
  /** A correction of an earlier entry (the original stays as written). */
  correctsEntryId: z.uuid().optional(),
});
export const shiftQuerySchema = z.object({ departmentCode: department, ...shiftRef });
export const draftHandoverSchema = z.object({
  departmentCode: department,
  ...shiftRef,
  /** Without the assistant the summary starts empty and is written by hand. */
  useAssistant: z.boolean().default(true),
});
export const editHandoverSchema = z.object({
  version: z.number().int().min(1),
  summary: z.string().trim().min(1).max(6000),
});
export const acknowledgeSchema = z.object({
  version: z.number().int().min(1),
  note: z.string().trim().max(1000).optional(),
});
export const listHandoversSchema = z.object({ departmentCode: department.optional() });

/**
 * The logbook (Spec §14): append-only entries per department and shift, and the handover. The facts a handover rests
 * on are counted by `FactsService` and stored with it; the SHIFT_HANDOVER assistant only writes the prose, and the
 * incoming supervisor (not the person who drafted it) edits and acknowledges it.
 */
@Injectable()
export class LogbookService {
  constructor(
    private readonly repo: LogbookRepositories,
    private readonly facts: FactsService,
    private readonly tx: TransactionRunner,
    private readonly gate: ActionGate,
    private readonly audit: AuditWriter,
    private readonly events: EventPublisher,
    private readonly actors: ActorStore,
    @Inject(ORGANIZATION_API) private readonly org: OrganizationPublicApi,
    @Optional() @Inject(STAFF_ASSISTANT_API) private readonly assistant?: StaffAssistantApi,
  ) {}

  addEntry(scope: PropertyScope, input: z.infer<typeof addEntrySchema>) {
    return this.act(scope, 'logbook.write', async () => {
      await this.department(scope, input.departmentCode);
      if (input.roomId && !(await this.org.getRoom(scope.tenantId, scope.propertyId, input.roomId)))
        throw AppError.notFound('org.room.not_found');
      if (input.correctsEntryId) {
        const original = await this.repo.entry(scope, input.correctsEntryId);
        if (!original || original.propertyId !== scope.propertyId)
          throw AppError.notFound('logbook.entry.not_found');
      }
      const now = await this.facts.current(scope);
      const actor = this.actors.require();
      const row = await this.repo.insertEntry({
        id: newId(),
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        departmentCode: input.departmentCode,
        shiftDate: now.shiftDate,
        shift: now.shift,
        kind: input.kind,
        text: input.text,
        roomId: input.roomId ?? null,
        correctsEntryId: input.correctsEntryId ?? null,
        authorType: actor.type,
        authorId: isUuid(actor.id) ? actor.id : null,
      });
      if (input.kind === 'INCIDENT')
        await this.audit.record({
          action: 'logbook.entry.incident',
          entityType: 'logbook_entry',
          entityId: row.id,
          tenantId: scope.tenantId,
          propertyId: scope.propertyId,
          after: { department: row.departmentCode, shiftDate: row.shiftDate, shift: row.shift },
        });
      return row;
    });
  }

  /** A shift of a department (the running one by default): its window, entries, facts and handover. */
  shift(scope: PropertyScope, query: z.infer<typeof shiftQuerySchema>) {
    return this.read(scope, async () => {
      const { shiftDate, shift } = await this.resolve(scope, query);
      const collected = await this.facts.collect(scope, query.departmentCode, shiftDate, shift);
      const rooms = new Map(
        (await this.org.listRooms(scope.tenantId, scope.propertyId)).map((r) => [
          r.id,
          r.roomNumber,
        ]),
      );
      return {
        departmentCode: query.departmentCode,
        shiftDate,
        shift,
        window: collected.facts.window,
        facts: collected.facts,
        entries: collected.entries.map((e) => ({
          ...e,
          roomNumber: e.roomId ? (rooms.get(e.roomId) ?? null) : null,
        })),
        handover:
          (await this.repo.handoverFor(scope, query.departmentCode, shiftDate, shift)) ?? null,
      };
    });
  }

  /**
   * Drafts (or redrafts) the handover of a shift: facts counted now, then the assistant writes the summary from them.
   * The model call runs outside any transaction; an acknowledged handover is never redrafted.
   */
  draftHandover(scope: PropertyScope, input: z.infer<typeof draftHandoverSchema>, locale: string) {
    return this.gate.execute(
      { action: 'logbook.write', tenantId: scope.tenantId, propertyId: scope.propertyId },
      async () => {
        await this.tx.read(() => this.department(scope, input.departmentCode));
        const { shiftDate, shift } = await this.tx.read(() => this.resolve(scope, input));
        const existing = await this.tx.read(() =>
          this.repo.handoverFor(scope, input.departmentCode, shiftDate, shift),
        );
        if (existing?.status === 'ACKNOWLEDGED')
          throw AppError.conflict('logbook.handover.acknowledged');
        const { facts } = await this.tx.read(() =>
          this.facts.collect(scope, input.departmentCode, shiftDate, shift),
        );
        const actor = this.actors.require();
        let summary = '';
        let executionId: string | null = null;
        if (input.useAssistant && this.assistant && isUuid(actor.id)) {
          const answer = await this.assistant.ask({
            tenantId: scope.tenantId,
            propertyId: scope.propertyId,
            agentCode: SHIFT_HANDOVER_AGENT,
            question: `Write the handover of department ${input.departmentCode} for the ${shift} shift of ${shiftDate}.`,
            locale,
            userId: actor.id,
          });
          executionId = answer.executionId;
          if (answer.outcome === 'ANSWERED' && answer.answer) summary = answer.answer;
        }
        return this.tx.run(async () => {
          const current = await this.repo.handoverFor(
            scope,
            input.departmentCode,
            shiftDate,
            shift,
            true,
          );
          if (current?.status === 'ACKNOWLEDGED')
            throw AppError.conflict('logbook.handover.acknowledged');
          const values = {
            summary,
            facts,
            source: summary ? ('AI' as const) : ('WRITTEN' as const),
            edited: false,
            executionId,
            draftedByType: actor.type,
            draftedById: isUuid(actor.id) ? actor.id : null,
          };
          const row = current
            ? await this.repo.updateHandover(scope, current.id, values)
            : await this.repo.insertHandover({
                id: newId(),
                tenantId: scope.tenantId,
                propertyId: scope.propertyId,
                departmentCode: input.departmentCode,
                shiftDate,
                shift,
                ...values,
              });
          await this.audit.record({
            action: 'logbook.handover.draft',
            entityType: 'logbook_handover',
            entityId: row.id,
            tenantId: scope.tenantId,
            propertyId: scope.propertyId,
            after: { source: row.source, executionId, facts },
          });
          return row;
        });
      },
    );
  }

  editHandover(scope: PropertyScope, id: string, input: z.infer<typeof editHandoverSchema>) {
    return this.act(scope, 'logbook.write', async () => {
      const current = await this.draft(scope, id, input.version);
      return this.repo.updateHandover(scope, current.id, {
        summary: input.summary,
        edited: current.edited || input.summary !== current.summary,
      });
    });
  }

  /** The incoming supervisor takes the shift over: someone other than the person who drafted it. */
  acknowledge(scope: PropertyScope, id: string, input: z.infer<typeof acknowledgeSchema>) {
    return this.act(scope, 'logbook.handover.acknowledge', async () => {
      const current = await this.draft(scope, id, input.version);
      if (!current.summary.trim()) throw AppError.conflict('logbook.handover.empty');
      const actor = this.actors.require();
      if (current.draftedById && current.draftedById === actor.id)
        throw AppError.conflict('logbook.handover.self_acknowledge');
      const row = await this.repo.updateHandover(scope, current.id, {
        status: 'ACKNOWLEDGED',
        acknowledgedById: isUuid(actor.id) ? actor.id : null,
        acknowledgedAt: new Date(),
        acknowledgementNote: input.note ?? null,
      });
      await this.events.publish(HandoverAcknowledged, {
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        source: 'logbook',
        aggregate: { type: 'logbook_handover', id: row.id },
        payload: {
          handover_id: row.id,
          department_code: row.departmentCode,
          shift_date: row.shiftDate,
          shift: row.shift,
          source: row.source,
          edited: row.edited,
        },
      });
      await this.audit.record({
        action: 'logbook.handover.acknowledge',
        entityType: 'logbook_handover',
        entityId: row.id,
        tenantId: scope.tenantId,
        propertyId: scope.propertyId,
        after: { source: row.source, edited: row.edited },
        ...(input.note ? { reason: input.note } : {}),
      });
      return row;
    });
  }

  handovers(scope: PropertyScope, query: z.infer<typeof listHandoversSchema>) {
    return this.read(scope, () => this.repo.handoversOf(scope, query.departmentCode));
  }

  // ---- helpers ----

  private async resolve(
    scope: PropertyScope,
    query: { shiftDate?: string | undefined; shift?: Shift | undefined },
  ): Promise<{ shiftDate: string; shift: Shift }> {
    if (query.shiftDate && query.shift) return { shiftDate: query.shiftDate, shift: query.shift };
    if (query.shiftDate || query.shift)
      throw new AppError('logbook.shift.incomplete', HttpStatus.BAD_REQUEST);
    const now = await this.facts.current(scope);
    return { shiftDate: now.shiftDate, shift: now.shift };
  }

  private async department(scope: PropertyScope, code: string) {
    const d = await this.org.getDepartment(scope.tenantId, scope.propertyId, code);
    if (!d || d.status !== 'ACTIVE') throw AppError.notFound('org.department.not_found');
    return d;
  }

  private async draft(scope: PropertyScope, id: string, version: number): Promise<HandoverRow> {
    const row = isUuid(id) ? await this.repo.handover(scope, id, true) : undefined;
    if (!row || row.propertyId !== scope.propertyId)
      throw AppError.notFound('logbook.handover.not_found');
    if (row.version !== version) throw AppError.conflict('logbook.handover.version_conflict');
    if (row.status === 'ACKNOWLEDGED') throw AppError.conflict('logbook.handover.acknowledged');
    return row;
  }

  private act<T>(scope: PropertyScope, action: string, fn: () => Promise<T>): Promise<T> {
    return this.gate.execute(
      { action, tenantId: scope.tenantId, propertyId: scope.propertyId },
      () => this.tx.run(fn),
    );
  }

  private read<T>(scope: PropertyScope, fn: () => Promise<T>): Promise<T> {
    return this.gate.execute(
      { action: 'logbook.read', tenantId: scope.tenantId, propertyId: scope.propertyId },
      () => this.tx.read(fn),
    );
  }
}
