import {
  type DynamicModule,
  Global,
  Inject,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '@hotella/platform-config';
import type { Pool } from 'pg';
import { createDatabase, type Database, type DatabaseHandle } from './client';
import { withTransaction, type Transaction } from './transaction';

export const DATABASE = Symbol('DATABASE');
export const PG_POOL = Symbol('PG_POOL');
const DATABASE_HANDLE = Symbol('DATABASE_HANDLE');

export const InjectDatabase = (): ParameterDecorator => Inject(DATABASE);

/** Injectable unit-of-work runner; application services start transactions here. */
export class TransactionRunner {
  constructor(@Inject(DATABASE) private readonly db: Database) {}
  run<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    return withTransaction(this.db, fn);
  }
}

@Global()
@Module({})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(DATABASE_HANDLE) private readonly handle: DatabaseHandle) {}

  static forRoot(
    options: { readonly schemas?: ReadonlyArray<Record<string, unknown>> } = {},
  ): DynamicModule {
    return {
      module: DatabaseModule,
      providers: [
        {
          provide: DATABASE_HANDLE,
          inject: [APP_CONFIG],
          useFactory: (config: AppConfig): DatabaseHandle =>
            createDatabase({
              url: config.database.url,
              schemas: options.schemas,
              applicationName: config.app.name,
            }),
        },
        {
          provide: DATABASE,
          inject: [DATABASE_HANDLE],
          useFactory: (h: DatabaseHandle): Database => h.db,
        },
        {
          provide: PG_POOL,
          inject: [DATABASE_HANDLE],
          useFactory: (h: DatabaseHandle): Pool => h.pool,
        },
        TransactionRunner,
      ],
      exports: [DATABASE, PG_POOL, TransactionRunner],
    };
  }

  async onApplicationShutdown(): Promise<void> {
    await this.handle.close();
  }
}
