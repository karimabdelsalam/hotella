import { eq } from 'drizzle-orm';
import { infraSkipReason, needsInfra, readTestInfra } from '@hotella/platform-testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type DatabaseHandle } from './client';
import { getDataClassRegistry } from './data-class';
import { isUuid, newId } from './ids';
import { runMigrations } from './migrate';
import { featureFlags } from './schema';
import { currentTransaction, executor, withTransaction } from './transaction';

describe.skipIf(needsInfra())(`platform-database against PostgreSQL (${infraSkipReason()})`, () => {
  let handle: DatabaseHandle;
  const url = readTestInfra().databaseUrl!;

  beforeAll(async () => {
    await runMigrations(url);
    await runMigrations(url); // idempotent
    handle = createDatabase({ url, pool: { max: 2 } });
  });
  afterAll(() => handle?.close());

  it('applies the journal and creates the platform schema tables', async () => {
    const rows = await handle.db.execute<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'platform' order by 1",
    );
    const names = rows.rows.map((r) => r.table_name);
    expect(names).toEqual(expect.arrayContaining(['feature_flags', 'schema_migrations']));
  });

  it('inserts with application-generated UUIDv7 ids and TIMESTAMPTZ defaults', async () => {
    const key = `test.flag.${newId()}`;
    const [row] = await handle.db.insert(featureFlags).values({ key, enabled: true }).returning();
    expect(isUuid(row!.id)).toBe(true);
    expect(row!.createdAt).toBeInstanceOf(Date);
    const tz = await handle.db.execute<{ data_type: string }>(
      "select data_type from information_schema.columns where table_schema='platform' and table_name='feature_flags' and column_name='created_at'",
    );
    expect(tz.rows[0]!.data_type).toBe('timestamp with time zone');
  });

  it('rolls back everything written through the ambient transaction when the unit of work fails', async () => {
    const key = `test.rollback.${newId()}`;
    await expect(
      withTransaction(handle.db, async () => {
        expect(currentTransaction()).toBeDefined();
        await executor(handle.db).insert(featureFlags).values({ key, enabled: false });
        // a nested call reuses the same transaction
        await withTransaction(handle.db, async (tx) => {
          expect(tx).toBe(currentTransaction());
        });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const after = await handle.db.select().from(featureFlags).where(eq(featureFlags.key, key));
    expect(after).toHaveLength(0);
    expect(currentTransaction()).toBeUndefined();
  });

  it('enforces the unique key per scope (nulls not distinct)', async () => {
    const key = `test.unique.${newId()}`;
    await handle.db.insert(featureFlags).values({ key, enabled: true });
    await expect(handle.db.insert(featureFlags).values({ key, enabled: false })).rejects.toThrow(
      /unique|duplicate/i,
    );
  });
});

describe('data classification registry', () => {
  it('registers every column of feature_flags', () => {
    const t = getDataClassRegistry().get('feature_flags');
    expect(t).toBeDefined();
    expect(Object.keys(t!.columns).sort()).toEqual([
      'created_at',
      'description',
      'enabled',
      'id',
      'key',
      'scope',
      'scope_id',
      'updated_at',
    ]);
  });
  it('UUIDv7 ids are time-ordered', () => {
    const a = newId();
    const b = newId();
    expect(isUuid(a)).toBe(true);
    expect(a < b).toBe(true);
  });
});
