import { join } from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Client } from 'pg';
import { createDatabase } from './client';
import { packageRoot } from './paths';

/** Location of the single migration journal (ADR-0002): packages/platform/database/migrations. */
export function migrationsFolder(): string {
  // Works from both src (tests) and dist (runtime): the folder sits next to both.
  return join(packageRoot(), 'migrations');
}

/**
 * The journal lives in its own schema so that migration 0000 can own `CREATE SCHEMA "platform"`.
 * Drizzle's migrator creates the journal schema/table itself (IF NOT EXISTS).
 */
export const MIGRATIONS_SCHEMA = 'migrations';
export const MIGRATIONS_TABLE = 'journal';

/**
 * Advisory-lock key serializing migration runners (two deploy replicas, or parallel test suites sharing one
 * database). Arbitrary but fixed: the int8 form of the ASCII bytes "hotella\0".
 */
export const MIGRATION_LOCK_KEY = 7525361481318949120n;

/**
 * Applies pending migrations. Idempotent; safe to run at every deploy and in test setup.
 * Concurrent callers wait on a session advisory lock held on a dedicated connection, so only one
 * runner applies a given migration and the others then see it as already applied.
 */
export async function runMigrations(url: string): Promise<void> {
  const lock = new Client({ connectionString: url, application_name: 'hotella-migrate-lock' });
  await lock.connect();
  try {
    await lock.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY.toString()]);
    const handle = createDatabase({ url, pool: { max: 1 }, applicationName: 'hotella-migrate' });
    try {
      await migrate(handle.db, {
        migrationsFolder: migrationsFolder(),
        migrationsSchema: MIGRATIONS_SCHEMA,
        migrationsTable: MIGRATIONS_TABLE,
      });
    } finally {
      await handle.close();
    }
  } finally {
    // Closing the session releases the lock even if the unlock statement fails.
    await lock
      .query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY.toString()])
      .catch(() => undefined);
    await lock.end();
  }
}
