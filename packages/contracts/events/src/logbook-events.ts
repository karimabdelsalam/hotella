import { z } from 'zod';
import { defineEvent } from './registry';

/** Logbook events (Spec §14, BUILD_PLAN Phase 9): ids and codes only, never what was written. */

export const HandoverAcknowledged = defineEvent({
  type: 'logbook.handover.acknowledged',
  version: 1,
  description:
    'The incoming supervisor acknowledged a shift handover (drafted by the assistant or written).',
  payload: z.object({
    handover_id: z.uuid(),
    department_code: z.string(),
    shift_date: z.iso.date(),
    shift: z.enum(['MORNING', 'EVENING', 'NIGHT']),
    source: z.enum(['AI', 'WRITTEN']),
    edited: z.boolean(),
  }),
});
