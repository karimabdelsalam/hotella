# ADR-0025: Owner decisions Q21–Q27 — SIP voice (Grandstream), room-context callers, speech egress, VingCard locks, BMS protocols

**Status:** Accepted — 2026-10-05 (product owner decisions Q21–Q27; engineering design below). Decisions 1–4 are
built (Sprint 13.7); 5–6 are deferred to future development (Phase 13 closed by the owner on 2026-10-05).

## Context
ADR-0024 shipped Phase 13 on vendor-neutral profiles and left the vendors and three policies to the owner. The owner
decided on 2026-10-05:

- **Q21 PBX:** Grandstream (UCM series) first, built on **standard SIP** so other PBX vendors can follow.
- **Q22 speech:** guest voice audio is processed **on-premises only** by default. Cloud speech-to-text and
  text-to-speech only by explicit per-hotel configuration, with the hotel's approval.
- **Q23 recording:** never. Call audio is never recorded or stored; call metadata may be kept for operations.
- **Q24 BMS:** vendor-neutral; standard protocols (BACnet/IP, Modbus TCP) through adapters.
- **Q25 door locks:** VingCard / ASSA ABLOY Global Solutions first, as an adapter, so other lock systems can follow.
- **Q26 Wi-Fi, POS, ERP:** vendor-neutral; modular connectors only, no hard-coded vendor dependency.
- **Q27 room phones:** enable **room-context identification**. A known guest-room extension maps to its room and the
  active stay; this identifies the room and stay, not the person speaking. The AI may load room and reservation context,
  but needs appropriate verification before exposing sensitive guest information or performing sensitive actions.
  Unknown, public-area, staff or unmapped extensions follow the normal operator / identity-verification flow.

## Decision
1. **Extensions are a directory, never a pattern (rule 16).** Each `VOICE` channel has an extension directory
   (`comms.voice_extensions`: extension → kind `ROOM | PUBLIC | STAFF | OPERATOR`, room for `ROOM`). Staff maintain it;
   it can be prefilled from the property's rooms (`extension = prefix + room number`) as an explicit, reviewed action.
   Only a `ROOM` extension with exactly one in-house stay in its room gives room context. Every other caller —
   external numbers, unknown/unmapped, public-area, staff and operator extensions — is transferred to the operator at
   once. The property setting `comms.voice.room_context` (default **on**, Q27) lets a hotel switch it off.
2. **Room context is an assurance level, enforced by code, not by the model (rule 11).** Messages from a room-context
   call carry assurance `ROOM_CONTEXT`; verified identities (activation, OTP, staff) are `VERIFIED`. For a
   `ROOM_CONTEXT` turn the concierge runs with a fixed **room-context tool allowlist** (services, open requests of the
   stay, new service requests, room signals, complaints, hotel knowledge, table availability). Reading the guest's
   details, booking or cancelling are not available. Its context leaves out the guest's name and the conversation's
   messages from other channels, and tells it the caller is not verified. Anything sensitive becomes a hand-off
   (`SENSITIVE_REQUEST`), which transfers the call to the operator — the normal verification flow. An in-call
   verification step (e.g. a one-time code to the guest's verified WhatsApp) is a later option, not part of this
   decision.
3. **Speech stays on Planova-operated infrastructure by default (Q22).** `AUDIO` calls go only to providers with egress
   `ON_PREM` unless the property's `ai.speech.external` setting records the hotel's approval (`enabled`, approver,
   date, reference); external providers additionally need the existing platform allowlist and tenant opt-in
   (ADR-0018). "On-premises" means infrastructure Planova operates for the hotel (ADR-0013), not a third-party cloud.
4. **No recording (Q23).** No audio column, no audio in queues, logs or messages; utterance audio lives only in the
   request that transcribes it. Calls keep metadata (`comms.calls`: times, outcome, transfer reason, caller kind).
   The transcribed words are conversation messages, with the same retention and anonymization as chat.
5. **SIP voice bridge for Grandstream (Q21).** The hotel agent hosts a `VOICE_SIP` connector: a SIP user agent
   registered on the PBX as an extension (or reached over a SIP trunk), answering calls, segmenting caller speech into
   utterances, and speaking replies over RTP (G.711). It turns calls into Planova Voice Profile events (outbound-only,
   like every agent connection, ADR-0017) and executes `/say` and `/transfer` (SIP REFER to the operator extension).
   Grandstream UCM is the first certified PBX; any PBX that registers standard SIP extensions works the same way. The
   SIP/RTP stack is a managed .NET library (no native code), chosen under the Maturity Gate in the sprint that builds
   it.
6. **Vendor adapters behind the existing profiles.** VingCard (Visionline on site, Vostio in the cloud) is a lock
   connector answering the Planova Lock Profile commands (`KEY_ENCODE`, `MOBILE_KEY_ISSUE`, `KEY_REVOKE`). Its wire
   protocol is ASSA ABLOY's licensed partner interface, so the adapter is built against their documentation and test
   system once Planova has partner access. BACnet/IP and Modbus TCP are polling bridges in the agent that produce
   `TELEMETRY_BATCH` messages for `BMS_STANDARD` from a configured point list (device/object or register, scale,
   point code). Wi-Fi, POS and ERP stay on their neutral profiles.

## Consequences
- 13.4's prefix rule and `comms.voice.room_phone_trusted` are replaced by the directory and `comms.voice.room_context`.
- The concierge's behaviour now depends on the assurance of the turn; tests cover both levels.
- New sprints: 13.7 (room context, extension directory, speech approval), 13.8 (SIP bridge for Grandstream UCM), 13.9
  (BACnet/IP and Modbus TCP bridges), 13.10 (VingCard adapter — blocked until ASSA ABLOY partner access).
- Owner follow-ups: ASSA ABLOY partner/certification access (commercial); whether an in-call verification step is
  wanted; confirmation of the meaning of "on-premises" for speech.
