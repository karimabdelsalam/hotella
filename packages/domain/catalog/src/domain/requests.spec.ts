import { describe, expect, it } from 'vitest';
import { canCancel, isTerminal, statusForWorkItem } from './requests';

describe('service request status', () => {
  it('follows the work item', () => {
    expect(statusForWorkItem('OPEN')).toBe('OPEN');
    expect(statusForWorkItem('IN_PROGRESS')).toBe('IN_PROGRESS');
    expect(statusForWorkItem('RESOLVED')).toBe('COMPLETED');
    expect(statusForWorkItem('CANCELLED')).toBe('CANCELLED');
  });

  it('guests cancel only what nobody started; staff until it is done', () => {
    expect(canCancel('OPEN', 'GUEST')).toBe(true);
    expect(canCancel('IN_PROGRESS', 'GUEST')).toBe(false);
    expect(canCancel('IN_PROGRESS', 'STAFF')).toBe(true);
    for (const done of ['COMPLETED', 'CANCELLED'] as const) {
      expect(isTerminal(done)).toBe(true);
      expect(canCancel(done, 'STAFF')).toBe(false);
    }
  });
});
