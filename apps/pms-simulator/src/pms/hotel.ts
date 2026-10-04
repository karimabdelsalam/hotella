import { randomUUID } from 'node:crypto';
import type { QueuedMessage } from '../agent/queue';

/**
 * A small simulated PMS (BUILD_PLAN §6.3). It keeps reservations and emits what a real interface would: FIAS-shaped
 * records for in-house events (check-in, guest change, check-out, room status, database sync) and OWS-shaped
 * results for reservations and profiles. Which face is active is configuration, so capability negotiation is
 * exercised exactly as with OPERA (ADR-0014).
 */

export type Face = 'FIAS' | 'OWS';

export interface SimGuest {
  readonly profileId?: string;
  readonly first: string;
  readonly last?: string;
  readonly title?: string;
  readonly language?: string;
  readonly vip?: string;
  readonly email?: string;
  readonly phone?: string;
}

export interface SimReservation {
  id: string;
  confirmation: string;
  guest: SimGuest;
  sharers: SimGuest[];
  arrival: string;
  departure: string;
  eta?: string;
  adults: number;
  children: number;
  room?: string;
  rate?: string;
  market?: string;
  status: 'RESERVED' | 'IN_HOUSE' | 'CHECKED_OUT' | 'CANCELLED' | 'NO_SHOW';
}

export class SimulationError extends Error {}

export class SimulatedPms {
  readonly reservations = new Map<string, SimReservation>();
  /** Room statuses the platform wrote back (SET_ROOM_STATUS), by room number. */
  readonly roomStatuses = new Map<string, string>();
  /** Out-of-order / out-of-service restrictions the platform wrote (SET_ROOM_RESTRICTION), by room number. */
  readonly restrictions = new Map<string, string>();
  private counter = 0;

  constructor(
    private readonly options: {
      readonly timezone: string;
      readonly faces: ReadonlySet<Face>;
      readonly emit: (message: QueuedMessage) => void;
      readonly clock?: () => Date;
    },
  ) {}

  // ---- reservations (OWS face) ----

  reserve(
    input: Omit<SimReservation, 'status' | 'confirmation' | 'sharers' | 'adults' | 'children'> & {
      confirmation?: string;
      sharers?: SimGuest[];
      adults?: number;
      children?: number;
    },
    /** When the booking was made (OWS modifiedAt); defaults to now. Scenarios dated in the past set it. */
    at?: string,
  ): SimReservation {
    if (this.reservations.has(input.id))
      throw new SimulationError(`reservation ${input.id} exists`);
    const r: SimReservation = {
      ...input,
      confirmation: input.confirmation ?? `C${input.id}`,
      sharers: input.sharers ?? [],
      adults: input.adults ?? 1 + (input.sharers?.length ?? 0),
      children: input.children ?? 0,
      status: 'RESERVED',
    };
    this.reservations.set(r.id, r);
    this.ows('NEW', r, at);
    return r;
  }

  modify(id: string, changes: Partial<Omit<SimReservation, 'id' | 'status'>>, at?: string): void {
    const r = this.get(id);
    Object.assign(r, changes);
    this.ows('CHANGE', r, at);
  }

  cancel(id: string, outcome: 'CANCELLED' | 'NO_SHOW' = 'CANCELLED'): void {
    const r = this.get(id);
    r.status = outcome;
    this.ows(outcome === 'CANCELLED' ? 'CANCEL' : 'NOSHOW', r);
  }

  // ---- in-house events (FIAS face) ----

  checkIn(id: string, room: string, at?: string): void {
    const r = this.get(id);
    r.room = room;
    r.status = 'IN_HOUSE';
    this.fias('GI', { ...this.stayFields(r), ...this.stamp(at) });
  }

  move(id: string, toRoom: string, at?: string): void {
    const r = this.get(id);
    const from = r.room;
    r.room = toRoom;
    this.fias('GC', { RN: toRoom, RO: from, 'G#': r.id, ...this.stamp(at) });
  }

  updateGuest(id: string, changes: Partial<SimGuest>, at?: string): void {
    const r = this.get(id);
    r.guest = { ...r.guest, ...changes };
    this.fias('GC', { RN: r.room, 'G#': r.id, ...this.guestFields(r.guest), ...this.stamp(at) });
    if (this.options.faces.has('OWS') && r.guest.profileId)
      this.emit('OWS_PROFILE', {
        modifiedAt: this.iso(at),
        reservationId: r.id,
        profile: owsGuest(r.guest),
      });
  }

  checkOut(id: string, at?: string): void {
    const r = this.get(id);
    r.status = 'CHECKED_OUT';
    this.fias('GO', { RN: r.room, 'G#': r.id, ...this.stamp(at) });
  }

  /** FIAS maid status 1–6 (dirty/clean/inspected × vacant/occupied). */
  roomStatus(room: string, status: 1 | 2 | 3 | 4 | 5 | 6, at?: string): void {
    this.fias('RE', { RN: room, RS: String(status), ...this.stamp(at) });
  }

  /**
   * A room status written by the platform (SET_ROOM_STATUS). The PMS records it and, like OPERA for statuses set
   * through the interface, does not echo it back as an event.
   */
  acceptRoomStatus(room: string, status: string): void {
    this.roomStatuses.set(room, status);
  }

  /** A restriction written by the platform (or lifted, with null); recorded without an echo event. */
  acceptRoomRestriction(room: string, kind: string | null): void {
    if (kind) this.restrictions.set(room, kind);
    else this.restrictions.delete(room);
  }

  /** Database sync of the in-house list (FIAS DS/DR/DE), e.g. on a RESYNC_IN_HOUSE command. */
  resyncInHouse(): number {
    this.fias('DS', this.stamp());
    const inHouse = [...this.reservations.values()].filter((r) => r.status === 'IN_HOUSE');
    for (const r of inHouse) this.fias('DR', { ...this.stayFields(r), ...this.stamp() });
    this.fias('DE', this.stamp());
    return inHouse.length;
  }

  /**
   * The database sync as OPERA's IFC8 sends it when the interface asks (DR): DS, one GI with the sync flag `SF` per
   * in-house stay, DE. Returned as records for the IFC8 face; the JSON face keeps `resyncInHouse`.
   */
  databaseSync(at?: string): string[] {
    const stamp = this.stamp(at);
    const inHouse = [...this.reservations.values()].filter((r) => r.status === 'IN_HOUSE');
    return [
      fiasRecord('DS', stamp),
      ...inHouse.map((r) => fiasRecord('GI', { ...this.stayFields(r), SF: '1', ...stamp })),
      fiasRecord('DE', stamp),
    ];
  }

  // ---- encoding ----

  private get(id: string): SimReservation {
    const r = this.reservations.get(id);
    if (!r) throw new SimulationError(`unknown reservation ${id}`);
    return r;
  }

  private stayFields(r: SimReservation): Record<string, string | undefined> {
    return {
      RN: r.room,
      'G#': r.id,
      ...this.guestFields(r.guest),
      GA: fiasDate(r.arrival),
      GD: fiasDate(r.departure),
    };
  }

  private guestFields(g: SimGuest): Record<string, string | undefined> {
    return {
      GN: g.last ?? g.first,
      GF: g.last ? g.first : undefined,
      GT: g.title,
      GL: g.language,
      GV: g.vip,
    };
  }

  private stamp(at?: string): Record<string, string> {
    const instant = at ? new Date(at) : this.now();
    const local = wallClock(instant, this.options.timezone);
    return { DA: local.date, TI: local.time };
  }

  private fias(record: string, fields: Record<string, string | undefined>): void {
    if (!this.options.faces.has('FIAS')) return;
    this.emit('FIAS_RECORD', { record: fiasRecord(record, fields) });
  }

  private ows(
    action: 'NEW' | 'CHANGE' | 'CANCEL' | 'NOSHOW',
    r: SimReservation,
    at?: string,
  ): void {
    if (!this.options.faces.has('OWS')) return;
    this.emit('OWS_RESERVATION', {
      action,
      modifiedAt: this.iso(at),
      reservation: {
        reservationId: r.id,
        confirmationNo: r.confirmation,
        arrivalDate: r.arrival,
        departureDate: r.departure,
        ...(r.eta ? { expectedArrivalTime: r.eta } : {}),
        adults: r.adults,
        children: r.children,
        ...(r.room ? { roomNumber: r.room } : {}),
        ...(r.rate ? { ratePlanCode: r.rate } : {}),
        ...(r.market ? { marketCode: r.market } : {}),
        guest: owsGuest(r.guest),
        sharers: r.sharers.map(owsGuest),
      },
    });
  }

  private emit(messageType: string, payload: unknown): void {
    this.options.emit({
      source_message_id: `sim-${++this.counter}-${randomUUID()}`,
      message_type: messageType,
      occurred_at: this.now().toISOString(),
      payload,
    });
  }

  private now(): Date {
    return this.options.clock?.() ?? new Date();
  }

  private iso(at?: string): string {
    return at ? new Date(at).toISOString() : this.now().toISOString();
  }
}

function owsGuest(g: SimGuest) {
  return {
    ...(g.profileId ? { profileId: g.profileId } : {}),
    firstName: g.first,
    ...(g.last ? { lastName: g.last } : {}),
    ...(g.title ? { title: g.title } : {}),
    ...(g.language ? { language: g.language } : {}),
    ...(g.vip ? { vipCode: g.vip } : {}),
    ...(g.email ? { email: g.email } : {}),
    ...(g.phone ? { phone: g.phone } : {}),
  };
}

/** `GI|RN504|G#…|`: a record id and its non-empty fields. */
export function fiasRecord(record: string, fields: Record<string, string | undefined>): string {
  const body = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}${v}`)
    .join('|');
  return `${record}|${body}|`;
}

/** `2026-10-03` → `261003`. */
function fiasDate(isoDate: string): string {
  return isoDate.slice(2, 4) + isoDate.slice(5, 7) + isoDate.slice(8, 10);
}

/** Hotel wall-clock (FIAS DA/TI) for an instant in the property timezone. */
export function wallClock(instant: Date, timeZone: string): { date: string; time: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hourCycle: 'h23',
      year: '2-digit',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(instant)
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts['year']}${parts['month']}${parts['day']}`,
    time: `${parts['hour']}${parts['minute']}${parts['second']}`,
  };
}
