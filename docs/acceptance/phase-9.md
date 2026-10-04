# Phase 9 acceptance — Inspections, Guest Relations, Lost & Found, Logbook (completes M3)

**Date:** 2026-10-04 · **Branch:** `claude/hopeful-archimedes-jskowx` · **CI:** GitHub Actions workflow `CI` run 37170866952 on `33b33c9` — "lint · typecheck · build · test" and "pilot deployment smoke" green (smoke output: `inspection: {"result":"FAIL","score":50,"findings":[{"severity":"CRITICAL","status":"LINKED"}]}` · `guest relations: OK` · `match: {"score":85,"reasons":["CATEGORY","COLOUR","LOCATION","DATE_CLOSE"]}` · `lost & found: OK` · `handover: {"source":"AI","summary":"ENG: 1 incident, 1 open jobs (1 urgent).",…}` · `logbook: OK` · `guest smoke: OK`)

Goal (Spec §11–§14, §17; BUILD_PLAN §10 Phase 9): one inspection engine serves room checks, kitchen hygiene, pool
safety, fire equipment and patrols: a supervisor runs a published checklist at a location or on an asset, and a
CRITICAL finding opens urgent work for the right department by a deterministic rule. A guest complaint is recorded as
a complaint (not a request), with its evidence; the concierge may only *suggest* one (a candidate with confidence and
the reason), a person confirms it; service recovery that costs money needs an approval. Found and lost items are
logged with the staff's own description, matched with scored reasons that a person confirms, and released through an
audited claim. Each department keeps a shift logbook; an AI-drafted handover summary is reviewed and acknowledged by
the incoming supervisor. ✅ verified by automation · 🟡 needs a human.

| # | Criterion (BUILD_PLAN 9.B / 9.C) | Status | Evidence |
|---|---|---|---|
| 1 | One inspection engine: tenant-wide templates, versioned and immutable once published; an inspection pins its version | ✅ | `inspection.integration.spec.ts` ("writes a checklist as a draft, refuses bad rules, publishes it, and never changes it again", "a new version is drafted and published; running inspections keep the version they started on"); migration 0033 triggers. |
| 2 | Typed answers and photos; deterministic score and PASS/FAIL; findings with severities; CRITICAL ⇒ URGENT work for the template's department | ✅ | `checklist.spec.ts` (`evaluate()`); `inspection.integration.spec.ts` ("answers item by item…", "completes deterministically; a critical finding opens urgent work…"). Deployed: the pilot smoke ("inspections") runs a published room checklist on the guest's room; the failed smoke detector's CRITICAL finding is LINKED to urgent work. |
| 3 | Housekeeping keeps its PASS/FAIL hook and may attach a completed checklist inspection | ✅ | `jobs.integration.spec.ts` (inspection decided by a completed checklist inspection at the job's room); migration 0034. |
| 4 | Complaints are their own context (not requests): categories in English and Arabic, numbered per property, links, append-only evidence and status history | ✅ | `complaints.spec.ts`; `relations.integration.spec.ts` ("sets up categories…", "records a complaint against a stay and a room…"); migration 0035 triggers. Deployed: the smoke records a complaint on the guest's stay. |
| 5 | The concierge only suggests a complaint (candidate with confidence and reason, never below the floor, never twice); a person confirms or dismisses | ✅ | `relations.integration.spec.ts` ("the concierge suggests candidates; a person confirms one into a complaint with its evidence or dismisses it"); GUEST_CONCIERGE v4 with the LOW tool `relations.suggest_complaint`. |
| 6 | Service recovery that costs money needs an approval (HIGH from the property's threshold); rejected/expired recovery is kept | ✅ | `relations.integration.spec.ts` ("service recovery: gestures are done at once, money waits for an approval, rejection is kept"). Deployed: the smoke's discount waits for and gets the group GM's approval. |
| 7 | Lost & Found: the reporter's description never overwritten; AI attributes kept apart; rule matching with reasons, confirmed by a person | ✅ | `items.spec.ts` (`matchScore`); `lostfound.integration.spec.ts` ("an attendant hands in a found phone; the guest's lost report is matched by rules with reasons", "AI attributes from the description are kept apart…"); migration 0036 trigger on `description`. Deployed: the smoke matches a found phone to the guest's report. |
| 8 | Release only against a claim record (who, document type shown, verification); disposal explicit, only after retention, audited | ✅ | `lostfound.integration.spec.ts` ("releases a found item only against a claim…", "an unclaimed item is disposed of only after its retention date…"). Deployed: the smoke hands the phone back against a claim. |
| 9 | Shift logbook per department, append-only (corrections are new entries); shifts from the property's clock | ✅ | `shifts.spec.ts`; `logbook.integration.spec.ts` ("records notes and incidents on the running shift…"); migration 0037 trigger. |
| 10 | AI-drafted handover from facts counted by code; reviewed, edited and acknowledged by the incoming supervisor (not the drafter); acknowledged handovers never change | ✅ | `logbook.integration.spec.ts` ("drafts the handover from facts counted by code…", "the incoming supervisor — not the drafter — acknowledges it…", "without an answer from the assistant the handover is written by hand…"). Deployed: the SHIFT_HANDOVER assistant drafts through the on-prem model stand-in with one READ tool call (execution COMPLETED), the drafter is refused, the group GM acknowledges. |
| 11 | Arrival risk gains a failed inspection today and a recurring failure (Spec §17) | ✅ | `arrival-risk.spec.ts`; `arrival-risk.integration.spec.ts` ("a room that failed its inspection today is a risk…"); `work-orders.integration.spec.ts` (`recentCorrectiveWork`). |
| 12 | Staff UX simple, English and Arabic (RTL) | ✅ / 🟡 | `apps/staff-web/e2e/inspections.spec.ts`, `relations.spec.ts`, `lostfound.spec.ts`, `logbook.spec.ts` (each in English and Arabic). Deployed: the new pages render in both directions. 🟡 Supervisors, guest relations, the desk and attendants at the pilot hotel should use the four screens for a week. |
| 13 | Tenant isolation | ✅ | RLS on every `inspection`, `relations`, `lostfound` and `logbook` table; leak checks in each context's integration spec (404 across tenants, RLS hides rows). |

## Deviations recorded during Phase 9
- Lost & Found AI reads the written description, not photos: the Model Gateway is text-only and sending item photos
  (which may show IDs or faces) to an external provider is a privacy decision for the owner — §10 reality notes for 9.3.
- `lostfound.register` was added so attendants and engineers can hand items in without seeing other items — 9.3 notes.
- Recovery actions have no PROPOSED state: a recovery is done at once or waits for its approval — 9.2 notes.
- A late, older room assignment from the PMS is now kept as closed history instead of being dropped (found by the
  pilot agent smoke; rule 10) — commit `fix(guest)`.
- Tenant-wide definitions (complaint categories, inspection checklists) are also served under the property
  (`/properties/:id/complaint-categories`, `/properties/:id/inspection-templates`) with the read permission checked in
  that hotel: the pilot smoke showed a property GM got 403 on the screens they work in — commit
  `fix(relations,inspection)`.

## Open items carried forward
- 🟡 Owner decision: whether Lost & Found may send item photos to a vision model (and to which provider).
- 🟡 Pilot: publish the hotel's checklists (room, pool, kitchen, fire), complaint categories and recovery threshold,
  retention days, shift times, and the supervisor accounts.
- 🟡 Pilot: the Anthropic and OpenAI API keys go into OpenBao (never in chat) and the tenant routes REASONING_HIGH and
  STRUCTURED_OUTPUT to them; then supervisors try the AI handover and give feedback.
- Guest-facing "I lost something" form, inspection schedules (patrols, recurring checks) and logbook entries scoped
  per department role (Phase 9 v1 lets anyone with `logbook.write` write in any department's log).
- Carried from earlier phases: see `docs/acceptance/phase-8.md`.
