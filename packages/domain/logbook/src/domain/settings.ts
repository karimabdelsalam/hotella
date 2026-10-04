import { z } from 'zod';
import { defineSetting } from '@hotella/platform-settings';
import { DEFAULT_SHIFT_STARTS, validShiftStarts } from './shifts';

/** Logbook settings (BUILD_PLAN 9.B); registered by LogbookModule. */
const SCOPES = ['PLATFORM', 'TENANT', 'PROPERTY'] as const;
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

/** When each shift starts, in the property's wall-clock time. */
export const SHIFT_STARTS = defineSetting({
  key: 'logbook.shift.starts',
  scopes: SCOPES,
  schema: z
    .object({ MORNING: clock, EVENING: clock, NIGHT: clock })
    .refine(validShiftStarts, { message: 'MORNING < EVENING < NIGHT' }),
  default: DEFAULT_SHIFT_STARTS,
  descriptionKey: 'logbook.setting.shift_starts',
});

export const LOGBOOK_SETTINGS = [SHIFT_STARTS];
