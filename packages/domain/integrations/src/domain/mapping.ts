import {
  type InboundProfile,
  type InboundRecord,
  type MappingType,
  REQUIRED_MAPPING_TYPES,
} from '@hotella/contracts-connectors';
import {
  type EventDefinition,
  GuestCheckedIn,
  GuestCheckedOut,
  type GuestProfile,
  GuestProfileUpdated,
  ReservationCancelled,
  ReservationCreated,
  ReservationUpdated,
  RoomStatusChanged,
  StayRoomChanged,
} from '@hotella/contracts-events';

/** An external code a record needs translated (Spec §52). */
export interface CodeNeed {
  readonly type: MappingType;
  readonly code: string;
  readonly required: boolean;
}

/** Every external code in a record, in a stable order. */
export function codesOf(record: InboundRecord): CodeNeed[] {
  const out: CodeNeed[] = [];
  const add = (type: MappingType, code: string | null | undefined) => {
    if (code) out.push({ type, code, required: REQUIRED_MAPPING_TYPES.has(type) });
  };
  const profiles = (...ps: InboundProfile[]) => ps.forEach((p) => add('VIP', p.vip_code));
  switch (record.kind) {
    case 'CHECK_IN':
      add('ROOM', record.room_code);
      add('RATE', record.rate_code);
      add('MARKET', record.market_code);
      profiles(record.primary_guest, ...record.accompanying_guests);
      break;
    case 'RESERVATION_UPSERT':
      add('ROOM', record.room_code);
      add('RATE', record.rate_code);
      add('MARKET', record.market_code);
      profiles(record.primary_guest, ...record.accompanying_guests);
      break;
    case 'CHECK_OUT':
      add('ROOM', record.room_code);
      break;
    case 'ROOM_MOVE':
      add('ROOM', record.from_room_code);
      add('ROOM', record.to_room_code);
      break;
    case 'PROFILE_UPDATE':
      profiles(record.profile);
      break;
    case 'ROOM_STATUS':
      add('ROOM', record.room_code);
      break;
    case 'RESERVATION_CANCELLED':
      break;
  }
  return out;
}

/** Resolved values: `ROOM` → internal room id; other types → canonical code. */
export interface ResolvedCodes {
  get(type: MappingType, code: string): string | undefined;
  roomNumber(roomId: string): string;
}

export interface CanonicalDraft {
  readonly definition: EventDefinition;
  readonly payload: unknown;
  readonly occurredAt: string;
}

/**
 * Builds the canonical event for a record whose required codes are all resolved. Pure: same record + same mappings ⇒
 * same payload. Optional codes without a mapping become null (never guessed); the caller records the gap.
 */
export function toCanonical(
  record: InboundRecord,
  instanceId: string,
  codes: ResolvedCodes,
): CanonicalDraft {
  const room = (code: string) => {
    const roomId = codes.get('ROOM', code);
    if (!roomId) throw new Error(`unresolved required ROOM code`); // guarded by the caller
    return { room_id: roomId, room_number: codes.roomNumber(roomId) };
  };
  const optional = (type: MappingType, code: string | null) =>
    code ? (codes.get(type, code) ?? null) : null;
  const profile = (p: InboundProfile): GuestProfile => ({
    external_id: p.external_id,
    given_name: p.given_name,
    family_name: p.family_name,
    title: p.title,
    locale: p.locale,
    vip_code: optional('VIP', p.vip_code),
    email: p.email,
    phone: p.phone,
    loyalty_number: p.loyalty_number,
  });
  const reservation = (r: { external_id: string; confirmation_number: string | null }) => ({
    integration_instance_id: instanceId,
    external_id: r.external_id,
    confirmation_number: r.confirmation_number,
  });

  switch (record.kind) {
    case 'CHECK_IN':
      return {
        definition: GuestCheckedIn,
        occurredAt: record.occurred_at,
        payload: {
          reservation: reservation(record.reservation),
          primary_guest: profile(record.primary_guest),
          accompanying_guests: record.accompanying_guests.map(profile),
          room: room(record.room_code),
          arrival_date: record.arrival_date,
          departure_date: record.departure_date,
          adults: record.adults,
          children: record.children,
          rate_code: optional('RATE', record.rate_code),
          market_code: optional('MARKET', record.market_code),
          checked_in_at: record.occurred_at,
        },
      };
    case 'CHECK_OUT':
      return {
        definition: GuestCheckedOut,
        occurredAt: record.occurred_at,
        payload: {
          reservation: reservation(record.reservation),
          room: record.room_code ? room(record.room_code) : null,
          checked_out_at: record.occurred_at,
        },
      };
    case 'ROOM_MOVE':
      return {
        definition: StayRoomChanged,
        occurredAt: record.occurred_at,
        payload: {
          reservation: reservation(record.reservation),
          from_room: record.from_room_code ? room(record.from_room_code) : null,
          to_room: room(record.to_room_code),
          reason: record.reason,
          changed_at: record.occurred_at,
        },
      };
    case 'RESERVATION_UPSERT':
      return {
        definition: record.change === 'CREATED' ? ReservationCreated : ReservationUpdated,
        occurredAt: record.occurred_at,
        payload: {
          reservation: reservation(record.reservation),
          primary_guest: profile(record.primary_guest),
          accompanying_guests: record.accompanying_guests.map(profile),
          arrival_date: record.arrival_date,
          departure_date: record.departure_date,
          eta: record.eta,
          adults: record.adults,
          children: record.children,
          room: record.room_code ? room(record.room_code) : null,
          rate_code: optional('RATE', record.rate_code),
          market_code: optional('MARKET', record.market_code),
        },
      };
    case 'RESERVATION_CANCELLED':
      return {
        definition: ReservationCancelled,
        occurredAt: record.occurred_at,
        payload: {
          reservation: reservation(record.reservation),
          outcome: record.outcome,
          cancelled_at: record.occurred_at,
        },
      };
    case 'PROFILE_UPDATE':
      return {
        definition: GuestProfileUpdated,
        occurredAt: record.occurred_at,
        payload: {
          reservation: record.reservation ? reservation(record.reservation) : null,
          profile: profile(record.profile),
          updated_at: record.occurred_at,
        },
      };
    case 'ROOM_STATUS':
      return {
        definition: RoomStatusChanged,
        occurredAt: record.occurred_at,
        payload: {
          room: room(record.room_code),
          status: record.status,
          occupied: record.occupied,
          changed_at: record.occurred_at,
        },
      };
  }
}
