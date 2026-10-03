import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { baseColumns, classify, versioned } from '@hotella/platform-database';
import {
  COLOURS,
  DISPOSAL_METHODS,
  ITEM_CATEGORIES,
  ITEM_KINDS,
  ITEM_STATUSES,
} from '../domain/items';

/**
 * Lost & Found (Spec §13, BUILD_PLAN Phase 9, schema `lostfound`). The staff's description is never overwritten:
 * AI-derived attributes live in their own table, matches are proposals a person decides, and every release and
 * disposal leaves a record.
 */
export const lostfound = pgSchema('lostfound');

export const itemKind = lostfound.enum('item_kind', ITEM_KINDS);
export const itemStatus = lostfound.enum('item_status', ITEM_STATUSES);
export const itemCategory = lostfound.enum('item_category', ITEM_CATEGORIES);
export const colour = lostfound.enum('colour', COLOURS);
export const disposalMethod = lostfound.enum('disposal_method', DISPOSAL_METHODS);
export const matchStatus = lostfound.enum('match_status', ['PROPOSED', 'CONFIRMED', 'REJECTED']);
export const idDocument = lostfound.enum('id_document', [
  'PASSPORT',
  'NATIONAL_ID',
  'DRIVING_LICENCE',
  'ROOM_KEY_AND_PMS',
  'OTHER',
]);
export const handover = lostfound.enum('handover', ['IN_PERSON', 'COURIER', 'REPRESENTATIVE']);

const audit = {
  id: 'INTERNAL',
  createdAt: 'INTERNAL',
  updatedAt: 'INTERNAL',
  tenantId: 'INTERNAL',
} as const;

export const items = classify(
  lostfound.table(
    'items',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      number: integer('number').notNull(),
      kind: itemKind('kind').notNull(),
      category: itemCategory('category').notNull(),
      colour: colour('colour'),
      brand: varchar('brand', { length: 60 }),
      /** In the words of whoever reported it; never overwritten (corrections are history notes). */
      description: text('description').notNull(),
      locationId: uuid('location_id'),
      /** Free words for where (e.g. "pool bar, under a sunbed") when no location fits. */
      placeNote: varchar('place_note', { length: 200 }),
      /** When it was found, or when the guest thinks they lost it. */
      occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull(),
      guestId: uuid('guest_id'),
      stayId: uuid('stay_id'),
      storageLocation: varchar('storage_location', { length: 120 }),
      photoKeys: jsonb('photo_keys').$type<string[]>().notNull().default([]),
      valuable: boolean('valuable').notNull().default(false),
      status: itemStatus('status').notNull().default('REGISTERED'),
      /** Found items only: from this date an unclaimed item may be disposed of (explicitly, never silently). */
      retentionUntil: date('retention_until', { mode: 'string' }),
      disposalMethod: disposalMethod('disposal_method'),
      closedAt: timestamp('closed_at', { withTimezone: true, mode: 'date' }),
      reportedByType: varchar('reported_by_type', { length: 16 }).notNull(),
      reportedById: uuid('reported_by_id'),
      ...versioned(),
    },
    (t) => [
      uniqueIndex('items_number_uq').on(t.propertyId, t.number),
      index('items_open_idx').on(t.tenantId, t.propertyId, t.kind, t.status),
      index('items_stay_idx').on(t.tenantId, t.stayId),
    ],
  ),
  {
    ...audit,
    propertyId: 'INTERNAL',
    number: 'INTERNAL',
    kind: 'INTERNAL',
    category: 'INTERNAL',
    colour: 'INTERNAL',
    brand: 'INTERNAL',
    description: 'CONFIDENTIAL',
    locationId: 'INTERNAL',
    placeNote: 'INTERNAL',
    occurredAt: 'INTERNAL',
    guestId: 'CONFIDENTIAL',
    stayId: 'CONFIDENTIAL',
    storageLocation: 'INTERNAL',
    photoKeys: 'CONFIDENTIAL',
    valuable: 'INTERNAL',
    status: 'INTERNAL',
    retentionUntil: 'INTERNAL',
    disposalMethod: 'INTERNAL',
    closedAt: 'INTERNAL',
    reportedByType: 'INTERNAL',
    reportedById: 'INTERNAL',
    version: 'INTERNAL',
  },
);

/** Everything that happened to an item, as it happened (append-only, rule 10). */
export const itemHistory = classify(
  lostfound.table(
    'item_history',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      itemId: uuid('item_id')
        .notNull()
        .references(() => items.id, { onDelete: 'restrict' }),
      event: varchar('event', { length: 32 }).notNull(),
      fromStatus: itemStatus('from_status'),
      toStatus: itemStatus('to_status'),
      note: text('note'),
      actorType: varchar('actor_type', { length: 16 }).notNull(),
      actorId: uuid('actor_id'),
    },
    (t) => [index('item_history_idx').on(t.itemId)],
  ),
  {
    ...audit,
    itemId: 'INTERNAL',
    event: 'INTERNAL',
    fromStatus: 'INTERNAL',
    toStatus: 'INTERNAL',
    note: 'CONFIDENTIAL',
    actorType: 'INTERNAL',
    actorId: 'INTERNAL',
  },
);

/** What a model derived from the description, kept apart from what the staff wrote (Spec §13). */
export const aiMetadata = classify(
  lostfound.table(
    'ai_metadata',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      itemId: uuid('item_id')
        .notNull()
        .references(() => items.id, { onDelete: 'restrict' }),
      objectType: varchar('object_type', { length: 80 }),
      colours: jsonb('colours').$type<string[]>().notNull().default([]),
      brand: varchar('brand', { length: 60 }),
      keywords: jsonb('keywords').$type<string[]>().notNull().default([]),
      modelCallId: varchar('model_call_id', { length: 64 }).notNull(),
    },
    (t) => [uniqueIndex('ai_metadata_item_uq').on(t.itemId)],
  ),
  {
    ...audit,
    itemId: 'INTERNAL',
    objectType: 'INTERNAL',
    colours: 'INTERNAL',
    brand: 'INTERNAL',
    keywords: 'CONFIDENTIAL',
    modelCallId: 'INTERNAL',
  },
);

/** A found item that may be a guest's lost one, with the score and why; a person confirms or rejects it. */
export const matchCandidates = classify(
  lostfound.table(
    'match_candidates',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      foundItemId: uuid('found_item_id')
        .notNull()
        .references(() => items.id, { onDelete: 'restrict' }),
      lostItemId: uuid('lost_item_id')
        .notNull()
        .references(() => items.id, { onDelete: 'restrict' }),
      score: integer('score').notNull(),
      reasons: jsonb('reasons').$type<string[]>().notNull(),
      source: varchar('source', { length: 8 }).notNull().default('RULES'),
      status: matchStatus('status').notNull().default('PROPOSED'),
      decidedByType: varchar('decided_by_type', { length: 16 }),
      decidedById: uuid('decided_by_id'),
      decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'date' }),
      ...versioned(),
    },
    (t) => [
      uniqueIndex('match_candidates_pair_uq').on(t.foundItemId, t.lostItemId),
      index('match_candidates_open_idx')
        .on(t.tenantId, t.propertyId)
        .where(sql`status = 'PROPOSED'`),
    ],
  ),
  {
    ...audit,
    propertyId: 'INTERNAL',
    foundItemId: 'INTERNAL',
    lostItemId: 'INTERNAL',
    score: 'INTERNAL',
    reasons: 'INTERNAL',
    source: 'INTERNAL',
    status: 'INTERNAL',
    decidedByType: 'INTERNAL',
    decidedById: 'INTERNAL',
    decidedAt: 'INTERNAL',
    version: 'INTERNAL',
  },
);

/** Who took a found item, how they were verified and who handed it over (append-only). */
export const claims = classify(
  lostfound.table(
    'claims',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      itemId: uuid('item_id')
        .notNull()
        .references(() => items.id, { onDelete: 'restrict' }),
      claimantGuestId: uuid('claimant_guest_id'),
      claimantName: varchar('claimant_name', { length: 160 }).notNull(),
      /** The kind of document shown; its number is never stored. */
      idDocument: idDocument('id_document').notNull(),
      verificationNote: text('verification_note').notNull(),
      handover: handover('handover').notNull(),
      releasedById: uuid('released_by_id'),
      releasedAt: timestamp('released_at', { withTimezone: true, mode: 'date' }).notNull(),
    },
    (t) => [uniqueIndex('claims_item_uq').on(t.itemId)],
  ),
  {
    ...audit,
    propertyId: 'INTERNAL',
    itemId: 'INTERNAL',
    claimantGuestId: 'CONFIDENTIAL',
    claimantName: 'CONFIDENTIAL',
    idDocument: 'INTERNAL',
    verificationNote: 'CONFIDENTIAL',
    handover: 'INTERNAL',
    releasedById: 'INTERNAL',
    releasedAt: 'INTERNAL',
  },
);

export type ItemRow = typeof items.$inferSelect;
export type MatchRow = typeof matchCandidates.$inferSelect;
export type ClaimRow = typeof claims.$inferSelect;
export type AiMetadataRow = typeof aiMetadata.$inferSelect;
