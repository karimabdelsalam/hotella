# Spec → Plan Traceability Matrix

**Purpose:** prove that every section of `docs/spec/HOTELLA_MASTER_SPEC.md` (v1.0) is satisfied by a concrete place in `docs/BUILD_PLAN.md` (BP), an ADR, and a phase. A spec requirement without a row here is a planning defect. Keep this file in sync in the same PR as any plan change (Gate C).

Legend: **BP §n** = Build Plan section; **P n** = Phase; **CM n** = `CLAUDE.md` rule n.

| Spec § | Requirement (condensed) | Where satisfied | Phase |
|---|---|---|---|
| 0 | Intelligence is horizontal; no redesign of core for new modules/PMS/AI/channels | BP §1.2 action gate spine, §1.4; ADR-0001 boundaries; BP §10 Phase 13 "no core redesign" | all |
| Identity & Branding | Hierarchy platform → tenant → property → channel; per-property brand profile fields; nothing hardcoded; consistent across channels | BP §5.2 `brand_profiles`, `brand_profile_translations`, scope incl. CHANNEL; §5.3 `GET /public/branding`; CM 15 | P1 |
| Identity & Branding | WhatsApp provider-controlled profile linked to property/channel | BP §8.1 `comms.channels.brand_profile_id`; ADR-0015 | P4 |
| Identity & Branding | `Powered by Planova` → https://planova.com.eg, LTR/RTL, not removable by brand settings | BP §5.2 `platform.attribution_policies` (CHECK: hidden only with an entitlement ref) + `AttributionPolicyService` used by the branding resolver; tests in `branding.spec.ts`, `settings.spec.ts`, `identity.integration.spec.ts`; ADR-0009 footer component; CM 15 | P1 ✔ (1.3), P4/5 UI |
| 1 | Single hotels and groups, multi-tenant/property, module licensing, AI-native, simple staff UX, OPERA 5 first-class without being the model, no OPERA modification, WhatsApp = channel, future channels/devices, provider-independent AI, isolation/audit/explainability, ar+en, future languages | BP §1 synthesis; ADR-0007; BP §10 P11; CM 1, 12, 13, 15, 18, 19, 23; BP §4 i18n | all |
| 2.1 | TypeScript, NestJS, modular monolith, bounded contexts, REST v1, async events, OpenAPI | BP §2 rows 1, 4, 5, 12; ADR-0001/0004/0005/0012 | P0 |
| 2.2 | PostgreSQL; UUIDv7 app-generated; TIMESTAMPTZ UTC; tenant_id/property_id; FKs; JSONB sparingly; version fields; RLS defense-in-depth only | ADR-0002/0003/0007 (+ Phase 1 notes); BP §4 0.2.1–0.2.3; §5.4 RLS → migration 0006 + RLS smoke test in `identity.integration.spec.ts`; CM 1, 2 | P0, P1 ✔ (1.3) |
| 2.3 | Redis for cache, rate limit, coordination, ephemeral state, queues, entitlement cache | ADR-0004; BP §4 0.3.5, 0.3.9; ADR-0011 permission cache | P0 |
| 2.4 | S3-compatible storage; no large binaries in PG | BP §4 0.2.8; ADR-0013 MinIO | P0 |
| 2.5 | Vector abstraction; pgvector first; vector store never source of truth | ADR-0002 pgvector type; BP §10 P6 knowledge module, P8 | P6, P8 |
| 2.6 | .NET on-prem agent: buffering, retries, signed identity, outbound-first, controlled updates, offline licensing grace | BP §10 P10; ADR-0013/0014/0017; platform side and a reference agent built in Sprint 2.3 (`apps/agent-gateway`, `apps/pms-simulator`) | P2 (link), P10 |
| 3 | Bounded contexts list; each owns data; no cross-domain table mutation | BP §3 layout; ADR-0001; CM "Repository shape" | P0 |
| 4.1–4.3 | Tenant, organization, property (incl. enabled languages, timezone, currency) | BP §5.2 `org.tenants/organizations/properties` | P1 |
| 4.4 | Generic location tree; room is a location specialization | BP §5.2 `org.locations` (ltree) + `org.rooms` | P1 |
| 5 | Person ≠ User ≠ Guest; Membership → tenant/property scope → role → permission; granular permissions; AI uses same authz | BP §5.2 `iam.*`, §5.4 action gate, §5.9 Sprint 1.2 (`domain-identity`: `MembershipPermissionResolver`, `IdentityAdminService` anti-escalation, `identity.integration.spec.ts` per-property acceptance); CM 4; BP §10 P6 tools through gate | P1 ✔ (1.2), P6 |
| 6 | Guest, Stay, Reservation Reference, Party Member, Room Assignment History, External Reference, Preference, Access Grant; PMS ids never internal ids; PMS source of truth for stay state | BP §6.1 tables, §6.7 Sprint 2.2 (`domain-guest`: `StayProjector` sole writer, `transition()` state machine, read-only `StaysController` asserted by test, uuid-only id columns asserted by test, external ids via `INTEGRATIONS_API`); preferences/consents 2.4; §8.1 grants; §1.5 source-of-truth rule; CM 3, 10, 19 | P2 ✔ (2.2), P4 |
| 7 | Service definitions independent of UI/channel; fields; versioned | BP §9.1 `catalog.*`, §9.2 | P5 |
| 8, 8.1–8.4 | Work Item, Task, Assignment history, Workflow def/version/instance/transition, SLA policy/instance, Escalation, Approval, Alert; one engine; deterministic SLA with response/resolution/pause/business hours/overrides; generic approvals | BP §7.1–7.4; CM 11 | P3 |
| 9, 9.1–9.3 | Room status ≠ cleaning job; `room_operational_states`; jobs & types; credits by type/room type; DND/MUR/privacy signals with sources | BP §10 P7 | P7 |
| 10.1–10.10 | Asset registry & hierarchy, types/models, documents, work orders & types, failure taxonomy, meters, PM triggers & versioned procedures, parts, warranty, room restrictions via integration | BP §10 P8; `integration.integration_commands` (BP §6.1) | P8 |
| 11 | One inspection engine; templates/versions/sections/items/responses/findings; item types; severities; critical ⇒ urgent work by rules | BP §10 P9 | P9 |
| 12 | Complaint ≠ request; fields; ComplaintCandidate with evidence/confidence; recovery actions; approvals for financial | BP §10 P9 | P9 |
| 13 | L&F items/match candidates/claims; AI metadata never overwrites staff description; staff confirms; audited | BP §10 P9 | P9 |
| 14 | Logbook by property/department/shift; AI shift summary; human acknowledgement | BP §10 P9 | P9 |
| 15 | Alert ≠ notification; alert types; dedup | BP §7.1 `ops.alerts` dedupe_key, §7.4 | P3 |
| 16 | Readiness from configurable dimensions, not boolean | BP §10 P7 arrival readiness v0 | P7 |
| 17 | Arrival-risk from ETA + HK + inspection + ENG + history + VIP, evidence-backed | BP §10 P8; ADR-0014 OWS supplies ETA | P8 |
| 18.1–18.3 | WhatsApp only a channel; adapters → conversation engine → AI → ops; conversation concept; participants; message types; delivery lifecycle; channel identity ≠ authorization | BP §8.1 `comms.*`; CM 18; ADR-0015 | P4 |
| 19.1–19.3 | Check-in → activation token/URL generated by platform; mobile entry; WhatsApp OTP; hashed/short/limited/rate-limited/replay-safe; grant = guest+stay+scopes+validity; no repeated room/name questions | BP §8.2 primary activation, §8.3, §8.6; ADR-0011; ADR-0015 fallback | P4 |
| 20 | Static room QR, platform-owned, no guest data, resolves to room, room+last-name verification, rotatable, no OPERA change | BP §8.1 `room_qr_codes`, §8.2 QR flow, §8.6 | P4 |
| 21 | Passwordless sessions; multi-device; scopes; narrower accompanying scopes; checkout revokes room privileges, post-stay capabilities remain | BP §8.1 grants/sessions, §8.2 checkout (automatic, PMS-driven); ADR-0011 | P4 |
| 22 | Pre-arrival capabilities for expected stays | BP §8.2 pre-arrival; ADR-0014 OWS (reservations) | P4, P10 |
| 23 | AI-first guest UX; duplicate avoidance; conversational slot filling; forms remain | BP §9.2 dedupe in `createServiceRequest`; §10 P6 concierge | P5, P6 |
| 24 | Handoff reasons; unified inbox with guest/stay/room/conversation/AI summary/open work/SLA; AI drafts, human edits recorded | BP §8.1 `inbox_views`, §8.4; §10 P6 drafts + `ai_feedback` | P4, P6 |
| 25 | Notification intent ≠ delivery channel; channels; preferences; critical override | BP §7.1 `ops.notification_*`, §7.2 adapters | P3, P4 |
| 26 | Service vs marketing consent; portal use ≠ marketing consent | BP §6.1 `guest.guest_consents` | P2 |
| 27 | Agent runtime: context, memory, planner, policy, tool registry, model gateway; provider-independent | BP §10 P6 | P6 |
| 28 | Single model gateway; capability-based routing; fallback; cost/latency/policy | BP §10 P6; CM 12 | P6 |
| 29 | Logical agents; agent = prompt+tools+context+memory+routing+autonomy+output contract; immutable versions | BP §10 P6 `agents/agent_versions` | P6 |
| 30 | Versioned prompts; layered composition | BP §10 P6 prompt layering | P6 |
| 31 | Tool registry fields; AI never writes tables; execution through validation/authz/entitlement/workflow/SLA/audit/events | BP §10 P6 tools via action gate; CM 12 | P6 |
| 32 | Risk levels READ…CRITICAL; policy matrix; decision depends on agent/tool/risk/actor/property/context | BP §10 P6 AI policy stage; CM 12 | P6 |
| 33 | Action proposals with args/reason/evidence/risk/expiry/status via approval engine | BP §10 P6 `action_proposals`; §7.1 approvals | P3, P6 |
| 34 | Execution audit fields and step types | BP §10 P6 `executions/execution_steps/model_calls`; CM 12 | P6 |
| 35 | Context engine with per-agent policies; minimum necessary data | BP §10 P6 | P6 |
| 36 | Short-term vs durable memory; candidate → policy → accept/reject/expire; stay facts not permanent prefs | BP §10 P6 `memory_candidates/memories`; `guest_preferences.source/expires_at` (BP §6.1) | P2, P6 |
| 37 | Knowledge sources & scoping; hybrid retrieval; structured live data via tools not RAG | BP §10 P6 knowledge module, P8 engineering manuals; CM 12 | P6, P8 |
| 38 | Evidence & explainability; traceable to document versions | BP §10 P6 (version refs), P12 insights | P6, P12 |
| 39 | Rules/statistics first, LLM only when valuable | BP §10 P7/P8 notes, P13 IoT path; CM 11 | P7+ |
| 40 | Feedback, evaluation sets/cases/runs/results; implicit signals; regression/shadow/canary before publish | BP §10 P6 `feedback`, P12 evaluation & canary | P6, P12 |
| 41 | Cost & quality observability metrics | BP §10 P6 cost/token metrics; ADR-0006 meter; P12 dashboards | P6, P12 |
| 42 | Safety pipeline; retrieved docs untrusted; schema → business → authz validation; classification/redaction; kill switches | BP §10 P6; BP §4 0.3.13 classification registry; CM 12 | P0, P6 |
| 43 | Controlled agent collaboration; no swarms | BP §10 P12 | P12 |
| 44 | Voice, vision, IoT, robots via same engine | BP §10 P13; `ops.task_assignments.assignee_type` includes AI/ROBOT (BP §7.1) | P13 |
| 45 | Core knows canonical concepts; connector adapters → integration platform → normalized events | BP §6.2 pipeline, §6.7 Sprint 2.1 (`IngestService`, `toCanonical`); `contracts-events/hotel-events.ts`; ADR-0014 | P2 ✔ (2.1) |
| 46 | Connector definition vs instance; categories; capabilities | BP §6.1 `connector_definitions/integration_instances`; `contracts-connectors` (`defineConnector`, `CONNECTOR_CAPABILITIES`); catalog synced at boot | P2 ✔ (2.1) |
| 47 | Capability negotiation per instance; AI/UI never offer unsupported actions | BP §6.1 enabled ∩ reported capabilities (`effectiveCapabilities`); per-record capability filter; action-gate connector stage `ConnectorCapabilityStage`; `INTEGRATIONS_API.hasCapability`; §6.3 two-faced simulator | P1, P2 ✔ (2.1) |
| 48 | OPERA 5 on-prem architecture; outbound; no remote shell; signed operations | BP §10 P10; ADR-0013/0014/0017; Sprint 2.3: `apps/agent-gateway` (outbound-only clients, TLS 1.3 + client certificates, no staff routes), predefined manifest commands only, Ed25519-signed command frames verified by the reference agent | P2 ✔ (2.3 gateway), P10 agent |
| 49 | Agent responsibilities; SQLite durable store contents | BP §10 P10; ADR-0017 §4, §6 | P10 |
| 50 | Inbox/outbox, idempotency, source ids, ordering, retries, DLQ, replay, reconciliation, checkpoints; raw ≠ domain event | ADR-0004; BP §6.1 `integration_messages` (unique source id, ordering keys, HELD successors, replay), §6.2; consumers pinned to the event tenant; CM 6 | P0, P2 ✔ (2.1) |
| 51 | Canonical event names; envelope fields; versioning | BP §4 0.3.1 envelope; §6.2 events (`hotel.*` snapshot payloads, `canonical: true` only); BP §0.8 naming | P0, P2 ✔ (2.1) |
| 52 | Mappings; unknown ⇒ exception not guess; AI suggests, human confirms; reconciliation outcomes; source-of-truth policies, no naive LWW | BP §6.1 mappings/exceptions (deduplicated open unknown-code exceptions; required vs optional mapping types; explicit `rooms-by-number` confirmation) — 2.1; reconciliation tables — 2.4; §6.6; CM 16 | P2 |
| 53 | Durable outbound commands with idempotency/lifecycle/ack; AI never calls PMS directly | BP §6.1 `integration_commands`; Sprint 2.3 `INTEGRATIONS_API.requestCommand` (manifest + capability + payload validation, idempotency key), delivery/ack/expiry over the link, audited; §10 P8 room restrictions path | P2 ✔ (2.3), P8 |
| 54 | OPERA independence of activation/QR/OTP/identity/grants | BP §1.5 source-of-truth rule; §8; CM 19 | P4 |
| 55 | POS/ERP/BMS/IoT/PBX/Wi-Fi capability sets; telemetry path | BP §10 P13 | P13 |
| 56 | Connector SDK: manifest, capabilities, config/credential schema, health, mappers, commands; simulators & contract tests | `packages/contracts/connectors` (manifest, `ParseContext`, `InboundRecord`, `RECORD_CAPABILITY`, link frames); `SIM_PMS` adapter; `apps/pms-simulator` (reference agent, FIAS/OWS faces, YAML scenarios, CI chaos); ADR-0005/0008 | P2 ✔ (2.1 SDK, 2.3 simulator) |
| 57 | Integration health states & tracked fields; dedup alerts | BP §6.1 `integration_health` (`HealthService`: rolling error rate, agent last seen + queue depth from heartbeats, deterministic `classifyHealth`, `integration.health.changed.v1` on change); §7.1 alerts | P2 ✔ (2.1/2.3), P3 |
| 58 | Entitlement engine, not plan checks; commercial concepts; billing ≠ entitlement | BP §10 P11; §5.4 stub stage; CM 14 | P1 stub, P11 |
| 59 | Module / AI / connector entitlements; tenant-wide and property grants | BP §10 P11 | P11 |
| 60 | Entitlement ≠ flag ≠ config ≠ permission ≠ connector capability ≠ AI policy; unified action gate order | BP §1.2, §5.4 `ActionGate`; CM 4, 14 | P1 |
| 61 | Usage metrics; idempotent usage events; aggregates | BP §10 P11; ADR-0015 `OTP_SMS_SENT` | P11 |
| 62 | Signed offline license tokens with grace; public-key validation on agent | BP §10 P10/P11; ADR-0017 §6 | P10, P11 |
| 63 | Control plane functions; data plane separation; admins no automatic guest data access | BP §10 P11; §5.2 support grants; ADR-0007 audited bypass role; CM 20 | P1, P11 |
| 64 | Support access explicit/scoped/time-limited/read-only/audited/reason/revocable | BP §5.2 `iam.support_access_grants`, §5.9 Sprint 1.3 (`SupportAccessService`, `SupportAccessAuditInterceptor`, grant-based resolver path); CM 20 | P1 ✔ (1.3) |
| 65 | Security scope; staff password/MFA now, OIDC/SAML later; guest passwordless | ADR-0011 (+ Sprint 1.2 implementation notes: argon2id, TOTP, lockout, rate limits) | P1 ✔ (1.2), P4 |
| 66 | Staff token model; guest activation token properties; OTP properties | ADR-0011 (staff: EdDSA access ≤ 15 min + rotating refresh with reuse detection, live-session check per request); BP §8.3 | P1 ✔ (1.2), P4 |
| 67 | TLS, encryption at rest, field-level encryption, secret manager; no plaintext production secrets; data classifications; AI respects classification | ADR-0010/0013; BP §4 0.3.13; CM 13, 21 | P0, P6 |
| 68 | Audit actor types; who/approved/policy/changed/integration ack/AI involved; append-only tamper-resistant | BP §5.2 `audit.audit_log` → `@hotella/platform-audit` (migration 0004 triggers, `AuditWriter`, redaction by data class); CM 5 | P1 ✔ (1.3) |
| 69 | Consent history, export, correction, retention, anonymization, deletion; integrity preserved; configurable retention | BP §5.2 `platform.retention_policies` → `RetentionPolicyService` (framework ✔ 1.3); §6.1 `guest_data_requests`, §6.6; DoD §12.15; CM 21 | P1 (framework ✔), P2 |
| 70 | Logs/metrics/traces; correlation by correlation_id/trace_id/tenant/property; no PII in logs | ADR-0006; BP §4 0.2.4–0.2.5; CM 17 | P0 |
| 71 | Deployables; isolated worker pools; five queue priorities; guest realtime isolation; stateless | ADR-0004/0013; BP §3 worker mapping; §4 0.3.5 | P0, P1 |
| 72 | Backups, PITR, replicas, restore tests, RPO/RTO, DR; expand/contract migrations | ADR-0013 pgBackRest → `infra/docker/postgres` (WAL archiving, retention, `restore-drill`), `docs/runbooks/backup-restore.md`, CI pilot job (backup + drill); ADR-0002; BP §5.8 | P1 ✔ (1.4) |
| 73 | Config inheritance; audited/versioned critical config; flags ≠ licensing | BP §5.2 `platform.configuration(+history)` → `@hotella/platform-settings` (typed keys, property → tenant → platform → default, history, event, audit); §4 0.3.11 | P0, P1 ✔ (1.3) |
| 74 | Versioned APIs; idempotency keys; signed webhooks with retry/DLQ/replay; rate limiting dimensions | ADR-0012; BP §4 0.3.9; §10 P11 webhooks | P0, P11 |
| 75 | Developer platform later; no untrusted plugins; contract-based extension | BP §10 P11 developer platform v1 | P11 |
| 76 | Module manifest concept | BP §4 0.3.12 `ModuleManifest` (brought forward as enforcement); DoD §12.16; CM 22 | P0 |
| 77 | Repository structure; `/domain` not a blob | BP §3; ADR-0001 (mapping of extra contexts) | P0 |
| 78 | Schema ownership `org.* … audit.*` | BP §0.8 schema list (+ catalog, lostfound, logbook, knowledge, platform); ADR-0002 | P0+ |
| 79.1 | No hardcoded UI strings; `/locales/{en,ar}` namespaces; stable keys | BP §4 0.3.7–0.3.8; CM 7 | P0 |
| 79.2 | No `*_en/*_ar` columns; normalized translation tables | BP §4 0.3.7 `translationColumns()`/`translationUnique()` (`org.location_translations`, `org.room_type_translations`, `org.brand_profile_translations`); every `*_translations` table in §5–§9; CM 7 | P0+ |
| 79.3 | Locale resolution order | BP §4 0.3.7 `LocaleResolver` | P0 |
| 79.4 | True RTL across staff/guest/admin UIs | ADR-0009 logical properties; DoD §12.8; CM 8 | P4+ |
| 79.5 | AI detects/responds in user language; ar/en documents; cross-language retrieval | BP §10 P6 language detection; P8 manuals cross-language | P6, P8 |
| 80 | Operational digital twin/graph over time | BP §10 P12 twin read model | P12 |
| 81 | Intelligence flywheel; no uncontrolled self-modification | BP §10 P6 feedback → P12 evaluation; versions immutable (CM 9) | P6, P12 |
| 82.1–82.34 | Non-negotiable invariants | `CLAUDE.md` rules 1–24 (each invariant maps to at least one rule); DoD §12 | all |
| 83 | Anti-patterns | CM rules; lint rules in BP §4 (boundaries, env, console, uuid); §9.2 single entrypoint for requests | all |
| 84.1–84.20 | Implementation rules (phase-by-phase, pre-phase artefacts, outbox, idempotency, authz first, audit first, i18n first, AI behind tools, deterministic first, observability first, surface tradeoffs, no new infra, ADRs) | BP §0 items 1–8 (gates), §4–§10 structure, ADR index | all |
| 85 | Roadmap Phases 0–13 and their deliverables/acceptance | BP §4–§11 (same phase numbering and deliverables, acceptance criteria restated per phase) | all |
| 86–88 | Definition of smart; final architecture; end state | BP §1 synthesis guides priorities (dedupe, routing, risk detection, evidence, language) | all |

## Known elaborations beyond the spec (not deviations)

| Item | Why | Record |
|---|---|---|
| Extra bounded-context packages/schemas: `catalog`, `inspections`, `relations`, `lostfound`, `logbook`, `knowledge`, `audit`, `platform` | Named as contexts in Spec §3 but absent from the "suggested" §77/§78 lists | ADR-0001 |
| `ModuleManifest` implemented from Phase 0 | Spec §76 describes it as a future concept; using it now enforces DoD mechanically | BP §4 0.3.12 |
| OWS as secondary OPERA interface; optional read-only DB views | FIAS alone cannot serve Spec §17/§22 | ADR-0014 |
| OTP fallback chain beyond WhatsApp | Spec §19.2 defines WhatsApp OTP only; availability requirement from product owner | ADR-0015 |
| On-premises hosting | Spec says "cloud platform" generically; product owner decision | ADR-0013 |
