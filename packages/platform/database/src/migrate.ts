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

/** Schemas the application reads and writes. The migration journal schema is deliberately not granted. */
export const APPLICATION_SCHEMAS = ['org', 'iam', 'audit', 'platform'] as const;
const ROLE_RE = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * Grants the application's ordinary (non-superuser, RLS-bound) role what it needs after migrations: USAGE on the
 * application schemas and DML on their tables, including tables future migrations create (default privileges).
 * Append-only tables stay append-only because their triggers reject UPDATE/DELETE regardless of grants.
 */
export async function grantApplicationRole(url: string, role: string): Promise<void> {
  if (!ROLE_RE.test(role)) throw new Error(`Invalid role name "${role}"`);
  const client = new Client({ connectionString: url, application_name: 'hotella-grant' });
  await client.connect();
  try {
    const { rows } = await client.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      'select rolsuper, rolbypassrls from pg_roles where rolname = $1',
      [role],
    );
    if (rows.length === 0) throw new Error(`Role "${role}" does not exist`);
    if (rows[0]!.rolsuper || rows[0]!.rolbypassrls)
      throw new Error(
        `Role "${role}" bypasses row-level security; the application must use an ordinary role`,
      );
    for (const schema of APPLICATION_SCHEMAS) {
      await client.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
      await client.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO "${role}"`,
      );
      await client.query(
        `ALTER DEFAULT PRIVILEGES IN SCHEMA "${schema}" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "${role}"`,
      );
    }
  } finally {
    await client.end();
  }
}
