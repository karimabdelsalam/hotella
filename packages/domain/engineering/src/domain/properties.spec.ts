import { describe, expect, it } from 'vitest';
import {
  checkProperties,
  compatibleChange,
  type PropertyField,
  propertiesSchema,
} from './properties';

const FCU: PropertyField[] = propertiesSchema.parse([
  { key: 'capacity', type: 'NUMBER', unit: 'kW', min: 0, max: 100, required: true },
  { key: 'refrigerant', type: 'CHOICE', options: ['R32', 'R410A'] },
  { key: 'inverter', type: 'BOOLEAN' },
  { key: 'notes', type: 'TEXT', maxLength: 10 },
]);

describe('asset type properties', () => {
  it('accepts valid values and reports each problem by key', () => {
    expect(checkProperties(FCU, { capacity: 3.5, refrigerant: 'R32', inverter: true })).toEqual([]);
    expect(
      checkProperties(FCU, {
        capacity: 300,
        refrigerant: 'R22',
        inverter: 'yes',
        notes: 'far too long text',
        colour: 'red',
      }),
    ).toEqual([
      { key: 'colour', problem: 'UNKNOWN' },
      { key: 'capacity', problem: 'RANGE' },
      { key: 'refrigerant', problem: 'NOT_AN_OPTION' },
      { key: 'inverter', problem: 'TYPE' },
      { key: 'notes', problem: 'TOO_LONG' },
    ]);
    expect(checkProperties(FCU, {})).toEqual([{ key: 'capacity', problem: 'REQUIRED' }]);
  });

  it('refuses duplicate keys and keys that are not snake case', () => {
    expect(
      propertiesSchema.safeParse([
        { key: 'a', type: 'BOOLEAN' },
        { key: 'a', type: 'BOOLEAN' },
      ]).success,
    ).toBe(false);
    expect(propertiesSchema.safeParse([{ key: 'Capacity', type: 'BOOLEAN' }]).success).toBe(false);
  });

  it('a type may only change in ways that keep existing assets valid', () => {
    const added = [...FCU, propertiesSchema.parse([{ key: 'zone', type: 'TEXT' }])[0]!];
    expect(compatibleChange(FCU, added)).toBe(true);
    const required = [
      ...FCU,
      propertiesSchema.parse([{ key: 'zone', type: 'TEXT', required: true }])[0]!,
    ];
    expect(compatibleChange(FCU, required)).toBe(false);
    expect(compatibleChange(FCU, FCU.slice(1))).toBe(false);
    const narrowed = FCU.map((f) => (f.type === 'CHOICE' ? { ...f, options: ['R32'] } : f));
    expect(compatibleChange(FCU, narrowed)).toBe(false);
  });
});
