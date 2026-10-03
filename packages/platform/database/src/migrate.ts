import { join } from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
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

/** Applies pending migrations. Idempotent; safe to run at every deploy and in test setup. */
export async function runMigrations(url: string): Promise<void> {
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
}
