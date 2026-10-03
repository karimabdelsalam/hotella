import {
  type DynamicModule,
  Global,
  Inject,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '@hotella/platform-config';
import { EVENT_TRANSPORT } from '@hotella/platform-events';
import { RequestContext } from '@hotella/platform-observability';
import type { Redis } from 'ioredis';
import { createValkeyConnection } from './connection';
import { QueueRegistry } from './registry';
import { BullmqEventTransport } from './transport';

export const VALKEY = Symbol('VALKEY');
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
          provide: EVENT_TRANSPORT,
          inject: [QueueRegistry],
          useFactory: (r: QueueRegistry) => new BullmqEventTransport(r),
        },
      ],
      exports: [VALKEY, QueueRegistry, EVENT_TRANSPORT],
    };
  }

  async onApplicationShutdown(): Promise<void> {
    await this.registry.close();
    this.valkey.disconnect(false);
  }
}
