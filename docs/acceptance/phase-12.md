# Phase 12 acceptance — Intelligence: evaluation, releases, twin, insights, Manager assistant, quality

**Date:** 2026-10-05 · **Branch:** `claude/hopeful-archimedes-jskowx` · **CI:** see "Evidence of the run" below

Goal (Spec §37–§43, §80; BUILD_PLAN §10 Phase 12; CLAUDE.md rules 9–12): agent versions are evaluated before they
run and released safely (shadow, canary, rollback); the operational twin answers how the hotel's things are connected,
now and before; deterministic detectors raise explainable insights people act on; the Manager assistant explains what
needs attention from tools only and may consult one specialist; and the quality and cost of the AI are measured by
code and shown to the general manager in English and Arabic. No model call decides a number.

Legend: ✅ verified by automation · 🟡 needs a human.

| # | Criterion (BUILD_PLAN 12.B / 12.E) | Status | Evidence |
|---|---|---|---|
| 1 | Evaluation sets and synthetic cases (platform and hotel), dry-run regression runs with deterministic graders; a candidate version is released only when its latest run passed on every active platform set | ✅ | `evaluation.spec.ts`; `evaluation.integration.spec.ts` (no sets → refused; failing critical case blocks; passing run releases; dry runs create no request and no approval; another hotel sees neither the hotel's set nor its runs). |
| 2 | Shadow runs beside the active version on the same input: reads for real, never acts or replies; the comparison is stored | ✅ | `release.integration.spec.ts` ("SHADOW: v1 answers and acts; v2 runs beside it…": one request only, the shadow's create came back dry, `TOOLS_DIFFER` against the active execution). |
| 3 | Canary: a stable, deterministic share of conversations | ✅ | `release.spec.ts` (bucketing stable, share within tolerance, raising the share only adds); `release.integration.spec.ts` (the conversation's bucket decides, stable while the share holds). |
| 4 | Promote and roll back as audited, append-only releases; published versions stay immutable (rule 9) | ✅ | `release.integration.spec.ts` (ACTIVE switches to v2; rollback reinstates v1 with unchanged content; nothing more to roll back; superseded not releasable; release rows append-only, audit `ai.agent.release` / `ai.agent.rollback`); migration 0050 trigger. |
| 5 | Operational twin built from events, connections over time (rule 10), names looked up at read time, no PII stored | ✅ | `twin.spec.ts`, `twin-projection.spec.ts`; `twin.integration.spec.ts` — the **Spec §80 chain** guest → stay → room → AC unit → failure → work order → engineer → resolution answered by the twin, now and before the room move; reassignment by name; edges cannot be deleted or edited once ended; no guest name in the twin. Deployed: the pilot smoke reads the stay's neighbourhood from the worker's projection. |
| 6 | Deterministic detectors with thresholds in configuration and a confidence formula; one live insight per fingerprint; refresh on re-detection; new evidence only reopens; expiry | ✅ | `insights.spec.ts` (each detector's thresholds, windows, confidence); `insights.integration.spec.ts` — the **Spec §38 example** raised as `RECURRING_ASSET_FAILURE` with its evidence and shared cause; refresh vs. new evidence; same evidence does not reopen; contributed detector expires two days later; a failing contributed detector changes nothing. |
| 7 | Detector registry open to other contexts without the AI context depending on them | ✅ | Housekeeping's `ARRIVAL_RISK_TOMORROW` through `AI_INSIGHT_DETECTORS` (`arrival-risk.integration.spec.ts`: MEDIUM day raises nothing, HIGH arrivals give one insight with ids only). |
| 8 | Acknowledge, resolve, dismiss (reason required), audited, with implicit feedback (Spec §40) | ✅ | `insights.integration.spec.ts` (version conflict, a reader cannot act, dismiss needs a reason, closed insights cannot move, `RECOMMENDATION_ACCEPTED` / `REJECTED` once each, append-only history). |
| 9 | Manager assistant answers "what needs my attention today" from tools only and consults the Engineering Copilot (controlled collaboration, depth 1) | ✅ | `manager.integration.spec.ts` (pulse, insights and one consult; the child execution is the copilot's, for the same person, linked to the parent; the model saw the exact pulse numbers; consult refused from another agent and from a consulted execution). |
| 10 | Cross-property comparison only with a tenant-level grant, never across tenants | ✅ | `manager.integration.spec.ts` (refused as a tool and as a report without `ai.intelligence.cross_property`; allowed with it; another tenant 404). |
| 11 | Quality and cost per agent, version and day by deterministic formulas | ✅ | `quality.spec.ts`; `quality.integration.spec.ts` (a seeded day gives exactly eight metrics; evaluation runs excluded; recomputing gives the same rows). Deployed: the pilot smoke recomputes today and finds the `executions` metric. |
| 12 | Intelligence screens in English and Arabic (RTL) | ✅ | `apps/staff-web/e2e/intelligence.spec.ts` (reasons from the shared `ai.*` keys, acknowledge, dismiss with a reason, the assistant's answer, pulse and quality; Arabic RTL with the severity bar on the start side). Deployed: `/en/intelligence` and `/ar/intelligence` render. |
| 13 | Tenant isolation for every new table | ✅ | RLS on `ai.evaluation_*`, `agent_releases`, `twin_nodes`, `twin_edges`, `signals`, `insights`, `insight_history`, `quality_daily` (migrations 0049–0054); leak checks in `evaluation`, `twin` (RLS query under another tenant), `insights`, `manager` and `quality` integration specs. |
| 14 | AI never writes business tables; only its repositories write `ai` | ✅ | `boundaries.spec.ts` (writers: `repositories.ts`, `evaluation-repositories.ts`, `insight-repositories.ts`, `quality-repositories.ts`, `twin-repositories.ts`). |
| 15 | Real model behaviour on a live provider | 🟡 | Tests use the fake provider and the pilot's on-prem mock; a hotel's Manager-assistant answers should be read by the owner on the pilot with a real model before rollout. |

## Deviations recorded during Phase 12
- Twin kinds add `SERVICE_REQUEST` and `STAFF` (the §80 chain needs them); a room is a `LOCATION` (`room` accepted in
  the URL). Node states are the latest known; `at` applies to connections — 12.3 notes.
- Insight signals live in `ai.signals`, written by the twin's consumer after the twin; the fifth detector is
  contributed by housekeeping through a registry instead of being written in the AI context — 12.4 notes.
- The twin also follows `eng.room_restriction.changed` for the pulse — 12.5 notes.
- Quality days are UTC days, recomputed whole every six hours — 12.6 notes.
- `ai.intelligence.cross_property` is in no default role (a tenant-level grant the hotel group gives explicitly).

## Open items carried forward
- 🟡 Owner: read Manager-assistant answers on the pilot with the hotel's real model (criterion 15).
- Guest names in the twin (read-time, with guest permissions) are left out in v1.
- Phase 13 (voice, IoT, more connectors) is next in order.
- Carried from earlier phases: see `docs/acceptance/phase-11.md` and `docs/acceptance/phase-10.md`.

## Evidence of the run
- GitHub Actions run `37359811730` on `615f7dc` (this acceptance): lint · typecheck · build · test ✅, staff app
  (Flutter) ✅, hotel agent MSI (WiX v5) ✅, pilot deployment smoke with the Phase 12 intelligence checks ✅. The Ubuntu
  one-command install job got no runner within 15 minutes and was cancelled before starting (no code ran); the same
  job passed on the Phase 12 code in run `37356922969` (`c94cde7`), and 615f7dc changed documentation only.
- Run `37356922969` on `c94cde7` (Sprints 12.2–12.5): every job ✅, including the Ubuntu one-command install.
