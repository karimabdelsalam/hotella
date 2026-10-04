import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import {
  ConnectorDefinitionError,
  defineConnector,
  inboundRecordSchema,
  orderingKeyOf,
  localDateTimeToUtc,
  parsedRecords,
} from './index';

const base = {
  code: 'TEST_PMS',
  version: 1,
  category: 'PMS' as const,
  description: 'test',
  capabilities: ['CHECKIN_EVENT', 'CHECKOUT_EVENT'] as const,
  messageTypes: [{ code: 'EVENT', description: 'x', requires: 'CHECKIN_EVENT' as const }],
  commands: [],
  configSchema: z.object({}),
  credentialSchema: z.object({}),
};

describe('defineConnector', () => {
  it('accepts a consistent manifest', () => {
    expect(defineConnector({ ...base }).code).toBe('TEST_PMS');
  });
  it('rejects message types or commands needing undeclared capabilities, and bad codes', () => {
    expect(() =>
      defineConnector({
        ...base,
        messageTypes: [{ code: 'EVENT', description: 'x', requires: 'RESERVATION_READ' }],
      }),
    ).toThrow(ConnectorDefinitionError);
    expect(() =>
      defineConnector({
        ...base,
        commands: [
          { code: 'SET_OOO', description: 'x', requires: 'OOO_WRITE', payload: z.object({}) },
        ],
      }),
    ).toThrow(ConnectorDefinitionError);
    expect(() => defineConnector({ ...base, code: 'bad-code' })).toThrow(ConnectorDefinitionError);
  });
  it('a read-only connector can declare no write capability and no command (ADR-0019)', () => {
    const readOnly = {
      ...base,
      readOnly: true,
      capabilities: ['CHECKIN_EVENT', 'ARRIVALS_READ'] as const,
    };
    expect(defineConnector(readOnly).readOnly).toBe(true);
    expect(() =>
      defineConnector({ ...readOnly, capabilities: ['CHECKIN_EVENT', 'ROOM_STATUS_WRITE'] }),
    ).toThrow(/read-only/);
    expect(() =>
      defineConnector({
        ...readOnly,
        commands: [
          { code: 'RESYNC', description: 'x', requires: 'CHECKIN_EVENT', payload: z.object({}) },
        ],
      }),
    ).toThrow(/read-only/);
  });
});

describe('inbound records', () => {
  const checkIn = {
    kind: 'CHECK_IN',
    reservation: { external_id: 'R1' },
    primary_guest: { given_name: 'Jane' },
    arrival_date: '2026-10-03',
    departure_date: '2026-10-06',
    room_code: '504',
    occurred_at: '2026-10-03T12:00:00Z',
  };
  it('fills SDK defaults and derives ordering keys', () => {
    const r = inboundRecordSchema.parse(checkIn);
    expect(r.kind === 'CHECK_IN' && r.adults).toBe(1);
    expect(orderingKeyOf(r)).toBe('reservation:R1');
    expect(
      orderingKeyOf(
        inboundRecordSchema.parse({
          kind: 'ROOM_STATUS',
          room_code: '504',
          status: 'DIRTY',
          occurred_at: '2026-10-03T12:00:00Z',
        }),
      ),
    ).toBe('room:504');
  });
  it('turns a malformed adapter record into a parse error', () => {
    const r = parsedRecords([{ ...checkIn, room_code: '' }]);
    expect(r.ok).toBe(false);
    expect(parsedRecords([checkIn]).ok).toBe(true);
  });
});

describe('localDateTimeToUtc', () => {
  it('converts hotel wall-clock time to UTC', () => {
    const p = { year: 2026, month: 1, day: 15, hour: 14, minute: 30 };
    expect(localDateTimeToUtc(p, 'UTC').toISOString()).toBe('2026-01-15T14:30:00.000Z');
    expect(localDateTimeToUtc(p, 'Africa/Cairo').toISOString()).toBe('2026-01-15T12:30:00.000Z');
    expect(localDateTimeToUtc(p, 'Asia/Dubai').toISOString()).toBe('2026-01-15T10:30:00.000Z');
    // Summer time (Europe/Berlin is UTC+2 in July).
    expect(
      localDateTimeToUtc({ year: 2026, month: 7, day: 1, hour: 9 }, 'Europe/Berlin').toISOString(),
    ).toBe('2026-07-01T07:00:00.000Z');
  });
});
