import { describe, expect, it } from 'vitest';
import { canMove, needsAmount, recoveryApproval } from './complaints';

describe('complaint rules', () => {
  it('moves through its lifecycle; closed is final; resolved can be reopened', () => {
    expect(canMove('OPEN', 'IN_PROGRESS')).toBe(true);
    expect(canMove('OPEN', 'RESOLVED')).toBe(true);
    expect(canMove('OPEN', 'CLOSED')).toBe(false);
    expect(canMove('RESOLVED', 'IN_PROGRESS')).toBe(true);
    expect(canMove('RESOLVED', 'CLOSED')).toBe(true);
    expect(canMove('CLOSED', 'IN_PROGRESS')).toBe(false);
  });

  it('asks for an approval only when recovery costs money, riskier above the threshold', () => {
    expect(recoveryApproval('APOLOGY', null, 50_000)).toEqual({ required: false });
    expect(recoveryApproval('ROOM_MOVE', null, 50_000)).toEqual({ required: false });
    expect(recoveryApproval('MEAL', 20_000, 50_000)).toEqual({ required: true, risk: 'MEDIUM' });
    expect(recoveryApproval('REFUND', 50_000, 50_000)).toEqual({ required: true, risk: 'HIGH' });
    expect(needsAmount('DISCOUNT')).toBe(true);
    expect(needsAmount('MEAL')).toBe(false);
  });
});
