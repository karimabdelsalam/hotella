import { z } from 'zod';
import { defineEvent } from './registry';

/**
 * Housekeeping events (Spec §9, BUILD_PLAN Phase 7): room state and signals. Ids, codes and states only.
 */

export const ROOM_STATE_DIMENSIONS = ['OCCUPANCY', 'HOUSEKEEPING', 'FRONT_OFFICE'] as const;
export const ROOM_STATE_CAUSES = ['PMS', 'JOB', 'INSPECTION', 'STAFF', 'SYSTEM'] as const;
export const ROOM_SIGNALS = ['DND', 'MAKE_UP_ROOM', 'PRIVACY', 'SERVICE_REQUESTED'] as const;
export const ROOM_SIGNAL_SOURCES = ['PMS', 'BMS', 'SMART_ROOM', 'STAFF', 'GUEST_PORTAL'] as const;

export const RoomStateChanged = defineEvent({
  type: 'hk.room.state_changed',
  version: 1,
  delivery: 'critical-operational',
  description:
    'A room changed occupancy, housekeeping or front-office state (the projection moved; its history row holds the cause).',
  payload: z.object({
    room_id: z.uuid(),
    dimension: z.enum(ROOM_STATE_DIMENSIONS),
    from: z.string().max(32).nullable(),
    to: z.string().max(32).nullable(),
    cause: z.enum(ROOM_STATE_CAUSES),
  }),
});

export const RoomSignalChanged = defineEvent({
  type: 'hk.room_signal.changed',
  version: 1,
  description: 'A service or privacy signal of a room (DND, make up room…) was raised or cleared.',
  payload: z.object({
    room_id: z.uuid(),
    signal: z.enum(ROOM_SIGNALS),
    active: z.boolean(),
    source: z.enum(ROOM_SIGNAL_SOURCES),
  }),
});

export const READINESS_DIMENSIONS = [
  'HOUSEKEEPING',
  'INSPECTION',
  'ENGINEERING',
  'NO_OOO',
] as const;

export const RoomReady = defineEvent({
  type: 'hk.room.ready',
  version: 1,
  delivery: 'critical-operational',
  description:
    'A vacant room became ready: every readiness dimension the property checks passes (front desk can give it to an arrival).',
  payload: z.object({
    room_id: z.uuid(),
    dimensions: z.array(z.enum(READINESS_DIMENSIONS)),
  }),
});

export const CLEANING_TYPES = [
  'STAYOVER',
  'CHECKOUT',
  'ARRIVAL',
  'DEEP_CLEAN',
  'TURNDOWN',
  'TOUCH_UP',
  'VIP',
  'OTHER',
] as const;
export const HK_JOB_STATUSES = [
  'OPEN',
  'IN_PROGRESS',
  'DONE',
  'INSPECTED',
  'FAILED_INSPECTION',
  'SKIPPED',
  'CANCELLED',
] as const;

export const HkJobCreated = defineEvent({
  type: 'hk.job.created',
  version: 1,
  description:
    'A cleaning job was created for a room and day (its work item carries assignment and SLA).',
  payload: z.object({
    job_id: z.uuid(),
    room_id: z.uuid(),
    work_item_id: z.uuid().nullable(),
    cleaning_type: z.enum(CLEANING_TYPES),
    origin: z.enum(['GENERATED', 'STAFF', 'INSPECTION']),
    credits: z.number().min(0),
    scheduled_for: z.iso.date(),
  }),
});

export const HkJobStatusChanged = defineEvent({
  type: 'hk.job.status_changed',
  version: 1,
  description: 'A cleaning job started, finished, was inspected, skipped or cancelled.',
  payload: z.object({
    job_id: z.uuid(),
    room_id: z.uuid(),
    from: z.enum(HK_JOB_STATUSES),
    to: z.enum(HK_JOB_STATUSES),
  }),
});
