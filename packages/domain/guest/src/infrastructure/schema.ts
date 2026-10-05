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

export const preferenceSource = guest.enum('preference_source', ['EXPLICIT', 'INFERRED', 'PMS']);
export const consentType = guest.enum('consent_type', [
  'SERVICE_COMMUNICATION',
  'MARKETING_WHATSAPP',
  'MARKETING_EMAIL',
  'PERSONALIZATION',
]);
export const dataRequestKind = guest.enum('data_request_kind', [
  'EXPORT',
  'CORRECTION',
  'ANONYMIZE',
  'DELETE',
]);
export const dataRequestStatus = guest.enum('data_request_status', [
  'REQUESTED',
  'COMPLETED',
  'REJECTED',
]);

/** What a guest likes (Spec §6): one current value per (guest, category, key); INFERRED values need a confidence. */
export const guestPreferences = classify(
  guest.table(
    'guest_preferences',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      guestId: uuid('guest_id')
        .notNull()
        .references(() => guests.id, { onDelete: 'cascade' }),
      category: varchar('category', { length: 64 }).notNull(),
      key: varchar('key', { length: 64 }).notNull(),
      value: jsonb('value').notNull(),
      source: preferenceSource('source').notNull(),
      /** 0–100; required for INFERRED, 100 for EXPLICIT/PMS. */
      confidence: integer('confidence').notNull().default(100),
      expiresAt: tz('expires_at'),
      recordedByType: varchar('recorded_by_type', { length: 16 }).notNull(),
      recordedById: varchar('recorded_by_id', { length: 64 }),
      ...versioned(),
    },
    (t) => [unique('guest_preferences_key_uq').on(t.guestId, t.category, t.key)],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    guestId: 'INTERNAL',
    category: 'INTERNAL',
    key: 'INTERNAL',
    value: 'CONFIDENTIAL',
    source: 'INTERNAL',
    confidence: 'INTERNAL',
    expiresAt: 'INTERNAL',
    recordedByType: 'INTERNAL',
    recordedById: 'INTERNAL',
    version: 'INTERNAL',
  },
);

/** Consent decisions (Spec §26), append-only history: the latest row per type is the current state. */
export const guestConsents = classify(
  guest.table(
    'guest_consents',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      guestId: uuid('guest_id')
        .notNull()
        .references(() => guests.id, { onDelete: 'cascade' }),
      type: consentType('type').notNull(),
      granted: boolean('granted').notNull(),
      channel: varchar('channel', { length: 32 }).notNull(),
      capturedAt: tz('captured_at').notNull(),
      /** How it was captured (form version, message id, staff note) — never the guest's contact data. */
      evidence: jsonb('evidence').notNull().default({}),
      capturedByType: varchar('captured_by_type', { length: 16 }).notNull(),
      capturedById: varchar('captured_by_id', { length: 64 }),
    },
    (t) => [index('guest_consents_current_idx').on(t.guestId, t.type, t.capturedAt)],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    guestId: 'INTERNAL',
    type: 'INTERNAL',
    granted: 'INTERNAL',
    channel: 'INTERNAL',
    capturedAt: 'INTERNAL',
    evidence: 'CONFIDENTIAL',
    capturedByType: 'INTERNAL',
    capturedById: 'INTERNAL',
  },
);

/** Data-subject requests (Spec §69): export, correction, anonymization; deletion is executed as anonymization. */
export const guestDataRequests = classify(
  guest.table(
    'guest_data_requests',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      guestId: uuid('guest_id')
        .notNull()
        .references(() => guests.id),
      kind: dataRequestKind('kind').notNull(),
      status: dataRequestStatus('status').notNull().default('REQUESTED'),
      reason: text('reason').notNull(),
      requestedByType: varchar('requested_by_type', { length: 16 }).notNull(),
      requestedById: varchar('requested_by_id', { length: 64 }),
      completedAt: tz('completed_at'),
      /** Outcome summary (counts, SHA-256 of an export) — never the exported data itself. */
      result: jsonb('result').notNull().default({}),
      ...versioned(),
    },
    (t) => [index('guest_data_requests_guest_idx').on(t.tenantId, t.guestId)],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    guestId: 'INTERNAL',
    kind: 'INTERNAL',
    status: 'INTERNAL',
    reason: 'CONFIDENTIAL',
    requestedByType: 'INTERNAL',
    requestedById: 'INTERNAL',
    completedAt: 'INTERNAL',
    result: 'INTERNAL',
    version: 'INTERNAL',
  },
);

export type GuestPreferenceRow = typeof guestPreferences.$inferSelect;
export type GuestConsentRow = typeof guestConsents.$inferSelect;
export type GuestDataRequestRow = typeof guestDataRequests.$inferSelect;

// ---- guest access (Spec §19–§22, ADR-0011) ----

export const grantVia = guest.enum('grant_via', ['ACTIVATION', 'QR', 'STAFF', 'PRE_ARRIVAL']);
export const grantEventKind = guest.enum('grant_event_kind', [
  'GRANTED',
  'WIDENED',
  'NARROWED',
  'REVOKED',
]);

/**
 * What a verified guest may do for a stay (Spec §19.3, §21). The phone or channel identity is never authorization
 * (§18.3): every guest request is checked against an active grant. Scopes change only with a row in
 * `guest_access_grant_events` (CLAUDE.md rule 10).
 */
export const guestAccessGrants = classify(
  guest.table(
    'guest_access_grants',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      guestId: uuid('guest_id')
        .notNull()
        .references(() => guests.id),
      stayId: uuid('stay_id').references(() => stays.id),
      /** PRIMARY or ACCOMPANYING in the stay party when granted; companions get narrower scopes. */
      partyRole: partyRole('party_role').notNull(),
      scopes: text('scopes').array().notNull(),
      validFrom: tz('valid_from').notNull(),
      validUntil: tz('valid_until').notNull(),
      revokedAt: tz('revoked_at'),
      revokeReason: varchar('revoke_reason', { length: 32 }),
      grantedVia: grantVia('granted_via').notNull(),
      grantedByType: varchar('granted_by_type', { length: 16 }).notNull(),
      grantedById: varchar('granted_by_id', { length: 64 }),
      ...versioned(),
    },
    (t) => [
      index('guest_access_grants_stay_idx').on(t.tenantId, t.stayId),
      index('guest_access_grants_guest_idx').on(t.tenantId, t.guestId),
    ],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    guestId: 'INTERNAL',
    stayId: 'INTERNAL',
    partyRole: 'INTERNAL',
    scopes: 'INTERNAL',
    validFrom: 'INTERNAL',
    validUntil: 'INTERNAL',
    revokedAt: 'INTERNAL',
    revokeReason: 'INTERNAL',
    grantedVia: 'INTERNAL',
    grantedByType: 'INTERNAL',
    grantedById: 'INTERNAL',
    version: 'INTERNAL',
  },
);

/** Append-only history of a grant's scopes and validity (a trigger refuses UPDATE/DELETE). */
export const guestAccessGrantEvents = classify(
  guest.table(
    'guest_access_grant_events',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      grantId: uuid('grant_id')
        .notNull()
        .references(() => guestAccessGrants.id),
      kind: grantEventKind('kind').notNull(),
      scopes: text('scopes').array().notNull(),
      validUntil: tz('valid_until').notNull(),
      reason: varchar('reason', { length: 32 }).notNull(),
      changedByType: varchar('changed_by_type', { length: 16 }).notNull(),
      changedById: varchar('changed_by_id', { length: 64 }),
      at: tz('at').notNull(),
    },
    (t) => [index('guest_access_grant_events_grant_idx').on(t.grantId, t.at)],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    grantId: 'INTERNAL',
    kind: 'INTERNAL',
    scopes: 'INTERNAL',
    validUntil: 'INTERNAL',
    reason: 'INTERNAL',
    changedByType: 'INTERNAL',
    changedById: 'INTERNAL',
    at: 'INTERNAL',
  },
);

/** Passwordless guest sessions on a grant; several devices per grant; all end when the grant is revoked. */
export const guestSessions = classify(
  guest.table(
    'guest_sessions',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      grantId: uuid('grant_id')
        .notNull()
        .references(() => guestAccessGrants.id),
      /** SHA-256 of the opaque 256-bit session token; the token itself is returned once. */
      sessionTokenHash: varchar('session_token_hash', { length: 64 }).notNull(),
      deviceInfo: varchar('device_info', { length: 200 }),
      lastSeenAt: tz('last_seen_at').notNull(),
      expiresAt: tz('expires_at').notNull(),
      revokedAt: tz('revoked_at'),
      revokeReason: varchar('revoke_reason', { length: 32 }),
    },
    (t) => [
      uniqueIndex('guest_sessions_token_uq').on(t.sessionTokenHash),
      index('guest_sessions_grant_idx').on(t.grantId),
    ],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    grantId: 'INTERNAL',
    sessionTokenHash: 'RESTRICTED',
    deviceInfo: 'CONFIDENTIAL',
    lastSeenAt: 'INTERNAL',
    expiresAt: 'INTERNAL',
    revokedAt: 'INTERNAL',
    revokeReason: 'INTERNAL',
  },
);

export type GuestAccessGrantRow = typeof guestAccessGrants.$inferSelect;
export type GuestAccessGrantEventRow = typeof guestAccessGrantEvents.$inferSelect;
export type GuestSessionRow = typeof guestSessions.$inferSelect;

// ---- spend facts (BUILD_PLAN 13.5) ----

/**
 * Closed POS checks tied to a stay: totals per outlet category and settlement, once per canonical event. No item lines,
 * card data or POS ids (those stay in the integration context). Spend is CONFIDENTIAL; the rows outlive anonymization
 * of the guest because they carry nothing that identifies a person.
 */
export const stayCharges = classify(
  guest.table(
    'stay_charges',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      stayId: uuid('stay_id')
        .notNull()
        .references(() => stays.id, { onDelete: 'restrict' }),
      roomId: uuid('room_id'),
      /** The canonical `hotel.pos.check_closed` event this fact came from (idempotency). */
      sourceEventId: uuid('source_event_id').notNull(),
      outletCategory: varchar('outlet_category', { length: 16 }).notNull(),
      settlement: varchar('settlement', { length: 16 }).notNull(),
      totalMinor: integer('total_minor').notNull(),
      currency: varchar('currency', { length: 3 }).notNull(),
      covers: integer('covers'),
      closedAt: tz('closed_at').notNull(),
    },
    (t) => [
      unique('stay_charges_source_uq').on(t.tenantId, t.sourceEventId),
      index('stay_charges_stay_idx').on(t.tenantId, t.stayId, t.closedAt),
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
    sourceEventId: 'INTERNAL',
    outletCategory: 'INTERNAL',
    settlement: 'CONFIDENTIAL',
    totalMinor: 'CONFIDENTIAL',
    currency: 'INTERNAL',
    covers: 'CONFIDENTIAL',
    closedAt: 'INTERNAL',
  },
);
export type StayChargeRow = typeof stayCharges.$inferSelect;
