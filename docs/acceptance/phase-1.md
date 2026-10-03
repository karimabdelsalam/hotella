# Phase 1 acceptance — Organization, IAM & Property

**Date:** 2026-10-03 · **Branch:** `claude/hopeful-archimedes-jskowx` · **CI:** GitHub Actions workflow `CI` (jobs "lint · typecheck · build · test" and "pilot deployment smoke")

Goal (Spec §85, BUILD_PLAN §5): one user can have different permissions across properties without data leakage; guest-facing branding resolves dynamically with the Planova attribution preserved. ✅ verified by automation · 🟡 needs a human.

| # | Criterion (BUILD_PLAN §5.7 / §5.8) | Status | Evidence |
|---|---|---|---|
| 1 | One user, different roles per property: permitted where granted, 403 elsewhere; cross-tenant ids → 404, never 403 | ✅ | `identity.integration.spec.ts` "one user, different permissions per property…": General manager at A edits A (200), Room attendant at B reads B (200) but cannot edit it (403), another tenant's property/users → 404, tenant-level routes need a tenant-wide membership (403). Guard verifies property ownership before permissions (`PROPERTY_SCOPE_VERIFIER`). The plan's example roles (HK supervisor / Engineer) carry operational permissions that arrive with Phases 3–4; the rule under test is identical. |
| 2 | Property B's brand never resolves for A; fallback tenant → platform; attribution survives every brand write | ✅ | `organization.integration.spec.ts` branding test (inheritance, channel layer, Arabic, other tenant cannot brand A); `branding.spec.ts`; attribution policy: hidden only with an entitlement reference (DB CHECK + `attributionFor`), other tenants unaffected (`identity.integration.spec.ts`). |
| 3 | Refresh-token reuse after rotation revokes the whole session | ✅ | `identity.integration.spec.ts` "refresh tokens rotate…": replaying the first token → 401, successor token and access token stop working; `iam.session.revoked.v1` + audit `iam.session.revoke` (reason TOKEN_REUSE). |
| 4 | Every mutating endpoint writes `audit.audit_log` with `correlation_id`; the audit table rejects UPDATE/DELETE at the database level | ✅ | All org/iam/config/retention/support mutations call `AuditWriter` inside their transaction (it refuses to run outside one); sign-in, revocation, invitation, MFA and lockout are audited. "mutations leave an audit trail…" asserts actor, correlation id, before/after and absence of credential material. Migration 0004 triggers reject UPDATE, DELETE and TRUNCATE for every role, superuser included (verified against PostgreSQL 16 locally and 18 in CI). |
| 5 | A user with `ar` preference gets Arabic error details and Arabic role names | ✅ | `/me` in Arabic (`Content-Language: ar`, role name «المدير العام») from the token's locale claim; Arabic password-policy detail; `en`/`ar` parity on 113 keys (`pnpm locales:check`). |
| 6 | RLS smoke: with the wrong `app.tenant_id`, direct SQL returns zero rows | ✅ | `identity.integration.spec.ts` "row-level security…" (other tenant's property invisible and not updatable, foreign insert rejected by policy). The whole identity suite runs the API as an ordinary role (`rolsuper=f, rolbypassrls=f`), 22 tenant-pinned transactions per run. |
| 7 | Staff auth: argon2id, short-lived EdDSA access token, per-request session check, TOTP MFA with replay protection, lockout, rate limits, invitations | ✅ | `domain.spec.ts` (RFC 6238/4226 vectors, argon2id parameters, sealing); integration tests for MFA, lockout, 429, invitation single use, disable → immediate 401. |
| 8 | Support access explicit, scoped, time-limited, read-only by default, approved, audited, revocable (Spec §64) | ✅ | "support access is explicit…": no standing access, READ-only scope enforcement, hotel approval (not requester, not platform admin), property-scoped reads only, every request audited as actor SUPPORT, revoke → 403. |
| 9 | Hierarchical configuration with history; retention framework | ✅ | `settings.spec.ts`; "configuration inherits platform → tenant → property…" and "a tenant can raise the password minimum…" and "retention policies…". |
| 10 | Pilot deployment (§5.8): images, compose stack with a real secret store, backups with a restore drill, runbooks | ✅ (CI) / 🟡 (target host) | CI job "pilot deployment smoke" (run 37100149940): images build, OpenBao initialised/unsealed with AppRoles, migrations as admin + grants, api/worker ready, first admin created and signed in, tenant created, `hotella_app` is not superuser/BYPASSRLS and is connected, pgBackRest full backup + `check`, restore drill restored 30 tables / 1 tenant / 3 audit rows / 7 migrations in 3 s. Runbooks: `docs/runbooks/`. A first installation on the Planova host is a manual step (deploy.md). |

## Delivered beyond the checklist
- Resilience fixes found by booting the production bundle with Valkey down: limiter fails open, idempotent requests get a retryable 503, probes are never rate limited.
- `pnpm iam:bootstrap-admin` (admin or support engineer), `hotella-db grant <role>` (refuses superuser/BYPASSRLS roles).
- `VaultKvSecretProvider` (OpenBao / HashiCorp Vault) and secret-referenced database/Valkey passwords.
- Lint self-test gained a positive fixture, after the domain boundary rule was found to block the allowed `/public` entry.

## Deviations recorded during Phase 1
- Secret store: OpenBao by default instead of HashiCorp Vault (licence; ADR-0013 revision) — same API, configuration-only switch.
- Refresh tokens: `iam.refresh_tokens` chain under `iam.sessions`; MFA seeds sealed under a SecretRef key (`mfa_secret_enc`) — ADR-0011 implementation notes.
- RLS restricts only when a tenant is pinned; platform-level work runs without the setting instead of a bypass role — ADR-0007 implementation notes.
- Organization-scoped memberships reserved; pgBackRest repository on a volume with off-site copy first, S3 repository next — BUILD_PLAN §5.9 reality notes, ADR-0013.

## Open items carried into Phase 2
- 🟡 Install the pilot on the target host (deploy.md), move the OpenBao unseal keys and root token offline, enable the backup timers, record the first manual restore drill.
- 🟡 Product owner: confirm OpenBao (MPL-2.0) as the secret store, or choose HashiCorp Vault (BSL) after a licence review.
- Pin non-transactional tenant reads to the tenant as well (ADR-0007 "known limit") when the guest context lands.
- Encrypted second pgBackRest repository on the S3-compatible store.
- The Phase 0 test routes (`/meta/echo`, `/meta/fail`) should be disabled in production builds before the first external exposure.
- Carried from Phase 0: Developer Guide walk-through timing by a team member; `pnpm/action-setup` Node 20 warning.
