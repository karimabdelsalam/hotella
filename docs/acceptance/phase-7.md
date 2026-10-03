# Phase 7 acceptance — Housekeeping (part of M3)

**Date:** 2026-10-03 · **Branch:** `claude/hopeful-archimedes-jskowx` · **CI:** GitHub Actions workflow `CI` run 37146210044 on `1681425` — "lint · typecheck · build · test" and "pilot deployment smoke" green (smoke output: `checkout clean: {"cleaningType":"CHECKOUT","credits":1,"status":"OPEN"}`, `room 506 after its clean: CLEAN ready=true`, `housekeeping: OK`)

Goal (Spec §9, §16; BUILD_PLAN §10 Phase 7): a check-out reported by the PMS makes the room dirty and creates the
CHECKOUT clean with its credits for Housekeeping; attendants work their rooms, DND and make-up-room signals shape the
day, a supervisor inspects where the property requires it, the room becomes ready on the property's own readiness
dimensions, and the PMS hears the new room status when the connector allows it. The supervisor gets a balanced
assignment proposal, never an automatic re-assignment. ✅ verified by automation · 🟡 needs a human.

| # | Criterion (BUILD_PLAN 7.B / 7.C) | Status | Evidence |
|---|---|---|---|
| 1 | Room status ≠ cleaning job; the PMS owns occupancy and front-office status; every change has history | ✅ | `housekeeping.integration.spec.ts`: check-in, check-out (dirty), room status, room move and late events against `hk.room_states` with append-only `hk.room_state_events` (cause, actor, job); the trigger refuses rewriting history. |
| 2 | Check-out → CHECKOUT job with credits for Housekeeping, once | ✅ | `jobs.integration.spec.ts`: the same check-out delivered three times makes one job (credits 1.0, `HK_JOB` work item for HK at the room, `hk.job.created.v1` once). Deployed: the pilot smoke ("housekeeping") finds the simulator's check-out clean for room 506 and finishes it. |
| 3 | Jobs follow their work; inspection when required; failed inspection → touch-up | ✅ | `jobs.integration.spec.ts`: start → CLEANING, done → CLEAN (or INSPECTING with `hk.inspection.required`); FAIL → DIRTY + HIGH TOUCH_UP (0.3); PASS → INSPECTED; append-only `hk.inspections`. Deployed: the room becomes CLEAN after the GM completes the task. |
| 4 | Credits deterministic, by type and room type, copied onto the job | ✅ | `jobs.spec.ts` (resolution order), `jobs.integration.spec.ts` (property rule replaces, staff job takes it, later changes do not rewrite jobs). |
| 5 | Daily generation: STAYOVER once per day after the property hour; ARRIVAL checks when asked | ✅ | `jobs.integration.spec.ts` (05:00 nothing, 10:00 once, again nothing), `readiness.integration.spec.ts` (ARRIVAL only with `hk.arrival.clean`, idempotent). |
| 6 | DND / make-up-room from staff, the guest web and the concierge; history kept | ✅ | `housekeeping.integration.spec.ts`, `readiness.integration.spec.ts` (concierge tool for the guest's own room only; make-up-room jobs listed first), `apps/guest-web/e2e/guest.spec.ts` (toggles, English and Arabic). |
| 7 | Readiness from configurable dimensions, not a boolean (Spec §16) | ✅ | `readiness.spec.ts`; `readiness.integration.spec.ts`: dirty → not ready (NOT_CLEAN); cleaned → ready + `hk.room.ready.v1`; open engineering work at the room → not ready; closed → ready again; INSPECTION dimension when configured. Deployed: room 506 is ready after its clean. |
| 8 | PMS write-back only when allowed | ✅ | `jobs.integration.spec.ts`: one `SET_ROOM_STATUS` per job outcome to the ACTIVE instance with `ROOM_STATUS_WRITE`; nothing without it. `SIM_PMS` declares the command; OPERA writes stay off until verified at the pilot (Phase 10). |
| 9 | Balanced assignment proposal; a person applies it | ✅ | `balancer.spec.ts` (floors kept together, split when too big, by credits, deterministic); `readiness.integration.spec.ts` (proposal, all-or-nothing apply through the task engine, ineligible attendant refused); `apps/staff-web/e2e/housekeeping.spec.ts`. |
| 10 | Staff UX simple, English and Arabic (RTL) | ✅ / 🟡 | `apps/staff-web/e2e/housekeeping.spec.ts`: one-tap start/done for attendants, supervisor inspection and planning, board mirrored in Arabic. 🟡 A housekeeping supervisor at the pilot hotel should try the day plan on a real floor list. |
| 11 | Tenant isolation | ✅ | RLS on every `hk` table; leak checks in `housekeeping.integration.spec.ts` and `jobs.integration.spec.ts` (404 across tenants, RLS hides rows). |

## Deviations recorded during Phase 7
- Make-up-room orders the job list instead of raising the work item's priority (the operations engine fixes priority
  and SLA policy at creation) — §10 reality notes for 7.3.
- PMS write-back checks the instance's effective capabilities through `INTEGRATIONS_API` (a system follow-up of a
  person's action) rather than the gate's connector stage — §10 reality notes for 7.2.
- A property without a Housekeeping department gets unrouted cleaning work instead of a failing consumer — §10
  reality notes for 7.4.

## Open items carried forward
- 🟡 Pilot: create the HK department, room attendants (ROOM_ATTENDANT) and a supervisor (HK_SUPERVISOR); set
  `hk.inspection.required`, `hk.stayover.hour`, `hk.readiness.dimensions` per property; floor labels on rooms.
- Room status write-back to OPERA (`ROOM_STATUS_WRITE`) after verification at the pilot (Phase 10).
- The generic inspection engine replaces the minimal PASS/FAIL hook (Phase 9); engineering work orders feed the
  ENGINEERING readiness dimension through the same work-item lookup (Phase 8).
- Carried from earlier phases: see `docs/acceptance/phase-6.md`.
