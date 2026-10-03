import { z } from 'zod';
import { defineEvent } from './registry';

/**
 * Canonical hotel events (Spec §51, BUILD_PLAN §6.2). Produced ONLY by the Integration Platform after a raw vendor
 * message was parsed and its codes mapped (Spec §50); core domains consume these and never see FIAS/OWS/vendor
 * formats. Payloads carry internal ids for everything the mapper resolved (rooms) and an opaque reservation/profile
 * reference for correlation — vendor ids are never used as primary keys (CLAUDE.md rule 3).
 *
 * Payloads are snapshots: each event carries enough state to be applied on its own, so a consumer stays correct when
 * the PMS repeats or reorders messages (out-of-order events are detected through `occurred_at`).
 */

const LOCALE_RE = /^[a-z]{2}(-[A-Z]{2})?$/;
const date = z.iso.date();
const instant = z.iso.datetime({ offset: true });

/** Correlates a canonical event with the reservation it describes in one integration instance. */
export const reservationRefSchema = z.object({
  integration_instance_id: z.uuid(),
  /** Opaque reservation id in the source system (resolved to a stay through integration.external_references). */
  external_id: z.string().min(1).max(128),
  confirmation_number: z.string().min(1).max(64).nullable(),
});
export type ReservationRef = z.infer<typeof reservationRefSchema>;

/** Guest profile as known by the source system. Contact fields are only present when the source shares them. */
export const guestProfileSchema = z.object({
  /** Opaque profile id in the source system; null when the source has no stable profile (FIAS walk-ins). */
  external_id: z.string().min(1).max(128).nullable(),
  given_name: z.string().min(1).max(200),
  family_name: z.string().max(200).nullable(),
  title: z.string().max(40).nullable(),
  locale: z.string().regex(LOCALE_RE).nullable(),
  /** Canonical VIP level after mapping; null when absent or the source code is not mapped. */
  vip_code: z.string().max(32).nullable(),
  email: z.email().max(320).nullable(),
  phone: z.string().max(32).nullable(),
  loyalty_number: z.string().max(64).nullable(),
});
export type GuestProfile = z.infer<typeof guestProfileSchema>;

/** A room resolved by the mapper (external room code → internal room). */
export const roomRefSchema = z.object({
  room_id: z.uuid(),
  room_number: z.string().min(1).max(32),
});
export type RoomRef = z.infer<typeof roomRefSchema>;

const occupancy = {
  adults: z.number().int().min(0).max(50),
  children: z.number().int().min(0).max(50),
};

const reservationSnapshot = z.object({
  reservation: reservationRefSchema,
  primary_guest: guestProfileSchema,
  accompanying_guests: z.array(guestProfileSchema).max(20),
  arrival_date: date,
  departure_date: date,
  eta: instant.nullable(),
  ...occupancy,
  /** Pre-assigned room, when the source shares one before arrival. */
  room: roomRefSchema.nullable(),
  /** Canonical codes after mapping; null when absent or unmapped (an integration exception records the gap). */
  rate_code: z.string().max(32).nullable(),
  market_code: z.string().max(32).nullable(),
});

export const ReservationCreated = defineEvent({
  type: 'hotel.reservation.created',
  version: 1,
  canonical: true,
  description:
    'A future reservation became known (query-capable sources such as OWS; FIAS has no future stays).',
  payload: reservationSnapshot,
});

export const ReservationUpdated = defineEvent({
  type: 'hotel.reservation.updated',
  version: 1,
  canonical: true,
  description:
    'A known reservation changed (dates, party, ETA, pre-assigned room, codes). Full snapshot.',
  payload: reservationSnapshot,
});

export const ReservationCancelled = defineEvent({
  type: 'hotel.reservation.cancelled',
  version: 1,
  canonical: true,
  description: 'A reservation was cancelled or marked no-show in the PMS.',
  payload: z.object({
    reservation: reservationRefSchema,
    outcome: z.enum(['CANCELLED', 'NO_SHOW']),
    cancelled_at: instant,
  }),
});

export const GuestCheckedIn = defineEvent({
  type: 'hotel.guest.checked_in',
  version: 1,
  canonical: true,
  delivery: 'critical-operational',
  description:
    'The PMS checked a reservation in to a room. Drives stay activation (and, from Phase 4, guest access).',
  payload: z.object({
    reservation: reservationRefSchema,
    primary_guest: guestProfileSchema,
    accompanying_guests: z.array(guestProfileSchema).max(20),
    room: roomRefSchema,
    arrival_date: date,
    departure_date: date,
    ...occupancy,
    rate_code: z.string().max(32).nullable(),
    market_code: z.string().max(32).nullable(),
    checked_in_at: instant,
  }),
});

export const GuestCheckedOut = defineEvent({
  type: 'hotel.guest.checked_out',
  version: 1,
  canonical: true,
  delivery: 'critical-operational',
  description:
    'The PMS checked a stay out. Revokes every stay-bound access (Phase 4) and starts departure housekeeping (Phase 7).',
  payload: z.object({
    reservation: reservationRefSchema,
    /** Room the guest left; null when the source does not report it. */
    room: roomRefSchema.nullable(),
    checked_out_at: instant,
  }),
});

export const StayRoomChanged = defineEvent({
  type: 'hotel.stay.room_changed',
  version: 1,
  canonical: true,
  delivery: 'critical-operational',
  description: 'An in-house stay moved to another room (room move, upgrade, maintenance move).',
  payload: z.object({
    reservation: reservationRefSchema,
    from_room: roomRefSchema.nullable(),
    to_room: roomRefSchema,
    reason: z.enum(['ROOM_MOVE', 'UPGRADE', 'MAINTENANCE']),
    changed_at: instant,
  }),
});

export const GuestProfileUpdated = defineEvent({
  type: 'hotel.guest.profile_updated',
  version: 1,
  canonical: true,
  description:
    'Guest profile data changed in the PMS (name, language, VIP). Applied to the guest linked to the reservation/profile.',
  payload: z.object({
    reservation: reservationRefSchema.nullable(),
    profile: guestProfileSchema,
    updated_at: instant,
  }),
});

/** Canonical housekeeping/front-office room states (Spec §9). */
export const CANONICAL_ROOM_STATUSES = [
  'DIRTY',
  'CLEAN',
  'INSPECTED',
  'PICKUP',
  'OUT_OF_ORDER',
  'OUT_OF_SERVICE',
] as const;

export const RoomStatusChanged = defineEvent({
  type: 'hotel.room.status_changed',
  version: 1,
  canonical: true,
  description:
    'The PMS reported a room status change. Consumed by housekeeping (Phase 7) to keep the room projection in sync.',
  payload: z.object({
    room: roomRefSchema,
    status: z.enum(CANONICAL_ROOM_STATUSES),
    occupied: z.boolean().nullable(),
    changed_at: instant,
  }),
});

/** Every canonical PMS event, for consumers that subscribe to the whole family. */
export const HOTEL_EVENTS = [
  ReservationCreated,
  ReservationUpdated,
  ReservationCancelled,
  GuestCheckedIn,
  GuestCheckedOut,
  StayRoomChanged,
  GuestProfileUpdated,
  RoomStatusChanged,
] as const;
