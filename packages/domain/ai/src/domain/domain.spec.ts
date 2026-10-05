import { describe, expect, it } from 'vitest';
import { applyEgress, maskIdentifiers, mayReceive, speechAllowed } from './egress';
import { estimateCostMinor, pickRule } from './routing';

describe('egress policy', () => {
  const external = { egress: 'EXTERNAL', maxDataClass: 'CONFIDENTIAL' } as const;
  const onPrem = { egress: 'ON_PREM', maxDataClass: 'SENSITIVE' } as const;

  it('never sends RESTRICTED data and respects the provider maximum', () => {
    expect(mayReceive(onPrem, 'SENSITIVE')).toBe(true);
    expect(mayReceive(onPrem, 'RESTRICTED')).toBe(false);
    expect(mayReceive({ egress: 'ON_PREM', maxDataClass: 'RESTRICTED' }, 'RESTRICTED')).toBe(false);
    expect(mayReceive(external, 'SENSITIVE')).toBe(false);
    expect(mayReceive(external, 'CONFIDENTIAL')).toBe(true);
  });

  it('masks identifiers before they leave the installation; room numbers stay readable', () => {
    expect(maskIdentifiers('Call me on +20 100 111 2233 or mona@example.com, room 504')).toBe(
      'Call me on [phone] or [email], room 504',
    );
    expect(maskIdentifiers('card 4111 1111 1111 1111')).toBe('card [number]');
    // Record ids and dates are not personal identifiers: tools need the ids back exactly.
    const ids = Array.from(
      { length: 30 },
      (_, i) => `01900000-0000-7000-8000-${String(i).padStart(12, '0')}`,
    );
    expect(maskIdentifiers(`assets ${ids.join(', ')}`)).toBe(`assets ${ids.join(', ')}`);
    expect(
      maskIdentifiers(
        '{"asset_id":"01a1036d-df42-7dfd-ae92-30719b47dc9d","reported_at":"2026-10-03T10:00:00.000Z","on":"2026-10-21","phone":"+201001112233"}',
      ),
    ).toBe(
      '{"asset_id":"01a1036d-df42-7dfd-ae92-30719b47dc9d","reported_at":"2026-10-03T10:00:00.000Z","on":"2026-10-21","phone":"[phone]"}',
    );
    const out = applyEgress(external, [
      { text: 'Guest phone +201001112233', dataClass: 'CONFIDENTIAL' },
      { text: 'Passport A1234567', dataClass: 'SENSITIVE' },
      { text: 'Room 504, in house', dataClass: 'INTERNAL' },
    ]);
    expect(out).toEqual({ kept: ['Guest phone [phone]', 'Room 504, in house'], dropped: 1 });
    expect(
      applyEgress(onPrem, [{ text: 'Guest phone +201001112233', dataClass: 'CONFIDENTIAL' }]).kept,
    ).toEqual(['Guest phone +201001112233']);
  });
});

describe('guest speech egress (ADR-0025, Q22)', () => {
  it('stays on Planova-operated providers unless the hotel approved cloud speech', () => {
    expect(speechAllowed('ON_PREM', { enabled: false })).toBe(true);
    expect(speechAllowed('EXTERNAL', { enabled: false })).toBe(false);
    expect(speechAllowed('EXTERNAL', { enabled: true })).toBe(true);
  });
});

describe('routing and cost', () => {
  const rules = [
    { tenantId: null, propertyId: null, capability: 'REASONING_HIGH', modelIds: ['platform'] },
    { tenantId: 't1', propertyId: null, capability: 'REASONING_HIGH', modelIds: ['tenant'] },
    { tenantId: 't1', propertyId: 'p1', capability: 'REASONING_HIGH', modelIds: ['property'] },
  ];
  it('the most specific rule wins', () => {
    expect(
      pickRule(rules, 'REASONING_HIGH', { tenantId: 't1', propertyId: 'p1' })?.modelIds,
    ).toEqual(['property']);
    expect(
      pickRule(rules, 'REASONING_HIGH', { tenantId: 't1', propertyId: 'p2' })?.modelIds,
    ).toEqual(['tenant']);
    expect(
      pickRule(rules, 'REASONING_HIGH', { tenantId: 't2', propertyId: null })?.modelIds,
    ).toEqual(['platform']);
    expect(pickRule(rules, 'EMBEDDING', { tenantId: 't1', propertyId: 'p1' })).toBeNull();
  });
  it('estimates cost in minor units, rounding up', () => {
    const price = {
      inputPerMillionMinor: 300,
      outputPerMillionMinor: 1500,
      cachedPerMillionMinor: 30,
    };
    expect(estimateCostMinor({ input: 1_000_000, output: 0, cached: 0 }, price)).toBe(300);
    expect(estimateCostMinor({ input: 1200, output: 300, cached: 0 }, price)).toBe(1);
    expect(estimateCostMinor({ input: 0, output: 0, cached: 0 }, price)).toBe(0);
  });
});
