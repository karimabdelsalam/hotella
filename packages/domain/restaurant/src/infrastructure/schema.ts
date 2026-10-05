import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  pgSchema,
  primaryKey,
  smallint,
  text,
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
import { RESERVATION_STATUSES } from '../domain/rules';

/**
 * Restaurant — à la carte reservations (Spec Appendix B.1, BUILD_PLAN 14.B, schema `restaurant`). Restaurants, their
 * weekly sittings with seats, closures, and reservations of in-house stays. Seats are counted atomically per sitting
 * and date (`sitting_loads`); every reservation transition is kept (rule 10). Names live in translation tables
 * (rule 7); the stay and guest are references to the guest context, never copies of its data beyond a room number.
 */
export const restaurant = pgSchema('restaurant');

export const restaurantStatus = restaurant.enum('restaurant_status', [
  'DRAFT',
  'ACTIVE',
  'INACTIVE',
]);
export const reservationStatus = restaurant.enum('reservation_status', RESERVATION_STATUSES);
export const reservationChannel = restaurant.enum('reservation_channel', [
  'GUEST_APP',
  'STAFF',
  'AI',
]);

const ownership = {
  id: 'INTERNAL',
  createdAt: 'INTERNAL',
  updatedAt: 'INTERNAL',
  tenantId: 'INTERNAL',
  propertyId: 'INTERNAL',
} as const;

export const restaurants = classify(
  restaurant.table(
    'restaurants',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      code: varchar('code', { length: 40 }).notNull(),
      status: restaurantStatus('status').notNull().default('DRAFT'),
      minParty: smallint('min_party').notNull().default(1),
      maxParty: smallint('max_party').notNull().default(8),
      /** Guests may book up to this many days ahead (hotel calendar). */
      bookDaysAhead: smallint('book_days_ahead').notNull().default(7),
      /** Guests book and cancel until this many minutes before a sitting. */
      guestCutoffMinutes: integer('guest_cutoff_minutes').notNull().default(120),
      /** The stay allowance applies (an included à la carte restaurant); false: book as often as seats allow. */
      allowanceApplies: boolean('allowance_applies').notNull().default(true),
      sortOrder: smallint('sort_order').notNull().default(0),
      ...versioned(),
    },
    (t) => [
      uniqueIndex('restaurants_code_uq').on(t.tenantId, t.propertyId, t.code),
      check('restaurants_party_ck', sql`${t.minParty} >= 1 and ${t.maxParty} >= ${t.minParty}`),
    ],
  ),
  {
    ...ownership,
    code: 'INTERNAL',
    status: 'INTERNAL',
    minParty: 'INTERNAL',
    maxParty: 'INTERNAL',
    bookDaysAhead: 'INTERNAL',
    guestCutoffMinutes: 'INTERNAL',
    allowanceApplies: 'INTERNAL',
    sortOrder: 'INTERNAL',
    version: 'INTERNAL',
  },
);

export const restaurantTranslations = classify(
  restaurant.table(
    'restaurant_translations',
    {
      ...translationColumns(() => restaurants.id),
      name: text('name').notNull(),
      description: text('description'),
      dressCode: text('dress_code'),
    },
    (t) => [translationUnique('restaurant_translations', t)],
  ),
  {
    entityId: 'INTERNAL',
    locale: 'INTERNAL',
    name: 'PUBLIC',
    description: 'PUBLIC',
    dressCode: 'PUBLIC',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
  },
);

/**
 * A weekly sitting: a weekday, a start time and its seats, in force from `valid_from` until `valid_to`. A schedule
 * change ends the old rows and adds new ones, so booked reservations keep pointing at what they booked.
 */
export const sittings = classify(
  restaurant.table(
    'sittings',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      restaurantId: uuid('restaurant_id')
        .notNull()
        .references(() => restaurants.id, { onDelete: 'restrict' }),
      weekday: smallint('weekday').notNull(),
      startsAt: varchar('starts_at', { length: 5 }).notNull(),
      seats: integer('seats').notNull(),
      validFrom: date('valid_from', { mode: 'string' }).notNull(),
      validTo: date('valid_to', { mode: 'string' }),
      active: boolean('active').notNull().default(true),
    },
    (t) => [
      index('sittings_restaurant_idx').on(t.restaurantId, t.weekday),
      check('sittings_weekday_ck', sql`${t.weekday} between 0 and 6`),
      check('sittings_seats_ck', sql`${t.seats} >= 1`),
      check('sittings_time_ck', sql`${t.startsAt} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'`),
    ],
  ),
  {
    ...ownership,
    restaurantId: 'INTERNAL',
    weekday: 'INTERNAL',
    startsAt: 'INTERNAL',
    seats: 'INTERNAL',
    validFrom: 'INTERNAL',
    validTo: 'INTERNAL',
    active: 'INTERNAL',
  },
);

/** A closed day (whole restaurant) or one closed sitting on a date. */
export const closures = classify(
  restaurant.table(
    'closures',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      restaurantId: uuid('restaurant_id')
        .notNull()
        .references(() => restaurants.id, { onDelete: 'restrict' }),
      onDate: date('on_date', { mode: 'string' }).notNull(),
      sittingId: uuid('sitting_id').references(() => sittings.id, { onDelete: 'restrict' }),
      reason: text('reason').notNull(),
    },
    (t) => [index('closures_restaurant_idx').on(t.restaurantId, t.onDate)],
  ),
  {
    ...ownership,
    restaurantId: 'INTERNAL',
    onDate: 'INTERNAL',
    sittingId: 'INTERNAL',
    reason: 'INTERNAL',
  },
);

/**
 * Covers booked per sitting and date — the capacity counter. Booking adds with
 * `INSERT … ON CONFLICT DO UPDATE … WHERE covers + n <= seats`, so two guests racing for the last seats cannot both win.
 */
export const sittingLoads = classify(
  restaurant.table(
    'sitting_loads',
    {
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      sittingId: uuid('sitting_id')
        .notNull()
        .references(() => sittings.id, { onDelete: 'restrict' }),
      serviceDate: date('service_date', { mode: 'string' }).notNull(),
      covers: integer('covers').notNull().default(0),
    },
    (t) => [
      primaryKey({ name: 'sitting_loads_pk', columns: [t.sittingId, t.serviceDate] }),
      check('sitting_loads_covers_ck', sql`${t.covers} >= 0`),
    ],
  ),
  {
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    sittingId: 'INTERNAL',
    serviceDate: 'INTERNAL',
    covers: 'INTERNAL',
  },
);

export const reservations = classify(
  restaurant.table(
    'reservations',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      restaurantId: uuid('restaurant_id')
        .notNull()
        .references(() => restaurants.id, { onDelete: 'restrict' }),
      sittingId: uuid('sitting_id')
        .notNull()
        .references(() => sittings.id, { onDelete: 'restrict' }),
      serviceDate: date('service_date', { mode: 'string' }).notNull(),
      /** The sitting time when booked (a later schedule change does not move a booking). */
      startsAt: varchar('starts_at', { length: 5 }).notNull(),
      partySize: smallint('party_size').notNull(),
      /** The stay in the guest context (the allowance counts per stay). */
      stayId: uuid('stay_id').notNull(),
      guestId: uuid('guest_id'),
      roomNumber: varchar('room_number', { length: 16 }),
      status: reservationStatus('status').notNull().default('CONFIRMED'),
      channel: reservationChannel('channel').notNull(),
      /** Allergies and wishes: SENSITIVE, shown only with permission, never to AI providers. */
      notes: text('notes'),
      overrideReason: text('override_reason'),
      cancelReason: text('cancel_reason'),
      createdByType: varchar('created_by_type', { length: 16 }).notNull(),
      createdById: uuid('created_by_id'),
      ...versioned(),
    },
    (t) => [
      index('reservations_day_idx').on(t.tenantId, t.propertyId, t.serviceDate),
      index('reservations_stay_idx').on(t.tenantId, t.stayId, t.restaurantId),
      check('reservations_party_ck', sql`${t.partySize} >= 1`),
    ],
  ),
  {
    ...ownership,
    restaurantId: 'INTERNAL',
    sittingId: 'INTERNAL',
    serviceDate: 'INTERNAL',
    startsAt: 'INTERNAL',
    partySize: 'INTERNAL',
    stayId: 'CONFIDENTIAL',
    guestId: 'CONFIDENTIAL',
    roomNumber: 'CONFIDENTIAL',
    status: 'INTERNAL',
    channel: 'INTERNAL',
    notes: 'SENSITIVE',
    overrideReason: 'CONFIDENTIAL',
    cancelReason: 'CONFIDENTIAL',
    createdByType: 'INTERNAL',
    createdById: 'INTERNAL',
    version: 'INTERNAL',
  },
);

/** Every status change of a reservation (append-only, rule 10). */
export const reservationTransitions = classify(
  restaurant.table(
    'reservation_transitions',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      reservationId: uuid('reservation_id')
        .notNull()
        .references(() => reservations.id, { onDelete: 'restrict' }),
      fromStatus: reservationStatus('from_status'),
      toStatus: reservationStatus('to_status').notNull(),
      reason: text('reason'),
      actorType: varchar('actor_type', { length: 16 }).notNull(),
      actorId: uuid('actor_id'),
    },
    (t) => [index('reservation_transitions_idx').on(t.reservationId)],
  ),
  {
    ...ownership,
    reservationId: 'INTERNAL',
    fromStatus: 'INTERNAL',
    toStatus: 'INTERNAL',
    reason: 'CONFIDENTIAL',
    actorType: 'INTERNAL',
    actorId: 'INTERNAL',
  },
);

export type RestaurantRow = typeof restaurants.$inferSelect;
export type RestaurantTranslationRow = typeof restaurantTranslations.$inferSelect;
export type SittingRow = typeof sittings.$inferSelect;
export type ClosureRow = typeof closures.$inferSelect;
export type ReservationRow = typeof reservations.$inferSelect;
