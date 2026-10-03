# ADR-0008: Vitest + Testcontainers; integration tests against real infrastructure

**Status:** Accepted — 2026-10-03

## Context
Tenant isolation, outbox atomicity, RLS, SLA timers and idempotency cannot be meaningfully tested against mocks. Spec §56 asks for connector simulators and contract tests.

## Decision
- **Vitest** for unit and integration tests (fast, ESM-native, TypeScript via SWC).
- **Testcontainers** starts PostgreSQL (pgvector image) and Redis once per test run; migrations are applied; tables are truncated between tests. In CI the same images run as GitHub Actions service containers.
- Test tiers: `unit` (pure domain logic, SLA math, workflow engine), `integration` (modules against real PG/Redis), `contract` (event schemas, connector manifests, OpenAPI snapshot), `e2e` (phase acceptance scenarios via supertest and the PMS simulator).
- Coverage thresholds enforced on domain logic packages; every tenant-scoped module has a mandatory tenant-leak test.

## Consequences
- Slightly slower CI than mock-only tests, offset by Turborepo caching and parallel packages.
- Developers need Docker locally for integration tests.
