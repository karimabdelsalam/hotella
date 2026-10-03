# Phase 4 acceptance — Communications & Guest Identity

**Date:** 2026-10-03 · **Branch:** `claude/hopeful-archimedes-jskowx` · **CI:** GitHub Actions workflow `CI` (jobs "lint · typecheck · build · test" and "pilot deployment smoke")

Goal (Spec §85, BUILD_PLAN §8): a checked-in guest activates without OPERA modification and is later recognized automatically on the verified channel. ✅ verified by automation · 🟡 needs a human.

| # | Criterion (BUILD_PLAN §8.6) | Status | Evidence |
|---|---|---|---|
| 1 | Simulator check-in → activation URL → OTP (fake provider) → grant; a later WhatsApp message from the verified phone resolves guest/stay/room with no questions | ✅ | `activation.integration.spec.ts` "link → phone → WhatsApp code → grant and session…" (`/guest/me` shows stay and room 504, link single use); `messaging.integration.spec.ts` "a message from the verified phone lands in the stay conversation, once…" and the inbox context (guest, stay, room from the guest/organization contexts). Deployed: the pilot smoke checks the simulator's guest in through the agent link and activates them (`smoke-guest.sh`: link → code request → front-desk confirmation → guest session → `/guest/me` room 504). |
| 2 | An unverified phone gets the activation prompt; brute-forcing the OTP locks the session | ✅ | `messaging.integration.spec.ts` "an unverified phone gets its own conversation and the activation prompt — never the stay" (one prompt per day); `activation.integration.spec.ts` "brute force locks the session; the per-phone limit stops floods" (5th wrong code locks, the right code is then refused; 6th session for a phone in an hour refused). |
| 3 | WhatsApp provider error → the same code by SMS, attempt counter continuous; WhatsApp OFFLINE → straight to SMS and one deduplicated alert | ✅ | `activation.integration.spec.ts` "a WhatsApp error moves the same code to SMS…" (remaining attempts carry over), "no receipt within the timeout: the sweep sends the same code by SMS…", "an offline WhatsApp channel sends codes straight to SMS and raises one deduplicated alert"; decision table in `domain.spec.ts` (chain, auto/manual fallback, health). |
| 4 | The same activation flow passes with the channel bound to the Meta Cloud API adapter and to a BSP adapter (contract tests on both) | ✅ | `adapters.spec.ts` (recorded Cloud API payloads: template/text bodies, error mapping, webhook signatures, parsing) for `WHATSAPP_META_CLOUD`, `WHATSAPP_BSP_360DIALOG`, `SMS_HTTP_JSON`; `messaging.integration.spec.ts` runs activation and webhooks through both WhatsApp adapters against a local provider stand-in. |
| 5 | Checkout revokes `SERVICE_REQUEST` and keeps `LOST_FOUND` for the configured window | ✅ | `guest.integration.spec.ts` "guest access follows the stay: pre-arrival, arrival, check-out window, staff revocation" (PMS check-out narrows to the post-stay scopes; sessions keep working for those only; staff revocation ends every session); `domain.spec.ts` access policy; the stay's conversation closes and AI mode stops ("…check-out closes the conversation"). |
| 6 | QR rotation: the old printed token is rejected, the new one accepted; the QR payload is only an opaque token | ✅ | `activation.integration.spec.ts` "room QR: opaque token → room; last name + phone + code → access; rotation invalidates the printed code"; `realtime.integration.spec.ts` "prints a localized, RTL-aware sheet of fresh room codes; earlier codes stop working". |
| 7 | The staff inbox shows guest/stay/room/open work items for the conversation; takeover marks `HANDED_OFF` and stops any auto mode | ✅ | `messaging.integration.spec.ts` "staff inbox: guest, stay, room and open work beside the thread; reply, receipts, takeover, assign" (`comms.handoff.requested.v1`, audited). |

## Staff inbox UI (ADR-0009, Sprint 4.5)
✅ `apps/staff-web`: sign-in (BFF, refresh token only in an httpOnly cookie), the unified inbox with guest/stay/room/open work, reply, take over, close and realtime refresh. Playwright (`apps/staff-web/e2e/inbox.spec.ts`) runs it in English (left-to-right) and Arabic (right-to-left: mirrored layout, translated strings, attribution footer); the pilot smoke checks the deployed portal's pages in both directions, its sign-in against the deployed API and the API proxy. It was missing from the first Phase 4 record and was added before Phase 5 started.

## Also verified
- Security (Spec §66, BUILD_PLAN §8.3): OTP derived with HMAC-SHA256 under a SecretRef key and never stored, 6 digits, 5 minutes, 5 attempts across channels, per-phone and per-IP limits, single use; activation links 256-bit, hashed, single purpose, revocable, replay → 410; guest sessions hashed, re-checked per request; webhook signatures verified over the raw body; no phone, code or token in logs or events.
- Staff-assisted verification with a reason (audited) when no code arrives; arrival sends the link to an already verified WhatsApp number.
- Realtime: staff subscribed to a property and the guest of the stay receive notices (ids only); other properties and stays do not; revoked sessions are disconnected (`realtime.integration.spec.ts`).
- Tenant isolation: 404 across tenants for channels, activation, verification sessions, QR codes and the inbox; RLS on every new table.
- Fixed on the way: concurrent application-role grants raced in PostgreSQL's catalog (CI run 37130913411); grants are now serialized.

## Deviations recorded during Phase 4
- Grants/sessions live in the guest context and follow the stay inside the projector's transaction; activation reacts to internal `guest.stay.status_changed.v1`, not to `hotel.*` events (§8.7).
- `guest.grant.issued|changed|revoked.v1` replace the plan's `guest.activated.v1` (notes for 4.1).
- The OTP is derived from a seed instead of a stored hash (notes for 4.2).
- The realtime gateway runs inside the API process; the QR sheet is printable HTML instead of a server-side PDF (notes for 4.4).

## Open items carried forward
- 🟡 Pilot providers: create the Meta app (or choose the BSP) and the SMS aggregator, approve the `otp` and `activation` templates, put the credentials into OpenBao and register the webhooks (deploy.md step 6); add the `otp_hmac_key` to existing pilot hosts before upgrading (deploy.md, "Upgrade").
- `apps/guest-web` (activation and chat screens for guests) — Phase 5, as ADR-0009 says.
- Inbound media download into the asset registry; staff WhatsApp/SMS notifications (needs staff phone numbers); templated re-engagement outside the 24-hour window; retention purge of processed `comms.inbound_events`.
- Run the realtime gateway as its own deployable (Spec §71) when load requires it; it only depends on Valkey pub/sub.
- Carried from earlier phases: pin non-transactional reads in the organization and identity contexts; object-storage data exports; agent enrollment runbook on the pilot host; product owner confirmation of OpenBao; SMTP for the pilot host.
