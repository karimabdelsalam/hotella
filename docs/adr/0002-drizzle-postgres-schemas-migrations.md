# ADR-0002: Drizzle ORM, PostgreSQL schema per bounded context, SQL migrations

**Status:** Accepted — 2026-10-03

## Context
Spec §2.2 requires PostgreSQL, application-generated UUIDv7, `TIMESTAMPTZ`, explicit `tenant_id`, strong FKs, JSONB only where justified, optional RLS, optimistic locking. Spec §78 suggests logical schemas per context (`org.*`, `iam.*`, …). Spec §72 requires expand/deploy/migrate/contract migrations. Spec §2.5 allows pgvector.

Candidates: Prisma (multi-schema still preview-grade, weak raw SQL/RLS ergonomics, migration engine opaque), TypeORM (decorator entities, migration drift history), Drizzle (schema as TypeScript, first-class `pgSchema`, SQL-visible migrations, custom types for pgvector/ltree), Kysely + hand-written SQL (maximum control, more boilerplate).

## Decision
- **Drizzle ORM 0.45.x** (stable line) with `drizzle-kit`, PostgreSQL **18**. We use pg-core schema definitions, SQL migrations and the core query builder; we avoid the relational-query API because it is the part that changes in 1.0 (ADR-0016 HOLD). Upgrade to 1.0 follows the official migration guide once final.
- Each bounded context defines its tables in `packages/domain/<ctx>/src/infrastructure/schema.ts` inside its own PostgreSQL schema via `pgSchema('<ctx>')`. Platform tables (outbox, inbox, configuration, feature flags) live in schema `platform`.
- `packages/platform/database` aggregates all schema modules for drizzle-kit and owns the single migration journal `migrations/`. File naming `<timestamp>_<ctx>_<description>.sql`.
- Generated SQL is **always hand-reviewed** before commit; CI runs `db:check` to fail on schema/migration drift.
- Shared column helpers (`baseColumns`, `tenantScoped`, `versioned`, `translationColumns` + `translationUnique`) live in `platform/database` and are the only way to declare ids/timestamps.
- Destructive changes follow expand → deploy → migrate → contract across separate releases.
- pgvector via a custom Drizzle column type; `ltree` for location paths.

## Consequences
- Developers see the exact SQL that runs in production.
- One journal means one ordering; teams coordinate on migration order through PR review.
- RLS policies are written as SQL in migrations (Drizzle does not model them).
