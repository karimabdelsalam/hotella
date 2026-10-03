import { sql } from 'drizzle-orm';
import {
  date,
  index,
  integer,
  pgSchema,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { baseColumns, classify, versioned } from '@hotella/platform-database';

/**
 * Guest & Stay (Spec §6, schema `guest`). Guest identity is separate from PMS identity: PMS reservation and profile
 * ids live only in `integration.external_references` (CLAUDE.md rule 3). Stays change state only through canonical
 * PMS events (rule 19). Foreign keys to `org.*` are added by hand in the migration.
 */
export const guest = pgSchema('guest');

const tz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const guestStatus = guest.enum('guest_status', ['ACTIVE', 'MERGED', 'ANONYMIZED']);
export const identifierKind = guest.enum('identifier_kind', [
  'EMAIL',
  'PHONE',
  'LOYALTY',
  'DOCUMENT_HASH',
]);
export const stayStatus = guest.enum('stay_status', [
  'EXPECTED',
  'IN_HOUSE',
  'CHECKED_OUT',
  'CANCELLED',
  'NO_SHOW',
]);
export const partyRole = guest.enum('party_role', ['PRIMARY', 'ACCOMPANYING']);
export const assignmentReason = guest.enum('assignment_reason', [
  'PRE_ASSIGNMENT',
  'INITIAL',
  'ROOM_MOVE',
  'UPGRADE',
  'MAINTENANCE',
]);

/** A guest as Hotella knows them (one per real person per tenant; duplicates are merged, never auto-matched). */
export const guests = classify(
  guest.table(
    'guests',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      givenName: text('given_name').notNull(),
      familyName: text('family_name'),
      title: varchar('title', { length: 40 }),
      primaryLocale: varchar('primary_locale', { length: 16 }),
      vipCode: varchar('vip_code', { length: 32 }),
      status: guestStatus('status').notNull().default('ACTIVE'),
      mergedIntoGuestId: uuid('merged_into_guest_id'),
      anonymizedAt: tz('anonymized_at'),
      ...versioned(),
    },
    (t) => [index('guests_tenant_name_idx').on(t.tenantId, t.familyName, t.givenName)],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    givenName: 'CONFIDENTIAL',
    familyName: 'CONFIDENTIAL',
    title: 'CONFIDENTIAL',
    primaryLocale: 'INTERNAL',
    vipCode: 'CONFIDENTIAL',
    status: 'INTERNAL',
    mergedIntoGuestId: 'INTERNAL',
    anonymizedAt: 'INTERNAL',
    version: 'INTERNAL',
  },
);

/** Contact points and stable identifiers of a guest, normalized (lower-case e-mail, E.164-ish phone). */
export const guestIdentifiers = classify(
  guest.table(
    'guest_identifiers',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      guestId: uuid('guest_id')
        .notNull()
        .references(() => guests.id, { onDelete: 'cascade' }),
      kind: identifierKind('kind').notNull(),
      valueNormalized: varchar('value_normalized', { length: 320 }).notNull(),
      source: varchar('source', { length: 16 }).notNull(),
      verifiedAt: tz('verified_at'),
    },
    (t) => [
      unique('guest_identifiers_value_uq').on(t.guestId, t.kind, t.valueNormalized),
      index('guest_identifiers_lookup_idx').on(t.tenantId, t.kind, t.valueNormalized),
    ],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    guestId: 'INTERNAL',
    kind: 'INTERNAL',
    valueNormalized: 'SENSITIVE',
    source: 'INTERNAL',
    verifiedAt: 'INTERNAL',
  },
);

/** A stay at a property. The PMS is its source of truth (Spec §6); only canonical events change `status`. */
export const stays = classify(
  guest.table(
    'stays',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      status: stayStatus('status').notNull(),
      primaryGuestId: uuid('primary_guest_id')
        .notNull()
        .references(() => guests.id),
      expectedArrival: date('expected_arrival', { mode: 'string' }).notNull(),
      expectedDeparture: date('expected_departure', { mode: 'string' }).notNull(),
      actualCheckinAt: tz('actual_checkin_at'),
      actualCheckoutAt: tz('actual_checkout_at'),
      cancelledAt: tz('cancelled_at'),
      eta: tz('eta'),
      adults: integer('adults').notNull().default(1),
      children: integer('children').notNull().default(0),
      rateCode: varchar('rate_code', { length: 32 }),
      marketCode: varchar('market_code', { length: 32 }),
      /** `occurred_at` of the newest PMS event applied: older snapshots never overwrite newer data. */
      lastPmsEventAt: tz('last_pms_event_at').notNull(),
      ...versioned(),
    },
    (t) => [
      index('stays_property_status_idx').on(t.tenantId, t.propertyId, t.status),
      index('stays_primary_guest_idx').on(t.primaryGuestId),
    ],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    status: 'INTERNAL',
    primaryGuestId: 'INTERNAL',
    expectedArrival: 'INTERNAL',
    expectedDeparture: 'INTERNAL',
    actualCheckinAt: 'INTERNAL',
    actualCheckoutAt: 'INTERNAL',
    cancelledAt: 'INTERNAL',
    eta: 'INTERNAL',
    adults: 'INTERNAL',
    children: 'INTERNAL',
    rateCode: 'INTERNAL',
    marketCode: 'INTERNAL',
    lastPmsEventAt: 'INTERNAL',
    version: 'INTERNAL',
  },
);

/**
 * Which integration a stay came from and what it last said about it. The confirmation number is display data for
 * staff and guests; the reservation id used for correlation lives only in `integration.external_references`.
 */
export const reservationReferences = classify(
  guest.table(
    'reservation_references',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      stayId: uuid('stay_id')
        .notNull()
        .references(() => stays.id, { onDelete: 'cascade' }),
      integrationInstanceId: uuid('integration_instance_id').notNull(),
      confirmationNumber: varchar('confirmation_number', { length: 64 }),
      lastEventType: varchar('last_event_type', { length: 96 }).notNull(),
      lastEventAt: tz('last_event_at').notNull(),
    },
    (t) => [unique('reservation_references_stay_uq').on(t.stayId, t.integrationInstanceId)],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    stayId: 'INTERNAL',
    integrationInstanceId: 'INTERNAL',
    confirmationNumber: 'CONFIDENTIAL',
    lastEventType: 'INTERNAL',
    lastEventAt: 'INTERNAL',
  },
);

/** Who stays together. Leaving the party closes the row; history is kept (CLAUDE.md rule 10). */
export const stayPartyMembers = classify(
  guest.table(
    'stay_party_members',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      stayId: uuid('stay_id')
        .notNull()
        .references(() => stays.id, { onDelete: 'cascade' }),
      guestId: uuid('guest_id')
        .notNull()
        .references(() => guests.id),
      role: partyRole('role').notNull(),
      joinedAt: tz('joined_at').notNull(),
      leftAt: tz('left_at'),
    },
    (t) => [
      uniqueIndex('stay_party_members_active_uq')
        .on(t.stayId, t.guestId)
        .where(sql`${t.leftAt} IS NULL`),
      index('stay_party_members_guest_idx').on(t.guestId),
    ],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    stayId: 'INTERNAL',
    guestId: 'INTERNAL',
    role: 'INTERNAL',
    joinedAt: 'INTERNAL',
    leftAt: 'INTERNAL',
  },
);

/**
 * Room assignment history: a move closes the open row and opens a new one; nothing is overwritten (Spec §6, rule 10).
 * At most one open assignment per stay.
 */
export const roomAssignments = classify(
  guest.table(
    'room_assignments',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      stayId: uuid('stay_id')
        .notNull()
        .references(() => stays.id, { onDelete: 'cascade' }),
      roomId: uuid('room_id').notNull(),
      assignedAt: tz('assigned_at').notNull(),
      unassignedAt: tz('unassigned_at'),
      reason: assignmentReason('reason').notNull(),
      /** Canonical event that caused it. */
      sourceEventId: uuid('source_event_id'),
    },
    (t) => [
      uniqueIndex('room_assignments_open_uq')
        .on(t.stayId)
        .where(sql`${t.unassignedAt} IS NULL`),
      index('room_assignments_room_open_idx')
        .on(t.tenantId, t.roomId)
        .where(sql`${t.unassignedAt} IS NULL`),
    ],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    stayId: 'INTERNAL',
    roomId: 'INTERNAL',
    assignedAt: 'INTERNAL',
    unassignedAt: 'INTERNAL',
    reason: 'INTERNAL',
    sourceEventId: 'INTERNAL',
  },
);

export type GuestRow = typeof guests.$inferSelect;
export type GuestIdentifierRow = typeof guestIdentifiers.$inferSelect;
export type StayRow = typeof stays.$inferSelect;
export type ReservationReferenceRow = typeof reservationReferences.$inferSelect;
export type StayPartyMemberRow = typeof stayPartyMembers.$inferSelect;
export type RoomAssignmentRow = typeof roomAssignments.$inferSelect;
