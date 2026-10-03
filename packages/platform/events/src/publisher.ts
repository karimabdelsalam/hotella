import { Inject, Injectable } from '@nestjs/common';
import type { ZodType, z } from 'zod';
import {
  createEnvelope,
  type EventDefinition,
  type EventEnvelope,
} from '@hotella/contracts-events';
import {
  currentTransaction,
  DATABASE,
  type Database,
  executor,
  newId,
} from '@hotella/platform-database';
import { RequestContext } from '@hotella/platform-observability';
import { DomainEventBus } from './domain-event-bus';
import { outbox } from './schema';

export interface PublishInput<P> {
  readonly payload: P;
  readonly tenantId: string | null;
  readonly propertyId?: string | null;
  /** Producing context or integration, e.g. `ops`, `integration:OPERA5_FIAS`. */
  readonly source: string;
  readonly aggregate?: { type: string; id: string };
  readonly sourceReference?: string | null;
  readonly occurredAt?: Date;
  /** Escape hatch for code that is provably not part of a business transaction (e.g. a CLI). */
  readonly allowAutocommit?: boolean;
}

export class OutboxRequiresTransactionError extends Error {
  constructor(name: string) {
    super(
      `publish(${name}) must run inside withTransaction()/TransactionRunner so the event is atomic with the business change (Spec §50).`,
    );
    this.name = 'OutboxRequiresTransactionError';
  }
}

/**
 * Writes the event to the outbox inside the ambient transaction and emits it on the in-context bus.
 * The relay (worker) delivers it to the queue after commit. Rollback = no event. (ADR-0004)
 */
@Injectable()
export class EventPublisher {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly ctx: RequestContext,
    private readonly bus: DomainEventBus,
  ) {}

  async publish<P extends ZodType>(
    def: EventDefinition<P>,
    input: PublishInput<z.infer<P>>,
  ): Promise<EventEnvelope<z.infer<P>>> {
    if (!currentTransaction() && !input.allowAutocommit)
      throw new OutboxRequiresTransactionError(def.name);
    const envelope = createEnvelope(def, {
      eventId: newId(),
      tenantId: input.tenantId,
      propertyId: input.propertyId ?? null,
      source: input.source,
      sourceReference: input.sourceReference ?? null,
      correlationId: this.ctx.correlationId,
      occurredAt: input.occurredAt,
      payload: input.payload,
    });
    await executor(this.db)
      .insert(outbox)
      .values({
        id: envelope.event_id,
        eventName: def.name,
        eventType: def.type,
        eventVersion: def.version,
        tenantId: envelope.tenant_id,
        propertyId: envelope.property_id,
        aggregateType: input.aggregate?.type ?? null,
        aggregateId: input.aggregate?.id ?? null,
        deliveryQueue: def.delivery,
        envelope,
        correlationId: envelope.correlation_id,
        occurredAt: new Date(envelope.occurred_at),
      });
    await this.bus.emit(def.name, envelope);
    return envelope;
  }
}
