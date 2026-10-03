# Phase 2 acceptance — Guest, Stay & PMS Canonical Model

**Date:** 2026-10-03 · **Branch:** `claude/hopeful-archimedes-jskowx` · **CI:** GitHub Actions workflow `CI` (jobs "lint · typecheck · build · test" and "pilot deployment smoke")

Goal (Spec §85, BUILD_PLAN §6): the PMS stays the source of truth for guests and stays; a hotel agent feeds the platform over an outbound-only, mutually authenticated, ordered and idempotent link; canonical events drive the guest context, and differences are surfaced, never silently fixed. ✅ verified by automation · 🟡 needs a human.

| # | Criterion (BUILD_PLAN §6.6) | Status | Evidence |
|---|---|---|---|
| 1 | Simulator check-in creates guest + stay + party + room assignment via a canonical event; replaying the same source message changes nothing | ✅ | `guest.integration.spec.ts` "a future reservation becomes an EXPECTED stay…" and "check-in moves the stay in house; delivering the same event again changes nothing" (inbox idempotency + monotonic state machine). End to end: `link.e2e-spec.ts` "connects, reports capabilities and delivers a scenario exactly once despite chaos" (duplicated and reordered frames, dropped connection, resend from the last cumulative ack; one `integration_messages` row per source message). The pilot smoke enrolls a simulated agent over mTLS and waits for the worker to project its stay (`pilot/smoke-agent.sh`; green in CI run 37126832854 after the three pilot defects below were fixed). |
| 2 | Room move adds a second `room_assignments` row and closes the first; `GET /rooms/{room}/current-stay` flips | ✅ | `guest.integration.spec.ts` "a room move keeps history and flips the room lookup"; `integrations.integration.spec.ts` "turns a room move into hotel.stay.room_changed…". |
| 3 | An unknown room code yields an `integration_exceptions` row and no stay; confirming the mapping and replaying resolves it | ✅ | `integrations.integration.spec.ts` "parks a check-in for an unmapped room, holds its check-out, and ignores duplicates" and "a confirmed mapping plus replay releases the parked message and its successors in order". Optional codes (rate, market, VIP) stay `null` and raise the same deduplicated exception; nothing is guessed (rule 16). |
| 4 | PMS ids never appear as `id` of any `guest.*` row | ✅ | `guest.integration.spec.ts` "PMS ids never become guest identifiers or keys" (walks every `guest.*` table and id column); external ids live only in `integration.external_references` (`integrations.integration.spec.ts` "…keeps external references inside the integration context"). |
| 5 | Reconciliation reports MATCH for a clean entry and the right outcome for each injected discrepancy | ✅ | `link.e2e-spec.ts` "reconciles the PMS in-house list with the platform: MATCH and every discrepancy": staff start a run → signed `RESYNC_IN_HOUSE` command → the agent answers with a FIAS database sync → MATCH, DIFFERENT (room), MISSING_INTERNAL, MISSING_EXTERNAL; three `CONFLICT` exceptions; no stay changed; duplicate event delivery is a no-op. Deterministic comparison: `domain.spec.ts` "classifies every reservation deterministically" (rule 11). |
| 6 | Anonymizing a checked-out guest removes identifying fields and identifiers while stays, work history and audit rows remain queryable | ✅ | `guest.integration.spec.ts` "exports and anonymizes on request while stays, room history and audit remain": identifiers, preferences and consent evidence removed, PMS profile references unlinked, raw PMS messages for the guest's reservations scrubbed, `guest.guest.anonymized.v1` published; the export is returned once and only its SHA-256 is stored. |
| 7 | Checkout emits `hotel.guest.checked_out.v1`, consumed later by grants (Phase 4) and HK (Phase 7) | ✅ | `integrations.integration.spec.ts` (canonical events in the outbox) and `guest.integration.spec.ts` "check-out closes the stay and its room assignment and announces it" (`guest.stay.status_changed.v1` → `CHECKED_OUT`, the internal-id event Phase 4 grants revoke on — BUILD_PLAN §6.8 reality notes for 2.2). |
| 8 | No API or UI path creates a guest or stay outside the canonical-event consumer; a test asserts the state machine is driven only by PMS events | ✅ | `guest.integration.spec.ts` "stays change only through PMS events: the staff API has no mutating route"; staff can view, merge ("merges a duplicate walk-in profile…"), keep preferences and an append-only consent history ("staff keep preferences and an append-only consent history"; database trigger rejects UPDATE/DELETE). `domain.spec.ts` "never moves backwards on late or duplicate facts". |

## Agent link (ADR-0017), verified end to end
- Single-use enrollment token (24 h, hash stored) → CSR → 90-day ECDSA P-256 device certificate bound to instance/tenant/property; links without a client certificate are rejected; revocation closes the link at once (`link.e2e-spec.ts`).
- Ordered, idempotent delivery with cumulative acks and resend; a sequence jump opens a `CONFLICT` exception. HTTPS batches for large resyncs.
- Commands signed with Ed25519 over canonical JSON and verified by the agent; heartbeats feed integration health (HEALTHY/DEGRADED/DOWN).
- Tenant isolation: "never leaks across tenants (HTTP 404 and row-level security)" in the integration context; the guest suite runs as an ordinary role under forced RLS; `database.integration.spec.ts` asserts that every tenant-owned table has RLS.

## Delivered beyond the checklist
- `apps/pms-simulator`: a FIAS/OWS-shaped simulated hotel with a durable agent queue, YAML scenarios and chaos (reorder, duplicate, drop connection); `pilot.sh simulate`.
- `apps/agent-gateway`: the internet-facing agent endpoint as its own process (TLS 1.3, client certificates), exposing nothing but `/agent/v1/*`.
- Gate defect fixed: `pnpm db:check` had passed vacuously since Phase 0; drift is now proven to fail the gate.
- Pilot defects fixed while proving the deployed pipeline: the agent gateway resolved no secrets in production builds (decorator metadata of a nullable parameter; DI regression test); the admin CLI's catalog sync stripped the integration grants of system roles (scoped sync; regression test); PostgreSQL restarted its processes until the first backup created the pgBackRest stanza (now created at `pilot.sh up`); the reference agent could strand a message held for the reorder chaos (regression test).

## Deviations recorded during Phase 2
- Capabilities are stored as enabled (administrator) and reported (agent); the effective set is their intersection, for active instances only — BUILD_PLAN §6.8 reality notes for 2.1.
- The agent gateway is a separate process instead of API routes; device certificates use ECDSA P-256 (commands stay Ed25519) — ADR-0017 implementation notes.
- FIAS database-sync records feed reconciliation instead of being applied as check-ins; the comparison runs in the guest context and reports back through `INTEGRATIONS_API` — reality notes for 2.4.
- Guest audit entries record changed field names only, never values (the audit log is append-only and could not be anonymized).

## Open items carried into Phase 3
- ~~Retention purge of published outbox rows~~ — done in Sprint 3.4 (`EventRetention`, hourly).
- Pin non-transactional tenant reads to the tenant in the organization and identity contexts as well (the integration and guest contexts already read through `TransactionRunner.read()`).
- Data exports to object storage with expiring links, once the asset registry exists.
- 🟡 Run the agent enrollment runbook (`docs/runbooks/agent-enrollment.md`) on the pilot host with a real hotel network path (outbound 443/8443 only).
- 🟡 Product owner: confirm OpenBao (MPL-2.0) as the secret store, or choose HashiCorp Vault (BSL) after a licence review.
- Carried from Phase 1: pilot installation on the target host, offline unseal keys, backup timers, first manual restore drill; encrypted second pgBackRest repository; disable the Phase 0 test routes in production builds.
