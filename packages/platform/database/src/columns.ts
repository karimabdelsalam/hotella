import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  integer,
  type PgColumnBuilderBase,
  type PgSchema,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { newId } from './ids';

/**
 * Column helpers (Spec §2.2). Use these instead of hand-writing id/timestamp/tenant columns so every
 * table is consistent and lint/`db:check` can rely on the shape.
 */

/** `id` (UUIDv7 from the application), `created_at`, `updated_at` — TIMESTAMPTZ in UTC. */
export function baseColumns() {
  return {
    id: uuid('id').primaryKey().$defaultFn(newId),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow()
      .$onUpdateFn(() => new Date()),
  };
}

/** Every tenant-owned table carries `tenant_id` (CLAUDE.md rule 1). FK to org.tenants is added by the org context migration. */
export function tenantScoped() {
  return { tenantId: uuid('tenant_id').notNull() };
}

/** Property-scoped tables add `property_id` next to `tenant_id`. */
export function propertyScoped() {
  return { ...tenantScoped(), propertyId: uuid('property_id').notNull() };
}

/** Optimistic locking (Spec §2.2). Repositories must `WHERE version = :expected` and increment. */
export function versioned() {
  return { version: integer('version').notNull().default(1) };
}

/** Locale column for translation tables (BCP 47, e.g. `en`, `ar`, `ar-EG`). */
export function localeColumn(name = 'locale') {
  return varchar(name, { length: 16 }).notNull();
}

/**
 * Normalized translation table (Spec §79.2): `<entity>_translations(entity_id, locale, …)` with a unique
 * `(entity_id, locale)` constraint. `entityRef` is the parent id column (FK, cascade on delete).
 * `extra` holds the translated columns (name, description, …).
 */
export function translationTable<TExtra extends Record<string, PgColumnBuilderBase>>(
  schema: PgSchema,
  name: string,
  entityRef: () => AnyPgColumn,
  extra: TExtra,
) {
  const columns = {
    entityId: uuid('entity_id').notNull().references(entityRef, { onDelete: 'cascade' }),
    locale: localeColumn(),
    ...extra,
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow()
      .$onUpdateFn(() => new Date()),
  };
  return schema.table(name, columns, (t) => [
    unique(`${name}_entity_locale_uq`).on(t.entityId, t.locale),
  ]);
}

/** `now()` for raw SQL fragments. */
export const nowSql = sql`now()`;
