# ADR-0023: The Hotella staff mobile app — one app, Flutter, push notifications

**Status:** Accepted — 2026-10-05 (product owner decisions: one mobile app named **Hotella**, for staff only, staff sign
in with their own hotel's details, notifications; built with **Flutter**)

## Context
Staff use `apps/staff-web` (Next.js, responsive). Hotels want a native phone app for their staff with push
notifications (new tasks, guest requests, escalations, restaurant bookings). The platform is multi-tenant and
white-label (rule 15): one deployment serves many hotels, each with its own branding. The owner chose a single store
app named "Hotella" (not one app per hotel) and chose Flutter over React Native/Expo, accepting that the app's code is
Dart rather than the platform's TypeScript.

## Decision
- **One app, `apps/mobile`, Flutter (stable channel, Dart 3), iOS and Android**, published once as "Hotella" under
  Planova's store accounts. Staff only — guests keep the guest web app and WhatsApp. The app passes the Maturity Gate
  (Flutter 3 GA since 2022; ADR-0016) and adds no native code compiled at install on our side.
- **Sign-in with the hotel's details:** the first screen asks for the hotel code (or scans a QR shown in staff-web) →
  the platform resolves the tenant/property and its branding → the staff member signs in with their own credentials
  (same IAM, MFA, sessions and refresh tokens as staff-web; tokens in the Keychain/Keystore). After sign-in the app
  shows the hotel's name, logo and colours (branding resolution of rule 15) and keeps the non-removable "Powered by
  Planova" mark. A staff member with several properties switches between them as on the web.
- **No business logic in the app:** it calls the same versioned REST API (`/api/v1`) with the same permissions,
  `ActionGate`, audit and tenant isolation; it shows only what the user's permissions allow (rule 23: simple staff UX).
- **Contracts stay single-sourced:** the Dart API client is generated from the platform's OpenAPI document (generated
  from the zod contracts, ADR-0005) — never written by hand; CI fails when the generated client is stale. Strings come
  from `/locales` — a script converts the ICU catalog to Flutter ARB files (ARB uses ICU syntax) for all five locales
  (ADR-0022); Arabic renders RTL through Flutter's `Directionality`.
- **Push notifications:** Firebase Cloud Messaging (Android) and APNs (iOS) behind a `PUSH` delivery adapter of the
  existing notification pipeline (Phase 3 intents/deliveries) — no module sends pushes itself (rule 18 applied to
  staff notifications). Devices are registered per staff session (`iam.staff_devices`: user, property, platform, push
  token — CONFIDENTIAL — app version, last seen, revoked); signing out or deactivating a user revokes the device.
  **Push payloads carry no guest personal data** (they pass through Google/Apple): a title from the catalog and an
  entity reference; the app fetches details over the API. Provider credentials (FCM service account, APNs key) are
  `SecretRef`s in OpenBao (rule 13).
- **Offline:** read-only cache of the last lists for poor Wi-Fi in back-of-house areas; actions need the platform
  (queued actions are a later decision).

## Consequences
- A third front-end (after staff-web and guest-web) in a second language (Dart): kept thin by generated clients and the
  shared catalog; CI gets a Flutter job (`flutter analyze`, `flutter test`, client/ARB freshness).
- Owner items: Apple Developer Program and Google Play developer accounts in Planova's name (paid), a Firebase project,
  store listings and privacy labels, the store name "Hotella".
- Branded per-hotel store apps remain possible later (same code, flavours) if the owner sells them; not now.
