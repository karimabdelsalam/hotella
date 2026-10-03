# Phase 6 acceptance — AI Foundation (closes M2)

**Date:** 2026-10-03 · **Branch:** `claude/hopeful-archimedes-jskowx` · **CI:** GitHub Actions workflow `CI` run 37146210044 on `1681425` — "lint · typecheck · build · test" and "pilot deployment smoke" green (smoke output: `M2 concierge: OK`, execution `COMPLETED` with 360 tokens)

Goal (Spec §85, BUILD_PLAN §10): the same guest flow in natural language. A guest writes "الجو حر أوي هنا"; the Guest
Concierge finds the stay and room, sees no open AC request, creates `AC_PROBLEM`, the work goes to Engineering, and the
guest is answered in Arabic. HIGH-risk tools become approval proposals, CRITICAL ones are refused, every execution is
fully recorded, and no AI code path writes a business table outside a tool handler.
**M2 — "The same flow in natural language"** (BUILD_PLAN §1.5). ✅ verified by automation · 🟡 needs a human.

| # | Criterion (BUILD_PLAN §10, 6.5) | Status | Evidence |
|---|---|---|---|
| 1 | "الجو حر أوي هنا" end to end: services looked up, `AC_PROBLEM` created (or related), Engineering gets the work, the guest is answered in Arabic | ✅ | `m2.integration.spec.ts` drives the worker path (the `comms.message.received` envelope's correlation id → `ConciergeRuntime`) with the scripted `FAKE` model: `catalog.list_services` → `operations.create_service_request` → Arabic reply through `communication.send_message`; work item `ENG`, priority `HIGH`; `concierge.integration.spec.ts` covers the reply language rule, the step budget, model and kill-switch hand-offs and ASSIST drafts. Deployed: the pilot smoke ("M2 concierge") runs the concierge in the worker through the real `OPENAI_COMPATIBLE` adapter against a stand-in model; the guest web shows the Arabic answer, `AC_PROBLEM` exists and was created by the `AI_AGENT`. |
| 2 | HIGH-risk proposal → approval → execution | ✅ | `m2.integration.spec.ts`: a cancellation becomes an `AI_ACTION` approval requested by the AI actor; nothing changes until a person approves; approving runs the call as proposed (request `CANCELLED`, proposal `EXECUTED`, audit actor = the execution). `tools.integration.spec.ts`: rejection closes the proposal, four-eyes and human-only decisions come from the approval engine. |
| 3 | CRITICAL refused | ✅ | `policy.spec.ts`, `scope.spec.ts` (the gate's AI policy stage refuses CRITICAL even when approved), `tools.integration.spec.ts` (a CRITICAL tool is refused by policy); the approval engine refuses AI requests for CRITICAL approvals (Phase 3). |
| 4 | Every execution fully recorded | ✅ | `ai.executions` + append-only `ai.execution_steps` (CONTEXT, MODEL_CALL, TOOL_CALL, DECISION, RESPONSE, APPROVAL; codes and decisions only, never guest text), `ai.model_calls` (provider, model, tokens, latency, cost, fallback, outcome), proposals and feedback, readable at `GET /properties/:id/ai/executions[/:id]` (`ai.execution.read`); totals summed on close. Asserted step by step in `m2.integration.spec.ts` and `concierge.integration.spec.ts`; deployed: the smoke reads the execution (`COMPLETED`, tokens). |
| 5 | No AI code path writes a business table | ✅ | `boundaries.spec.ts`: the AI package imports other contexts only through their `public` entry, declares only the `ai` schema, and only its repositories write; ESLint `no-restricted-imports` and dependency-cruiser enforce the same. Every business change goes through a tool handler → public API → ActionGate as `AI_AGENT` (authorized only for its tools' permissions, in its tenant and property, inside a cleared tool call); outside a tool call an AI actor is refused (`tools.integration.spec.ts`). |
| 6 | Providers, data egress and budgets per ADR-0018 | ✅ (Q8 answered) | `gateway.integration.spec.ts`: on-prem by default, external providers only with the platform allow-list, the tenant opt-in and budget; data-class filter, identifier masking, RESTRICTED never sent; fallback and kill switches. Which external providers and budgets to allow is the product owner's decision (Q8). |

## Also verified
- Agents and prompts are versioned and immutable once published (trigger); the Guest Concierge is now at v2 (adds `knowledge.search`), v1 kept as history.
- Knowledge v1: scoped documents (property or tenant, audience, classification, effective dates, language), immutable published versions, Arabic-aware keyword search (diacritics, letter forms, digits, definite article) fused with pgvector similarity; passages carry document version references; the guest tool sees only PUBLIC guest-audience documents and returns excerpts as reference data (`knowledge.integration.spec.ts`, `text.spec.ts`).
- ASSIST mode: drafts for staff in the inbox (`comms.reply_drafts`), the edit distance of what staff actually sent recorded as `ai.feedback`; staff choose the AI mode per conversation; takeover and hand-off stop the AI (`concierge.integration.spec.ts`, `apps/staff-web/e2e/inbox.spec.ts` in English and Arabic).
- Tenant isolation: RLS on every new table (`ai.executions`, steps, proposals, feedback, `comms.reply_drafts`, all `knowledge` tables) with leak checks in the integration specs.
- Fixed on the way: the pilot smoke routes the stand-in model as the platform default (`PUT /ai/routing-rules/platform`
  by the platform administrator): a GM whose membership is property-scoped cannot change tenant-wide routing
  (`ai.routing.manage` is checked tenant-wide), which is the intended permission model. Plain queue jobs (SLA sweep, approval expiry, notification delivery, heartbeat) were never run by the worker; the guest chat crashed on browsers whose `scrollIntoView` returns a promise.

## Deviations recorded during Phase 6
- Tools v1 handlers live in the AI context over the owning contexts' public APIs; later tools are registered by their owning context through `AI_TOOL_REGISTRY` (knowledge does so) — §10 reality notes for 6.2 and 6.4.
- An approved AI proposal runs as the AI actor with the approval reference, not as the approving person (the approver is recorded on the approval) — §10 notes for 6.2.
- Agents and prompts are platform definitions in code, published on first use; tenant prompt layers and an agent admin screen come later — §10 notes for 6.3.
- Exact vector search over scoped candidates instead of an HNSW index until the embedding model (and dimension) is chosen — §6.D.

## Open items carried forward
- ✅ **Q8 / ADR-0018** answered on 2026-10-03: Anthropic and OpenAI allowed, 100 USD per hotel per month (now the
  default budget, enforced per property). 🟡 Pilot: create the two provider rows with their API keys in OpenBao, allow
  them on the platform and switch the tenant's opt-in on.
- 🟡 Pilot: route `REASONING_HIGH` and `EMBEDDING` to the chosen models and set `comms.ai_mode.default` per property (OFF by default).
- Agent and prompt administration, tenant prompt layers, evaluation sets and canary publishing (Phase 12); durable guest memory; AI conversation summaries in the inbox; HNSW index per embedding model.
- Carried from earlier phases: see `docs/acceptance/phase-5.md`.
