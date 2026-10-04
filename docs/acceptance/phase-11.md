# Phase 11 acceptance — Licensing & Control Plane, Developer Platform v1 (M4b)

**Date:** 2026-10-04 · **Branch:** `claude/hopeful-archimedes-jskowx` · **CI:** CI_EVIDENCE

Goal (Spec §58–§64, §74–§75; BUILD_PLAN §10 Phase 11; CLAUDE.md rule 14): a platform administrator defines a plan
once (modules, AI and connector entitlements, limits), publishes it as an immutable version and subscribes a tenant —
tenant-wide or for chosen properties. From then on every human, guest and AI action passes the real entitlement stage
of the action gate. The apps offer only what the property is entitled to, the hotel agent's offline licence carries
only entitled connectors, and usage is metered idempotently and aggregated for reporting. HARD limits stop the action
that would cross them with a localized reason. A tenant that holds `API_ACCESS` connects its own systems with scoped
API keys and receives signed webhooks. No business code compares plan names. Billing stays out (entitlement ≠
billing).

Legend: ✅ verified by automation · 🟡 needs a human.

| # | Criterion (BUILD_PLAN 11.B / 11.C) | Status | Evidence |
|---|---|---|---|
| 1 | Code-defined catalog (Spec §59 modules, AI, connectors, add-ons; §61 metrics), synced at boot, labelled in English and Arabic | ✅ | `licensing.integration.spec.ts` ("synchronises the code-defined catalog and labels it in the reader’s language"); `apps/api/test/role-catalog.spec.ts` (every manifest entitlement is a catalog code). |
| 2 | Plans with versions; a version is validated, needs CORE to publish and is immutable once published (rule 9) | ✅ | `plans.spec.ts`; `licensing.integration.spec.ts` ("drafts, validates, publishes and freezes a plan version, then retires it" — the database trigger refuses an UPDATE); migration 0038. |
| 3 | Subscriptions tenant-wide or for chosen properties, with a status machine, grace for PAST_DUE and append-only history; grants revoked, never deleted | ✅ | `entitlements.spec.ts` (status, period, grace, property scopes, grants); `entitlements.integration.spec.ts` ("subscribes a tenant to a published plan version only", "applies a property grant to that property only and revokes it", "follows the subscription through suspension and back, keeping its history"). |
| 4 | The real entitlement stage in api and worker: people, guests, AI agents and API clients of an unlicensed tenant are refused with `403 license.not_entitled`; SYSTEM/INTEGRATION work (PMS truth, revocations, timers) is never stopped | ✅ | `entitlements.integration.spec.ts` ("refuses people of an unlicensed tenant, but never system work"); `staff-assistant.integration.spec.ts` (AI agent entitlement); worker `WorkerManifestsModule`. Deployed: `smoke-developer.sh` — a staff action of the `UNLICENSED` tenant is refused, then allowed after a CORE grant. |
| 5 | No plan-name checks: modules declare their entitlement in the manifest; anything else asks `ENTITLEMENT_API.can` | ✅ | Manifest `entitlement` with validation rule `UNDECLARED_ENTITLEMENT`; `role-catalog.spec.ts`; there is no `plan ===` / plan-code comparison in `packages/` or `apps/` (grep). |
| 6 | Staff apps offer only entitled modules (English and Arabic) | ✅ | `apps/staff-web/e2e/licence.spec.ts` (header in English and RTL Arabic; fails open when the licence cannot be read, the API still refuses). Guest web: the API refuses; it has no navigation to hide yet. |
| 7 | The hotel agent's offline licence only while the connector entitlement holds; it expires no later than the entitlement | ✅ | `apps/pms-simulator/test/link.e2e-spec.ts` ("issues the agent licence only while the tenant is entitled to the connector (Spec §62)"). |
| 8 | Usage metered idempotently and aggregated per tenant and property by UTC day and month; reports for the control plane and the tenant; a reached limit is announced once per period; retention 400 days | ✅ | `usage.spec.ts` (UTC periods); `usage.integration.spec.ts` (all seven cases); producers: AI gateway tokens and vision, WhatsApp conversations, daily property and staff gauges, API calls (`api-clients.integration.spec.ts`). Deployed: the smoke finds `API_CALLS` usage events for the API client. |
| 9 | HARD limits refuse the action that would cross them (`409 license.limit_reached`), overrides replace the plan limit | ✅ | `entitlements.integration.spec.ts` ("enforces HARD limits through the engine, with overrides"); `staff-assistant.integration.spec.ts` ("is metered, stops at a HARD token limit and needs its AI entitlement"); property and staff creation call `assertWithinLimit`. |
| 10 | Control plane for platform administrators: tenants, plans, subscriptions, grants, usage, feature flags, attribution; reason on every change; no guest data; hidden from hotel staff; English and Arabic | ✅ / 🟡 | `control.integration.spec.ts`; `apps/staff-web/e2e/control.spec.ts` (four scenarios, LTR and RTL; hotel staff refused). Deployed: `license-pilot.sh` publishes `PILOT_ALL` and subscribes PILOT through the control-plane API. 🟡 Planova operations should run one real tenant onboarding through `/control`. |
| 11 | "Powered by Planova" can be hidden only while the tenant holds `WHITE_LABEL`, and comes back when it ends (rule 15) | ✅ | `control.integration.spec.ts` ("hides “Powered by Planova” only while the tenant holds WHITE_LABEL, and brings it back when it ends"); `branding.spec.ts`; `identity.integration.spec.ts` (attribution policy). |
| 12 | Developer platform: scoped API clients, a key shown once and stored hashed, scopes ⊆ the creator's (never `iam`/`support`/`license`), bound to tenant and optionally a property, gated by `API_ACCESS`, metered, revocable | ✅ | `api-clients.integration.spec.ts` (five cases, real licensing engine). Deployed: `smoke-developer.sh` creates a key, reads within its scope, is refused outside it, is metered and is refused once revoked. |
| 13 | Signed outbound webhooks: offered events only, HMAC-SHA256 over `t.body`, exponential retry, dead letter after 8 attempts, replay, secret rotation, https public targets only | ✅ | `webhooks.spec.ts`; `webhooks.integration.spec.ts` (six cases with a local receiver). Deployed: a private target is refused; a lost & found event travels outbox → relay → queue → inbox → delivery → the worker's 30-second sweep, which signs and attempts it (the target cannot resolve on the runner, so the retry is scheduled). |
| 14 | Tenant isolation | ✅ | RLS on every `license` tenant table, `iam.api_clients`, `integration.webhook_endpoints` and `webhook_deliveries` (migrations 0038–0040). Leak checks: `entitlements.integration.spec.ts` ("never confirms another tenant"), `usage.integration.spec.ts` (never another tenant's usage), `webhooks.integration.spec.ts` (404 across tenants; no fan-out to another tenant), `api-clients.integration.spec.ts` (a key cannot reach another tenant's property). |

## Deviations recorded during Phase 11
- Entitlement facts are cached per process for 30 s and dropped at once by the process that changes them, instead
  of a shared Valkey cache — 11.B.
- `API_CALLS` is recorded per request (idempotent on the correlation id), not flushed per minute by an interceptor —
  11.5 notes.
- API clients are refused by the key authenticator itself while the tenant lacks `API_ACCESS`, because reads do not
  pass the action gate — 11.5 notes.
- Webhook secrets are derived from one platform key (`WEBHOOK_SIGNING_KEY_REF`, OpenBao) and a per-endpoint secret
  version instead of one stored SecretRef per endpoint: nothing secret is stored per tenant, and rotation is a
  version bump — 11.5 notes.
- Control-plane screens cover tenants and plans; AI providers, connectors, support access and health stay on their
  existing APIs and Grafana — 11.4 notes.
- API clients and webhooks are managed by API only in v1; the tenant settings screens come with the tenant settings
  area.

## Open items carried forward
- 🟡 Owner (commercial): the real plan catalogue — names, which modules and add-ons each plan carries, limits and
  their enforcement (SOFT/HARD). `PILOT_ALL` is a technical pilot plan, not a commercial offer.
- 🟡 Pilot upgrade: before starting this release on an existing pilot host, add the webhook signing key to OpenBao
  (`docs/runbooks/deploy.md`).
- Billing integration (invoices, payment, `external_ref` sync) stays outside the platform (Spec §58).
- OAuth clients, per-client rate limits and a public developer portal (Spec §75 "later").
- Carried from earlier phases: see `docs/acceptance/phase-10.md` and `docs/acceptance/phase-9.md`.
