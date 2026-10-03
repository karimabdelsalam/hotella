import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolConfig } from 'pg';
import * as platformSchema from './schema';

/** The full Drizzle schema map. Domain packages register their schemas through `DatabaseModule.forRoot({ schemas })`. */
export type Schema = typeof platformSchema & Record<string, unknown>;
export type Database = NodePgDatabase<Schema>;

export interface DatabaseOptions {
  readonly url: string;
  readonly pool?: Pick<
    PoolConfig,
    'max' | 'min' | 'idleTimeoutMillis' | 'connectionTimeoutMillis' | 'statement_timeout'
  >;
  readonly schemas?: ReadonlyArray<Record<string, unknown>>;
  readonly applicationName?: string;
}

export interface DatabaseHandle {
  readonly db: Database;
  readonly pool: Pool;
  close(): Promise<void>;
}

/** Creates the pg Pool + Drizzle client. One per process; injected via `DATABASE`. */
export function createDatabase(options: DatabaseOptions): DatabaseHandle {
  const pool = new Pool({
    connectionString: options.url,
    application_name: options.applicationName ?? 'hotella',
    max: 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    ...options.pool,
  });
  // Never let an idle-client error crash the process; it surfaces on the next query and in /ready.
  pool.on('error', () => undefined);
  const schema = Object.assign({}, platformSchema, ...(options.schemas ?? [])) as Schema;
  const db = drizzle(pool, { schema, casing: 'snake_case' });
  return { db, pool, close: () => pool.end() };
}
