import { POS_CHECK_MESSAGE, type PosCheckPayload } from '@hotella/contracts-connectors';

export interface SimOutlet {
  /** The POS's outlet code (mapped by staff to an outlet category). */
  readonly code: string;
  readonly covers: boolean;
  /** Typical check range in minor units. */
  readonly minMinor: number;
  readonly maxMinor: number;
}

/** A small hotel's outlets: a restaurant, a bar, room service and the spa. */
export const HOTEL_OUTLETS: readonly SimOutlet[] = [
  { code: 'OUT-REST', covers: true, minMinor: 60_000, maxMinor: 240_000 },
  { code: 'OUT-BAR', covers: false, minMinor: 8_000, maxMinor: 45_000 },
  { code: 'OUT-IRD', covers: true, minMinor: 25_000, maxMinor: 90_000 },
  { code: 'OUT-SPA', covers: false, minMinor: 80_000, maxMinor: 300_000 },
];

/**
 * The POS face of the simulator (BUILD_PLAN 13.5, Planova POS Profile v1): closed checks with totals only — no item
 * lines, card data or names — each sent with its check id as the message id. Deterministic: the same seed gives the
 * same evening.
 */
export class SimulatedPos {
  private n = 0;
  constructor(
    private readonly outlets: readonly SimOutlet[] = HOTEL_OUTLETS,
    private seed = 1,
  ) {}

  private next(): number {
    // xorshift32: reproducible scenarios without a dependency.
    let x = this.seed;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.seed = x >>> 0;
    return this.seed / 0x1_0000_0000;
  }

  /** One closed check; `room` charges it to a room (else the guest paid in cash or by card). */
  close(input: {
    readonly outlet?: string;
    readonly room?: string | null;
    readonly reservation?: string | null;
    readonly at?: Date;
    readonly currency?: string;
  }): { message_type: string; source_message_id: string; payload: PosCheckPayload } {
    const outlet = this.outlets.find((o) => o.code === input.outlet) ?? this.outlets[0]!;
    const check = `SIM-CHK-${++this.n}`;
    const total = Math.round(outlet.minMinor + this.next() * (outlet.maxMinor - outlet.minMinor));
    const room = input.room ?? null;
    return {
      message_type: POS_CHECK_MESSAGE,
      source_message_id: check,
      payload: {
        check_id: check,
        outlet: outlet.code,
        room,
        reservation: input.reservation
          ? { external_id: input.reservation, confirmation_number: null }
          : null,
        closed_at: (input.at ?? new Date()).toISOString(),
        total_minor: total,
        currency: input.currency ?? 'EGP',
        covers: outlet.covers ? 1 + Math.floor(this.next() * 4) : null,
        settlement: room ? 'ROOM_CHARGE' : this.next() < 0.5 ? 'CARD' : 'CASH',
      },
    };
  }

  /** An evening: `count` checks spread over the outlets, charged to the given rooms in turn (some walk-ins). */
  evening(rooms: readonly string[], count: number, at = new Date()) {
    return Array.from({ length: count }, (_, i) =>
      this.close({
        outlet: this.outlets[i % this.outlets.length]!.code,
        room: i % 3 === 2 ? null : (rooms[i % Math.max(1, rooms.length)] ?? null),
        at: new Date(at.getTime() - (count - i) * 7 * 60_000),
      }),
    );
  }
}
