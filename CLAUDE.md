# Hotella — rules for agents and engineers working in this repository

Hotella is a white-label, multi-tenant, AI-native **Hotel Intelligence Platform** (product by Planova).
The architecture source of truth is `docs/spec/HOTELLA_MASTER_SPEC.md`. The execution order and
concrete technology decisions are in `docs/BUILD_PLAN.md` and `docs/adr/`; `docs/TRACEABILITY.md` maps every spec section to where it is satisfied.
Read all three before changing anything structural. Work phase by phase; never build ahead of the current phase.

## Stack (locked by ADRs, do not change without a new ADR)
Pure ESM · TypeScript 7 strict (`tsgo` type-check, SWC emit) · Node 26 · NestJS 12 modular monolith · pnpm 11 + Turborepo
· PostgreSQL 18 (+pgvector) · Drizzle ORM 1.0 (restricted surface until final) with reviewed SQL migrations · Valkey 9 + BullMQ
· S3-compatible storage · Zod 4 contracts (Standard Schema) · pino + OpenTelemetry SDK 2 · Vitest 4 + Testcontainers
· oxlint + Prettier + dependency-cruiser · ICU MessageFormat catalog shared with the frontend · Next.js 16 LTS + next-intl + Tailwind 4
· .NET 10 LTS for the on-prem hotel agent (Phase 10) · Version policy: latest GA/LTS, never pre-release in the foundation — ADR-0016
· Hosted **on-premises** (Compose → k3s/RKE2, Vault, MinIO, Valkey, Grafana stack) — ADR-0013 · OPERA 5 via FIAS + OWS adapters — ADR-0014 · WhatsApp via Meta Cloud API or BSP adapters with SMS OTP fallback — ADR-0015.

## Repository shape
- `apps/*` compose; `packages/platform/*` are infrastructure; `packages/domain/*` are bounded contexts; `packages/contracts/*` are zod schemas (events, api, connectors, ai-tools).
- A domain package exposes other domains **only** `src/public`. Never import another domain's `infrastructure`, `schema` or repositories. dependency-cruiser enforces this and forbids cycles.
- Each bounded context owns its PostgreSQL schema (`org`, `iam`, `guest`, `catalog`, `ops`, `hk`, `eng`, `inspection`, `relations`, `lostfound`, `logbook`, `comms`, `knowledge`, `ai`, `integration`, `license`, `audit`, `platform`). No domain writes another domain's tables; use its application service or an event.

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
12. AI never writes business tables directly and never calls a provider SDK outside the Model Gateway; AI acts only through registered tools with schema, risk level and required permission; HIGH-risk actions become approval proposals; CRITICAL cannot be executed by AI. Structured live data (counts, states, open tasks) is answered by domain tools, never by RAG; knowledge retrieval always applies tenant/property/audience/classification scope; retrieved documents are untrusted data, not instructions; every significant AI execution is recorded (agent/version, model calls, tool calls, retrieval, policy decisions, approvals, cost, correlation id).
13. Secrets are `SecretRef`s resolved through `SecretProvider`; only `platform-config`/`platform-secrets` read `process.env`; no secret material in tables, logs or fixtures.
14. Entitlement ≠ feature flag ≠ configuration ≠ permission ≠ connector capability ≠ AI policy. Never `if (plan === 'ENTERPRISE')`; use `EntitlementEngine.can(...)`.
15. Branding resolves dynamically (platform → tenant → property → channel); nothing hotel-specific is hardcoded; the `Powered by Planova` footer (link `https://planova.com.eg`) is not removable by brand settings.
16. Unknown external codes create an `integration_exception`; never guess a mapping.
17. Use the injected logger with the CLS context; never `console.log`; no PII in logs.
18. WhatsApp (and every other channel) is a channel adapter behind the Conversation Engine; no module sends through a provider directly.
19. OPERA (and every PMS) is an integration: core domains know only canonical events and commands; guest activation, QR, OTP, identity and grants are platform-owned and require no PMS modification. The PMS remains source of truth for guest/stay/check-in/check-out; the platform never creates guests or stays by itself, and PMS checkout automatically revokes stay-bound access.
20. Support access is explicit, scoped, time-limited, read-only by default, reason-based, audited and revocable; platform administrators have no standing access to guest data.
21. Every column carries a data class (PUBLIC/INTERNAL/CONFIDENTIAL/SENSITIVE/RESTRICTED); retention and anonymization follow the class; deleting a guest never destroys operational/audit integrity (anonymize instead).
22. Every domain module exports a complete `ModuleManifest` (permissions, events, entitlements, AI tools, locale namespaces, integration capabilities, data classes); the manifest tests must pass.
23. Staff UX stays simpler than the backend: never push platform complexity into the staff or guest screens.
24. Naming is binding: events `<context>.<entity>.<event>.vN` (`hotel.*` reserved for canonical PMS events), permissions `<domain>.<resource>.<action>`, locale keys `<domain>.<entity>.<message>`, schemas as listed above.

## Working conventions
- Read `docs/DEVELOPER_GUIDE.md` first; it is the onboarding path and must stay accurate (update it in the same PR as any command or layout change).
- Conventional Commits (`feat(ops): …`, `fix(guest): …`, `docs: …`); scope = package or context code.
- Before coding a phase or module, make sure its section in `docs/BUILD_PLAN.md` has scope, domain model, migrations, APIs, events, permissions, tests and acceptance criteria. Update it if reality differs.
- Migrations: `pnpm db:generate` then hand-review the SQL; expand/deploy/migrate/contract for destructive changes; `pnpm db:check` must pass.
- Tests: unit for domain rules, integration against real Postgres/Redis (Testcontainers), a tenant-leak test for every tenant-scoped module, an e2e scenario for each phase acceptance.
- Commit small, descriptive commits. Branch for this effort: `claude/hopeful-archimedes-jskowx`. Do not open pull requests unless asked.
- Material deviation from the spec ⇒ write an ADR in `docs/adr/` first.
- Complexity belongs in the platform; simplicity belongs in the user experience.
