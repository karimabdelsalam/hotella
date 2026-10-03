import { Injectable } from '@nestjs/common';
import type { z, ZodType } from 'zod';
import type { EventDefinition, EventEnvelope } from '@hotella/contracts-events';

export type DomainEventHandler<P> = (envelope: EventEnvelope<P>) => Promise<void> | void;

/**
 * Synchronous, in-process bus for side effects INSIDE one bounded context, executed within the
 * publishing transaction (ADR-0004). Anything crossing a context boundary must go through the
 * outbox instead; this bus is not durable and not for other contexts.
 */
@Injectable()
export class DomainEventBus {
  private readonly handlers = new Map<string, Set<DomainEventHandler<unknown>>>();

  on<P extends ZodType>(
    def: EventDefinition<P>,
    handler: DomainEventHandler<z.infer<P>>,
  ): () => void {
    const set = this.handlers.get(def.name) ?? new Set();
    set.add(handler as DomainEventHandler<unknown>);
    this.handlers.set(def.name, set);
    return () => set.delete(handler as DomainEventHandler<unknown>);
  }

  async emit(name: string, envelope: EventEnvelope): Promise<void> {
    const set = this.handlers.get(name);
    if (!set) return;
    for (const h of set) await h(envelope);
  }
}
