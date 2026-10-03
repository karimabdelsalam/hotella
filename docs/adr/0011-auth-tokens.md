# ADR-0011: Staff and guest token model

**Status:** Accepted — 2026-10-03

## Context
Spec §65–66: staff strong password/MFA now, OIDC/SAML later; short-lived access token + rotating refresh token + device revocation; guests passwordless with high-entropy, single-purpose, expiring, revocable, hashed activation tokens and hashed, short-lived, attempt- and rate-limited OTPs; multiple guest devices (§21).

## Decision
- **Staff:** JWT access token (RS256/EdDSA, ≤15 min, claims: `sub`, `tenant_id`, `sid`, `mem` membership ids; permissions are *not* embedded — they are resolved per request to honour revocations). Opaque refresh token (256-bit), stored as hash in `iam.sessions`, rotated on every use; reuse of a rotated token revokes the session family. Passwords hashed with argon2id via `@node-rs/argon2` (prebuilt N-API binaries, no node-gyp — ADR-0016 gate rule 5). TOTP MFA; WebAuthn and OIDC/SAML are later adapters behind the same `AuthenticationStrategy` interface.
- **Guests:** no passwords. Activation token (256-bit, hashed, single purpose, default 24h, revocable). OTP (6 digits, 5 min, 5 attempts, per-phone and per-IP rate limits, hashed with HMAC-SHA256 using a provider-managed key). Guest session: opaque token (hashed) bound to a `guest_access_grant`, multiple concurrent sessions per grant, sliding expiry, all revoked when the grant is revoked.
- **Scopes:** guest authorization is evaluated against grant scopes and stay state on every request; the phone/channel identity is never sufficient (§18.3).

## Consequences
- Permission changes take effect immediately (per-request resolution with a short Valkey cache keyed by membership version).
- Guest flows need no account management UI.
