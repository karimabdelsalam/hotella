import { z } from 'zod';
import type { ConnectorCapability } from './capabilities';

/**
 * The connector-neutral inbound record (Connector SDK v0, Spec §50/§56). A connector adapter parses one raw vendor
 * message into zero or more of these; the platform's mapper then resolves the external codes they still contain
 * (room numbers, rate/market/VIP codes) and turns each record into a canonical `hotel.*` event. Adapters never see
 * internal ids and never decide mappings.
 */

const LOCALE_RE = /^[a-z]{2}(-[A-Z]{2})?$/;
const date = z.iso.date();
const instant = z.iso.datetime({ offset: true });
const code = z.string().trim().min(1).max(64);

export const inboundReservationSchema = z.object({
  external_id: z.string().min(1).max(128),
  confirmation_number: z.string().min(1).max(64).nullable().default(null),
});

export const inboundProfileSchema = z.object({
  external_id: z.string().min(1).max(128).nullable().default(null),
  given_name: z.string().trim().min(1).max(200),
  family_name: z.string().trim().max(200).nullable().default(null),
  title: z.string().trim().max(40).nullable().default(null),
  locale: z.string().regex(LOCALE_RE).nullable().default(null),
  /** External VIP code; mapped (VIP, optional). */
  vip_code: code.nullable().default(null),
  email: z.email().max(320).nullable().default(null),
  phone: z.string().max(32).nullable().default(null),
  loyalty_number: z.string().max(64).nullable().default(null),
});
export type InboundProfile = z.infer<typeof inboundProfileSchema>;

const stayCore = {
  reservation: inboundReservationSchema,
  primary_guest: inboundProfileSchema,
  accompanying_guests: z.array(inboundProfileSchema).max(20).default([]),
  arrival_date: date,
  departure_date: date,
  adults: z.number().int().min(0).max(50).default(1),
  children: z.number().int().min(0).max(50).default(0),
  /** External rate / market codes; mapped (RATE / MARKET, optional). */
  rate_code: code.nullable().default(null),
  market_code: code.nullable().default(null),
};

/** Samples one telemetry message may carry. */
export const MAX_TELEMETRY_SAMPLES = 500;
export const telemetrySampleSchema = z.object({
  /** The external point code (BMS point, sensor id); mapped to an engineering point, never guessed. */
  point: code,
  value: z.number().finite(),
  at: instant,
});
export type TelemetrySample = z.infer<typeof telemetrySampleSchema>;

/**
 * Planova Telemetry Profile v1: the raw message a BMS gateway (agent bridge or cloud webhook) sends — one
 * `TELEMETRY_BATCH` per flush, the samples verbatim. Vendor gateways are connectors that produce exactly this.
 */
export const TELEMETRY_BATCH_MESSAGE = 'TELEMETRY_BATCH';
export const telemetryBatchPayloadSchema = z.object({
  samples: z.array(telemetrySampleSchema).min(1).max(MAX_TELEMETRY_SAMPLES),
});
export type TelemetryBatchPayload = z.infer<typeof telemetryBatchPayloadSchema>;

export const inboundRecordSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('CHECK_IN'),
    ...stayCore,
    /** External room code; mapped (ROOM, required). */
    room_code: code,
    occurred_at: instant,
  }),
  z.object({
    kind: z.literal('CHECK_OUT'),
    reservation: inboundReservationSchema,
    room_code: code.nullable().default(null),
    occurred_at: instant,
  }),
  z.object({
    kind: z.literal('ROOM_MOVE'),
    reservation: inboundReservationSchema,
    from_room_code: code.nullable().default(null),
    to_room_code: code,
    reason: z.enum(['ROOM_MOVE', 'UPGRADE', 'MAINTENANCE']).default('ROOM_MOVE'),
    occurred_at: instant,
  }),
  z.object({
    kind: z.literal('RESERVATION_UPSERT'),
    /** CREATED when the source says the reservation is new, UPDATED otherwise. */
    change: z.enum(['CREATED', 'UPDATED']),
    ...stayCore,
    eta: instant.nullable().default(null),
    room_code: code.nullable().default(null),
    occurred_at: instant,
  }),
  z.object({
    kind: z.literal('RESERVATION_CANCELLED'),
    reservation: inboundReservationSchema,
    outcome: z.enum(['CANCELLED', 'NO_SHOW']),
    occurred_at: instant,
  }),
  z.object({
    kind: z.literal('PROFILE_UPDATE'),
    reservation: inboundReservationSchema.nullable().default(null),
    profile: inboundProfileSchema,
    occurred_at: instant,
  }),
  // Database sync (FIAS DS/DR/DE or an OWS in-house query): a PMS snapshot for reconciliation (Spec §52), never
  // applied as check-ins — differences become reconciliation results and exceptions.
  z.object({ kind: z.literal('SYNC_START'), occurred_at: instant }),
  z.object({
    kind: z.literal('IN_HOUSE_ENTRY'),
    reservation: inboundReservationSchema,
    room_code: code.nullable().default(null),
    occurred_at: instant,
  }),
  z.object({ kind: z.literal('SYNC_END'), occurred_at: instant }),
  z.object({
    kind: z.literal('ROOM_STATUS'),
    room_code: code,
    status: z.enum(['DIRTY', 'CLEAN', 'INSPECTED', 'PICKUP', 'OUT_OF_ORDER', 'OUT_OF_SERVICE']),
    occupied: z.boolean().nullable().default(null),
    occurred_at: instant,
  }),
  /**
   * Building telemetry (Planova Telemetry Profile v1): raw samples of external points. Not turned into domain events
   * (rule 6, and far too many): the ingest hands them to engineering's telemetry sink, which keeps minute aggregates.
   */
  z.object({
    kind: z.literal('TELEMETRY_SAMPLES'),
    samples: z.array(telemetrySampleSchema).min(1).max(MAX_TELEMETRY_SAMPLES),
  }),
]);
export type InboundRecord = z.infer<typeof inboundRecordSchema>;
export type InboundRecordInput = z.input<typeof inboundRecordSchema>;
export type InboundRecordKind = InboundRecord['kind'];

/** The capability an instance must have negotiated for a record of each kind to be applied (Spec §47). */
export const RECORD_CAPABILITY = {
  CHECK_IN: 'CHECKIN_EVENT',
  CHECK_OUT: 'CHECKOUT_EVENT',
  ROOM_MOVE: 'ROOM_MOVE_EVENT',
  RESERVATION_UPSERT: 'RESERVATION_READ',
  RESERVATION_CANCELLED: 'RESERVATION_READ',
  PROFILE_UPDATE: 'PROFILE_EVENT',
  ROOM_STATUS: 'ROOM_STATUS_READ',
  SYNC_START: 'RECONCILIATION_READ',
  IN_HOUSE_ENTRY: 'RECONCILIATION_READ',
  SYNC_END: 'RECONCILIATION_READ',
  TELEMETRY_SAMPLES: 'TELEMETRY_READ',
} as const satisfies Record<InboundRecordKind, ConnectorCapability>;

/**
 * Ordering key of a record: messages that touch the same reservation (or room, for room status) are applied in
 * source order; a message blocked on a mapping holds back its successors with the same key (Spec §50).
 */
export function orderingKeyOf(record: InboundRecord): string {
  switch (record.kind) {
    case 'ROOM_STATUS':
      return `room:${record.room_code}`;
    case 'SYNC_START':
    case 'IN_HOUSE_ENTRY':
    case 'SYNC_END':
      return 'sync';
    // Aggregates are order-independent and telemetry never waits for a mapping.
    case 'TELEMETRY_SAMPLES':
      return 'telemetry';
    case 'PROFILE_UPDATE':
      return record.reservation
        ? `reservation:${record.reservation.external_id}`
        : `profile:${record.profile.external_id ?? record.profile.given_name}`;
    default:
      return `reservation:${record.reservation.external_id}`;
  }
}
