import { describe, expect, it } from 'vitest';
import { maskIdentifier, normalizeEmail, normalizePhone, sameName } from './identity';
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
