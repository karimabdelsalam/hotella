import {
  boolean,
  date,
  index,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { baseColumns, classify, versioned } from '@hotella/platform-database';
import { SHIFTS } from '../domain/shifts';

/**
 * Logbook (Spec §14, BUILD_PLAN Phase 9, schema `logbook`): what happened on each shift of each department, written
 * once (corrections are new entries), and the handover the incoming supervisor acknowledges.
 */
export const logbook = pgSchema('logbook');

export const shift = logbook.enum('shift', SHIFTS);
export const entryKind = logbook.enum('entry_kind', ['NOTE', 'INCIDENT', 'HANDOVER_ITEM']);
export const handoverStatus = logbook.enum('handover_status', ['DRAFT', 'ACKNOWLEDGED']);
export const handoverSource = logbook.enum('handover_source', ['AI', 'WRITTEN']);

/** The facts a handover was built from: counts computed by code, never by a model. */
export interface HandoverFacts {
  readonly department: string;
  readonly shift_date: string;
  readonly shift: (typeof SHIFTS)[number];
  readonly window: { readonly from: string; readonly to: string };
  readonly work: { readonly open: number; readonly urgent: number; readonly overdue: number };
  readonly complaints: { readonly open: number; readonly high_or_critical: number } | null;
  readonly rooms_out_of_order: ReadonlyArray<{
    readonly room: string;
    readonly kind: string;
  }> | null;
  readonly lost_found: {
    readonly found_waiting: number;
    readonly lost_reports_open: number;
    readonly matches_to_decide: number;
    readonly past_retention: number;
  } | null;
  readonly entries: { readonly total: number; readonly incidents: number };
}

const audit = {
  id: 'INTERNAL',
  createdAt: 'INTERNAL',
  updatedAt: 'INTERNAL',
  tenantId: 'INTERNAL',
} as const;

export const entries = classify(
  logbook.table(
    'entries',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      departmentCode: varchar('department_code', { length: 32 }).notNull(),
      shiftDate: date('shift_date', { mode: 'string' }).notNull(),
      shift: shift('shift').notNull(),
      kind: entryKind('kind').notNull(),
      /** In the author's words (may name a guest: CONFIDENTIAL). */
      text: text('text').notNull(),
      roomId: uuid('room_id'),
      /** A correction points at the entry it corrects; the original stays as written. */
      correctsEntryId: uuid('corrects_entry_id'),
      authorType: varchar('author_type', { length: 16 }).notNull(),
      authorId: uuid('author_id'),
    },
    (t) => [
      index('entries_shift_idx').on(
        t.tenantId,
        t.propertyId,
        t.departmentCode,
        t.shiftDate,
        t.shift,
      ),
    ],
  ),
  {
    ...audit,
    propertyId: 'INTERNAL',
    departmentCode: 'INTERNAL',
    shiftDate: 'INTERNAL',
    shift: 'INTERNAL',
    kind: 'INTERNAL',
    text: 'CONFIDENTIAL',
    roomId: 'INTERNAL',
    correctsEntryId: 'INTERNAL',
    authorType: 'INTERNAL',
    authorId: 'INTERNAL',
  },
);

export const handovers = classify(
  logbook.table(
    'handovers',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      departmentCode: varchar('department_code', { length: 32 }).notNull(),
      /** The shift being handed over (its team writes it; the next one acknowledges it). */
      shiftDate: date('shift_date', { mode: 'string' }).notNull(),
      shift: shift('shift').notNull(),
      summary: text('summary').notNull().default(''),
      facts: jsonb('facts').$type<HandoverFacts>().notNull(),
      source: handoverSource('source').notNull(),
      /** A person changed the drafted summary before acknowledging it. */
      edited: boolean('edited').notNull().default(false),
      /** The staff-assistant execution that drafted it (Spec §36: every AI run is recorded). */
      executionId: uuid('execution_id'),
      status: handoverStatus('status').notNull().default('DRAFT'),
      draftedByType: varchar('drafted_by_type', { length: 16 }).notNull(),
      draftedById: uuid('drafted_by_id'),
      acknowledgedById: uuid('acknowledged_by_id'),
      acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true, mode: 'date' }),
      acknowledgementNote: text('acknowledgement_note'),
      ...versioned(),
    },
    (t) => [
      uniqueIndex('handovers_shift_uq').on(t.propertyId, t.departmentCode, t.shiftDate, t.shift),
    ],
  ),
  {
    ...audit,
    propertyId: 'INTERNAL',
    departmentCode: 'INTERNAL',
    shiftDate: 'INTERNAL',
    shift: 'INTERNAL',
    summary: 'CONFIDENTIAL',
    facts: 'INTERNAL',
    source: 'INTERNAL',
    edited: 'INTERNAL',
    executionId: 'INTERNAL',
    status: 'INTERNAL',
    draftedByType: 'INTERNAL',
    draftedById: 'INTERNAL',
    acknowledgedById: 'INTERNAL',
    acknowledgedAt: 'INTERNAL',
    acknowledgementNote: 'CONFIDENTIAL',
    version: 'INTERNAL',
  },
);

export type EntryRow = typeof entries.$inferSelect;
export type HandoverRow = typeof handovers.$inferSelect;
