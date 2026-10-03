import { describe, expect, it } from 'vitest';
import {
  decideGrant,
  effectiveScopes,
  type GrantPolicy,
  grantOnStayStatus,
  GUEST_SESSION_TTL_MS,
  sessionExpiry,
} from './access';
import { maskIdentifier, normalizeEmail, normalizePhone, sameName } from './identity';
import { reconcileInHouse } from './reconcile';
import { type StayFacts, transition } from './stay-state';

const t = (iso: string) => new Date(`2026-10-0${iso}Z`);
const stay = (over: Partial<StayFacts> = {}): StayFacts => ({
  status: 'EXPECTED',
  actualCheckoutAt: null,
  cancelledAt: null,
  lastPmsEventAt: t('3T10:00:00'),
  ...over,
});

describe('stay state machine', () => {
  it('moves forward with PMS facts', () => {
    expect(transition(stay(), { kind: 'CHECKED_IN', at: t('3T12:00:00') }).status).toBe('IN_HOUSE');
    expect(
      transition(stay({ status: 'IN_HOUSE' }), { kind: 'CHECKED_OUT', at: t('5T09:00:00') }).status,
    ).toBe('CHECKED_OUT');
    expect(
      transition(stay(), { kind: 'CANCELLED', at: t('3T11:00:00'), outcome: 'NO_SHOW' }).status,
    ).toBe('NO_SHOW');
  });

  it('never moves backwards on late or duplicate facts', () => {
    const out = stay({
      status: 'CHECKED_OUT',
      actualCheckoutAt: t('5T09:00:00'),
      lastPmsEventAt: t('5T09:00:00'),
    });
    const late = transition(out, { kind: 'CHECKED_IN', at: t('3T12:00:00') });
    expect(late).toEqual({ status: 'CHECKED_OUT', applySnapshot: false, reinstated: false });
    expect(
      transition(stay({ status: 'IN_HOUSE' }), {
        kind: 'CANCELLED',
        at: t('4T00:00:00'),
        outcome: 'CANCELLED',
      }).status,
    ).toBe('IN_HOUSE');
    expect(
      transition(stay({ status: 'CHECKED_OUT' }), { kind: 'CHECKED_OUT', at: t('6T00:00:00') })
        .status,
    ).toBe('CHECKED_OUT');
  });

  it('honours PMS reinstatements that happen after the check-out or cancellation', () => {
    const out = stay({
      status: 'CHECKED_OUT',
      actualCheckoutAt: t('5T09:00:00'),
      lastPmsEventAt: t('5T09:00:00'),
    });
    expect(transition(out, { kind: 'CHECKED_IN', at: t('5T09:30:00') })).toEqual({
      status: 'IN_HOUSE',
      applySnapshot: true,
      reinstated: true,
    });
    const cancelled = stay({ status: 'CANCELLED', cancelledAt: t('3T11:00:00') });
    expect(transition(cancelled, { kind: 'RESERVATION', at: t('3T12:00:00') }).status).toBe(
      'EXPECTED',
    );
    expect(transition(cancelled, { kind: 'RESERVATION', at: t('3T10:30:00') }).status).toBe(
      'CANCELLED',
    );
  });
});

describe('guest identity helpers', () => {
  it('normalizes contacts and compares names within a party', () => {
    expect(normalizeEmail(' Amira.Nile@Example.COM ')).toBe('amira.nile@example.com');
    expect(normalizePhone('+20 100-123 4567')).toBe('+201001234567');
    expect(normalizePhone('0100 123')).toBe('0100123');
    expect(
      sameName(
        { givenName: 'AMIRA ', familyName: 'Nile' },
        { givenName: 'amira', familyName: 'nile' },
      ),
    ).toBe(true);
    expect(
      sameName(
        { givenName: 'Amira', familyName: null },
        { givenName: 'Amira', familyName: 'Nile' },
      ),
    ).toBe(false);
  });
  it('masks contact values for staff screens', () => {
    expect(maskIdentifier('EMAIL', 'amira@example.com')).toBe('a***@example.com');
    expect(maskIdentifier('PHONE', '+201001234567')).toBe('+20********67');
    expect(maskIdentifier('LOYALTY', '123')).toBe('***');
  });
});

describe('in-house reconciliation', () => {
  it('classifies every reservation deterministically', () => {
    const stay = (
      stayId: string,
      externalId: string | null,
      status: string,
      roomId: string | null,
    ) => ({
      stayId,
      externalId,
      status,
      roomId,
    });
    const known = new Map([
      ['A', stay('s-a', 'A', 'IN_HOUSE', 'r1')],
      ['B', stay('s-b', 'B', 'IN_HOUSE', 'r2')],
      ['E', stay('s-e', 'E', 'CHECKED_OUT', null)],
    ]);
    const findings = reconcileInHouse(
      [
        { externalId: 'A', roomId: 'r1', roomCode: '101' },
        { externalId: 'B', roomId: 'r3', roomCode: '103' },
        { externalId: 'D', roomId: null, roomCode: '999' },
        { externalId: 'E', roomId: 'r5', roomCode: '105' },
      ],
      known,
      [known.get('A')!, known.get('B')!, stay('s-c', 'C', 'IN_HOUSE', 'r4')],
    );
    expect(findings.map((f) => [f.externalId, f.outcome])).toEqual([
      ['A', 'MATCH'],
      ['B', 'DIFFERENT'],
      ['D', 'MISSING_INTERNAL'],
      ['E', 'DIFFERENT'],
      ['C', 'MISSING_EXTERNAL'],
    ]);
    expect(findings[1]!.details).toMatchObject({
      field: 'room',
      pms_room_id: 'r3',
      platform_room_id: 'r2',
    });
    expect(findings[3]!.details).toMatchObject({ field: 'status', platform: 'CHECKED_OUT' });
  });
});

describe('guest access policy (Spec §21)', () => {
  const policy: GrantPolicy = {
    inStayScopes: [
      'SERVICE_REQUEST',
      'CHAT',
      'ROOM_CONTROL',
      'VIEW_BILL',
      'LOST_FOUND',
      'FEEDBACK',
    ],
    companionScopes: ['SERVICE_REQUEST', 'CHAT', 'ROOM_CONTROL', 'LOST_FOUND'],
    preArrivalScopes: ['CHAT', 'SERVICE_REQUEST'],
    postStayScopes: ['LOST_FOUND', 'FEEDBACK', 'INVOICE'],
    postStayHours: 72,
  };
  const t = new Date('2026-10-06T09:00:00Z');

  it('grants by stay state and party role; ended stays and strangers get nothing', () => {
    const base = { expectedDeparture: '2026-10-06', policy };
    expect(decideGrant({ ...base, status: 'EXPECTED', partyRole: 'PRIMARY' })).toEqual({
      kind: 'GRANT',
      scopes: ['SERVICE_REQUEST', 'CHAT'],
      validUntil: new Date('2026-10-13T00:00:00Z'),
    });
    expect(decideGrant({ ...base, status: 'IN_HOUSE', partyRole: 'ACCOMPANYING' })).toMatchObject({
      scopes: ['SERVICE_REQUEST', 'CHAT', 'ROOM_CONTROL', 'LOST_FOUND'],
    });
    for (const status of ['CHECKED_OUT', 'CANCELLED', 'NO_SHOW'] as const)
      expect(decideGrant({ ...base, status, partyRole: 'PRIMARY' })).toEqual({
        kind: 'REFUSE',
        reason: 'STAY_NOT_ACTIVE',
      });
    expect(decideGrant({ ...base, status: 'IN_HOUSE', partyRole: null })).toEqual({
      kind: 'REFUSE',
      reason: 'NOT_IN_PARTY',
    });
  });

  it('follows the stay: widen on arrival, keep post-stay scopes for the window, revoke otherwise', () => {
    const grant = {
      scopes: ['SERVICE_REQUEST', 'CHAT'],
      validUntil: new Date('2026-10-13T00:00:00Z'),
      partyRole: 'PRIMARY' as const,
    };
    expect(grantOnStayStatus(grant, 'IN_HOUSE', t, policy)).toMatchObject({
      kind: 'WIDENED',
      scopes: ['SERVICE_REQUEST', 'CHAT', 'ROOM_CONTROL', 'VIEW_BILL', 'LOST_FOUND', 'FEEDBACK'],
    });
    const inStay = { ...grant, scopes: [...policy.inStayScopes] };
    expect(grantOnStayStatus(inStay, 'IN_HOUSE', t, policy)).toBeNull();
    expect(grantOnStayStatus(inStay, 'CHECKED_OUT', t, policy)).toEqual({
      kind: 'NARROWED',
      scopes: ['LOST_FOUND', 'FEEDBACK'],
      validUntil: new Date('2026-10-09T09:00:00Z'),
      reason: 'CHECKOUT',
    });
    // The window never extends a grant; no post-stay scope or no window means revocation.
    const short = { ...inStay, validUntil: new Date('2026-10-07T00:00:00Z') };
    expect(grantOnStayStatus(short, 'CHECKED_OUT', t, policy)).toMatchObject({
      validUntil: new Date('2026-10-07T00:00:00Z'),
    });
    expect(grantOnStayStatus(grant, 'CHECKED_OUT', t, policy)).toEqual({
      kind: 'REVOKED',
      reason: 'CHECKOUT',
    });
    expect(grantOnStayStatus(inStay, 'CHECKED_OUT', t, { ...policy, postStayHours: 0 })).toEqual({
      kind: 'REVOKED',
      reason: 'CHECKOUT',
    });
    expect(grantOnStayStatus(grant, 'CANCELLED', t, policy)).toEqual({
      kind: 'REVOKED',
      reason: 'STAY_CANCELLED',
    });
    expect(grantOnStayStatus(grant, 'NO_SHOW', t, policy)).toMatchObject({ kind: 'REVOKED' });
    expect(grantOnStayStatus(grant, 'EXPECTED', t, policy)).toBeNull();
  });

  it('usable scopes depend on revocation and the validity window; sessions never outlive the grant', () => {
    const g = {
      scopes: ['CHAT', 'BOGUS'],
      validFrom: new Date('2026-10-01T00:00:00Z'),
      validUntil: new Date('2026-10-06T00:00:00Z'),
      revokedAt: null,
    };
    expect(effectiveScopes(g, new Date('2026-10-03T00:00:00Z'))).toEqual(['CHAT']);
    expect(effectiveScopes(g, new Date('2026-10-06T00:00:00Z'))).toEqual([]);
    expect(effectiveScopes(g, new Date('2026-09-30T00:00:00Z'))).toEqual([]);
    expect(effectiveScopes({ ...g, revokedAt: t }, new Date('2026-10-03T00:00:00Z'))).toEqual([]);
    expect(sessionExpiry(new Date('2026-10-01T00:00:00Z'), g.validUntil)).toEqual(
      new Date('2026-10-06T00:00:00Z'),
    );
    expect(sessionExpiry(new Date('2026-09-01T00:00:00Z'), g.validUntil).getTime()).toBe(
      new Date('2026-09-01T00:00:00Z').getTime() + GUEST_SESSION_TTL_MS,
    );
  });
});
