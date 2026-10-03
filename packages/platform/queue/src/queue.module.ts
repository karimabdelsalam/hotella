import {
  type DynamicModule,
  Global,
  Inject,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '@hotella/platform-config';
import { RequestContext } from '@hotella/platform-observability';
import type { Redis } from 'ioredis';
import { createValkeyConnection } from './connection';
import { QueueRegistry } from './registry';
import { BullmqEventTransport } from './transport';
import { EventConsumerRegistry } from './worker';

export const VALKEY = Symbol('VALKEY');
/** The BullMQ-backed EventTransport. Apps that run the relay alias EVENT_TRANSPORT to it via useExisting. */
export const BULLMQ_EVENT_TRANSPORT = Symbol('BULLMQ_EVENT_TRANSPORT');
export const InjectValkey = (): ParameterDecorator => Inject(VALKEY);

@Global()
@Module({})
export class QueueModule implements OnApplicationShutdown {
  constructor(
    @Inject(VALKEY) private readonly valkey: Redis,
    private readonly registry: QueueRegistry,
  ) {}

  /** Provides the shared Valkey connection, the queue registry and the BullMQ EventTransport for the outbox relay. */
  static forRoot(): DynamicModule {
    return {
      module: QueueModule,
      providers: [
        {
          provide: VALKEY,
          inject: [APP_CONFIG],
          useFactory: (config: AppConfig): Redis => createValkeyConnection(config.valkey.url),
        },
        {
          provide: QueueRegistry,
          inject: [VALKEY, RequestContext],
          useFactory: (v: Redis, ctx: RequestContext) => new QueueRegistry(v, ctx),
        },
        {
          provide: BULLMQ_EVENT_TRANSPORT,
          inject: [QueueRegistry],
          useFactory: (r: QueueRegistry) => new BullmqEventTransport(r),
        },
        EventConsumerRegistry,
      ],
      exports: [VALKEY, QueueRegistry, BULLMQ_EVENT_TRANSPORT, EventConsumerRegistry],
    };
  }

  async onApplicationShutdown(): Promise<void> {
    await this.registry.close();
    this.valkey.disconnect(false);
  }
}
