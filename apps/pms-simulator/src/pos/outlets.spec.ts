import { describe, expect, it } from 'vitest';
import { posStandardAdapter } from '@hotella/domain-integrations';
import { SimulatedPos } from './outlets';

describe('SimulatedPos', () => {
  it('produces checks the POS_STANDARD connector accepts, reproducibly and without card data', () => {
    const evening = new SimulatedPos().evening(['214', '215'], 6, new Date('2026-10-05T22:00:00Z'));
    expect(evening).toEqual(
      new SimulatedPos().evening(['214', '215'], 6, new Date('2026-10-05T22:00:00Z')),
    );
    for (const m of evening) {
      const parsed = posStandardAdapter.parse(
        { ...m, sequence_no: null, occurred_at: null },
        { timezone: 'Africa/Cairo', receivedAt: '2026-10-05T22:00:00Z' },
      );
      expect(parsed.ok).toBe(true);
      expect(m.payload.settlement === 'ROOM_CHARGE').toBe(m.payload.room !== null);
    }
    expect(evening.filter((m) => m.payload.room === null)).toHaveLength(2);
  });
});
