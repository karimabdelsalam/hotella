import { z } from 'zod';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createEnvelope,
  defineEvent,
  EventDefinitionError,
  getEventDefinition,
  resetEventRegistryForTests,
} from './registry';

const uuid = '019265a0-1b2c-7d3e-8f4a-5b6c7d8e9f01';

describe('defineEvent', () => {
  beforeEach(() => resetEventRegistryForTests());

  it('registers a versioned event and validates envelopes', () => {
    const TaskAssigned = defineEvent({
      type: 'ops.task.assigned',
      version: 1,
      description: 'x',
      payload: z.object({ task_id: z.uuid() }),
      delivery: 'critical-operational',
    });
    expect(TaskAssigned.name).toBe('ops.task.assigned.v1');
    expect(getEventDefinition('ops.task.assigned.v1')).toBe(TaskAssigned);
    const env = createEnvelope(TaskAssigned, {
      eventId: uuid,
      tenantId: uuid,
      propertyId: null,
      source: 'ops',
      correlationId: 'c-1',
      payload: { task_id: uuid },
    });
    expect(env.event_type).toBe('ops.task.assigned');
    expect(env.event_version).toBe(1);
    expect(() => TaskAssigned.parse({ ...env, payload: { task_id: 'nope' } })).toThrow();
    expect(() => TaskAssigned.parse({ ...env, event_version: 2 })).toThrow();
  });

  it('rejects duplicates, bad names and misuse of the hotel.* namespace', () => {
    defineEvent({ type: 'ops.task.assigned', version: 1, description: 'x', payload: z.object({}) });
    expect(() =>
      defineEvent({
        type: 'ops.task.assigned',
        version: 1,
        description: 'dup',
        payload: z.object({}),
      }),
    ).toThrow(EventDefinitionError);
    expect(() =>
      defineEvent({
        type: 'ops.TaskAssigned',
        version: 1,
        description: 'x',
        payload: z.object({}),
      }),
    ).toThrow(EventDefinitionError);
    expect(() =>
      defineEvent({ type: 'ops.task', version: 1, description: 'x', payload: z.object({}) }),
    ).toThrow(EventDefinitionError);
    expect(() =>
      defineEvent({
        type: 'hotel.guest.checked_in',
        version: 1,
        description: 'x',
        payload: z.object({}),
      }),
    ).toThrow(/reserved/);
    expect(() =>
      defineEvent({
        type: 'ops.task.done',
        version: 1,
        description: 'x',
        payload: z.object({}),
        canonical: true,
      }),
    ).toThrow(/hotel\.\*/);
    expect(
      defineEvent({
        type: 'hotel.guest.checked_in',
        version: 1,
        description: 'x',
        payload: z.object({}),
        canonical: true,
      }).canonical,
    ).toBe(true);
  });

  it('allows a new version of the same type side by side', () => {
    const v1 = defineEvent({
      type: 'ops.task.assigned',
      version: 1,
      description: 'x',
      payload: z.object({ a: z.string() }),
    });
    const v2 = defineEvent({
      type: 'ops.task.assigned',
      version: 2,
      description: 'x',
      payload: z.object({ a: z.string(), b: z.number() }),
    });
    expect(v1.name).not.toBe(v2.name);
    expect(v2.delivery).toBe('normal');
  });
});
