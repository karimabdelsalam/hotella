# Phase 8 acceptance — Engineering / CMMS (completes M3 with Phase 7)

**Date:** 2026-10-03 · **Branch:** `claude/hopeful-archimedes-jskowx` · **CI:** GitHub Actions workflow `CI` run RUN_ID on `c369db9` — "lint · typecheck · build · test" and "pilot deployment smoke" green (smoke output: SMOKE_OUTPUT)

Goal (Spec §10; BUILD_PLAN §10 Phase 8): engineering works on real equipment. An AC complaint in a room becomes a
CORRECTIVE work order on the room's fan-coil unit with symptom, diagnosis, failure mode, cause, resolution and
downtime kept as structured history; preventive maintenance comes due by calendar or meter and creates work from a
versioned procedure; a room that cannot be sold is restricted and the PMS hears it when the connector allows;
engineering knowledge answers the engineer's question for that exact asset; warranty rules flag a vendor case. Open
engineering work keeps the room from being ready. ✅ verified by automation · 🟡 needs a human.

| # | Criterion (BUILD_PLAN 8.B / 8.C) | Status | Evidence |
|---|---|---|---|
| 1 | Asset registry: types with controlled properties (translated), models, hierarchy, location, criticality, warranty | ✅ | `engineering.integration.spec.ts` ("defines equipment types…", "registers equipment at a room with its parts…"); `properties.spec.ts` (controlled schema, compatible type changes only). |
| 2 | Failure taxonomy as four controlled lists (starter set in English and Arabic + the hotel's own) | ✅ | `engineering.integration.spec.ts` ("imports the failure taxonomy once…"). |
| 3 | Work orders on the operations engine; a guest request becomes corrective work on the room's unit; the same work closes both | ✅ | `work-orders.integration.spec.ts` ("opens corrective work…", "takes over a guest request…"). Deployed: the pilot smoke ("engineering") turns the guest's AC_PROBLEM from M2 into a CORRECTIVE order (source GUEST_REQUEST) on the unit of their room. |
| 4 | Closing CORRECTIVE/EMERGENCY work needs symptom, failure mode, cause and resolution; downtime computed, never estimated | ✅ | `work-orders.spec.ts`, `work-orders.integration.spec.ts` (422 `coding_missing`, 90 minutes of downtime, `eng.work_order.closed.v1` with the codes). Deployed: the smoke codes and closes the order. |
| 5 | Parts usage and stock; warranty suggestion for equipment under warranty | ✅ | `work-orders.integration.spec.ts` ("parts come off the shelf…", warranty SUGGESTED → OPENED). |
| 6 | Meters (append-only, cumulative never backwards), versioned PM procedures (immutable once published), calendar/meter/condition plans opening preventive work once | ✅ | `pm.spec.ts`; `maintenance.integration.spec.ts` (readings, procedure versions, calendar plan pinned to the published version, meter and condition plans). |
| 7 | Room restrictions with history; readiness blocked; the PMS told only when the connector may write | ✅ | `maintenance.integration.spec.ts` ("takes a room out of order, tells the PMS when it may…"); `readiness.integration.spec.ts` (NO_OOO and ENGINEERING dimensions). |
| 8 | Engineering knowledge for the exact asset (manuals of the asset and its model first) | ✅ | `copilot.integration.spec.ts` ("searches the asset's own manuals first, then the hotel's staff documents"); `knowledge.integration.spec.ts` (search restricted to named documents, still within scope). |
| 9 | Engineering Copilot v1 (ASSIST): reads only, cites its sources, answers in the engineer's language, every run recorded | ✅ | `staff-assistant.integration.spec.ts` (READ tools only, a tool outside the agent refused, sources with versions, Arabic question → Arabic answer, kill switch, model failure, execution with trigger STAFF for the engineer); `copilot.integration.spec.ts` (tools and the endpoint, both read permissions required). Deployed: the copilot answers about the unit through the OPENAI_COMPATIBLE adapter with one READ tool call, execution COMPLETED. |
| 10 | Arrival risk v1: deterministic score with reasons; AI never computes it | ✅ | `arrival-risk.spec.ts` (points, levels, cap, VIP only raising a real problem); `arrival-risk.integration.spec.ts` (riskiest first, tomorrow, permission, tenant isolation). Deployed: the smoke reads tomorrow's arrival risk. |
| 11 | Staff UX simple, English and Arabic (RTL) | ✅ / 🟡 | `apps/staff-web/e2e/engineering.spec.ts` (code and close a work order, history, the copilot labelled as an AI suggestion with its sources; Arabic read-only view), `arrivals.spec.ts` (English and Arabic, risk bar on the start side). 🟡 Engineers and the front desk at the pilot hotel should use both screens on real equipment and arrivals. |
| 12 | Tenant isolation | ✅ | RLS on every `eng` table; leak checks in `engineering`, `work-orders`, `maintenance`, `copilot` and `arrival-risk` integration specs (404 across tenants, RLS hides rows). |

## Deviations recorded during Phase 8
- Room restrictions use the existing `OOO_WRITE` capability instead of a new `ROOM_RESTRICTION_WRITE` — §10 reality
  notes for 8.3.
- Arrival risk lives in housekeeping (owner of readiness) and its "explanation" is the ordered, translated reason
  codes; no model phrases it in v1 — §10 reality notes for 8.4.
- The identifier masking for external providers keeps record UUIDs and ISO dates (they were being masked as phone
  numbers, which would have broken any agent's tool calls with Claude or ChatGPT) — §10 reality notes for 8.4.

## Open items carried forward
- 🟡 Pilot: import the hotel's equipment (types, models, assets per room and plant room), upload manuals to Knowledge
  and link them, set up the failure codes the engineers use, PM plans for the critical equipment, and the ENGINEER /
  CHIEF_ENGINEER accounts.
- 🟡 Pilot: the Anthropic and OpenAI API keys go into OpenBao (never in chat) and the tenant routes REASONING_HIGH to
  them; then engineers try the copilot on real faults and give feedback.
- Purchasing and ERP adapters for parts (Spec §10.8), IoT/BMS meter readings through the integration layer
  (Phase 13).
- Carried from earlier phases: see `docs/acceptance/phase-7.md`.
