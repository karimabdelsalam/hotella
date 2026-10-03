# Phase 5 acceptance — Guest Service Catalog (closes M1)

**Date:** 2026-10-03 · **Branch:** `claude/hopeful-archimedes-jskowx` · **CI:** GitHub Actions workflow `CI` (jobs "lint · typecheck · build · test" and "pilot deployment smoke")

Goal (Spec §85, BUILD_PLAN §9): a verified guest opens the property's localized catalog, requests a service, the right
department gets the work with its SLA, and the guest is told on their verified channel when it is done.
**M1 — "Guest activates and gets served, driven by PMS data, without a live OPERA link yet"** (BUILD_PLAN §1.5).
✅ verified by automation · 🟡 needs a human.

| # | Criterion (BUILD_PLAN §9.4) | Status | Evidence |
|---|---|---|---|
| 1 | Simulator check-in → activation | ✅ | `m1.integration.spec.ts` "the PMS checks the guest in…" (OWS reservation + FIAS `GI` through the simulator connector → canonical `hotel.*` events → stay projector → `IN_HOUSE`) and "front desk sends the link; the guest activates with the WhatsApp code". Deployed: the pilot smoke checks SIM-C2 in through the agent link and activates the guest through the guest web app's BFF (`smoke-guest.sh`). |
| 2 | Request EXTRA_TOWELS from the guest web API in Arabic | ✅ | `m1.integration.spec.ts` (`POST /guest/requests`, `Accept-Language: ar`); deployed: the smoke asks through the guest web's same-origin proxy with the session cookie; `apps/guest-web/e2e/guest.spec.ts` drives the form in English and Arabic. |
| 3 | The task appears for Housekeeping with SLA | ✅ | `m1.integration.spec.ts` (work item `SERVICE_REQUEST`, department `HK`, SLA instance from the policy matching the service code); `requests.integration.spec.ts` (task in the HK queue, work title is a key with service and room, never the guest's words); deployed: the smoke reads the work item (`HK`, `EXTRA_TOWELS`). |
| 4 | Staff completes → the guest receives a localized notification (fake WhatsApp provider) | ✅ | `m1.integration.spec.ts`: accept/start/complete → the worker step follows the work item → the outbound job sends the `service_update` template to the verified number with Arabic parameters (`مناشف إضافية`, `في الطريق إليك` / `تم`), and the guest web thread shows `تم: مناشف إضافية…`; `notifications.integration.spec.ts`: text inside the 24-hour window, guest web only without a verified number, no notice for a guest's own cancellation. Deployed: the smoke waits for `COMPLETED` (worker) and the Arabic message in the guest's conversation. |
| 5 | The audit trail links every step by `correlation_id` | ✅ | `m1.integration.spec.ts` "the audit trail and the events link every step": `catalog.request.create` (GUEST) under the ask's id with `ops.work_item.created` + `catalog.service_request.created`; `catalog.request.status` (SYSTEM) under the staff action's id with `ops.task.status_changed`, `ops.work_item.status_changed`, `catalog.service_request.status_changed` and `comms.message.sent`. A human action starts a new correlation id; everything it causes carries it, and the request id ties the chain (request history in `catalog.service_request_events`). Deployed: the smoke checks the audit rows with correlation ids. |
| 6 | A second identical request within the window is related, not duplicated | ✅ | `requests.integration.spec.ts` (related asks from both party members, `RELATED` history with the new field values, one work item; two concurrent asks → one created, one related); `m1.integration.spec.ts`; deployed smoke. |

## Also verified
- Published service versions are immutable in the database (triggers on versions and their translations); edits create the next draft; publishing supersedes and announces `catalog.service_version.published.v1` (`catalog.integration.spec.ts`).
- Tenant-wide and property services; a property opting out by retiring its own version; eligibility (primary guest only for late check-out), availability in the property time zone, translation fallback (`rules.spec.ts`, `catalog.integration.spec.ts`).
- Requests follow the work item's current status (late or repeated deliveries cannot move them back), are withdrawn when the stay leaves the house, and can be cancelled by the guest (open) or staff (with a reason).
- Anonymization removes the guest's words from requests, asks and their work (`ops.work.title_redacted`); history rows can only be emptied, never rewritten (`requests.integration.spec.ts`).
- Guest web: the session token only in an httpOnly cookie; the proxy forwards guest and public routes only and never the routes that mint a session; English (LTR) and Arabic (RTL) with mirrored layout and the attribution footer (`apps/guest-web/e2e/guest.spec.ts`, pilot smoke).
- Tenant isolation: 404 across tenants for catalog items and requests; RLS on every new table.
- Fixed on the way: replies to a stay conversation begun on the guest web reached nobody once the guest wrote on WhatsApp (the writer now becomes the conversation's contact).

## Deviations recorded during Phase 5
- SLA and workflow are bound by service and workflow **code** instead of foreign ids into the operations context (§9.2).
- Duplicate detection serializes with a transaction-scoped advisory lock instead of row locks (§9.2).
- The guest web refreshes requests and chat by polling because the session token is not readable by scripts (notes for 5.4).
- Staff WhatsApp/SMS notifications move to Phase 7 with staff phone numbers (§9.2 "Not in Phase 5").

## Open items carried forward
- 🟡 Pilot providers: approve the `service_update` template next to `otp` and `activation` and map it in the WhatsApp channel's `config.templates` (deploy.md step 6).
- 🟡 Guest web domain: point `HOTELLA_PUBLIC_BASE_URL` at the guest web app's public name (BUILD_PLAN Q4) and add it to the host reverse proxy.
- Offline service worker for the guest PWA; a short-lived realtime ticket for guest chat instead of polling.
- Staff catalog administration screens (the API exists; staff-web gains them with the Phase 7 staff screens); staff invitation e-mails through the notification service and department membership of staff — moved to the Phase 7 staff screens as well.
- Carried from earlier phases: inbound media download, templated re-engagement outside the window for staff replies, retention purge of processed `comms.inbound_events`, realtime gateway as its own deployable, product owner confirmation of OpenBao, SMTP for the pilot host.
