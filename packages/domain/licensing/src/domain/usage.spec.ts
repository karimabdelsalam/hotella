import { describe, expect, it } from 'vitest';
import { periodStart } from './usage';

describe('usage periods', () => {
  it('are UTC days and months', () => {
    const at = new Date('2026-10-31T23:30:00-03:00'); // 2026-11-01T02:30Z
    expect(periodStart('DAY', at).toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(periodStart('MONTH', at).toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(periodStart('MONTH', new Date('2026-10-04T12:00:00Z')).toISOString()).toBe(
      '2026-10-01T00:00:00.000Z',
    );
  });
});
