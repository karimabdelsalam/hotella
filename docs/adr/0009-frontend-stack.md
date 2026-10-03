# ADR-0009: Frontend stack

**Status:** Accepted — 2026-10-03 (approved by product owner)

## Context
The Master Spec defines the backend stack (§2) but not the frontend. It requires: guest web/PWA, room QR activation pages, staff portal with unified inbox, administration; English and Arabic with true RTL (§79.4); no hardcoded strings (§79.1); dynamic branding by tenant/property/channel (§Product Identity); `Powered by Planova` attribution footer in LTR and RTL.

## Decision
- **Next.js (App Router)** for `apps/guest-web` (PWA, server-rendered activation and QR pages for fast first paint on mobile) and `apps/staff-web`.
- **next-intl** with locale resources from `/locales/{en,ar}`; `dir` attribute set per locale; the same key catalog as the backend where applicable.
- **Tailwind CSS** using logical properties (`ms-`, `me-`, `ps-`, `text-start`) so RTL needs no mirrored stylesheet; brand tokens injected as CSS variables from the resolved brand profile.
- Shared UI package `packages/ui` with RTL-tested primitives; the attribution footer is a component that cannot be disabled by brand configuration.
- Realtime via the `apps/realtime` WebSocket gateway.

## Alternatives
- Vite + React SPA (simpler, but worse mobile first paint for activation pages and no server-side locale/branding resolution).
- Separate mobile framework now (premature; native app is a later channel).

## Consequences
Phase 4 adds `apps/staff-web` (inbox) and Phase 5 adds `apps/guest-web`. Until then, Phases 0–3 are API-only.
