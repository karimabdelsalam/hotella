import { describe, expect, it } from 'vitest';
import { inboundRecordSchema } from '@hotella/contracts-connectors';
import { opera5FiasAdapter, opera5OwsAdapter } from '../connectors/opera5';
import { simPmsAdapter } from '../connectors/sim-pms';
import { classifyHealth, effectiveCapabilities, HEALTH_WINDOW, recordOutcome } from './instance';
import { type CanonicalRecord, codesOf, toCanonical } from './mapping';

const ctx = { timezone: 'Africa/Cairo', receivedAt: '2026-10-03T10:00:00.000Z' };
const fias = (record: string) =>
  simPmsAdapter.parse(
    {
      message_type: 'FIAS_RECORD',
      source_message_id: 'x',
      sequence_no: 1,
      occurred_at: null,
      payload: { record },
    },
    ctx,
  );

describe('SIM_PMS adapter', () => {
  it('parses FIAS-shaped check-in, check-out, guest change and room status records', () => {
    const gi = fias(
      'GI|RN504|G#R1|GNNile|GFAmira|GTMrs|GLAR|GVGOLD|GA261003|GD261006|DA261003|TI143000|',
    );
    expect(gi.ok && gi.records[0]).toMatchObject({
      kind: 'CHECK_IN',
      room_code: '504',
      reservation: { external_id: 'R1', confirmation_number: null },
      primary_guest: {
        given_name: 'Amira',
        family_name: 'Nile',
        title: 'Mrs',
        locale: 'ar',
        vip_code: 'GOLD',
      },
      arrival_date: '2026-10-03',
      departure_date: '2026-10-06',
      occurred_at: '2026-10-03T11:30:00.000Z',
    });
    const go = fias('GO|RN504|G#R1|');
    expect(go.ok && go.records[0]).toMatchObject({
      kind: 'CHECK_OUT',
      occurred_at: ctx.receivedAt,
    });
    const gc = fias('GC|RN505|RO504|G#R1|GNNile|GLEN|');
    expect(gc.ok && gc.records.map((r) => r.kind)).toEqual(['ROOM_MOVE', 'PROFILE_UPDATE']);
    const re = fias('RE|RN504|RS2|');
    expect(re.ok && re.records[0]).toMatchObject({
      kind: 'ROOM_STATUS',
      status: 'DIRTY',
      occupied: true,
    });
    const ls = fias('LS|DA261003|TI120000|');
    expect(ls.ok && ls.records).toEqual([]);
  });

  it('reports malformed records as parse errors instead of guessing', () => {
    for (const bad of [
      'GI|RN504|',
      'XX|RN1|',
      'RE|RN504|RS9|',
      'GI|RN504|G#R1|GNX|GD2610|',
      'gi|',
      'GC|G#R1|',
    ]) {
      const r = fias(bad);
      expect(r.ok, bad).toBe(false);
    }
    const ows = simPmsAdapter.parse(
      {
        message_type: 'OWS_RESERVATION',
        source_message_id: 'x',
        sequence_no: null,
        occurred_at: null,
        payload: { action: 'NEW' },
      },
      ctx,
    );
    expect(ows.ok).toBe(false);
  });

  it('parses OWS-shaped reservations and cancellations', () => {
    const parse = (payload: unknown) =>
      simPmsAdapter.parse(
        {
          message_type: 'OWS_RESERVATION',
          source_message_id: 'x',
          sequence_no: null,
          occurred_at: null,
          payload,
        },
        ctx,
      );
    const created = parse({
      action: 'NEW',
      modifiedAt: '2026-10-01T08:00:00Z',
      reservation: {
        reservationId: 'R9',
        confirmationNo: 'C9',
        arrivalDate: '2026-10-10',
        departureDate: '2026-10-12',
        expectedArrivalTime: '2026-10-10T13:00:00Z',
        adults: 2,
        ratePlanCode: 'BAR',
        guest: {
          profileId: 'P9',
          firstName: 'Lina',
          lastName: 'Saad',
          language: 'ar-EG',
          email: 'lina@example.com',
        },
        sharers: [{ firstName: 'Omar' }],
      },
    });
    expect(created.ok && created.records[0]).toMatchObject({
      kind: 'RESERVATION_UPSERT',
      change: 'CREATED',
      adults: 2,
      rate_code: 'BAR',
      primary_guest: { external_id: 'P9', locale: 'ar' },
      accompanying_guests: [{ given_name: 'Omar' }],
    });
    const cancelled = parse({
      action: 'NOSHOW',
      modifiedAt: '2026-10-11T08:00:00Z',
      reservation: { reservationId: 'R9' },
    });
    expect(cancelled.ok && cancelled.records[0]).toMatchObject({
      kind: 'RESERVATION_CANCELLED',
      outcome: 'NO_SHOW',
    });
  });
});

describe('OPERA5_FIAS adapter', () => {
  const opera = (record: string, type = 'FIAS_RECORD') =>
    opera5FiasAdapter.parse(
      {
        message_type: type,
        source_message_id: 'x',
        sequence_no: 1,
        occurred_at: null,
        payload: { record },
      },
      ctx,
    );

  it('reads IFC8 records like the simulator does: a check-in with hotel wall-clock time', () => {
    const r = opera(
      'GI|RN504|G#88123|GNNile|GFAmira|GLAR|GA261003|GD261006|DA261003|TI140500|GS0|',
    );
    expect(r.ok && r.records).toEqual([
      expect.objectContaining({
        kind: 'CHECK_IN',
        reservation: expect.objectContaining({ external_id: '88123' }),
        room_code: '504',
        occurred_at: '2026-10-03T11:05:00.000Z',
        primary_guest: expect.objectContaining({
          given_name: 'Amira',
          family_name: 'Nile',
          locale: 'ar',
        }),
      }),
    ]);
  });

  it('a GI with the sync flag inside a database sync is a snapshot entry, never a check-in', () => {
    expect(opera('DS|DA261004|TI020000|')).toMatchObject({
      ok: true,
      records: [{ kind: 'SYNC_START' }],
    });
    const entry = opera('GI|RN505|G#88124|GNNile|GA261003|GD261006|SF|DA261004|TI020001|');
    expect(entry.ok && entry.records).toEqual([
      expect.objectContaining({
        kind: 'IN_HOUSE_ENTRY',
        reservation: expect.objectContaining({ external_id: '88124' }),
        room_code: '505',
      }),
    ]);
    expect(opera('DE|DA261004|TI020002|')).toMatchObject({
      ok: true,
      records: [{ kind: 'SYNC_END' }],
    });
  });

  it('link records produce nothing; OWS messages are not this connector’s', () => {
    expect(opera('LA|DA261004|TI020000|')).toEqual({ ok: true, records: [] });
    expect(opera('x', 'OWS_RESERVATION')).toEqual({
      ok: false,
      error: 'unsupported message type OWS_RESERVATION',
    });
  });

  it('night audit records of the standard profile are accepted and change nothing; unknown ids are refused', () => {
    expect(opera('NS|DA261004|TI000100|')).toEqual({ ok: true, records: [] });
    expect(opera('NE|DA261004|TI001500|')).toEqual({ ok: true, records: [] });
    expect(opera('ZZ|RN504|')).toEqual({ ok: false, error: 'unsupported record ZZ' });
  });

  it('observes the record id and field ids of every record, even one the parser refuses', () => {
    const observe = (record: string) =>
      opera5FiasAdapter.observe!({
        message_type: 'FIAS_RECORD',
        source_message_id: 'x',
        sequence_no: 1,
        occurred_at: null,
        payload: { record },
      });
    expect(observe('GI|RN504|GNNile|DA261004|')).toEqual({
      record: 'GI',
      fields: ['RN', 'GN', 'DA'],
    });
    expect(opera('GI|RN504|GNNile|DA261004|').ok).toBe(false);
    expect(observe('LA|DA261004|')).toBeNull();
    expect(observe('not fias')).toBeNull();
    expect(opera5FiasAdapter.manifest.profile?.code).toBe('PLANOVA_FIAS_STANDARD');
  });

  it('declares only predefined commands, room-status writes behind their own capability', () => {
    const m = opera5FiasAdapter.manifest;
    expect(m.commands.map((c) => [c.code, c.requires])).toEqual([
      ['RESYNC_IN_HOUSE', 'RECONCILIATION_READ'],
      ['SET_ROOM_STATUS', 'ROOM_STATUS_WRITE'],
    ]);
    expect(m.capabilities).not.toContain('RESERVATION_READ');
  });
});

describe('OPERA5_OWS adapter', () => {
  const ows = (message_type: string, payload: unknown) =>
    opera5OwsAdapter.parse(
      { message_type, source_message_id: 'x', sequence_no: 1, occurred_at: null, payload },
      ctx,
    );

  it('reads a polled future reservation with ETA and sharers, and its cancellation', () => {
    const upsert = ows('OWS_RESERVATION', {
      action: 'NEW',
      modifiedAt: '2026-10-04T09:00:00Z',
      reservation: {
        reservationId: '771234',
        confirmationNo: '99887766',
        arrivalDate: '2026-10-10',
        departureDate: '2026-10-13',
        expectedArrivalTime: '2026-10-10T14:30:00+03:00',
        adults: 2,
        guest: { profileId: 'P1', firstName: 'Amira', lastName: 'Nile', language: 'AR' },
        sharers: [{ firstName: 'Omar', lastName: 'Nile' }],
      },
    });
    expect(upsert.ok && upsert.records).toEqual([
      expect.objectContaining({
        kind: 'RESERVATION_UPSERT',
        change: 'CREATED',
        reservation: { external_id: '771234', confirmation_number: '99887766' },
        eta: '2026-10-10T14:30:00+03:00',
        primary_guest: expect.objectContaining({ external_id: 'P1', locale: 'ar' }),
        accompanying_guests: [expect.objectContaining({ given_name: 'Omar' })],
      }),
    ]);
    const cancel = ows('OWS_RESERVATION', {
      action: 'CANCEL',
      modifiedAt: '2026-10-05T09:00:00Z',
      reservation: { reservationId: '771234' },
    });
    expect(cancel.ok && cancel.records).toEqual([
      expect.objectContaining({ kind: 'RESERVATION_CANCELLED', outcome: 'CANCELLED' }),
    ]);
  });

  it('standard connector v1: the reads, one additive contact write, never a reservation write', () => {
    const m = opera5OwsAdapter.manifest;
    expect(m.queries?.map((q) => [q.code, q.requires])).toEqual([
      ['LOOKUP_RESERVATION', 'RESERVATION_LOOKUP'],
      ['LIST_ARRIVALS', 'ARRIVALS_READ'],
      ['LOOKUP_PROFILE', 'PROFILE_LOOKUP'],
    ]);
    expect(m.commands.map((c) => [c.code, c.requires])).toEqual([
      ['UPDATE_PROFILE_CONTACT', 'PROFILE_WRITE'],
    ]);
    expect(m.capabilities).not.toContain('RESERVATION_WRITE');
    const payload = m.commands[0]!.payload;
    expect(payload.safeParse({ profile_id: 'N1', email: 'guest@example.com' }).success).toBe(true);
    expect(payload.safeParse({ profile_id: 'N1' }).success).toBe(false);
    expect(payload.safeParse({ profile_id: 'N1', phone: 'call me' }).success).toBe(false);
  });

  it('FIAS records are not its messages', () => {
    expect(ows('FIAS_RECORD', { record: 'GI|' })).toEqual({
      ok: false,
      error: 'unsupported message type FIAS_RECORD',
    });
  });
});

describe('mapper', () => {
  const record = inboundRecordSchema.parse({
    kind: 'CHECK_IN',
    reservation: { external_id: 'R1' },
    primary_guest: { given_name: 'A', vip_code: 'GOLD' },
    arrival_date: '2026-10-03',
    departure_date: '2026-10-05',
    room_code: '504',
    rate_code: 'BAR',
    occurred_at: '2026-10-03T12:00:00Z',
  });
  it('lists every external code with its required flag', () => {
    expect(codesOf(record)).toEqual([
      { type: 'ROOM', code: '504', required: true },
      { type: 'RATE', code: 'BAR', required: false },
      { type: 'VIP', code: 'GOLD', required: false },
    ]);
  });
  it('builds the canonical payload from confirmed mappings only', () => {
    const roomId = '01920000-0000-7000-8000-0000000000aa';
    const draft = toCanonical(record as CanonicalRecord, '01920000-0000-7000-8000-0000000000bb', {
      get: (type, code) => (type === 'ROOM' && code === '504' ? roomId : undefined),
      roomNumber: () => '504',
    });
    expect(draft.definition.name).toBe('hotel.guest.checked_in.v1');
    const parsed = draft.definition.payload.parse(draft.payload) as {
      room: unknown;
      rate_code: unknown;
      primary_guest: { vip_code: unknown };
    };
    expect(parsed.room).toEqual({ room_id: roomId, room_number: '504' });
    expect(parsed.rate_code).toBeNull();
    expect(parsed.primary_guest.vip_code).toBeNull();
  });
});

describe('instance capabilities and health', () => {
  it('narrows enabled capabilities to what the agent reported, and only when active', () => {
    const i = {
      status: 'ACTIVE',
      enabledCapabilities: ['CHECKIN_EVENT', 'RESERVATION_READ'],
      reportedCapabilities: null,
    };
    expect(effectiveCapabilities(i)).toEqual(['CHECKIN_EVENT', 'RESERVATION_READ']);
    expect(effectiveCapabilities({ ...i, reportedCapabilities: ['CHECKIN_EVENT'] })).toEqual([
      'CHECKIN_EVENT',
    ]);
    expect(effectiveCapabilities({ ...i, status: 'PAUSED' })).toEqual([]);
  });
  it('classifies health deterministically', () => {
    const now = new Date('2026-10-03T12:00:00Z');
    const recent = new Date('2026-10-03T11:59:00Z');
    expect(
      classifyHealth({ now, agentLastSeenAt: null, lastSuccessAt: null, errorRatePermille: 0 }),
    ).toBe('OFFLINE');
    expect(
      classifyHealth({ now, agentLastSeenAt: recent, lastSuccessAt: null, errorRatePermille: 10 }),
    ).toBe('HEALTHY');
    expect(
      classifyHealth({ now, agentLastSeenAt: recent, lastSuccessAt: null, errorRatePermille: 200 }),
    ).toBe('DEGRADED');
    expect(
      classifyHealth({
        now,
        agentLastSeenAt: new Date('2026-10-03T11:50:00Z'),
        lastSuccessAt: null,
        errorRatePermille: 0,
      }),
    ).toBe('OFFLINE');
    expect(
      classifyHealth({
        now,
        agentLastSeenAt: recent,
        lastSuccessAt: null,
        errorRatePermille: 0,
        authFailed: true,
      }),
    ).toBe('AUTH_FAILED');
  });
  it('keeps a bounded rolling error rate', () => {
    let c = { recentTotal: 0, recentFailed: 0 };
    for (let i = 0; i < 1000; i++) c = recordOutcome(c, i % 10 === 0);
    expect(c.recentTotal).toBeLessThanOrEqual(HEALTH_WINDOW);
    const r = recordOutcome(c, false);
    expect(r.errorRatePermille).toBeGreaterThan(50);
    expect(r.errorRatePermille).toBeLessThan(150);
  });
});
