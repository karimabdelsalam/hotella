import { z } from 'zod';

/**
 * Canonical rows of the PMS read queries (ADR-0019; OPERA Integration Guide §4.2, §6.3): what any connector answers
 * for a lookup, a list or a snapshot, whatever it reads underneath (the OPERA database, OWS, the simulator). Codes stay
 * the PMS's own (status, room type, rate, market, VIP) and are mapped by the platform's mapping tables; personal data
 * is limited to the logical contract (no documents, cards, folios or amounts).
 */

export const PMS_RESERVATION_STATUSES = [
  'RESERVED',
  'IN_HOUSE',
  'CHECKED_OUT',
  'CANCELLED',
  'NO_SHOW',
] as const;

const code = z.string().min(1).max(64);
const day = z.iso.date();

export const pmsReservationRowSchema = z.object({
  reservation_id: z.string().min(1).max(128),
  confirmation_number: z.string().max(64).nullable(),
  status: z.enum(PMS_RESERVATION_STATUSES),
  arrival_date: day,
  departure_date: day,
  /** Local expected arrival time, `HH:mm`, when the PMS knows it. */
  eta: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .nullable(),
  adults: z.number().int().min(0).max(50),
  children: z.number().int().min(0).max(50),
  room_number: z.string().max(16).nullable(),
  room_type: code.nullable(),
  rate_code: code.nullable(),
  market_code: code.nullable(),
  profile_id: z.string().max(128).nullable(),
  /** The reservation this one shares a room with, when it is a sharer. */
  share_of: z.string().max(128).nullable(),
});
export type PmsReservationRow = z.infer<typeof pmsReservationRowSchema>;

export const pmsProfileRowSchema = z.object({
  profile_id: z.string().min(1).max(128),
  title: z.string().max(40).nullable(),
  first_name: z.string().max(200).nullable(),
  last_name: z.string().max(200).nullable(),
  language: z.string().max(16).nullable(),
  vip_code: code.nullable(),
  email: z.string().max(320).nullable(),
  phone: z.string().max(32).nullable(),
});
export type PmsProfileRow = z.infer<typeof pmsProfileRowSchema>;

export const pmsRoomRowSchema = z.object({
  room_number: z.string().min(1).max(16),
  room_type: code.nullable(),
  floor: z.string().max(16).nullable(),
});
export type PmsRoomRow = z.infer<typeof pmsRoomRowSchema>;

/** Parameters of the standard read queries; a connector declares the ones it serves (guide §4.2). */
export const pmsQueryParams = {
  LOOKUP_RESERVATION: z
    .object({
      confirmation_number: z.string().min(1).max(64).optional(),
      reservation_id: z.string().min(1).max(128).optional(),
    })
    .strict()
    .refine((p) => Boolean(p.confirmation_number) !== Boolean(p.reservation_id), {
      message: 'exactly one of confirmation_number or reservation_id',
    }),
  LIST_ARRIVALS: z
    .object({ from: day, to: day })
    .strict()
    .refine((p) => p.from <= p.to, { message: 'from must not be after to' })
    .refine((p) => (Date.parse(p.to) - Date.parse(p.from)) / 86_400_000 <= 31, {
      message: 'at most 31 days',
    }),
  IN_HOUSE: z.object({}).strict(),
  LOOKUP_PROFILE: z.object({ profile_id: z.string().min(1).max(128) }).strict(),
  ROOM_INVENTORY: z.object({}).strict(),
} as const;
export type PmsQueryType = keyof typeof pmsQueryParams;

export const pmsQueryRows = {
  LOOKUP_RESERVATION: pmsReservationRowSchema,
  LIST_ARRIVALS: pmsReservationRowSchema,
  IN_HOUSE: pmsReservationRowSchema,
  LOOKUP_PROFILE: pmsProfileRowSchema,
  ROOM_INVENTORY: pmsRoomRowSchema,
} as const;
