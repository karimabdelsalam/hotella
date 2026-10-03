import { z } from 'zod';
import { defineEvent } from './registry';

/** Lost & Found events (Spec §13, BUILD_PLAN Phase 9): ids and codes only, never a description or a claimant. */

const category = z.string();

export const LostFoundItemRegistered = defineEvent({
  type: 'lostfound.item.registered',
  version: 1,
  description: 'A found item or a lost report was registered.',
  payload: z.object({
    item_id: z.uuid(),
    number: z.number().int(),
    kind: z.enum(['FOUND', 'LOST']),
    category,
    valuable: z.boolean(),
    stay_id: z.uuid().nullable(),
  }),
});

export const LostFoundItemReleased = defineEvent({
  type: 'lostfound.item.released',
  version: 1,
  description: 'A found item was handed over to its owner after verification.',
  payload: z.object({
    item_id: z.uuid(),
    category,
    lost_item_id: z.uuid().nullable(),
    handover: z.enum(['IN_PERSON', 'COURIER', 'REPRESENTATIVE']),
    held_days: z.number().int().min(0),
  }),
});

export const LostFoundItemDisposed = defineEvent({
  type: 'lostfound.item.disposed',
  version: 1,
  description:
    'An unclaimed found item past its retention date was disposed of by an explicit, audited action.',
  payload: z.object({
    item_id: z.uuid(),
    category,
    method: z.enum(['DONATED', 'DESTROYED', 'HANDED_TO_AUTHORITIES', 'GIVEN_TO_FINDER']),
  }),
});
