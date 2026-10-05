# HOTELLA — Build Plan

**Status:** Active execution plan (derived from `docs/spec/HOTELLA_MASTER_SPEC.md` v1.0)
**Version:** 1.5 (Phase 0 delivered and accepted; see `docs/acceptance/phase-0.md`)
**Date:** 2026-10-03
**Audience:** Implementation team / Claude engineering agents

> The Master Spec is the architecture source of truth. This document says *in which order*, *with which concrete technology choices*, and *with which acceptance criteria* we build it. If this plan and the spec disagree, the spec wins and this plan gets corrected (with an ADR if the deviation is material).

---

## 0. How to use this plan

1. Work strictly phase by phase (Spec §84.4). A phase is not "done" until its acceptance criteria pass in CI.
2. Before coding any phase, its section here must contain: scope, domain model, migrations, APIs, events, permissions, tests, acceptance criteria (Spec §84.5). Phases 0–5 already carry that detail below. Phases 6–13 are outlined and get expanded when their predecessor is accepted.
3. Every module follows the **Module Definition of Done** (§9 of this plan) — no exceptions for "internal" modules.
4. Material technology or boundary decisions are recorded in `docs/adr/`. Decisions already taken for Phase 0 are listed in §2.
5. **Traceability:** `docs/TRACEABILITY.md` maps every spec section to the plan section, ADR and phase that satisfies it. A spec requirement with no row there is a planning bug; fix the plan before coding.
6. **Quality gates (every sprint, no exceptions):**
   - *Gate A — Automated:* lint (incl. boundaries, no-`process.env`, no-`console`, no-`gen_random_uuid`), typecheck, unit + integration + contract tests, migration drift check, `en`/`ar` key parity, OpenAPI snapshot. All green in CI before review.
   - *Gate B — Spec review:* reviewer walks the Module Definition of Done (§12) and the relevant TRACEABILITY rows; any invariant in `CLAUDE.md` touched by the change is cited in the PR description with how it is honoured.
   - *Gate C — Docs sync:* BUILD_PLAN section, ADRs, TRACEABILITY and CLAUDE.md updated in the same PR if anything deviated.
   - *Gate D — Acceptance:* the sprint's acceptance checklist is executed and its result recorded in the PR.
7. **Versions:** the **Maturity Gate** of ADR-0016 decides (GA ≥ 6 months with ≥ 2 patches, ecosystem and tooling ready, documented exit path, no node-gyp). Baseline: Node 24 LTS, TypeScript 6, NestJS 11, Zod 4 + nestjs-zod, PostgreSQL 18, Drizzle 0.45, Valkey 9, pnpm 10 (11 after 28 Oct 2026), ESLint 10 + Prettier 3, Vitest 4, OTel SDK 2, Next.js 16 LTS, Tailwind 4, .NET 10 LTS. HOLD with dates: NestJS 12/ESM, TypeScript 7, Node 26, Drizzle 1.0, oxlint. Exact versions are pinned by `pnpm-lock.yaml`; Renovate proposes, CI proves, a human merges; majors change only with an ADR-0016 update.
8. **Naming conventions (binding):**
   - Events: `<context>.<entity>.<past_tense_event>.v<N>` for platform events (e.g. `ops.task.assigned.v1`); `hotel.<entity>.<event>.v<N>` is reserved for canonical PMS/hotel events produced by the Integration Platform (Spec §51).
   - Permissions: `<domain>.<resource>.<action>` or `<resource>.<action>` as in Spec §5 (e.g. `engineering.work_order.create`, `task.assign`).
   - Locale keys: `<domain>.<entity>.<message>` (Spec §79.1). Error codes: same shape, stored in `errors.json`.
   - PostgreSQL schemas: `org, iam, guest, catalog, ops, hk, eng, inspection, relations, lostfound, logbook, comms, knowledge, ai, integration, license, audit, platform`.
   - Tables: snake_case plural; translation tables `<singular>_translations`; history tables keep every row (no updates to closed rows).

---

## 1. Study synthesis — what the spec actually demands

Reading the spec end to end, the product decomposes into **three layers of work**, and the ordering of the roadmap follows directly from their dependencies.

### 1.1 Foundations everything sits on (Spec §2, §65–§74, §79, §82)

| Foundation | Where it bites | Must exist before |
|---|---|---|
| Tenant / property scoping on every row and every request | all domains | Phase 1 |
| Explicit, granular permissions resolved via Membership → Role → Permission | all APIs, all AI tools | Phase 1 |
| Transactional outbox / inbox, idempotent consumers, canonical event envelope (§51) | every cross-domain workflow, every integration | Phase 0 |
| Audit with actor types USER / GUEST / AI_AGENT / SYSTEM / INTEGRATION / SUPPORT (§68) | every important mutation | Phase 1 |
| Localization: external locale resources, translation tables not `*_en/*_ar` columns, locale resolution chain, RTL (§79) | every user-facing string and every localized business entity | Phase 0 |
| Config inheritance Platform → Tenant → Property → Department (§73) | branding, SLA overrides, credits, readiness rules | Phase 1 |
| Observability: correlation_id, trace_id, tenant_id, property_id on every log/trace (§70) | debugging any flow | Phase 0 |
| Secrets abstraction (§67) | any credential | Phase 0 |
| Versioning of published definitions (§82.6) | services, workflows, inspections, prompts, agents, PM procedures, plans | pattern defined in Phase 0, first use Phase 3 |

### 1.2 The unified action gate is the architectural spine (Spec §60, §42)

```text
Action Request
 -> Authorization        (IAM, Phase 1)
 -> Entitlement          (Licensing, stub in Phase 1, real in Phase 11)
 -> Feature Availability (Feature flags, Phase 0/1)
 -> Configuration        (Config service, Phase 1)
 -> Connector Capability (Integration platform, Phase 2 sim / Phase 10 real)
 -> AI Policy            (AI platform, Phase 6)
 -> Execute
```

We build this as **one pipeline with pluggable stages** from Phase 1 onwards, with later stages present as pass-through stubs. Human requests and AI tool calls go through the *same* pipeline (Spec §5 "AI agents must pass through the same authorization/policy layer as human users"). Retro-fitting this later is the single most expensive mistake we can make.

### 1.3 Separation rules that shape the schema (recurring theme in the spec)

| Keep separate | Spec |
|---|---|
| Person ≠ User ≠ Guest | §5 |
| Guest identity ≠ PMS identity (external_references) | §6 |
| Channel identity (phone) ≠ authorization (Guest Access Grant) | §18.3 |
| Room status ≠ cleaning job | §9 |
| Complaint ≠ service request | §12 |
| Alert ≠ notification | §15, §25 |
| Notification intent ≠ delivery channel | §25 |
| Service consent ≠ marketing consent | §26 |
| Entitlement ≠ feature flag ≠ configuration ≠ permission ≠ connector capability ≠ AI policy | §60 |
| Raw vendor message ≠ integration message ≠ canonical event | §50 |
| Short-term conversation state ≠ durable memory | §36 |
| Billing ≠ entitlement | §58 |

### 1.4 The AI layer is a *consumer* of the operations core, never a shortcut around it

Spec §27–§44 and §83. Consequence for sequencing: deterministic workflows, SLA, approvals, service catalog and conversations are all built **before** the first LLM call (Spec §84.14). The first AI phase (Phase 6) then only adds Model Gateway + Agent Runtime + Tool Registry over APIs that already exist and are already authorized/audited.

### 1.5 First commercially meaningful milestone (drives Phases 0–5)

**M1 — "Guest activates and gets served, driven by PMS data, without a live OPERA link yet":**

> Source-of-truth rule for M1 and forever after: the platform does **not** create guests or stays on its own. Guest profile, reservation, check-in, room assignment, room move and check-out all originate from the PMS (OPERA in production). The platform only mints what OPERA does not have: activation tokens, OTP, access grants, sessions, conversations and work. When OPERA checks the guest out, the platform receives `hotel.guest.checked_out.v1` and **automatically** revokes room/stay scopes, ends guest sessions and closes the stay-bound conversation; nobody has to do anything in the platform. "Without OPERA" in M1 means only that during development the PMS simulator stands in for OPERA and emits the exact same canonical events, so the core is not blocked on the hotel link (Spec §85 Phase 2). Phase 10 swaps the simulator for the real FIAS/OWS adapters without touching anything built in Phases 0–6.

```text
Simulated PMS check-in (Phase 2 simulator)
 -> Stay IN_HOUSE -> activation token + URL (Phase 4)
 -> Guest enters mobile -> WhatsApp OTP (abstracted provider) -> Guest Access Grant (Phase 4)
 -> Guest opens service catalog, requests EXTRA_TOWELS (Phase 5)
 -> Service request -> Work Item -> Task -> SLA instance (Phase 3)
 -> Staff sees it in unified inbox, completes it (Phase 4)
 -> Guest receives notification on the verified channel (Phase 3/4)
 -> Full audit trail + correlation id end to end (Phase 0/1)
```

**M2 — "Same flow, in natural language":** Phase 6 adds Guest Concierge over the same tools. Guest types "الجو حر أوي هنا" and the right request is created, deduplicated, routed to Engineering and answered in Arabic.

**M3 — "Operations modules":** Phases 7–9.
**M4 — "Real hotel":** Phase 10 (OPERA 5 agent) + Phase 11 (licensing/control plane).

---

## 2. Decisions locked for Phase 0

All of these are recorded as ADRs in `docs/adr/`. "Locked" means: do not re-open without a new ADR.

| # | Decision | Choice | Rejected alternatives | ADR |
|---|---|---|---|---|
| 1 | Repository | pnpm 10 workspaces + Turborepo 2 monorepo, Node 24 LTS, TypeScript 6 strict, ESM-style source compiled to CommonJS (NestJS 11 supported path; ESM flip planned with NestJS 12) | Nx (heavier), multi-repo (kills bounded-context refactors); Node 26 / TS 7 / Nest 12 held by the Maturity Gate | ADR-0001, ADR-0016 |
| 2 | Database access & migrations | **PostgreSQL 18** + pgvector; **Drizzle ORM 0.45.x** (stable line; core query builder, no relational-query API so the 1.0 move stays mechanical) per bounded context, SQL migration files (generated then hand-reviewed), one migration journal, PostgreSQL schemas per context | Prisma (weak multi-schema, poor control over RLS/raw SQL), TypeORM (migration drift) | ADR-0002, ADR-0016 |
| 3 | Identifiers | Application-generated UUIDv7 (`uuidv7` package), `uuid` columns | DB-generated `gen_random_uuid()` (v4, poor index locality), bigserial (leaks counts, not multi-tenant friendly) | ADR-0003 |
| 4 | Events & async | Transactional **outbox** table → relay worker → **BullMQ** on **Valkey 9** (BSD-licensed RESP store; Redis 8 rejected for licence reasons in an on-prem product) with the 5 spec priority queues; synchronous in-process domain event dispatch inside the same transaction where needed; **inbox** table for idempotent consumers | Kafka/NATS now (new infra dep, Spec §84.17), EventEmitter only (not durable) | ADR-0004 |
| 5 | Validation & contracts | **Zod 4** schemas in `packages/contracts` shared by API DTOs (via `nestjs-zod` on NestJS 11; native Standard Schema once on Nest 12), event payloads, AI tool I/O, connector manifests; OpenAPI generated from the same schemas | class-validator (not reusable for events/tools) | ADR-0005 |
| 6 | Observability | **pino** structured logs, **OpenTelemetry JS SDK 2.x** traces/metrics, request context via AsyncLocalStorage (`nestjs-cls`) carrying `correlation_id`, `trace_id`, `tenant_id`, `property_id`, `actor` | winston, custom middleware | ADR-0006 |
| 7 | Multi-tenancy model | Shared database, shared schema, explicit `tenant_id` columns, repository layer enforces tenant filter, PostgreSQL RLS added as defense-in-depth (Phase 1.3) | schema-per-tenant (migration fan-out), DB-per-tenant (ops cost) | ADR-0007 |
| 8 | Testing | **Vitest 4** unit tests; integration tests with **Testcontainers** (real PostgreSQL 18 + Valkey 9); contract tests for events/connectors; e2e via supertest | Jest (slower), mocking the DB (hides tenant leaks) | ADR-0008 |
| 9 | Frontend stack | Next.js 16 LTS (App Router, React 19) + `next-intl` (ICU, shared catalog with backend) + Tailwind 4 with CSS logical properties for RTL; `apps/guest-web` (PWA) and `apps/staff-web` | Separate SPA frameworks | ADR-0009 |
| 10 | Secrets | `SecretProvider` interface; `EnvSecretProvider` for dev/test, Vault/AWS SM/… adapter for production; secrets never in `settings`/config tables | Reading `process.env` directly in modules | ADR-0010 |
| 11 | Auth tokens | Staff: JWT access (≤15 min) + opaque rotating refresh token (hashed in DB, device-bound, revocable). Guest: passwordless opaque session token (hashed). Passwords: argon2id | Long-lived JWTs, sessions in Redis only | ADR-0011 |
| 12 | API style | REST `/api/v1`, RFC 9457 Problem Details errors with localized `detail`, `Idempotency-Key` on retriable creates, cursor pagination | GraphQL first | ADR-0012 |
| 13 | Lint, format, boundaries | **ESLint 10 + typescript-eslint 8** (type-aware) with core `no-restricted-imports` per layer folder, **package `exports` maps** (runtime + compile-time enforcement), **Prettier 3**, **dependency-cruiser** in CI for cycles, layer rules on resolved paths and the documentation graph: a domain package imports only `@hotella/platform-*`, `@hotella/contracts-*`, and other domains' **`/public`** entrypoint; never another domain's schema/repositories | oxlint (plugins alpha), Biome (no boundary rules), code review only | ADR-0001, ADR-0016 |
| 14 | Hosting | **On-premises**: Docker Compose (pilot) → Kubernetes k3s/RKE2 (production); self-managed PostgreSQL 18 + pgBackRest PITR; Valkey 9; SeaweedFS; OpenBao (Vault KV v2 API; HashiCorp Vault interchangeable) as secrets store; Grafana/Prometheus/Loki/Tempo via OTel collector; hotel agent still connects outbound | Public cloud managed services | ADR-0013 |
| 19 | Hotel ↔ platform link | Outbound-only from the hotel on TCP 443: single-use enrollment token → locally generated key pair → mTLS device certificate; persistent WSS for events/commands + HTTPS for batches; SQLite durable ordered queue with acks; predefined signed commands only; signed offline licence; signed auto-updates with rollback | VPN per site, inbound ports, edge message broker | ADR-0017 |
| 15 | OPERA 5 interfaces | **FIAS over IFC8** primary (real-time GI/GO/GC/RE, DB sync), **OWS (SOAP)** secondary for reservations/profiles/pre-arrival where licensed, optional **read-only DB views** for reconciliation only | OXI (CRS-oriented, extra licensing) | ADR-0014 |
| 17 | i18n engine | **ICU MessageFormat** (`intl-messageformat`) behind our own `I18nService` on the backend, `next-intl` on the frontend → one shared `/locales/{en,ar}` catalog, one parity check; no dependency on third-party Nest i18n modules | nestjs-i18n (lags Nest majors, different format from frontend) | ADR-0016 |
| 18 | Agent runtime | **.NET 10 LTS** for the on-prem hotel agent | .NET 11 (STS, 2-year support) | ADR-0016 |
| 16 | WhatsApp & OTP | `MessagingProvider` abstraction with **Meta Cloud API** and **BSP** adapters selectable per channel; OTP fallback chain WhatsApp → SMS (auto on failure/timeout, manual after 30 s) → optional voice → staff-assisted verification, all deterministic and per-property configurable | Single provider, WhatsApp-only OTP | ADR-0015 |

---

## 3. Repository layout (concrete)

Follows Spec §77 with pnpm package names.

```text
hotella/
├── apps/
│   ├── api/                      # NestJS HTTP API (platform-api)
│   ├── worker/                   # BullMQ consumers, outbox relay, scheduler (platform-worker / scheduler)
│   │                             # apps/worker runs one or more BullMQ queue groups selected by WORKER_QUEUES, so the
│   │                             # six Spec §71 deployables are: api; worker[normal,analytics]; worker[scheduler];
│   │                             # realtime; worker[integration]; worker[background-ai] — same image, different env
│   ├── realtime/                 # WebSocket gateway (Phase 4: runs inside apps/api for now — §8.9 notes for 4.4)
│   ├── guest-web/                # Guest PWA (Phase 5, stack per ADR-0009)
│   ├── staff-web/                # Staff portal (Phase 4+, stack per ADR-0009)
│   ├── pms-simulator/            # Dev-only PMS simulator CLI/HTTP (Phase 2)
│   └── hotel-agent/              # .NET 10 LTS on-prem hotel agent (Phase 10)
├── packages/
│   ├── platform/
│   │   ├── database/             # drizzle client, migration runner, base column helpers, tx helper, migrations/
│   │   ├── events/               # outbox/inbox, envelope, dispatcher, BullMQ queues & priorities
│   │   ├── queue/                # BullMQ wrappers, queue names, worker base
│   │   ├── auth/                 # guards, request actor, permission decorator, action gate pipeline
│   │   ├── observability/        # pino, OTel, CLS request context
│   │   ├── storage/              # S3-compatible client abstraction
│   │   ├── config/               # env schema (zod), hierarchical config service, feature flags
│   │   ├── secrets/              # SecretProvider interface + adapters
│   │   ├── i18n/                 # locale resolution, message catalog loader, translation-table helpers
│   │   └── testing/              # testcontainers harness, factories, test app builder
│   ├── domain/
│   │   ├── organization/         # tenants, organizations, properties, locations, branding
│   │   ├── identity/             # persons, users, memberships, roles, permissions, sessions, support access
│   │   ├── guest/                # guests, stays, party, room assignment history, external refs, preferences, grants
│   │   ├── catalog/              # service definitions/versions/categories/translations
│   │   ├── operations/           # work items, tasks, workflows, SLA, escalation, approvals, alerts, notification intents
│   │   ├── housekeeping/
│   │   ├── engineering/
│   │   ├── inspections/
│   │   ├── relations/            # complaints, service recovery
│   │   ├── lostfound/            # schema lostfound
│   │   ├── logbook/              # schema logbook
│   │   ├── communications/       # channels, conversations, messages, delivery, channel identities, activation, OTP, inbox
│   │   ├── knowledge/            # documents, chunks, embeddings abstraction, retrieval
│   │   ├── ai/                   # model gateway, agents, prompts, tools, context engine, policy, execution audit, memory
│   │   ├── integrations/         # connector defs, instances, capabilities, messages, commands, mappings, reconciliation
│   │   ├── licensing/            # products, modules, features, plans, subscriptions, entitlements, usage
│   │   └── audit/                # append-only audit log
│   └── contracts/
│       ├── events/               # canonical event schemas (zod) + registry, versioned
│       ├── api/                  # shared API DTO schemas, error codes
│       ├── connectors/           # connector manifest/capability contracts (Connector SDK)
│       └── ai-tools/             # tool I/O schemas, risk levels
├── locales/                      # ONE ICU MessageFormat catalog shared by backend (I18nService) and frontend (next-intl)
│   ├── en/  common.json errors.json guest.json housekeeping.json engineering.json …
│   └── ar/  (same keys — parity enforced in CI)
├── infra/
│   ├── docker/                   # docker-compose.dev.yml (postgres16+pgvector, redis7, minio, mailpit) + compose.pilot.yml
│   ├── k8s/                      # Helm charts for on-prem Kubernetes (ADR-0013), added at end of Phase 1
│   └── ci/                       # reusable GitHub Actions workflows
├── docs/
│   ├── spec/HOTELLA_MASTER_SPEC.md
│   ├── BUILD_PLAN.md             # this file
│   ├── TRACEABILITY.md
│   ├── DEVELOPER_GUIDE.md        # onboarding: setup, map, conventions, how to add a module
│   ├── GLOSSARY.md               # EN/AR hotel + platform vocabulary
│   ├── architecture/             # Mermaid diagrams + CI-generated dependency graph
│   └── adr/
├── .github/
│   ├── workflows/ci.yml
│   ├── pull_request_template.md  # Gates A–D checklist
│   └── CODEOWNERS
├── renovate.json  .nvmrc  .editorconfig  .dependency-cruiser.cjs  eslint.config.mjs  .prettierrc
├── CLAUDE.md                     # non-negotiable rules for agents working in this repo
└── package.json  pnpm-workspace.yaml  turbo.json  tsconfig.base.json
```

**Package naming:** `@hotella/platform-database`, `@hotella/domain-guest`, `@hotella/contracts-events`, etc.

**Domain package internal layout (mandatory):**

```text
packages/domain/<ctx>/src/
├── public/            # the ONLY thing other domains may import: interfaces + DTO types + event names
├── application/       # use cases / application services (transaction boundaries live here)
├── domain/            # entities, value objects, invariants, domain events
├── infrastructure/    # drizzle schema (schema.ts), repositories, adapters
├── api/               # NestJS controllers for this context (mounted by apps/api)
├── <ctx>.module.ts
└── index.ts           # re-exports module + public only
```

---

## 4. Phase 0 — Repository & Engineering Foundation (detailed)

**Goal:** a running, tested, observable, bilingual NestJS skeleton with database, Redis, outbox events and CI, such that **no hotel business feature can bypass these foundations** (Spec §85 Phase 0).

**Duration estimate:** 3 sprints (~3 weeks for one focused engineer/agent working continuously).

### Sprint 0.1 — Skeleton & tooling

| # | Task | Done when |
|---|---|---|
| 0.1.1 | `.nvmrc` (Node 24 LTS), Corepack-pinned pnpm 10, pnpm workspace, Turborepo pipeline (`build`, `lint`, `format:check`, `typecheck`, `test`, `depcruise`), `tsconfig.base.json` (TypeScript 6, `strict`, `isolatedModules` + lint-enforced `consistent-type-imports` (`verbatimModuleSyntax` cannot emit CommonJS), `module: nodenext` with CommonJS output, no deprecated options so TS 7 is a no-op later), `typecheck` runs `tsc --noEmit`, emit via SWC (`nest build` with the SWC builder) | `pnpm -r build && pnpm typecheck` pass on empty packages |
| 0.1.2 | ESLint 10 flat config: typescript-eslint (type-aware), `no-restricted-imports` layer rules from §2.13 scoped by folder, `no-console`, `no-restricted-globals` for `process.env`, `no-restricted-imports` for provider SDKs outside the gateway; Prettier 3; dependency-cruiser (`no-circular`, graph) — `pnpm depcruise:graph` renders `docs/architecture/dependency-graph.svg` | lint fails on a deliberate cross-domain import, on `console.log` and on `process.env` in a test fixture; depcruise fails on an injected cycle |
| 0.1.3 | `apps/api`: NestJS 11 app, `/health` (liveness) and `/ready` (checks PostgreSQL + Valkey), global prefix `/api/v1`, graceful shutdown, `nestjs-zod` validation pipe wired with a zod 4 sample DTO | `curl /api/v1/health` returns 200; invalid body returns Problem Details 400 |
| 0.1.4 | `infra/docker/docker-compose.dev.yml`: `pgvector/pgvector:pg18`, `valkey/valkey:9`, `chrislusf/seaweedfs:4.48`, `axllent/mailpit`, `grafana/otel-lgtm` (all-in-one Grafana/Tempo/Loki/Prometheus for dev); `pnpm dev:infra` script | `/ready` green against compose |
| 0.1.5 | `@hotella/platform-config`: zod-validated env schema, typed `AppConfig`, fail-fast on invalid env | app refuses to boot with a missing var and prints the field name |
| 0.1.6 | `@hotella/platform-observability`: pino JSON logs, redaction list (authorization headers, tokens, phone, otp), log level from config | log line contains `correlation_id` placeholder field |
| 0.1.7 | CI (`.github/workflows/ci.yml`): install → lint → typecheck → build → unit tests, with PG/Redis service containers for integration tests | green on the first PR |
| 0.1.8 | `renovate.json` (grouped by ADR-0016 rows, weekly), `.editorconfig`, `.github/pull_request_template.md` (Gates A–D), `CODEOWNERS`, commitlint with Conventional Commits, `docs/DEVELOPER_GUIDE.md` kept in sync with the real commands | a new developer follows the guide from clone to green tests in ≤ 30 minutes (timed once, recorded in the PR) |

### Sprint 0.2 — Data, identity of requests, tests

| # | Task | Done when |
|---|---|---|
| 0.2.1 | `@hotella/platform-database`: Drizzle 0.45 client (core query builder only, ADR-0016), `withTransaction()` helper (AsyncLocalStorage; nested calls join the outer unit of work; `executor(db)` returns the ambient tx) propagating the tx through CLS, base column helpers `baseColumns()` (`id uuid pk`, `created_at`, `updated_at` TIMESTAMPTZ) and `tenantScoped()` (`tenant_id`), `versioned()` (`version int` for optimistic locking) | unit-tested helpers |
| 0.2.2 | UUIDv7 generator `newId()`; lint rule banning `gen_random_uuid()` defaults in schema | tests assert monotonic ordering |
| 0.2.3 | Migration framework: drizzle-kit generates SQL into `packages/platform/database/migrations/<n>_<name>.sql` (one journal, journal table `migrations.journal` in its own schema so migration 0000 owns `CREATE SCHEMA platform`); `pnpm db:migrate`, `pnpm db:generate <name>`, `pnpm db:check` (generates into a temp copy of the journal; any new file = drift = CI failure); each bounded context lives in its own PostgreSQL schema listed in `drizzle.config.ts` `schemaFilter` | CI fails when a schema change has no migration |
| 0.2.4 | Request context (`nestjs-cls`): middleware generates/propagates `X-Correlation-Id`, stores `correlation_id`, `trace_id`, `tenant_id`, `property_id`, `actor` (empty until Phase 1); pino mixin injects them into every log line | integration test asserts the header is echoed and logged |
| 0.2.5 | OpenTelemetry JS SDK 2.x bootstrap (HTTP, pg, ioredis, BullMQ instrumentation), OTLP exporter configured by env, no-op in tests | trace visible in the dev `otel-lgtm` Grafana |
| 0.2.6 | `@hotella/platform-secrets`: `SecretProvider` interface, `EnvSecretProvider`, `SecretRef` type used by config for anything credential-like | `grep process.env` outside platform-config/secrets returns nothing (lint rule) |
| 0.2.7 | `@hotella/platform-testing`: Testcontainers PostgreSQL 18 + Valkey 9 singleton per test run, migration applied, `createTestApp()` builder, DB truncation between tests, factory helpers | one sample integration test passes in CI |
| 0.2.8 | `@hotella/platform-storage`: S3 client abstraction (`putObject`, `getSignedUrl`, `delete`), SeaweedFS in dev | integration test uploads and signs a URL |

### Sprint 0.3 — Events, queues, i18n, API conventions

| # | Task | Done when |
|---|---|---|
| 0.3.1 | `@hotella/contracts-events`: `EventEnvelope` zod schema exactly per Spec §51 (`event_id, event_type, event_version, tenant_id, property_id, source, source_reference, occurred_at, received_at, correlation_id, payload`), `defineEvent('hotel.guest.checked_in', 1, payloadSchema)` registry helper | registry rejects two definitions with the same type+version |
| 0.3.2 | `@hotella/platform-events`: `platform.outbox` table (`id, event_type, event_version, tenant_id, property_id, aggregate_type, aggregate_id, payload jsonb, correlation_id, occurred_at, published_at, attempts, last_error`); `EventPublisher.publish()` writes inside the caller's transaction | integration test: rollback of business tx removes outbox row |
| 0.3.3 | Outbox relay in `apps/worker`: polls unpublished rows (`FOR UPDATE SKIP LOCKED`), pushes to BullMQ, marks published; metrics for lag | relay survives worker restart with no loss/duplication (test) |
| 0.3.4 | `platform.inbox` table + `@Idempotent(consumerName)` decorator for consumers (keyed by `event_id + consumer`) | duplicate delivery processes once (test) |
| 0.3.5 | `@hotella/platform-queue`: BullMQ on Valkey, queues `critical-operational`, `guest-realtime`, `normal`, `analytics`, `background-ai` with separate worker concurrency settings (Spec §71); job base class with retry/backoff/DLQ | jobs land in the right queue by declared priority |
| 0.3.6 | In-process `DomainEventBus` for same-transaction side effects (used only within a bounded context) | documented when to use which (ADR-0004) |
| 0.3.7 | `@hotella/platform-i18n`: own `I18nService` on ICU MessageFormat (`intl-messageformat`) loading `/locales/{en,ar}/*.json` (the same files `next-intl` will load on the frontend); `LocaleResolver` implementing the chain *explicit → user/guest preference → detected → property default → platform default (en)*; `Accept-Language` + `?lang=` + per-actor preference hooks (Phase 1 wires the preference); `translationColumns()` + `translationUnique()` schema helpers (split so Drizzle keeps column types) producing `<entity>_translations(entity_id, locale, …)` with unique `(entity_id, locale)` | test: same key resolves differently per locale; CI check that `ar` and `en` key sets are identical |
| 0.3.8 | Error model: `AppError(code, params)` → RFC 9457 Problem Details with `code` (stable, e.g. `guest.activation.token_expired`) and localized `detail`; error codes documented in `locales/*/errors.json` | unknown code fails tests |
| 0.3.9 | API conventions: versioned routes, `IdempotencyInterceptor` (`Idempotency-Key` header, Valkey-backed, 24h, replays stored response), Valkey rate limiting (per IP now; per actor/tenant in Phase 1), cursor pagination helper, OpenAPI from zod 4 (`nestjs-zod` + `@nestjs/swagger` 11) served at `/api/docs` in non-prod and snapshot-tested | replayed POST returns identical body and `Idempotent-Replayed: true` |
| 0.3.10 | Scheduler base in `apps/worker` (BullMQ repeatable jobs) for later SLA timers, reconciliation, PM | a heartbeat job runs every minute in dev |
| 0.3.11 | Feature flags v0 in `platform-config`: `FeatureFlagService.isEnabled(flag, {tenant, property})` reading a table `platform.feature_flags` with scope columns; explicitly *not* licensing | test shows flag ≠ entitlement call sites |
| 0.3.12 | **Module manifest** (Spec §76 brought forward as an enforcement tool): every domain module exports a `ModuleManifest { code, schema, permissions[], events[], entitlements[], aiTools[], localeNamespaces[], integrationCapabilities[], dataClasses[] }`; a `ManifestRegistry` collects them at boot; tests assert that every permission used in a decorator, every event published, every locale namespace loaded and every table's data class is declared in exactly one manifest | a permission used but not declared fails the test suite |
| 0.3.13 | **Data classification registry** (Spec §67) — *delivered early in Sprint 0.2*: `classify(table, {...})` wraps every table and throws at module load when a column is missing a class (`PUBLIC / INTERNAL / CONFIDENTIAL / SENSITIVE / RESTRICTED`); registry exported for the logger redaction list, the AI redaction policy (Phase 6) and retention policies (Phase 1) | an unclassified column cannot be built or tested |

### Phase 0 acceptance criteria

> **Status: accepted on 2026-10-03** — evidence per item in `docs/acceptance/phase-0.md` (two items need a human walk-through of the Developer Guide).

- [ ] `pnpm install && pnpm dev:infra && pnpm db:migrate && pnpm dev` boots API + worker locally; `/api/v1/ready` is green.
- [ ] CI runs ESLint, Prettier check, dependency-cruiser, `tsc --noEmit`, build, unit + integration tests (real PostgreSQL 18 / Valkey 9), the migration drift check and the OpenAPI snapshot.
- [ ] Every log line carries `correlation_id`; a request's correlation id appears in the outbox row and in the job the relay enqueues.
- [ ] A sample `ping.requested.v1` event published inside a transaction is delivered to a worker consumer exactly once across a forced duplicate delivery.
- [ ] Switching `Accept-Language: ar` changes the error `detail` of a Problem Details response; the `ar`/`en` key-parity check passes.
- [ ] A deliberate cross-domain import fails ESLint (`pnpm lint:selftest` proves five forbidden patterns); a deliberate `process.env` read outside the config package fails ESLint; no `require`/`__dirname` in source (ESM-ready rule) and no node-gyp dependency in the lockfile.
- [ ] No secret value appears in any config table, log line or test fixture.
- [ ] ADR-0001…0016 exist and `CLAUDE.md` reflects them; `docs/DEVELOPER_GUIDE.md` has been followed end-to-end by someone other than its author.

---

## 5. Phase 1 — Organization, IAM & Property (detailed)

> **Status: accepted on 2026-10-03** — evidence per item in `docs/acceptance/phase-1.md` (installing on the target host and the secret-store licence confirmation are owner/operator steps).

**Goal / acceptance (Spec §85):** one user can have different permissions across different properties without data leakage; guest-facing branding resolves dynamically with the Planova attribution preserved.

### 5.1 Scope

Tenants, organizations, properties, generic location tree (rooms as a location specialization), persons, staff users, memberships, roles & permissions, staff sessions, audit baseline, property-scoped authorization, locale preferences, hierarchical configuration, brand profiles with inheritance, branding resolver, platform attribution policy, support-access grants (model only; UI later).

### 5.2 Domain model (PostgreSQL schemas `org`, `iam`, `audit`, `platform`)

```text
org.tenants                (Spec §4.1 columns)                           + version
org.organizations          (Spec §4.2 columns)                           + version
org.properties             id, tenant_id, organization_id, code, name, timezone, currency,
                           default_locale, enabled_locales text[], country, address jsonb,
                           geo point nullable, status, settings jsonb, version
org.locations              id, tenant_id, property_id, parent_id nullable, kind
                           (PROPERTY|BUILDING|FLOOR|ROOM|AREA|PLANT|OTHER), code, path ltree,
                           sort_order, status, metadata jsonb, version
org.location_translations  location_id, locale, name, description
org.rooms                  location_id pk/fk, room_number, room_type_id, bed_config, floor_label,
                           connecting_room_id nullable, attributes jsonb          (specialization of location)
org.room_types             id, tenant_id, property_id, code, capacity, attributes jsonb
org.room_type_translations room_type_id, locale, name, description
org.brand_profiles         id, tenant_id, scope (TENANT|ORGANIZATION|PROPERTY|CHANNEL), scope_id,
                           channel nullable, display_name, logo_asset_id, logo_alt_asset_id,
                           primary_color, secondary_color, cover_asset_ids, favicon_asset_id,
                           typography jsonb (approved fonts only), contact jsonb, social jsonb,
                           ai_persona jsonb (validated against platform policy), presentation jsonb, version
org.brand_profile_translations  brand_profile_id, locale, welcome_text, farewell_text
platform.attribution_policy     singleton rows per tenant: show_powered_by bool (default true),
                                link (default https://planova.com.eg), override_entitlement_ref nullable
                                — NOT editable through brand profile APIs

iam.persons                id, tenant_id nullable (platform staff), given_name, family_name, email, phone, locale_pref, metadata
iam.users                  id, person_id, email (unique per tenant), password_hash (argon2id), status,
                           mfa_enabled, mfa_secret_ref (SecretRef, never plaintext), last_login_at, version
iam.memberships            id, user_id, tenant_id, organization_id nullable, property_id nullable
                           (null = tenant-wide), status, version
iam.roles                  id, tenant_id nullable (null = platform-defined), code, is_system
iam.role_translations      role_id, locale, name, description
iam.permissions            code pk (e.g. task.assign), domain, risk_level, description_key
iam.role_permissions       role_id, permission_code
iam.membership_roles       membership_id, role_id
iam.sessions               id, user_id, refresh_token_hash, device_info, ip, created_at, expires_at,
                           rotated_from nullable, revoked_at, revoke_reason
iam.support_access_grants  id, tenant_id, property_id nullable, granted_to_user_id, reason, scopes text[],
                           read_only bool default true, starts_at, expires_at, approved_by, revoked_at

audit.audit_log            id, tenant_id, property_id nullable, actor_type
                           (USER|GUEST|AI_AGENT|SYSTEM|INTEGRATION|SUPPORT), actor_id, action,
                           entity_type, entity_id, before jsonb, after jsonb, reason, approval_ref,
                           policy_ref, correlation_id, occurred_at — append-only (no UPDATE/DELETE grants)

platform.configuration     id, scope (PLATFORM|TENANT|PROPERTY|DEPARTMENT|MODULE), scope_id, key,
                           value jsonb, version, changed_by, changed_at  + platform.configuration_history
platform.retention_policies id, tenant_id nullable, data_class, entity_type nullable, retain_days, action
                           (DELETE|ANONYMIZE|ARCHIVE), legal_hold bool — framework only in Phase 1; each module
                           declares its data classes (manifest) and implements its purge/anonymize job (DoD §12.15)
```

### 5.3 Application services & APIs (`/api/v1`)

- `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, `POST /auth/mfa/verify` (TOTP), `GET /me` (memberships, effective permissions per property, locale)
- Tenants / organizations / properties CRUD (platform-admin scoped), `GET /properties/:id/locations?tree=1`, locations & rooms CRUD, bulk room import (CSV)
- Roles & permissions: list permissions catalog, role CRUD, assign roles to memberships
- Users & memberships CRUD, invite flow (email via mailpit in dev)
- Configuration: `GET/PUT /config/{scope}/{scopeId}/{key}` with effective-value resolution endpoint
- Branding: brand profile CRUD per scope; **`GET /public/branding?property=…&channel=…`** returns the fully resolved guest-facing brand (used by guest web / QR pages / WhatsApp context) and always includes `attribution: { show: true, label: "Powered by Planova", href: "https://planova.com.eg" }` unless the attribution policy entitlement says otherwise
- Audit: `GET /audit?entity=…` (read-only)
- Support access: request/approve/revoke endpoints (model + API; approval UI later)
- Retention policies: CRUD per tenant/data class (framework; enforcement jobs land with each module)

### 5.4 Authorization & the action gate v1

- `RequestActor` (in CLS): `{ type, userId, tenantId, membershipIds, propertyScope }` resolved from the access token on every request.
- `@RequirePermission('task.assign')` + `@PropertyScoped()` decorators; guard resolves permission through Membership → Role → Permission **for the property in the request** (path/body/query `property_id`); tenant-wide memberships cover all properties.
- Repository base enforces `tenant_id` filter from CLS; a repository method without tenant filter fails a unit test helper (`assertTenantScoped`).
- `ActionGate.execute(actionRequest)` pipeline with stages `authorization` (real), `entitlement`, `feature`, `configuration`, `connectorCapability`, `aiPolicy` (pass-through stubs with interfaces). All controllers that mutate go through it.
- RLS (Phase 1.3): policies on tenant-scoped tables using `current_setting('app.tenant_id')`, set per transaction. Application authorization remains authoritative (Spec §2.2).

### 5.5 Events

```text
org.tenant.created.v1          org.property.created.v1       org.property.updated.v1
org.location.created.v1        org.room.created.v1           org.brand_profile.updated.v1
iam.user.created.v1            iam.membership.changed.v1     iam.role_permissions.changed.v1
iam.session.revoked.v1         platform.configuration.changed.v1
```

### 5.6 Permissions introduced

```text
org.tenant.manage  org.property.read  org.property.manage  org.location.manage
iam.user.read  iam.user.manage  iam.role.manage  iam.membership.manage
config.read  config.manage  branding.read  branding.manage  audit.read
support.access.request  support.access.approve
```

### 5.7 Tests & acceptance

- Integration: user U with role Housekeeping-Supervisor at Property A and Engineer at Property B — `GET /properties/A/...` with engineering permission → 403; cross-tenant id guessing → 404 (never 403 leaking existence).
- Property B's brand profile never resolves for Property A; missing property profile falls back to tenant then platform defaults; attribution survives any brand profile write.
- Refresh token reuse after rotation revokes the whole session chain.
- Every mutating endpoint writes an `audit.audit_log` row with `correlation_id`; the audit table rejects UPDATE/DELETE at the DB grant level.
- Locale: user with `ar` preference gets Arabic error details and Arabic role names from `role_translations`.
- RLS smoke test: direct SQL with wrong `app.tenant_id` returns zero rows.

---

### 5.8 Deployment deliverable at end of Phase 1 (ADR-0013)

First staging environment on the on-prem target: `infra/docker/compose.pilot.yml` (api, worker, scheduler, realtime placeholder, PostgreSQL 18 + pgvector, Valkey 9, SeaweedFS, a real (non-dev) OpenBao secret store, OTel collector + Grafana stack), pgBackRest backup job with a documented restore drill, and operations runbooks (deploy, rollback, backup/restore, secret rotation). Helm charts for Kubernetes follow when the second property/tenant is onboarded.

### 5.9 Sprints and progress

| Sprint | Scope | Status |
|---|---|---|
| 1.1 | `@hotella/platform-auth` (RequestActor in CLS, `@Public`/`@RequirePermission`/`@PropertyScoped`/`@TenantScoped`, global `AuthGuard`, `ActionGate` with pluggable stages, test strategy/resolver); `@hotella/domain-organization` (schema `org`, migration `0002_org_phase1` incl. `ltree`, tenant/property foreign keys on every scoped table, services, controllers, public API, manifest, branding resolver with non-removable attribution); `runMigrations` serialized by a PostgreSQL advisory lock | delivered |
| 1.2 | `@hotella/domain-identity` (schema `iam`, migration `0003_iam_phase1` with hand-reviewed FKs to `org`): persons, users, invitations, roles + translations, permission catalog synced from manifests, system roles (Platform admin, Support, General manager, Duty manager, HK supervisor, Room attendant, Engineer, Front desk, Guest relations — en/ar), memberships (tenant-wide or per property), sessions + refresh-token chain with reuse detection, TOTP MFA, lockout, real `AuthenticationStrategy` + `PermissionResolver`, anti-escalation, `pnpm iam:bootstrap-admin`; platform-auth: property-scope verifier (foreign property → 404), `checkedBy: 'gate'`, optional property scope | delivered |
| 1.3 | `@hotella/platform-audit` (append-only `audit.audit_log`, migration 0004, triggers reject UPDATE/DELETE/TRUNCATE; `AuditWriter` with data-class redaction; `GET /audit`) retrofitted into every org/iam mutation and security event; `@hotella/platform-settings` (migration 0005: typed hierarchical configuration + append-only history, retention policies, attribution policy with CHECK constraint; `/config`, `/retention-policies`); support-access request/approve/revoke with SUPPORT actor, grant-based permissions and per-request audit; RLS (migration 0006) with `FORCE` and transaction-local `app.tenant_id` | delivered |
| 1.4 | Pilot deployment (§5.8): `infra/docker/Dockerfile` (api/worker), `compose.pilot.yml` + `pilot/pilot.sh`, OpenBao (Vault API) secret provider with AppRole, application database role (non-superuser, RLS-bound) + `hotella-db grant`, PostgreSQL+pgBackRest image with restore drill, runbooks (`docs/runbooks/`), CI job "pilot deployment smoke"; Valkey-outage resilience fixes; Phase 1 acceptance (`docs/acceptance/phase-1.md`) | delivered |

Reality notes for 1.1: brand assets are stored as object-storage keys (`logo_asset_key`, `cover_asset_keys`, …) because the asset registry arrives with the knowledge/storage work; the public branding endpoint takes `property` (+ optional `channel`) and resolves platform → tenant → organization → property → channel.

Owner request (Phase 8, between 8.3 and 8.4) — the hotel's own brand in the product: a property manager
(`branding.manage`) edits the property layer from the staff web (`/branding`): `GET|PATCH /properties/:id/branding`
(name and colour; `null` clears so the group's value shows) and `PUT|DELETE /properties/:id/branding/logo` (the raw
image body; PNG/JPEG/WebP read from the bytes, SVG refused, 512 KB at most; stored in object storage under
`brand/<tenant>/`). `GET /public/branding/logo?property=&channel=` serves only the logo the resolved brand points at,
and a brand profile may only reference its own tenant's `brand/` keys (`org.brand_profile.invalid_asset`). Guest web
and staff web show the logo (or the hotel's initials) in their headers and use the hotel colour; both use the Cairo
typeface, self-hosted (`@fontsource-variable/cairo`, OFL); the `Powered by Planova` footer is smaller but keeps its
fixed text and link and is still not a brand setting.

Reality notes for 1.2 (details in ADR-0011 "Implementation notes"):
- `iam.sessions` is the refresh-token family and `iam.refresh_tokens` holds one row per issued token; the plan's single `refresh_token_hash` column could not express reuse detection safely.
- `mfa_secret_ref` became `mfa_secret_enc`: per-user TOTP seeds are sealed with AES-256-GCM under a SecretRef key (`IAM_MFA_KEY_REF`), because secret providers are read-only; `mfa_last_step` blocks code replay.
- Organization-scoped memberships are reserved (column and FK exist, the API grants tenant-wide or per-property only) until a customer needs a group/brand level; the resolver ignores them.
- Platform administrators get exactly the `PLATFORM_ADMIN` role's permissions; staff below tenant-wide level cannot list properties (`GET /properties` is tenant-level) — they see their properties through `GET /me`.
- Invitation tokens are returned once to the inviting administrator until invitations are e-mailed through the
  notification service (moved from Phase 5 to the Phase 7 staff screens; see `docs/acceptance/phase-5.md`).
- Support-access grants: table only in 1.2; request/approve/revoke endpoints land in 1.3 with the audit log they depend on.

Reality notes for 1.3:
- `GET /audit` is tenant- or property-scoped (`audit.read`): general managers hold it, platform administrators do not (audit snapshots may contain hotel data, Spec §64).
- Configuration keys are declared in code (`defineSetting`: zod schema, default, allowed scopes, localized description) and registered by their module; unknown keys cannot be written. DEPARTMENT and MODULE scopes exist in the enum and wait for the operations phases. First keys: `iam.password.min_length` (tenant may raise the floor), `org.property.checkout_time`.
- The attribution policy has no HTTP route yet (control plane, Phase 11); the table refuses a hidden attribution without an entitlement reference.
- Support engineers are platform staff without the administrator flag (`pnpm iam:bootstrap-admin --role support`); they act as actor type `SUPPORT`, only through approved grants, and every request they make is audited (`support.access.use`).
- RLS details and the "application must not connect as a superuser" requirement: ADR-0007 implementation notes.

---

## 6. Phase 2 — Guest, Stay & PMS Canonical Model (detailed)

**Goal:** core guest/stay model driven by canonical PMS events, fully testable with a simulator; no OPERA required (Spec §85 Phase 2).

> **Status: accepted on 2026-10-03** — evidence in `docs/acceptance/phase-2.md`; sprints and reality notes in §6.7.

### 6.1 Domain model (schema `guest`, `integration`)

```text
guest.guests                     id, tenant_id, person_id nullable, primary_locale, vip_code nullable,
                                 status, merged_into_guest_id nullable, version
guest.guest_identifiers          guest_id, kind (EMAIL|PHONE|LOYALTY|DOCUMENT_HASH), value_normalized, verified_at
guest.stays                      id, tenant_id, property_id, status
                                 (EXPECTED|IN_HOUSE|CHECKED_OUT|CANCELLED|NO_SHOW), expected_arrival,
                                 expected_departure, actual_checkin_at, actual_checkout_at, eta,
                                 adults, children, rate_code nullable, market_code nullable, version
guest.reservation_references     stay_id, integration_instance_id, confirmation_number, reservation_status, raw_ref jsonb
guest.stay_party_members         id, stay_id, guest_id, role (PRIMARY|ACCOMPANYING|CHILD), joined_at, left_at
guest.room_assignments           id, stay_id, room_id, assigned_at, unassigned_at nullable, reason
                                 (INITIAL|ROOM_MOVE|UPGRADE|MAINTENANCE), source — history, never overwritten
guest.guest_preferences          id, guest_id, category, key, value jsonb, source (EXPLICIT|INFERRED|PMS), confidence, expires_at
guest.guest_consents             id, guest_id, type (SERVICE_COMMUNICATION|MARKETING_WHATSAPP|MARKETING_EMAIL|PERSONALIZATION),
                                 granted bool, channel, captured_at, evidence jsonb — append history
integration.external_references  internal_entity_type, internal_entity_id, integration_instance_id,
                                 external_entity_type, external_id, first_seen_at, last_seen_at
                                 unique(integration_instance_id, external_entity_type, external_id)
integration.connector_definitions   code, category, capabilities text[], config_schema jsonb, credential_schema jsonb, version
integration.integration_instances   id, tenant_id, property_id, connector_code, name, status, config jsonb,
                                    credential_ref (SecretRef), negotiated_capabilities text[], health_status
integration.integration_messages    id, instance_id, direction, source_message_id, received_at, raw payload (or storage ref),
                                    parse_status, canonical_event_id nullable, error — raw inbox (Spec §50)
integration.integration_mappings    instance_id, mapping_type (ROOM|ROOM_TYPE|RATE|MARKET|STATUS…), external_code,
                                    internal_value, confirmed_by, confirmed_at
integration.integration_exceptions  instance_id, kind (UNKNOWN_MAPPING|PARSE_ERROR|CONFLICT), payload, status, resolved_by
integration.integration_commands    id, instance_id, command_type, payload, idempotency_key unique(instance_id, key),
                                    status (PENDING|SENT|ACKNOWLEDGED|FAILED|EXPIRED), attempts, sent_at, acknowledged_at,
                                    error, correlation_id — durable outbound commands (Spec §53); first used by Phase 8 room restrictions
integration.integration_health      instance_id, status (HEALTHY|DEGRADED|OFFLINE|MISCONFIGURED|AUTH_FAILED), last_success_at,
                                    last_failure_at, latency_ms_p95, queue_depth, error_rate, agent_last_seen_at, updated_at
                                    (Spec §57; alerts deduplicated through ops.alerts)
integration.reconciliation_runs / reconciliation_results  run_id, instance_id, entity_type, outcome
                                    (MATCH|MISSING_INTERNAL|MISSING_EXTERNAL|DIFFERENT), details — Spec §52; simulator-driven in Phase 2
guest.guest_data_requests           id, tenant_id, guest_id, kind (EXPORT|CORRECTION|ANONYMIZE|DELETE), status, requested_by_actor,
                                    reason, completed_at, result_asset_id — Spec §69; anonymization keeps operational/audit integrity
```

### 6.2 Canonical events (contracts, Spec §51)

```text
hotel.reservation.created.v1   hotel.reservation.updated.v1   hotel.reservation.cancelled.v1
hotel.guest.checked_in.v1      hotel.guest.checked_out.v1     hotel.stay.room_changed.v1
hotel.guest.profile_updated.v1 hotel.room.status_changed.v1 (consumed by HK in Phase 7)
```

Pipeline per Spec §50: raw vendor message → `integration_messages` → parser → mapper (unknown code ⇒ `integration_exceptions`, never guess) → canonical event (outbox) → `guest` domain consumer (idempotent via inbox) → stay state machine.

### 6.3 Simulator (`apps/pms-simulator`)

Connector `SIM_PMS` implementing the Connector SDK contract v0 **and the agent link protocol of ADR-0017** (enrollment, mTLS, WSS frames with sequence numbers and acks, HTTPS batches) from a container, so the platform-side gateway is production-tested long before the .NET agent exists: HTTP endpoints / CLI to create reservations, check in, move rooms, check out, send duplicates and out-of-order messages. It emulates **two faces** so capability negotiation is exercised before Phase 10 (ADR-0014): an event stream shaped like FIAS (in-house events only, no future reservations) and a query API shaped like OWS (future reservations, profiles, ETA). Instances can be configured with either or both faces. Used by all later phases' integration tests. Also a scripted scenario file format (YAML) replayable in CI.

### 6.4 APIs

`GET /guests/:id`, search, merge (approval-gated later), `GET /stays?status=IN_HOUSE&property=`, `GET /stays/:id` (with party, current room, assignment history), `GET /rooms/:id/current-stay`, preferences & consents CRUD, external reference lookup, integration instances CRUD, mapping confirmation, exceptions queue, integration health read, reconciliation run/trigger/results, guest data requests (export → JSON asset; anonymize → pseudonymised profile with audit/ops rows intact).

### 6.5 Permissions

`guest.read guest.manage guest.merge guest.data_request.manage stay.read stay.manage integration.read integration.configure integration.replay integration.mapping.confirm integration.reconcile`

### 6.6 Acceptance

- Simulator check-in creates guest + stay + party + room assignment via canonical event; replaying the same source message changes nothing.
- Room move creates a second `room_assignments` row and closes the first; `GET /rooms/504/current-stay` flips.
- Unknown room code from the simulator yields an `integration_exceptions` row and no stay; confirming the mapping and replaying resolves it.
- PMS ids never appear as `id` of any `guest.*` row (test over schema).
- Reconciliation against the simulator reports MATCH for a clean run and the correct outcome for each injected discrepancy.
- Anonymizing a checked-out guest removes identifying fields and identifiers while stays, work history and audit rows remain queryable.
- Checkout emits `hotel.guest.checked_out.v1` consumed later by grants (Phase 4) and HK (Phase 7).
- No API or UI path creates a guest or stay outside the canonical-event consumer (staff can only *view*, *merge*, annotate preferences/consents); a test asserts the stay state machine is driven exclusively by PMS events.

### 6.7 Sprints and progress

| Sprint | Scope | Status |
|---|---|---|
| 2.1 | `@hotella/contracts-connectors` (Connector SDK v0: categories, capabilities, `defineConnector`, raw message, `ParseContext`, connector-neutral `InboundRecord`, `RECORD_CAPABILITY`, ordering keys, wall-clock → UTC helper); canonical `hotel.*` events + `integration.exception.opened.v1` / `integration.health.changed.v1`; `@hotella/domain-integrations` (schema `integration`, migration `0007_integration_phase2` with hand-reviewed FKs to `org` and forced RLS): connector catalog synced at boot, instances with enabled ∩ reported capabilities, raw inbox with replay-safe ingest, `SIM_PMS` adapter (FIAS-shaped records + OWS-shaped JSON), mapper with required/optional mapping types, deduplicated exceptions, HELD successors, replay, external references API, health counters, action-gate connector-capability stage; `TransactionRunner.read()` and tenant-pinned event consumers; RLS coverage test | delivered |
| 2.2 | `@hotella/domain-guest` (schema `guest`, migration `0008_guest_phase2` with FKs to `org`/`integration`, period CHECKs, forced RLS): guests, identifiers, stays, reservation references, party, room-assignment history; `StayProjector` = the only writer of stays (pure state machine, out-of-order safety, PMS reinstatements, per-reservation advisory locks), `guest.stay.created/status_changed/room_changed.v1`; read-only staff API (`/properties/:id/stays`, `/stays/:id`, `/rooms/:roomId/current-stay`, `/guests`, `/guests/:id` with masked contacts); worker runs the projector (`GuestEventsModule`); `AuditCoreModule` / `IntegrationsCoreModule` / `GuestCoreModule` without HTTP routes for background processes | delivered |
| 2.3 | Agent link (ADR-0017): `@hotella/platform-pki` (agent CA, CSR → device certificate, Ed25519 canonical signatures); link frames in `contracts-connectors`; migration `0009_agent_link` (`agent_links`, `enrollment_tokens`); `EnrollmentService` (single-use tokens, enroll, renew, revoke), `AgentLinkService` (hello/capabilities, ordered cumulative acks, resend, gap exception, heartbeats → health, signed command delivery/results), `INTEGRATIONS_API.requestCommand`; `apps/agent-gateway` (TLS 1.3 + client certificates, no staff routes); `apps/pms-simulator` (reference agent: durable queue, reconnect, chaos, FIAS/OWS faces, YAML scenarios, `RESYNC_IN_HOUSE`); pilot: gateway service, agent PKI in OpenBao, `pilot.sh simulate`, CI smoke through the deployed worker | delivered |
| 2.4 | Reconciliation (Spec §52): database-sync records (FIAS DS/DR/DE) become a PMS snapshot on a run started by staff (`POST …/reconciliations` → `RESYNC_IN_HOUSE` command), the guest context's `StayReconciler` compares it deterministically (`reconcileInHouse`) and reports MATCH / MISSING_INTERNAL / MISSING_EXTERNAL / DIFFERENT back; non-matches open exceptions, nothing is auto-corrected. Guest data: preferences (EXPLICIT/INFERRED with confidence), append-only consent history (DB trigger), merge of duplicates (stays, party, identifiers, preferences, consents and PMS profile links follow the survivor; MERGED tombstone), data-subject requests (EXPORT returned once with only its SHA-256 kept; ANONYMIZE/DELETE anonymize, unlink PMS profiles and scrub raw vendor payloads; CORRECTION recorded for the PMS). Migration `0010`. Phase 2 acceptance record | delivered |

Reality notes for 2.1:
- `integration_instances` stores `enabled_capabilities` (administrator) and `reported_capabilities` (agent, from 2.3); the effective set is their intersection, and only for `ACTIVE` instances. The plan's single `negotiated_capabilities` column could not tell the two apart.
- Mapping types are split into REQUIRED (`ROOM`, `ROOM_STATUS`: the message waits as `PENDING_MAPPING`) and OPTIONAL (`RATE`, `MARKET`, `VIP`: the canonical field is `null`). Both raise a deduplicated `UNKNOWN_MAPPING` exception; nothing is inferred. `POST …/mappings/rooms-by-number` is an explicit administrator confirmation that PMS room codes equal Hotella room numbers (exact matches only).
- Ordering: a message whose reservation/room key is shared with an earlier blocked message is `HELD` and released, in order, when the blocker is processed. Exception kinds gained `UNSUPPORTED_MESSAGE` (message type or capability not enabled).
- Protocol-defined FIAS values (e.g. `RS` maid status 1–6, `YYMMDD` dates) are translated by the adapter; hotel-defined codes (rooms, rates, VIP) always go through mappings. FIAS wall-clock times are converted with the property timezone.
- Raw message payloads (SENSITIVE) are not exposed through the staff API; staff see message metadata, status and error.
- Ingestion has no staff HTTP endpoint on purpose: messages enter only through the agent link (2.3), authenticated as the instance (actor `INTEGRATION`).

Reality notes for 2.2:
- `guests.person_id` is not created: no flow links a guest to a staff person yet; it arrives with the use case. `party_role` has PRIMARY and ACCOMPANYING (children are counted on the stay; FIAS/OWS give no per-child profile).
- Guest resolution is deterministic and conservative: by the PMS profile reference, else by exact name inside the same stay's party (a repeated snapshot), else a new guest. Nothing is matched across stays by name, e-mail or phone; duplicates are merged by staff (2.4).
- Downstream contexts consume `guest.stay.*` events (internal ids) rather than `hotel.*` (vendor references): Phase 4 grants revoke on `guest.stay.status_changed.v1` → `CHECKED_OUT`.
- A check-out, room move or cancellation for an unknown reservation is logged and ignored (nothing to close); reconciliation (2.4) reports it. A reference to a missing stay fails the job loudly (dead-letter set).
- Staff see guest contact identifiers masked; full values are used by the communication channels (Phase 4).

Reality notes for 2.3 (details in ADR-0017 "Implementation notes"):
- The gateway is a separate process (`apps/agent-gateway`, Nest application context + its own TLS listener) rather than routes of the API, so the internet-facing agent endpoint exposes nothing else and holds WebSockets independently of API deploys.
- Device certificates use ECDSA P-256 (portable to .NET TLS); commands are signed with Ed25519 as decided. X.509 issuance uses `@peculiar/x509` (ADR-0016 row "Agent link").
- `ReplayService` was split from `IngestService`, and `HealthService` from both, so the ingest path needs no staff action gate.
- Rate limiting is a per-instance throttle frame (200 frames/s); hard limits arrive with the licensing/metering work (Phase 11).
- Gate defect found and fixed: `pnpm db:check` passed vacuously since Phase 0 — drizzle-kit could not open the absolute temporary `out` path, printed the error and exited 0, so no drift migration was ever generated. The scratch journal now lives under the package (relative path), any drizzle-kit error fails the check, and drift was proven to be detected (temporary column → exit 2). The existing schema had no drift.

Reality notes for 2.4:
- FIAS `DR` records are no longer applied as check-ins: a database sync is a snapshot for reconciliation, and differences become exceptions (ADR-0017 §4: never silent fixes). A sync the platform did not request still gets its own run.
- The comparison runs in the guest context (owner of stays) and reports back through `INTEGRATIONS_API.completeReconciliation`, so the dependency stays guest → integrations.
- Guest audit entries record which fields changed, never their values: the audit log is append-only, so personal data in it could not be anonymized (Spec §69). The projector was corrected accordingly.
- Data exports are returned in the response and not stored (only their SHA-256); an object-storage export with expiring links arrives with the asset registry. `DELETE` requests are executed as anonymization to keep operational and audit integrity (CLAUDE.md rule 21).
- Published outbox rows still hold canonical payloads (names) until a retention job purges published events (scheduled with the operations scheduler in Phase 3).

---

## 7. Phase 3 — Operations Engine (detailed)

**Goal / acceptance (Spec §85):** multiple future modules create work through one engine; SLA deterministic; approvals generic.

> **Status: accepted on 2026-10-03** — evidence in `docs/acceptance/phase-3.md`; sprints and reality notes in §7.7. Package `@hotella/domain-operations` (context code `ops`).

### 7.1 Domain model (schema `ops`)

```text
ops.work_items              id, tenant_id, property_id, kind (SERVICE_REQUEST|HK_JOB|WORK_ORDER|INSPECTION|COMPLAINT|…),
                            source_entity_type, source_entity_id, title_key/params or title, status, priority,
                            location_id nullable, guest_id nullable, stay_id nullable, department_code,
                            workflow_instance_id nullable, sla_instance_id nullable, correlation_id, version
ops.tasks                   id, work_item_id, tenant_id, property_id, status (NEW|ASSIGNED|ACCEPTED|IN_PROGRESS|PAUSED|
                            DONE|CANCELLED|REJECTED), priority, due_at, location_id, department_code,
                            current_assignee_user_id nullable, started_at, completed_at, version
ops.task_assignments        id, task_id, assignee_type (USER|TEAM|AI|ROBOT), assignee_id, assigned_by_actor,
                            assigned_at, unassigned_at, reason — history
ops.task_events             id, task_id, type, actor, payload, occurred_at — operational history
ops.workflow_definitions    id, tenant_id nullable, code, status
ops.workflow_versions       id, definition_id, version, definition jsonb (states, transitions, guards, actions), published_at, immutable
ops.workflow_instances      id, version_id, work_item_id, current_state, context jsonb, version
ops.workflow_transitions    id, instance_id, from_state, to_state, trigger, actor, occurred_at
ops.sla_policies            id, tenant_id, property_id nullable, department_code nullable, service_code nullable,
                            response_minutes, resolution_minutes, business_hours_ref, pause_rules jsonb, escalation_rules jsonb, version
ops.sla_instances           id, work_item_id, policy_id, response_due_at, resolution_due_at, paused_at, paused_total_sec,
                            response_met_at, resolution_met_at, breached_at, status
ops.escalations             id, sla_instance_id, level, triggered_at, notified_actor_refs, acknowledged_by, acknowledged_at
ops.approval_requests       id, tenant_id, property_id, kind, subject_type, subject_id, requested_by_actor, payload,
                            risk_level, status (PENDING|APPROVED|REJECTED|EXPIRED), decided_by, decided_at, decision_reason, expires_at
ops.alerts                  id, tenant_id, property_id, type, severity, dedupe_key unique(active), status, evidence jsonb,
                            first_seen_at, last_seen_at, acknowledged_by, resolved_at
ops.notification_intents    id, tenant_id, property_id, recipient_type (USER|GUEST|ROLE|DEPARTMENT), recipient_id,
                            template_key, params jsonb, priority, critical_override bool, status, created_at
ops.notification_deliveries id, intent_id, channel (PUSH|WHATSAPP|EMAIL|SMS|IN_APP), status, provider_ref, attempts, last_error
ops.notification_preferences actor_type, actor_id, template_key/category, channel, enabled
ops.business_hours          id, tenant_id, property_id, department_code nullable, schedule jsonb, timezone
ops.sla_pauses              id, sla_instance_id, reason, paused_at, resumed_at — pause history (rule 10), totals derive from it
-- owned by the organization context (Spec §80 "Property → Departments"); ops references departments by code
org.departments             id, tenant_id, property_id, code unique per property, status, version
org.department_translations department_id, locale, name
```

Work-item kinds are not an enum: a module registers the kinds it creates (`WorkItemKindRegistry.register('HK_JOB', …)`) at
module init; creating a work item of an unregistered kind is rejected. This is what lets future modules use the engine
without a migration of `ops`.

### 7.2 Engine rules

- **SLA** computed by a pure, unit-tested function `computeSlaDeadlines(policy, businessHours, now)`; timers via scheduler jobs on the `critical-operational` queue; breach ⇒ escalation ⇒ alert (deduped) ⇒ notification intent. No LLM anywhere in this path (Spec §8.3, §82.25).
- **Workflow**: JSON state machine interpreted by a deterministic engine; guards are named predicates registered in code; actions are named handlers (create task, start SLA, notify, request approval). Versions immutable once `published_at` set.
- **Approvals**: one engine used by compensation/refund/OOO/AI proposals; subject carries risk level; decision audited.
- **Delivery adapters**: `IN_APP` and `EMAIL` (mailpit) in this phase; `WHATSAPP` adapter lands in Phase 4; `PUSH` with staff web.

### 7.3 APIs / permissions / events (abridged)

APIs: work items & tasks list/filter (my tasks, department, property), assign/accept/start/pause/complete/cancel, workflow definitions CRUD + publish, SLA policies, approvals inbox (pending/decide), alerts (ack/resolve), notification preferences.

Permissions: `task.read task.assign task.accept task.complete task.cancel workflow.manage sla.manage approval.read approval.decide alert.read alert.ack notification.preferences.manage`

Events: `ops.work_item.created.v1`, `ops.task.assigned.v1`, `ops.task.status_changed.v1`, `ops.sla.breached.v1`, `ops.escalation.triggered.v1`, `ops.approval.requested.v1`, `ops.approval.decided.v1`, `ops.alert.raised.v1`, `ops.notification.requested.v1`

### 7.4 Acceptance

- Two different "modules" (a test module A and B) create work items and get tasks, SLA and escalation without any module-specific task table.
- SLA with business hours 08:00–20:00 and a pause correctly shifts deadlines (table-driven tests across DST in `Africa/Cairo`).
- Same alert condition raised 50 times produces one active alert with `last_seen_at` updated.
- Approval of a HIGH-risk subject is required before the subject's handler runs; expiry closes it.
- Assignment history is complete after assign → reassign → unassign.

### 7.5 Task lifecycle (deterministic, unit-tested)

```text
NEW ──assign──▶ ASSIGNED ──accept──▶ ACCEPTED ──start──▶ IN_PROGRESS ──complete──▶ DONE
 ▲                 │  └──reject (assignee)──▶ NEW (assignment closed, reason REJECTED)
 └───unassign──────┘                          IN_PROGRESS ──pause(reason)──▶ PAUSED ──resume──▶ IN_PROGRESS
any non-terminal ──cancel(reason)──▶ CANCELLED;   reassign = close current assignment + open a new one (ASSIGNED)
```

Assignees act on their own tasks with `task.accept`/`task.complete`; supervisors (`task.assign`) may act on any task of
the property. Work-item status derives from its tasks: OPEN → IN_PROGRESS (a task accepted/started) → RESOLVED (all
tasks terminal, at least one DONE) or CANCELLED (all cancelled). Every transition writes `ops.task_events` and an
`ops.task.status_changed.v1` event; the row's `version` guards concurrent updates.

### 7.6 Migrations and tests

- `0011_ops_core` (departments, work items, tasks, assignments, task events), `0012_ops_sla` (business hours,
  policies, instances, pauses, escalations, alerts), `0013_ops_workflow_approvals`, `0014_ops_notifications`; every
  tenant-owned table gets forced RLS and tenant/property FKs; published workflow versions are protected by a trigger.
- Unit: task state machine, work-item status derivation, `computeSlaDeadlines` table (business hours, overnight
  schedules, pauses, DST in `Africa/Cairo` and a zone with a gap), escalation ladder, workflow interpreter, approval
  expiry, alert dedupe key.
- Integration (real PostgreSQL/Valkey): two test modules create work through `OPERATIONS_API`; assignment history;
  SLA timers fire through the `critical-operational` queue and breach → escalation → alert → notification intent;
  approvals gate a HIGH-risk handler; 50 identical alert raises → one alert; tenant-leak test (404 + RLS).
- e2e: API routes for tasks/approvals/alerts with the role catalog (General manager, Duty manager, department staff).

### 7.7 Sprints and progress

| Sprint | Scope | Status |
|---|---|---|
| 3.1 | `org.departments` (+ translations, API, `ORGANIZATION_API.getDepartment`); `@hotella/domain-operations`: work items, tasks, assignment history, task events; kind registry; `OPERATIONS_API.createWorkItem/addTask`; task lifecycle API (assign/unassign/accept/reject/start/pause/resume/complete/cancel); `my tasks`/department/property lists; events `ops.work_item.created.v1`, `ops.work_item.status_changed.v1`, `ops.task.assigned.v1`, `ops.task.status_changed.v1`; permissions; role grants | delivered |
| 3.2 | `@hotella/platform-time` (IANA wall clock ↔ UTC); business hours; SLA policies with property/department/service overrides; `computeSlaDeadlines`; SLA instances started by work items, paused/resumed by task pauses with policy pause rules; timers on `critical-operational` + a sweep; breach → escalation ladder → deduplicated alert; `ops.sla.breached.v1`, `ops.escalation.triggered.v1`, `ops.alert.raised.v1` | delivered |
| 3.3 | Workflow definitions/versions (immutable once published), deterministic interpreter with code-registered guards and actions (create task, start SLA, notify, request approval); generic approval engine (risk level, expiry job, audited decisions, handler registry); `ops.approval.requested.v1`, `ops.approval.decided.v1` | delivered |
| 3.4 | Notification intents (from escalations and alerts) and deliveries; `IN_APP` inbox and `EMAIL` (SMTP, Mailpit locally) adapters; preferences with critical-policy override; outbox retention purge; Phase 3 acceptance (`docs/acceptance/phase-3.md`) | delivered |

Reality notes for 3.4:
- Notification intents name a user, everyone holding a role, or everyone holding a permission at the property; the
  worker's dispatcher (an inbox consumer of `ops.notification.requested.v1`) expands them into one delivery per person
  and channel, idempotently (unique per intent, person and channel). Rules turn engine events into intents:
  escalations → the ladder's roles (severity sets the priority; CRITICAL overrides preferences), approval requests →
  holders of `approval.decide`, task assignments → the assignee.
- Channels by priority: NORMAL in-app; HIGH and CRITICAL in-app + e-mail. Preferences are per user, category and channel
  (`notification_preferences`, keyed by user instead of the plan's actor type/id: guests get channels in Phase 4).
  `PUSH` arrives with the staff app, `WHATSAPP`/`SMS` with the Phase 4 adapters; until then they are recorded as
  skipped. `DEPARTMENT` recipients wait for department membership (see 3.1 notes).
- E-mail goes through `EMAIL_CHANNEL` (SMTP via `nodemailer` 8, ADR-0016 row; Mailpit locally). A 10 s job sends due
  deliveries with retries (1, 2, 4, 8 minutes, then FAILED); a delivery records the transport error code, never its
  message (it can echo the address). Subjects and bodies are ICU templates rendered per recipient locale; the inbox
  renders them in the reader's locale; intents store keys and parameters only.
- Retention of delivered events (Phase 2 open item): `EventRetention` purges published outbox rows after
  `EVENTS_OUTBOX_RETENTION_DAYS` (7) and processed inbox rows after `EVENTS_INBOX_RETENTION_DAYS` (30), hourly from the
  worker. Pending outbox rows are never touched.
- Pilot hardening found on the way: the pgBackRest stanza is now created when the pilot database starts (WAL archiving
  without it made PostgreSQL restart its processes), and the reference agent no longer strands a message held back by
  the reorder chaos.
- Stay projection ordering (Phase 2 defect the deployed pipeline exposed): facts of one stay are processed concurrently
  (two queues, concurrency per queue), so a check-out, room move or cancellation could reach the projector before the
  check-in and be dropped. A fresh fact for an unknown stay now fails with `StayNotYetKnownError` and the queue retries
  it (20 s window, then it is reported and ignored as before); an assignment older than the current in-stay assignment
  never moves the guest back. Covered by "facts delivered before their check-in are retried…" in the guest suite.

Reality notes for 3.3:
- Workflow definitions and versions are property-scoped (like SLA policies). A version is a draft until published;
  publishing validates it against the registered guards and actions, retires the previous published version and freezes
  it — a database trigger refuses any later change except retiring, and any deletion (CLAUDE.md rule 9). Running
  workflows stay on the version they started with.
- Triggers are the task lifecycle (`TASK_ACCEPTED/STARTED/COMPLETED/CANCELLED`), approval outcomes
  (`APPROVAL_APPROVED/REJECTED/EXPIRED`) and named staff actions (`MANUAL:<ACTION>`, permission `task.assign`). SLA
  breaches do not drive workflows yet (escalation covers them). Built-in guards: `all_tasks_done`, `no_open_tasks`,
  `has_open_tasks`, `last_approval_approved`; actions: `create_task`, `request_approval`, `cancel_open_tasks` — modules
  add theirs through the registry. Actions never fire triggers, so a move cannot recurse.
- While a workflow runs, a work item does not become RESOLVED/CANCELLED just because its current tasks are finished: it
  stays IN_PROGRESS until the workflow reaches a terminal state, then follows its tasks again. A work item started with a
  workflow gets its tasks from the workflow (no default task).
- Approvals: kinds are registered with an optional handler that runs inside the approving transaction (a failing handler
  rolls the approval back). Only a person may decide, never the requester (four eyes); an AI agent cannot request a
  CRITICAL action; undecided requests expire (default 1 h CRITICAL, 4 h HIGH, 24 h otherwise) through
  `ops.approval.expire` (every minute on `critical-operational`). Every request and decision is audited with
  `approvalRef`.
- The worker now runs the full engine (approval expiry moves workflows): it composes route-free modules of the contexts
  the engine looks up — `OrganizationCoreModule` (branding resolution is not available there) and
  `IdentityDirectoryModule` — next to `GuestCoreModule`. This is the pattern later phases use to create work from events.

Reality notes for 3.2:
- Timers are one repeatable job, `ops.sla.sweep` every 15 s on `critical-operational`, over an indexed `next_check_at`
  (claimed with `FOR UPDATE SKIP LOCKED`, so several workers are safe), instead of one delayed job per deadline. Targets
  are minute-based; the API path never depends on Valkey; evaluation is idempotent (`evaluateSla`, unit-tested).
- SLA state follows the tasks inside the same transaction: the response target is met by the first accept/start/complete,
  the resolution clock pauses only while every open task is paused for a reason the policy lists (e.g. `WAITING_GUEST`)
  and its deadline is recomputed from the pause history; resolution/cancellation of the work item closes the SLA.
- An SLA copies targets, calendar (business hours + the property's time zone) and escalation ladder from its policy when
  it starts, so policy edits never move running deadlines. `ops.business_hours` has no time-zone column (the property's
  is used) and no `department_code`: department hours are a separate code chosen by a department-matched policy.
- Policies are property-scoped in this sprint (the property is the broadest override); a tenant-wide default comes with
  multi-property chains if needed. Selection is deterministic: service > department > priority > kind, ties by id.
- Alerts moved here from 3.4 because escalation needs them: one active alert per dedupe key (partial unique index +
  `ON CONFLICT`), repeats count and only raise severity, SLA alerts close themselves (SYSTEM) when the response is met
  or the work is resolved/cancelled. Escalations record the roles to notify; intents for them arrive in 3.4.
- `@hotella/platform-time` converts wall clock ↔ UTC with ECMAScript Temporal's `compatible` disambiguation (a
  non-existent local time moves forward by the gap; a repeated one takes the earlier instant).

Reality notes for 3.1:
- Tasks keep the plan's status set without `REJECTED`: an assignee who rejects a task hands it back (`ASSIGNED → NEW`, the
  assignment closes with end reason `REJECTED`); cancelling is `CANCELLED`. Starting implies accepting, and completing is
  allowed from any owned status, so staff screens stay one tap (CLAUDE.md rule 23).
- `tasks.current_assignee_user_id` became `assignee_type` + `assignee_id`: a task can wait in a department's queue
  (`TEAM` = the department) and any member claims it (`CLAIM` in the history, the team assignment closes with `CLAIMED`).
  `AI` and `ROBOT` are reserved. Department membership of staff is not modelled yet: anyone with `task.accept` at the
  property may claim; it arrives with the Phase 7 staff screens if hotels need it (not needed for M1).
- Supervisors (`task.assign`) may act for an assignee; such actions are audited with `onBehalf`. Assignments, unassignments
  and cancellations are audited; every transition is in `ops.task_events`, append-only at the database level (only a
  free-text reason may be cleared, for anonymization).
- Work items carry `source_module/source_entity_type/source_entity_id`; titles are a locale key with parameters or quoted
  free text (CONFIDENTIAL). Anonymizing a guest must also clear free-text titles that quote them — wired when the first
  guest-facing source (service requests, Phase 5) exists.
- Departments live in the organization context (`org.departments`), referenced by code with a composite foreign key
  `(property_id, department_code)`. Permission `org.department.manage` (platform admin, general manager).
- Defects found and fixed on the way: the identity catalog sync let a partial process (the admin CLI) strip the grants of
  modules it does not load, which broke the Phase 2 pilot smoke; the check that system roles grant only declared
  permissions moved to `apps/api` (`test/role-catalog.spec.ts`), because identity cannot import contexts that depend on it.

---

## 8. Phase 4 — Communications & Guest Identity (detailed)

**Goal / acceptance (Spec §85):** a checked-in guest activates without OPERA modification and is later recognized automatically on the verified channel.

> **Status: accepted on 2026-10-03** — evidence in `docs/acceptance/phase-4.md` (the staff inbox UI that ADR-0009 places in this phase landed in Sprint 4.5). Design decisions in §8.7, sprints and reality notes in §8.9. Package `@hotella/domain-communications` (context code `comms`); grants and guest sessions in `@hotella/domain-guest`.

### 8.1 Domain model (schema `comms`, plus `guest` additions)

```text
comms.channels                  id, tenant_id, property_id, type (WHATSAPP|GUEST_WEB|ROOM_QR|EMAIL|SMS|VOICE|MESSENGER|INSTAGRAM|APP),
                                provider_code, config jsonb, credential_ref, status, brand_profile_id nullable
comms.channel_identities        id, tenant_id, channel_type, identifier_normalized (E.164 phone, email…), guest_id nullable,
                                verified_at, last_seen_at — identity ≠ authorization
comms.conversations             id, tenant_id, property_id, subject_type (GUEST|STAFF_INTERNAL), guest_id, stay_id nullable,
                                status (OPEN|WAITING_GUEST|WAITING_STAFF|HANDED_OFF|CLOSED), assigned_user_id nullable,
                                ai_mode (OFF|ASSIST|AUTO), handoff_reason nullable, last_message_at, version
comms.conversation_participants id, conversation_id, participant_type (GUEST|STAFF|AI|SYSTEM|EXTERNAL), participant_ref, joined_at, left_at
comms.messages                  id, conversation_id, channel_id, direction, sender_participant_id, type
                                (TEXT|IMAGE|AUDIO|VIDEO|DOCUMENT|LOCATION|INTERACTIVE|SYSTEM), body text, media_asset_id,
                                locale_detected, provider_message_id, reply_to_message_id, created_at
comms.message_delivery_events   id, message_id, status (QUEUED|SENT|DELIVERED|READ|FAILED), provider_payload, occurred_at
comms.activation_tokens         id, tenant_id, property_id, stay_id, token_hash, purpose, expires_at, used_at, revoked_at, created_by
comms.verification_sessions     id, tenant_id, property_id, stay_id nullable, room_id nullable, phone_normalized, otp_hash,
                                attempts, max_attempts, expires_at, verified_at, channel (WHATSAPP|SMS), activation_token_id nullable
comms.verification_deliveries   id, tenant_id, session_id, channel (WHATSAPP|SMS|VOICE|STAFF), provider_code, status, provider_ref,
                                error_code, sent_at — one row per delivery attempt of the same code (ADR-0015)
comms.inbound_events            id, tenant_id, property_id, channel_id, provider_event_id unique per channel, payload jsonb,
                                received_at, processed_at, status — raw webhook store, normalized by the worker
comms.room_qr_codes             id, tenant_id, property_id, room_id (location), token_hash, status (ACTIVE|ROTATED|REVOKED),
                                created_at, rotated_from — contains no guest data
comms.inbox_views               (materialized/read model) conversation + guest + stay + room + open work items + SLA risk + AI summary placeholder
-- owned by the guest domain (Spec §6); comms creates grants only through `@hotella/domain-guest/public`
guest.guest_access_grants       id, tenant_id, property_id, guest_id, stay_id nullable, scopes text[]
                                (SERVICE_REQUEST|CHAT|DINING|CONCIERGE|ROOM_CONTROL|VIEW_BILL|PAYMENT|LOST_FOUND|FEEDBACK|INVOICE|SUPPORT),
                                valid_from, valid_until, revoked_at, revoke_reason, granted_via (ACTIVATION|QR|STAFF|PRE_ARRIVAL)
guest.guest_sessions            id, grant_id, session_token_hash, device_info, created_at, last_seen_at, expires_at, revoked_at
```

### 8.2 Flows

- **Primary activation** (Spec §19): consume `hotel.guest.checked_in.v1` → mint `activation_token` (256-bit, hashed) → build URL on the property's guest-web domain → *delivery policy* (WhatsApp template if a verified channel identity exists, else staff-visible for front desk) → guest enters mobile → OTP via the fallback chain of ADR-0015 (WhatsApp template through the property's `MessagingProvider`, Meta Cloud API or BSP; automatic SMS fallback on provider error/timeout, manual fallback after 30 s, optional voice, staff-assisted verification as last resort; one verification session and one attempt counter across channels) → verify → `channel_identity` verified → `guest_access_grant` (scopes by property policy; accompanying guests narrower) → `guest_session`.
- **Room QR fallback** (Spec §20): static QR → `room_qr_codes` resolve → room + last-name check against current stay (rate-limited) → same OTP path → grant.
- **Checkout (automatic, PMS-driven)**: `hotel.guest.checked_out.v1` from the PMS revokes room/stay scopes, revokes all guest sessions bound to the grant, closes or archives the stay-bound conversation, and stops any AI auto mode; keeps post-stay scopes (`LOST_FOUND|FEEDBACK|INVOICE|SUPPORT`) for a configurable window. No staff action is required.
- **Pre-arrival** (Spec §22): `EXPECTED` stays can get a narrower grant via the same path.
- **Inbound WhatsApp**: webhook → signature check → `integration_messages`-style raw store → normalize → `channel_identity` lookup → conversation routing → message → (Phase 6) AI → or staff inbox. Unverified phone with room/stay request ⇒ activation prompt, never trust the phone.
- **Realtime**: `apps/realtime` WS gateway pushes inbox updates and guest conversation updates (auth by staff access token / guest session).

### 8.3 Security requirements (tests, Spec §66)

OTP stored as HMAC-SHA256 with a provider-managed key (ADR-0011; a plain hash of a 6-digit code is brute-forceable), 6 digits, 5 min, 5 attempts, per-phone and per-IP rate limits, single-use; activation token single purpose, 24h default, revocable; replay of a used token ⇒ 410; QR token rotation invalidates printed codes without PMS change.

### 8.4 APIs

Public (guest, unauthenticated → session): `POST /guest/activation/start`, `/guest/activation/otp/request`, `/guest/activation/otp/verify`, `POST /guest/qr/:token/verify`, `GET /guest/me` (stay/room/scopes/branding), `GET/POST /guest/conversations/:id/messages`.
Staff: inbox list/filter, conversation detail, send message, assign, handoff/takeover, close; channels CRUD; QR generation/rotation per room (PDF sheet export); activation token issuance/revoke; grants list/revoke.
Webhooks: `POST /webhooks/whatsapp/:channelId` (provider-agnostic `MessagingProvider`; adapters `WHATSAPP_META_CLOUD` and `WHATSAPP_BSP_*`), `POST /webhooks/sms/:channelId` (`SmsProvider` delivery receipts).
Staff-assisted verification: `POST /guest/activation/assist` (permission `guest.activation.assist`, reason required, audited).

### 8.5 Permissions / events

`inbox.read inbox.reply inbox.assign inbox.takeover channel.manage guest.activation.issue guest.activation.assist guest.grant.revoke qr.manage`
Events: `comms.conversation.opened.v1`, `comms.message.received.v1`, `comms.message.sent.v1`, `comms.delivery.updated.v1`, `comms.handoff.requested.v1`, `guest.activated.v1`, `guest.grant.revoked.v1`

### 8.6 Acceptance

- Simulator check-in → activation URL → OTP (fake provider in tests) → grant; subsequent WhatsApp message from the verified phone resolves guest/stay/room automatically with no questions asked.
- Unverified phone gets the activation prompt; brute-forcing OTP locks the session after the limit.
- Fake WhatsApp provider returns an error → the same code is delivered by the fake SMS provider; the attempt counter is continuous across channels; a WhatsApp channel in `OFFLINE` health sends OTP straight to SMS and raises one deduplicated alert.
- Same activation flow passes with the channel bound to the Meta Cloud API adapter and to a BSP adapter (contract tests on both).
- Checkout revokes `SERVICE_REQUEST` and keeps `LOST_FOUND` for the configured window.
- QR rotation: old printed token rejected, new accepted; QR payload contains only an opaque token.
- Staff inbox shows guest/stay/room/open work items for the conversation; takeover marks `HANDED_OFF` and stops any auto mode.

### 8.7 Design decisions taken before coding (spec and ADR-0011/0015 applied)

- **Package** `@hotella/domain-communications` (schema `comms`) owns channels, channel identities, conversations,
  messages, activation tokens, verification sessions/deliveries and room QR codes. **Grants and guest sessions belong to
  the guest context** (`guest.guest_access_grants`, `guest.guest_sessions`); communications creates and reads them only
  through `GUEST_API` (CLAUDE.md rule 19: identity and grants are platform-owned, no PMS change).
- **Internal ids only:** activation and the post-stay rules react to `guest.stay.status_changed.v1` (the guest context
  already turned PMS facts into stays), never to `hotel.*` events with external ids. Checkout revokes stay-bound scopes
  and every session of the grant **inside the projector transaction that checks the stay out** (same context, so no
  window in which a checked-out guest still acts), then publishes `guest.grant.revoked.v1`; communications consumes it to
  close the stay-bound conversation and switch AI mode off.
- **Guest authentication** is separate from staff tokens: guest routes are `@Public()` for the staff guard and protected
  by a `GuestSessionGuard` (header `X-Guest-Session`, opaque 256-bit token, SHA-256 at rest) that resolves the session,
  its grant and the stay on every request and sets the actor (`GUEST`). Scopes are checked per route
  (`@RequireGuestScope('CHAT')`). Sessions slide (default 7 days, never past the grant).
- **Secrets:** the OTP HMAC key is a SecretRef (`COMMS_OTP_HMAC_KEY_REF`); provider credentials are the channel's
  `credential_ref`; the webhook verification secret is part of those credentials. No token, code or phone number is
  logged; phone numbers are stored normalized (E.164) and classified SENSITIVE.
- **OTP**: 6 digits, HMAC-SHA256(key, session id ‖ code), 5 minutes, 5 attempts per session across channels; per-phone
  (5 sessions per hour) and per-IP (route rate limit) limits; a verified or locked session cannot be reused. The
  fallback chain of ADR-0015 is deterministic code: primary channel → automatic fallback when the provider refuses or no
  delivery receipt arrives within `comms.otp.fallback_timeout_seconds` (a 5 s sweep, `comms.otp.fallback`) → manual
  fallback after `comms.otp.manual_fallback_after_seconds` → staff-assisted verification. The voice adapter stays off.
- **Activation delivery:** when a stay goes in house and its primary guest already has a verified WhatsApp identity at
  the tenant, a token is minted and the activation template is sent; otherwise front desk issues a token on demand and
  the URL (and its QR) is shown once (tokens are hashed, so they cannot be shown again; issuing a new one revokes the
  previous one for that stay and purpose).
- **Configuration keys** (property-overridable): `comms.otp.primary_channel`, `comms.otp.fallback_channels`,
  `comms.otp.fallback_timeout_seconds`, `comms.otp.manual_fallback_after_seconds`, `comms.otp.staff_assist_enabled`,
  `comms.activation.token_ttl_hours`; `guest.grant.in_stay_scopes`, `guest.grant.companion_scopes`,
  `guest.grant.pre_arrival_scopes`, `guest.grant.post_stay_scopes`, `guest.grant.post_stay_hours`.
- **Inbound webhooks** are stored raw first (`comms.inbound_events`, CONFIDENTIAL, purged by retention) after signature
  verification, then normalized by the worker; a duplicate provider message id is a no-op. Raw vendor payloads are not
  domain events (rule 6).
- **Outbound messages** are written `QUEUED` and sent by a worker job with retries (like e-mail notifications); OTP
  sends are the exception and go out inside the request so the guest waits on one round trip.
- **Channel health** is the communications context's (`comms.channels.health`: HEALTHY/DEGRADED/OFFLINE/AUTH_FAILED,
  from send outcomes); OFFLINE/AUTH_FAILED pre-empts OTP to the fallback and raises one deduplicated operations alert
  through `OPERATIONS_API.raiseAlert`. The ops notification dispatcher gets `WHATSAPP`/`SMS` delivery through the same
  adapters once staff phone numbers exist (Phase 7, see §9.2 "Not in Phase 5"); until then they stay skipped.
- **Inbox read model** is a query over conversations joined through public APIs (guest, stay, room, open work items,
  SLA risk) at pilot scale; a materialized projection is introduced only if profiling shows the need.

### 8.8 Migrations and tests

- `0015_guest_access` (grants, grant history, sessions), `0016_comms_channels` (channels, channel identities),
  `0017_comms_activation` (activation tokens, verification sessions, verification deliveries, room QR codes),
  `0018_comms_conversations` (inbound events, conversations, participants, messages, delivery events); forced RLS, tenant/property FKs,
  partial unique indexes (one ACTIVE QR per room, one open stay-bound conversation per stay, one verified identity per
  channel type and identifier per tenant).
- Unit: phone normalization (E.164, Egyptian local formats), OTP generation/verification and HMAC, attempt/expiry
  rules, fallback decision table (provider error, no receipt, health pre-emption, manual fallback timing), grant scope
  policy (primary vs companion vs pre-arrival vs post-stay), Meta Cloud webhook signature (HMAC-SHA256 `X-Hub-Signature-256`)
  and payload parsing, BSP adapter mapping, conversation routing table.
- Integration (real PostgreSQL/Valkey, fake providers): check-in → token → OTP → grant → session; WhatsApp error → SMS
  receives the same code with a continuous attempt counter; OFFLINE channel → straight to SMS + one alert; brute force
  locks; replayed token → 410; QR rotation; checkout revokes in-stay scopes and sessions, keeps post-stay scopes for the
  window; inbound message from a verified phone lands in the stay's conversation; unverified phone gets the activation
  prompt; staff inbox, assignment, takeover (`HANDED_OFF`, AI off), close; tenant-leak test (404 + RLS).
- Contract tests: the same activation flow and inbound/outbound message flow run against the Meta Cloud API adapter
  and the generic BSP adapter (recorded provider payloads, no network).
- e2e: the guest API and staff inbox routes with the role catalog (front desk, guest relations, duty manager).

### 8.9 Sprints and progress

| Sprint | Scope | Status |
|---|---|---|
| 4.1 | Guest access in the guest context: grants (scopes by policy, companions narrower, pre-arrival, post-stay window), guest sessions, `GUEST_API` (issue grant, open/authenticate/revoke session), checkout revocation in the projector, `guest.grant.revoked.v1`, staff grants list/revoke; `@hotella/domain-communications` skeleton: channels CRUD with `credential_ref`, `MessagingProvider`/`SmsProvider` ports with fake adapters, channel identities, phone normalization, manifest | delivered |
| 4.2 | Activation: tokens (on in-house stays with a verified identity, front-desk issuance/revoke), verification sessions with HMAC OTP, delivery chain WhatsApp → SMS with `verification_deliveries`, fallback sweep, health pre-emption + alert, rate limits, guest routes (`/guest/activation/*`, `/guest/me`), `GuestSessionGuard`, staff-assisted verification; room QR codes (generate, rotate, revoke, verify with last name); `guest.activated.v1` | delivered |
| 4.3 | Messaging: Meta Cloud API and generic BSP adapters (templates, text, media refs, webhook signatures, delivery receipts) with contract tests; webhooks with raw store and worker normalization; conversations, participants, messages, delivery events; routing by verified identity + active grant; activation prompt for unverified phones; outbound queue with retries; staff inbox (list/filter, detail with guest/stay/room/open work, send, assign, takeover/handoff, close); guest conversation routes; checkout closes stay conversations; `comms.*` events | delivered |
| 4.4 | `apps/realtime` WebSocket gateway (staff access token / guest session; inbox and conversation updates through Valkey pub/sub); printable room QR sheet; pilot smoke extended to activation; Phase 4 acceptance (`docs/acceptance/phase-4.md`) | delivered |
| 4.5 | `apps/staff-web` (ADR-0009: Next.js 16, next-intl on the shared catalog, Tailwind 4 logical properties) with `packages/ui` (RTL-tested primitives, the non-removable attribution footer): staff sign-in (BFF: refresh token in an httpOnly cookie, access token in memory), the unified inbox (property picker, conversation list, thread with guest/stay/room and open work, reply, take over, close) with realtime refresh; Playwright checks in English (LTR) and Arabic (RTL) | delivered |

Reality notes for 4.5:
- `apps/staff-web`: Next.js 16 App Router with next-intl 4 (locale routing `/en`, `/ar`; `lang`/`dir` per locale), Tailwind
  4 (logical properties only), `@hotella/ui` (`packages/ui`: Button, Badge and the attribution footer whose label and
  link are fixed; only the platform policy can hide it). UI strings are `locales/{en,ar}/staff.json` in the shared
  catalog (parity-checked); a build step nests them for next-intl.
- Sign-in through a small BFF in the web server (`/bff/login|mfa|refresh|logout`): the refresh token lives only in an
  `HttpOnly; Secure; SameSite=Strict` cookie scoped to `/bff`, the access token only in page memory and is renewed a
  minute before expiry. API calls go through a same-origin proxy route (`/hotella/*` → `WEB_API_URL`, resolved at run
  time so one image serves every environment); no CORS. The web server's configuration comes from
  `@hotella/platform-config/web` (rule 13).
- The inbox: property picker (properties where the person holds `inbox.read`), filters (waiting for us, all open,
  closed), the thread with guest, stay, room and the stay's open work, reply, take over, close; the realtime gateway
  refreshes list and thread. Messages mirror in Arabic (inbound on the start side).
- Tests: Playwright in English and Arabic with the API, BFF and WebSocket mocked in the browser (CI installs Chromium);
  the pilot image gains a `staff-web` target and service, and the pilot smoke checks both directions, the BFF sign-in
  against the deployed API (cookie flags, no refresh token in the body) and the proxy.

Reality notes for 4.4:
- The realtime gateway runs **inside the API process** (`CommunicationsRealtimeModule`, WebSocket on
  `/api/v1/realtime`) instead of a separate `apps/realtime`: it needs exactly what the API already has (the staff
  authentication strategy, permissions, the guest context, Valkey), and a separate service would need its own secrets,
  OpenBao role and compose service at pilot. It stays extractable: the worker's `RealtimeRelay` publishes notices on
  Valkey pub/sub (`hotella:rt:<tenant>`) and every API instance fans them out to its own sockets.
- Protocol: the first message authenticates (`{type:"auth", token}` with the staff access token, or
  `{type:"guest", session}`; browsers cannot set headers on WebSockets), within 10 s; staff then subscribe per property
  (`inbox.read` there, same rule as the route); guests hear only about their stay and need `CHAT`. Credentials are
  re-checked every minute (logout, revoked sessions, check-out and expired tokens close the socket with 4401).
  Notices carry the event name and ids only; clients fetch content over REST.
- The printable room QR sheet is an **HTML page** (inline SVG codes via `qrcode-generator`, ADR-0016 row; A4 print CSS,
  logical properties, localized, `Powered by Planova` per the attribution policy) that staff print to paper or PDF,
  instead of a server-side PDF. Printing needs the tokens, which are shown only once, so the sheet rotates the codes it
  prints (`POST /properties/:p/room-qr-codes/sheet`, optional `roomIds`; `Cache-Control: no-store`).
- Pilot smoke: the simulator scenario `pilot-stay.yml` leaves a second guest in house; `smoke-guest.sh` signs in a
  general manager, issues a link, requests a code (the OTP key comes from OpenBao; the smoke SMS channel cannot
  deliver, so the failure is recorded), confirms the guest at the desk, opens the guest session, checks `/guest/me`,
  the single-use link, the QR sheet and the WebSocket upgrade on the deployed stack.

Reality notes for 4.3:
- Adapters shipped: `WHATSAPP_META_CLOUD` (Graph API `/{phone-number-id}/messages`, `X-Hub-Signature-256` webhooks,
  `hub.verify_token` handshake), `WHATSAPP_BSP_360DIALOG` on a `CloudCompatibleBspAdapter` base (BSPs relaying the Cloud
  API model; webhooks authenticated by a shared secret header `X-Hotella-Webhook-Secret`), and `SMS_HTTP_JSON` (a
  generic JSON aggregator until the pilot's aggregator is chosen). Credentials are one SecretRef holding a JSON object
  (ADR-0015 implementation notes). Provider error codes map to `UNAVAILABLE/TIMEOUT/AUTH_FAILED/INVALID_RECIPIENT/
  RATE_LIMITED/REJECTED`; calls time out after 10 s. Contract tests replay recorded Cloud API payloads, and the
  integration suite runs activation and messaging through both WhatsApp adapters against a local provider stand-in.
- Webhooks (`POST /webhooks/whatsapp|sms/:channelId`, raw body kept for signatures) store each normalized item once in
  `comms.inbound_events` (unique per channel and provider id) and process it at once; items that fail stay RECEIVED and
  the worker retries them (`comms.inbound.retry`, 15 s, FAILED after 5 attempts). Delivery receipts of OTP messages
  feed the verification deliveries (4.2), the others move outbound messages forward only.
- Routing: a WhatsApp number reaches a stay only through a verified channel identity **and** a live grant with `CHAT`
  at the channel's property; then the stay's one open conversation is used (also from guest web). Anyone else gets a
  conversation keyed by the channel identity and, at most once a day, the localized activation prompt; nothing about
  the stay is revealed. SMS is a code channel only (no conversations).
- Outbound: staff replies are queued and sent by `comms.message.send` (3 s, `guest-realtime` queue) on the channel the
  guest last wrote on, with retries for retryable provider errors (30 s, 2 min, 5 min; FAILED after 4 attempts); a
  WhatsApp reply outside the 24-hour customer-service window fails with `OUTSIDE_WINDOW` (templated re-engagement comes
  with the catalog/AI phases). Guest-web replies are shown at once (no provider).
- Inbox: list/detail with guest, stay, room (from the guest and organization contexts, never from the phone), open
  work items of the stay (`OPERATIONS_API.openWorkItemsOfStay`), masked contact, `aiSummary` placeholder; reply,
  assign (optimistic version), takeover (`HANDED_OFF`, AI mode OFF, `comms.handoff.requested.v1`, audited), close.
  The inbox read model is a query (see §8.7). Permissions `inbox.read/reply/takeover` for guest desks, `inbox.assign`
  for duty and general managers.
- Lifecycle: the stay leaving the house (check-out, cancellation, no-show) closes its conversation and switches AI mode
  off; anonymization clears message texts and media references of the guest's conversations. Messages are append-only
  at the database level except delivery fields and that anonymization clearing.
- Not yet: inbound media download into the asset registry (references are kept), staff WhatsApp/SMS notifications
  (Phase 7, needs staff phone numbers), templated messages outside the window (guest notifications use the
  `service_update` template since 5.3).

Reality notes for 4.2:
- The OTP is **derived, not stored**: `code = HMAC-SHA256(key, session id ‖ random seed)` truncated to 6 digits, under
  the key `COMMS_OTP_HMAC_KEY_REF` (a SecretRef; pilot: `kv/hotella/app#otp_hmac_key`). The row keeps only the seed
  (RESTRICTED), so a fallback channel re-sends *the same* code (ADR-0015) and the database alone never reveals it —
  this replaces the plan's `otp_hash` column. Codes are compared in constant time.
- The guest's device holds a 256-bit **handle** (SHA-256 at rest) for its verification session; the session id alone is
  never a credential. A wrong code is counted and committed before the error is returned; the fifth locks the session.
  A verified session becomes a grant and a guest session exactly once (`completed_at`); the activation link is consumed
  at that moment (single use; replay → 410).
- Who is verified: a link issued for a party member names them; otherwise the party member whose PMS phone matches the
  verified number, else the primary guest. Room QR: the last name (case-, accent- and Arabic-diacritic-insensitive)
  must match a member of a stay in house in that room; every mismatch gets the same `comms.qr.no_match`.
- Delivery: the chain is primary + fallbacks from configuration, limited to the property's active channels and
  skipping OFFLINE/AUTH_FAILED ones (which raises the `CHANNEL_UNHEALTHY` alert, deduplicated per channel). A provider
  error moves on at once (`AUTO_FALLBACK`); a send without a delivery receipt after `comms.otp.fallback_timeout_seconds`
  is moved on by the worker sweep `comms.otp.fallback` (every 5 s, SKIP LOCKED); the guest may ask for the next channel
  after `comms.otp.manual_fallback_after_seconds`. Health: a success heals; an unavailable provider degrades, then takes
  the channel offline; an authentication failure sticks until the channel's credentials or configuration change.
  Delivery receipts (`ActivationService.deliveryStatus`) are fed by the provider webhooks of 4.3.
- Staff-assisted verification: the guest reads out a 6-character reference; staff with `guest.activation.assist` find
  the open session (masked phone, guest name) and confirm it with a reason (audited); the guest's device then calls
  `POST /guest/activation/complete`. A session locked by wrong codes may still be confirmed in person; an expired one not.
- Arrival: on `EXPECTED → IN_HOUSE` the worker sends the activation template to the primary guest's most recently
  verified WhatsApp number at the tenant, if the property has a healthy WhatsApp channel; nothing is ever sent to an
  unverified number. Otherwise front desk issues the link (`POST /properties/:p/stays/:s/activation-tokens`), shown once.
- Guest API: `POST /guest/activation/start|otp/request|otp/resend|otp/verify|complete`, `GET /guest/qr/:token`,
  `POST /guest/qr/:token/verify`, `GET /guest/me`, `POST /guest/logout`; per-IP rate limits on every public step.
  `GuestSessionGuard` reads `X-Guest-Session`, re-checks session, grant and scope per request and sets a GUEST actor.
- Staff API: activation tokens (issue/list/revoke, `guest.activation.issue`), verification sessions by reference and
  assist (`guest.activation.assist`), room QR codes (list, generate/rotate — token shown once — revoke, `qr.manage`).
  Front desk, guest relations and managers hold the activation permissions; general managers hold `qr.manage` and
  `channel.manage`. The printable sheet arrives in 4.4.
- `PropertySummary` exposes the property's country (national phone numbers); `GUEST_API.stayParty` gives verification
  flows the party with names and PMS phone numbers.

Reality notes for 4.1:
- Grants carry the party role and their scopes; every change is a row in `guest.guest_access_grant_events`
  (GRANTED/WIDENED/NARROWED/REVOKED, append-only by trigger), so history is never overwritten (rule 10). A pre-arrival
  grant widens to the in-stay (primary) or companion scopes when the stay goes in house; check-out narrows it to the
  post-stay scopes it holds for `guest.grant.post_stay_hours` (72 by default) and caps its sessions there — revoking the
  grant and every session when nothing remains; cancellation and no-show revoke. This runs in the projector's
  transaction (`GuestAccessService.followStay`), so a checked-out guest never keeps in-stay access.
- `PAYMENT` is not in any default scope set: a property opts in through configuration.
- One live grant per guest and stay, reused for every device; verifying again after check-out returns the post-stay
  grant, never a wider one. Anonymization and merges revoke the guest's grants (device descriptions are cleared).
- Guest sessions: opaque 256-bit tokens, SHA-256 at rest, 7-day sliding expiry capped at the grant, `last_seen_at`
  written at most once a minute; `GUEST_API.authenticateGuestSession` re-checks session, grant and validity on every
  call. The HTTP guard that uses it arrives with the guest routes in 4.2.
- Events: `guest.grant.issued.v1` (stands in for the plan's `guest.activated.v1`; activation is one of its `granted_via`
  values), `guest.grant.changed.v1`, `guest.grant.revoked.v1`; permission `guest.grant.revoke` (guest desks and
  managers); staff routes `GET /properties/:p/stays/:s/grants` (with history) and `POST /properties/:p/guest-grants/:g/revoke`.
- `@hotella/platform-settings` gained a route-free `SettingsCoreModule`/`SettingsReader`, so the worker reads property
  policy without the configuration API.
- Communications: channels are created for adapter-backed types (`WHATSAPP`, `SMS`) only; web and QR entry points need
  no channel row. Adapters register in `ChannelAdapterRegistry`; the in-memory `FAKE_WHATSAPP`/`FAKE_SMS` adapters
  serve tests and local development; Meta Cloud API and BSP adapters arrive in 4.3. Channel identities are one row per
  identifier per tenant (the guest it was last verified for); anonymization removes them (worker consumer of
  `guest.guest.anonymized.v1`). Phone numbers normalize to E.164 with the property's country for national forms;
  ambiguous input is refused.

---

## 9. Phase 5 — Guest Service Catalog (detailed)

> **Status: accepted on 2026-10-03; M1 reached** — evidence in `docs/acceptance/phase-5.md`.

**Goal / acceptance (Spec §85, closes M1):** a verified guest opens the property's localized catalog, requests a service,
the right department gets the work with its SLA, and the guest is told on their verified channel when it is done.
Package `@hotella/domain-catalog` (context code `catalog`, schema `catalog`); guest notifications in the communications
context; `apps/guest-web` per ADR-0009.

### 9.1 Domain model (schema `catalog`)

```text
catalog.service_categories            id, tenant_id, property_id nullable (null = every property of the tenant), code,
                                      parent_id, sort_order, icon, status ACTIVE|INACTIVE, version
catalog.service_category_translations entity_id, locale, name, description
catalog.service_definitions           id, tenant_id, property_id nullable, code (EXTRA_TOWELS…), category_id,
                                      status ACTIVE|RETIRED, published_version_id nullable, version
catalog.service_versions              id, tenant_id, definition_id, version_no, status DRAFT|PUBLISHED|SUPERSEDED,
                                      department_code, priority, workflow_code nullable, required_fields jsonb,
                                      eligibility jsonb, availability jsonb, guest_visible, automation_policy jsonb,
                                      price jsonb nullable, duplicate_window_minutes, published_at, published_by, version
catalog.service_version_translations  entity_id, locale, name, short_description, description, guest_prompt_hints,
                                      field_labels jsonb ({field: {label, options: {code: label}}})
catalog.service_requests              id, tenant_id, property_id, definition_id, service_version_id, service_code,
                                      guest_id, stay_id, room_id, conversation_id nullable, work_item_id, status
                                      OPEN|IN_PROGRESS|COMPLETED|CANCELLED, fields jsonb, requested_for_at nullable,
                                      locale, source GUEST_WEB|WHATSAPP|STAFF|AI|QR, created_by_type, created_by_id,
                                      related_count, last_related_at, closed_at, version
catalog.service_request_events        id, tenant_id, request_id, type CREATED|RELATED|STATUS_CHANGED, from, to,
                                      actor_type, actor_id, fields jsonb nullable, reason, occurred_at   (append-only)
```

### 9.2 Design decisions taken before coding

- **Versions are immutable once published** (CLAUDE.md rule 9): a database trigger refuses any change to a published
  version except its status moving to `SUPERSEDED`; editing a published service creates the next `DRAFT` (copying the
  current one and its translations); publishing supersedes the previous version and moves
  `service_definitions.published_version_id`. Requests keep the exact version they were made under.
- **SLA and workflow are bound by code, not by foreign id**: the operations context owns SLA policies and workflow
  versions. A request creates its work item with `serviceCode`, `departmentCode`, `priority` and, if set,
  `workflowCode`; the SLA engine picks the most specific policy (service > department > priority > kind, Phase 3) and
  the workflow engine starts the property's published workflow. This replaces the plan's `sla_policy_id` /
  `workflow_version_id` columns, which would have reached into another context's tables (rule "no domain writes
  another domain's tables").
- **Tenant-wide and property services**: a definition without `property_id` serves every property of the tenant; a
  property definition with the same code replaces it there. Categories follow the same rule.
- **Required fields** are a small declarative schema (`TEXT` up to 500 chars, `NUMBER` with bounds, `CHOICE` of option
  codes, `DATETIME`, `BOOLEAN`, each `required` or not), validated in code; labels and option labels are translations
  (rule 7). `TEXT` values are the guest's own words: CONFIDENTIAL, never in events, logs or work titles, cleared on
  anonymization.
- **Eligibility** (`{ stayStatuses, partyRoles, roomTypeIds }`, defaults: in house, any party member, any room type)
  and the guest scope `SERVICE_REQUEST`; **availability** (`{ hours: [{ days, from, to }], leadTimeMinutes,
  allowScheduling, maxPerStayPerDay }`) in the property's time zone via `@hotella/platform-time`. All deterministic
  code (rule 11). Ineligible services are not listed to guests; a request for one gets a localized 422 with the reason.
- **Duplicate detection** (Spec §23): an `OPEN`/`IN_PROGRESS` request of the same stay and service created within the
  version's `duplicate_window_minutes` (default 30) is **related**, not duplicated: `related_count` grows, a `RELATED`
  event keeps who asked and the new field values, `catalog.service_request.related.v1` is published, and the caller
  gets the existing request with `related: true`. A transaction-scoped advisory lock per stay and service serializes
  concurrent asks, so two of them cannot both create.
- **One entrypoint**: `CatalogPublicApi.createServiceRequest()` (also `CATALOG_API` for the Phase 6 AI tool
  `operations.create_service_request`) runs scope → eligibility → availability → fields → duplicates → request +
  work item (`OPERATIONS_API.createWorkItem` in the same transaction, kind `SERVICE_REQUEST`, source
  `catalog/service_request/<id>`) → audit → `catalog.service_request.created.v1`. Staff on behalf of a guest use the same
  path with actor USER and source `STAFF` (gate `request.create`).
- **Work titles** are a locale key with the service name in the property's default locale and the room number
  (`catalog.request.work_title`); guest words never become titles. This settles the Phase 3 open item: requests never
  quote a guest in a title, and the operations context now also clears quoted free-text titles of a guest's work
  items on `guest.guest.anonymized.v1`.
- **Status follows the work**: a worker consumer of `ops.work_item.status_changed.v1` for `SERVICE_REQUEST` maps
  `IN_PROGRESS → IN_PROGRESS`, `RESOLVED → COMPLETED`, `CANCELLED → CANCELLED`, writes a `STATUS_CHANGED` event and
  publishes `catalog.service_request.status_changed.v1`. A guest may cancel only an `OPEN` request (the work item is
  cancelled through `OPERATIONS_API.cancelWorkItem`).
- **Guest notifications** (Spec §25, rule 18): the catalog asks the communications context
  (`COMMUNICATIONS_API.notifyGuest`) on the statuses listed in `catalog.notify.statuses` (property-overridable; default
  `IN_PROGRESS`, `COMPLETED`, `CANCELLED`), in the locale the guest made the request in. Communications writes a
  `SYSTEM` message into the stay's conversation (opening a guest-web one if none) and pushes it to the guest web in
  real time; when the guest has a verified WhatsApp identity and the property an active WhatsApp channel, it also goes
  out there: as text inside the 24-hour window, otherwise as the `service_update` template (ADR-0015). Service
  notifications are transactional (about the guest's own request), so no marketing consent is needed.
- **Localization**: guest-facing names come from the translation tables with the chain request locale → property
  default → `en`; a service without any usable translation is not listed. A **starter catalog** (the Spec §7 examples:
  EXTRA_TOWELS, ROOM_CLEANING, AC_PROBLEM, WIFI_HELP, AIRPORT_TRANSFER, LATE_CHECKOUT_REQUEST, with categories) can be
  imported into a property; its texts come from `locales/{en,ar}/catalog.json`, so nothing user-facing is hardcoded.
- **Guest web** (`apps/guest-web`, ADR-0009): Next.js 16 PWA on the shared catalog, branding from
  `GET /public/branding` with the non-removable attribution footer; the guest session token lives in an HttpOnly cookie
  set by a BFF route (never in script-readable storage); activation by link and room QR, catalog, request form, my
  requests, chat with realtime updates.
- **Not in Phase 5:** charging (price is display only; posting to the PMS folio is Phase 10), AI-created requests
  (Phase 6 over the same entrypoint), staff WhatsApp/SMS notifications (Phase 7 with the staff mobile flows and staff
  phone numbers; staff keep in-app, e-mail and realtime).

### 9.3 APIs / permissions / events

Guest (session guard, scope `SERVICE_REQUEST`): `GET /guest/services` (eligible, localized, by category),
`GET /guest/services/:code`, `POST /guest/requests`, `GET /guest/requests`, `POST /guest/requests/:id/cancel`.
Staff: categories and services CRUD, drafts and publish (`/catalog/...` with `propertyId` for property items),
`POST /properties/:p/catalog/starter` (import), requests board `GET /properties/:p/service-requests`, detail with
history, `POST /properties/:p/stays/:s/service-requests` (on behalf of a guest), cancel.
Permissions: `catalog.read catalog.manage catalog.publish request.read request.create request.manage`.
Events: `catalog.service_version.published.v1`, `catalog.service_request.created.v1`,
`catalog.service_request.status_changed.v1`, `catalog.service_request.related.v1`.
Configuration: `catalog.notify.statuses`, `catalog.request.default_duplicate_window_minutes`.

### 9.4 Acceptance (closes **M1**)

End-to-end CI scenario: simulator check-in → activation → request EXTRA_TOWELS from guest web API in Arabic → task appears for Housekeeping department with SLA → staff completes → guest receives localized notification (fake WhatsApp provider) → audit trail links every step by `correlation_id`. A second identical request within the window is related to the first, not duplicated.

### 9.5 Sprints and progress

| Sprint | Scope | Status |
|---|---|---|
| 5.1 | `@hotella/domain-catalog`: categories, definitions, versions with translations, drafts, publish (immutable by trigger), tenant-wide vs property services, starter catalog import from the locale catalog, eligibility and availability rules, guest catalog `GET /guest/services` localized with fallback, manifest, permissions, `catalog.service_version.published.v1` | delivered |
| 5.2 | Service requests: `createServiceRequest` entrypoint and `CATALOG_API`, fields validation, duplicate detection with locking, work item via `OPERATIONS_API` (SLA/workflow by code), status follow from ops events, guest and staff routes, requests board, history, anonymization (catalog fields; ops quoted titles), tenant-leak tests | delivered |
| 5.3 | Guest notifications: `COMMUNICATIONS_API.notifyGuest`, `SYSTEM` messages in the stay conversation, WhatsApp text or `service_update` template by window, realtime push, `catalog.notify.statuses` | delivered |
| 5.4 | `apps/guest-web` PWA: BFF guest session cookie, activation (link, room QR), catalog, request form, my requests, chat; branding + attribution; Playwright in English (LTR) and Arabic (RTL); Docker target and pilot service | delivered |
| 5.5 | M1 end-to-end scenario in CI, pilot smoke extended to a service request, Phase 5 / M1 acceptance (`docs/acceptance/phase-5.md`) | delivered |

Reality notes for 5.5:
- `m1.integration.spec.ts` runs the whole milestone in CI against PostgreSQL: simulator connector messages (OWS
  reservation, FIAS check-in) → canonical events → stay projector → activation link → WhatsApp OTP (fake provider) →
  Arabic request → housekeeping work with SLA → staff accept/start/complete → worker steps run in the context the
  queue gives them (the event's correlation id) → `service_update` template in Arabic → audit and outbox checked by
  correlation id. Automatic request moves are audited as SYSTEM (`catalog.request.status`).
- The pilot smoke repeats it on the deployed stack (real simulator, worker, relay, guest web BFF and proxy): starter
  catalog, an Arabic request and its related repeat, the HK task done by the manager, the worker completing the
  request and the Arabic message in the guest's conversation, audit rows with correlation ids.

Reality notes for 5.4:
- `apps/guest-web` (Next.js 16, next-intl on `locales/{en,ar}/portal.json`, Tailwind 4 logical properties, `@hotella/ui`):
  `/a/<token>` (activation link) and `/q/<token>` (room QR: last name, then phone) → code by WhatsApp/SMS, resend
  another way after the policy delay, or the front-desk reference with "the front desk has confirmed me"; home with
  greeting, room and the localized catalog; a form per service built from its fields; my requests with status and
  cancel; chat. Links printed without a language follow the browser's language.
- The guest session token lives only in the httpOnly cookie `hotella_gs` (`SameSite=Lax`, so opening the app from a
  WhatsApp link keeps the session; `Secure` in production), set by `/bff/verify` and `/bff/complete`; `/bff/logout`
  ends the session on the API. The same-origin proxy forwards only `guest/*` and `public/*` and refuses the routes
  that mint a session, so no page script ever holds the token.
- Because the token is not readable by scripts, the guest web refreshes requests (15 s) and chat (5 s) instead of
  opening the realtime socket; a short-lived socket ticket can replace polling later without changing the API's
  guest routes.
- Branding comes from `GET /public/branding` (before a session) or `/guest/me`; only `#rgb/#rrggbb` colors reach CSS;
  the attribution footer's visibility follows the platform policy. The PWA manifest is served per language
  (`/<locale>/manifest.webmanifest`); an offline service worker is not part of M1.
- Pilot: `guest-web` image target and compose service (`127.0.0.1:3200`), `HOTELLA_PUBLIC_BASE_URL` now defaults to
  it so activation links open it; the smoke completes activation through the deployed guest web's BFF and reads
  `/guest/me` through its proxy with the cookie, then signs out.

Reality notes for 5.3:
- `COMMUNICATIONS_API.notifyGuest` (joins the caller's transaction) writes a `SYSTEM` message, rendered from the locale
  catalog in the given locale, into the stay's open conversation (opening a guest-web one if needed) and announces
  it to the guest web at once. With a verified WhatsApp number of **that guest** and a usable WhatsApp channel the
  message is queued there too; `comms.messages` gained `recipient_identity_id` and `template` (migration
  `0021_comms_notifications`, both clearable by anonymization only). The outbound job sends text when the recipient is
  the conversation's last contact inside the 24-hour window, otherwise the template; without a template it still
  fails `OUTSIDE_WINDOW`.
- The catalog's `RequestNotifier` runs on every status move it records (worker and API) for the statuses in
  `catalog.notify.statuses`, in the language of the request; a guest is not told about their own cancellation.
  Messages: `catalog.notification.request_in_progress|completed|cancelled`; template parameters: service name and
  `catalog.notification.status.*`.
- Fixed on the way (from 4.3): an inbound WhatsApp message into a stay conversation that began on the guest web did
  not make the writer the conversation's contact, so staff replies had no recipient; the writer now becomes the
  contact (replies go to whoever wrote last).

Reality notes for 5.2:
- Order of checks in `createServiceRequest`: service (published, active, guest-visible for guest-facing sources) →
  stay and party membership → eligibility → **fields** → duplicate window → availability (opening hours, lead time,
  scheduling, daily cap per property day) → request + work item + `CREATED` history + audit + event, all in one
  transaction. An invalid ask is refused even when an open request would have absorbed it.
- Guests act through their session (`SERVICE_REQUEST` scope, their own stay); staff and later AI through the
  ActionGate (`request.create`). Staff on a guest's behalf: `POST /properties/:p/stays/:s/service-requests`
  (default: the primary guest), source `STAFF`. Guests see their own requests; the primary guest sees the stay's.
- The request follows the work item's **current** status (read through `OPERATIONS_API.getWorkItem` on each
  `ops.work_item.status_changed.v1`), so late or repeated deliveries never move it backwards. Guests cancel `OPEN`
  requests; staff (`request.manage`) cancel open or started ones with a reason; the work item is cancelled with it.
  When the stay leaves the house, `OPEN` requests are withdrawn (`STAY_ENDED`); started work is left to staff.
- Status moves live in `RequestLifecycle` (API and worker); creation and reads in `ServiceRequestService` (API only,
  it needs the ActionGate). `CATALOG_API` is provided by the API module.
- Anonymization: the catalog removes TEXT field values from the guest's requests and asks and clears reasons; the
  operations context replaces free-text work and task titles of the guest's work by `ops.work.title_redacted` and
  clears free-text task-history reasons (consumer `ops.guest-anonymization`) — the Phase 3 open item. Migration
  `0020_catalog_history` tightens the history trigger: field values may only be removed, reasons only cleared.
- Permissions `request.read|create|manage` (guest desks and managers; supervisors read).

Reality notes for 5.1:
- Schema `catalog` (migration `0019_catalog`) holds the whole context, including the request tables 5.2 fills. Triggers:
  a published version only moves to `SUPERSEDED` and is never deleted; translations of a non-draft version cannot be
  written; request history is append-only except the guest's words (cleared on anonymization).
- A property row replaces the tenant-wide row with the same code once it is **published**; a **retired** property row
  opts the property out of the chain's service; an unpublished property draft leaves the chain's service in place.
  Categories follow the same code rule.
- Tenant-wide items need a tenant-wide membership (the ActionGate checks the permission without a property); the
  admin routes declare `catalog.*` with `checkedBy: 'gate'` because the level is known only once the item is loaded.
- Publishing checks that every translation labels every field and choice option, and (for property services) that the
  department exists and is active; tenant-wide services are checked per property when a request is made (5.2).
- Guests see a service only if it is published, active, guest-visible, eligible for them (stay status, party role,
  room type) and translated in some locale of the chain; `openNow` tells the guest web whether it can be asked for now.
- `GuestSessionGuard`, `RequireGuestScope` and `CurrentGuest` moved from the communications context to
  `@hotella/domain-guest/public` (the guest context owns sessions); the error key became `guest.session.scope_missing`.
- Starter import: categories HOUSEKEEPING, MAINTENANCE, FRONT_DESK, TRANSPORT; services EXTRA_TOWELS, ROOM_CLEANING
  (housekeeping), AC_PROBLEM (engineering, high), WIFI_HELP, AIRPORT_TRANSFER (also before arrival),
  LATE_CHECKOUT_REQUEST (primary guest only; front office); department codes default to HK/ENG/FO and can be mapped.
  Roles: guest desks get `catalog.read`; general managers `catalog.manage` and `catalog.publish`.

---

## 10. Phases 6–13 (outline; expanded before each starts)

### Phase 6 — AI Foundation (M2, detailed)

> **Status: accepted on 2026-10-03; M2 reached** — evidence in `docs/acceptance/phase-6.md`.

**Goal / acceptance (Spec §85, M2):** the same guest flow in natural language. A guest writes "الجو حر أوي هنا"; the
Guest Concierge (over the tools that already exist) finds the stay and room, sees no open AC request, creates
`AC_PROBLEM` (or relates it to an open one), the work goes to Engineering, and the guest is answered in Arabic.
HIGH-risk tools become approval proposals; CRITICAL ones are refused; every execution is fully recorded; no AI code
path writes a business table outside a tool handler. Providers, data egress and budgets per ADR-0018 (Q8 open: until
the product owner enables an external provider, CI and local runs use the `FAKE` provider and pilots may use an
on-prem model server).

#### 6.A Domain model (schema `ai`; `knowledge` in 6.4)

```text
ai.providers            id, code, kind (OPENAI_COMPATIBLE|ANTHROPIC|FAKE), base_url, credential_ref, egress
                        (ON_PREM|EXTERNAL), max_data_class, status, version
ai.models               id, provider_id, code (provider's model name), capabilities text[], context_window,
                        input/output/cached price per million tokens (minor units), status, version
ai.routing_rules        id, tenant_id nullable, property_id nullable, capability, model_ids uuid[] (ordered), version
ai.agents               id, code (GUEST_CONCIERGE…), status            ai.agent_versions  id, agent_id, version_no,
                        status DRAFT|PUBLISHED|SUPERSEDED, capability, prompt_version_id, tool_codes text[],
                        context_policy jsonb, autonomy_policy jsonb, output_contract jsonb, max_steps (immutable once
                        published, trigger)
ai.prompts              id, code         ai.prompt_versions  id, prompt_id, version_no, status, layers jsonb
                        (platform/agent instructions as locale keys or text), published_at (immutable once published)
ai.tools                id, code, domain, description_key, input_schema jsonb, output_schema jsonb, risk,
                        required_permission, status (registry mirror of the module manifests, synced at boot)
ai.executions           id, tenant_id, property_id, agent_version_id, trigger (USER|EVENT), actor, conversation_id,
                        status, started_at, finished_at, tokens, estimated_cost_minor, correlation_id
ai.execution_steps      id, tenant_id, execution_id, seq, type (CONTEXT|MODEL_CALL|TOOL_CALL|RETRIEVAL|DECISION|
                        APPROVAL|RESPONSE), summary jsonb, latency_ms, outcome (append-only)
ai.model_calls          id, tenant_id, execution_id, provider, model, capability, tokens_in/out/cached, latency_ms,
                        cost_minor, fallback_from, outcome, correlation_id
ai.action_proposals     id, tenant_id, property_id, execution_id, tool_code, arguments jsonb, reason, evidence jsonb,
                        risk, approval_id, status (PENDING|APPROVED|REJECTED|EXPIRED|EXECUTED|FAILED), expires_at
ai.feedback             id, tenant_id, execution_id, kind (DRAFT_EDIT|REASSIGNMENT|GUEST_CORRECTION|RATING),
                        edit_distance, details jsonb, actor
```

#### 6.B Design decisions taken before coding

- **One context, one gateway.** `@hotella/domain-ai` (context code `ai`) owns the gateway, registry, policy,
  runtime and audit. Modules contribute tools by implementing a handler and declaring it in their manifest's
  `aiTools`; the ai context never imports another context's internals — tool handlers live in the owning context and
  register into `AI_TOOL_REGISTRY` at boot (like work item kinds).
- **No business writes from AI code.** The ai context's own tables are the only ones it writes; a dependency-cruiser
  rule forbids `packages/domain/ai` from importing any other context except through `public`, and a test asserts that
  every mutating tool call passes the ActionGate with an `AI_AGENT` actor.
- **Tool execution path** (Spec §42): schema validation (zod from the registered schema) → business validation (the
  owning service) → ActionGate with `AI_AGENT` actor (authorization → entitlement → feature → configuration →
  connector → **AI policy stage, now real**) → execute → audit → events. The AI policy stage decides from tool risk,
  agent autonomy policy, property policy and context: `READ`/`LOW` auto; `MEDIUM` auto when the agent's policy allows
  it for that tool (default: allowed for the Guest Concierge's own-stay actions); `HIGH` → `ai.action_proposals` +
  approval request of kind `AI_ACTION` (the approval handler executes the tool as the approving human's decision,
  audited); `CRITICAL` refused (already enforced by the approval engine).
- **Guest identity in AI actions.** When the concierge acts for a guest, tools receive the guest principal of the
  conversation (stay, scopes) and enforce it exactly as the guest web does; the AI cannot reach another stay.
- **Prompts are layers, not monoliths** (Spec §30): platform → agent → tenant policy → property context → actor role
  → current task, each a short block; texts that guests may see come from the locale catalog. Prompt and agent
  versions are immutable once published (trigger, like catalog versions).
- **Context Engine:** per-agent context policies list context providers (`guest.current_stay`, `catalog.services`,
  `catalog.open_requests`, `conversation.recent`, `knowledge.guest_safe`); each provider returns labelled parts with a
  data class; the gateway applies the egress policy of ADR-0018. Structured live data comes from tools, never RAG.
- **Runtime:** a bounded loop (max steps per agent version) of model call → tool calls → model call, with structured
  output for the reply. Language: the reply language is the guest's message language (deterministic detection of
  Arabic script vs Latin, then the conversation locale), never guessed by a second model call.
- **Triggering** (Spec §39): `comms.message.received.v1` for a stay conversation whose AI mode is `AUTO` (or `ASSIST`
  for drafts) runs the concierge in the `background-ai` queue; nothing else triggers an LLM in Phase 6.
- **Handoff** (Spec §24): the model's structured output may request a handoff with a reason
  (`GUEST_REQUESTED_HUMAN`, `LOW_CONFIDENCE`, `COMPLAINT`, `SENSITIVE_REQUEST`, `PAYMENT_ISSUE`, `POLICY_REQUIRED`,
  `AI_FAILURE`); the runtime then switches the conversation to `HANDED_OFF` through the comms public API (no AI write).
  In `ASSIST` mode the reply is stored as a draft; when staff send it, the edit distance is recorded in `ai.feedback`.
- **Kill switches and budgets** per ADR-0018 as feature flags and settings; a disabled guest AI hands off.

#### 6.C Sprints and progress

| Sprint | Scope | Status |
|---|---|---|
| 6.1 | `@hotella/domain-ai`: providers, models, routing rules, `MODEL_GATEWAY` (`complete`, `embed`) with `OPENAI_COMPATIBLE`, `ANTHROPIC` and `FAKE` adapters, fallback, cost/latency in `ai.model_calls`, egress policy (data class filter + identifier masking), budgets and kill switches, admin API (platform admin for providers/models, tenant for routing overrides) | delivered |
| 6.2 | Tool registry + AI policy stage: tool definitions declared in the AI manifest, execution through the ActionGate as `AI_AGENT`, risk decisions, `ai.executions`/`ai.execution_steps`, `ai.action_proposals` + approval kind `AI_ACTION`; tools v1 `guest.get_current_stay`, `catalog.list_services`, `operations.find_open_requests`, `operations.create_service_request`, `operations.cancel_service_request`, `communication.send_message` (`knowledge.search` moves to 6.4) | delivered |
| 6.3 | Agents and prompts (immutable versions), Context Engine with context policies, execution audit read API, Guest Concierge v1 runtime triggered by guest messages (AUTO/ASSIST), language rule, handoff → inbox, drafts with edit-distance feedback, staff inbox shows AI drafts | delivered |
| 6.4 | Knowledge v1 (`knowledge` schema: documents, versions, chunks, embeddings with pgvector; scope tenant/property/department/language/audience/effective dates/classification; hybrid retrieval metadata + keyword + vector + rerank with document version references; retrieved text framed as untrusted data) | delivered |
| 6.5 | M2 acceptance: "الجو حر أوي هنا" end to end with the `FAKE` provider scripted, HIGH-risk proposal → approval → execution, execution audit complete, the no-direct-write rule enforced by depcruise + test; `docs/acceptance/phase-6.md` | delivered |

Reality notes for 6.1:
- Migration `0022_ai_gateway`: `ai.providers`, `ai.models`, `ai.routing_rules` (platform defaults visible to every
  tenant through their RLS policy), `ai.model_calls` (never the content). Adapters speak HTTP through `fetch`
  (no vendor SDK); calls time out after 60 s.
- Routing: the property's rule, else the tenant's, else the platform default; models are tried in order, skipped when
  disabled, killed (`ai.kill.provider.<code>`, `ai.kill.model.<code>` feature flags), not serving the capability, or
  external without the opt-in. External providers need the platform allow-list `ai.external_providers.allowed`, the
  tenant's `ai.external_providers.enabled` and budget left in `ai.budget.monthly_limit_minor` (UTC month; reaching it
  raises one `AI_BUDGET_EXHAUSTED` alert per tenant and month). Retryable failures (timeout, 429, 5xx, bad response)
  fall back to the next model; every attempt is a `model_calls` row with its outcome.
- Egress: system parts above the provider's maximum class are left out, conversation turns above it become
  `[withheld]`; RESTRICTED never leaves; phone numbers, e-mail addresses and card-like numbers are masked for
  `EXTERNAL` providers. Embeddings refuse a provider that may not see every text.
- Administration: `/ai/providers`, `/ai/models`, `PUT /ai/routing-rules/platform` (platform administrators,
  `ai.provider.manage`); `GET|PUT /ai/routing-rules` and `GET /ai/usage` for a tenant (`ai.routing.manage`,
  `ai.usage.read`, general managers).

Reality notes for 6.2:
- Migration `0023_ai_executions`: `ai.executions`, `ai.execution_steps` (append-only by trigger; summaries hold tool
  codes, decisions, outcomes and argument *names*, never values or guest text), `ai.action_proposals` (arguments and
  context CONFIDENTIAL, one per approval). All three tenant-scoped with RLS. The execution tables arrive here rather
  than in 6.3 because every tool call is recorded as a step.
- Tools v1 live in the AI context (`application/tools/v1.ts`) and act only through the public APIs of guest, catalog,
  communications and organization, so the dependency stays one-way (no context imports the AI package). They are
  declared in `AI_MANIFEST.aiTools`; the manifest registry now refuses duplicate tool codes and tools whose
  permission no module declares. The guest, stay and conversation come from the execution, never from the model.
- `ToolExecutor.invoke`: tool in the agent version's list → kill switches (`ai.kill.agent.<code>`,
  `ai.kill.tool.<code>`) → zod arguments (issues report paths only) → `decide()` (READ/LOW auto, MEDIUM auto only for
  tools the agent version lists, HIGH proposes, CRITICAL refused, `ai.kill.auto_actions` turns everything but reading
  into proposals) → the handler runs in a fresh request context whose actor is `AI_AGENT` with the execution id, inside
  `ActionGate.execute({ action: tool.requiredPermission, aiRisk })`. Errors come back to the model as codes.
- The ActionGate authorizes AI actors through `AI_AGENT_AUTHORIZER` (only the permissions of the agent's tools, only
  in the execution's tenant and property, only inside a tool call) and step 6 `AI_POLICY_STAGE` (no tool call → 403,
  CRITICAL never, HIGH only when approved, never riskier than the tool declares). Without these providers
  (`AiModule.gateStages()`) every AI actor is refused.
- Proposals: `operations.cancel_service_request` (HIGH) prechecks that the request is the guest's and open, then
  creates the proposal and an `AI_ACTION` approval requested by the AI actor (four-eyes and human-only decisions come
  from the approval engine). Approving runs the call as proposed inside the deciding transaction (a failure rolls the
  approval back); the worker's `ai.proposal-settle` consumer of `ops.approval.decided` closes rejected or expired ones.
  `ApprovalSummary` gained `tenantId` so handlers can load their tenant-scoped records.

Reality notes for 6.3:
- Migration `0024_ai_agents`: `ai.prompts`/`ai.prompt_versions` (ordered `{layer, text}` blocks), `ai.agents`/
  `ai.agent_versions` (capability, prompt version, tool codes, context policy, autonomy policy, output contract,
  max steps), one PUBLISHED version per prompt/agent (partial unique index), published rows immutable except
  PUBLISHED → SUPERSEDED (trigger); `ai.feedback` (tenant data, one row per source). Agents are platform definitions:
  the built-in `GUEST_CONCIERGE` v1 lives in `domain/agents.ts` and is published on first use (`AgentCatalog`); a
  change means a new version number. Tenant prompt layers and an agent admin UI come later; `GET
  /properties/:id/ai/agents` lists the versions.
- Migration `0025_comms_reply_drafts`: ASSIST drafts belong to communications (`comms.reply_drafts`, at most one
  pending per conversation, body CONFIDENTIAL and cleared on guest anonymization). The inbox detail returns `aiDraft`;
  a staff reply may carry `draftId`, which marks it used, computes the edit distance (code-point Levenshtein in comms)
  and publishes `comms.reply_draft.used.v1`; the AI worker records `ai.feedback` (DRAFT_EDIT).
- AI mode: verified stay conversations open in the property's `comms.ai_mode.default` (OFF by default); staff switch
  it per conversation with `POST /properties/:id/conversations/:id/ai-mode` (`inbox.takeover`, audited; giving it back
  to the AI ends a hand-off). Takeover, hand-off and closing turn it off and discard pending drafts.
- Runtime (`ConciergeRuntime`): the worker consumer `ai.concierge` of `comms.message.received.v1` queues
  `ai.concierge.run` on `background-ai` (job id = message id). A run answers only the latest guest message of a
  verified AUTO/ASSIST conversation not handed off; the reply language comes from the message's script, else the
  guest's language. Context: `property.profile`, `guest.current_stay`, `catalog.services`, `catalog.open_requests`,
  `conversation.recent` (the conversation becomes the message history). The loop calls the gateway with the tools the
  model may use (all but `communication.send_message`, which the runtime uses for the reply) and a JSON output
  contract `{reply, handoff}`; it stops at `max_steps` (6). AUTO replies go through the `communication.send_message`
  tool (ActionGate); ASSIST saves a draft; a hand-off (model's reason, step budget, gateway failure, kill switch in AUTO)
  goes through `comms.handOff` as the AI actor. Steps: CONTEXT, MODEL_CALL, TOOL_CALL, DECISION, RESPONSE; execution
  totals (tokens, cost) are summed from its model calls when it closes.
- The worker now composes `AuthModule.forRoot({ httpGuard: false, stages })` and `CatalogServicesModule` (the route-free
  `CATALOG_API`), so AI tools run through the same ActionGate there. While wiring this, plain queue jobs (`onJob`) were
  found never to run in the worker (SLA sweep, approval expiry, notification delivery, heartbeat); fixed separately
  in `platform-queue`.

#### 6.D Knowledge v1 design (Sprint 6.4)

- **Context and dependency direction.** `@hotella/domain-knowledge` (code `knowledge`, schema `knowledge`) owns
  documents and retrieval. It depends on `@hotella/domain-ai/public` (Model Gateway embeddings, tool registration);
  the AI context never imports it. Its tool `knowledge.search` is declared in the knowledge manifest and registered
  into the AI tool registry at boot (`AI_TOOL_REGISTRY` in `ai/public`), the pattern 6.B describes for owning contexts.
- **Model.**
  ```text
  knowledge.documents          id, tenant_id, property_id (null = whole tenant), kind (POLICY|FAQ|MENU|MANUAL|GENERAL),
                               title, status (ACTIVE|ARCHIVED), version
  knowledge.document_versions  id, tenant_id, document_id, version_no, status (DRAFT|PUBLISHED|SUPERSEDED), language,
                               audience (GUEST|STAFF|ALL), classification (PUBLIC|INTERNAL|CONFIDENTIAL),
                               department_code, effective_from, effective_until, body, published_at
                               (immutable once published; one published version per document and language)
  knowledge.chunks             id, tenant_id, version_id, seq, text, normalized, search tsvector (generated, 'simple')
  knowledge.chunk_embeddings   chunk_id, tenant_id, model_code, dims, embedding vector (pgvector, any dimension)
  ```
- **Ingestion.** Publishing splits the body into paragraph chunks (~800 characters, sentence-aware, overlap of one
  sentence), stores an Arabic/Latin-normalized copy for keyword search (diacritics and tatweel removed, alef/ya/ta
  marbuta forms unified, lower case), and embeds the chunks through `MODEL_GATEWAY.embed` with the version's
  classification as data class. If no embedding route exists yet (Q8), chunks stay keyword-searchable and the worker's
  `knowledge.embed.sweep` job embeds them later.
- **Retrieval** (`KNOWLEDGE_API.search`): candidates are chunks of published versions of active documents of the
  tenant, for the property or the whole tenant, whose audience matches, whose classification is at most the caller's
  maximum, and that are effective today (UTC); the requested language first, then any. Keyword rank
  (`ts_rank_cd` on the normalized text) and vector rank (cosine distance for the same embedding model) are fused by
  reciprocal rank (k = 60), deterministic, no model call; results carry document, version id and number, title and
  excerpt (Spec §38 traceability). Exact vector search over the scoped candidates is enough for hotel-sized corpora;
  an HNSW index per embedding dimension comes with the chosen embedding model.
- **Safety.** The guest-facing tool searches only `GUEST`/`ALL` audiences at `PUBLIC` classification; excerpts return
  to the model inside the tool result marked as reference data, never instructions (Spec §37, CLAUDE.md rule 12).
  Structured live data (stays, requests, counts) stays with the domain tools.
- **API and permissions.** `knowledge.read` (search, list) and `knowledge.manage` (documents, versions, publish,
  archive); tenant-wide documents need tenant-wide membership. Concierge v2 adds `knowledge.search` to its tools and
  prompt.
- **Tests.** Chunking and normalization unit tests; integration: publish → chunks/embeddings, scope (property vs
  tenant, audience, classification, effective dates, archived, superseded), Arabic keyword match across spelling
  variants, hybrid ranking with the FAKE embedder, the tool through the ActionGate, tenant isolation (RLS).

Reality notes for 6.4:
- Migration `0026_knowledge` creates the `vector` extension (the pgvector image in CI, compose and the pilot; local
  development needs pgvector installed) and the `knowledge` schema with RLS on all four tables; `knowledge` joins the
  application schemas granted to the app role.
- Keyword search: the normalizer also folds Arabic-Indic digits and strips the definite article (and its و/ب/ك/ف/لل
  prefixes) from words, so "الإفطار", "إفطار" and "بالإفطار" meet; queries match any normalized term (OR) ranked by
  `ts_rank_cd`. Vector neighbours count only within cosine distance 0.5. "Rerank" is the reciprocal-rank fusion; a
  model reranker is not needed for hotel-sized corpora and would add a model call per search.
- The `FAKE` embedder now uses signed feature hashing of words (64 dimensions), so texts sharing words are similar and
  vector retrieval is exercised in tests; `FakeModelProvider.failWith` applies to embeddings too.
- Tools registered by owning contexts: `ai/public` exposes `AI_TOOL_REGISTRY` and the tool types; `KnowledgeCoreModule`
  registers `knowledge.search` when the AI tools are composed (API and worker). Guest Concierge v2 (agent and prompt
  version 2) adds the tool; v1 stays as published history.
- Embedding happens right after publishing (best effort) and in the worker's `knowledge.embed.sweep` job (every 5
  minutes on `background-ai`) for chunks published without an embedding route.

Reality notes for 6.5:
- The scripted-`FAKE` M2 run is `m2.integration.spec.ts` (the worker path, under the message event's correlation id);
  the no-direct-write rule is `boundaries.spec.ts` next to the ESLint and dependency-cruiser rules.
- The pilot smoke routes the stand-in as the platform default route (a GM with a property membership cannot change the
  tenant-wide routing, by design).
- The pilot smoke goes further than planned: a stand-in OpenAI-compatible model (`infra/docker/pilot/model-mock.mjs`,
  compose profile `tools`) lets the deployed worker run the concierge through the real adapter, so M2 is also proven on
  the deployed stack (queue job, gateway, tools, ActionGate, comms, execution record).

### Phase 7 — Housekeeping (detailed)

**Goal / acceptance (Spec §9, §16; part of M3):** a check-out reported by the PMS makes the room dirty and creates the
CHECKOUT clean with its credits for Housekeeping; attendants work their rooms from a board, DND and make-up-room
signals shape the day, a supervisor inspects where the property requires it, the room becomes ready on the property's
own readiness dimensions, and the PMS hears the new room status when the connector allows it. The supervisor gets a
balanced assignment proposal (deterministic, credits and floors), never an automatic re-assignment.

#### 7.A Domain model (schema `hk`, context `@hotella/domain-housekeeping`, code `hk`)

```text
hk.room_states            room_id (PK, = org room location id), tenant_id, property_id, occupancy (VACANT|OCCUPIED),
                          housekeeping (DIRTY|CLEANING|CLEAN|INSPECTING|INSPECTED|PICKUP), front_office (PMS status text,
                          e.g. OUT_OF_ORDER), last_cleaned_at, last_inspected_at, updated_at, version
                          (fast projection; never the only record)
hk.room_state_events      id, tenant_id, room_id, dimension (OCCUPANCY|HOUSEKEEPING|FRONT_OFFICE), from, to, cause
                          (PMS|JOB|INSPECTION|STAFF|SYSTEM), actor_type/id, job_id, occurred_at (append-only history)
hk.jobs                   id, tenant_id, property_id, work_item_id, room_id, stay_id, cleaning_type (STAYOVER|CHECKOUT|
                          ARRIVAL|DEEP_CLEAN|TURNDOWN|TOUCH_UP|VIP|OTHER), credits numeric(5,2), status (OPEN|IN_PROGRESS|
                          DONE|INSPECTED|FAILED_INSPECTION|SKIPPED|CANCELLED), scheduled_for date, started_at, completed_at,
                          inspected_at, version; unique (room_id, cleaning_type, scheduled_for) for generated jobs
hk.credit_rules           id, tenant_id, property_id, cleaning_type, room_type_id nullable, credits, version
hk.room_signals           id, tenant_id, property_id, room_id, signal (DND|MAKE_UP_ROOM|PRIVACY|SERVICE_REQUESTED),
                          source (PMS|BMS|SMART_ROOM|STAFF|GUEST_PORTAL), started_at, ended_at, actor_type/id
                          (one open row per room and signal; history kept)
hk.inspections            id, tenant_id, job_id, room_id, result (PASS|FAIL), notes, inspector_id, inspected_at
```

#### 7.B Design decisions taken before coding

- **Room status ≠ cleaning job** (Spec §9). The projection answers "what is the room now" fast; every change is an
  `hk.room_state_events` row (rule 10). Jobs are work items of kind `HK_JOB` in the operations engine (SLA, assignment
  history, escalation come from there); a job follows its work item's status like service requests do.
- **PMS is the source of truth for occupancy and front-office status** (rule 19): `hotel.guest.checked_in/out.v1`,
  `hotel.stay.room_changed.v1` and `hotel.room.status_changed.v1` drive occupancy and FO state; a check-out makes the room
  DIRTY and creates the CHECKOUT job. Housekeeping state changes made by the platform (cleaned, inspected) go back to
  the PMS as a `SET_ROOM_STATUS` command only when the instance has `ROOM_STATUS_WRITE` (ActionGate connector stage);
  otherwise they stay internal.
- **Generation:** CHECKOUT on check-out; STAYOVER for occupied rooms once per property-local day (worker job, hourly
  check of each property's configured hour, idempotent by the unique key); ARRIVAL for vacant-clean rooms with an
  arrival today when the property asks for it; TOUCH_UP after a failed inspection. DND at generation time does not skip
  the job: the job waits (`SKIPPED` only by staff, with a reason) and a make-up-room signal raises its priority.
- **Credits** are deterministic: property rule for (type, room type) → property rule for the type → platform default
  (CHECKOUT 1.0, STAYOVER 0.7, ARRIVAL 0.5, DEEP_CLEAN 2.0, TURNDOWN 0.4, TOUCH_UP 0.3, VIP 1.5, OTHER 0.5), copied onto
  the job at creation so later rule changes do not rewrite history.
- **Inspection hook (minimal, before the Phase 9 engine):** setting `hk.inspection.required` (property); when on, a done
  job moves the room to INSPECTING and a supervisor records PASS (→ INSPECTED) or FAIL (→ DIRTY + TOUCH_UP job).
- **Readiness v0** (Spec §16): dimensions configured per property (`hk.readiness.dimensions`: HOUSEKEEPING, INSPECTION,
  ENGINEERING, NO_OOO); each evaluates to PASS/FAIL/UNKNOWN with a reason (ENGINEERING from open engineering work at the
  room through `OPERATIONS_API`, NO_OOO from the front-office state). A room that becomes ready publishes
  `hk.room.ready.v1`.
- **Assignment proposal ("Housekeeping Copilot" v1):** deterministic balancing of the day's open jobs across chosen
  attendants by credits, keeping floors together (location tree) — returned as a proposal the supervisor applies or
  edits; nothing is assigned without a person. An AI explanation can come later; the numbers are code (rule 11).
- **Guest signals:** the guest web gets a DND / make-up-room toggle (guest scope `SERVICE_REQUEST`), recorded with source
  GUEST_PORTAL; the concierge gets `housekeeping.set_room_signal` (LOW) for its guest's room.
- **Events:** `hk.room.state_changed.v1`, `hk.job.created.v1`, `hk.job.status_changed.v1`, `hk.room_signal.changed.v1`,
  `hk.room.ready.v1`. **Permissions:** `hk.board.read`, `hk.room.manage`, `hk.job.manage`, `hk.inspect`,
  `hk.config.manage`; roles HK_SUPERVISOR (all but config), ROOM_ATTENDANT (`hk.board.read` + task actions), GM (all).

#### 7.C Sprints and progress

| Sprint | Scope | Status |
|---|---|---|
| 7.1 | `@hotella/domain-housekeeping`: room states projection + history, PMS event consumers (check-in/out, room change, room status), room signals (staff + guest web + PMS), room board API, events, permissions, tenant-leak tests | delivered |
| 7.2 | Jobs on the operations engine (`HK_JOB`), credit rules, generation (CHECKOUT, daily STAYOVER), job ↔ work item status, inspection hook (PASS/FAIL → TOUCH_UP), room status command to the PMS when allowed | delivered |
| 7.3 | Readiness v0 (configurable dimensions, `hk.room.ready.v1`), ARRIVAL generation, make-up-room jobs first, assignment balancer proposal + apply, concierge tool `housekeeping.set_room_signal`, guest web DND/make-up toggle | delivered |
| 7.4 | Staff web: housekeeping board (rooms by floor, states, signals, jobs, credits per attendant, assign, inspect) and the attendant's "my rooms" list, English and Arabic (RTL) with Playwright; pilot smoke: check-out → CHECKOUT job → done → room clean | delivered |
| 7.5 | Phase 7 acceptance (`docs/acceptance/phase-7.md`) | delivered — Phase 7 accepted |

Reality notes for 7.1:
- Migration `0027_housekeeping`: `hk.room_states` (one row per room, created on first touch as VACANT/DIRTY — the
  platform never claims a room clean without evidence; FK to `org.rooms`), append-only `hk.room_state_events`
  (dimension, from, to, cause, actor, job), `hk.room_signals` (one open row per room and signal, history kept). RLS on
  all three; `hk` joins the application schemas.
- PMS consumer `hk.room-states` (worker): check-in → OCCUPIED; check-out → VACANT + DIRTY; room move → old room VACANT +
  DIRTY, new room OCCUPIED; room status → housekeeping state (DIRTY/CLEAN/INSPECTED/PICKUP) or front-office
  restriction (OUT_OF_ORDER/OUT_OF_SERVICE), a housekeeping status lifting an earlier restriction. Events older than
  the last applied PMS event of the room are ignored.
- Staff move housekeeping states by hand only along allowed moves (`staffMoveAllowed`) with the room's version
  (optimistic locking), audited. DND/privacy and make-up-room/service-requested exclude each other; the guest web
  toggles DND or make-up-room for the guest's current room (`POST /guest/room-signals`, source GUEST_PORTAL).
- `HOUSEKEEPING_API` (`roomState`, `setGuestRoomSignal`) for the concierge tool and readiness in 7.3.

Reality notes for 7.2:
- Migration `0028_hk_jobs`: `hk.jobs` (unique work item; partial unique key (room, type, day) for GENERATED jobs only,
  so staff can add a second clean the same day), `hk.credit_rules` (one rule per type, or per type and room type),
  append-only `hk.inspections`; credits are `numeric(5,2)` checked to 0–20; FKs to tenant, property, room and room type;
  RLS on all three.
- `JobService`: a job is created with its `HK_JOB` work item (department HK, the room as location, title
  `hk.job.title`) in one transaction; worker consumer `hk.jobs` creates CHECKOUT cleans on check-out and on a room move
  (for the room left) and follows `ops.work_item.status_changed` for HK jobs (OPEN → IN_PROGRESS → DONE, or CANCELLED;
  finished jobs are never reopened by late events). IN_PROGRESS moves a dirty room to CLEANING; DONE moves it to CLEAN,
  or INSPECTING when `hk.inspection.required` is on. VIP jobs default to HIGH priority.
- Stayover sweep: worker job `hk.stayover.generate` every hour on `normal`; per property, once its local hour passed
  `hk.stayover.hour` (default 8), a STAYOVER clean for each occupied room, idempotent by the generated-job key; one
  property's failure is logged and does not stop the others.
- Inspection: `POST …/housekeeping/jobs/:id/inspection` (`hk.inspect`) only for a DONE job whose room is INSPECTING;
  PASS → room INSPECTED; FAIL → room DIRTY and a TOUCH_UP job (origin INSPECTION, HIGH). Skip
  (`POST …/jobs/:id/skip`, `hk.job.manage`) needs a reason, only while OPEN, and cancels the work item.
- PMS write-back: after CLEAN (no inspection) or INSPECTED, a `SET_ROOM_STATUS` command (`{room_number, status}`) goes to
  each ACTIVE instance whose effective capabilities include `ROOM_STATUS_WRITE` (otherwise the status stays internal);
  idempotency key per job and outcome, sent after the transaction and best effort (a refused command never undoes the
  clean). `SIM_PMS` declares the capability and command; the simulator records the status without echoing an event.
  The check reads the instance's effective capabilities through `INTEGRATIONS_API` rather than the gate's connector
  stage, because the write is a system follow-up of a person's action, not an action of its own.
- Moved to 7.3: ARRIVAL generation (needs the day's arrivals from the guest context) and the make-up-room signal
  raising an open job's priority.

Reality notes for 7.3:
- Readiness v0: `hk.room_states.ready` / `ready_since` (migration `0029_hk_readiness`), recomputed in the same
  transaction as every state change and by worker consumer `hk.readiness` when engineering work (department ENG) at
  the room is created or changes status (`OPERATIONS_API.openWorkItemsAtLocation`). A room is ready when it is VACANT
  and every dimension of `hk.readiness.dimensions` passes (default HOUSEKEEPING, ENGINEERING, NO_OOO); a dimension that
  could not be checked is UNKNOWN and never counts as passed. Becoming ready publishes `hk.room.ready.v1`;
  `GET …/housekeeping/rooms/:id/readiness` explains each dimension (reason codes localized under
  `hk.readiness.reason.*`). A change of the dimensions setting applies from the room's next change.
- ARRIVAL: the hourly sweep (`generateDaily`, same `hk.stayover.generate` job) also creates an ARRIVAL check for each
  vacant CLEAN/INSPECTED room an EXPECTED stay arriving that day is pre-assigned to, when `hk.arrival.clean` is on
  (`GUEST_API.expectedArrivals`); dirty rooms already have their CHECKOUT clean.
- Make-up room: instead of changing the work item's priority (which the operations engine does not support after
  creation, and which would bypass its SLA policy choice), the job list puts open jobs of rooms asking to be made up
  first and flags `makeUpRequested` / `doNotDisturb`; the attendant's list (7.4) uses the same order.
- Assignment proposal: `POST …/housekeeping/assignments/proposal` (`hk.job.manage`) balances the day's OPEN jobs across
  the chosen attendants (longest-floor-first by credits; a floor larger than 1.2× the fair share is split room by
  room; floor = `org.rooms.floor_label`, now on `RoomSummary`, else the room number without its last two digits);
  `POST …/housekeeping/assignments` applies a (possibly edited) plan through `OPERATIONS_API.assignTask` (the gate
  checks `task.assign`, operations checks the attendant may take tasks), all or nothing, audited.
- Concierge: `housekeeping.set_room_signal` (LOW, `hk.room.manage`, guest executions only) registered by the
  housekeeping core module through `AI_TOOL_REGISTRY`; Guest Concierge v3 (agent and prompt) offers it, v2 stays as
  history. Signals set this way have source GUEST_PORTAL and the AI execution as actor.
- Guest web: "Your room" with Do not disturb / Please make up my room toggles (`GET`/`POST /guest/room-signals`),
  English and Arabic, Playwright-covered.

Reality notes for 7.4:
- `apps/staff-web` `/[locale]/housekeeping`: "My rooms" (the person's assigned open jobs; Start and Done are one tap
  each through the task lifecycle — START implies accept), "Rooms" (board by floor with state, occupancy, readiness,
  out-of-order and guest signals) and "Today's jobs" (credits, status, flags, assignee; Passed/Failed for rooms waiting
  for inspection when the person holds `hk.inspect`; with `hk.job.manage` the day plan: choose attendants from
  `GET …/housekeeping/attendants` — active ROOM_ATTENDANT members — review the proposal, assign as proposed). The
  header links Inbox and Housekeeping. Playwright: attendant flow and supervisor flow in English, the board in Arabic
  (RTL mirroring checked).
- A property without an active Housekeeping department still gets its cleans: the job's work item is created without
  a department (unrouted, visible in the operations lists) and a warning is logged, rather than failing the PMS
  consumer.
- Pilot smoke ("housekeeping"): the simulator's SIM-C1 check-out from 506 created the CHECKOUT clean (credits 1.0,
  unrouted — the smoke creates departments later); the GM starts and completes its task; the worker moves room 506 to
  CLEAN and it becomes ready.

### Phase 8 — Engineering / CMMS (detailed)

**Goal / acceptance (Spec §10; completes M3 with Phase 7):** engineering works on real equipment. An AC complaint in
room 504 becomes a CORRECTIVE work order on the room's fan-coil unit with symptom, diagnosis, failure mode, cause,
resolution and downtime kept as structured history; preventive maintenance comes due by calendar or meter and creates
work from a versioned procedure; a room that cannot be sold is restricted (OOO/OOS/BLOCKED) and the PMS hears it when
the connector allows; engineering knowledge (manuals linked to assets and models) answers the engineer's question for
that exact asset; warranty rules flag a vendor case. Open engineering work keeps the room from being ready (7.3).

#### 8.A Domain model (schema `eng`, context `@hotella/domain-engineering`, code `eng`)

```text
eng.asset_types           id, tenant_id, code, properties_schema (controlled JSON schema), version; translations
                          (asset_type_translations: name)
eng.asset_models          id, tenant_id, asset_type_id, manufacturer, model_code, expected_life_months
eng.assets                id, tenant_id, property_id, parent_asset_id, asset_number (unique per property),
                          asset_type_id, asset_model_id, location_id (org location: room, plant room…), name,
                          serial_number, status (ACTIVE|OUT_OF_SERVICE|RETIRED), criticality (LOW|MEDIUM|HIGH|CRITICAL),
                          installed_at, warranty_until, properties (validated against the type schema), version
eng.asset_documents       id, tenant_id, asset_id | asset_model_id, knowledge_document_id (Knowledge owns the file and
                          its versions; engineering links), kind (MANUAL|DATASHEET|WARRANTY|DIAGRAM|PHOTO)
eng.failure_codes         id, tenant_id nullable (platform starter set), kind (SYMPTOM|FAILURE_MODE|CAUSE|RESOLUTION),
                          code, asset_type_id nullable, active; translations
eng.work_orders           id, tenant_id, property_id, work_item_id (the ops engine carries assignment, SLA, history),
                          type (CORRECTIVE|PREVENTIVE|PREDICTIVE|INSPECTION|EMERGENCY|PROJECT), asset_id, location_id,
                          reported_at, symptom_code, diagnosis (text, CONFIDENTIAL), failure_mode_code, cause_code,
                          resolution_code, downtime_started_at, downtime_ended_at, pm_plan_id, source (STAFF|GUEST_REQUEST|
                          PM|INSPECTION|AI), source_ref, status (follows the work item), version
eng.meters                id, tenant_id, asset_id, kind (RUNTIME_HOURS|CYCLES|ENERGY_KWH|TEMPERATURE|PRESSURE), unit,
                          cumulative (bool)
eng.meter_readings        id, tenant_id, meter_id, value numeric, read_at, source (STAFF|IOT|BMS|API), actor (append-only)
eng.pm_procedures         id, tenant_id, code; eng.pm_procedure_versions (immutable once published: steps JSON,
                          estimated minutes, required parts) — rule 9
eng.pm_plans              id, tenant_id, property_id, asset_id | asset_type_id (+ location scope), procedure_id,
                          trigger (CALENDAR every N days | METER every N units | CONDITION threshold), last_done_at,
                          last_meter_value, next_due_at / next_due_value, lead_days, active, version
eng.parts / eng.part_stock / eng.part_usages
                          minimal stock per property (on hand, reorder level) and usage per work order; no purchasing
                          (ERP adapters later, Spec §10.8)
eng.room_restrictions     id, tenant_id, property_id, room_id, kind (OOO|OOS|BLOCKED_OPERATIONALLY), reason_code,
                          starts_at, ends_at, work_order_id, source (PLATFORM|PMS), pms_sync_status (NOT_REQUIRED|PENDING|
                          SENT|FAILED), released_at, released_by (history kept)
eng.warranty_cases        id, tenant_id, work_order_id, asset_id, vendor, status (SUGGESTED|OPENED|CLOSED|DISMISSED)
```

#### 8.B Design decisions taken before coding

- **Work orders on the operations engine** like service requests and cleans: a work order is an `ENG_WORK_ORDER` work
  item for department ENG at the asset's location; it follows the work item's status. A guest `AC_PROBLEM` request
  (catalog, department ENG) becomes a CORRECTIVE work order on the asset at the room when engineering triages it (one
  click: "convert to work order", or automatically when the room has exactly one asset of the service's mapped asset
  type) — the request keeps its own lifecycle and is closed by the work.
- **Failure taxonomy** is four separate controlled code lists (platform starter set + tenant additions, translated);
  closing a CORRECTIVE/EMERGENCY order requires symptom, failure mode, cause and resolution codes (deterministic
  validation, rule 11). Downtime is computed from the downtime timestamps, never estimated by AI.
- **Asset types** carry a controlled JSON schema (zod-compatible subset: string/number/boolean/enum, required, units)
  validated on asset create/update; type schemas are versioned and never break existing assets.
- **PM due computation** is deterministic code: CALENDAR → last done + N days (property time zone), METER → last value
  + N units (cumulative meters), CONDITION → reading crosses a threshold. A worker sweep (hourly) creates the PREVENTIVE
  work order `lead_days` ahead with the plan's **published procedure version** pinned; completing it moves the plan.
- **Meter readings** are append-only; a reading lower than the last for a cumulative meter is refused (meter
  replacement is an explicit reset event). IoT/BMS readings arrive through the integration layer later (Phase 13).
- **Room restrictions:** creating OOO/OOS for a room publishes `eng.room_restriction.changed.v1`; housekeeping's
  front-office dimension already blocks readiness. When the property's PMS instance has `ROOM_RESTRICTION_WRITE`, the
  platform sends `SET_ROOM_RESTRICTION` (rule 19); a PMS-reported OOO stays PMS-owned (source PMS, read-only here).
- **Engineering knowledge:** asset documents are Knowledge documents (audience STAFF, classification INTERNAL) linked
  to an asset or model; the engineer's tool `engineering.search_manuals` restricts retrieval to the documents linked
  to that asset, its model and its type before falling back to the property's engineering documents.
- **Warranty:** rule-based — a CORRECTIVE order on an asset whose `warranty_until` is in the future suggests a warranty
  case (`SUGGESTED`) to the supervisor; AI may draft the vendor message later, never send it.
- **Engineering Copilot v1** (staff-facing agent, ASSIST only): explains an asset's history, finds the manual section,
  suggests likely failure modes from the asset model's history (counts, deterministic) — read tools only.
- **Arrival-risk intelligence v1** (rules first, AI for explanation): for today's and tomorrow's arrivals with an
  assigned room, a deterministic risk score from the room's readiness (housekeeping state, open engineering work,
  restrictions), the stay's ETA when the PMS gives it (`RESERVATION_READ`), VIP flag and the open work's SLA; shown to
  front desk and the duty manager with reasons; the AI may phrase the explanation, never compute the score.
- **Events:** `eng.work_order.created.v1`, `eng.work_order.closed.v1` (codes, downtime), `eng.pm.due.v1`,
  `eng.room_restriction.changed.v1`, `eng.meter.reading_recorded.v1`. **Permissions:** `eng.asset.read`,
  `eng.asset.manage`, `eng.work_order.read`, `eng.work_order.manage`, `eng.pm.manage`, `eng.restriction.manage`,
  `eng.parts.manage`, `eng.config.manage`; roles ENGINEER (read + work orders + readings), CHIEF_ENGINEER (all), GM.

#### 8.C Sprints and progress

| Sprint | Scope | Status |
|---|---|---|
| 8.1 | `@hotella/domain-engineering`: asset types (schema, translations), models, assets with hierarchy and location, asset documents linked to Knowledge, failure code lists with starter set, APIs, events, permissions, tenant-leak tests | delivered |
| 8.2 | Work orders on the operations engine (`ENG_WORK_ORDER`), types, taxonomy and downtime on close, guest request → work order, parts usage and stock, warranty suggestion | delivered |
| 8.3 | Meters and readings, PM procedures (versioned) and plans (CALENDAR/METER/CONDITION), due sweep creating PREVENTIVE work, room restrictions with PMS sync (`SET_ROOM_RESTRICTION`) | delivered |
| 8.4 | Engineering knowledge tool `engineering.search_manuals`, Engineering Copilot v1 (ASSIST), arrival-risk v1 (rules + explanation), staff web: work orders and asset pages (English/Arabic, Playwright), pilot smoke | delivered |
| 8.5 | Phase 8 acceptance (`docs/acceptance/phase-8.md`) | delivered |

Reality notes for 8.1:
- Migration `0030_engineering_assets` creates schema `eng`: `asset_types` (+ translations) whose `properties` field list
  is the controlled language of `domain/properties.ts` (TEXT, NUMBER with unit/range, BOOLEAN, CHOICE; unknown keys
  refused); a type change must keep existing assets valid (`compatibleChange`: only optional additions, no removal,
  retyping or narrowing of choices). `asset_models` per manufacturer + model code; `assets` with a unique number per
  property, a location (FK to `org.locations`), an optional parent (cycle refused), criticality, warranty date and
  typed values checked against the type; `asset_documents` link a knowledge document (FK) to an asset or a model —
  a document of another property cannot be linked; `failure_codes` (+ translations) per tenant with an optional asset
  type. RLS on every tenant table.
- Reference data is tenant-wide under `/eng/*`; assets are property-scoped under `/properties/:id/eng/*`.
  `POST /eng/failure-codes/starter` imports the starter taxonomy (8 symptoms, 7 failure modes, 7 causes, 8
  resolutions, English and Arabic names) and skips codes the tenant already has.
- `ENGINEERING_API` (`getAsset`, `assetsAtLocation`) and `KNOWLEDGE_API.getDocument` are the cross-context surfaces.
  Roles: ENGINEER reads equipment, new CHIEF_ENGINEER manages engineering, GM holds all engineering permissions.

Reality notes for 8.2:
- Migration `0031_engineering_work_orders`: `eng.work_orders` (number per property, serialized by an advisory lock;
  unique work item; asset optional, location required; taxonomy codes; diagnosis CONFIDENTIAL; downtime timestamps
  with an order check), `eng.parts` (stock never negative), append-only `eng.part_movements` (USAGE/RECEIPT),
  `eng.warranty_cases`; RLS on all.
- A staff work order creates an `ENG_WORK_ORDER` work item for department ENG (unrouted when the property has none)
  at the asset's location, priority by type and source (EMERGENCY → URGENT, guest-reported CORRECTIVE → HIGH,
  PREVENTIVE/PROJECT → LOW). `POST …/work-orders/from-request` adopts the guest request's own work item instead of
  creating a second one, so completing the work order also completes the request (and the guest is told by the
  catalog's existing follow-up); the room's single active top-level asset is picked when no asset is given.
  Automatic conversion by service → asset type mapping is left for later; conversion is one call.
- Codes must exist in the tenant taxonomy for their kind (never guessed). `POST …/work-orders/:id/complete` records
  the coding, refuses CORRECTIVE/EMERGENCY work that is not fully coded (`eng.work_order.coding_missing`), ends open
  downtime, completes the work item's tasks through the task lifecycle (`OPERATIONS_API.actOnTask`, START first for an
  unclaimed task) and closes the order with `eng.work_order.closed.v1` (codes, downtime minutes). Work finished from
  the generic task screen still closes the order (worker consumer `eng.work-orders`); it then shows `codingMissing`.
- A CORRECTIVE/EMERGENCY order on an asset under warranty on the reported day creates a SUGGESTED warranty case; a
  supervisor opens, closes or dismisses it. Nothing is sent to a vendor automatically.

Reality notes for 8.3:
- Migration `0032_engineering_maintenance`: `eng.meters` (one per asset and kind, last value cached),
  append-only `eng.meter_readings` (a lower reading of a cumulative meter is refused unless it is a `reset`, i.e. the
  meter was replaced), `eng.pm_procedures` + `eng.pm_procedure_versions` (a trigger refuses any change to a published
  version, rule 9; one draft at a time), `eng.pm_plans` (per asset; trigger CALENDAR every N days, METER every N units
  of one of the asset's meters, CONDITION above/below a reading; `lead_days`; `open_work_order_id` so a plan never has
  two open orders), `eng.room_restrictions` (one open per room, history kept); `work_orders.pm_plan_id` and
  `procedure_version_id`; RLS on all.
- Due rules are pure functions (`domain/pm.ts`). The worker job `eng.pm.sweep` (hourly, `normal`) opens a PREVENTIVE
  work order (priority LOW, department ENG) for each due plan with the latest published procedure version pinned and
  publishes `eng.pm.due.v1`; a plan without a published version is skipped with a warning. Completing the work moves
  the plan to today (property calendar) and, for meter plans, to the meter's value; cancelling frees it.
- Room restrictions (`eng.restriction.manage`): `eng.room_restriction.changed.v1`; housekeeping's NO_OOO readiness
  dimension now also fails on an open platform restriction (`ENGINEERING_API.activeRestriction`) and its readiness
  consumer refreshes the room on the event. With an ACTIVE instance holding `OOO_WRITE` (the existing capability,
  used instead of the planned `ROOM_RESTRICTION_WRITE`), `SET_ROOM_RESTRICTION` goes to the PMS on restrict and on
  release (idempotent per restriction and direction; outcome kept in `pms_sync`). `SIM_PMS` and the simulator accept
  it. PMS-reported out-of-order statuses stay PMS-owned (housekeeping front-office state).

Reality notes for 8.4:
- Engineering registers four READ tools through `AI_TOOL_REGISTRY` (declared in its manifest): `engineering.find_assets`
  (by room number and/or words of the number or name; wildcards are literal), `engineering.get_asset_history` (type,
  model, warranty, room, the last work orders with named codes, downtime and a truncated diagnosis),
  `engineering.likely_failure_modes` (deterministic counts of failure modes, causes and resolutions on closed work of
  the same model, else the same type, across the tenant — history, not a diagnosis) and `engineering.search_manuals`
  (Knowledge search restricted to the documents linked to the asset and its model — `KnowledgeSearchInput.documentIds`
  was added — then the property's STAFF documents up to INTERNAL). Handlers read engineering's tables directly after
  the tool's gate; no second gate.
- The AI context gained a generic staff-assistant runtime (`STAFF_ASSISTANT_API`): one question, one bounded run of
  the agent loop now shared with the concierge (`runAgentLoop`), output `{answer}`, language from the question's
  script, the sources (document versions) the tools returned, kill switch per agent, and an execution recorded with
  trigger STAFF on behalf of the user. It refuses an agent whose tools are not all READ (ASSIST only).
  `ENGINEERING_COPILOT` v1 is the first such agent. Staff call it through `POST /properties/:id/eng/copilot`
  (`question`, optional `assetId` passed as focus), which needs both `eng.asset.read` and `eng.work_order.read`.
- The identifier masking applied to external providers (ADR-0018) no longer mistakes record UUIDs and ISO dates for
  phone numbers: with Claude or ChatGPT the copilot must get asset ids back exactly to call its tools.
- Arrival risk v1 lives in housekeeping (it owns readiness): `GET /properties/:id/housekeeping/arrival-risk?day=today|tomorrow`
  (`hk.arrivals.read`, granted to housekeeping desks, duty managers and the front desk). `assessArrival` scores each
  expected arrival from fixed points per reason (restricted 60, no room 30, ETA passed 30, still occupied 25, dirty
  25, open engineering work 25, ETA within 2 h 20, urgent work 10, being cleaned 10, VIP 10 when anything else is
  wrong, awaiting inspection 5; capped at 100; HIGH ≥ 60, MEDIUM ≥ 25). The "explanation" is the ordered reason codes,
  shown translated; no model phrases it in v1 (nothing to add over the reasons, and the score must stay deterministic).
  `StaySummary` gained `eta` and `vip` (the VIP code itself stays in the guest context).
- Staff web: `/engineering` (open work orders with room and equipment labels — added to the work-order list/detail —
  coding, diagnosis, downtime and close-out; equipment with its history and the copilot panel, labelled as an AI
  suggestion with its sources) and `/arrivals` (today/tomorrow, riskiest first, reasons). Header sections now follow
  the person's permissions (`/me` loaded once per session). Playwright: English and Arabic for both.
- Pilot smoke ("engineering"): the guest's AC_PROBLEM request from M2 becomes a corrective work order on the
  fan-coil unit of their room; the copilot answers about that unit through the deployed OPENAI_COMPATIBLE adapter and
  the stand-in model (one READ tool call, execution COMPLETED); the work is coded and closed; arrival risk answers;
  the new staff pages render in both directions.

### Phase 9 — Inspections, Guest Relations, Lost & Found, Logbook (detailed)

**Goal / acceptance (Spec §11–§14, §17):** one inspection engine serves room checks, kitchen hygiene, pool safety,
fire equipment and patrols: a supervisor runs a published checklist at a location or on an asset, and a CRITICAL
finding opens urgent work for the right department by a deterministic rule. A guest complaint is recorded as a
complaint (not a request), with its evidence; the concierge may only *suggest* one (a candidate with confidence and
the reason), a person confirms it; service recovery that costs money needs an approval. Found and lost items are
logged with the staff's own description, matched with scored reasons that a person confirms, and released through an
audited claim. Each department keeps a shift logbook; an AI-drafted handover summary is reviewed and acknowledged by
the incoming supervisor.

#### 9.A Domain model (one schema per context)

```text
inspection.templates            id, tenant_id, code, scope (ROOM|AREA|ASSET), department_code, translations (name)
inspection.template_versions    id, template_id, version_no, status (DRAFT|PUBLISHED|SUPERSEDED), published_at —
                                immutable once published (rule 9)
inspection.sections / items     per version: section order + translations; item kind (PASS_FAIL|YES_NO|SCORE|NUMBER|
                                TEXT|PHOTO|MULTI_SELECT), required, options, min/max/pass threshold, translations,
                                finding rule (severity when failed: INFO|MINOR|MAJOR|CRITICAL)
inspection.inspections          id, tenant_id, property_id, template_version_id (pinned), location_id, asset_id
                                nullable, source (STAFF|SCHEDULE|HK_JOB|WORK_ORDER), source_ref, status (IN_PROGRESS|
                                COMPLETED|CANCELLED), inspector, started_at, completed_at, score, result (PASS|FAIL),
                                version
inspection.responses            inspection_id, item_id, value (typed jsonb), photo asset keys, note, answered_by/at
                                (append-only per answer; the latest counts)
inspection.findings             id, inspection_id, item_id, severity, description, status (OPEN|LINKED|RESOLVED),
                                work_item_id nullable

relations.complaint_categories  id, tenant_id, code, default_severity, department_code, translations
relations.complaints            id, tenant_id, property_id, number, guest_id, stay_id, category_id, severity (LOW|
                                MEDIUM|HIGH|CRITICAL), status (OPEN|IN_PROGRESS|RESOLVED|CLOSED), source (STAFF|
                                GUEST_WEB|CHAT|AI_CANDIDATE|SURVEY), summary, description (CONFIDENTIAL),
                                detected_sentiment nullable, opened_at, resolved_at, closed_at, version
relations.complaint_links       complaint_id, kind (ROOM|SERVICE_REQUEST|TASK|ASSET|WORK_ORDER|USER), ref
relations.complaint_evidence    complaint_id, kind (MESSAGE|NOTE|PHOTO|AI_REASON), ref/text, added_by (append-only)
relations.complaint_candidates  id, tenant_id, property_id, stay_id, conversation_id, message_id, category_code,
                                severity, confidence (0..1), reason, status (PENDING|CONFIRMED|DISMISSED), decided_by,
                                complaint_id
relations.recovery_actions      id, complaint_id, kind (APOLOGY|AMENITY|MEAL|DISCOUNT|REFUND|ROOM_MOVE|OTHER),
                                amount_minor nullable, currency, status (PROPOSED|PENDING_APPROVAL|DONE|REJECTED),
                                approval_id

lostfound.items                 id, tenant_id, property_id, number, kind (FOUND|LOST), description (staff's words,
                                never overwritten), category, colour, brand, location_id, found_or_lost_at, reported_by
                                (staff, or the guest for LOST), guest_id/stay_id nullable, storage_location, status
                                (REGISTERED|MATCHED|CLAIMED|RELEASED|DISPOSED), photo keys, retention_until, version
lostfound.ai_metadata           item_id, derived (object type, colours, brand guess) with model call ref — kept
                                apart from the staff's description
lostfound.match_candidates      found_item_id, lost_item_id, score, reasons[], source (RULES|AI), status (PROPOSED|
                                CONFIRMED|REJECTED), decided_by
lostfound.claims                id, item_id, claimant (guest id or name + id document type), verification note,
                                released_by, released_at, signature/photo key (audited)

logbook.entries                 id, tenant_id, property_id, department_code, shift_date, shift (MORNING|EVENING|NIGHT),
                                author, kind (NOTE|INCIDENT|HANDOVER_ITEM), text, links, created_at (append-only;
                                corrections are new entries)
logbook.handovers               id, property_id, department_code, shift_date, shift, summary (AI draft or written),
                                facts (the counts the summary was built from), execution_id nullable, status (DRAFT|
                                ACKNOWLEDGED), acknowledged_by/at
```

#### 9.B Design decisions taken before coding

- **One inspection engine, owned by `inspection`:** templates are tenant-wide, versioned and immutable once published;
  an inspection pins the version it was started on. Scoring and PASS/FAIL are deterministic (rule 11): required items
  answered, each item's own pass rule, overall FAIL when any MAJOR/CRITICAL finding exists. A failed item creates a
  finding with the item's configured severity; a **CRITICAL finding opens an URGENT work item** (operations engine,
  department of the template, at the inspection's location) by rule, and MAJOR ones are offered as one-click work.
  Photos go to object storage like brand images (type read from the bytes, size-limited).
- **Housekeeping keeps its PASS/FAIL hook** and may attach a completed generic inspection (`hk.inspection.template`
  per property): the inspection's result decides PASS/FAIL, so supervisors use one checklist everywhere.
- **Complaints are their own context (`relations`)** and never a service request. The concierge gets one LOW-risk tool,
  `relations.suggest_complaint`, that records a **candidate** (category, severity, confidence, the reason, the message
  as evidence) and never a complaint; a guest-relations person confirms (→ complaint with the evidence copied and
  the AI reason kept) or dismisses it. Sentiment alone never creates a complaint. Complaint numbers are sequential per
  property.
- **Service recovery:** APOLOGY/AMENITY/ROOM_MOVE/OTHER are recorded directly; MEAL, DISCOUNT and REFUND (anything
  with an amount) go through the approval engine (`RECOVERY_ACTION`, HIGH when above the property's threshold
  setting). Nothing is posted to the PMS folio in Phase 9 (a later PMS command, Phase 10+).
- **Lost & Found:** rule-based matching first (category, colour, brand, location and date window → score with
  reasons), optional AI vision metadata through the Model Gateway (`VISION` capability) stored separately; a person
  confirms a match; release requires a claim record (who, how verified) and is audited; unclaimed items reach
  `retention_until` (setting) and are disposed by an explicit, audited action, never silently.
- **Logbook:** entries are append-only per department and shift. The handover summary is a staff-assistant run
  (`SHIFT_HANDOVER` agent, READ tools: open tasks and SLA risks, open complaints, OOO/OOS rooms, open work orders,
  the shift's entries) that returns a draft with the **facts** (counts) it was built from; the incoming supervisor
  edits and acknowledges it. Counts are computed by the tools, never by the model.
- **Arrival risk** gains two reasons from these contexts: a failed room inspection today and a recurring failure on
  the room's equipment (closed corrective work on the same asset in the last 7 days).
- **Events:** `inspection.inspection.completed.v1`, `inspection.finding.raised.v1`, `relations.complaint.opened.v1`,
  `relations.complaint.resolved.v1`, `lostfound.item.registered.v1`, `lostfound.item.released.v1`,
  `logbook.handover.acknowledged.v1`. **Permissions:** `inspection.template.manage`, `inspection.perform`,
  `inspection.read`, `complaint.read`, `complaint.manage`, `complaint.recovery.manage`, `lostfound.read`,
  `lostfound.manage`, `lostfound.release`, `logbook.read`, `logbook.write`, `logbook.handover.acknowledge`.
- **Staff UX:** one screen per context in the staff web (inspection run on a phone, guest relations, lost & found,
  logbook/handover), English and Arabic, Playwright-covered; no guest-facing changes except the concierge's candidate
  tool and a guest "lost something" form later.

#### 9.C Sprints and progress

| Sprint | Scope | Status |
|---|---|---|
| 9.1 | Inspection engine: templates/versions/sections/items, publish, inspections with responses, photos, deterministic scoring and findings, CRITICAL → urgent work, housekeeping bridge, staff web inspection runner | delivered |
| 9.2 | Guest relations: categories, complaints with links and evidence, candidates from the concierge tool, recovery actions with approvals, staff web | delivered |
| 9.3 | Lost & Found: items, rule matching, optional vision metadata, claims and release, retention/disposal, staff web | delivered |
| 9.4 | Logbook and shift handover with the `SHIFT_HANDOVER` assistant; arrival-risk reasons from inspections and recurring failures; pilot smoke | delivered |
| 9.5 | Lost & Found vision on photos (owner decision 2026-10-04): optional per property, off by default; provider-neutral `VISION` capability of the Model Gateway; metadata stripped; no guest data in the request | done |
| 9.5 | Phase 9 acceptance (`docs/acceptance/phase-9.md`) | delivered |

Reality notes for 9.1:
- `@hotella/domain-inspection`, migration `0033_inspection_engine`: `templates` (+ translations, scope ROOM/AREA/ASSET,
  the department its findings go to), `template_versions` (DRAFT/PUBLISHED), `template_sections` and `template_items`
  (+ translations; item labels carry option labels per locale), `inspections` (number per property, pinned version,
  location, optional asset, source, inspector, score, result), append-only `responses` (latest per item counts) and
  `findings`. Triggers refuse any change to a published version or to its sections, items and their translations;
  RLS on every tenant table. A draft is replaced as a whole (one per template); publishing checks every rule
  (`ruleProblem`). The application role is granted the new schema (`APPLICATION_SCHEMAS`).
- `evaluate()` is the only judge: PASS_FAIL, YES_NO (expected answer), SCORE (scale, pass-from), NUMBER (range),
  MULTI_SELECT (failing options); TEXT and PHOTO are evidence. Completion needs every required item, then stores
  score and result (FAIL on any MAJOR/CRITICAL) and one finding per failed item. CRITICAL → URGENT `INSPECTION_FINDING`
  work for the template's department (unrouted when that department is not active) at the inspection's place; other
  findings get work on request; the worker resolves a finding when its work is resolved (cancelled work reopens it).
- Photos: `POST …/inspections/:id/photos` with the raw image (PNG/JPEG/WebP read from the bytes, 2 MB), stored under
  `inspection/<tenant>/<inspection>/`; a PHOTO answer may only name photos of its own inspection; served to
  `inspection.read`. Image sniffing moved to `platform-storage` (shared with hotel logos).
- Housekeeping bridge: the supervisor's inspection of a clean may pass `inspectionId` (a completed checklist inspection
  at the job's room) instead of a bare result; its result decides and `hk.inspections.checklist_inspection_id` keeps
  the link (migration 0034; no cross-schema FK, the reference is checked through `INSPECTION_API`).
- Roles: inspection.read/perform for housekeeping and engineering desks and engineers, template management for the
  GM and the chief engineer, read for duty managers.
- Staff web `/inspections`: start a published checklist on a room, phone-sized answer controls per kind (buttons,
  numbers, text, photos from the camera, chips), complete, findings with "open work"; read-only for viewers.
  Playwright English and Arabic.

Reality notes for 9.2:
- `@hotella/domain-relations`, migration `0035_guest_relations`: `complaint_categories` (+ translations, default
  severity, owning department; starter set NOISE, CLEANLINESS, MAINTENANCE, STAFF, FOOD, BILLING, AMENITIES, SAFETY,
  OTHER in English and Arabic), `complaints` (number per property under an advisory lock, stay/guest, category,
  severity, source, version), append-only `complaint_status_history` and `complaint_evidence` (triggers), `complaint_links`
  (ROOM/SERVICE_REQUEST/TASK/ASSET/WORK_ORDER/USER), `complaint_candidates` (with the guest's own words, the execution
  id, and a partial unique index: one PENDING per stay and category) and `recovery_actions`; RLS on every table.
- Lifecycle (`domain/complaints.ts`): OPEN → IN_PROGRESS/RESOLVED, IN_PROGRESS → RESOLVED, RESOLVED → IN_PROGRESS
  (reopen) or CLOSED; CLOSED is final; optimistic `version`. Resolving publishes `relations.complaint.resolved.v1`
  with the minutes open and the recovery kinds done.
- Concierge (GUEST_CONCIERGE v4): `relations.suggest_complaint` (LOW, permission `complaint.suggest`, needs the guest)
  records a candidate only — below confidence 0.6 nothing is kept; a code the tenant does not use is kept under
  OTHER; the guest is never told. Confirming (`complaint.manage`) creates the complaint with source AI_CANDIDATE and
  copies the guest's words (MESSAGE) and the AI's reason with its confidence (AI_REASON) as evidence; the person may
  correct category, severity and summary. Dismissing keeps the candidate as DISMISSED with who and when.
- Recovery (`complaint.recovery.manage`): APOLOGY/AMENITY/ROOM_MOVE/OTHER are DONE at once; MEAL, DISCOUNT and REFUND
  (amount required for discount and refund, in the property's currency) become PENDING_APPROVAL with a
  `RECOVERY_ACTION` approval, HIGH from `relations.recovery.high_risk_from_minor` (default 50 000 minor units). The
  approval handler sets DONE in the approving transaction; the worker settles rejected or expired approvals as
  REJECTED (idempotent). No PROPOSED state was needed: a recovery is either done or waiting for its approval.
  Nothing is posted to the PMS folio.
- `RELATIONS_API.openComplaints` (ids, codes, severities; never the guest's words) for the shift handover in 9.4.
- Roles: complaint read/manage/recovery for the GM, duty manager and guest relations (+ `approval.read`), category
  management for the GM, read/manage for the front desk.
- Staff web `/relations`: the concierge's suggestions with confidence, the guest's words and the reason (confirm /
  dismiss), record a complaint, list and detail with evidence, notes, status buttons, recovery with "waits for
  approval", history; read-only for viewers. Playwright English and Arabic. The pilot smoke covers relations in 9.4.

Reality notes for 9.3:
- `@hotella/domain-lostfound`, migration `0036_lost_and_found`: `items` (FOUND and LOST in one table, number per
  property, category, colour, brand, location or place note, storage, photos, `valuable` for phones, jewellery,
  watches, documents, money and electronics, `retention_until` for found items), append-only `item_history` and
  `claims` (triggers), `ai_metadata` and `match_candidates` (unique per pair); a trigger refuses any change to an
  item's `description` (Spec §13: the reporter's words are never overwritten). RLS on every table.
- Matching (`domain/items.ts`, unit-tested): same category and the found date within 1 day before to 30 days after
  the loss are required; then colour ±20, brand ±20 (normalised), same place +15, within 2 days +10; AI-derived
  colour/brand only fill gaps (+10 each); kept from 50. It runs when either item is registered and again when AI
  attributes arrive. Confirming a match (`lostfound.manage`) marks both items MATCHED and rejects the other
  proposals involving them.
- AI attributes instead of vision: the Model Gateway takes text only, and sending photos to an external provider
  (they may show IDs or faces) would be a privacy decision of its own. So the worker asks the gateway
  (`STRUCTURED_OUTPUT`, agent code `LOSTFOUND_ATTRIBUTES`, egress policy, budget and tenant opt-in apply) to read
  the **description** into object type, colours, brand and keywords, stored in `ai_metadata`; photos never leave
  the platform. Setting `lostfound.ai.attributes` (default on). Vision on photos stays a later, owner-approved step.
- Release (`lostfound.release`): only a found, open item; the claim records who took it, the kind of document shown
  (never its number), how they were verified and the handover; the confirmed lost report becomes CLAIMED;
  `lostfound.item.released.v1` with the days held. Disposal (`lostfound.manage`): only after `retention_until`
  (`lostfound.retention.days`, default 90), with a method and a reason, audited, `lostfound.item.disposed.v1`;
  `GET …/lostfound/items?due=true` lists what may be disposed of. Nothing is disposed of automatically.
- Permissions gained `lostfound.register` (hand an item in) so attendants and engineers can register what they find
  without seeing other items; `lostfound.manage` records guests' losses, decides matches, stores and disposes.
  Roles: the GM, duty manager, front desk and guest relations hold all four; the housekeeping supervisor reads,
  registers and manages; attendants, engineers register.
- `LOSTFOUND_API.openCounts` (found, lost, matches to decide, past retention) for the shift handover in 9.4.
- Staff web `/lostfound`: phone-first "hand in" form for everyone; for the desk, "record a guest's loss", proposed
  matches with score and reasons, lists (found, lost reports, past retention), detail with photos (camera), AI
  reading, matches, release form and disposal form, history. Playwright English and Arabic.

**9.5 — Lost & Found vision (owner decision 2026-10-04).**
- *Scope:* when the property enables `lostfound.ai.vision` (configuration, **default off**; entitlement `AI_VISION`),
  a photo attached to a found item is read by a vision model into suggestions: object type, category, short
  description, colours, material, brand, keywords. Suggestions are stored apart from the staff description in
  `ai_metadata` (never overwrite it, Spec §13) and feed the existing matcher and a duplicate check between found items.
- *Privacy:* the request carries only the image — EXIF/XMP/GPS metadata stripped and the image re-encoded and
  downscaled (≤ 1568 px) on the platform — and a fixed instruction; never the guest, reservation, room or staff
  identity. Images are classified SENSITIVE (they may show faces or documents); the egress policy must allow
  SENSITIVE for the routed provider, otherwise the call is refused and nothing leaves the platform. The instruction
  tells the model to ignore any people or text in the image and not to transcribe documents.
- *Provider abstraction:* the Model Gateway gains image input (`GatewayMessage` content parts) for the `VISION`
  capability; each provider adapter (Anthropic, OpenAI; others later) maps it to its own format; routing, budget,
  kill switches, metering (`AI_VISION`) and the execution record apply as for text. Keys stay in OpenBao
  (`kv/hotella/ai/<provider>`).
- *Tests:* metadata stripping; refusal when disabled or not entitled or the egress policy forbids SENSITIVE;
  adapters' request shapes; worker job end to end with the fake provider; en/ar labels for suggestions.

- *As built (9.5):* `platform-storage` `imageForModel()` (sharp 0.34, ADR-0016 row): only PNG/JPEG/WebP by
  their bytes, at most 50 MP decoded, turned upright from EXIF, longest edge ≤ 1568 px, re-encoded as JPEG — EXIF, XMP,
  IPTC, GPS, ICC and comments are left behind (unit test with a name and GPS in the EXIF). Model Gateway: user turns
  take `images` (`GatewayImage`: media type, bytes, data class) only with `VISION` (else 400
  `ai.gateway.images_need_vision`); a routed provider whose egress policy may not receive the image's class is not
  called at all, and when none may, the call fails with `EGRESS_POLICY` and nothing is sent; Anthropic gets base64
  `image` blocks, OpenAI-compatible servers `image_url` data URLs (adapter tests); metering `AI_VISION` per call as
  before. Lost & Found: `lostfound.item.photo_added.v1` (ids and photo name) on every upload; the worker (now with
  lazily-credentialed object storage) queues `lostfound.vision.read` on `background-ai` for found items only;
  `VisionService` reads a photo when `lostfound.ai.vision` (default **off**) is on for the property and the licence
  holds `AI_VISION`, sends the fixed instruction (ignore people, never transcribe documents, cards, screens or labels;
  the photo is data) and the re-encoded image as SENSITIVE, agent `LOSTFOUND_VISION`, and stores the suggestions
  (object type, category, short description, colours, material, brand, keywords) in `lostfound.vision_readings`
  (migration `0048_lostfound_vision`, one row per photo, RLS) — never in the staff's description. Matching merges the
  description's AI attributes and every photo reading (`mergeSuggestions`); a deterministic duplicate check
  (`duplicateScore`: same category, a model named the same object, found within 3 days, colour/brand/place; a
  contradicting brand rules it out; kept from 60) lists possible second hand-ins on the found item's detail. Staff web:
  "AI read the photo as …" with the description, and "Possibly the same item handed in again" with reasons (five
  locales, Playwright en/ar). Tests: image stripping; gateway (VISION only, EGRESS_POLICY with nothing sent, the
  on-prem model behind gets the image part); Lost & Found integration (off by default, on without the licence, a
  failure, read once, what was sent has no metadata and no guest/room/staff text, the match it brings, a duplicate, a
  guest's lost-report photo never sent).

Reality notes for 9.4:
- `@hotella/domain-logbook`, migration `0037_logbook`: `entries` (department, shift date and shift, kind NOTE /
  INCIDENT / HANDOVER_ITEM, text, optional room, `corrects_entry_id`; append-only by trigger) and `handovers` (one
  per department and shift, summary, the `facts` it was built from, source AI/WRITTEN, `edited`, the drafting
  execution, DRAFT → ACKNOWLEDGED; a trigger refuses any change to an acknowledged one). RLS on both.
- Shifts (`domain/shifts.ts`, unit-tested): MORNING/EVENING/NIGHT from the property's wall-clock starts (setting
  `logbook.shift.starts`, default 07:00/15:00/23:00), time-zone and DST aware through `platform-time`; the small hours
  belong to the night that started the evening before. Entries always land on the shift running when written.
- Facts (`FactsService`), counted by code and stored with the draft: the department's open/urgent/overdue work (new
  `OPERATIONS_API.openWorkSummary`), open complaints and how many are HIGH/CRITICAL (`RELATIONS_API`), rooms out
  of order (new `ENGINEERING_API.activeRestrictions`), lost & found counts (`LOSTFOUND_API`) and the shift's entries.
  A context the deployment does not compose is reported as null.
- `SHIFT_HANDOVER` staff assistant (ASSIST, one READ tool `logbook.get_shift_facts`, prompt: copy numbers exactly,
  never recompute) writes the summary in the person's language; without an answer the summary starts empty and is
  written by hand. Editing marks it `edited`; only a person other than the drafter acknowledges it
  (`logbook.handover.acknowledge`), publishing `logbook.handover.acknowledged.v1`. Departments are checked against
  the property's active departments; anyone with `logbook.write` may write in any department's log (v1).
- Arrival risk: `INSPECTION_FAILED_TODAY` (25, the room's latest completed inspection failed today in the property's
  time zone) and `RECURRING_FAILURE` (15, corrective work completed on the room's equipment in the last 7 days, new
  `ENGINEERING_API.recentCorrectiveWork`); labels in the staff web.
- Roles: read/write/acknowledge for the GM, duty manager, housekeeping supervisor, chief engineer and front desk;
  read/write for engineers and guest relations.
- Staff web `/logbook`: department picker, the running shift and its window, the facts as tiles, add a note /
  incident / item for the next shift (with room), the entries, and the handover card (draft with the assistant,
  edit, save, acknowledge — hidden for the drafter). Playwright English and Arabic.
- Pilot smoke (`smoke-guest.sh`, Phase 9 section): a group GM (tenant-wide) publishes a room checklist and the
  property GM runs it on the guest's room (critical failure → linked urgent work); starter complaint categories, a
  complaint on the stay with a discount approved by the group GM; a found phone matched to the guest's report and
  handed back against a claim; an incident in the logbook and a handover drafted by the SHIFT_HANDOVER assistant
  through the on-prem model stand-in (the execution shows one READ tool call), refused to its drafter and
  acknowledged by the group GM; the new staff pages render in both directions.

### Phase 10 — Real OPERA 5 On-Premise Integration (M4a)
`apps/hotel-agent` (.NET 10 LTS worker service — CLAUDE.md stack; this line said .NET 8 before the version policy of ADR-0016): registration with signed identity, outbound WSS/HTTPS, SQLite durable queue (pending events, acks, checkpoints, config cache, license token, health), the link of ADR-0017 (MSI installer, enrollment, mTLS, WSS/HTTPS client, SQLite WAL queue with ordering and acks, signed-command verification, licence verification, signed updater with rollback) and three adapters per ADR-0014 — `OPERA5_FIAS` (IFC8/FIAS TCP link: link-alive, DB-sync handshake, GI/GO/GC/RE records → canonical events; primary, real-time), `OPERA5_OWS` (SOAP OPERA Web Services: future reservations, arrivals, profiles, ETA → `RESERVATION_READ`/`GUEST_READ`, enabling pre-arrival and arrival-risk; where licensed), `OPERA5_DBVIEW` (optional read-only Oracle views, reconciliation only, never an event source; **superseded by
ADR-0019**: the read-only database becomes the first-class connector `OPERA5_DB`, see 10.D) — mapping, canonical events, reconciliation jobs (MATCH/MISSING_INTERNAL/MISSING_EXTERNAL/DIFFERENT), health states, signed offline license validation (public key), controlled update/rollback. Platform side: the three adapters share one connector manifest family through the same Connector SDK as `SIM_PMS`; predefined signed operations only (no remote shell). Room-status/OOO writes toward OPERA are enabled per instance only after verification at the pilot. **Pilot prerequisites:** IFC8 license for a new generic interface, OWS license status, contractual possibility of a read-only DB account (the dedicated `HOTELLA_RO` account of the OPERA Integration Guide §6).

**Goal / acceptance (Spec §48–§54, §57, §62; ADR-0014, ADR-0017):** a hotel installs one agent, pastes an enrollment
token and allows outbound 443; from then on OPERA 5's FIAS records reach the platform as canonical events in order,
exactly once, through days offline; OWS adds future reservations and ETA where licensed; reconciliation finds what was
missed; the platform can only send predefined signed commands; the agent runs under a signed licence with an offline
grace and updates itself from signed packages with rollback. Proven end to end against the simulator's byte-level
IFC8/FIAS and OWS faces before the pilot; the pilot only swaps the simulator for the hotel's OPERA.

#### 10.A Components
```text
apps/hotel-agent/                      .NET 10 solution (built and tested in CI with setup-dotnet)
  src/Hotella.Agent                    host: Worker service (Windows service / systemd), config, JSON logs (no PII), CLI
                                       (enroll, run, status)
  src/Hotella.Agent.Core               identity (ECDSA P-256 key + CSR, OS-protected key store), durable queue (SQLite,
                                       WAL, ordered, cumulative acks, retention), link client (mTLS ClientWebSocket:
                                       hello/welcome/message/ack/resend/heartbeat/throttle, HTTPS batches, reconnect
                                       1 s → 60 s with jitter), command verification (Ed25519 over canonical JSON, same
                                       bytes as platform-pki), command dispatch to adapters, licence verification, health
  src/Hotella.Agent.Fias               IFC8/FIAS TCP client: STX/ETX framing, LS/LD/LR/LA link handshake and link-alive,
                                       DR → DS/DR…/DE database sync, records → `FIAS_RECORD` messages, outbound RE for
                                       room status (only when the capability is enabled)
  src/Hotella.Agent.Ows                OWS SOAP client: arrivals/reservations polling window → `OWS_RESERVATION`,
                                       profiles → `OWS_PROFILE` (same payloads as the simulator's OWS face)
  src/Hotella.Agent.OperaDb            (10.7, ADR-0019; replaces the planned DbView) read-only Oracle connector:
                                       allow-listed parameterised SELECTs of data contract v1, read-only transactions,
                                       privilege self-check, answers link-protocol-2 queries
  src/Hotella.Agent.Updater            signed package manifest → download, verify (SHA-256 + Ed25519), stage, swap,
                                       health check, rollback
  test/…                               xUnit: framing, queue, canonical JSON/signature vectors shared with TypeScript
apps/pms-simulator                     gains a byte-level IFC8/FIAS TCP server and an OWS SOAP endpoint, so the .NET agent
                                       is tested against wire formats, not JSON shortcuts
packages/domain/integrations           connector family OPERA5_FIAS / OPERA5_OWS / OPERA5_DBVIEW reusing the FIAS record
                                       parser and the OWS mapping (core domains still see only canonical events);
                                       signed licence tokens delivered on enrol/renew/welcome
```

#### 10.B Design decisions taken before coding
- **Same protocol, second implementation.** The .NET agent speaks exactly the link contract of
  `packages/contracts/connectors/src/link.ts` (protocol 1). The TypeScript reference agent stays the executable
  specification; a cross-language test runs the .NET agent against the real `agent-gateway` and asserts the same
  outcomes (enrolment, ordering, resend, duplicate, revoked certificate, signed command). Shared test vectors pin the
  canonical JSON bytes and an Ed25519 signature produced by `platform-pki`.
- **Dependencies (ADR-0016 maturity gate):** `Microsoft.Data.Sqlite` (prebuilt native SQLite, nothing compiled at
  install), `BouncyCastle.Cryptography` for Ed25519 only (the BCL has no Ed25519), `Microsoft.Extensions.Hosting`
  with `.WindowsServices`/`.Systemd`, xUnit for tests; `Oracle.ManagedDataAccess.Core` only in the optional DbView
  project. ECDSA P-256, X.509 CSRs, TLS 1.3 and WebSockets come from the BCL.
- **Secrets at the hotel** (OPERA/OWS credentials, the agent's private key) live in an OS-protected store (DPAPI on
  Windows, a 0600 file owned by the service user on Linux) behind one interface; never in config files or logs, never
  sent to the platform.
- **FIAS idempotency:** `source_message_id` = SHA-256 of (instance, record type, room, reservation number, date, time,
  record body) so a re-sent record after an IFC8 reconnect is a no-op on the platform; the per-instance sequence keeps
  order. A database sync (DS…DE) is forwarded as received and the platform's existing late-event guard decides.
- **Commands:** `RESYNC_IN_HOUSE` (FIAS DR) in 10.2; `SET_ROOM_STATUS` (FIAS RE outbound) implemented but advertised
  only when the instance's configuration enables `ROOM_STATUS_WRITE` after verification at the pilot. No other
  command exists; there is no shell.
- **Licence (Spec §62):** an Ed25519-signed token (tenant, property, instance, connector, capabilities, issued,
  expires, offline grace 14 days) delivered by the platform and verified offline by the agent with the pinned key. Past
  the grace the agent keeps buffering FIAS records but executes no command until a fresh token arrives. Phase 11
  builds the commercial control plane on top of the same token.
- **Updates:** a signed manifest (version, SHA-256, size, ring) and package from `updates.…`; the updater stages it,
  starts it, waits for a healthy link, and rolls back on failure. The agent never updates OPERA or itself in place.
- **Packaging:** self-contained publish for `win-x64` and `linux-x64`; Windows service install via the MSI (WiX, built
  on a Windows CI runner in 10.4) and a systemd unit for Linux. Enrolment is `hotella-agent enroll --token-file …`
  (the MSI asks for the token; 10.1 notes: never on the command line).

#### 10.C Sprints and progress

| Sprint | Scope | Status |
|---|---|---|
| 10.1 | .NET agent core: solution, host, config, identity and enrolment (CSR), OS key store, SQLite durable queue, mTLS WSS link with acks/resend/heartbeats/batches, signed-command verification; shared vectors; cross-language test against `agent-gateway`; CI job | delivered |
| 10.2 | FIAS adapter (IFC8 TCP, link handshake, link-alive, database sync, records), simulator IFC8 face, `OPERA5_FIAS` connector, `RESYNC_IN_HOUSE` and gated `SET_ROOM_STATUS` | delivered |
| 10.3 | OWS adapter (SOAP polling, reservations and profiles), simulator OWS SOAP face, `OPERA5_OWS` connector; optional `OPERA5_DBVIEW` reconciliation adapter | delivered (DBVIEW deferred, see notes) |
| 10.4 | Licence tokens (issue, verify offline, grace), health states, signed updater with rollback, packaging (self-contained publish, systemd unit, Windows service + MSI on a Windows runner) | delivered (MSI: owner decision, see notes) |
| 10.5 | Phase 10 acceptance (`docs/acceptance/phase-10.md`); the pilot prerequisites stay owner items | delivered |
| 10.6 | Unified OPERA Adapter (`PMS_API`) and per-property capability registry (10.D) | delivered (writes routed; reads arrive with 10.7, see notes) |
| 10.7 | Link protocol 2 (`query`/`query_result`) and the `OPERA5_DB` read-only connector (10.D) | delivered (see notes; real Oracle verified at the pilot) |
| 10.8 | Planova Standard IFC8/FIAS Profile v1 alignment and OWS standard connector v1 (reads + supported writes) (10.D) | delivered (see notes; reservation writes held until verified) |
| 10.9 | Commissioning tooling: Interface Sheet comparison, DB probe, OWS verification, capability sign-off; OPERA integration acceptance (10.D) | delivered (`docs/acceptance/opera-integration.md`; the real hotel at the pilot) |
| 10.10 | Windows MSI with WiX v5 (ADR-0020): enrollment codes, multi-instance hosts, `hotella-agent setup` shared with `install.ps1`, WiX v5 MSI, Windows CI job (build, install, uninstall, no code in the log) | done |

**Reality notes for 10.1 (delivered).**
- Solution `apps/hotel-agent/Hotella.Agent.slnx`: `Hotella.Agent.Core` (identity, durable queue, link, command
  verification, settings and renewal policy), `Hotella.Agent` (the `hotella-agent` executable), `test/Hotella.Agent.Tests`
  (xUnit) and `test/Hotella.Agent.Conformance` (test tooling only, never shipped). Analyzers run at
  `latest-recommended` with warnings as errors; output goes to `artifacts/bin/<project>/<debug|release>/`.
- Shared vector `packages/platform/pki/test-vectors/command-frame.json`: canonical bytes and an Ed25519 signature made
  by `platform-pki`; `vector.spec.ts` keeps the platform on it and `CanonicalJsonTests` keeps the agent on it (numbers
  are written like ECMAScript, keys sorted by UTF-16 code unit, strings escaped like `JSON.stringify`).
- Cross-language e2e `apps/pms-simulator/test/dotnet-agent.e2e-spec.ts` runs the same scenario as the reference agent
  (`basic-stay.yml` with duplicate, reorder and dropped-connection chaos) through the .NET link against the real
  gateway, plus enrolment (single use), capabilities, heartbeats, a signed `RESYNC_IN_HOUSE`, certificate renewal,
  HTTPS batches and revocation; the last case starts the real `hotella-agent` executable (enrol from a token file,
  `status`, `run` until the platform sees it linked). The gateway setup is shared with `link.e2e-spec.ts`
  (`test/gateway-harness.ts`); `runScenario` takes any `ScenarioLink`.
- Found by the cross-language test and fixed in the .NET link before it shipped: a `resend` arriving while a send pass
  was in flight could be undone by that pass (the cursor is now rewound only by the sender loop); an exception other
  than a socket error ended the link silently (every failure now reconnects with back-off); a renewed certificate was
  not used by the running link (`UseIdentity`).
- Configuration: `agent.json` beside the program, the machine's `/etc/hotella-agent/agent.json` or
  `%ProgramData%\Hotella\Agent\agent.json`, `HOTELLA_AGENT_` variables, `--Agent:Key=value` switches; the shipped
  sample is `agent.example.json` and is not loaded (list settings merge index by index). The identity is in the data
  directory (`/var/lib/hotella-agent` or `%ProgramData%\Hotella\Agent`) — DPAPI on Windows, 0700/0600 on Linux.
- The enrolment token is read from a file or stdin (`--token-file -`), never from the command line (shell history,
  process list). Re-enrolment over an existing identity needs `--replace`.
- Upkeep runs hourly: renew once a third of the certificate's lifetime remains (`RenewalPolicy`) and drop acknowledged
  history past `QueueRetentionDays`. Exit codes for the service manager: 2 not configured/enrolled, 3 revoked.
- CI: the `verify` job sets up .NET from `apps/hotel-agent/global.json`, runs `dotnet test` in Release, and the
  simulator's e2e finds the build through `TEST_DOTNET_AGENT` (without it the suite is skipped locally; on CI it
  fails instead — until 10.5 Turborepo's strict environment filtered the variable out and CI skipped the .NET suites
  silently, found while collecting the Phase 10 evidence; `turbo.json` now passes it and `CI` through, and CI builds
  the whole solution first — `dotnet test` alone never built the host or the conformance driver).

**Reality notes for 10.2 (delivered).**
- Platform: `OPERA5_FIAS` connector (`connectors/opera5`) with message type `FIAS_RECORD`, commands
  `RESYNC_IN_HOUSE` and `SET_ROOM_STATUS`; it shares the FIAS parser with `SIM_PMS` (`connectors/fias.ts`). A `GI`
  carrying the sync flag `SF` (OPERA's database sync) is a reconciliation snapshot entry, never a check-in — a stay
  the platform missed becomes a reconciliation exception for a person, as for the simulator's `DR`.
- `SET_ROOM_STATUS` gained an optional `occupied`: FIAS maid statuses carry occupancy (RS 1–6), so housekeeping sends
  the PMS occupancy its projection last saw, and the agent refuses the write without it rather than guess.
  `ROOM_STATUS_WRITE` stays out of the agent's reported capabilities until the pilot verifies it (the sample
  `agent.example.json` leaves it out).
- Agent: `Hotella.Agent.Fias` — STX/ETX framing (8 KB limit, noise outside frames ignored), configurable character
  set, Client or Server mode (IFC8 can be set up either way; the hotel's interface sheet decides), the handshake
  LS → LD + LR (GI, GO, GC, RE, DS, DE with their fields) + LA, LA when idle and reconnect after three silent
  intervals, LE ends the session. Business records are forwarded verbatim; the message id is SHA-256 of instance and
  record, so IFC8 repeating a record is a no-op. The host runs the adapter when `ConnectorCode` is `OPERA5_FIAS`
  (settings section `Fias`); `status` shows the IFC8 address.
- Simulator: `Ifc8Face` (byte-level IFC8 over TCP: LS on connect, LR-driven record selection, buffering while the
  interface is down, DR → DS/GI…SF/DE, RE applied to the simulated PMS) and `SimulatedPms.databaseSync()`.
- e2e `opera5-fias.e2e-spec.ts`: handshake; a stay through an IFC8 drop and a platform link drop, exactly once and in
  order; reconciliation through a signed `RESYNC_IN_HOUSE` (DR → DS/GI SF/DE → snapshot → MATCH); a room status written
  as RE with occupancy, refused without it. It found a simulator defect (records written to a socket being dropped).
- To verify at the pilot (owner prerequisites): the IFC8 licence and interface sheet (connect direction, port,
  character set, the exact LR field lists and link-alive timing of the hotel's IFC8 version); the agent's settings
  cover each of these without a code change.

**Reality notes for 10.3 (delivered).**
- Platform: `OPERA5_OWS` (`RESERVATION_READ`, `GUEST_READ`, `PROFILE_EVENT`; messages `OWS_RESERVATION`,
  `OWS_PROFILE`; no commands — nothing is written to OPERA through OWS) sharing the OWS parser with `SIM_PMS`
  (`connectors/ows.ts`). No platform change was needed beyond registering it: the agent forwards the JSON shape the
  parser already reads.
- Agent: `Hotella.Agent.Ows` polls `Reservation.FutureBookingSummary` (OWS 5.1 shapes, OGHeader credentials) for
  arrivals from yesterday to `WindowDays` ahead every `PollSeconds`; elements are read by local name so namespace
  prefixes and OWS versions do not matter. A local SQLite snapshot (`ows.db`) of fingerprints makes it forward only
  differences: NEW, CHANGE, CANCEL/NOSHOW once (a cancellation of a booking never seen live is not sent); checked-out
  reservations are FIAS's business. Message ids derive from instance, reservation, action and fingerprint.
- Profiles travel inside the reservation (primary guest and sharers by `resGuestRPH`); a separate `OWS_PROFILE` poll
  is not needed for v1.
- Credentials: `hotella-agent secret set ows.password` reads the password from stdin into the protected store
  (`SecretStore`: DPAPI / 0600, beside the identity); `status` lists secret names, never values, and flags a missing
  one. A SOAP fault is reported by its reason only.
- One agent service serves one integration instance; a hotel with FIAS and OWS runs two services (two enrolments,
  two data directories). The installer (10.4) offers both.
- Simulator: `OwsSoapFace` answers `FutureBookingSummary` for the requested arrival window from the simulated PMS,
  refuses wrong credentials with a SOAP fault. e2e `opera5-ows.e2e-spec.ts`: two future reservations (ETA, sharers,
  a booking outside the window ignored) become EXPECTED stays; repeated polls forward nothing; a change and a
  cancellation arrive once each; the password is set from stdin and never shown.
- `OPERA5_DBVIEW` is deferred: it is optional, needs Oracle's driver and a read-only account whose contractual
  possibility is an open owner prerequisite; reconciliation already works through FIAS database sync (10.2).
- To verify at the pilot: the hotel's OWS licence and WSDL version, the OGHeader origin/destination entity codes and
  domain, and whether `ExpectedArrivalTime`/`MarketSegment` are populated in that version.

**Reality notes for 10.4 (delivered).**
- Licence: every `welcome` carries a licence (optional field, protocol 1 unchanged) — instance, tenant, property,
  connector, the enabled capabilities, 30 days, 14 days offline grace — Ed25519-signed with the command key over its
  canonical JSON; `typ: hotella.licence.v1` keeps it from passing as a command. The agent keeps it only when it
  verifies for its instance (`LicenceStore`, re-verified on load; an older one never replaces a newer one). Past the
  grace the link refuses commands (`CommandGate`; not recorded as executed, so they can run later) while PMS records
  keep being buffered. Both agents verify it (`link.e2e-spec.ts`, `dotnet-agent.e2e-spec.ts`: 45 days offline → a
  signed command is refused; a fresh licence lifts it). Phase 11 issues it from entitlements instead of the instance.
- Health: `AgentHealth` classifies HEALTHY / DEGRADED / UNHEALTHY by rules with reasons (platform link down, then
  unhealthy after 15 minutes; PMS side down; licence in grace / expired / missing; backlog ≥ 1000; certificate within
  7 days / expired); `health.json` every minute; `hotella-agent status` shows licence and health.
- Updates (`Hotella.Agent.Updater`): a manifest (`typ: hotella.agent-update.v1`, version, package URL, SHA-256, size,
  channel) signed with Planova's update key, pinned at install (`Updates:PublicKeyFile`); the package is size- and
  hash-checked, unpacked beside the running version under `versions/<v>/`, and `current` is switched atomically
  (rename(2) on Linux). Exit code 10 asks the service manager to restart into it; the new version is on probation
  (10 minutes or 3 starts): it confirms itself once its links are up, otherwise `current` goes back and the release
  is blocked (exit 11). Operators: `hotella-agent update status|check|apply|rollback`. Automatic when `Updates:Auto`
  (default) every `CheckHours`. The release step signs with `packaging/sign-manifest.mjs` (key from the release
  pipeline's secret store). Limitation: a candidate that crashes before reading its update state cannot roll itself
  back — the 3-start rule covers crashes after startup; a separate launcher is the follow-up if the pilot needs it.
- Packaging: `packaging/publish.sh` (self-contained single file, linux-x64 and win-x64, zip + SHA-256);
  `packaging/linux/install.sh` + hardened systemd unit (`StateDirectory` 0700, `ProtectSystem=strict`, restart on any
  exit); `packaging/windows/install.ps1` (Windows service, restart-on-failure actions, ACL on the data directory).
  CI publishes both and runs `packaging/smoke-update.sh`: a signed 0.10.1 → 0.10.2 update through check, apply,
  probation and rollback with the real binaries, and a manifest signed by another key refused.
- **Owner decision (taken 2026-10-04):** the MSI is built with **WiX v5** (no maintenance fee); WiX v6's fee is not
  taken on now (ADR-0020, Sprint 10.10). `install.ps1` stays for development, diagnostics and emergencies.

**10.10 — Windows MSI with WiX v5 (ADR-0020).**
- *Enrollment tells the agent what it is:* the enroll response gains `connector_code` and `capabilities` (the
  instance's enabled ones; optional fields, older agents ignore them), so an installer needs only the platform address
  and a token. *Several agents on one host:* `--instance <name>` selects `%ProgramData%\Hotella\Agent\instances\<name>`
  (settings, identity, queue) and the service `HotellaAgent-<name>`; without it the single-instance layout of 10.4
  stays.
- *Agent:* `hotella-agent setup install [--instance] [--platform-url] [--token-file]` makes the
  layout (`current` → this version, data directory with the SYSTEM/Administrators ACL, default `agent.json` with the
  given values), registers the Windows service with recovery actions, enrolls from the token file when given (then
  deletes it) and starts the service; `setup remove [--remove-data]` stops and deletes the service, removes the
  version directories the self-updater added and the data only when asked. `install.ps1` calls the same subcommand.
- *MSI (`packaging/windows/msi`, `WixToolset.Sdk` 5.x):* per-machine, x64, `MajorUpgrade` on one `UpgradeCode`, files
  under `versions\<version>`, a dialog for the platform address and up to three enrollment tokens (one per
  connector instance; hidden properties, written to the protected data directory, never logged); silent-install
  properties `PLATFORM_URL`, `ENROLLMENT_TOKEN_FILE` (a file with one token per line), `REMOVE_DATA`; deferred custom
  actions run `setup install` / `setup remove`.
- *CI:* a `windows-latest` job publishes `win-x64`, builds the MSI with WiX v5 and keeps it as an artefact; Linux tests
  cover the setup subcommand's layout logic.
- *Open (owner):* an Authenticode certificate to sign the MSI and the executable.
- *As built:* the installer asks for **enrollment codes**, not an address and a token: `hotella1.` + base64url JSON
  `{g: gateway URL, t: token, c: SHA-256 of the agent CA}` (`encodeEnrollmentCode` in `contracts-connectors`;
  `AGENT_GATEWAY_PUBLIC_URL` must be set, otherwise the control plane falls back to the bare token). The agent fetches
  `GET /agent/v1/ca` and trusts it only when its fingerprint matches the code, then enrolls; the enroll response
  names the connector and its capabilities, which `setup install` writes into the instance's `agent.json`. Instances
  are named after the connector (`OPERA5_FIAS` → `opera5-fias`); `--data-root` moves the data root (development,
  tests). `setup install` without codes on a host that has instances only refreshes their services (an upgrade);
  with none it keeps the single-instance layout of 10.4. The MSI's one piece of custom code is a .NET Framework
  custom action (`HotellaSetupActions`) that writes the codes into the ACL-protected data directory under a hidden
  action — the codes never reach a command line or the MSI log; everything else is `WixQuietExec` of
  `hotella-agent setup install | stop | remove`. Repair asks for codes again (adding a connector later). The control
  plane's Integrations tab issues the code (shown once). Tests: setup unit tests (.NET), the cross-language
  `setup install` from a platform-issued code to a connected instance (`dotnet-agent.e2e-spec.ts`), Playwright
  en/ar, and the `agent-msi` CI job on `windows-latest` (build, install, uninstall, `REMOVE_DATA`, and the code absent
  from the verbose MSI log and from disk).

#### 10.D Unified OPERA Integration Layer (ADR-0019; owner decisions of 2026-10-04)
The owner confirmed on 2026-10-04: direct **read-only** OPERA database access is an officially supported method (a
dedicated Oracle account with `SELECT` only; never any write); every write to OPERA goes through IFC8/FIAS or OWS; the
FIAS integration follows a **Planova Standard OPERA IFC8/FIAS Profile** independent of any one hotel, against which each
hotel's Interface Sheet is compared; OWS is an optional enhanced capability built once as a standard connector; modules
reach OPERA only through a **Unified OPERA Adapter** routed by a **per-property capability registry**. The standards
live in `docs/integrations/opera/OPERA_INTEGRATION_GUIDE.md` (profile §7.3, OWS §8, DB data contract §6.3, adapter §4,
registry §5, commissioning §16, pilot checklist §20). Sprints 10.6–10.9 run **after Phase 11 and before the M4 pilot**;
Phase 11 does not wait for pilot-specific IFC8/OWS details.

**Connectors (one agent service per instance, ADR-0017).**
| Connector | Purpose | Writes |
|---|---|---|
| `OPERA5_DB` (A) | reads, lookups, arrivals/in-house lists, profiles, room inventory, reconciliation snapshots, fallback change polling | never |
| `OPERA5_FIAS` (B) | real-time GI/GO/GC events, database swap, room status | `RE` room status (verified per hotel) |
| `OPERA5_OWS` (C, optional) | structured reads (`FetchBooking`, `FutureBookingSummary`, `FetchProfile`) | profile contact, reservation notes/ETA, room status/restrictions where the hotel's OWS supports them |

**10.6 — Capability registry and `PMS_API`.**
- *Domain model (integration context, schema `integration`):* `property_capabilities` (tenant_id, property_id,
  capability, connector_code, instance_id, enabled, verified_at, verified_by, verification_ref, version) and
  `capability_status` (derived from health; AVAILABLE / DEGRADED / UNAVAILABLE, last change). Effective capability =
  manifest supported ∧ enabled ∧ agent reported ∧ verified ∧ licence ∧ not UNAVAILABLE — pure function, unit-tested.
  Operation routing table per operation (guide §4.2) with per-property reordering limited to allowed connectors; the
  database is never a write target (a validation error, not a convention).
- *Migrations:* the two tables above (data class INTERNAL), `routing_overrides` (property, operation, ordered
  connector list), history rows for verification changes (rule 10).
- *APIs:* `GET /properties/:id/integration/capabilities` (effective view with reasons), `PUT …/capabilities/:code`
  (enable/disable, permission `integration.capability.manage`), `POST …/capabilities/:code/verify` (commissioning,
  `integration.capability.verify`, audited with evidence reference). Public service `PmsApi` (`can`, `explain`,
  operations of guide §4.2) exported from `integrations/src/public`; housekeeping's room-status command and
  engineering's room restriction move onto it; AI tools check `can` before being offered.
- *Events:* `integration.capability.changed.v1` (property, capability, effective, reason).
- *Tests:* unit (effective rule, routing incl. "never DB write", fallbacks for reads only), integration (registry with
  real Postgres, tenant-leak test), e2e: hotels A/B/C of guide §5.4 run the same scenario with different connector sets
  and the same core.

**Reality notes for 10.6 (delivered).**
- Business capabilities added to the connector contract: `RESERVATION_LOOKUP`, `ARRIVALS_READ`, `IN_HOUSE_SNAPSHOT`,
  `PROFILE_LOOKUP`, `ROOM_INVENTORY_READ`, `PROFILE_WRITE`, `RESERVATION_WRITE`; `WRITE_CAPABILITIES` classifies
  writes. Connector manifests gain `readOnly`: a read-only connector that declares a write capability or any command
  fails at definition time, and `route()` also refuses a read-only connector as a write target (two independent
  guards for "the database is never written").
- Registry (migration 0041, RLS): `property_capabilities` holds only the commissioning facts (verified at/by, evidence
  reference) per instance and capability, never deleted; `property_capability_history` is append-only (VERIFIED,
  UNVERIFIED, ENABLED, DISABLED, COMMISSIONED, ROUTING_CHANGED); `property_capability_states` is the last announced
  effective state; `routing_overrides` the property's order per operation; `integration_instances.commissioned_at/by`
  the sign-off; `integration_commands.routing` the routing decision of each command.
- Deviation from the plan, one source of truth each: *enabled* stays the instance's capability list (changed with the
  existing `PATCH /properties/:id/integrations/:instanceId`, now recorded as ENABLED/DISABLED history), *supported*
  is the manifest, *reported* the agent's hello, *licence* `ENTITLEMENT_API.can(connector entitlement)`, *status* the
  instance health. No separate enable route and no `capability_status` table: the effective rule is computed on
  demand (`CapabilityRegistry.facts` → pure `ineffectiveReasons`/`route`).
- Health → status: HEALTHY = AVAILABLE; DEGRADED and OFFLINE = DEGRADED (commands are durable and wait for the agent;
  reads try AVAILABLE connectors first); MISCONFIGURED and AUTH_FAILED = UNAVAILABLE.
- Verification: writes always need it; reads and events run unverified while the instance is in commissioning, and
  every capability needs it after `POST /properties/:id/integration/instances/:instanceId/commission` (sign-off is
  final). Inbound PMS events are still accepted by the instance's enabled ∧ reported capabilities: the PMS is the
  source of truth (rule 19) and the registry governs what the platform *asks* of the PMS.
- APIs: `GET /properties/:id/integration/capabilities` (each capability with every connector's verdict and reasons,
  each operation's route and skipped connectors), `GET …/capabilities/history`, `POST …/capabilities/:code/verify`
  (evidence) and `…/unverify` (reason) with `integration.capability.verify`, `POST …/instances/:instanceId/commission`
  (`integration.capability.verify`), `PUT …/routing/:operation` (`integration.capability.manage`; empty list = the
  standard order; duplicates, connectors outside the standard list and read-only write targets are refused). Both
  permissions are Planova installer work (platform administrators), not hotel staff.
- `PMS_API` (integrations `public`): `can`, `setRoomStatus`, `setRoomRestriction` → one durable command on the first
  effective connector (never two connectors, never a silent fallback for writes), or `UNAVAILABLE`. Housekeeping's
  room status and engineering's room restriction moved onto it (they used to send to every instance with the
  capability). `INTEGRATIONS_API.hasCapability` — the action gate's connector stage — now answers from the registry.
  Read operations (lookups, arrivals, snapshots) need link protocol 2 and arrive in 10.7; no AI tool offers a PMS
  action yet, so the "AI tools ask `can`" rule has no caller today.
- Events: `integration.capability.changed.v1` once per change of a property capability (verification, enablement,
  agent report, health state, licence — the worker re-evaluates a tenant's properties on
  `license.entitlements.changed.v1`).
- Tests: `domain/capabilities.spec.ts` (effective rule, commissioning, statuses, routing, overrides, hotels A/B/C of
  guide §5.4, never a DB write); `capabilities.integration.spec.ts` (hotels A/B/C run the same write through their own
  connector, one command with its routing, events once, licence and health, sign-off, history, routing overrides,
  tenant isolation); housekeeping and engineering tests verify the write capability before expecting the command.

**10.7 — Link protocol 2 and `OPERA5_DB`.**
- *Contracts:* `query` (signed like commands: query_type, params, deadline) and `query_result` (rows, page token,
  truncated) frames in `contracts/connectors/link.ts`; protocol negotiated in `hello`; protocol-1 agents unaffected.
- *Agent:* `Hotella.Agent.OperaDb` with `Oracle.ManagedDataAccess.Core` (managed, no native install); statements of
  data contract v1 compiled in, bind variables only, `SET TRANSACTION READ ONLY`, row caps, 30 s timeouts, pool ≤ 2;
  privilege self-check at start and daily (any privilege beyond `CREATE SESSION` + contract `SELECT`s ⇒ UNHEALTHY and
  refuse); `hotella-agent opera-db probe` (objects, columns, privileges, sample counts — no personal data printed);
  password via `hotella-agent secret set opera.db.password`; fallback change polling as `OPERA_DB_RESERVATION`.
- *Platform:* `OPERA5_DB` manifest (read capabilities only, no commands), canonical row parser, query routing.
- *Tests:* statement allow-list and privilege self-check unit tests (fixture privilege sets including a writable
  account ⇒ refused); simulator gains a DB face (an Oracle-shaped fixture behind the agent's data-source interface — CI
  does not run Oracle); cross-language e2e for queries (lookup, arrivals, in-house snapshot, reconciliation via DB).
- *Acceptance:* the agent cannot be made to write: no write statement exists, the session is read-only and a writable
  account is refused.

**Reality notes for 10.7 (delivered).**
- Contracts: `LINK_PROTOCOL_VERSION = 2`; `hello` carries `protocol: 1 | 2` (stored as `agent_links.agent_protocol`)
  and queries go only to protocol-2 agents. `query` is signed like a command (query_id, instance_id, query_type,
  params, issued_at, deadline); `query_result` carries status OK/FAILED, rows, `truncated` and an error. Deviation: no
  page token — one answer holds at most `MAX_QUERY_ROWS` (2 000) rows and says `truncated`; the standard reads of a
  property stay well below that. Manifests declare `queries` (query type → capability, params and row schema;
  `pms-rows.ts`: reservation, profile and room rows; `pmsQueryParams`), validated at definition time.
- Platform (migration 0042, RLS): `integration.integration_queries` (PENDING → SENT → ANSWERED/FAILED/EXPIRED; params
  INTERNAL, result SENSITIVE). The result is kept only until the asker takes it, then cleared; the worker job
  `integration.queries.sweep` (every 60 s) expires overdue queries and clears results older than 2 minutes. The agent
  gateway sends pending queries every 500 ms; `LinkService.queryResult` validates every row against the manifest's row
  schema (errors name paths, never values). `AgentQueryService.run` (outside a transaction; deadline 15 s by default,
  60 s max) answers OK / UNREACHABLE / TIMEOUT / FAILED.
- `PMS_API` reads: `lookupReservation`, `listArrivals`, `inHouseSnapshot`, `lookupProfile`, `roomInventory`, each
  routed through the 10.6 registry (`PMS_OPERATIONS[op].query`); a read falls through to the next effective connector
  when one is unreachable or fails. Reconciliation (Sprint 2.4) uses the `IN_HOUSE` query when a protocol-2 agent of a
  connector with `IN_HOUSE_SNAPSHOT` is reachable, otherwise the `RESYNC_IN_HOUSE` command (the FIAS database swap) as
  before. `GET /properties/:id/integration/queries` lists recent queries (type, status, timings; never rows) for the
  installer.
- `OPERA5_DB` (`connectors/opera5`): `readOnly`, entitlement `CONNECTOR_OPERA5`, read capabilities only, no commands,
  queries `LOOKUP_RESERVATION`, `LIST_ARRIVALS`, `IN_HOUSE`, `LOOKUP_PROFILE`, `ROOM_INVENTORY`; fallback change
  polling arrives as `OPERA_DB_RESERVATION` in the OWS reservation shape and reuses the OWS parser. `SIM_PMS` gained the
  same queries.
- Agent: `Hotella.Agent.OperaDb` (`Oracle.ManagedDataAccess.Core` 23.26.301, ADR-0016 row): the statements of data
  contract v1 are compiled in (private constructor, bind variables only; the schema owner is the only identifier and
  must be an upper-case Oracle identifier); every read runs in `SET TRANSACTION READ ONLY` and is rolled back; command
  timeout ≤ 30 s, connection pool ≤ 2, at most two queries at a time. `PrivilegeCheck` (at start and daily): only
  `CREATE SESSION` and `SELECT`/`READ` on the contract objects of the owner; any other system privilege, any role, any
  write privilege or grant outside the contract refuses every read and reports the adapter unhealthy until the DBA
  fixes it. `hotella-agent opera-db probe` reports objects, columns, privileges and per-table counts (no personal
  data); the password is `hotella-agent secret set opera.db.password`. The link client answers queries on a background
  task behind the licence gate; failure messages carry only the error type.
- Tests: `OperaDbTests.cs` (statement allow-list has no write verb, privilege sets including a writable account and a
  DBA role ⇒ refused, row mapping, fixture source, polling fingerprints); `pms-simulator` `queries.e2e-spec.ts` (each
  query type validated against the manifest, a request log that never keeps answers once taken, invalid parameters
  refused before the agent is asked, reconciliation by query, honest UNAVAILABLE/FAILED when the agent is gone;
  `link.e2e-spec.ts` keeps a protocol-1 agent working) and the cross-language
  `opera5-db.e2e-spec.ts` (the .NET agent answers lookups, arrivals and the in-house snapshot from an Oracle-shaped
  fixture generated from the simulated hotel by `databaseFixture`, refuses a writable account, and forwards polled
  changes). CI does not run Oracle: the real database is verified with `opera-db probe` during commissioning (10.9).

**10.8 — Standard FIAS profile v1 and OWS standard connector v1.**
- FIAS: align the agent's `LR` request list and the parser with Planova Standard Profile v1 (guide §7.3): GI/GO/GC with
  the profile's mandatory and optional fields, RE both directions, DR/DS/DE, link records; optional records requested
  only when configured; fields not delivered by a hotel are reported as profile gaps in health, never guessed.
- OWS: services and operations of guide §8 (Reservation `FetchBooking`/`FutureBookingSummary`, Name `FetchProfile`,
  and the write operations the hotel's OWS supports), configured per hotel (endpoint, WSDL version, OGHeader entities,
  domain, enabled operations); writes are commands with idempotency and audit, offered only when verified.
- Tests: simulator FIAS and OWS faces extended to the profile; e2e per profile record and per OWS operation.

**Reality notes for 10.8 (delivered).**
- Profile as contract: `FIAS_STANDARD_PROFILE_V1` (`contracts-connectors/profiles.ts`) holds per record the requested
  fields, the mandatory ones and whether it is optional (`NS`/`NE`); manifests may carry a `profile`, adapters an
  `observe()` that reports the record id and field ids of a message. The agent's `FiasProfile` is checked against the
  shared vector `test-vectors/fias-profile-v1.json` by both test suites, so the `LR` list cannot drift from the
  platform's definition. GI mandatory fields: `RN`, `G#`, `GN`, `GD`; GO/GC: `G#`; RE: `RN`, `RS`.
- Profile gaps (migration 0043, RLS): `integration.profile_observations` counts per instance and record the messages
  received, how often each field id arrived and how many lacked a mandatory field — field ids and counts only, counted
  once per message before parsing, so refused records count too. `GET /properties/:id/integration/instances/:id/profile`
  (`integration.read`) answers the coverage (seen, gaps, refused, extra fields; a record never received is all gaps);
  `POST …/profile/reset` (`integration.capability.verify`, audited, reason) starts it again after the hotel's IFC8 was
  reconfigured. Deviation from the plan: gaps are a commissioning view on the platform, not part of the agent's
  health — a missing optional field is not an outage.
- Parser: `NS`/`NE` accepted and change nothing (the business date is the property's local date); unknown record ids
  stay parse errors (an exception, never a guess).
- Agent FIAS: `LR` from the profile plus `Fias:OptionalRecords` (only `NS`/`NE` accepted); nothing is sent to IFC8
  between `DS` and `DE` — a command waits up to `Fias:SwapWaitSeconds` (120) and then fails for the platform to retry;
  after an outage longer than `Fias:ResyncAfterOutageSeconds` (300; 0 = off) the agent sends `DR` once the link is back.
  The simulator's IFC8 face now sends only the requested fields (`FL`) and can withhold fields to play a hotel's gaps.
- OWS standard connector v1 (`OPERA5_OWS`): capabilities add `RESERVATION_LOOKUP`, `ARRIVALS_READ`, `PROFILE_LOOKUP`,
  `PROFILE_WRITE`; queries `LOOKUP_RESERVATION` (`FetchBooking` by confirmation or `RESV_NAME_ID`), `LIST_ARRIVALS`
  (`FutureBookingSummary`; cancellations left out), `LOOKUP_PROFILE` (`Name.FetchProfile`); rows mapped by the agent
  (`OwsRows`): waitlist/prospect/request states are outside the read contract (like the DB statements), any other
  unknown status fails the read. One command, `UPDATE_PROFILE_CONTACT` (`Name.InsertEmail` / `InsertPhone`, primary):
  the agent reads the profile first and inserts only what OPERA lacks, so a repeat after a timeout changes nothing;
  existing contacts are never replaced. All OWS calls share one OGHeader builder.
- Deviation: `RESERVATION_WRITE` (note/ETA) is **not** offered. It would need `ModifyBooking`, which can replace
  reservation data, and its OWS 5.1 semantics are not verified from the licensed documentation (guide §21); a write
  that could damage a reservation is never guessed. `SET_ROOM_STATUS`/`SET_ROOM_RESTRICTION` through OWS likewise wait
  for verification at a hotel that exposes them.
- `PMS_API.updateProfileContact({ subject: { entityType, id }, email?, phone? })`: the OPERA profile id is resolved
  inside the integration context from the `PROFILE` references of the property's connectors (the routed connector's
  own first: all connectors of one property read the same OPERA); a subject the PMS never reported is `NOT_LINKED`
  (new outcome). Writes still need verification (10.6). No module calls it yet; the guest-contact flow that will is a
  product decision for the guest app.
- Tests: `profiles.spec.ts` (vector, optional records, coverage, definition rule); `domain.spec.ts` (NS/NE, observe,
  OWS v1 manifest and payload); `capabilities.integration.spec.ts` (profile coverage 404 across tenants and
  properties); .NET `FiasTests` (vector, swap guard, auto-resync, optional records) and `OwsTests` (row mapping, reads,
  read-before-write); e2e `opera5-fias.e2e-spec.ts` (coverage with a withheld field) and `opera5-ows.e2e-spec.ts` (reads
  through `PMS_API`; contact write unavailable until verified, applied once, `NOT_LINKED`).
- Also fixed: the operations test that moves the clock forward expired other suites' approvals in the shared test
  database (`expireDue` takes an optional tenant; the worker still sweeps every tenant) — the intermittent M2 failure.

**10.9 — Commissioning tooling and acceptance.**
- Interface Sheet comparison (guide §16.2) recorded as a commissioning record per property (requirement, hotel value,
  status MATCH/GAP/CHANGE_REQUIRED/NOT_APPLICABLE, note); OWS and DB verification runs; capability sign-off writes the
  `verified` facts of 10.6. Staff never see this; it is a control-plane/installer screen.
- Acceptance: the pilot readiness checklist (guide §20) is executable against the simulator end to end for the three
  hotel shapes; at the pilot only the hotel's values change.
- *Domain model (schema `integration`, data class INTERNAL — interface settings, counts and reasons, never guest
  data):* `commissioning_sheet_rows` (tenant, property, requirement code, hotel value, status, note, recorded by, at) —
  append-only, the latest row per requirement is current (rule 10); `commissioning_runs` (tenant, property, instance,
  connector, status PASSED/FAILED, checks `[{code, outcome PASS/FAIL/SKIPPED, detail}]`, started/finished, requested
  by). The requirement catalog is code (`domain/commissioning.ts`): FIAS (interface/version, connection, guest records,
  `RE` to and from the interface, database swap, character set, IfcAuthKey, interface number), OWS (licence/version,
  endpoint/TLS, entities, user rights), DB (read-only account, network), and site items (versions recorded, agent host,
  on-site tests, rollback agreed); each with its connector (or the site), whether it is required and the capabilities
  it affects. Labels are locale keys (rule 7).
- *Verification runs (deterministic, rule 11):* for one instance, the checks of its connector run through the agent
  over link protocol 2 directly against that instance (not routed): the agent is linked with protocol 2; DB — room
  inventory, arrivals of tomorrow, in-house list answer; OWS — arrivals of tomorrow answer, and a lookup of a sample
  confirmation number / profile when given; FIAS — the link is up and the profile coverage shows the mandatory records
  with no refused record. Rows are counted and dropped; only counts and reasons are stored.
- *Readiness (pure function, unit-tested):* the guide §20 checklist computed from the facts — versions recorded, IFC8
  interface, sheet compared (every required row of a present connector MATCH or NOT_APPLICABLE), OWS known, DB account
  and a passed DB run, agent host, agents linked/licensed/healthy, mappings confirmed (no open integration exception),
  capabilities signed off (every instance commissioned, every effective-candidate capability verified), on-site tests
  and a reconciliation with only MATCH, rollback agreed — each DONE / OPEN (with reason codes) / NOT_APPLICABLE;
  `ready` when nothing is OPEN.
- *APIs (installer/control plane; permissions of 10.6, no new ones):* `GET /properties/:id/integration/commissioning`
  (`integration.read`: sheet with current rows, instances with last run and coverage summary, checklist, ready);
  `PUT …/commissioning/sheet/:requirement` (`integration.capability.verify`, audited; appends a row);
  `GET …/commissioning/sheet/history`; `POST …/commissioning/runs` (`integration.capability.verify`, audited;
  `{ instanceId, sample?: { confirmationNumber?, profileId? } }`); `GET …/commissioning/runs`.
- *UI:* the control plane gains an "Integrations" tab (platform administrators only, English and Arabic, LTR/RTL):
  property picker, the checklist, the sheet with status per requirement, instances with their last run and profile
  gaps, run and verify actions.
- *Tests:* unit (catalog, readiness for hotels A/B/C, run checks); integration (sheet history, runs, readiness, 404
  across tenants); e2e (hotel B shape — DB + FIAS + OWS agents against the simulator — taken from nothing to `ready`
  through the API only); Playwright (the tab in both directions).

**Reality notes for 10.9 (delivered).**
- As designed above: `domain/commissioning.ts` (19 requirements over FIAS, OWS, DB and the site; 12 checklist items;
  pure `readiness()`), migration 0044 (`commissioning_sheet_rows` — an UPDATE is refused by trigger, the latest row per
  requirement is current — and `commissioning_runs`, both with RLS), `CommissioningService` and
  `CommissioningController` at `/properties/:id/integration/commissioning` (view, `sheet/:requirement`,
  `sheet/history`, `runs`), no new permission (`integration.read` / `integration.capability.verify`).
- Verification run checks: `AGENT_LINK` (a protocol-2 agent is linked), `HEALTH` (instance HEALTHY), then the reads the
  connector serves against that instance only — `ROOM_INVENTORY` (rows > 0), `ARRIVALS_TOMORROW` (answered, the
  property's local date), `IN_HOUSE` (answered), `SAMPLE_RESERVATION` / `SAMPLE_PROFILE` (exactly one row) when a sample
  is given — and, for a connector with a profile, `PROFILE_COVERAGE` (GI and GO received, no refused record). Rows are
  counted and dropped. A run passes when something passed and nothing failed.
- "Capabilities signed off" asks every instance to be commissioned and every capability the hotel uses on it
  (supported ∧ enabled ∧ not refused by the agent) to be verified — reads included, which matches 10.6's rule after
  sign-off. "Verification runs" is an item the guide's checklist implies ("probe passes") and is now explicit for every
  connector.
- Deviation found by the acceptance and fixed (ADR-0019 amendment): the three OPERA connectors share one id namespace
  per property. Manifests declare `family: 'OPERA5'`; `resolveReference`/`linkReference` look across the family's
  instances of the property (first holder wins); the projector locks reservations and profiles per property;
  `ReconciliationSnapshot.familyInstanceIds` lets the reconciler compare a DB snapshot with stays FIAS and OWS made.
  Before this, a reservation seen by OWS and checked in by FIAS would have become two stays.
- UI: control plane tab "Integrations" (`control-integrations.tsx`): tenant → property → checklist with reasons,
  connectors (health, last run, capabilities to verify, sign-off, profile gaps), the Interface Sheet; English and
  Arabic (ICU plurals), logical CSS.
- Tests: `commissioning.spec.ts` (hotels A/B/C ready, fresh property with reasons, sheet statuses, DB run, inactive
  instances); `capabilities.integration.spec.ts` (sheet history and the append-only trigger, a run without an agent,
  the view, the family namespace, 404 across tenants and properties); e2e `opera-commissioning.e2e-spec.ts` (hotel B:
  three .NET agents — DB fixture, IFC8 face, OWS face — one stay per reservation across OWS and FIAS, then sheet → runs
  → verification → sign-off → DB reconciliation MATCH → `ready`); Playwright `control.spec.ts` (the tab in English and
  Arabic).

### Phase 11 — Licensing & Control Plane (M4b)
`license` schema (products, modules, features, plans, plan_versions, subscriptions, entitlements (tenant-wide + property-specific), limits, usage_metrics, usage_events (idempotent), usage_aggregates). `EntitlementEngine.can(tenant, property, capability)` replaces the Phase 1 stub stage. Control-plane admin API/UI (tenant mgmt, subscriptions, entitlements, flags, connector & AI provider registries, support access, health). Offline license token issuance for the hotel agent. Developer platform v1 (Spec §75): API clients with scoped keys, signed outbound webhooks with retry/DLQ/replay (ADR-0012), OAuth clients later; no untrusted code plugins in the runtime.

**Goal / acceptance (Spec §58–§64, §75; CLAUDE.md rule 14):** a platform administrator defines a plan once (modules,
AI and connector entitlements, limits), publishes it as an immutable version and subscribes a tenant — tenant-wide or
for chosen properties; from that moment every human, guest and AI action passes the real entitlement stage of the
action gate, the staff and guest apps offer only what the property is entitled to, the hotel agent's offline licence
carries only entitled connector capabilities, usage is metered idempotently and aggregated for reporting, and hard
limits stop the action that would exceed them with a localized reason. No business code compares plan names; every
check is `EntitlementEngine.can(…)`. Billing (invoices, payment) stays out: entitlement ≠ billing (Spec §58).

#### 11.A Domain model (schema `license`; data class INTERNAL unless stated)
```text
products(id, code, status)
capabilities(id, code, product_code, kind MODULE|AI|CONNECTOR|ADDON|FEATURE, module_code, default_included, status)
                                              — the entitlement-code catalog of Spec §59 (modules and features are
                                                kinds of capability, so plan items and grants have one FK target)
metrics(id, code, unit, kind COUNTER|GAUGE, status)                          — Spec §61 usage metrics
                                              (catalog rows are code-defined, synchronised at boot and labelled by
                                               locale keys `license.capability.<code>` / `license.metric.<code>`,
                                               like permissions and system roles; codes are retired, never deleted)
plans(id, code, status ACTIVE|RETIRED)        + plan_translations
plan_versions(id, plan_id, version_no, status DRAFT|PUBLISHED|RETIRED, published_at, published_by, notes)
                                              — immutable once published (trigger, CLAUDE.md rule 9)
plan_version_items(plan_version_id, capability_code)          — modules/features the version grants
plan_version_limits(plan_version_id, metric_code, scope TENANT|PROPERTY, period NONE|DAY|MONTH,
                    limit_value, enforcement SOFT|HARD)
subscriptions(id, tenant_id, plan_version_id, scope TENANT|PROPERTIES, status TRIAL|ACTIVE|PAST_DUE|SUSPENDED|
              CANCELLED|EXPIRED, starts_at, ends_at, grace_days, external_ref, version)
subscription_properties(subscription_id, tenant_id, property_id)            — when scope = PROPERTIES
subscription_history(id, subscription_id, tenant_id, from_status, to_status, plan_version_id, actor, reason, at)
entitlement_grants(id, tenant_id, property_id null, capability_code, source MANUAL|TRIAL|PROMO, valid_from,
                   valid_until, reason, granted_by, revoked_at, revoked_by, revoke_reason)  — never deleted
limit_overrides(id, tenant_id, property_id null, metric_code, limit_value, enforcement, valid_until, reason,
                set_by, revoked_at)
usage_events(id, tenant_id, property_id null, metric_code, quantity, occurred_at, source, idempotency_key)
                                              — unique (tenant_id, idempotency_key); retention 400 days
usage_aggregates(tenant_id, property_key, metric_code, granularity DAY|MONTH, period_start, quantity, updated_at)
                                              — property_key = property id or the tenant sentinel; upserted
usage_collector_cursors(collector, tenant_id null, cursor, updated_at)
```
`external_ref` on a subscription is the billing system's reference (opaque, CONFIDENTIAL), never an id here.

#### 11.B Design decisions taken before coding
- **New bounded context `packages/domain/licensing`** (schema `license`, permission prefix `license.`) with a public
  API `ENTITLEMENT_API` (`can`, `explain`, `effective`, `limitStatus`) and `USAGE_API` (`record`). It depends on no
  other domain: tenants and properties are ids; contexts that need entitlements depend on its `public` entry.
- **Effective entitlements** for (tenant, property) are computed, never stored: the union of the plan-version items of
  every subscription that covers the property and is *in force* (TRIAL/ACTIVE, or PAST_DUE within `grace_days` after
  `ends_at`), plus unrevoked manual/trial/promo grants valid now (tenant-wide or for that property). A feature is
  entitled by its own code, or by its module's code when `default_included`. `CORE` is mandatory in every published
  plan version (publish refuses otherwise). Pure function, unit-tested; a tenant's licensing facts are cached in the
  process for 30 s and dropped at once by the process that changes them (11.2: simpler than a Valkey round trip on
  every gated action; other processes converge within the TTL; `license.entitlements.changed.v1` announces changes).
- **The action-gate stage** (`ENTITLEMENT_STAGE`, composed by `apps/api` and `apps/worker`): requests with a null
  tenant (platform-level actions) and platform administrators (onboarding a tenant is not customer use) pass, and a
  tenant can always read its own licence (`license.*` permissions); the required code is `request.entitlement` when given, otherwise the
  entitlement declared by the module manifest that owns the permission (`hk.*` → `HOUSEKEEPING`, `eng.*` →
  `ENGINEERING`, …; modules without one → `CORE`). **SYSTEM and INTEGRATION actors are not gated** — PMS truth,
  checkout revocations, SLA timers and retention keep running when a subscription lapses (integrity and security over
  commerce); USER, GUEST, AI_AGENT and SUPPORT actors are. A refusal is `403 license.not_entitled` with the capability.
  Domain test harnesses keep composing without the stage (pass-through), so module tests stay independent.
- **Codes:** the catalog seeds Spec §59 (`CORE`, `GUEST_EXPERIENCE`, `HOUSEKEEPING`, `ENGINEERING`, `INSPECTIONS`,
  `GUEST_RELATIONS`, `LOST_FOUND`, `LOGBOOK`, `AI_PRO`, `AI_INTELLIGENCE`, `VOICE_AI`; `AI_CORE`, `AI_GUEST`,
  `AI_STAFF`, `AI_HOUSEKEEPING`, `AI_ENGINEERING`, `AI_MANAGER`, `AI_VISION`, `AI_VOICE`, `AI_PREDICTIVE`;
  `CONNECTOR_PMS`, `CONNECTOR_OPERA5`, `CONNECTOR_OPERA_CLOUD`, `CONNECTOR_POS`, `CONNECTOR_BMS`, `CONNECTOR_PBX`,
  `CONNECTOR_ERP`, `CONNECTOR_WIFI`; `API_ACCESS`, `WHITE_LABEL`). A manifest test fails when a module manifest
  declares an entitlement the catalog does not know (lost & found's manifest moves to the spec's `LOST_FOUND`).
  Catalog/communications manifests declare `GUEST_EXPERIENCE`.
- **AI:** each agent version names its AI entitlement (`GUEST_CONCIERGE` → `AI_GUEST`, `ENGINEERING_COPILOT` →
  `AI_ENGINEERING`, `SHIFT_HANDOVER` → `AI_MANAGER`); the AI runtime asks `ENTITLEMENT_API.can` before running an
  agent and answers with the usual localized "not available" when not entitled; tools stay gated by their module's
  entitlement through the stage (AI_AGENT actors are gated).
- **Limits** (Spec §61): `ACTIVE_PROPERTIES`, `ACTIVE_STAFF` and monthly `AI_*_TOKENS`, `WHATSAPP_CONVERSATIONS`,
  `API_CALLS`, `STORAGE_BYTES`. The effective limit is the most generous of the in-force plan versions, replaced by an
  unrevoked override. HARD limits refuse the action that would cross them (`409 license.limit_reached`, through
  `ENTITLEMENT_API.limitStatus` in the owning service: property creation, staff invitation); SOFT limits raise one
  deduplicated alert per period. The AI monthly budget of Phase 6 stays the cost cap; token limits are commercial.
- **Usage metering:** `USAGE_API.record` (idempotency key required; a repeat is a no-op) and pull collectors with a
  cursor per source — AI model calls (tokens, vision), conversations opened per channel (WhatsApp), active staff and
  properties (daily gauge), stored object bytes (daily gauge), API calls (HTTP interceptor, flushed per minute per
  process with a window key). Aggregation upserts DAY and MONTH rows in the same transaction; reports read aggregates
  only. Usage rows carry no personal data.
- **Agent licence (Spec §62):** `link.service` issues the licence only when the tenant is entitled to the connector's
  entitlement at the property (`SIM_PMS` → `CONNECTOR_PMS`, `OPERA5_*` → `CONNECTOR_OPERA5`); capabilities stay the
  instance's enabled ones; expiry is the earlier of 30 days and the covering subscription's end plus grace. Not
  entitled ⇒ no licence: the agent keeps buffering PMS records and refuses commands after its grace (10.4 behaviour).
- **Control plane (Spec §63):** platform-administrator APIs under `/control/…` plus the existing `/tenants`, `/ai`,
  `/support-access` routes; no control-plane screen shows guest data. The UI is a platform-admin area of staff-web
  (`/[locale]/control`), hidden from hotel staff, LTR/RTL verified.
- **Developer platform v1 (Spec §75, ADR-0012):** API clients live in identity (`iam.api_clients`: tenant, property
  scope, permission scopes ⊆ the creator's, hashed secret, prefix shown once, expiry, last use, revocation; actor
  `INTEGRATION` with `apiClient` set, which *is* gated by entitlement `API_ACCESS` and the scopes); outbound webhooks
  live in integrations (`integration.webhook_endpoints`, `integration.webhook_deliveries`: event filter, secret as a
  `SecretRef`, HMAC-SHA256 over `timestamp.body`, exponential retry, dead letter, replay), fed from the outbox.

#### 11.C Sprints and progress

| Sprint | Scope | Status |
|---|---|---|
| 11.0 | This section | delivered |
| 11.1 | Licensing context: catalog (products, modules, features, metrics) seeded from Spec §59/§61, plans and immutable plan versions with items and limits, control-plane plan API, manifest ↔ catalog test | delivered (manifest ↔ catalog test moves to 11.2 with the stage) |
| 11.2 | Subscriptions (scope, status machine, history), manual grants, `EntitlementEngine` with cache and invalidation, real `ENTITLEMENT_STAGE` in api/worker, HARD/SOFT limits, AI agent entitlements, agent licence from entitlements, `GET /me/entitlements` and staff/guest apps hiding unentitled modules, CI/pilot subscribe step | delivered (SOFT-limit alerts in 11.3; guest web: the API refuses, nothing to hide yet) |
| 11.3 | Usage metering: `USAGE_API.record`, collectors with cursors, DAY/MONTH aggregates, usage report API, SOFT-limit alerts | delivered (alerts as `license.limit.reached.v1`; STORAGE_BYTES, VOICE_MINUTES and API_CALLS wait for their producers, see notes) |
| 11.4 | Control plane: tenant overview, plans/subscriptions/grants/usage screens, feature flags admin, connector registry, AI provider registry screens, attribution policy route, support-access overview, system health (no guest data); Playwright en/ar | delivered (screens: tenants and plans; flags, connectors, AI providers, support access and health stay API/Grafana, see notes) |
| 11.5 | Developer platform v1: scoped API clients, signed outbound webhooks with retry/DLQ/replay | delivered (management by API; screens follow with the tenant settings area, see notes) |
| 11.6 | Phase 11 acceptance (`docs/acceptance/phase-11.md`), deployed smoke `smoke-developer.sh` | delivered |
| 11.7 | Offline-resilient entitlements (ADR-0021): last-known-good facts with grace; signed entitlement bundle for hotel-site installations (installation identity, issue/renew, verify offline, grace, revocation, audit) | done |

**Reality notes for 11.1 (delivered).**
- New context `packages/domain/licensing` (manifest code `license`, schema `license`, migration 0038 with the whole
  Phase 11 model so later sprints add services, not tables). `LicenseCatalogService` syncs `CAPABILITIES`/`METRICS`
  at every boot under an advisory lock (API and worker boot together). Plans: create (with draft v1), drafts copied
  from the latest published version, draft edits validated against the catalog (`planProblems`, pure), publish
  (needs CORE and a name; event `license.plan_version.published.v1` with a null tenant), retire. The database freezes
  published versions and their items/limits (triggers), keeps subscription history append-only and refuses deletes
  of subscriptions, grants and overrides; tenant-owned tables have RLS.
- `PLATFORM_ADMIN` holds `license.catalog.read` and `license.plan.manage`; hotel roles hold neither.
- Found while adding the routes: Swagger keys component schemas by DTO class name, so a second `UpdateDraftDto`
  silently replaced the catalog context's schema in the OpenAPI document; the licensing DTOs carry distinct names,
  and the three older duplicates (`CreateCategoryDto`, `InboxQueryDto`, `ReferenceQueryDto`) are renamed in 11.2.

**Reality notes for 11.2 (delivered).**
- `EntitlementEngine` (`ENTITLEMENT_API`: `can`, `entitledUntil`, `effective`, `assertWithinLimit`) loads a tenant's
  subscriptions (with covered properties, plan items and limits), grants, overrides and features once and evaluates
  per property with the pure rules of `domain/entitlements.ts` (in force: TRIAL/ACTIVE within the period, PAST_DUE
  through `grace_days`; limits: most generous in-force plan, replaced by an override). Other contexts inject it
  `@Optional()`, so module test harnesses without licensing keep working exactly like the pass-through stage.
- Gate stage: the required code is the request's `entitlement` or the gate entitlement of the module that owns the
  permission — a new optional `entitlement` field of the module manifest (`hk` → HOUSEKEEPING, `eng` → ENGINEERING,
  `inspection` → INSPECTIONS, `relations` → GUEST_RELATIONS, `lostfound` → LOST_FOUND, `logbook` → LOGBOOK,
  `catalog`/`comms` → GUEST_EXPERIENCE; everything else CORE). The manifest registry validates it and answers
  `ownerOfPermission`. The worker composes only route-free modules, which register no manifests, so it now registers
  every manifest itself (`WorkerManifestsModule`) — the same set as the API, so both gate alike.
- Control plane: `/control/tenants/:tenantId/{subscriptions,grants,limit-overrides,entitlements}`; subscriptions
  only to PUBLISHED versions, status machine (`SUBSCRIPTION_TRANSITIONS`, CANCELLED/EXPIRED final), plan/terms
  changes in one recorded step, every step in `subscription_history` + audit + `license.subscription.changed.v1` +
  `license.entitlements.changed.v1`; grants and overrides revoked, never deleted. Tenant view
  `GET /tenants/:tenantId/license` (`license.tenant.read`, General Manager) and `GET /me/entitlements` (codes
  anywhere in the tenant when no property is named, for the apps' navigation).
- HARD limits where the owning context counts: properties not INACTIVE at property creation (organization), staff
  not DISABLED at user creation (identity) → `409 license.limit_reached`.
- AI: `AGENT_ENTITLEMENTS` (GUEST_CONCIERGE → AI_GUEST, ENGINEERING_COPILOT → AI_ENGINEERING, SHIFT_HANDOVER →
  AI_MANAGER); not entitled = the kill-switch path (concierge hands off, staff assistant answers DISABLED), recorded as a
  DECISION step `entitlement: NOT_ENTITLED`, no model call.
- Agent licence: connector manifests name their entitlement (`SIM_PMS` → CONNECTOR_PMS, `OPERA5_*` →
  CONNECTOR_OPERA5); the gateway composes licensing and issues the licence only while entitled, ending no later than
  the entitlement (`link.e2e-spec.ts`).
- Staff web hides sections whose module the hotel is not licensed for (`useEntitled`; a failed read hides nothing,
  the API refuses anyway); Playwright en/ar in `e2e/licence.spec.ts`.
- Pilot/CI: `infra/docker/pilot/license-pilot.sh <token> [TENANT]` publishes `PILOT_ALL` (every module) once and
  subscribes the tenant; CI runs it right after creating `PILOT`, before the smokes.
- Guard added after 11.1's finding: `apps/api/test/dto-names.spec.ts` fails on duplicate DTO class names; the three
  older duplicates are renamed (`CreateComplaintCategoryDto`, `ExternalReferenceQueryDto`, `ApprovalInboxQueryDto`),
  restoring their schemas in the OpenAPI document.

**Reality notes for 11.3 (delivered).**
- `USAGE_API.record` (licensing public): validates the metric against the catalog, inserts the event once per
  (tenant, idempotency key), upserts DAY and MONTH aggregates for the tenant and the property (counter: sum; gauge:
  maximum; UTC periods) and checks the in-force limits — all in the caller's transaction, so a measurement commits or
  rolls back with what it measures. A limit reached for the first time in its period (gauges: per day) writes a
  `limit_notices` row (migration 0039, append-only) and publishes `license.limit.reached.v1` once; nothing is
  stopped by a SOFT limit. `withinLimit` is false only for a HARD counter limit used up in its period.
- Producers push (licensing depends on no other context, so no pull collector can read them): the AI gateway meters
  `AI_INPUT_TOKENS` / `AI_OUTPUT_TOKENS` (embeddings included) and `AI_VISION` per successful model call keyed by the
  call id, and refuses new calls with `ai.gateway.unavailable` / `LICENCE_LIMIT` when a HARD token limit is used up
  (the Phase 6 budget remains the cost cap); communications meters `WHATSAPP_CONVERSATIONS` when a WhatsApp
  conversation opens. Gauges are sampled daily by the worker (`license.usage.gauges`, hourly check, once per metric
  and day through `usage_collector_cursors`) from providers the owning contexts register (`USAGE_GAUGES`):
  organization → `ACTIVE_PROPERTIES`, identity → `ACTIVE_STAFF`. `license.usage.purge` drops events older than 400
  days daily; aggregates stay.
- Not yet produced: `STORAGE_BYTES` (object storage keeps no per-tenant accounting yet), `VOICE_MINUTES` (Phase 13)
  and `API_CALLS` (counted for API clients from 11.5). Their limits can be defined; nothing is measured until then.
- Reports: `GET /control/tenants/:tenantId/usage?granularity&from&to&metric&propertyId` (`license.usage.read`,
  aggregates only, at most two years) and the current month in the tenant's own `GET /tenants/:tenantId/license`.
- Tests: `usage.integration.spec.ts` (idempotency, aggregates, rollback with the caller, notices once per period,
  HARD room, gauges once a day with maximum, reports and tenant isolation, retention), AI metering / HARD limit /
  entitlement in `staff-assistant.integration.spec.ts`, WhatsApp metering in `messaging.integration.spec.ts`.

**Reality notes for 11.4 (delivered).**
- API (licensing, platform administrators): `GET /control/subscriptions` (every tenant's subscriptions with plan,
  for the overview), `GET|PUT /control/tenants/:tenantId/attribution` and `GET|PUT /control/feature-flags` (reason
  required, audited; flags stay release control, Spec §60).
- White label (CLAUDE.md rule 15): "Powered by Planova" can be hidden only while the tenant holds `WHITE_LABEL`
  (`403 license.not_entitled` otherwise; the policy cites `license:WHITE_LABEL`), and the worker's daily
  `license.white_label.sweep` shows it again — audited `platform.attribution_policy.restore` — once the entitlement
  ends (`AttributionPolicyService.restore`, always allowed because showing is the safe default).
- Staff web `/[locale]/control` for platform administrators only (header link only for them; hotel staff get a
  plain refusal): tenants with licence status, subscriptions (subscribe to a published version, suspend, resume),
  effective entitlements and limits, extra grants (grant, revoke), this month's usage, the attribution switch; plans
  with versions, a new-plan form (en/ar names) and the draft editor (capabilities by kind, save, publish). Every
  change takes a reason. No guest or operational data is read. Playwright en/ar in `e2e/control.spec.ts`.
- Kept as API or existing tools in this sprint (no new screens): the AI provider and model registry (`/ai/providers`,
  `/ai/models`, Phase 6), connector manifests (per property, `/properties/:id/integrations/connectors`), support
  access (`/support-access`, Phase 1) and system health (`/ready`, the Grafana stack of ADR-0013).

**11.7 — Offline-resilient entitlements (owner requirement 2026-10-04; ADR-0021).**
- *Last-known-good:* `EntitlementEngine` keeps each tenant's last successfully read facts; a read failure answers from
  them for `LICENSING_STALE_GRACE_HOURS` (default 72) with one warning per tenant, then refuses; SYSTEM/INTEGRATION
  stay ungated.
- *Model (schema `license`):* `installations(id, tenant_id, name, public_key, status ACTIVE|REVOKED, last_seen_at,
  version)`, `installation_bundles(id, installation_id, tenant_id, issued_at, valid_until, grace_until, digest)` —
  issue history, never the bundle's secrets (it has none).
- *Contract (`contracts/licensing`):* `hotella.entitlements.v1` — installation, tenant, per-property capability codes,
  limits, subscription statuses, `issued_at`, `valid_until`, `grace_until`, Ed25519 signature with the platform
  licence key; canonical JSON as for agent licences.
- *Control plane:* register/revoke an installation (`license.installation.manage`, platform administrators, audited);
  `POST /licensing/installations/:id/bundle` signed by the installation's key (request signature + timestamp),
  answers a fresh bundle; renewals recorded.
- *Site mode (`LICENSING_MODE=site`):* a job renews every `LICENSING_RENEW_HOURS` (6); the engine reads facts from the
  verified cached bundle; between `valid_until` and `grace_until` everything works with an administrator warning; past
  `grace_until` people's actions get `403 license.offline_expired`; a bundle older than the newest accepted or issued
  in the future beyond 5 minutes is refused.
- *Tests:* unit (bundle verification, grace states, clock rollback refusal, last-known-good); integration (issue,
  renew, revoke, audit, tenant isolation); e2e (a site-mode app keeps working with the control plane down, warns
  after `valid_until`, refuses people past `grace_until`, never stops SYSTEM work).
- *As built:* the bundle carries the tenant's licensing facts themselves (subscriptions with their items and limits,
  grants, overrides, features — `TenantFacts`), so a site evaluates them with the same pure rules as the centre
  (`domain/bundle.ts`: `issueBundle`, `verifyBundle`, `bundleState`; token `base64url(payload).base64url(sig)`). It
  is signed with a dedicated Ed25519 key, `LICENSING_BUNDLE_SIGNING_KEY_REF` (`kv/hotella/license#bundle_signing_key`;
  ephemeral in development, required in production only to issue), rather than the agent licence key, which belongs
  to the integration context. Instead of an issue-history table, each issue is an audit row
  (`license.bundle.issue`, actor INTEGRATION = the installation) and `installations.last_issued_at`; the site keeps
  the newest accepted bundle in `license.site_bundles` and re-verifies it whenever it reads it. Routes:
  `GET|POST /control/tenants/:t/installations`, `POST …/:id/revoke`, `GET /control/license/bundle-key` (the key a
  site pins, `LICENSING_BUNDLE_PUBLIC_KEY`, SPKI DER base64), and the public `POST /license/bundle` authenticated by
  the installation's signature over `hotella.entitlements.v1.request.<id>.<at>` (±5 minutes). Site settings:
  `LICENSING_MODE=site`, `LICENSING_CONTROL_PLANE_URL` (the central API base), `LICENSING_INSTALLATION_ID`,
  `LICENSING_INSTALLATION_KEY_REF`; the worker renews at start and every `LICENSING_RENEW_HOURS`. The site's tenant
  keeps the central tenant id. Tests: `domain/bundle.spec.ts`, `offline.integration.spec.ts` (fault fallback and its
  limit, registration/issue/audit, refusals, a site app through VALID → GRACE → EXPIRED with SYSTEM still served).
  A control-plane screen for installations follows with the next control-plane work; the API is complete.

**Reality notes for 11.5 (delivered).**
- API clients (identity, `iam.api_clients`, migration `0040`): `GET|POST /tenants/:tenantId/api-clients`,
  `POST …/:clientId/revoke` (reason), permission `iam.api_client.manage` (risk HIGH; GM role), entitlement
  `API_ACCESS`. The key `hk_<12-char prefix>_<43-char secret>` is returned once; only the prefix and the SHA-256 digest
  are stored (constant-time compare). Scopes must be catalog permissions the creator holds at the client's scope
  (same delegation rule as roles) and never `iam.*`, `support.*` or `license.*`. A client may be bound to one
  property. Clients are revoked, never deleted (trigger), with a CHECK tying `REVOKED` to `revoked_at`.
- A key authenticates as an `INTEGRATION` actor with `apiClient` set: the permission resolver allows only its scopes,
  in its tenant (and property); the entitlement stage gates it (API_ACCESS **and** the module's entitlement). Reads
  do not pass the gate, so the authenticator itself refuses a valid key with `403 license.not_entitled` while the
  tenant lacks `API_ACCESS`. Every authenticated call is metered as `API_CALLS` (one usage event per request,
  idempotent on the correlation id) — simpler than the planned per-minute interceptor flush, same aggregates.
- Outbound webhooks (integrations, `integration.webhook_endpoints` / `webhook_deliveries`, RLS): `GET|POST
  /tenants/:tenantId/webhooks`, `PATCH …/:webhookId` (url, events, status ACTIVE/PAUSED, optimistic `version`),
  `POST …/:webhookId/rotate-secret`, `GET …/:webhookId/deliveries?status=`, `POST …/deliveries/:deliveryId/replay`;
  permission `integration.webhook.manage` (risk HIGH; GM role), entitlement `API_ACCESS`.
- Secrets: no per-endpoint secret is stored. The endpoint secret is `whsec_` + HMAC-SHA256(platform signing key,
  endpoint id + `secret_version`), shown at creation and rotation; the platform key is the SecretRef
  `WEBHOOK_SIGNING_KEY_REF` (pilot: `vault://kv/hotella/app#webhook_signing_key`). Without it webhooks answer
  `503 integration.webhook.unavailable` and nothing is sent (no ephemeral fallback: a secret must verify in every
  process).
- Events offered (`WEBHOOK_EVENTS`): operational facts with ids and codes only — ops work items/tasks/SLA breaches,
  hk room states/readiness/jobs, eng work orders/PM/room restrictions, inspections, complaints, lost & found. No
  canonical `hotel.*`, guest, identity, comms or AI events. The worker's `IntegrationsWorkerModule` subscribes consumer
  `integration.webhooks` to each (inbox-idempotent) and creates one delivery per matching ACTIVE endpoint (tenant,
  event, property or tenant-wide), unique per endpoint and event, only while the tenant holds `API_ACCESS`.
- Delivery: job `integration.webhooks.sweep` every 30 s claims due rows with `FOR UPDATE SKIP LOCKED` and a 2-minute
  lease (the attempt is counted at claim), then POSTs outside the transaction (10 s timeout, no redirects) with
  `X-Hotella-Event`, `X-Hotella-Delivery` and `X-Hotella-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "t.body")>`.
  2xx ⇒ DELIVERED; otherwise retry after 30 s·2^(n−1); after 8 attempts DEAD (the dead letter), replayable with a
  fresh attempt budget (`replays` counted, audited). A paused endpoint keeps its deliveries waiting.
- Targets: https only and no private, loopback, link-local or `*.internal` hosts; `WEBHOOK_ALLOW_INSECURE=true`
  (refused in production) allows http/local targets for development and tests. Resolution-time (DNS) checks belong
  to the deployment's egress proxy.
- Tests: `domain/webhooks.spec.ts` (back-off, dead letter, secret derivation, signature, target policy);
  `webhooks.integration.spec.ts` (entitlement, validation, signed delivery to a local server, idempotent fan-out,
  tenant/property isolation, retry → DEAD → replay, rotation, pause); identity `api-clients.integration.spec.ts`
  (real licensing engine: API_ACCESS refusal, scope rules, key shown once and stored hashed, scope/property/tenant
  limits, API_CALLS metering, audit as INTEGRATION, lapse and revocation).
- Not in this sprint: staff-web screens for API clients and webhooks (the tenant settings area does not exist yet;
  GMs use the API), per-client rate limits beyond the global HTTP limiter, and a public developer portal.

**APIs (all mutations through `ActionGate`, audited).**
| Route | Permission |
|---|---|
| `GET /control/license/catalog` (modules, features, metrics with translations) | `license.catalog.read` |
| `POST /control/license/plans`, `GET /control/license/plans[/:id]` | `license.plan.manage` |
| `POST /control/license/plans/:id/versions` (new draft, optionally copied), `PUT …/versions/:versionId` (draft only), `POST …/versions/:versionId/publish`, `POST …/versions/:versionId/retire` | `license.plan.manage` |
| `GET/POST /control/tenants/:tenantId/subscriptions`, `POST …/subscriptions/:id/transition` (status + reason), `POST …/subscriptions/:id/properties` | `license.subscription.manage` |
| `GET/POST /control/tenants/:tenantId/grants`, `POST …/grants/:id/revoke` | `license.grant.manage` |
| `GET/POST /control/tenants/:tenantId/limit-overrides`, `POST …/:id/revoke` | `license.grant.manage` |
| `GET /control/tenants/:tenantId/entitlements?propertyId=` (effective, with sources and limits) | `license.entitlement.read` |
| `GET /control/tenants/:tenantId/usage?metric&from&to&granularity&propertyId` | `license.usage.read` |
| `GET /me/entitlements?propertyId=` (codes only, for the apps' navigation) | authenticated staff of the property |
| `GET /tenants/:tenantId/license` (the tenant's own plan, entitlements and usage, read-only) | `license.tenant.read` |
| `GET/POST /tenants/:tenantId/api-clients`, `POST …/:clientId/revoke` (11.5, entitlement `API_ACCESS`) | `iam.api_client.manage` |
| `GET/POST /tenants/:tenantId/webhooks`, `PATCH …/:id`, `POST …/:id/rotate-secret`, `GET …/:id/deliveries`, `POST …/deliveries/:deliveryId/replay` (11.5, entitlement `API_ACCESS`) | `integration.webhook.manage` |

**Events.** `license.plan_version.published.v1`, `license.subscription.changed.v1`,
`license.entitlements.changed.v1` (tenant, property or null, reason — cache invalidation, agent licence refresh, apps),
`license.limit.reached.v1` (tenant, property, metric, enforcement, period).

**Tests.** Unit: effective-entitlement rule (scopes, statuses, grace, features by default, grants, revocations),
limit resolution, stage derivation from manifests and actor rules, plan-version immutability. Integration (real
Postgres/Valkey): catalog seed, publish trigger, subscriptions and history, idempotent usage events and aggregates,
cache invalidation, tenant-leak test (`/tenants/:other/license` 404, grants of another tenant invisible).
e2e: the CI pilot subscribes `PILOT` to the seeded plan before the smokes; a smoke proves a module refused without
entitlement and allowed after a grant; agent licence absent without `CONNECTOR_*`.

### Phase 12 — Advanced Intelligence
GM/duty-manager intelligence, cross-property analysis, insight/recommendation engine with evidence (Spec §38), evaluation sets/runs, shadow & canary agent versions, predictive models where data supports, cost optimization and quality metrics dashboards (Spec §41). Operational digital-twin read model (Spec §80): a graph-shaped projection (property → rooms → stays/guests/assets/tasks/incidents/conversations) built from existing domain events, used by Manager AI and arrival-risk; it is a projection, never a source of truth. Controlled agent collaboration (Spec §43): specialist agents callable as capabilities with structured results, no free-form agent swarms.

**Goal / acceptance (Spec §38–§43, §80–§81; CLAUDE.md rules 11–12):** the general manager and the duty manager see
what needs their attention, each item with its reason, evidence, confidence, affected entities and a suggested action,
computed by deterministic detectors over the hotel's own data (an LLM only phrases or converses, never decides); a
Manager assistant answers from domain tools and the operational twin, consults a specialist agent in a controlled,
recorded way, and compares properties only for those allowed to; no new prompt or agent version reaches guests or
staff without a passing regression evaluation, and it can run in shadow (never acting) and as a canary (a deterministic
share of traffic) before promotion, with rollback; AI quality and cost are measured per agent, version and property
from real outcomes (overrides, reassignments, edits, acceptance), not token counts alone.

#### 12.A Domain model (schema `ai`; data class INTERNAL unless stated)
```text
evaluation_sets(id, tenant_id null = platform set, agent_code, code, name, status ACTIVE|RETIRED, version)
evaluation_cases(id, set_id, code, critical bool, input jsonb (turns, channel, locale, context fixtures),
                 tool_fixtures jsonb (what each tool answers in dry run), expectations jsonb (tools called / not called
                 with argument matchers, handoff, reply must / must not contain, risk outcome), data_class)
                                              — fixtures are synthetic (no real guest data); CONFIDENTIAL at most
evaluation_runs(id, set_id, agent_version_id, mode REGRESSION|SHADOW, status RUNNING|PASSED|FAILED|ERROR,
                totals jsonb, cost_micros, requested_by, started_at, finished_at)
evaluation_results(id, run_id, case_id null (shadow: live execution id), outcome PASS|FAIL|ERROR, checks jsonb,
                   execution_id)              — checks: expectation, outcome, detail (codes, never free text)
agent_releases(id, tenant_id null, agent_code, agent_version_id, stage SHADOW|CANARY|ACTIVE|ROLLED_BACK,
               canary_percent, started_at, ended_at, actor, reason)      — append-only release history (rule 10)
insights(id, tenant_id, property_id, detector, fingerprint, severity LOW|MEDIUM|HIGH, confidence numeric(4,3),
         reason_key, reason_params jsonb, evidence jsonb [{kind, ref_type, ref_id, count, window}], affected jsonb
         [{type, id}], suggested_action jsonb {key, params, action_ref?}, status OPEN|ACKNOWLEDGED|RESOLVED|DISMISSED|
         EXPIRED, first_seen_at, last_seen_at, occurrences, expires_at, version)
                                              — one OPEN insight per (property, detector, fingerprint): re-detection
                                                updates it; evidence holds ids, counts and codes only
insight_history(id, insight_id, tenant_id, from_status, to_status, actor_type, actor_id, reason, at)
twin_nodes(id, tenant_id, property_id, kind ROOM|STAY|GUEST|ASSET|WORK_ITEM|WORK_ORDER|COMPLAINT|CONVERSATION|
           INSPECTION|LOST_ITEM, ref_id, state, updated_at)          — ids and states, never names
twin_edges(id, tenant_id, property_id, from_node, to_node, relation, valid_from, valid_to null)
                                              — relations end, never disappear (rule 10); projection, never truth
quality_daily(tenant_id, property_id, agent_code, agent_version_id, day, metric, value numeric, samples int)
                                              — upserted by a deterministic job
```

#### 12.B Design decisions taken before coding
- **Placement:** everything lives in the AI context (schema `ai`): insights are the AI evidence model of Spec §38 and
  the twin serves the Manager assistant and arrival risk. Inputs come only through other contexts' **public APIs and
  events** (never their tables); no new schema, so no ADR.
- **Deterministic first (§39, rule 11):** detectors are code with thresholds in configuration (`ai.insights.*`),
  evaluated on a schedule or on events; confidence is a formula of the evidence (sample size against threshold), not a
  model's opinion. An LLM is used only by the Manager assistant to converse over tool results; detectors never call
  the Model Gateway.
- **Detectors v1:** `RECURRING_ASSET_FAILURE` (≥ N corrective work orders on one asset or failure code in 30 days, most
  closed with the same cause — the Spec §38 example), `SLA_BREACH_CLUSTER` (a department/category breaching above its
  own 28-day baseline), `REPEAT_COMPLAINT` (the same room or category complained about repeatedly in 14 days),
  `SLOW_TURNAROUND` (a room type's clean-to-inspected median far above the property's), `ARRIVAL_RISK_TOMORROW`
  (high-risk arrivals with their reasons). Each declares its entitlement (`AI_INTELLIGENCE`), inputs, window and
  suggested action (e.g. open a preventive work order — as an approval proposal through the existing tool path, never
  executed by the detector).
- **Insight lifecycle:** OPEN → ACKNOWLEDGED → RESOLVED, or DISMISSED with a reason; expiry when the evidence ages
  out. Acting and dismissing write `ai.feedback` (`RECOMMENDATION_ACCEPTED` / `REJECTED`) — the implicit signal of
  Spec §40 — and are audited.
- **Evaluation:** cases run through the real agent loop with the agent version under test and **dry-run tools** (the
  executor answers from the case's fixtures, writes nothing, proposes nothing); graders are deterministic. Publishing an
  agent or prompt version (rule 9, already immutable) requires a PASSED regression run of the agent's active sets on
  that exact version: every `critical` case passes and the pass rate meets `ai.evaluation.min_pass_rate` (default
  0.9). Platform sets apply to every tenant; a tenant may add its own.
- **What "publish" means for code-defined agents:** built-in agent and prompt versions arrive with a deployment
  (Phase 6: published on first use, immutable). From Phase 12 a deployed version that has a predecessor arrives as a
  **candidate**: the predecessor stays the one that runs until the candidate passes its regression run and an AI
  administrator releases it (shadow → canary → active, or straight to active). An agent's first version is active at
  once — there is nothing to fall back to. `AgentCatalog.published(code)` answers the active release.
- **Shadow and canary:** a released version is SHADOW (after the active version answers, the shadow runs on the same
  input with dry-run tools; its tool calls and handoff are compared and stored as a SHADOW run; it never replies or
  acts) or CANARY (a deterministic share of conversations — hash of the conversation id against `canary_percent` —
  runs on it for real). Promotion and rollback are explicit, audited releases; a kill switch on the agent stops both.
  Shadow cost counts against the AI budget and is refused when the budget is exhausted.
- **Twin:** a projection fed by idempotent consumers of domain events (stays, room assignments, work items, work
  orders, complaints, conversations, inspections, lost items); `neighbourhood(entity, depth ≤ 3, at?)` answers the
  connected context deterministically; names are resolved at read time through the owning context's public API and
  the reader's permissions (no PII copied into the twin).
- **Manager assistant (`MANAGER_ASSIST`, ASSIST mode):** tools `intelligence.insights`, `intelligence.pulse`
  (deterministic live KPIs from domain tools: open work by department, breaches today, arrivals tomorrow with risk,
  open complaints, rooms out of order), `intelligence.twin`, `intelligence.compare` (tenant-level, needs
  `ai.intelligence.cross_property`), and `agents.consult` — **controlled collaboration (§43):** it may ask one
  specialist agent (v1: `ENGINEERING_COPILOT`) a question and gets a structured result; depth 1 (a consulted agent
  cannot consult), budget-capped, recorded as an execution step pointing at the child execution. No swarms.
- **Quality and cost (§41):** a nightly job computes per agent/version/property: task-creation accuracy (AI-created
  requests not cancelled or reassigned by a person within 24 h), human override rate, draft edit distance, guest
  re-contact within 24 h, recommendation acceptance, fallback rate, tool failure rate, cost per execution. Raw signals
  come from `ai.executions`, `ai.feedback` and domain events (reassignment, cancellation).

#### 12.C APIs, events, permissions
- APIs: `/ai/evaluation-sets` (+ cases), `POST /ai/agents/:code/versions/:id/evaluations`, `GET /ai/evaluation-runs/:id`;
  `POST /ai/agents/:code/releases` (`{ versionId, stage, canaryPercent? }`), `GET /ai/agents/:code/releases`;
  `GET /properties/:id/insights`, `POST /properties/:id/insights/:insightId/{acknowledge|resolve|dismiss}`;
  `GET /properties/:id/twin/:kind/:refId?depth=`; `GET /properties/:id/ai/quality?from&to`;
  `GET /tenants/:id/intelligence/compare` (cross-property).
- Events: `ai.insight.raised.v1`, `ai.insight.status_changed.v1`, `ai.evaluation.completed.v1`,
  `ai.agent.released.v1`.
- Permissions: `ai.evaluation.manage`, `ai.evaluation.read`, `ai.agent.release`, `ai.insight.read`, `ai.insight.act`,
  `ai.intelligence.cross_property`, `ai.quality.read`. GM gets insight read/act and quality read; duty manager insight
  read/act; cross-property is a tenant-level grant; evaluation and release are AI administrators'.
- Entitlements: `AI_INTELLIGENCE` (insights, twin, Manager assistant, quality dashboards); evaluation and releases are
  platform capabilities (no entitlement needed to keep AI safe).
- Locale namespaces: `ai.insight.*` (reasons, actions, detector names), `staff.intelligence.*`.

#### 12.D Sprints
| Sprint | Scope | Status |
|---|---|---|
| 12.1 | Evaluation sets/cases, dry-run tool executor, deterministic graders, regression runs, publish gate | done |
| 12.2 | Agent releases: shadow (compare, never act) and canary (deterministic share), promote/rollback, kill switch | done |
| 12.3 | Operational twin read model: consumers, neighbourhood queries, read-time names | done |
| 12.4 | Insight engine v1: detector registry, five detectors, lifecycle, feedback, events | done |
| 12.5 | Manager assistant, `agents.consult` (controlled collaboration), cross-property comparison | done |
| 12.6 | Quality and cost metrics job; staff-web Intelligence screens (insights, pulse, quality) in English and Arabic | done |
| 12.7 | Phase 12 acceptance (`docs/acceptance/phase-12.md`) | planned |

- *As built (12.1):* migration `0049_ai_evaluation`: `ai.evaluation_sets` (platform when `tenant_id` is null, else the
  hotel's own; RLS shows platform rows to every tenant), `evaluation_cases` (input, tool fixtures, expectations, data
  class at most CONFIDENTIAL — cases are synthetic), `evaluation_runs` (one set × one agent version, under a tenant's
  property for routing and budget), `evaluation_results` (checks as codes, the execution), `agent_releases`
  (append-only by trigger; stages SHADOW/CANARY/ACTIVE/ROLLED_BACK, 12.1 writes ACTIVE). `domain/evaluation.ts`:
  case input (locale, turns ending with the person, synthetic context parts), fixtures, expectations (tools called
  with `equals`/`contains`/`present` argument matchers and an OK/PROPOSED/REFUSED/ERROR outcome, tools not called,
  hand-off NONE/ANY/reason, reply must / must not contain), `grade()` and `runPasses()` (every critical case and
  `ai.evaluation.min_pass_rate`, default 0.9; errors count as failures), unit-tested. `agent-contracts.ts`: the
  instructions and answer schema of CONVERSATION (`{reply, handoff}`) and ASSIST (`{answer}`) agents, now used by the
  concierge, the staff assistants and the evaluator alike. `DryRunExecutor`: same allow-list, argument schema and
  policy decision as the real executor; READ and allowed actions answer from fixtures, approvals come back PROPOSED
  without a proposal, CRITICAL is refused; nothing is written, every call is a step (`dry_run: true`) of an execution
  with trigger `EVALUATION`. `AgentCatalog`: definitions are a provider (`AGENT_DEFINITIONS`); an agent's first version
  is published at once, a later deployed version is kept as a **candidate** (DRAFT) while the published one keeps
  running; the cached published version is re-read every 30 s so a release reaches every process. API (`ai`):
  `GET|POST /evaluation-sets`, `GET|PATCH /evaluation-sets/:id`, `POST /evaluation-sets/:id/cases`,
  `DELETE /evaluation-sets/:id/cases/:caseId` (retire), `GET /agents/:code/versions` (PUBLISHED / CANDIDATE /
  SUPERSEDED), `POST /agents/:code/versions/:id/evaluations` (`{propertyId, setIds?}` → one RUNNING run per set, job
  `ai.evaluation.run` on `background-ai` in the worker), `GET /evaluation-runs/:id` (totals, per-case checks),
  `POST /agents/:code/versions/:id/publish` (platform `ai.agent.release`: refused with `ai.evaluation.no_sets` or
  `ai.evaluation.not_passed {set}` unless the latest run of this exact version PASSED on every active platform set;
  supersedes the previous version, writes the ACTIVE release with the run ids, audit `ai.agent.release`),
  `GET /agents/:code/releases`. Events `ai.evaluation.completed.v1`, `ai.agent.released.v1`. Permissions
  `ai.evaluation.read`, `ai.evaluation.manage`, `ai.agent.release` (platform administrators; no tenant role gets them
  by default). Tests: grader unit tests; integration (first version active, second a candidate; no sets → refused;
  platform cases and the hotel's own set, another hotel sees neither the hotel's set nor its runs; a failing run with
  the critical case's `NOT_CALLED` blocks the release; a passing run releases v2, v1 superseded, published version
  switches; dry runs create no request and no approval and record a PROPOSED cancel; events; release rows refuse
  edits; reruns of the suite on the same database stay green).
- *As built (12.2):* migration `0050_ai_releases`: `evaluation_runs.set_id` nullable (a SHADOW run has no set),
  `evaluation_results.compared_execution_id` (the active execution a shadow result is compared with), and the rule-9
  trigger on `agent_versions` now also lets a SUPERSEDED version become PUBLISHED again **with identical content**
  (rollback; any content change is still refused). `domain/release.ts` (unit-tested): `canaryBucket` (FNV-1a of the
  conversation id mod 100; raising the share only adds conversations), `currentTrial` (the latest release row decides:
  SHADOW/CANARY start or change a trial, ACTIVE/ROLLED_BACK end it), `compareRuns` (codes `BOTH_ANSWERED`,
  `SAME_TOOLS`, `SAME_HANDOFF`; runtime tools such as the final reply are left out). `AgentCatalog.select(code,
  conversationId)` answers the version that replies (the canary version when the conversation falls in its share) and
  the shadow version to run beside it; the trial is cached 30 s like the published version and dropped on release.
  Concierge runtime: runs the agent named by the `CONCIERGE_AGENT` provider (default `GUEST_CONCIERGE`; tests run
  their own agent through the same runtime); **after** the guest was answered, a shadow version runs on exactly the
  context and history the active one saw, as its own execution with trigger `SHADOW`: READ tools the policy allows run
  for real (reading changes nothing), any other action comes back as the policy would decide (`performed: false`,
  PROPOSED for approvals) without being performed, no reply, draft or hand-off is made; the comparison is stored as a
  result of the version's open SHADOW run in that tenant (one per tenant, totals recounted). A disabled agent or guest
  AI (kill switch) or a missing entitlement runs neither; shadow model calls go through the Model Gateway, so they
  count against, and are refused by, the AI budget; a failing shadow never affects the guest. API (`ai`, platform
  `ai.agent.release`): `POST /agents/:code/releases` (`{versionId, stage SHADOW|CANARY|ACTIVE, canaryPercent 1–99
  (CANARY only), reason?}` → 201; same gate as publish; trials only for CONVERSATION agents, else
  `ai.agent.trial_not_supported`; ACTIVE promotes the candidate and closes its shadow runs PASSED/FAILED by what they
  found; `publish` is now ACTIVE through the same path), `POST /agents/:code/rollback` (`{reason}`: ends a trial in
  progress, else undoes the last ACTIVE release and runs the version it replaced again; `ai.agent.nothing_to_roll_back`
  otherwise; audit `ai.agent.rollback`, release row ROLLED_BACK, event `ai.agent.released.v1`),
  `GET /agents/:code/versions/:id/runs` (regression and shadow runs the caller's tenant may see). Tests: integration
  `release.integration.spec.ts` (a staff assistant cannot be tried; a hotel cannot release; invalid shares refused;
  SHADOW: v1 answers and creates the one request, v2 runs as a SHADOW execution whose list-services read ran for real
  and whose create came back dry, the stored result names `TOOLS_DIFFER` against the active execution; rolling back
  the trial closes the shadow run FAILED; CANARY answers by the conversation's bucket and the side stays stable;
  ACTIVE switches the reply to v2; rollback reinstates v1 with unchanged content, v2 superseded and not releasable
  again, nothing more to roll back; release history and audit rows), green on reruns.
- *As built (12.3):* migration `0051_ai_twin`: `ai.twin_nodes` (one per `(tenant, kind, ref_id)`; `state` with the
  moment it was observed, `attributes` jsonb of codes only) and `ai.twin_edges` (`from_node —relation→ to_node`,
  `valid_from`, `valid_to`; one open edge per triple; a trigger lets an edge only be ended, never edited again or
  deleted — rule 10); RLS per tenant. Kinds: `LOCATION` (a room is a location; `room` is accepted in the URL), `STAY`,
  `GUEST`, `ASSET`, `WORK_ITEM`, `WORK_ORDER`, `SERVICE_REQUEST`, `COMPLAINT`, `CONVERSATION`, `INSPECTION`,
  `LOST_ITEM`, `STAFF` (the plan's list plus `SERVICE_REQUEST` and `STAFF`, which the §80 chain needs). Relations:
  `HAS_GUEST`, `IN_ROOM` (one at a time), `AT`, `FOR_STAY`, `BY_GUEST`, `ASSIGNED_TO`, `TRACKS`, `ON_ASSET`,
  `RAISED`. `application/twin-projection.ts` (pure, unit-tested) maps 18 events — stay created / status / room
  changed, guest anonymized, work item created / status, task assigned (the previous assignee's edge ends), work order
  created / closed (failure, cause, resolution codes, downtime), service request created / status, complaint opened /
  resolved, conversation opened, inspection completed, finding raised (its urgent work), lost & found registered /
  released / disposed — to node and edge operations; the worker applies them through the inbox (consumer `ai.twin`,
  exactly once) at the event's `occurred_at`, and a late event never overwrites a newer state. `domain/twin.ts`:
  `neighbourhood(start, depth 1–3, edgesOf)` — breadth first in both directions, deterministic order, capped at 200
  nodes (`truncated`). API: `GET /properties/:id/twin/:kind/:refId?depth=1..3&at=` (permission `ai.twin.read`, given
  to the general manager and the duty manager; entitlement `AI_INTELLIGENCE`) answers the nodes (distance, state,
  codes, label) and the edges valid at `at` (default now; states are the latest known). Names are never stored: they
  are looked up at read time through `AI_TWIN_LABELS` (`ai/public`), where the AI context names locations (room number
  or location code, organization API) and staff (display name, identity API) and engineering names assets (number and
  name) for readers holding `eng.asset.read`; guests stay unnamed in v1. Tests: traversal and projection unit tests;
  integration `twin.integration.spec.ts` (the §80 chain as events: the stay's neighbourhood now and before the room
  move; reassignment shows the current engineer now and the first one earlier, by name; the closed work order's codes;
  the asset's name only for a reader with `eng.asset.read`; a redelivered event is a duplicate; a late status does not
  win; 14 edges, 2 ended, none deletable or editable once ended; no guest name in the twin; another hotel, an unknown
  thing or kind, depth 4 and a reader without the permission are refused; RLS hides the rows from another tenant).
- *As built (12.4):* migration `0052_ai_insights`: `ai.signals` (facts kept from events — `WORK_ORDER_CLOSED`,
  `SLA_BREACHED`, `COMPLAINT_OPENED`, `HK_JOB_STATUS` — with ids and codes, unique per source event), `ai.insights`
  (as in 12.A; one live — OPEN or ACKNOWLEDGED — insight per property, detector and fingerprint by a partial unique
  index; optimistic `version`), `ai.insight_history` (append-only by trigger); `ai.feedback` may now be about an
  insight (`insight_id`, `execution_id` nullable, one of them required) with kinds `RECOMMENDATION_ACCEPTED` /
  `RECOMMENDATION_REJECTED`; RLS per tenant. Signals are written by the twin's consumer right after the twin (so a
  breach carries its work item's department and a complaint the room its stay was in at that moment).
  `domain/insights.ts` (unit-tested): `RECURRING_ASSET_FAILURE` (≥ `minFailures` corrective work orders done on one
  asset in `windowDays`, naming the cause when most share it), `SLA_BREACH_CLUSTER` (breaches of a department in the
  recent window ≥ max(`minBreaches`, `factor` × its own baseline over the same length)), `REPEAT_COMPLAINT` (per room
  and per category), `SLOW_TURNAROUND` (a room type's DONE→INSPECTED median ≥ `factor` × the property's, with
  `minSamples`); `confidence = min(1, samples ÷ (2 × threshold))`; severities from the same formulas; thresholds are the
  settings `ai.insights.{recurring_failure, sla_cluster, repeat_complaint, slow_turnaround}` (platform → tenant →
  property). The fifth detector, `ARRIVAL_RISK_TOMORROW`, is **contributed** by housekeeping through
  `AI_INSIGHT_DETECTORS` (`ai/public`): tomorrow's arrivals its rules score HIGH, stays as evidence, rooms as affected,
  no names — the registry lets any context add deterministic detectors without the AI context depending on it.
  `InsightEngine.detect(property)`: entitled properties only (`AI_INTELLIGENCE`); a found insight refreshes the live
  one (evidence, severity, `last_seen_at`, `expires_at` = now + its window; `occurrences` + 1 when the evidence has new
  ids); otherwise a new OPEN insight is raised — but after a person resolved or dismissed one, only evidence it did not
  have raises it again; a live insight no longer found expires when its evidence aged out; a failing contributed
  detector changes nothing of its own insights. The worker runs `ai.insights.detect` hourly on `background-ai` for every
  property the twin knows. API (`AI_INTELLIGENCE`): `GET /properties/:id/insights?status=&limit=` (HIGH first, latest
  first), `GET …/insights/:insightId` (with history), `POST …/insights/detect` (run now), `POST …/:insightId/{acknowledge,
  resolve}` (`{version, reason?}`) and `…/dismiss` (`{version, reason}` required): optimistic, audited
  (`ai.insight.acknowledge|resolve|dismiss`), history row, `ai.insight.status_changed.v1`, and feedback (acknowledging
  or resolving accepts the recommendation once; dismissing rejects it). Events `ai.insight.raised.v1` (detector,
  severity, confidence) and `ai.insight.status_changed.v1`. Permissions `ai.insight.read`, `ai.insight.act` (general
  manager, duty manager). Locale keys `ai.insight.detector.*`, `ai.insight.reason.*`, `ai.insight.action.*` in five
  languages (no plural forms needed). Tests: detector unit tests; integration `insights.integration.spec.ts` (the §38
  AC unit with its shared cause, an engineering breach cluster, a twice-complained room — from events through the
  consumer; refresh vs. new evidence; version conflict, a reader cannot act, dismiss needs a reason, a closed insight
  cannot move; feedback once per kind; same evidence does not reopen, a new repair raises a new insight; contributed
  detector raised and expired two days later, a failing detector ignored; events; append-only history; another hotel
  sees nothing); housekeeping's detector raises nothing for a MEDIUM day and one HIGH insight with ids only.
- *As built (12.5):* migration `0053_ai_consult` adds `ai.executions.parent_execution_id` (the consulting execution).
  The twin also follows `eng.room_restriction.changed` (`restriction` code on the room). `PulseService` (deterministic,
  rule 11): open work by department, service-target breaches in the last 24 h by department, open complaints by
  severity, restricted rooms by kind, tomorrow's expected arrivals (guest API, the property's local day) and live
  insights by severity — from the AI context's own twin, signals and insights. Agent `MANAGER_ASSIST` v1 (ASSIST,
  entitlement `AI_INTELLIGENCE`, READ tools only, 8 steps) with tools `intelligence.pulse`, `intelligence.insights`
  (`ai.insight.read`), `intelligence.twin` (`ai.twin.read`, ≤ 2 hops, names only from labelers that need no extra
  permission), `intelligence.compare` (`ai.intelligence.cross_property`, and the person behind the execution must hold
  it at tenant level) and `agents.consult` (controlled collaboration, Spec §43): only the Manager assistant may call
  it, only `ENGINEERING_COPILOT`, only when the person may read assets and work orders, and never from a consulted
  execution (depth 1); the specialist runs as its own execution for the same person with `parent_execution_id`, and the
  manager's execution records a `DECISION consult` step naming the child execution. API: `POST
  /properties/:id/ai/manager` (`{question}`; `ai.manager.use` + `AI_INTELLIGENCE`) → the staff-assistant answer;
  `GET /tenants/:id/intelligence/compare` (`ai.intelligence.cross_property`, own tenant only) → each draft or active
  property with its pulse. Permissions `ai.manager.use` (general manager, duty manager) and
  `ai.intelligence.cross_property` (a tenant-level grant, in no default role). Tests: integration
  `manager.integration.spec.ts` (the pulse counts the seeded day exactly; "what needs my attention today" calls pulse,
  insights and one consult, the child execution is the copilot's, for the same person, linked to the parent, and the
  model saw the exact numbers; consult refused from another agent and from a consulted execution; the comparison
  refused as a tool and as a report without the grant, allowed with it, never across tenants; a clerk cannot ask).
- *As built (12.6):* migration `0054_ai_quality`: `ai.quality_daily` (tenant, property, agent, version — null for an
  agent-level metric —, UTC day, metric, value, samples; unique with NULLS NOT DISTINCT; RLS). `domain/quality.ts`
  (unit-tested) turns recorded counts into metrics, each with its sample size and left out without samples:
  `executions`, `fallback_rate` (FAILED or HANDED_OFF), `cost_per_execution_minor`, `tool_failure_rate` (TOOL_CALL steps
  in ERROR), `human_override_rate` (proposals people rejected of those decided), `draft_edit_distance` (average of
  `DRAFT_EDIT` feedback), `guest_recontact_rate` (a completed reply followed by another guest message in the same
  conversation within 24 h), `task_creation_accuracy` (requests the AI created that were not cancelled within 24 h —
  new signals `SERVICE_REQUEST_CREATED` / `SERVICE_REQUEST_STATUS`; attributed to `GUEST_CONCIERGE`) and
  `recommendation_acceptance` (insight feedback; pseudo-agent `INSIGHTS`). Evaluation and shadow executions are left
  out. `QualityService` recomputes a whole day (replace, so reruns give the same rows); the worker runs
  `ai.quality.compute` every six hours for yesterday and today of every property the AI context knows. API (permission
  `ai.quality.read`, general manager; `AI_INTELLIGENCE`): `GET /properties/:id/ai/quality?from&to` (≤ 92 days) and
  `POST …/ai/quality/recompute` (`{day}`); `GET /properties/:id/ai/pulse` (`ai.insight.read`) serves the screen the same
  pulse the Manager assistant reads. Staff web: `/intelligence` (section shown with `ai.insight.read` and
  `AI_INTELLIGENCE`) — **Insights** (HIGH first, the reason, suggested action and detector name from the shared `ai.*`
  catalog keys, confidence, acknowledge / resolve / dismiss with a required reason, and the Manager assistant's
  question box for `ai.manager.use`), **Right now** (the pulse counts) and **AI quality** (latest value per assistant
  and measure over the last week); the app's messages now include the `ai` namespace. Tests: quality unit test;
  integration `quality.integration.spec.ts` (a seeded day gives exactly eight metrics, evaluation runs excluded,
  recomputing gives the same rows, permission and tenant isolation, range validation); the pulse endpoint in the
  manager spec; Playwright `intelligence.spec.ts` (English: reasons, acknowledge, dismiss needs a reason, the
  assistant's answer, pulse and quality tabs; Arabic: RTL, translated reason and action, severity bar on the start side).

#### 12.E Tests and acceptance
- Unit: graders, canary bucketing, every detector's thresholds and confidence, insight fingerprinting, twin traversal,
  quality formulas.
- Integration (real Postgres): publish refused without a passing run; shadow stores a comparison and changes nothing;
  canary share stable per conversation; detectors raise once and update on re-detection; acknowledge/dismiss write
  feedback; twin built from events; tenant-leak tests for every new table.
- E2E: the Spec §80 chain — guest → stay → room → AC unit → failure → work order → engineer → resolution → feedback —
  answered by the twin for a seeded scenario; the Spec §38 example raised as `RECURRING_ASSET_FAILURE` with its
  evidence; the Manager assistant answers "what needs my attention today" from tools only and consults the Engineering
  Copilot; Playwright for the Intelligence screens in LTR and RTL.

### Phase 13 — Voice / IoT / Additional Connectors
Voice channel via PBX gateway → conversation engine → same tools; IoT/BMS telemetry path (high-volume ingest → rules/anomaly → meaningful events); POS/ERP/Wi-Fi/lock connectors through the Connector SDK. No core redesign allowed; if one seems needed, stop and write an ADR.

### Phase 14 — Languages, Restaurant reservations, the Hotella staff app (owner decisions of 2026-10-05)
Spec Appendix B; ADR-0022 (five locales), ADR-0023 (Flutter staff app). **Order (owner may reorder):** after 11.7 —
14.1 → 14.2 → 14.3 (pilot value: tourists' languages and à la carte dinners) → 14.4 → 14.5 → 14.6 → 9.5 → Phase 12 →
Phase 13.

#### 14.A Languages (ADR-0022)
- `SUPPORTED_LOCALES` default `en,ar,it,ru,de`; one `LOCALES`/`RTL_LOCALES` constant in `platform-i18n` (and a
  web-safe export) used by staff-web, guest-web, the catalog check and the ARB converter.
- `tools/locales-check` → every locale has exactly the `en` keys, valid ICU, same arguments, the CLDR plural
  categories of that locale (`Intl.PluralRules(locale).resolvedOptions().pluralCategories`).
- Catalogs `locales/{it,ru,de}/*.json` (all namespaces); staff-web/guest-web routing and language switchers; property
  `enabledLocales` accepts the five; translation tables accept them; FIAS/OPERA language codes mapped through the
  integration mapping (unknown → exception); WhatsApp template locales; concierge language list.
- Tests: catalog check unit tests (plural categories per locale), i18n service resolution for `it`/`ru`/`de`,
  Playwright smoke per new locale (guest home, staff inbox), translation fallback (property default → `en`).
- Owner item: native-speaker review of the drafted it/ru/de texts before the first hotel uses them.
- *As built:* `SUPPORTED_LOCALES`/`RTL_LOCALES` in `platform-i18n` (server) and `LOCALES`/`RTL_LOCALES`/`LOCALE_NAMES`
  (endonyms) in `@hotella/ui` (web; a test keeps `/locales` and the list in step); `checkMessages` adds argument and
  CLDR plural-form checks (current CLDR gives Italian a `many` form as well; an exact `=0` stands in for Arabic
  `zero`) — it found nine incomplete Arabic plurals, fixed. 1,356 keys × 3 new locales drafted in parallel and checked
  (`pnpm locales:check` now covers all five). Web apps take every locale that has their namespaces
  (`sync-messages.mjs`); the language menus list the five by their own names. The concierge and staff assistants
  answer in all five: `replyLocale` reads Arabic and Cyrillic script and tells English, Italian and German apart by
  common words and letters, else the conversation's language (deterministic). OPERA `GL` passes through when it is a
  two-letter ISO 639-1 code (the Planova Standard Profile asks the hotel to configure GL that way); anything else is
  not guessed. Cyrillic falls back from Cairo (no Cyrillic glyphs) to the system font. Tests: catalog checker unit
  tests, reply-language unit tests, Playwright staff inbox and guest home in it/ru/de and a German browser landing in
  German.

#### 14.B Restaurant context (schema `restaurant`, Spec B.1)
*Domain model (data class INTERNAL unless stated):*
- `restaurants` (tenant, property, code, status DRAFT|ACTIVE|INACTIVE, `min_party`, `max_party`,
  `book_days_ahead`, `guest_cutoff_minutes`, `cancel_cutoff_minutes`, `allowance_applies` bool, version).
- `restaurant_translations` (restaurant_id, locale, name, description, dress_code_note) — PUBLIC.
- `sittings` (restaurant, weekday 0–6, `starts_at` local time, `seats`, `valid_from`, `valid_to` null, active) —
  rows are never deleted once booked against; a schedule change closes the old row (`valid_to`) and adds a new one.
- `closures` (restaurant, `on_date`, sitting null = whole day, reason).
- `sitting_loads` (tenant, property, sitting, `service_date`, `covers`) — the atomic capacity counter:
  `INSERT … ON CONFLICT DO UPDATE SET covers = covers + n WHERE covers + n <= seats RETURNING` (override skips the
  `WHERE`), decremented on cancel/no-capacity transitions.
- `reservations` (tenant, property, restaurant, sitting, `service_date`, `starts_at` snapshot, `party_size`,
  `stay_id`, `guest_id` (CONFIDENTIAL), `room_number` snapshot (CONFIDENTIAL), status
  CONFIRMED|SEATED|COMPLETED|CANCELLED|NO_SHOW, `channel` GUEST_APP|STAFF|AI, `notes` (SENSITIVE: allergies),
  `override_reason`, `cancel_reason`, version) and `reservation_transitions` (append-only: from, to, actor type/id,
  reason, at; trigger `platform.reject_history_mutation()`).
- Allowance (pure function, `domain/rules.ts`): `nights = departure − arrival (≥ 1)`;
  `allowed = ceil(nights / blockNights) × perBlock` (setting `restaurant.reservation.allowance` = `{ blockNights: 7,
  perBlock: 1 }`); used = reservations of the stay at that restaurant not CANCELLED.
- Stay facts come from `GUEST_API` (public): status, dates, adults/children, room; the context never reads guest
  tables. Checkout/cancellation of a stay (canonical `hotel.*` → guest events) cancels its future reservations
  (consumer `@Idempotent`).
*Migrations:* `00xx_restaurant` with tenant/property FKs, RLS `tenant_isolation`, unique
`(tenant_id, property_id, code)`, `sitting_loads` PK `(sitting_id, service_date)`, check `covers >= 0`.
*APIs (staff, `/api/v1`):* `GET|POST /properties/:p/restaurants`, `PATCH /properties/:p/restaurants/:id`,
`PUT …/:id/translations/:locale`, `GET|PUT …/:id/sittings` (replace the weekly schedule from a date),
`POST|DELETE …/:id/closures`, `GET /properties/:p/restaurants/availability?from&to`,
`GET /properties/:p/restaurant-reservations?date&restaurantId&status`, `POST /properties/:p/restaurant-reservations`
(by `stayId`; optional `override: { reason }`), `POST …/restaurant-reservations/:id/{seat,complete,no-show,cancel}`.
*Guest:* `GET /guest/restaurants` (open dates/sittings within the stay + remaining allowance),
`GET|POST /guest/restaurant-reservations`, `POST /guest/restaurant-reservations/:id/cancel` — guest scope
`DINING`. Errors: `restaurant.reservation.allowance_used`, `.sitting_full`, `.outside_stay`,
`.cutoff_passed`, `.party_size`, `.closed`.
*Events:* `restaurant.reservation.created.v1`, `restaurant.reservation.cancelled.v1`,
`restaurant.reservation.status_changed.v1`. *Permissions:* `restaurant.restaurant.read|manage`,
`restaurant.reservation.read|manage|override`. *Entitlement:* module `RESTAURANT` (catalog convention). *Manifest:* complete (rule 22).
*AI tools (14.3):* `restaurant.find_tables` (READ), `restaurant.book_table` (MEDIUM, own stay only).
*Tests:* allowance unit table (1, 7, 8, 14, 15, 21 nights; config 7/1 and 5/2), capacity race (two concurrent
bookings for the last seats → exactly one), override with reason audited, checkout cancels future bookings, outside
stay / cutoff / closure / party size refusals, tenant-leak test, manifest test, e2e scenario (guest books, staff
books by phone, allowance refuses a second booking at the same restaurant for a 6-night stay but allows one for a
9-night stay, checkout cancels), Playwright staff board and guest booking in en/ar (+ it/ru/de smoke).

- *As built (14.2):* `packages/domain/restaurant` (schema `restaurant`, migration `0046_restaurant`: restaurants,
  translations, sittings, closures, sitting_loads, reservations, append-only reservation_transitions; RLS
  `tenant_isolation`, tenant/property FKs). Rules in `domain/rules.ts`: `stayNights`, `stayAllowance`, `withinStay`
  (arrival ≤ date < departure), `sittingsOn` (weekday, validity, active, closures), `guestWindow` (cut-off and days
  ahead, guest channel only), transitions. Seats are held by CONFIRMED/SEATED/COMPLETED; the allowance counts
  CONFIRMED/SEATED/COMPLETED/NO_SHOW (a no-show used its booking, a cancellation did not). A transaction-scoped
  advisory lock per stay + restaurant serialises the allowance check; the capacity counter is the atomic upsert
  above (`sitting_full` when it returns no row). Staff booking goes through ActionGate
  (`restaurant.reservation.manage`), and `override: { reason }` passes a second gate on
  `restaurant.reservation.override` (HIGH) and is audited as `restaurant.reservation.create_override`. Guest routes
  check scope `DINING` and the `RESTAURANT` entitlement; guests see names in their language (`Accept-Language`,
  fallback property default → `en`). Worker consumer `restaurant.stay-ended` (stay checked out, cancelled or no-show)
  cancels the stay's CONFIRMED reservations (`STAY_ENDED`) and releases their seats. System roles: GM (all), duty manager (desk +
  override), front desk and guest relations (desk), and a new `RESTAURANT_HOST` (board, phone bookings, logbook).
  Additional errors beyond the list: `.too_early`, `.transition_not_allowed`, `restaurant.sitting_duplicate`,
  `restaurant.stay_required`. Tests: rules unit table (nights 1/7/8/14/15/21, policy 7/1 and 5/2, sittings,
  windows, transitions), integration (6-night stay refused a second booking, 9-night stay books twice and a third
  needs the override permission with an audited reason, two concurrent bookings for the last seats → one wins,
  board + seat/complete history, PMS checkout cancels and frees seats, tenant leak), manifest and role catalog.

- *As built (14.3):* staff web `/restaurant` (section shown with `restaurant.restaurant.read` and the `RESTAURANT`
  licence): **Reservations** — the board of a day per restaurant and sitting (seats booked/total, room, guest, party,
  channel, override, notes) with seat / no-show / cancel / done; **New booking** — find the room
  (`GET …/restaurant-reservations/stays?room=` → the stays in the room or arriving there today, the primary guest and
  each restaurant's bookings left; needs `restaurant.reservation.manage`), pick restaurant, night and sitting, book;
  past the allowance or a full sitting only with `restaurant.reservation.override` and a reason; **Setup** — create
  (draft), open/close for bookings, rules, names/descriptions/dress code in the five languages, the weekly sittings
  (repeat a sitting every day; a new schedule applies from a chosen date) and closed days or sittings
  (`DELETE …/restaurants/:id/closures/:closureId` reopens; `GET …/restaurants/:id` returns all translations, the
  latest schedule and the closures ahead). Guest web `/restaurants` (link on the home screen only when the guest has
  `DINING` and the hotel has bookable restaurants): bookings left per restaurant, date → time → guests → optional
  allergies/wishes, the guest's reservations with cancel (until the cut-off). Guest Concierge v5:
  `restaurant.find_tables` (READ, permission `restaurant.offer.read`) and `restaurant.book_table` (MEDIUM, autonomous
  like a service request, permission `restaurant.reservation.book_own`); both act only for the execution's guest with
  the scopes of that guest's live grant (no grant for the stay → refused) and through the same rules as the guest app;
  bookings are recorded with channel `AI` and actor `AI_AGENT`. Tests: integration (room lookup, closures, the two
  tools including a stranger's stay refused, and the Phase 14 restaurant acceptance end to end: a 9-night guest books
  in Italian, a third booking at one restaurant is refused, a full sitting is booked only with the override, seat and
  no-show on the board, checkout cancels the rest), Playwright staff (en: seat + phone booking with override; ar RTL
  without the override permission; setup of the week; it/ru/de board) and guest (en: book and cancel from home; ar
  RTL with the allowance used; it/ru/de).

#### 14.C The Hotella staff app (ADR-0023)
- `apps/mobile` (Flutter): hotel code / QR → branding → sign-in (IAM, MFA) → home with My tasks, Requests inbox,
  Alerts, Restaurant bookings (with permission); five locales from the catalog (ARB generated), RTL for Arabic.
- Platform: `POST /me/devices` (register/refresh push token), `DELETE /me/devices/:id`; `iam.staff_devices`;
  `PUSH` delivery adapter (FCM, APNs) in the notification pipeline with credentials as SecretRefs; payloads without
  guest PII; device revoked on sign-out/user deactivation; `GET /public/properties/by-code/:code` (branding only).
- CI: Flutter job (`flutter analyze`, `flutter test`, golden tests LTR/RTL), generated Dart client and ARB freshness.

- *As built (14.4):* `apps/mobile` (Flutter 3.47.6 stable, Dart 3.13; Android `eg.planova.hotella` and iOS, display
  name "Hotella"; dependencies `http`, `flutter_secure_storage`, `intl`, `flutter_localizations` only). Platform:
  `GET /public/hotels/:code` (public, 20/min per IP; the tenant code → brand of its first live property on channel
  `APP`: name, colours, whether it has a logo, locale/direction, attribution; unknown, suspended or empty → 404
  `org.hotel.not_found`). Strings: namespace `mobile` in `/locales` (five locales, parity-checked) →
  `tool/sync_arb.mjs` → `lib/l10n/app_*.arb` (keys `homeWelcomePlain`; a plural branch's ICU `#` becomes the plural
  argument because gen-l10n does not read `#`) → `flutter gen-l10n`. Client: `tool/gen_client.mjs` reads the OpenAPI
  snapshot and writes `lib/api/hotella_api.g.dart` — one method per operation the app uses and a Dart class per
  request body (the OpenAPI document has no response schemas yet, so responses are read by small hand-written view
  models in `session.dart`). Flow: hotel code → brand → e-mail/password (`tenantCode` from the hotel) → MFA code
  when enrolled → home (greeting, property switcher when there are several, the sections the person's permissions
  open: tasks `task.read`, requests `request.read`, alerts `alert.read`, restaurant `restaurant.reservation.read`;
  the screens behind them are 14.6) and the Planova attribution on every screen. Only the refresh token is kept, in
  the Keychain/Keystore; the access token lives in memory, is renewed once on a 401, and a returning person is signed
  in again from the refresh token. CI job `mobile`: generated client and ARB `--check`, `flutter gen-l10n` committed,
  `flutter analyze`, `flutter test` (sign-in with a wrong password, MFA, sign-out clears the kept token, a returning
  person, Arabic RTL and API calls in Arabic, it/ru/de LTR). Golden screenshots are left out: font rendering differs
  between machines, so direction is asserted on the widget tree instead.

- *As built (14.5):* `iam.staff_devices` (migration `0047_staff_devices`: tenant, user, session, platform
  ANDROID|IOS, push token CONFIDENTIAL, app version, locale, last seen, revoked; RLS `tenant_isolation`; one live row
  per tenant and token). `POST /me/devices` registers this session's phone (again on every app start; the same token
  moves to whoever is signed in on the phone, `REASSIGNED`), `DELETE /me/devices/:id` removes it — self-service bound
  to the session like sign-out and MFA enrolment (no permission beyond a signed-in hotel staff member; platform staff
  get 403 `iam.device.staff_only`), audited without the token. A revoked session (sign-out, disabled user, refresh
  reuse) revokes its phones. `IDENTITY_API.staffDevices` / `revokeStaffDevice` for the sender. Operations: channel
  `PUSH` in every priority's defaults (switchable per category like e-mail; critical policy overrides), deliveries
  `PENDING` when the channel is configured, else `SKIPPED channel_not_configured`; the sender pushes to each live
  phone with a generic title per category (`ops.push.<category>.title`, else `ops.push.default.title`) in the phone's
  or the person's language, and data `intent_id`, `category`, `property_id`, `source_type/id` only; a phone FCM
  reports gone (404/UNREGISTERED) is revoked (`PUSH_TOKEN_GONE`), other failures retry like e-mail. `FcmPushChannel`:
  FCM HTTP v1 with an OAuth token minted from the service-account JSON (RS256 JWT bearer; Node crypto and fetch, no
  SDK), `PUSH_FCM_PROJECT_ID` + `PUSH_FCM_CREDENTIALS_REF` (OpenBao `kv/hotella/app#fcm_service_account`); iOS goes
  through FCM with the APNs key uploaded to Firebase (no separate APNs adapter). Operations: `pilot.sh push-setup
  <project> <key.json>` (also `hotella push-setup`), runbook `docs/runbooks/push-notifications.md`. App:
  `firebase_core` + `firebase_messaging`, Firebase options from `--dart-define` (no config files committed), the
  phone registers after sign-in and on token rotation, sign-out removes it and deletes the token before the session
  ends; builds without Firebase settings run without pushes. Tests: FCM channel unit test against a local fake (JWT
  signature, one token for several sends, gone vs retryable), operations integration (push reaches the phones in the
  person's language with references only, a gone phone is revoked, no phone → skipped), identity integration
  (register, re-register, platform staff refused, sign-out and disabling revoke, delete, audit without token), app
  widget test (registration body, removal before logout, token forgotten). Notification taps open the right screen in
  14.6.

- *As built (14.6):* platform: `GET /properties/:p/restaurant-reservations/:id` (`restaurant.reservation.read`; the
  board's view with the guest's name and the restaurant's name in the asked language; another tenant → 404) and a
  notification rule on `restaurant.reservation.created`: a booking from the guest app or the concierge (not one the
  restaurant team took itself) notifies everyone with `restaurant.reservation.manage` at the property — category
  `RESTAURANT`, template `ops.notification.restaurant_booked` (party, night, time, channel; never the guest), push title
  `ops.push.restaurant.title`, source `restaurant_reservation`. App (`apps/mobile`): the home sections open **My tasks**
  (`assignee=me`, open statuses; a task with start / pause with a reason / resume / done / decline with a reason,
  each sent with the version the person saw), **Guest requests** (open and in progress; detail with room, times, how
  often it was asked and a link to the work), **Alerts** (open and acknowledged; acknowledge, resolve with what was
  done, open the work behind an SLA alert), **Restaurant bookings** (the board of a day, moved by day; a booking with
  seat / no-show / finished for `restaurant.reservation.manage`), a **work item** screen (an escalation's work and its
  tasks) and the **inbox** (bell with the unread count, refreshed when a push arrives in the foreground; a tap marks it
  read and opens what it is about). A tapped push (`source_type` task, work_item or restaurant_reservation; anything
  else → inbox) opens its screen at its property, also when the app was started from it and after the session is
  restored. Actions show only with the permission and the API decides again. Offline read cache: each screen's last
  good answer is kept per property in the Keychain/Keystore (`ReadCache`); without a connection the screen shows it
  with "Offline: showing what was saved at …", with nothing saved the error and a retry; sign-out (and a lost
  session) wipes it. Every screen carries the Planova attribution. Strings: 55 `mobile.*` keys in the five locales
  (ARB generated). The generated client covers 29 operations. Tests: restaurant integration (detail, isolation),
  operations integration (a guest-app booking reaches the manager in Arabic as a push with references only, a staff
  booking notifies nobody, the inbox text in English), app widget tests (tasks lifecycle with versions, offline banner
  and wipe on sign-out, alerts acknowledge/resolve, a tapped booking push opens the booking and seats it, the app
  started from a push opens the task after restore, inbox read + open, board by day, Arabic RTL screens). Acceptance on
  devices (a waiter's phone receives the booking push and opens it) is part of the pilot checklist once the Firebase
  project exists (`docs/runbooks/push-notifications.md`).

#### 14.D Sprints
| Sprint | Scope | Status |
|---|---|---|
| 14.1 | Five locales: config, catalog check with CLDR plurals, it/ru/de catalogs, web apps, translation tables, PMS language mapping | done |
| 14.2 | Restaurant context: model, migration, allowance and capacity rules, staff and guest APIs, events, checkout consumer, manifest, tests | done |
| 14.3 | Restaurant UI: staff board, phone booking, configuration screens; guest booking; concierge tools; e2e; acceptance | done |
| 14.4 | Staff app skeleton: Flutter project, generated client, ARB from the catalog, hotel code → branding → sign-in, CI job | done |
| 14.5 | Push notifications: devices, PUSH adapter (FCM/APNs) with OpenBao credentials, notification routing to devices | done |
| 14.6 | Staff app screens: tasks, requests, alerts, restaurant bookings; offline read cache; acceptance on devices | done |

#### 14.E Acceptance
A guest of a 9-night stay books two dinners at the same à la carte restaurant and one at each other restaurant from the
guest app in Italian; a third booking at the first restaurant is refused; the restaurant manager sees the board,
books a phone guest into a full sitting only with the override and a reason, marks seat/no-show; checkout cancels the
remaining bookings; a waiter receives a push on the Hotella app (no guest data in the push) and opens the booking.

---

## 11. Milestones & sequencing

```text
Phase 0 ──> Phase 1 ──> Phase 2 ──> Phase 3 ──> Phase 4 ──> Phase 5  = M1 (guest served from PMS data via simulator, no live OPERA link, no AI)
                                                              └─> Phase 6  = M2 (AI concierge)
                                                                   ├─> Phase 7 (HK) ──┐
                                                                   ├─> Phase 8 (ENG) ─┼─> Phase 9 = M3
                                                                   │                  │
                                                                   ├─> Phase 10 (OPERA 5 agent) ─┐
                                                                   └─> Phase 11 (Licensing)  ────┴─> M4 (pilot-ready)
                                                                                 └─> Phase 12 ──> Phase 13
```

**M4 completion (owner decisions 2026-10-04):** before the first pilot hotel also Sprints 10.10 (WiX v5 MSI) and 11.7
(offline-resilient entitlements); Sprint 9.5 (Lost & Found vision) is optional per property and may follow.

**Owner additions (2026-10-05):** Phase 14 — five languages (14.1), Restaurant à la carte reservations (14.2–14.3),
the Hotella staff app in Flutter with push notifications (14.4–14.6) — runs after 11.7 and before 9.5, Phase 12 and
Phase 13. Every hotel
is prepared with `docs/pilot/PILOT_READINESS_CHECKLIST.md`.

Phases 7 and 8 may run in parallel after Phase 6 (they share only the Operations Engine). Phase 10 may start its .NET agent skeleton in parallel with Phase 7 since it depends only on the Connector SDK from Phase 2.

**Parallelism rule:** two phases may run in parallel only if neither needs to change a package the other owns. Shared packages (`platform/*`, `contracts/*`, `operations`) changes are serialized through review.

---

## 12. Module Definition of Done (applies to every bounded context, Spec §84.19)

A module/phase is accepted only when all of the following are true:

1. **Scope doc** in this plan is current (scope, domain model, migrations, APIs, events, permissions, tests, acceptance).
2. **Schema**: own PostgreSQL schema; every tenant-owned table has `tenant_id` (+ `property_id` where scoped); UUIDv7 ids; TIMESTAMPTZ; `version` on concurrency-sensitive tables; FKs for business-critical relations; no `*_en`/`*_ar` columns; migrations reviewed, reversible where feasible, expand/contract-safe.
3. **Boundaries**: other domains touch it only via `/public` interfaces or events (lint-enforced). It never writes another domain's tables.
4. **Authorization**: every endpoint declares permissions; property scope enforced; tenant leak tests present.
5. **Action gate**: every mutation goes through `ActionGate`; entitlement capability codes declared even while the stage is a stub.
6. **Audit**: important mutations write audit rows with actor type, reason, approval/policy refs, correlation id.
7. **Events**: published events are in `contracts/events`, versioned, written through the outbox; consumers idempotent via inbox.
8. **Localization**: no hardcoded user-facing strings; `en` and `ar` keys present and parity-checked; localized business data uses translation tables; RTL verified for any UI.
9. **Versioning**: published definitions immutable.
10. **AI**: if the module exposes AI tools, they are registered with schema, risk level, required permission; no provider SDK imported outside the Model Gateway.
11. **Integration**: declared connector capabilities consumed; unknown external values create exceptions.
12. **Observability**: correlation ids flow through jobs and events; metrics for queue lag/failures; no PII in logs.
13. **Tests**: unit for domain rules; integration against real PG/Redis; contract tests for events/connectors; e2e scenario for the phase acceptance; all in CI.
14. **Docs**: OpenAPI updated; ADR for any deviation; CLAUDE.md updated if a convention changed; TRACEABILITY rows updated.
15. **Privacy & retention**: every column carries a data class; the module declares retention behaviour per class and implements its purge/anonymize job; nothing in the module blocks guest anonymization except legal-hold rows.
16. **Manifest**: the module's `ModuleManifest` is complete (permissions, events, entitlements, AI tools, locale namespaces, integration capabilities, data classes) and the manifest tests pass.

---

## 13. Open questions (do not block Phase 0; must be answered by the phase indicated)

| # | Question | Needed by | Current assumption |
|---|---|---|---|
| Q1 | Frontend stack | — | **Answered:** Next.js + next-intl + Tailwind (ADR-0009 accepted) |
| Q2 | WhatsApp provider | — | **Answered:** both Meta Cloud API and BSP, selectable per channel (ADR-0015). Concrete first BSP picked at pilot |
| Q3 | OTP fallback | — | **Answered:** WhatsApp → SMS (auto + manual) → optional voice → staff-assisted (ADR-0015). Concrete SMS aggregator picked at pilot |
| Q4 | Guest-web domain model: `*.hotella.app` subdomain per property vs custom property domains (affects activation URLs & branding resolution). With on-prem hosting, DNS for `*.guest.hotella.app` must point at the on-prem ingress, or properties use their own domains | Phase 4 | `{property-code}.guest.hotella.app` + optional custom domain |
| Q5 | OPERA 5 interface | — | **Answered (amended 2026-10-04, ADR-0019):** three connectors behind the Unified OPERA Adapter — read-only OPERA DB (first-class read source, never written), IFC8/FIAS (real-time events, Planova Standard Profile), OWS (optional, standard connector); capability registry per property. Pilot to confirm IFC8/OWS licences and the read-only account |
| Q6 | Hosting target | — | **Answered:** on-premises (ADR-0013): Compose → k3s/RKE2, OpenBao (Vault API), SeaweedFS, Grafana stack, pgBackRest |
| Q7 | Data residency / region constraints | — | **Answered by Q6:** data stays within the on-prem installation; multi-region = multiple installations |
| Q8 | First AI provider(s), data egress to them, and budget caps (ADR-0018) | Phase 6 | **Answered 2026-10-03:** Anthropic (Claude) and OpenAI (ChatGPT) behind the gateway, masked and class-limited; cap 100 USD per hotel per month (`ai.budget.monthly_limit_minor` default, per property). CI keeps `FAKE` |
| Q9 | Initial platform role catalog (GM, Duty Manager, HK Supervisor, Room Attendant, Engineer, Front Desk, Guest Relations, Platform Admin, Support) — confirm names and Arabic labels | Phase 1 | as listed |
| Q10 | Pilot property: IFC8 interface license, OWS license status, read-only DB account possibility (ADR-0014, ADR-0019); compared against the standards of the OPERA Integration Guide (§16, §20) | before the M4 pilot | IFC8 available (owner, 2026-10-04); OWS per hotel; read-only DB access allowed |
| Q11 | Concrete BSP and SMS aggregator for the pilot (ADR-0015) | Phase 4 end | Meta Cloud API adapter first; BSP/SMS adapters implemented against fakes until chosen |
| Q12 | Windows installer toolset | before M4 | **Answered 2026-10-04:** MSI with WiX v5 (ADR-0020); PowerShell secondary |
| Q13 | Lost & Found photos to a vision model | Phase 9 | **Answered 2026-10-04:** allowed, optional per property, off by default, no guest data, keys in OpenBao (Sprint 9.5) |
| Q14 | Offline behaviour of licensing | Phase 11 | **Answered 2026-10-04:** offline-resilient entitlements (ADR-0021, Sprint 11.7) |
| Q15 | Server requirements and the hotel checklist | before M4 | **Answered:** `docs/pilot/PILOT_READINESS_CHECKLIST.md` (§1 sizing, §2–§19 checks) |
| Q16 | Authenticode certificate for signing the MSI and agent executable (a purchase) | before go-live | open — owner |
| Q17 | Native-speaker review of the Italian, Russian and German texts | before a hotel uses them | open — owner (drafted by engineering, ADR-0022) |
| Q18 | Restaurant allowance counted per stay (room reservation) or per person; 7-night block configurable | 14.2 | per stay, block 7 nights, 1 booking per block (Spec B.1); owner may change |
| Q19 | Apple Developer Program and Google Play accounts, Firebase project, store name "Hotella" (purchases) | 14.4 | open — owner |
| Q20 | Staff app technology | — | **Answered 2026-10-05:** Flutter, one app "Hotella", sign-in per hotel (ADR-0023) |

---

## 14. Immediate next actions (start now)

1. Commit this plan, the spec, ADRs and `CLAUDE.md` to `claude/hopeful-archimedes-jskowx` and push.
2. Execute **Sprint 0.1** tasks 0.1.1 → 0.1.8 in order; open one PR per sprint (or per task group if large).
3. On Sprint 0.1 completion: run the Phase 0 acceptance checklist items that already apply, then start Sprint 0.2.
4. Product owner answers Q4, Q8, Q9 while Phase 0 runs; they do not block it. Q1, Q2, Q3, Q5, Q6, Q7 are answered (ADR-0009, 0013, 0014, 0015).
