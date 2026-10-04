import { describe, expect, it } from 'vitest';
import {
  type CapabilityFacts,
  ineffectiveReasons,
  overrideProblem,
  PMS_OPERATIONS,
  route,
  type RouteCandidate,
  statusFromHealth,
} from './capabilities';

const facts = (over: Partial<CapabilityFacts> = {}): CapabilityFacts => ({
  instanceId: 'i1',
  connectorCode: 'OPERA5_FIAS',
  instanceActive: true,
  supported: true,
  enabled: true,
  reported: true,
  licensed: true,
  verified: true,
  commissioned: true,
  status: 'AVAILABLE',
  ...over,
});
const candidate = (connectorCode: string, over: Partial<RouteCandidate> = {}): RouteCandidate => ({
  instanceId: `i-${connectorCode}`,
  connectorCode,
  readOnly: connectorCode === 'OPERA5_DB',
  reasons: [],
  status: 'AVAILABLE',
  ...over,
});
const codes = (d: ReturnType<typeof route>) => d.route.map((r) => r.connectorCode);

describe('effective capability (guide §5.3)', () => {
  it('needs every fact', () => {
    expect(ineffectiveReasons('ROOM_STATUS_WRITE', facts())).toEqual([]);
    expect(
      ineffectiveReasons(
        'ROOM_STATUS_WRITE',
        facts({
          instanceActive: false,
          supported: false,
          enabled: false,
          reported: false,
          licensed: false,
          verified: false,
          status: 'UNAVAILABLE',
        }),
      ),
    ).toEqual([
      'INSTANCE_INACTIVE',
      'NOT_SUPPORTED',
      'NOT_ENABLED',
      'NOT_REPORTED',
      'NOT_LICENSED',
      'NOT_VERIFIED',
      'UNAVAILABLE',
    ]);
  });

  it('runs reads and events unverified only while the instance is in commissioning; writes never', () => {
    const commissioning = facts({ verified: false, commissioned: false });
    expect(ineffectiveReasons('ARRIVALS_READ', commissioning)).toEqual([]);
    expect(ineffectiveReasons('CHECKIN_EVENT', commissioning)).toEqual([]);
    expect(ineffectiveReasons('ROOM_STATUS_WRITE', commissioning)).toEqual(['NOT_VERIFIED']);
    const signedOff = facts({ verified: false, commissioned: true });
    expect(ineffectiveReasons('ARRIVALS_READ', signedOff)).toEqual(['NOT_VERIFIED']);
  });

  it('treats an agent that has not reported yet as not narrowing, and a degraded link as still serving', () => {
    expect(ineffectiveReasons('CHECKIN_EVENT', facts({ reported: null }))).toEqual([]);
    expect(ineffectiveReasons('CHECKIN_EVENT', facts({ status: 'DEGRADED' }))).toEqual([]);
    expect(statusFromHealth('HEALTHY')).toBe('AVAILABLE');
    expect(statusFromHealth('OFFLINE')).toBe('DEGRADED');
    expect(statusFromHealth('DEGRADED')).toBe('DEGRADED');
    expect(statusFromHealth('AUTH_FAILED')).toBe('UNAVAILABLE');
    expect(statusFromHealth('MISCONFIGURED')).toBe('UNAVAILABLE');
  });
});

describe('routing (guide §4.3)', () => {
  it('never lists the database as a write target', () => {
    for (const op of Object.values(PMS_OPERATIONS))
      if (op.kind === 'write') expect(op.connectors).not.toContain('OPERA5_DB');
  });

  it('follows the preference order and keeps only effective connectors', () => {
    const all = [candidate('OPERA5_OWS'), candidate('OPERA5_FIAS'), candidate('OPERA5_DB')];
    expect(codes(route('LIST_ARRIVALS', all))).toEqual(['OPERA5_DB', 'OPERA5_OWS']);
    expect(codes(route('IN_HOUSE_SNAPSHOT', all))).toEqual([
      'OPERA5_DB',
      'OPERA5_FIAS',
      'OPERA5_OWS',
    ]);
    expect(codes(route('SET_ROOM_STATUS', all))).toEqual(['OPERA5_FIAS', 'OPERA5_OWS']);
    const unverifiedFias = [
      candidate('OPERA5_FIAS', { reasons: ['NOT_VERIFIED'] }),
      candidate('OPERA5_OWS'),
    ];
    const decision = route('SET_ROOM_STATUS', unverifiedFias);
    expect(codes(decision)).toEqual(['OPERA5_OWS']);
    expect(decision.skipped).toEqual([
      { instanceId: 'i-OPERA5_FIAS', connectorCode: 'OPERA5_FIAS', reasons: ['NOT_VERIFIED'] },
    ]);
  });

  it('refuses a read-only connector for a write even when it claims the capability', () => {
    const decision = route('SET_ROOM_STATUS', [candidate('OPERA5_DB')]);
    expect(decision.route).toEqual([]);
    expect(decision.skipped[0]!.reasons).toEqual(['READ_ONLY']);
  });

  it('tries available connectors before degraded ones for reads, but not for writes', () => {
    const list = [candidate('OPERA5_DB', { status: 'DEGRADED' }), candidate('OPERA5_OWS')];
    expect(codes(route('LIST_ARRIVALS', list))).toEqual(['OPERA5_OWS', 'OPERA5_DB']);
    const writes = [candidate('OPERA5_FIAS', { status: 'DEGRADED' }), candidate('OPERA5_OWS')];
    expect(codes(route('SET_ROOM_STATUS', writes))).toEqual(['OPERA5_FIAS', 'OPERA5_OWS']);
  });

  it('applies a property override within the allowed connectors', () => {
    const all = [candidate('OPERA5_DB'), candidate('OPERA5_OWS')];
    expect(codes(route('LIST_ARRIVALS', all, ['OPERA5_OWS', 'OPERA5_DB']))).toEqual([
      'OPERA5_OWS',
      'OPERA5_DB',
    ]);
    expect(codes(route('LIST_ARRIVALS', all, ['OPERA5_OWS']))).toEqual(['OPERA5_OWS']);
    const readOnly = (c: string) => c === 'OPERA5_DB';
    expect(overrideProblem('LIST_ARRIVALS', ['OPERA5_OWS', 'OPERA5_DB'], readOnly)).toBeNull();
    expect(overrideProblem('LIST_ARRIVALS', [], readOnly)).toBe('EMPTY');
    expect(overrideProblem('LIST_ARRIVALS', ['OPERA5_OWS', 'OPERA5_OWS'], readOnly)).toBe(
      'DUPLICATE',
    );
    expect(overrideProblem('LIST_ARRIVALS', ['OPERA5_FIAS'], readOnly)).toBe('NOT_ALLOWED');
    expect(overrideProblem('SET_ROOM_STATUS', ['OPERA5_DB'], readOnly)).toBe(
      'READ_ONLY_WRITE_TARGET',
    );
  });

  it('serves hotels A, B and C of the guide with the same table (guide §5.4)', () => {
    const hotelA = [candidate('OPERA5_DB'), candidate('OPERA5_FIAS')];
    const hotelB = [candidate('OPERA5_DB'), candidate('OPERA5_FIAS'), candidate('OPERA5_OWS')];
    const hotelC = [candidate('OPERA5_FIAS'), candidate('OPERA5_OWS')];
    expect([hotelA, hotelB, hotelC].map((h) => codes(route('LIST_ARRIVALS', h)))).toEqual([
      ['OPERA5_DB'],
      ['OPERA5_DB', 'OPERA5_OWS'],
      ['OPERA5_OWS'],
    ]);
    expect([hotelA, hotelB, hotelC].map((h) => codes(route('SET_ROOM_STATUS', h))[0])).toEqual([
      'OPERA5_FIAS',
      'OPERA5_FIAS',
      'OPERA5_FIAS',
    ]);
    expect([hotelA, hotelB, hotelC].map((h) => codes(route('UPDATE_PROFILE_CONTACT', h)))).toEqual([
      [],
      ['OPERA5_OWS'],
      ['OPERA5_OWS'],
    ]);
  });
});
