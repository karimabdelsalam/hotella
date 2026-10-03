# Phase 0 acceptance — Repository & Engineering Foundation

**Date:** 2026-10-03 · **Branch:** `claude/hopeful-archimedes-jskowx` · **Head:** see `git log` · **CI:** GitHub Actions workflow `CI`

Checklist from `docs/BUILD_PLAN.md` §4, with evidence. ✅ verified by automation · 🟡 needs a human.

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | `pnpm install && pnpm dev:infra && pnpm db:migrate && pnpm dev` boots API + worker; `/api/v1/ready` green | ✅ (CI) / 🟡 (laptop) | CI step "Migrations apply to a real PostgreSQL 18" and "Readiness against real PostgreSQL 18 + Valkey 9" return `{"status":"ok","info":{"postgres":{"status":"up"},"valkey":{"status":"up"}}}` (runs 4, 6, 8). The dev-compose path needs a developer with Docker to run it once (Developer Guide §2). |
| 2 | CI runs lint, typecheck, build, unit + integration tests against real PostgreSQL/Valkey, migration drift check, locale parity, OpenAPI snapshot | ✅ | `.github/workflows/ci.yml`; run 6: database 6/6, events 7/7, queue 3/3, storage 2/2 (SeaweedFS via Testcontainers), worker pipeline 1/1, i18n 9/9, api 8/8. |
| 3 | Every log line carries `correlation_id`; a request's id appears on the outbox row and in the job the relay enqueues | ✅ | `logger.spec.ts` (mixin field always present); `events.integration.spec.ts` asserts `outbox.correlation_id` and the envelope's `correlation_id` from the request context; `pipeline.e2e-spec.ts` asserts the consumer runs under the originating id. |
| 4 | A sample event published inside a transaction is delivered to a consumer exactly once across a forced duplicate delivery | ✅ | `platform.ping.requested.v1`: `pipeline.e2e-spec.ts` relays twice and asserts one consumption; `queue.integration.spec.ts` publishes the same envelope twice (jobId = event_id); `IdempotentConsumer` tests (duplicate → no-op, per-consumer, failed handler leaves no inbox row). |
| 5 | `Accept-Language: ar` changes the `detail` of a Problem Details response; `ar`/`en` key parity passes | ✅ | `app.e2e-spec.ts` (404 and validation details in Arabic, `Content-Language: ar`); `pnpm locales:check` in CI (35 keys, ICU-valid). |
| 6 | A deliberate cross-domain import fails lint; a deliberate `process.env` read outside the config package fails lint | ✅ | `pnpm lint:selftest` 6/6 negative fixtures (cross-domain import, platform→domain, `process.env`, `console`, `__dirname`, DB-generated uuid/naive timestamp). |
| 7 | No secret value appears in any config table, log line or test fixture | ✅ | Config accepts only `SecretRef`s for storage credentials (`schema.spec.ts`); redaction covers tokens/OTP/phones/headers at depth (`logger.spec.ts`); fixtures use `env://` refs; `SecretResolver` is the only path to values. |
| 8 | ADRs exist and `CLAUDE.md` reflects them; the Developer Guide has been followed end-to-end by someone other than its author | ✅ ADR-0001…0017 / 🟡 guide walk-through | `docs/adr/README.md`; `CLAUDE.md` stack and rules match ADR-0016/0017. The 30-minute clone-to-green walk-through must be timed by a team member and recorded here. |

## Delivered beyond the checklist
- Module manifests and data-class registry (Spec §76, §67) are live from Phase 0 and validated at boot.
- Feature flags with scope resolution and change events.
- Worker app with outbox relay, five priority queues, scheduler base and operational readiness endpoint.
- HTTP conventions: idempotency keys, rate limiting with IETF headers, cursor pagination contracts, OpenAPI from zod with a committed snapshot.

## Deviations recorded during Phase 0 (all in ADRs)
- MinIO → SeaweedFS (ADR-0013): MinIO community images withdrawn from Docker Hub and quay.io; unpatched CVE in the last free release.
- `node16` → `nodenext` module setting (ADR-0016): CommonJS output may `require()` ESM-only dependencies on Node 24.
- `eslint-plugin-boundaries` → core `no-restricted-imports` + package `exports` maps + dependency-cruiser (ADR-0001).
- Migration journal moved to its own `migrations` schema so migration 0000 owns `CREATE SCHEMA platform` (found by CI run 2).

## Open items carried into Phase 1
- 🟡 Items 1 and 8 above need one developer with Docker to run the Developer Guide once and record the time.
- `pnpm/action-setup@v4` prints a Node 20 deprecation warning on GitHub runners; bump when a Node 24 build is published.
- Arabic digit shaping (Arabic-Indic vs Western) becomes a per-property presentation setting when the guest UI lands (Phase 4/5).
