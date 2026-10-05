# Phase 13 acceptance — Voice, IoT/BMS, stay-bound access, POS and ERP connectors

**Date:** 2026-10-05 · **Branch:** `claude/hopeful-archimedes-jskowx` · **CI:** see "Evidence of the run" below

Goal (Spec §44, §55; BUILD_PLAN §10 Phase 13; ADR-0024; CLAUDE.md rules 3, 11, 12, 16, 18, 19): every new kind of
system arrives through the Connector SDK or a channel adapter. Voice is a channel of the Conversation Engine, building
telemetry flows into engineering, room keys and Wi-Fi follow the stay, and POS and ERP feed the core through canonical
events and commands. Core domains are not redesigned. Vendors are owner decisions (Q21–Q26), so every sprint ships a
neutral Planova profile, a simulator face and contract vectors; a vendor adapter later is a connector only.

Legend: ✅ verified by automation · 🟡 needs a human or an owner decision.

| # | Criterion (BUILD_PLAN 13.B / 13.E) | Status | Evidence |
|---|---|---|---|
| 1 | Connector SDK v2 on the agent: one adapter interface, a registry by connector code; an unknown code runs the link alone | ✅ | `ConnectorRegistryTests.cs`; the .NET agent conformance and OPERA e2e suites in `apps/pms-simulator/test` run every OPERA connector through the registry. |
| 2 | Contract vectors for every platform connector: raw message → expected records or refusal | ✅ | `packages/domain/integrations/test-vectors/*.json` (`sim-pms`, `bms-standard`, `pos-standard`, `erp-standard`) checked by `vectors.spec.ts` for every registered adapter. |
| 3 | Signed webhook ingress for cloud-hosted vendor systems: bad signatures and replays are refused, and a repeated message is a duplicate | ✅ | `inbound.integration.spec.ts` (5-minute window, rotate and revoke, idempotent on `source_message_id`). |
| 4 | Telemetry: an unknown point becomes an exception, never a guess; alarms are raised once and cleared with hysteresis; a rule opens a work order | ✅ | `telemetry.spec.ts` (threshold, hysteresis, rate, stuck, missing, minute aggregation); `telemetry.integration.spec.ts`. Simulator: the chiller scenario (`hotella-sim bms`); staff web `e2e/telemetry.spec.ts` in en/ar; pilot smoke telemetry block. |
| 5 | Keys and Wi-Fi only for an in-house stay; check-out and room moves revoke them; the vendor's answer decides the grant; history is append-only; no key material is stored | ✅ | `room-access.integration.spec.ts` (guest); `access.e2e-spec.ts` (a lock agent over the real link); staff web `e2e/keys.spec.ts` in en/ar. |
| 6 | Voice: a call from a room phone of an in-house stay becomes conversation turns answered by the concierge with the same tools. The caller's words are transcribed through the Model Gateway and the answer is spoken back. The audio is never stored. | ✅ | `voice.integration.spec.ts` (AI package): a towels request by voice → `EXTRA_TOWELS` → spoken answer → `VOICE_MINUTES` metered once. `voice-gateway.spec.ts`: signature window, parsing, requests. Simulator: `voice/gateway.spec.ts`. |
| 7 | Voice safety: unknown callers, handed-off conversations and speech the egress policy refuses go to the operator; a hand-off during a call transfers it | ✅ | `voice.integration.spec.ts` (untrusted callers by default, `SPEECH_FAILED` on an external-only AUDIO route, `HANDOFF` and `HANDED_OFF` transfers, forged and repeated deliveries). |
| 8 | POS: closed checks wait for an outlet mapping (never guessed) and are tied to the right stay, by reservation or by room at closing time. Walk-ins stay untied, and the same check counts once. | ✅ | `pos-standard-v1.json`; `spend.integration.spec.ts` (guest); twin projection unit (`POS_CHECK`, `HAS_CHARGE`). |
| 9 | ERP: stock is read by part over the link, a person approves every requisition, it is sent as a command and the ERP's answer settles it; item codes stay external references | ✅ | `erp.e2e-spec.ts` (an ERP agent over the real link: stock rows, unlinked part reported, requisition acknowledged → `integration.requisition.settled`); `requisitions.integration.spec.ts` (approval, no connector → manual purchase, one code per part, rejection, rights). |
| 10 | Tenant isolation for every new table | ✅ | RLS on `integration.inbound_endpoints`, `eng.telemetry_*`, `integration.access_grant*`, `comms.calls`, `guest.stay_charges`, `eng.requisitions` (migrations 0055–0060); leak checks in the inbound, telemetry, room-access, voice, spend and requisitions specs. |
| 11 | Core not redesigned (BUILD_PLAN Phase 13 rule) | ✅ | New capabilities arrive as connectors, a channel adapter, canonical events (`hotel.pos.check_closed`), integration events and ports (`SPEECH_SERVICES`, `ACCESS_API`, `ERP_API`); no core context changed shape. |
| 12 | Real vendor systems (PBX/SIP, BMS protocols, door locks and Wi-Fi, POS, ERP) | 🟡 | Owner decisions Q21, Q24, Q25 and Q26; until then the neutral profiles and simulator faces stand in. |
| 13 | Voice with real telephony and a real on-prem speech model | 🟡 | Tests use the FAKE speech provider and the simulated gateway; the pilot needs a PBX bridge (Q21) and a local speech server (`OPENAI_COMPATIBLE` `/audio/*`). Q22 (external speech) and Q23 (recording) stay at their safe defaults. |
| 14 | Room phones (Q27, decided 2026-10-05): a directory ROOM extension gives room context; the concierge then serves the room only, and sensitive things go to the operator | ✅ | Sprint 13.7 (ADR-0025): `caller-assurance.spec.ts`; `voice.integration.spec.ts` (unknown, external and public extensions → operator; a room call cannot read the guest and the name is not in the model's input). |

## Deviations recorded during Phase 13
- Link protocol 3 (several connectors on one link) was dropped: several connectors on one host are ADR-0020 instances,
  each with its own identity and link (ADR-0024 amendment, 13.1).
- Telemetry reaches engineering through an outbox event (`integration.telemetry_batch.received`), because the agent
  gateway process does not load engineering — 13.2 notes.
- Voice arrives through the comms webhook controller (not the agent link) with the Planova Voice Profile; replies are
  spoken through the normal send loop rather than in the webhook answer, and caller identity uses room phones (Q27)
  instead of phone-number verification, because caller ids can be spoofed — 13.4 notes.
- POS reservation ids are the PMS's; they are resolved across the property's PMS connectors and used only when they
  agree on one stay. A POS bridge must send the check id as the message id — 13.5 notes.
- ERP item codes are external references of parts (`eng.part` ↔ `ERP_ITEM`), not a field on the part (rule 3) — 13.5.

## Open items carried forward
- Owner decisions Q21–Q27 answered on 2026-10-05 (ADR-0025). The owner closed Phase 13 the same day: 13.8 SIP bridge
  (Grandstream), 13.9 BACnet/Modbus bridges and 13.10 VingCard adapter (needs ASSA ABLOY partner access) are future
  development.
- Staff screens for calls, stay spend and requisitions are API-only in v1 (the inbox already shows voice turns).
- Pre-existing: `Promise.all` inside transactions in the integrations context (capability registry, commissioning)
  triggers pg's deprecation warning on concurrent queries of one client; it should become sequential before pg 9.
- Carried from earlier phases: see `docs/acceptance/phase-12.md` and `docs/acceptance/phase-11.md`.

## Evidence of the run
- Local, on `85bd015`: every gate (format, lint, lint self-test, dependency rules, typecheck in 81 tasks, locale parity
  in five languages, `db:check`, OpenAPI snapshot) and the full test suite (78 of 78 tasks, real PostgreSQL and Valkey,
  the .NET agent suites included) pass.
- GitHub Actions on the Phase 13 commits: the runs on `ef37a45` and `42d297f` were cancelled because no runner picked
  up their jobs within 15 minutes (no code ran). The run for this acceptance is recorded here when it finishes.
