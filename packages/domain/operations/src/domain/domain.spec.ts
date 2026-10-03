import { describe, expect, it } from 'vitest';
import { TASK_STATUSES } from '@hotella/contracts-events';
import { OPERATIONS_MANIFEST } from '../manifest';
import { channelsFor, retryDelayMs } from './notification';
import {
  ACTION_PERMISSION,
  deriveWorkItemStatus,
  nextTaskStatus,
  type TaskAction,
  type TaskStatus,
  WORK_ITEM_KIND_RE,
} from './task-lifecycle';

const ACTIONS = Object.keys(ACTION_PERMISSION) as TaskAction[];

describe('task lifecycle', () => {
  // The whole table, so any change to the rules is a visible diff (BUILD_PLAN §7.5).
  const allowed: Record<TaskAction, Partial<Record<TaskStatus, TaskStatus>>> = {
    ASSIGN: {
      NEW: 'ASSIGNED',
      ASSIGNED: 'ASSIGNED',
      ACCEPTED: 'ASSIGNED',
      IN_PROGRESS: 'ASSIGNED',
      PAUSED: 'ASSIGNED',
    },
    UNASSIGN: { ASSIGNED: 'NEW', ACCEPTED: 'NEW', IN_PROGRESS: 'NEW', PAUSED: 'NEW' },
    ACCEPT: { ASSIGNED: 'ACCEPTED' },
    REJECT: { ASSIGNED: 'NEW' },
    START: { ASSIGNED: 'IN_PROGRESS', ACCEPTED: 'IN_PROGRESS' },
    PAUSE: { IN_PROGRESS: 'PAUSED' },
    RESUME: { PAUSED: 'IN_PROGRESS' },
    COMPLETE: { ASSIGNED: 'DONE', ACCEPTED: 'DONE', IN_PROGRESS: 'DONE', PAUSED: 'DONE' },
    CANCEL: {
      NEW: 'CANCELLED',
      ASSIGNED: 'CANCELLED',
      ACCEPTED: 'CANCELLED',
      IN_PROGRESS: 'CANCELLED',
      PAUSED: 'CANCELLED',
    },
  };

  it('allows exactly the listed moves', () => {
    for (const action of ACTIONS)
      for (const status of TASK_STATUSES)
        expect(nextTaskStatus(status, action), `${action} from ${status}`).toBe(
          allowed[action][status] ?? null,
        );
  });

  it('never leaves a terminal status', () => {
    for (const action of ACTIONS) {
      expect(nextTaskStatus('DONE', action)).toBeNull();
      expect(nextTaskStatus('CANCELLED', action)).toBeNull();
    }
  });

  it('maps every action to a permission the module declares', () => {
    const declared = OPERATIONS_MANIFEST.permissions.map((p) => p.code);
    for (const action of ACTIONS) expect(declared).toContain(ACTION_PERMISSION[action]);
  });
});

describe('work item status', () => {
  it('follows its tasks', () => {
    expect(deriveWorkItemStatus([])).toBe('OPEN');
    expect(deriveWorkItemStatus(['NEW', 'ASSIGNED'])).toBe('OPEN');
    expect(deriveWorkItemStatus(['ASSIGNED', 'ACCEPTED'])).toBe('IN_PROGRESS');
    expect(deriveWorkItemStatus(['PAUSED'])).toBe('IN_PROGRESS');
    expect(deriveWorkItemStatus(['DONE', 'NEW'])).toBe('IN_PROGRESS');
    expect(deriveWorkItemStatus(['DONE', 'CANCELLED'])).toBe('RESOLVED');
    expect(deriveWorkItemStatus(['CANCELLED', 'CANCELLED'])).toBe('CANCELLED');
  });
});

describe('work item kinds', () => {
  it('are stable upper-snake codes', () => {
    for (const ok of ['HK_JOB', 'WORK_ORDER', 'SERVICE_REQUEST', 'INSPECTION2'])
      expect(ok).toMatch(WORK_ITEM_KIND_RE);
    for (const bad of ['hk_job', 'X', '1JOB', 'HK-JOB', ''])
      expect(bad).not.toMatch(WORK_ITEM_KIND_RE);
  });
});

describe('notification channels', () => {
  it('follow priority, honour preferences, and let critical policy override them', () => {
    const off = [{ category: 'ESCALATION', channel: 'EMAIL' as const, enabled: false }];
    expect(channelsFor('NORMAL', false, 'TASK', [])).toEqual(['IN_APP']);
    expect(channelsFor('HIGH', false, 'ESCALATION', [])).toEqual(['IN_APP', 'EMAIL']);
    expect(channelsFor('HIGH', false, 'ESCALATION', off)).toEqual(['IN_APP']);
    expect(channelsFor('HIGH', false, 'APPROVAL', off)).toEqual(['IN_APP', 'EMAIL']);
    expect(channelsFor('CRITICAL', true, 'ESCALATION', off)).toEqual(['IN_APP', 'EMAIL']);
    expect(channelsFor('CRITICAL', false, 'ESCALATION', off)).toEqual(['IN_APP']);
    expect([1, 2, 3, 4].map(retryDelayMs)).toEqual([60_000, 120_000, 240_000, 480_000]);
  });
});
