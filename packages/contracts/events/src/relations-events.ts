import { z } from 'zod';
import { defineEvent } from './registry';

/** Guest relations events (Spec §12, BUILD_PLAN Phase 9): ids and codes only, never what the guest said. */

const severity = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);

export const ComplaintOpened = defineEvent({
  type: 'relations.complaint.opened',
  version: 1,
  description: 'A complaint was recorded (by staff, or confirmed from an AI candidate).',
  payload: z.object({
    complaint_id: z.uuid(),
    number: z.number().int(),
    category_code: z.string(),
    severity,
    source: z.enum(['STAFF', 'GUEST_WEB', 'CHAT', 'AI_CANDIDATE', 'SURVEY']),
    stay_id: z.uuid().nullable(),
  }),
});

export const ComplaintResolved = defineEvent({
  type: 'relations.complaint.resolved',
  version: 1,
  description: 'A complaint was resolved, with how long it stayed open and the recovery given.',
  payload: z.object({
    complaint_id: z.uuid(),
    category_code: z.string(),
    severity,
    open_minutes: z.number().int().min(0),
    recovery_kinds: z.array(z.string()),
  }),
});
