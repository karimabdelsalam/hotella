import { describe, expect, it } from 'vitest';
import {
  defaultPriority,
  downtimeMinutes,
  missingCoding,
  statusFor,
  underWarranty,
} from './work-orders';

const none = { symptomCode: null, failureModeCode: null, causeCode: null, resolutionCode: null };

describe('work order rules', () => {
  it('corrective and emergency work closes only when fully coded', () => {
    expect(missingCoding('CORRECTIVE', none)).toEqual([
      'symptomCode',
      'failureModeCode',
      'causeCode',
      'resolutionCode',
    ]);
    expect(
      missingCoding('EMERGENCY', { ...none, symptomCode: 'LEAKING', failureModeCode: 'PIPE_LEAK' }),
    ).toEqual(['causeCode', 'resolutionCode']);
    expect(missingCoding('PREVENTIVE', none)).toEqual([]);
  });

  it('downtime is whole minutes between start and end', () => {
    const start = new Date('2026-10-03T10:00:00Z');
    expect(downtimeMinutes(start, new Date('2026-10-03T11:29:40Z'))).toBe(90);
    expect(downtimeMinutes(start, null)).toBeNull();
    expect(downtimeMinutes(start, new Date('2026-10-03T09:00:00Z'))).toBe(0);
  });

  it('priorities follow type and source; status follows the work item and never reopens', () => {
    expect(defaultPriority('EMERGENCY', 'STAFF')).toBe('URGENT');
    expect(defaultPriority('CORRECTIVE', 'GUEST_REQUEST')).toBe('HIGH');
    expect(defaultPriority('PREVENTIVE', 'PM')).toBe('LOW');
    expect(statusFor('OPEN', 'IN_PROGRESS')).toBe('IN_PROGRESS');
    expect(statusFor('IN_PROGRESS', 'RESOLVED')).toBe('DONE');
    expect(statusFor('OPEN', 'OPEN')).toBeNull();
    expect(statusFor('DONE', 'OPEN')).toBeNull();
  });

  it('warranty covers the last day', () => {
    expect(underWarranty('2026-10-03', '2026-10-03')).toBe(true);
    expect(underWarranty('2026-10-02', '2026-10-03')).toBe(false);
    expect(underWarranty(null, '2026-10-03')).toBe(false);
  });
});
