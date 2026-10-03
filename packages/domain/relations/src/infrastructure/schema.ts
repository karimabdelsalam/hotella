import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  pgSchema,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import {
  baseColumns,
  classify,
  translationColumns,
  translationUnique,
  versioned,
} from '@hotella/platform-database';
import { COMPLAINT_SEVERITIES, COMPLAINT_STATUSES, RECOVERY_KINDS } from '../domain/complaints';

/**
 * Guest relations (Spec §12, BUILD_PLAN Phase 9, schema `relations`). A complaint is not a service request: it has its
 * own lifecycle, evidence and service recovery; the AI may only suggest one.
 */
export const relations = pgSchema('relations');

export const complaintSeverity = relations.enum('complaint_severity', COMPLAINT_SEVERITIES);
export const complaintStatus = relations.enum('complaint_status', COMPLAINT_STATUSES);
export const complaintSource = relations.enum('complaint_source', [
  'STAFF',
  'GUEST_WEB',
  'CHAT',
  'AI_CANDIDATE',
  'SURVEY',
]);
export const linkKind = relations.enum('complaint_link_kind', [
  'ROOM',
  'SERVICE_REQUEST',
  'TASK',
  'ASSET',
  'WORK_ORDER',
  'USER',
]);
export const evidenceKind = relations.enum('complaint_evidence_kind', [
  'MESSAGE',
  'NOTE',
  'PHOTO',
  'AI_REASON',
]);
export const candidateStatus = relations.enum('candidate_status', [
  'PENDING',
  'CONFIRMED',
  'DISMISSED',
]);
export const recoveryKind = relations.enum('recovery_kind', RECOVERY_KINDS);
export const recoveryStatus = relations.enum('recovery_status', [
  'DONE',
  'PENDING_APPROVAL',
  'REJECTED',
]);

const audit = {
  id: 'INTERNAL',
  createdAt: 'INTERNAL',
  updatedAt: 'INTERNAL',
  tenantId: 'INTERNAL',
} as const;

/** What a complaint is about (noise, cleanliness, staff, food…) and the department that owns it. */
export const categories = classify(
  relations.table(
    'complaint_categories',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      code: varchar('code', { length: 40 }).notNull(),
      defaultSeverity: complaintSeverity('default_severity').notNull().default('MEDIUM'),
      departmentCode: varchar('department_code', { length: 32 }),
      active: boolean('active').notNull().default(true),
      ...versioned(),
    },
    (t) => [uniqueIndex('complaint_categories_code_uq').on(t.tenantId, t.code)],
  ),
  {
    ...audit,
    code: 'INTERNAL',
    defaultSeverity: 'INTERNAL',
    departmentCode: 'INTERNAL',
    active: 'INTERNAL',
    version: 'INTERNAL',
  },
);

export const categoryTranslations = classify(
  relations.table(
    'complaint_category_translations',
    { ...translationColumns(() => categories.id), name: text('name').notNull() },
    (t) => [translationUnique('complaint_category_translations', t)],
  ),
  {
    entityId: 'INTERNAL',
    locale: 'INTERNAL',
    name: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
  },
);

export const complaints = classify(
  relations.table(
    'complaints',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      number: integer('number').notNull(),
      guestId: uuid('guest_id'),
      stayId: uuid('stay_id'),
      categoryId: uuid('category_id')
        .notNull()
        .references(() => categories.id, { onDelete: 'restrict' }),
      severity: complaintSeverity('severity').notNull(),
      status: complaintStatus('status').notNull().default('OPEN'),
      source: complaintSource('source').notNull(),
      /** What happened, in the reporter's words (may name the guest: CONFIDENTIAL). */
      summary: text('summary').notNull(),
      description: text('description'),
      detectedSentiment: varchar('detected_sentiment', { length: 16 }),
      openedAt: timestamp('opened_at', { withTimezone: true, mode: 'date' }).notNull(),
      resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'date' }),
      closedAt: timestamp('closed_at', { withTimezone: true, mode: 'date' }),
      openedByType: varchar('opened_by_type', { length: 16 }).notNull(),
      openedById: uuid('opened_by_id'),
      ...versioned(),
    },
    (t) => [
      uniqueIndex('complaints_number_uq').on(t.propertyId, t.number),
      index('complaints_status_idx').on(t.tenantId, t.propertyId, t.status),
      index('complaints_stay_idx').on(t.tenantId, t.stayId),
    ],
  ),
  {
    ...audit,
    propertyId: 'INTERNAL',
    number: 'INTERNAL',
    guestId: 'CONFIDENTIAL',
    stayId: 'CONFIDENTIAL',
    categoryId: 'INTERNAL',
    severity: 'INTERNAL',
    status: 'INTERNAL',
    source: 'INTERNAL',
    summary: 'CONFIDENTIAL',
    description: 'CONFIDENTIAL',
    detectedSentiment: 'INTERNAL',
    openedAt: 'INTERNAL',
    resolvedAt: 'INTERNAL',
    closedAt: 'INTERNAL',
    openedByType: 'INTERNAL',
    openedById: 'INTERNAL',
    version: 'INTERNAL',
  },
);

/** Every status change of a complaint, as it happened (rule 10: history is never overwritten). */
export const statusHistory = classify(
  relations.table(
    'complaint_status_history',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      complaintId: uuid('complaint_id')
        .notNull()
        .references(() => complaints.id, { onDelete: 'restrict' }),
      fromStatus: complaintStatus('from_status'),
      toStatus: complaintStatus('to_status').notNull(),
      note: text('note'),
      actorType: varchar('actor_type', { length: 16 }).notNull(),
      actorId: uuid('actor_id'),
    },
    (t) => [index('complaint_status_history_idx').on(t.complaintId)],
  ),
  {
    ...audit,
    complaintId: 'INTERNAL',
    fromStatus: 'INTERNAL',
    toStatus: 'INTERNAL',
    note: 'CONFIDENTIAL',
    actorType: 'INTERNAL',
    actorId: 'INTERNAL',
  },
);

export const links = classify(
  relations.table(
    'complaint_links',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      complaintId: uuid('complaint_id')
        .notNull()
        .references(() => complaints.id, { onDelete: 'restrict' }),
      kind: linkKind('kind').notNull(),
      ref: uuid('ref').notNull(),
    },
    (t) => [uniqueIndex('complaint_links_uq').on(t.complaintId, t.kind, t.ref)],
  ),
  { ...audit, complaintId: 'INTERNAL', kind: 'INTERNAL', ref: 'INTERNAL' },
);

/** What the complaint rests on: guest messages, staff notes, photos and the AI's stated reason (append-only). */
export const evidence = classify(
  relations.table(
    'complaint_evidence',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      complaintId: uuid('complaint_id')
        .notNull()
        .references(() => complaints.id, { onDelete: 'restrict' }),
      kind: evidenceKind('kind').notNull(),
      ref: varchar('ref', { length: 200 }),
      text: text('text'),
      addedByType: varchar('added_by_type', { length: 16 }).notNull(),
      addedById: uuid('added_by_id'),
    },
    (t) => [index('complaint_evidence_idx').on(t.complaintId)],
  ),
  {
    ...audit,
    complaintId: 'INTERNAL',
    kind: 'INTERNAL',
    ref: 'INTERNAL',
    text: 'CONFIDENTIAL',
    addedByType: 'INTERNAL',
    addedById: 'INTERNAL',
  },
);

/** A complaint the AI thinks it heard, with its confidence and reason, until a person confirms or dismisses it. */
export const candidates = classify(
  relations.table(
    'complaint_candidates',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      stayId: uuid('stay_id'),
      guestId: uuid('guest_id'),
      conversationId: uuid('conversation_id'),
      categoryCode: varchar('category_code', { length: 40 }).notNull(),
      severity: complaintSeverity('severity').notNull(),
      confidence: real('confidence').notNull(),
      summary: text('summary').notNull(),
      reason: text('reason').notNull(),
      /** The guest's own words the suggestion rests on (copied as MESSAGE evidence on confirmation). */
      guestWords: text('guest_words'),
      executionId: uuid('execution_id'),
      status: candidateStatus('status').notNull().default('PENDING'),
      decidedByType: varchar('decided_by_type', { length: 16 }),
      decidedById: uuid('decided_by_id'),
      decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'date' }),
      complaintId: uuid('complaint_id').references(() => complaints.id, { onDelete: 'restrict' }),
      ...versioned(),
    },
    (t) => [
      index('complaint_candidates_status_idx').on(t.tenantId, t.propertyId, t.status),
      // One pending candidate per stay and category: the concierge hearing the same complaint again adds nothing.
      uniqueIndex('complaint_candidates_pending_uq')
        .on(t.stayId, t.categoryCode)
        .where(sql`status = 'PENDING'`),
    ],
  ),
  {
    ...audit,
    propertyId: 'INTERNAL',
    stayId: 'CONFIDENTIAL',
    guestId: 'CONFIDENTIAL',
    conversationId: 'INTERNAL',
    categoryCode: 'INTERNAL',
    severity: 'INTERNAL',
    confidence: 'INTERNAL',
    summary: 'CONFIDENTIAL',
    reason: 'CONFIDENTIAL',
    guestWords: 'CONFIDENTIAL',
    executionId: 'INTERNAL',
    status: 'INTERNAL',
    decidedByType: 'INTERNAL',
    decidedById: 'INTERNAL',
    decidedAt: 'INTERNAL',
    complaintId: 'INTERNAL',
    version: 'INTERNAL',
  },
);

/** Service recovery for a complaint; anything with an amount waits for an approval. */
export const recoveryActions = classify(
  relations.table(
    'recovery_actions',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      complaintId: uuid('complaint_id')
        .notNull()
        .references(() => complaints.id, { onDelete: 'restrict' }),
      kind: recoveryKind('kind').notNull(),
      amountMinor: bigint('amount_minor', { mode: 'number' }),
      currency: varchar('currency', { length: 3 }),
      note: text('note'),
      status: recoveryStatus('status').notNull(),
      approvalId: uuid('approval_id'),
      createdByType: varchar('created_by_type', { length: 16 }).notNull(),
      createdById: uuid('created_by_id'),
      decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'date' }),
      ...versioned(),
    },
    (t) => [
      index('recovery_actions_complaint_idx').on(t.complaintId),
      uniqueIndex('recovery_actions_approval_uq').on(t.approvalId),
    ],
  ),
  {
    ...audit,
    propertyId: 'INTERNAL',
    complaintId: 'INTERNAL',
    kind: 'INTERNAL',
    amountMinor: 'INTERNAL',
    currency: 'INTERNAL',
    note: 'CONFIDENTIAL',
    status: 'INTERNAL',
    approvalId: 'INTERNAL',
    createdByType: 'INTERNAL',
    createdById: 'INTERNAL',
    decidedAt: 'INTERNAL',
    version: 'INTERNAL',
  },
);

export type CategoryRow = typeof categories.$inferSelect;
export type ComplaintRow = typeof complaints.$inferSelect;
export type CandidateRow = typeof candidates.$inferSelect;
export type RecoveryRow = typeof recoveryActions.$inferSelect;
export type EvidenceRow = typeof evidence.$inferSelect;
