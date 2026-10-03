import { type DynamicModule, Global, Module, type Provider } from '@nestjs/common';
import { DomainEventBus } from './domain-event-bus';
import { IdempotentConsumer } from './idempotency';
import { EventPublisher } from './publisher';
import { EVENT_TRANSPORT, OutboxRelay, type EventTransport } from './relay';

@Global()
@Module({})
export class EventsModule {
  /**
   * `transport` is required where the relay runs (the worker); the API only publishes to the outbox
   * and may omit it. A `NoopTransport` is wired then so the DI graph still resolves.
   */
  static forRoot(options: { readonly transport?: Provider<EventTransport> } = {}): DynamicModule {
    const transport: Provider = options.transport ?? {
      provide: EVENT_TRANSPORT,
      useValue: new NoopTransport(),
    };
    return {
      module: EventsModule,
      providers: [DomainEventBus, EventPublisher, IdempotentConsumer, transport, OutboxRelay],
      exports: [DomainEventBus, EventPublisher, IdempotentConsumer, OutboxRelay, EVENT_TRANSPORT],
    };
  }
}

export class NoopTransport implements EventTransport {
  async publish(): Promise<void> {
    throw new Error(
      'No EventTransport configured: the outbox relay must run in a worker with QueueModule (ADR-0004).',
    );
  }
}
