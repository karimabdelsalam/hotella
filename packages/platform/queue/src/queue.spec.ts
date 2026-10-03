import { DELIVERY_QUEUES } from '@hotella/contracts-events';
import { describe, expect, it } from 'vitest';
import { EventConsumerRegistry } from './worker';
import { isQueueName, QUEUE_NAMES } from './queues';

describe('queues', () => {
  it('match the delivery queues declared in the event contracts exactly', () => {
    expect([...QUEUE_NAMES].sort()).toEqual([...DELIVERY_QUEUES].sort());
    expect(isQueueName('guest-realtime')).toBe(true);
    expect(isQueueName('nope')).toBe(false);
  });
  it('registry rejects a consumer subscribing twice to one event', () => {
    const r = new EventConsumerRegistry();
    r.on('ops.task.assigned.v1', 'hk.board', async () => undefined);
    expect(() => r.on('ops.task.assigned.v1', 'hk.board', async () => undefined)).toThrow(
      /already/,
    );
    r.on('ops.task.assigned.v1', 'eng.board', async () => undefined);
    expect(r.for('ops.task.assigned.v1')).toHaveLength(2);
  });
});
