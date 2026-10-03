import { z } from 'zod';
import { defineSetting } from '@hotella/platform-settings';

/** Housekeeping settings (BUILD_PLAN 7.B); registered by HousekeepingModule. */
const SCOPES = ['PLATFORM', 'TENANT', 'PROPERTY'] as const;

/** A cleaned room waits for a supervisor's inspection before it counts as ready. */
export const HK_INSPECTION_REQUIRED = defineSetting({
  key: 'hk.inspection.required',
  scopes: SCOPES,
  schema: z.boolean(),
  default: false,
  descriptionKey: 'hk.setting.inspection_required',
});
/** Property-local hour from which the day's stayover cleans are created for occupied rooms. */
export const HK_STAYOVER_HOUR = defineSetting({
  key: 'hk.stayover.hour',
  scopes: SCOPES,
  schema: z.number().int().min(0).max(23),
  default: 8,
  descriptionKey: 'hk.setting.stayover_hour',
});

export const HOUSEKEEPING_SETTINGS = [HK_INSPECTION_REQUIRED, HK_STAYOVER_HOUR];
