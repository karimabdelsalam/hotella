# ADR-0010: `SecretProvider` abstraction

**Status:** Accepted — 2026-10-03

## Context
Spec §67 and §82.30: production secrets must not be stored as ordinary plaintext application configuration; use a secret manager/vault. Integration instances, AI providers and messaging channels all need credentials (§46, §28, §18).

## Decision
- `@hotella/platform-secrets` exposes `SecretProvider { get(ref: SecretRef): Promise<string>; }` and the `SecretRef` type (`provider://path#key`).
- Adapters: `EnvSecretProvider` (dev/test), then a production adapter chosen by hosting target (HashiCorp Vault, AWS Secrets Manager, GCP Secret Manager — see open question Q6).
- Database rows store **only** `SecretRef` values (e.g. `credential_ref`), never secret material. Config tables and `settings` JSONB are validated to reject keys that look like secrets.
- Only `platform-config` and `platform-secrets` may read `process.env` (lint rule).
- Encryption-at-rest for the few secrets that must live in the database (e.g. OTP hashes are hashes, not secrets; refresh tokens are hashed) uses envelope encryption with a key from the provider.

## Consequences
- Rotating a credential never requires a code or schema change.
- Local development remains simple (`.env` + `EnvSecretProvider`).
