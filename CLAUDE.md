# Hotella — rules for agents and engineers working in this repository

Hotella is a white-label, multi-tenant, AI-native **Hotel Intelligence Platform** (product by Planova).
The architecture source of truth is `docs/spec/HOTELLA_MASTER_SPEC.md`. The execution order and
concrete technology decisions are in `docs/BUILD_PLAN.md` and `docs/adr/`.
Read all three before changing anything structural. Work phase by phase; never build ahead of the current phase.

## Stack (locked by ADRs, do not change without a new ADR)
TypeScript 5 strict · Node 22 · NestJS modular monolith · pnpm workspaces + Turborepo · PostgreSQL 16 (+pgvector)
· Drizzle ORM with reviewed SQL migrations · Redis 7 + BullMQ · S3-compatible storage · Zod contracts · pino + OpenTelemetry
· Vitest + Testcontainers · .NET 8 for the on-prem hotel agent (Phase 10).

## Repository shape
- `apps/*` compose; `packages/platform/*` are infrastructure; `packages/domain/*` are bounded contexts; `packages/contracts/*` are zod schemas (events, api, connectors, ai-tools).
- A domain package exposes other domains **only** `src/public`. Never import another domain's `infrastructure`, `schema` or repositories. Lint enforces this.
- Each bounded context owns its PostgreSQL schema (`org`, `iam`, `guest`, `catalog`, `ops`, `hk`, `eng`, `inspection`, `relations`, `comms`, `knowledge`, `ai`, `integration`, `license`, `audit`, `platform`). No domain writes another domain's tables; use its application service or an event.

## Hard rules (from Spec §82–§84; violating any of these is a bug)
1. Every tenant-owned table has `tenant_id` (and `property_id` where scoped); every query is tenant-filtered through the repository base; cross-tenant probing returns 404.
2. Ids are application-generated UUIDv7 (`newId()`), timestamps are `TIMESTAMPTZ` in UTC, concurrency-sensitive rows have `version`.
3. External/PMS ids live only in `integration.external_references`; they are never primary keys.
4. Every mutating endpoint declares a permission and goes through `ActionGate` (authorization → entitlement → feature → configuration → connector capability → AI policy → execute).
5. Important mutations write `audit.audit_log` with actor type (USER/GUEST/AI_AGENT/SYSTEM/INTEGRATION/SUPPORT), reason, approval/policy refs and `correlation_id`.
6. Cross-domain events go through the transactional outbox using the Spec §51 envelope; consumers are idempotent (`@Idempotent`). Raw vendor messages are not domain events.
7. No hardcoded user-facing strings. Use `/locales/{en,ar}/*.json` with stable keys; `en`/`ar` key parity is CI-checked. Localized business data uses `<entity>_translations(entity_id, locale, …)` tables, **never** `name_en`/`name_ar` columns.
8. Arabic is first-class RTL; any UI work uses logical CSS properties and is verified in both directions.
9. Published definitions (service versions, workflow versions, inspection versions, prompt/agent versions, PM procedures, plan versions) are immutable once published.
10. Operational history is preserved (room assignments, task assignments, transitions); never overwrite a single "current" field without also recording history.
11. SLA, security and business calculations are deterministic code, never delegated to an LLM.
12. AI never writes business tables directly and never calls a provider SDK outside the Model Gateway; AI acts only through registered tools with schema, risk level and required permission; HIGH-risk actions become approval proposals; CRITICAL cannot be executed by AI.
13. Secrets are `SecretRef`s resolved through `SecretProvider`; only `platform-config`/`platform-secrets` read `process.env`; no secret material in tables, logs or fixtures.
14. Entitlement ≠ feature flag ≠ configuration ≠ permission ≠ connector capability ≠ AI policy. Never `if (plan === 'ENTERPRISE')`; use `EntitlementEngine.can(...)`.
15. Branding resolves dynamically (platform → tenant → property → channel); nothing hotel-specific is hardcoded; the `Powered by Planova` footer (link `https://planova.com.eg`) is not removable by brand settings.
16. Unknown external codes create an `integration_exception`; never guess a mapping.
17. Use the injected logger with the CLS context; never `console.log`; no PII in logs.

## Working conventions
- Before coding a phase or module, make sure its section in `docs/BUILD_PLAN.md` has scope, domain model, migrations, APIs, events, permissions, tests and acceptance criteria. Update it if reality differs.
- Migrations: `pnpm db:generate` then hand-review the SQL; expand/deploy/migrate/contract for destructive changes; `pnpm db:check` must pass.
- Tests: unit for domain rules, integration against real Postgres/Redis (Testcontainers), a tenant-leak test for every tenant-scoped module, an e2e scenario for each phase acceptance.
- Commit small, descriptive commits. Branch for this effort: `claude/hopeful-archimedes-jskowx`. Do not open pull requests unless asked.
- Material deviation from the spec ⇒ write an ADR in `docs/adr/` first.
- Complexity belongs in the platform; simplicity belongs in the user experience.
