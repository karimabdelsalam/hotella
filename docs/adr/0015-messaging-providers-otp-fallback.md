# ADR-0015: WhatsApp providers (Meta Cloud API and BSP) and OTP fallback policy

**Status:** Accepted — 2026-10-03 (product owner: support both provider types; engineering chooses the fallback design)

## Context
Spec §18 treats WhatsApp strictly as a channel behind adapters; §19.2 defines WhatsApp OTP; §66 defines OTP security; §25 separates notification intent from delivery channel. The product owner wants to be able to use **either Meta's WhatsApp Cloud API directly or a Business Solution Provider (BSP)** per deployment, and wants an OTP fallback if WhatsApp is unavailable.

## Decision

### Provider abstraction
- `MessagingProvider` interface in `@hotella/domain-communications`: `sendTemplate`, `sendText`, `sendMedia`, `sendInteractive`, `parseWebhook`, `verifyWebhookSignature`, `getDeliveryStatus`. A `comms.channels` row binds a property channel to a provider adapter and a `credential_ref`.
- Adapters shipped in Phase 4: `WHATSAPP_META_CLOUD` (Graph API, webhook HMAC verification) and `WHATSAPP_BSP_GENERIC` (an adapter base with concrete implementations added per BSP; first concrete BSP chosen at pilot time — e.g. 360dialog or Twilio — both are thin mappings over the same template/message model).
- Template management: OTP and activation templates are registered per channel with provider template ids stored in channel config; the platform never sends free-form text outside the 24-hour window.

### OTP delivery and fallback policy (deterministic, configurable per property)
```text
request OTP
 -> primary: WhatsApp template "authentication" via the property's channel
 -> wait for provider accept + DELIVERED/READ within fallback_timeout (default 20 s)
    - provider error, undeliverable, or no delivery receipt within timeout
      -> automatic fallback: SMS via SmsProvider (same OTP session, same code, new attempt record)
    - guest taps "Didn't get the code?" after 30 s -> manual fallback to SMS (rate-limited)
 -> SMS unavailable/undelivered
    -> option 3: voice call read-out via VoiceOtpProvider (optional adapter, off by default)
    -> option 4: staff-assisted verification at the front desk: staff with permission
       guest.activation.assist verifies identity and issues the grant; audited with reason
```
- `SmsProvider` interface with the first adapter chosen at pilot (any HTTP SMS aggregator; Egyptian local aggregators are expected). Sender IDs/templates are configuration.
- One `verification_session` spans all channels: attempts, expiry (5 min) and the single valid code are shared; fallback never resets the attempt counter. Each delivery attempt is recorded in `comms.verification_deliveries (session_id, channel, provider, status, provider_ref, sent_at)`.
- Fallback decisions are made by code and configuration, never by an LLM (Spec §82.25). Per-property configuration keys: `otp.primary_channel`, `otp.fallback_channels[]`, `otp.fallback_timeout_seconds`, `otp.manual_fallback_after_seconds`, `otp.staff_assist_enabled`.
- Health-driven pre-emption: if the WhatsApp channel's integration health is `OFFLINE`/`AUTH_FAILED` (Spec §57), OTP goes straight to the first fallback channel and an operational alert is raised (deduplicated).

### Consequences
- A property can run on Meta Cloud API, switch to a BSP, or use different providers per property without touching domain code.
- OTP success does not depend on a single provider; the guest sees one flow.
- Phase 4 test plan adds: fake WhatsApp provider failing → SMS fake receives the same code; attempt counter continuity; staff-assisted path audited.
- Costs: SMS fallback incurs per-message charges; the metering metric `OTP_SMS_SENT` is added to usage metering (Phase 11).

## Implementation notes (Sprints 4.2–4.3, 2026-10-03)
These refine the decision without changing it; code lives in `packages/domain/communications`.
- **Adapters:** `WHATSAPP_META_CLOUD` (Graph API, default `v23.0`, configurable base URL), `WHATSAPP_BSP_360DIALOG`
  on a `CloudCompatibleBspAdapter` base for BSPs that relay the Cloud API model (another BSP is a small subclass naming
  its endpoint and key header), `SMS_HTTP_JSON` until the pilot's SMS aggregator is chosen. Fakes (`FAKE_WHATSAPP`,
  `FAKE_SMS`) exist for tests and local development only.
- **Credentials:** one `credential_ref` per channel resolving to a JSON object — Meta: `accessToken`, `appSecret`
  (webhook signatures), `verifyToken` (subscription handshake); BSP and SMS: `apiKey`, `webhookSecret`. Never stored,
  logged or returned.
- **Webhook authentication:** Meta signs with `X-Hub-Signature-256`; BSP and SMS webhooks are registered with the
  header `X-Hotella-Webhook-Secret` (BSPs relay Meta's payload unsigned). Comparison is constant-time.
- **Templates:** each channel maps platform template codes (`otp`, `activation`, and from Sprint 5.3
  `service_update` — parameters: service name, new status, both in the guest's language) to approved provider
  templates in its configuration; authentication templates may repeat the code in a copy-code button (`codeButton`).
- **Notifications (Sprint 5.3):** other contexts tell a guest something only through `COMMUNICATIONS_API.notifyGuest`:
  a `SYSTEM` message in the stay's conversation, delivered to the guest's verified WhatsApp number as text inside the
  24-hour window and as its template outside it (or to someone other than the conversation's last contact).
- **Same code on every channel without storing it:** the code is derived with HMAC-SHA256 under the OTP key (a
  SecretRef) from the session id and a random seed (BUILD_PLAN §8.9, notes for 4.2).
- **Fallback timing:** provider errors fall back immediately; a missing delivery receipt falls back after
  `fallback_timeout_seconds` through a 5-second worker sweep; health pre-emption skips OFFLINE/AUTH_FAILED channels and
  raises the `CHANNEL_UNHEALTHY` alert, deduplicated per channel.
