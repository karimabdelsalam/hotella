# OPERA integration acceptance — standard, reusable OPERA architecture (ADR-0019, BUILD_PLAN 10.D)

**Date:** 2026-10-04 · **Branch:** `claude/hopeful-archimedes-jskowx` · **CI:** CI_EVIDENCE

Goal (ADR-0019; OPERA Integration Guide; BUILD_PLAN §10 Sprints 10.6–10.9): any OPERA 5 hotel is connected by the same
standard architecture. The read-only OPERA database, IFC8/FIAS with the Planova Standard Profile and optional OWS sit
behind one Unified OPERA Adapter (`PMS_API`). A per-property capability registry decides what may be done and through
which connector. The database is never written. The hotel is compared with the standard at commissioning, never the
other way round. At the pilot only the hotel's values change. Proven end to end against the simulator's OPERA-shaped
database fixture, byte-level IFC8 face and OWS SOAP face, with the production .NET agent.
✅ verified by automation · 🟡 needs a human or the pilot hotel.

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | One adapter for modules: business operations routed per property, never a write to the database, writes never silently retried elsewhere, reads fall through | ✅ | `capabilities.spec.ts` (routing, overrides, "never a DB write"); `capabilities.integration.spec.ts` (hotels A/B/C run the same write through their own connector); `PMS_API` reads in `queries.e2e-spec.ts`, `opera5-db.e2e-spec.ts`, `opera5-ows.e2e-spec.ts`. |
| 2 | Effective capability = supported ∧ enabled ∧ reported ∧ licensed ∧ verified ∧ not unavailable; writes always need verification, everything after sign-off | ✅ | `ineffectiveReasons` unit tests; `capabilities.integration.spec.ts` ("offers no PMS write before it is verified", "after the sign-off every capability must be verified"); `opera5-ows.e2e-spec.ts` (contact write `UNAVAILABLE` until verified). |
| 3 | Predefined signed reads over link protocol 2; protocol-1 agents unaffected; rows validated, answers kept only until taken | ✅ | `link.ts` contract tests; `queries.e2e-spec.ts`; `link.e2e-spec.ts` (protocol 1); `LinkClient` query handling in the .NET agent. |
| 4 | `OPERA5_DB` cannot write: no write statement exists, read-only transactions, a writable account is refused | ✅ | `OperaDbTests.cs` (statement allow-list, privilege check incl. DBA role and grants outside the contract); `opera5-db.e2e-spec.ts` ("refuses every read once the account can write"); manifest `readOnly` (definition error for any write). |
| 5 | Planova Standard FIAS Profile v1 is one definition shared by agent and platform; gaps are reported, never guessed | ✅ | `profiles.spec.ts` + `FiasTests` (shared vector `fias-profile-v1.json`); `opera5-fias.e2e-spec.ts` (coverage with a withheld field); `domain.spec.ts` (observe, NS/NE). |
| 6 | FIAS behaviour rules: nothing sent during a database swap; a swap after a long outage; optional records only when enabled | ✅ | `FiasTests` ("Nothing_is_sent_during_a_database_swap_and_a_long_outage_asks_for_one", vector test). |
| 7 | OWS standard connector v1: standard reads; additive contact write, read before write, applied once; reservation writes not offered until verified | ✅ | `OwsTests`; `opera5-ows.e2e-spec.ts` (reads through `PMS_API`, write once, `NOT_LINKED`); `domain.spec.ts` (no `RESERVATION_WRITE`). |
| 8 | Connectors of one OPERA are one PMS: a reservation seen by OWS is the stay FIAS checks in; a DB snapshot is compared with stays made through FIAS/OWS | ✅ | `capabilities.integration.spec.ts` (family namespace); `opera-commissioning.e2e-spec.ts` (two reservations → two stays across OWS and FIAS; reconciliation from the DB: MATCH). |
| 9 | Commissioning: Interface Sheet as append-only statements, verification runs with counts and reasons only, capability sign-off with evidence, audited | ✅ | `capabilities.integration.spec.ts` (sheet history, update refused by the database, a run without an agent); `CommissioningService` audit records; Playwright `control.spec.ts` (installer flow, English and Arabic). |
| 10 | The pilot readiness checklist (guide §20) is executable: hotel B goes from nothing to `ready` through the API alone | ✅ | `opera-commissioning.e2e-spec.ts` (three .NET agents; sheet → runs → verification → sign-off → reconciliation → `ready`); `commissioning.spec.ts` (hotels A, B and C, reasons item by item). |
| 11 | Tenant isolation | ✅ | RLS on `profile_observations`, `commissioning_sheet_rows`, `commissioning_runs`, `integration_queries` and the registry tables (migrations 0041–0044); 404 across tenants and properties in `capabilities.integration.spec.ts`. |
| 12 | The real hotel | 🟡 | At the pilot: IFC8 Interface Sheet and licence, OWS licence/version/entities (if any), the DBA's `HOTELLA_RO` account from the grant script, then the commissioning tab until `ready`, and a week of live traffic with daily reconciliation. Items marked "to verify" in guide §21 are checked there. |

## Deviations recorded during 10.6–10.9
- *Enabled* stays the instance's capability list and status is computed on demand; no separate enable route or status
  table (10.6 notes).
- No page token in `query_result`: at most 2 000 rows with `truncated` (10.7 notes).
- Profile gaps are a commissioning view, not part of the agent's health (10.8 notes).
- `RESERVATION_WRITE` through OWS (`ModifyBooking`) is not offered until its OWS 5.1 behaviour is verified; room status
  and restrictions through OWS likewise (10.8 notes, guide §21).
- One id namespace per connector family (ADR-0019 amendment, 10.9 notes).

## Open items carried forward
- Pilot-specific: the hotel's Interface Sheet, IFC8 licence, OWS details, DBA account, agent host (guide §20).
- Guide §21 "to verify" items against Oracle's licensed documentation (the design environment could not reach
  docs.oracle.com).
- `Oracle.ManagedDataAccess.Core` is redistributed unmodified under the Oracle Free Use Terms and Conditions — the owner
  confirms.
- `PMS_API.updateProfileContact` has no caller yet; wiring the guest app's contact change to it is a product decision.
