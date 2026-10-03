import { sql } from 'drizzle-orm';
import { index, pgSchema, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { classify, versioned } from '@hotella/platform-database';

/**
 * Housekeeping (Spec §9, §16, BUILD_PLAN Phase 7, schema `hk`). The room projection is fast state; history and work are
 * separate rows (rule 10). Rooms are organization locations: `room_id` is the room's location id.
 */
export const hk = pgSchema('hk');

const tz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const occupancy = hk.enum('occupancy', ['VACANT', 'OCCUPIED']);
export const housekeepingState = hk.enum('housekeeping_state', [
  'DIRTY',
  'CLEANING',
  'CLEAN',
  'INSPECTING',
  'INSPECTED',
  'PICKUP',
]);
export const stateDimension = hk.enum('state_dimension', [
  'OCCUPANCY',
  'HOUSEKEEPING',
  'FRONT_OFFICE',
]);
export const stateCause = hk.enum('state_cause', ['PMS', 'JOB', 'INSPECTION', 'STAFF', 'SYSTEM']);
export const signal = hk.enum('signal', ['DND', 'MAKE_UP_ROOM', 'PRIVACY', 'SERVICE_REQUESTED']);
export const signalSource = hk.enum('signal_source', [
  'PMS',
  'BMS',
  'SMART_ROOM',
  'STAFF',
  'GUEST_PORTAL',
]);

/** What each room is right now (one row per room, created on first touch). */
export const roomStates = classify(
  hk.table(
    'room_states',
    {
      roomId: uuid('room_id').primaryKey(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      occupancy: occupancy('occupancy').notNull().default('VACANT'),
      /** Never claimed clean without evidence: a room the platform has not seen is DIRTY. */
      housekeeping: housekeepingState('housekeeping').notNull().default('DIRTY'),
      /** The PMS front-office restriction (OUT_OF_ORDER, OUT_OF_SERVICE) or null. */
      frontOffice: varchar('front_office', { length: 32 }),
      lastCleanedAt: tz('last_cleaned_at'),
      lastInspectedAt: tz('last_inspected_at'),
      /** Time of the last PMS event applied (older ones are ignored). */
      lastPmsEventAt: tz('last_pms_event_at'),
      createdAt: tz('created_at').notNull().defaultNow(),
      updatedAt: tz('updated_at').notNull().defaultNow(),
      ...versioned(),
    },
    (t) => [index('room_states_property_idx').on(t.tenantId, t.propertyId)],
  ),
  {
    roomId: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    occupancy: 'INTERNAL',
    housekeeping: 'INTERNAL',
    frontOffice: 'INTERNAL',
    lastCleanedAt: 'INTERNAL',
    lastInspectedAt: 'INTERNAL',
    lastPmsEventAt: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    version: 'INTERNAL',
  },
);

/** Every change of a room's state, with its cause (append-only). */
export const roomStateEvents = classify(
  hk.table(
    'room_state_events',
    {
      id: uuid('id').primaryKey(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      roomId: uuid('room_id').notNull(),
      dimension: stateDimension('dimension').notNull(),
      fromValue: varchar('from_value', { length: 32 }),
      toValue: varchar('to_value', { length: 32 }),
      cause: stateCause('cause').notNull(),
      actorType: varchar('actor_type', { length: 16 }).notNull(),
      actorId: uuid('actor_id'),
      jobId: uuid('job_id'),
      occurredAt: tz('occurred_at').notNull(),
      createdAt: tz('created_at').notNull().defaultNow(),
    },
    (t) => [index('room_state_events_room_idx').on(t.tenantId, t.roomId, t.occurredAt)],
  ),
  {
    id: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    roomId: 'INTERNAL',
    dimension: 'INTERNAL',
    fromValue: 'INTERNAL',
    toValue: 'INTERNAL',
    cause: 'INTERNAL',
    actorType: 'INTERNAL',
    actorId: 'INTERNAL',
    jobId: 'INTERNAL',
    occurredAt: 'INTERNAL',
    createdAt: 'INTERNAL',
  },
);

/** Service and privacy signals of a room (Spec §9.3), independent of its state; one open row per room and signal. */
export const roomSignals = classify(
  hk.table(
    'room_signals',
    {
      id: uuid('id').primaryKey(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      roomId: uuid('room_id').notNull(),
      signal: signal('signal').notNull(),
      source: signalSource('source').notNull(),
      startedAt: tz('started_at').notNull(),
      endedAt: tz('ended_at'),
      startedByType: varchar('started_by_type', { length: 16 }).notNull(),
      startedById: uuid('started_by_id'),
      endedByType: varchar('ended_by_type', { length: 16 }),
      endedById: uuid('ended_by_id'),
      createdAt: tz('created_at').notNull().defaultNow(),
    },
    (t) => [
      uniqueIndex('room_signals_open_uq')
        .on(t.roomId, t.signal)
        .where(sql`${t.endedAt} is null`),
      index('room_signals_property_idx').on(t.tenantId, t.propertyId),
    ],
  ),
  {
    id: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    roomId: 'INTERNAL',
    signal: 'INTERNAL',
    source: 'INTERNAL',
    startedAt: 'INTERNAL',
    endedAt: 'INTERNAL',
    startedByType: 'INTERNAL',
    startedById: 'INTERNAL',
    endedByType: 'INTERNAL',
    endedById: 'INTERNAL',
    createdAt: 'INTERNAL',
  },
);

export type RoomStateRow = typeof roomStates.$inferSelect;
export type RoomSignalRow = typeof roomSignals.$inferSelect;
