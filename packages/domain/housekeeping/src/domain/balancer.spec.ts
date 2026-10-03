import { describe, expect, it } from 'vitest';
import { type BalancerJob, proposeAssignments } from './balancer';

const job = (room: string, credits = 1, floor: string | null = null): BalancerJob => ({
  jobId: `job-${room}`,
  roomNumber: room,
  floor,
  credits,
});
const rooms = (load: { jobs: readonly BalancerJob[] }) => load.jobs.map((j) => j.roomNumber);

describe('housekeeping assignment proposal', () => {
  it('keeps floors together when that stays balanced', () => {
    const plan = proposeAssignments(
      [job('101'), job('102'), job('103'), job('201'), job('202'), job('203')],
      ['a', 'b'],
    );
    expect(plan.map(rooms)).toEqual([
      ['101', '102', '103'],
      ['201', '202', '203'],
    ]);
    expect(plan.map((l) => l.credits)).toEqual([3, 3]);
  });

  it('splits a floor that is too big for one attendant, room by room', () => {
    const plan = proposeAssignments(
      [job('101'), job('102'), job('103'), job('104'), job('201', 0.5)],
      ['a', 'b'],
    );
    expect(plan.map((l) => l.credits)).toEqual([2.5, 2]);
    expect(plan.flatMap(rooms).sort()).toEqual(['101', '102', '103', '104', '201']);
  });

  it('balances by credits, not by room count, and is deterministic', () => {
    const jobs = [job('101', 2, '1'), job('102', 0.3, '1'), job('301', 1, '3'), job('302', 1, '3')];
    const first = proposeAssignments(jobs, ['a', 'b']);
    expect(proposeAssignments([...jobs].reverse(), ['a', 'b'])).toEqual(first);
    expect(first.map((l) => l.credits)).toEqual([2.3, 2]);
  });

  it('one attendant gets everything; nobody gets nothing to do', () => {
    expect(proposeAssignments([job('101'), job('901')], ['a'])[0]!.jobs).toHaveLength(2);
    expect(proposeAssignments([job('101')], [])).toEqual([]);
    expect(proposeAssignments([], ['a', 'a'])).toEqual([
      { attendantId: 'a', credits: 0, jobs: [] },
    ]);
  });
});
