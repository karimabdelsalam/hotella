import { sql } from 'drizzle-orm';
import {
  date,
  index,
  numeric,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { baseColumns, classify, versioned } from '@hotella/platform-database';

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

// ---- cleaning jobs (Spec §9.1–§9.2, BUILD_PLAN 7.2) ----

export const cleaningType = hk.enum('cleaning_type', [
  'STAYOVER',
  'CHECKOUT',
  'ARRIVAL',
  'DEEP_CLEAN',
  'TURNDOWN',
  'TOUCH_UP',
  'VIP',
  'OTHER',
]);
export const jobStatus = hk.enum('job_status', [
  'OPEN',
  'IN_PROGRESS',
  'DONE',
  'INSPECTED',
  'FAILED_INSPECTION',
  'SKIPPED',
  'CANCELLED',
]);
export const jobOrigin = hk.enum('job_origin', ['GENERATED', 'STAFF', 'INSPECTION']);
export const inspectionResult = hk.enum('inspection_result', ['PASS', 'FAIL']);

/** A cleaning of a room on a day; its work (assignment, SLA, history) is an `HK_JOB` work item. */
export const jobs = classify(
  hk.table(
    'jobs',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      workItemId: uuid('work_item_id'),
      roomId: uuid('room_id').notNull(),
      stayId: uuid('stay_id'),
      cleaningType: cleaningType('cleaning_type').notNull(),
      origin: jobOrigin('origin').notNull(),
      /** Copied from the credit rules at creation: later rule changes do not rewrite history. */
      credits: numeric('credits', { precision: 5, scale: 2, mode: 'number' }).notNull(),
      status: jobStatus('status').notNull().default('OPEN'),
      /** The property-local day the job is for. */
      scheduledFor: date('scheduled_for', { mode: 'string' }).notNull(),
      startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
      completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
      inspectedAt: timestamp('inspected_at', { withTimezone: true, mode: 'date' }),
      skipReason: varchar('skip_reason', { length: 200 }),
      ...versioned(),
    },
    (t) => [
      // Generated jobs are idempotent: one per room, type and day.
      uniqueIndex('jobs_generated_uq')
        .on(t.roomId, t.cleaningType, t.scheduledFor)
        .where(sql`${t.origin} = 'GENERATED'`),
      uniqueIndex('jobs_work_item_uq').on(t.workItemId),
      index('jobs_property_day_idx').on(t.tenantId, t.propertyId, t.scheduledFor),
    ],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    workItemId: 'INTERNAL',
    roomId: 'INTERNAL',
    stayId: 'INTERNAL',
    cleaningType: 'INTERNAL',
    origin: 'INTERNAL',
    credits: 'INTERNAL',
    status: 'INTERNAL',
    scheduledFor: 'INTERNAL',
    startedAt: 'INTERNAL',
    completedAt: 'INTERNAL',
    inspectedAt: 'INTERNAL',
    skipReason: 'INTERNAL',
    version: 'INTERNAL',
  },
);

/** Credits of a cleaning type for the property, optionally for one room type (Spec §9.2). */
export const creditRules = classify(
  hk.table(
    'credit_rules',
    {
      ...baseColumns(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      cleaningType: cleaningType('cleaning_type').notNull(),
      roomTypeId: uuid('room_type_id'),
      credits: numeric('credits', { precision: 5, scale: 2, mode: 'number' }).notNull(),
      ...versioned(),
    },
    (t) => [
      uniqueIndex('credit_rules_type_uq')
        .on(t.propertyId, t.cleaningType)
        .where(sql`${t.roomTypeId} is null`),
      uniqueIndex('credit_rules_room_type_uq')
        .on(t.propertyId, t.cleaningType, t.roomTypeId)
        .where(sql`${t.roomTypeId} is not null`),
    ],
  ),
  {
    id: 'INTERNAL',
    createdAt: 'INTERNAL',
    updatedAt: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    cleaningType: 'INTERNAL',
    roomTypeId: 'INTERNAL',
    credits: 'INTERNAL',
    version: 'INTERNAL',
  },
);

/** A supervisor's inspection of a cleaned room (minimal hook before the Phase 9 inspection engine). */
export const inspections = classify(
  hk.table(
    'inspections',
    {
      id: uuid('id').primaryKey(),
      tenantId: uuid('tenant_id').notNull(),
      propertyId: uuid('property_id').notNull(),
      jobId: uuid('job_id')
        .notNull()
        .references(() => jobs.id, { onDelete: 'restrict' }),
      roomId: uuid('room_id').notNull(),
      result: inspectionResult('result').notNull(),
      notes: text('notes'),
      inspectorId: uuid('inspector_id'),
      inspectedAt: timestamp('inspected_at', { withTimezone: true, mode: 'date' }).notNull(),
    },
    (t) => [index('inspections_job_idx').on(t.jobId)],
  ),
  {
    id: 'INTERNAL',
    tenantId: 'INTERNAL',
    propertyId: 'INTERNAL',
    jobId: 'INTERNAL',
    roomId: 'INTERNAL',
    result: 'INTERNAL',
    notes: 'INTERNAL',
    inspectorId: 'INTERNAL',
    inspectedAt: 'INTERNAL',
  },
);

export type JobRow = typeof jobs.$inferSelect;
export type CreditRuleRow = typeof creditRules.$inferSelect;
