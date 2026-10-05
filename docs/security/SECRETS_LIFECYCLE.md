# Secrets lifecycle — OpenBao

Owner decision (2026-10-03, confirmed 2026-10-04): **OpenBao** is the single secret store of the platform (ADR-0010,
ADR-0013). This document is the lifecycle every secret follows: where it lives, who may read it, how it is created,
retrieved, rotated, revoked and audited. Operational commands are in `docs/runbooks/secret-rotation.md`.

## Rules (CLAUDE.md rule 13)
- Secrets are referenced, never stored: tables, configuration and code hold a **SecretRef** (`vault://kv/<path>#<key>`);
  only `platform-secrets` resolves it, through `SecretProvider`.
- Never in source code, database plaintext, frontend bundles, logs, prompts, chat, tickets or screenshots. Logs redact
  credential-shaped fields; errors name the ref, never the value.
- Hotel-side secrets (OWS password, OPERA database password) never leave the hotel: they live in the agent's protected
  store (Windows DPAPI machine scope / Linux 0600), entered with `hotella-agent secret set <name>` from stdin.

## Inventory
| Secret | Where | Readers (policy) | Rotation |
|---|---|---|---|
| Database application password | `kv/hotella/app#db_password` | api, worker (`hotella-app`) | 180 days, and on staff change |
| Valkey password, object-storage keys | `kv/hotella/app` | api, worker | 180 days |
| JWT signing key (Ed25519) | `kv/hotella/app#jwt_private_key` | api | yearly; tokens ≤ 15 min so rotation is seamless |
| MFA sealing key | `kv/hotella/app#mfa_key` | api | only on compromise (forces MFA re-enrolment) |
| Webhook signing key | `kv/hotella/app#webhook_signing_key` | api, worker | yearly; endpoint secrets are re-derived and shown once |
| **AI provider keys** (Anthropic, OpenAI, others) | `kv/hotella/ai/<provider>#api_key`, referenced by `ai.providers.credential_ref` | worker (AI gateway) | 90 days or the provider's policy; immediately on suspicion |
| WhatsApp / SMS provider tokens | `kv/hotella/comms/<channel>` via `comms` channel `credentialRef` | worker | per provider; on staff change |
| SMTP password | `kv/hotella/app#smtp_password` | worker | 180 days |
| Agent gateway TLS key, agent CA key, command/licence signing key | `kv/hotella/agent` (CA key offline) | agent-gateway (`hotella-agent`) | TLS 397 days; signing keys only on compromise (re-enrolment) |
| Entitlement bundle signing key (ADR-0021) | `kv/hotella/license#bundle_signing_key` (`LICENSING_BUNDLE_SIGNING_KEY_REF`, Ed25519) | api | only on compromise (every site re-pins `LICENSING_BUNDLE_PUBLIC_KEY`) |
| Site installation key (ADR-0021, on-site platforms only) | the site's own OpenBao, `kv/hotella/license#installation_key` (`LICENSING_INSTALLATION_KEY_REF`, Ed25519) | the site's api/worker | on compromise: register a new key, revoke the old installation |
| OWS credentials, OPERA DB password | **agent protected store at the hotel** | the agent service only | with the hotel's IT policy (`secret set` replaces) |
| OpenBao unseal shares, root token | three custodians (offline); root token never kept | people | rekey yearly; root generated per need and revoked |

## Lifecycle
1. **Create** — generated on the host by `pilot.sh` (random, never typed into chat) or supplied by the provider and
   written straight into OpenBao by an operator (`bao kv patch`), never through the application.
2. **Access control** — one AppRole per workload (api, worker, agent-gateway) with a read-only policy on exactly the
   paths it needs; tokens live one hour (max 24 h). People use per-person OpenBao identities; there is no shared admin
   login. Platform administrators of the application have no OpenBao access by their role.
3. **Retrieve** — at start-up and on cache expiry through `SecretProvider`; values stay in process memory only.
4. **Rotate** — per the table and the runbook: write the new version (KV v2 keeps versions), apply it where it is
   enforced, restart the readers, verify, then destroy the old version. AI keys: create the new key at the provider,
   write it, restart the worker, check one model call in `/ai/usage`, revoke the old key at the provider.
5. **Revoke** — on suspected exposure: revoke at the source (provider console, `ALTER ROLE`, AppRole secret-id
   destroy), rotate, and record the incident.
6. **Audit** — OpenBao's file audit device is enabled at initialisation (`pilot.sh vault-init`): every read and write is
   logged with the identity (values are HMAC-ed by OpenBao, never in clear). Rotations are recorded in the change log;
   application-side changes that reference secrets (provider and channel configuration) are in `audit.audit_log`.
7. **Back up** — OpenBao's storage is backed up with the platform; unseal shares are held by different custodians.
