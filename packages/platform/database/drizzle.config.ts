import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit configuration (ADR-0002). All bounded-context schemas are aggregated here so there is
 * ONE migration journal. Domain packages add their `src/infrastructure/schema.ts` to `schema` below.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: [
    './src/schema/*.ts',
    '../events/src/schema/*.ts',
    '../audit/src/schema/*.ts',
    '../settings/src/schema/*.ts',
    '../../domain/*/src/infrastructure/schema.ts',
  ],
  out: './migrations',
  casing: 'snake_case',
  schemaFilter: [
    'platform',
    'org',
    'iam',
    'guest',
    'catalog',
    'ops',
    'hk',
    'eng',
    'inspection',
    'relations',
    'lostfound',
    'logbook',
    'comms',
    'knowledge',
    'ai',
    'integration',
    'license',
    'audit',
    'restaurant',
  ],
  migrations: { schema: 'migrations', table: 'journal' },
  strict: true,
  verbose: true,
});
