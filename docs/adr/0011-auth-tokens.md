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

## Implementation notes (Sprint 1.2, 2026-10-03)
These refine the decision above without changing it; code lives in `packages/domain/identity`.
- **Access token:** EdDSA (Ed25519) signed with `jose`; claims `sub`, `tid` (tenant or null for platform staff), `sid`, `adm`, `loc`, `typ=access`, `jti`; audience `hotella-staff`; TTL `IAM_ACCESS_TOKEN_TTL_SECONDS` (≤ 900, enforced by config). Membership ids are **not** embedded either: memberships, like permissions, are resolved per request. The key is a SecretRef (`IAM_JWT_SIGNING_KEY_REF`, PKCS#8 PEM); the `kid` is derived from the public key.
- **Every request checks the session:** a valid signature is not enough — the session must be unrevoked and unexpired and the user ACTIVE (one indexed query). Logout, refresh-token reuse and disabling a user therefore take effect on the next request, not at token expiry.
- **Refresh tokens:** `iam.sessions` is the family; each token is a row in `iam.refresh_tokens` (SHA-256 only, chained by `replaced_by_id`). Rotation claims the presented token atomically (`UPDATE … WHERE used_at IS NULL`); presenting a used token revokes the session and publishes `iam.session.revoked.v1`.
- **Permission cache:** not yet introduced — resolution is one query per check. The Valkey cache keyed by membership version is added when profiling shows the need; correctness does not depend on it.
- **MFA:** RFC 6238 TOTP (SHA-1, 6 digits, 30 s, ±1 step) implemented on `node:crypto` and verified against the RFC vectors. The per-user seed cannot be its own SecretRef (secret providers are read-only), so it is sealed with AES-256-GCM under a key that is a SecretRef (`IAM_MFA_KEY_REF`); the stored value is ciphertext classified RESTRICTED. The last accepted time step is stored, so a code can never be replayed.
- **Brute force:** identical generic 401 for unknown user, wrong password, disabled or locked account (an argon2 verification is burned for unknown users so timing does not differ); `IAM_LOGIN_MAX_ATTEMPTS` failures (password or MFA) lock the account for `IAM_LOGIN_LOCK_MINUTES`; credential endpoints are additionally rate limited per IP.
- **Passwords:** argon2id at m=19 MiB, t=2, p=1 (pinned); NIST-style policy: 12–128 characters, no composition rules, must not contain the e-mail's local part.
- **Invitations:** a single-use, hashed, expiring (`IAM_INVITE_TTL_HOURS`) token sets the first password. Until the comms context delivers it by e-mail/WhatsApp (Phase 5), it is returned once to the inviting administrator.
- **Platform staff:** platform administrators hold exactly the `PLATFORM_ADMIN` system role's permissions (tenant administration, never guest or operational data; Spec §64). No HTTP endpoint can create one; the first is created by `pnpm iam:bootstrap-admin` (password on stdin).
- **Locale preference:** the `loc` claim feeds the "user preference" step of the locale chain without a database round trip.
