import { z } from 'zod';
import { defineEvent } from './registry';

/** Engineering events (Spec §10, BUILD_PLAN Phase 8): ids and codes only, never the engineer's free text. */

export const WORK_ORDER_TYPES = [
  'CORRECTIVE',
  'PREVENTIVE',
  'PREDICTIVE',
  'INSPECTION',
  'EMERGENCY',
  'PROJECT',
] as const;

export const WorkOrderCreated = defineEvent({
  type: 'eng.work_order.created',
  version: 1,
  description:
    'Engineering work was opened on an asset or at a place (its work item carries assignment and SLA).',
  payload: z.object({
    work_order_id: z.uuid(),
    work_item_id: z.uuid(),
    number: z.number().int(),
    type: z.enum(WORK_ORDER_TYPES),
    source: z.enum(['STAFF', 'GUEST_REQUEST', 'PM', 'INSPECTION', 'AI']),
    asset_id: z.uuid().nullable(),
    location_id: z.uuid(),
    symptom_code: z.string().nullable(),
  }),
});

export const WorkOrderClosed = defineEvent({
  type: 'eng.work_order.closed',
  version: 1,
  description:
    'A work order was completed or cancelled, with its failure taxonomy and downtime (reliability history).',
  payload: z.object({
    work_order_id: z.uuid(),
    asset_id: z.uuid().nullable(),
    type: z.enum(WORK_ORDER_TYPES),
    status: z.enum(['DONE', 'CANCELLED']),
    symptom_code: z.string().nullable(),
    failure_mode_code: z.string().nullable(),
    cause_code: z.string().nullable(),
    resolution_code: z.string().nullable(),
    downtime_minutes: z.number().int().min(0).nullable(),
  }),
});
