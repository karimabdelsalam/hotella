import { describe, expect, it } from 'vitest';
import { jobStatusFor, localDay, localHour, resolveCredits } from './jobs';

describe('cleaning credits', () => {
  const rules = [
    { cleaningType: 'CHECKOUT' as const, roomTypeId: null, credits: 1.2 },
    { cleaningType: 'CHECKOUT' as const, roomTypeId: 'suite', credits: 1.8 },
  ];
  it('prefers the room type rule, then the type rule, then the platform default', () => {
    expect(resolveCredits(rules, 'CHECKOUT', 'suite')).toBe(1.8);
    expect(resolveCredits(rules, 'CHECKOUT', 'standard')).toBe(1.2);
    expect(resolveCredits(rules, 'CHECKOUT', null)).toBe(1.2);
    expect(resolveCredits(rules, 'STAYOVER', 'suite')).toBe(0.7);
    expect(resolveCredits([], 'TURNDOWN', null)).toBe(0.4);
  });
});

describe('a job follows its work item', () => {
  it('starts, finishes or is cancelled with it, and never reopens', () => {
    expect(jobStatusFor('OPEN', 'IN_PROGRESS')).toBe('IN_PROGRESS');
    expect(jobStatusFor('IN_PROGRESS', 'RESOLVED')).toBe('DONE');
    expect(jobStatusFor('OPEN', 'RESOLVED')).toBe('DONE');
    expect(jobStatusFor('OPEN', 'CANCELLED')).toBe('CANCELLED');
    expect(jobStatusFor('DONE', 'IN_PROGRESS')).toBeNull();
    expect(jobStatusFor('INSPECTED', 'CANCELLED')).toBeNull();
    expect(jobStatusFor('IN_PROGRESS', 'IN_PROGRESS')).toBeNull();
  });
});

describe('property-local time', () => {
  it('gives the local day and hour', () => {
    const at = new Date('2026-10-03T22:30:00Z');
    expect(localDay(at, 'Africa/Cairo')).toBe('2026-10-04');
    expect(localHour(at, 'Africa/Cairo')).toBe(1);
    expect(localDay(at, 'UTC')).toBe('2026-10-03');
  });
});
