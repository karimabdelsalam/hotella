import { z } from 'zod';

const code = z
  .string()
  .trim()
  .regex(/^[A-Z][A-Z0-9_]{1,39}$/);
const locale = z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/);
const day = z.iso.date();
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const translationSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).nullish(),
  dressCode: z.string().trim().max(300).nullish(),
});

const settings = {
  minParty: z.number().int().min(1).max(50),
  maxParty: z.number().int().min(1).max(50),
  bookDaysAhead: z.number().int().min(0).max(60),
  guestCutoffMinutes: z
    .number()
    .int()
    .min(0)
    .max(24 * 60),
  allowanceApplies: z.boolean(),
  sortOrder: z.number().int().min(0).max(999),
};

export const createRestaurantSchema = z
  .object({
    code,
    translations: z.array(translationSchema.extend({ locale })).min(1).max(10),
    minParty: settings.minParty.default(1),
    maxParty: settings.maxParty.default(8),
    bookDaysAhead: settings.bookDaysAhead.default(7),
    guestCutoffMinutes: settings.guestCutoffMinutes.default(120),
    allowanceApplies: settings.allowanceApplies.default(true),
    sortOrder: settings.sortOrder.default(0),
  })
  .refine((v) => v.maxParty >= v.minParty, { message: 'maxParty < minParty', path: ['maxParty'] });

export const updateRestaurantSchema = z.object({
  version: z.number().int().min(1),
  status: z.enum(['DRAFT', 'ACTIVE', 'INACTIVE']).optional(),
  minParty: settings.minParty.optional(),
  maxParty: settings.maxParty.optional(),
  bookDaysAhead: settings.bookDaysAhead.optional(),
  guestCutoffMinutes: settings.guestCutoffMinutes.optional(),
  allowanceApplies: settings.allowanceApplies.optional(),
  sortOrder: settings.sortOrder.optional(),
});

export const scheduleSchema = z.object({
  /** The new weekly schedule applies from this date; bookings made before keep their sitting. */
  fromDate: day,
  sittings: z
    .array(
      z.object({
        weekday: z.number().int().min(0).max(6),
        startsAt: clock,
        seats: z.number().int().min(1).max(1000),
      }),
    )
    .max(70),
});

export const closureSchema = z.object({
  onDate: day,
  sittingId: z.uuid().nullish(),
  reason: z.string().trim().min(2).max(500),
});

export const rangeSchema = z
  .object({ from: day, to: day })
  .refine((v) => v.from <= v.to, { message: 'from > to', path: ['to'] });

const booking = {
  restaurantId: z.uuid(),
  sittingId: z.uuid(),
  serviceDate: day,
  partySize: z.number().int().min(1).max(50),
  notes: z.string().trim().max(500).nullish(),
};
export const guestBookSchema = z.object(booking);
export const staffBookSchema = z.object({
  ...booking,
  stayId: z.uuid(),
  /** Beyond the stay allowance or a full sitting — needs `restaurant.reservation.override` and a reason. */
  override: z.object({ reason: z.string().trim().min(3).max(500) }).optional(),
});
export const stayLookupSchema = z.object({ room: z.string().trim().min(1).max(10) });
export const transitionSchema = z.object({
  version: z.number().int().min(1),
  reason: z.string().trim().max(500).optional(),
});
export const boardQuerySchema = z.object({ date: day, restaurantId: z.uuid().optional() });

export type CreateRestaurantInput = z.infer<typeof createRestaurantSchema>;
export type UpdateRestaurantInput = z.infer<typeof updateRestaurantSchema>;
export type ScheduleInput = z.infer<typeof scheduleSchema>;
export type ClosureInput = z.infer<typeof closureSchema>;
export type GuestBookInput = z.infer<typeof guestBookSchema>;
export type StaffBookInput = z.infer<typeof staffBookSchema>;
export type TransitionInput = z.infer<typeof transitionSchema>;
