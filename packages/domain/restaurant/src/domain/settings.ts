import { z } from 'zod';
import { defineSetting } from '@hotella/platform-settings';
import { DEFAULT_ALLOWANCE } from './rules';

/** Restaurant settings (Spec Appendix B.1); registered by RestaurantModule. */
const SCOPES = ['PLATFORM', 'TENANT', 'PROPERTY'] as const;

/** One booking (`perBlock`) per restaurant per started block of `blockNights` nights of a stay. */
export const ALLOWANCE = defineSetting({
  key: 'restaurant.reservation.allowance',
  scopes: SCOPES,
  schema: z.object({
    blockNights: z.number().int().min(1).max(60),
    perBlock: z.number().int().min(1).max(10),
  }),
  default: DEFAULT_ALLOWANCE,
  descriptionKey: 'restaurant.setting.reservation_allowance',
});

export const RESTAURANT_SETTINGS = [ALLOWANCE];
