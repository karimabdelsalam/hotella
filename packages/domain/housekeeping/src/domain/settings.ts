import { z } from 'zod';
import { defineSetting } from '@hotella/platform-settings';
import { READINESS_DIMENSIONS, type ReadinessDimension } from './readiness';

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

/** What makes a vacant room ready at this property (Spec §16). */
export const HK_READINESS_DIMENSIONS = defineSetting<ReadinessDimension[]>({
  key: 'hk.readiness.dimensions',
  scopes: SCOPES,
  schema: z.array(z.enum(READINESS_DIMENSIONS)).min(1),
  default: ['HOUSEKEEPING', 'ENGINEERING', 'NO_OOO'],
  descriptionKey: 'hk.setting.readiness_dimensions',
});
/** A vacant clean room with an arrival today gets an ARRIVAL clean (a final check before the guest). */
export const HK_ARRIVAL_CLEAN = defineSetting({
  key: 'hk.arrival.clean',
  scopes: SCOPES,
  schema: z.boolean(),
  default: false,
  descriptionKey: 'hk.setting.arrival_clean',
});

export const HOUSEKEEPING_SETTINGS = [
  HK_INSPECTION_REQUIRED,
  HK_STAYOVER_HOUR,
  HK_READINESS_DIMENSIONS,
  HK_ARRIVAL_CLEAN,
];
