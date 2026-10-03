import { describe, expect, it } from 'vitest';
import {
  availabilityProblem,
  availabilitySchema,
  eligibilityProblem,
  eligibilitySchema,
  FieldError,
  freeTextFieldCodes,
  isOpenAt,
  pickTranslation,
  requiredFieldsSchema,
  validateFields,
} from './rules';

const fields = requiredFieldsSchema.parse([
  { code: 'quantity', type: 'NUMBER', required: true, min: 1, max: 6 },
  { code: 'issue', type: 'CHOICE', required: true, options: ['TOO_HOT', 'TOO_COLD'] },
  { code: 'pickup_at', type: 'DATETIME' },
  { code: 'urgent', type: 'BOOLEAN' },
  { code: 'notes', type: 'TEXT', maxLength: 20 },
]);

describe('service fields', () => {
  it('accepts and normalizes valid values', () => {
    expect(
      validateFields(fields, {
        quantity: 2,
        issue: 'TOO_HOT',
        pickup_at: '2026-10-03T18:00:00+03:00',
        urgent: false,
        notes: '  near the window  ',
      }),
    ).toEqual({
      quantity: 2,
      issue: 'TOO_HOT',
      pickup_at: '2026-10-03T15:00:00.000Z',
      urgent: false,
      notes: 'near the window',
    });
    expect(validateFields(fields, { quantity: 1, issue: 'TOO_COLD', notes: '   ' })).toEqual({
      quantity: 1,
      issue: 'TOO_COLD',
    });
  });

  it('refuses missing, invalid and unknown values with the field named', () => {
    const fail = (values: Record<string, unknown>) => {
      try {
        validateFields(fields, values);
      } catch (e) {
        return e instanceof FieldError ? `${e.field}:${e.problem}` : 'other';
      }
      return 'ok';
    };
    expect(fail({ issue: 'TOO_HOT' })).toBe('quantity:required');
    expect(fail({ quantity: 7, issue: 'TOO_HOT' })).toBe('quantity:invalid');
    expect(fail({ quantity: 1.5, issue: 'TOO_HOT' })).toBe('quantity:invalid');
    expect(fail({ quantity: '2', issue: 'TOO_HOT' })).toBe('quantity:invalid');
    expect(fail({ quantity: 1, issue: 'WARM' })).toBe('issue:invalid');
    expect(fail({ quantity: 1, issue: 'TOO_HOT', pickup_at: '2026-10-03 18:00' })).toBe(
      'pickup_at:invalid',
    );
    expect(fail({ quantity: 1, issue: 'TOO_HOT', urgent: 'yes' })).toBe('urgent:invalid');
    expect(fail({ quantity: 1, issue: 'TOO_HOT', notes: 'x'.repeat(21) })).toBe('notes:invalid');
    expect(fail({ quantity: 1, issue: 'TOO_HOT', colour: 'red' })).toBe('colour:unknown');
  });

  it('knows which fields hold the guest’s own words', () => {
    expect(freeTextFieldCodes(fields)).toEqual(['notes']);
  });

  it('rejects duplicate field codes in a definition', () => {
    expect(
      requiredFieldsSchema.safeParse([
        { code: 'a', type: 'BOOLEAN' },
        { code: 'a', type: 'TEXT' },
      ]).success,
    ).toBe(false);
  });
});

describe('eligibility', () => {
  const rules = eligibilitySchema.parse({});
  const guest = { stayStatus: 'IN_HOUSE', partyRole: 'ACCOMPANYING', roomTypeId: null } as const;

  it('defaults to in-house guests of any party role and room type', () => {
    expect(eligibilityProblem(rules, guest)).toBeNull();
    expect(eligibilityProblem(rules, { ...guest, stayStatus: 'EXPECTED' })).toBe(
      'stay_not_eligible',
    );
  });

  it('narrows by party role and room type', () => {
    const primaryOnly = eligibilitySchema.parse({ partyRoles: ['PRIMARY'] });
    expect(eligibilityProblem(primaryOnly, guest)).toBe('guest_not_eligible');
    expect(eligibilityProblem(primaryOnly, { ...guest, partyRole: 'PRIMARY' })).toBeNull();
    const suites = eligibilitySchema.parse({
      roomTypeIds: ['0199a000-0000-7000-8000-000000000001'],
    });
    expect(eligibilityProblem(suites, guest)).toBe('room_not_eligible');
    expect(
      eligibilityProblem(suites, { ...guest, roomTypeId: '0199a000-0000-7000-8000-000000000001' }),
    ).toBeNull();
  });
});

describe('availability (property time zone)', () => {
  // Saturday 2026-10-03 09:30 in Cairo (UTC+3).
  const saturdayMorning = new Date('2026-10-03T06:30:00Z');
  const breakfast = availabilitySchema.parse({
    hours: [{ days: [6, 0], from: '07:00', to: '10:00' }],
  });

  it('opening hours are read in the property time zone', () => {
    expect(isOpenAt(breakfast, saturdayMorning, 'Africa/Cairo')).toBe(true);
    // The same instant is 06:30 in UTC: before opening.
    expect(isOpenAt(breakfast, saturdayMorning, 'UTC')).toBe(false);
    expect(isOpenAt(breakfast, new Date('2026-10-05T06:30:00Z'), 'Africa/Cairo')).toBe(false);
    expect(isOpenAt(availabilitySchema.parse({}), saturdayMorning, 'Africa/Cairo')).toBe(true);
  });

  it('scheduling, lead time, closing and the daily cap are deterministic', () => {
    const at = (h: number) => new Date(saturdayMorning.getTime() + h * 3_600_000);
    const input = { now: saturdayMorning, timeZone: 'Africa/Cairo', sameDayCount: 0 };
    expect(availabilityProblem(breakfast, { ...input, requestedFor: null })).toBeNull();
    expect(availabilityProblem(breakfast, { ...input, requestedFor: at(0.25) })).toBe(
      'scheduling_not_allowed',
    );
    const scheduled = availabilitySchema.parse({
      hours: [{ days: [6], from: '07:00', to: '10:00' }],
      allowScheduling: true,
      leadTimeMinutes: 20,
      maxPerStayPerDay: 2,
    });
    expect(availabilityProblem(scheduled, { ...input, requestedFor: at(0.25) })).toBe('lead_time');
    expect(availabilityProblem(scheduled, { ...input, requestedFor: at(0.4) })).toBeNull();
    expect(availabilityProblem(scheduled, { ...input, requestedFor: at(1) })).toBe('closed');
    expect(availabilityProblem(scheduled, { ...input, requestedFor: null, sameDayCount: 2 })).toBe(
      'daily_limit',
    );
  });

  it('refuses malformed hours', () => {
    expect(
      availabilitySchema.safeParse({ hours: [{ days: [1], from: '10:00', to: '09:00' }] }).success,
    ).toBe(false);
    expect(
      availabilitySchema.safeParse({ hours: [{ days: [7], from: '09:00', to: '10:00' }] }).success,
    ).toBe(false);
  });
});

describe('translation fallback', () => {
  const rows = [
    { locale: 'en', name: 'Extra towels' },
    { locale: 'ar', name: 'مناشف إضافية' },
    { locale: 'fr', name: 'Serviettes' },
  ];
  it('request locale, its language, the property default, then English', () => {
    expect(pickTranslation(rows, 'ar', 'en')?.name).toBe('مناشف إضافية');
    expect(pickTranslation(rows, 'ar-EG', 'en')?.name).toBe('مناشف إضافية');
    expect(pickTranslation(rows, 'de', 'fr')?.name).toBe('Serviettes');
    expect(pickTranslation(rows, 'de', 'it')?.name).toBe('Extra towels');
    expect(pickTranslation([{ locale: 'it', name: 'x' }], 'de', 'fr')).toBeUndefined();
  });
});
