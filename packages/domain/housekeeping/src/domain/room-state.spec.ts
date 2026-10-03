import { describe, expect, it } from 'vitest';
import { conflictingSignals, fromPmsStatus, isStale, staffMoveAllowed } from './room-state';

describe('room operational state', () => {
  it('maps PMS statuses to housekeeping or front-office state', () => {
    expect(fromPmsStatus('DIRTY')).toEqual({ housekeeping: 'DIRTY', frontOffice: null });
    expect(fromPmsStatus('INSPECTED')).toEqual({ housekeeping: 'INSPECTED', frontOffice: null });
    expect(fromPmsStatus('OUT_OF_ORDER')).toEqual({
      housekeeping: null,
      frontOffice: 'OUT_OF_ORDER',
    });
    expect(fromPmsStatus('SOMETHING_NEW')).toEqual({ housekeeping: null, frontOffice: null });
  });

  it('lets staff move cleaning forward or send a room back, never to the same state', () => {
    expect(staffMoveAllowed('DIRTY', 'CLEAN')).toBe(true);
    expect(staffMoveAllowed('INSPECTED', 'DIRTY')).toBe(true);
    expect(staffMoveAllowed('INSPECTED', 'CLEAN')).toBe(false);
    expect(staffMoveAllowed('DIRTY', 'INSPECTED')).toBe(false);
    expect(staffMoveAllowed('CLEAN', 'CLEAN')).toBe(false);
  });

  it('ignores PMS events older than the last one applied', () => {
    const t = new Date('2026-10-03T10:00:00Z');
    expect(isStale(new Date('2026-10-03T09:59:59Z'), t)).toBe(true);
    expect(isStale(new Date('2026-10-03T10:00:00Z'), t)).toBe(false);
    expect(isStale(t, null)).toBe(false);
  });
});

describe('room signals', () => {
  it('privacy and service requests exclude each other', () => {
    expect(conflictingSignals('DND')).toEqual(['MAKE_UP_ROOM', 'SERVICE_REQUESTED']);
    expect(conflictingSignals('MAKE_UP_ROOM')).toEqual(['DND', 'PRIVACY']);
  });
});
