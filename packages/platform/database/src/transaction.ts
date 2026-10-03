import { sql } from 'drizzle-orm';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ExtractTablesWithRelations } from 'drizzle-orm';
import type { PgTransaction } from 'drizzle-orm/pg-core';
import type { NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';
import type { Database, Schema } from './client';

export type Transaction = PgTransaction<
  NodePgQueryResultHKT,
  Schema,
  ExtractTablesWithRelations<Schema>
>;
/** What repositories query against: the active transaction if any, else the root client. */
export type Executor = Database | Transaction;

const txStorage = new AsyncLocalStorage<Transaction>();

/**
 * Runs `fn` inside a transaction and makes it ambient for everything called within (repositories,
 * the outbox publisher, audit writer) through `executor()`. Nested calls reuse the outer transaction
 * (one unit of work, no savepoints unless explicitly requested later).
 */
export async function withTransaction<T>(
  db: Database,
  fn: (tx: Transaction) => Promise<T>,
  options: { readonly tenantId?: string | null } = {},
): Promise<T> {
  const existing = txStorage.getStore();
  if (existing) return fn(existing);
  return db.transaction(async (tx) => {
    // Row-level security (ADR-0002, migration 0006): tenant-scoped transactions carry the tenant in a
    // transaction-local setting; policies then hide every other tenant's rows even if a query forgets its filter.
    if (options.tenantId)
      await tx.execute(sql`select set_config('app.tenant_id', ${options.tenantId}, true)`);
    return txStorage.run(tx as Transaction, () => fn(tx as Transaction));
  });
}

/** The ambient transaction if one is active. */
export function currentTransaction(): Transaction | undefined {
  return txStorage.getStore();
}

/** The ambient transaction, or the given root client. Repositories should always go through this. */
export function executor(db: Database): Executor {
  return txStorage.getStore() ?? db;
}
