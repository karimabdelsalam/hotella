import { describe, expect, it } from 'vitest';
import { type ArrivalRiskInput, assessArrival } from './arrival-risk';

const ready: ArrivalRiskInput = {
  roomAssigned: true,
  housekeeping: 'INSPECTED',
  occupied: false,
  ready: true,
  restricted: false,
  openEngineeringWork: 0,
  urgentEngineeringWork: false,
  vip: false,
  minutesToEta: 30,
};

describe('arrival risk', () => {
  it('a ready room is no risk, VIP or not, ETA or not', () => {
    expect(assessArrival(ready)).toEqual({ score: 0, level: 'LOW', reasons: [] });
    expect(assessArrival({ ...ready, vip: true, minutesToEta: -10 })).toEqual({
      score: 0,
      level: 'LOW',
      reasons: [],
    });
  });

  it('a dirty room an hour before a VIP arrives is high risk, with its reasons in order', () => {
    expect(
      assessArrival({ ...ready, housekeeping: 'DIRTY', ready: false, vip: true, minutesToEta: 60 }),
    ).toEqual({ score: 55, level: 'MEDIUM', reasons: ['ROOM_DIRTY', 'ETA_SOON', 'VIP_GUEST'] });
    expect(
      assessArrival({
        ...ready,
        housekeeping: 'DIRTY',
        ready: false,
        openEngineeringWork: 1,
        urgentEngineeringWork: true,
        minutesToEta: 60,
      }),
    ).toEqual({
      score: 80,
      level: 'HIGH',
      reasons: ['ROOM_DIRTY', 'OPEN_ENGINEERING_WORK', 'ETA_SOON', 'URGENT_ENGINEERING_WORK'],
    });
  });

  it('an out-of-order room is high risk by itself; scores never pass 100', () => {
    expect(assessArrival({ ...ready, restricted: true, ready: false, minutesToEta: null })).toEqual(
      {
        score: 60,
        level: 'HIGH',
        reasons: ['ROOM_RESTRICTED'],
      },
    );
    const worst = assessArrival({
      roomAssigned: true,
      housekeeping: 'DIRTY',
      occupied: true,
      ready: false,
      restricted: true,
      openEngineeringWork: 2,
      urgentEngineeringWork: true,
      vip: true,
      minutesToEta: -15,
    });
    expect(worst.score).toBe(100);
    expect(worst.reasons[0]).toBe('ROOM_RESTRICTED');
  });

  it('no room yet: risk grows as the guest gets closer; far ETAs and waiting inspection are low', () => {
    const none = { ...ready, roomAssigned: false, housekeeping: null, ready: false };
    expect(assessArrival({ ...none, minutesToEta: null })).toMatchObject({
      score: 30,
      level: 'MEDIUM',
    });
    expect(assessArrival({ ...none, minutesToEta: -5 })).toMatchObject({
      score: 60,
      level: 'HIGH',
      reasons: ['NO_ROOM_ASSIGNED', 'ETA_PASSED'],
    });
    expect(
      assessArrival({ ...ready, housekeeping: 'INSPECTING', ready: false, minutesToEta: 600 }),
    ).toEqual({ score: 5, level: 'LOW', reasons: ['AWAITING_INSPECTION'] });
  });
});
