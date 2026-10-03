import type { EventEnvelope } from '@hotella/contracts-events';
import type { EventTransport } from '@hotella/platform-events';
import type { QueueRegistry } from './registry';
import { isQueueName } from './queues';

/**
 * Outbox → BullMQ. Job id = event_id so a re-published row (at-least-once relay) is de-duplicated by
 * BullMQ as well; the inbox remains the authoritative idempotency guard.
 */
export class BullmqEventTransport implements EventTransport {
  constructor(private readonly registry: QueueRegistry) {}

  async publish(
    envelope: EventEnvelope,
    meta: { eventName: string; deliveryQueue: string },
  ): Promise<void> {
    const queue = isQueueName(meta.deliveryQueue) ? meta.deliveryQueue : 'normal';
    await this.registry.queue(queue).add(
      meta.eventName,
      {
        data: envelope,
        context: {
          correlation_id: envelope.correlation_id ?? undefined,
          tenant_id: envelope.tenant_id,
          property_id: envelope.property_id,
        },
        enqueuedAt: new Date().toISOString(),
      },
      { jobId: envelope.event_id },
    );
  }
}
