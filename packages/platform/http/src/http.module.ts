import { type DynamicModule, Global, Module, type Provider } from '@nestjs/common';
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
export class HttpConventionsModule {
  static forRoot(options: HttpModuleOptions = {}): DynamicModule {
    const store: Provider =
      options.store === 'memory'
        ? { provide: KV_STORE, useValue: new MemoryKeyValueStore() }
        : {
            provide: KV_STORE,
            inject: [VALKEY],
            useFactory: (v: Redis): KeyValueStore => new ValkeyKeyValueStore(v),
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
