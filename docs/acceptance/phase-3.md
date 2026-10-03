# Phase 3 acceptance — Operations Engine

**Date:** 2026-10-03 · **Branch:** `claude/hopeful-archimedes-jskowx` · **CI:** GitHub Actions workflow `CI` (jobs "lint · typecheck · build · test" and "pilot deployment smoke"; green in run 37128555604, commit d496c79)

Goal (Spec §85, BUILD_PLAN §7): multiple future modules create work through one engine; SLA deterministic; approvals generic. ✅ verified by automation · 🟡 needs a human.

| # | Criterion (BUILD_PLAN §7.4) | Status | Evidence |
|---|---|---|---|
| 1 | Two different modules create work items and get tasks, SLA and escalation without any module-specific task table | ✅ | `operations.integration.spec.ts`: two test modules register kinds (`TEST_A_JOB` from `testa`, `TEST_B_ORDER`/`TEST_SLA_JOB`/`TEST_NOTIFY` from `testb`) and create work through `OPERATIONS_API` ("two modules create work through one engine…", which also asserts the only task tables are `ops.tasks`, `ops.task_assignments` and `ops.task_events`); both get SLA instances from matching policies ("business hours and policies…", "the clock is met…") and escalation ("missed targets climb the escalation ladder…"). Unknown kinds and foreign references are refused. |
| 2 | SLA with business hours 08:00–20:00 and a pause shifts deadlines correctly (table-driven, DST in `Africa/Cairo`) | ✅ | `domain/sla.spec.ts`: deadlines rolling into and out of the 2026 Cairo summer time, pauses inside and across business hours, closed dates, overnight windows, a New York spring-forward gap; `platform-time` tests for the wall-clock conversion. Integration: a pause for a policy reason stops the clock and the resumed deadline moves; other pause reasons do not ("the clock is met by taking the work on…"). |
| 3 | The same alert condition raised 50 times produces one active alert with `last_seen_at` updated | ✅ | "the same alert condition raised 50 times is one alert…": one row, `occurrences` 50, severity only goes up, evidence refreshed, a single `ops.alert.raised.v1`; acknowledged alerts still deduplicate; after resolution the condition opens a new alert. Partial unique index + `ON CONFLICT` make it race-free. |
| 4 | Approval of a HIGH-risk subject is required before the subject's handler runs; expiry closes it | ✅ | "drives the work: tasks, a HIGH-risk approval whose handler runs only once approved…" (handler not run while pending, runs exactly once on approval in the deciding transaction, second decision 409); "a rejected request never runs its handler; four eyes…" (requester cannot decide, rejection runs nothing); "an undecided request expires, closes and moves the workflow on" (`ApprovalService.expireDue`, then 409). Unit rules: only people decide, AI agents cannot request CRITICAL actions. |
| 5 | Assignment history is complete after assign → reassign → unassign | ✅ | "keeps the complete assignment history through assign → reassign → unassign": two closed assignments with end reasons (REASSIGNED, UNASSIGNED) and the reassignment reason, four task-history entries, two audited assignments. Task history is append-only at the database level. |

## Also verified
- Task lifecycle: the full transition table as a unit test; department queues with claiming; supervisors acting on behalf (audited); optimistic versions; tenant isolation (404 across tenants, RLS inside tenant transactions).
- Workflows: versions validated against registered guards/actions, published once and frozen by a trigger; a running workflow holds its work item in progress; staff actions (`MANUAL:<ACTION>`).
- Notifications: escalations reach the roles on duty in-app and by e-mail in the recipient's language, assignments reach the assignee, preferences switch channels off, critical policy overrides them, failed e-mails retry without storing personal data in the error.
- Delivered-event retention (`EventRetention`), the Phase 2 open item.
- The worker composes the full engine (`OrganizationCoreModule`, `IdentityDirectoryModule`) and arms the SLA sweep, approval expiry, e-mail delivery and retention schedules: `apps/worker/test/composition.e2e-spec.ts` boots the real `WorkerAppModule` (it caught a missing i18n module before the pilot did), and the pilot smoke runs it.
- Phase 2 hardening from the deployed pipeline: out-of-order stay facts are retried instead of dropped (guest suite), the pgBackRest stanza exists from the first start, the reference agent no longer strands a reordered message.

## Deviations recorded during Phase 3
- Timers are a 15-second sweep over an indexed next-check time instead of one delayed job per deadline (BUILD_PLAN §7.7, notes for 3.2).
- Alerts were built in 3.2 with the SLA engine; `REJECTED` is not a task status (rejection hands the task back); departments live in the organization context; SLA policies and workflows are property-scoped; notification preferences are keyed by user (notes for 3.1–3.4).

## Open items carried forward
- Department membership of staff (who may claim a department's queue) and `DEPARTMENT` notification recipients — with the staff app (Phase 5) if hotels need it.
- Anonymizing a guest must also clear free-text work titles that quote them — when the first guest-facing source of work exists (service requests, Phase 5).
- Workflows reacting to SLA breaches; tenant-wide SLA/workflow defaults for multi-property chains.
- 🟡 Configure SMTP for the pilot host (deploy.md step 5) so escalations also reach staff by e-mail.
- Carried from Phase 2: pin non-transactional reads in the organization and identity contexts; object-storage data exports; run the agent enrollment runbook on the pilot host; product owner confirmation of OpenBao.
