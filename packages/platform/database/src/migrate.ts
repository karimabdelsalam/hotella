import { join } from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDatabase } from './client';
import { packageRoot } from './paths';

/** Location of the single migration journal (ADR-0002): packages/platform/database/migrations. */
export function migrationsFolder(): string {
  // Works from both src (tests) and dist (runtime): the folder sits next to both.
  return join(packageRoot(), 'migrations');
}

export const MIGRATIONS_SCHEMA = 'platform';
export const MIGRATIONS_TABLE = 'schema_migrations';

/** Applies pending migrations. Idempotent; safe to run at every deploy and in test setup. */
export async function runMigrations(url: string): Promise<void> {
  const handle = createDatabase({ url, pool: { max: 1 }, applicationName: 'hotella-migrate' });
  try {
    await handle.db.execute(`CREATE SCHEMA IF NOT EXISTS "${MIGRATIONS_SCHEMA}"`);
    await migrate(handle.db, {
      migrationsFolder: migrationsFolder(),
      migrationsSchema: MIGRATIONS_SCHEMA,
      migrationsTable: MIGRATIONS_TABLE,
    });
  } finally {
    await handle.close();
  }
}
