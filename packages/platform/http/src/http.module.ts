import {
  type DynamicModule,
  Global,
  Inject,
  Module,
  type OnApplicationShutdown,
  type Provider,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { VALKEY } from '@hotella/platform-queue';
import type { Redis } from 'ioredis';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import { KV_STORE, MemoryKeyValueStore, ValkeyKeyValueStore, type KeyValueStore } from './kv-store';
import { ProblemDetailsFilter } from './problem-details.filter';
import { RateLimitGuard } from './rate-limit.guard';

export interface HttpModuleOptions {
  /** `valkey` (default) uses the shared connection from QueueModule; `memory` is for unit tests only. */
  readonly store?: 'valkey' | 'memory';
}

/** Installs the HTTP conventions globally: Problem Details, rate limiting, idempotency keys (ADR-0012). */
@Global()
@Module({})
export class HttpConventionsModule implements OnApplicationShutdown {
  constructor(@Inject(KV_STORE) private readonly store: KeyValueStore) {}

  async onApplicationShutdown(): Promise<void> {
    await this.store.close?.();
  }

  static forRoot(options: HttpModuleOptions = {}): DynamicModule {
    const store: Provider =
      options.store === 'memory'
        ? { provide: KV_STORE, useValue: new MemoryKeyValueStore() }
        : {
            provide: KV_STORE,
            inject: [VALKEY],
            // Its own connection that fails fast: the shared BullMQ connection retries forever, which would make every
            // rate-limited request (and the health probes) hang while Valkey is down.
            useFactory: (v: Redis): KeyValueStore => {
              const client = v.duplicate({
                maxRetriesPerRequest: 1,
                enableOfflineQueue: false,
                commandTimeout: 500,
              });
              client.on('error', () => undefined); // surfaced by readiness and the limiter's fail-open warning
              return new ValkeyKeyValueStore(client);
            },
          };
    return {
      module: HttpConventionsModule,
      providers: [
        store,
        ProblemDetailsFilter,
        { provide: APP_FILTER, useExisting: ProblemDetailsFilter },
        { provide: APP_GUARD, useClass: RateLimitGuard },
        { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
      ],
      exports: [KV_STORE, ProblemDetailsFilter],
    };
  }
}
