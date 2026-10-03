# Secret rotation

All application credentials are read from OpenBao (`kv/hotella/app`) at start-up through AppRole; rotating one means writing the new value, applying it where it is enforced, and restarting the readers. Use a root or operator token created for the occasion (`bao operator generate-root`), and revoke it afterwards.

```bash
C="docker compose -p hotella-pilot -f infra/docker/compose.pilot.yml"
bao() { $C exec -T -e BAO_TOKEN="$BAO_TOKEN" openbao bao "$@"; }
```

| Secret | Procedure | User impact |
|---|---|---|
| Database application password (`db_password`) | `bao kv patch -mount=kv hotella/app db_password=<new>`; `ALTER ROLE hotella_app PASSWORD '<new>'` (as `hotella_admin`); `pilot.sh start` | Seconds while api/worker restart |
| Database admin password | Update `pilot/.secrets/pg_admin_password`; `ALTER ROLE hotella_admin PASSWORD …` | None (operators only) |
| Valkey password (`valkey_password`) | Update `pilot/.secrets/valkey.conf` and OpenBao; `$C up -d valkey`; `pilot.sh start` | Queues pause for the restart; jobs persist |
| Object storage keys (`s3_access_key`, `s3_secret_key`) | Update `pilot/.secrets/s3.json` and OpenBao; `$C up -d s3`; `pilot.sh start` | None |
| JWT signing key (`jwt_private_key`) | `openssl genpkey -algorithm ed25519`; write to OpenBao; `pilot.sh start` | Access tokens (≤ 15 min) stop verifying; clients refresh silently with their refresh tokens |
| MFA sealing key (`mfa_key`) | **Avoid.** Seeds sealed with the old key become unreadable: every MFA user must re-enrol. Only after a suspected compromise, announced in advance | All MFA users re-enrol |
| AppRole secret ids | `bao write -f -field=secret_id auth/approle/role/hotella-api/secret-id > pilot/.secrets/approle/api/secret_id` (same for worker); `pilot.sh start`; then destroy the old id with `bao write auth/approle/role/hotella-api/secret-id-accessor/destroy secret_id_accessor=…` | None |
| OpenBao unseal keys | `bao operator rekey` with the current threshold of custodians; distribute the new shares; destroy the old ones | None |
| OpenBao root token | Never kept. Generate with `bao operator generate-root` when needed, revoke when done | None |
| Pilot CA / OpenBao TLS certificate (825 days) | Re-issue `tls/server.crt` from the CA (pilot.sh init steps), `$C up -d openbao`, `pilot.sh unseal`, `pilot.sh start` | Minutes |

After every rotation: record it in the change log, run `pilot.sh status`, sign in once, and check the audit log for the restart window.

## Hotel-agent PKI (ADR-0017)
- **Gateway TLS certificate** (397 days): re-issue it from the agent CA (`openssl x509 -req … -CA agent/ca.crt -CAkey <agent CA key>`), write it to `kv/hotella/agent` (`tls_cert`, `tls_key`) and restart `agent-gateway`. Agents keep working: they pin the CA, not the leaf.
- **Command-signing key**: agents pin its public key at enrollment, so rotating it means re-enrolling every agent. Only on suspected compromise.
- **Agent CA**: re-enroll every agent (new CA certificate shipped with the installer). Plan as a change window; revoke the old agents one by one (`agent-enrollment.md`).
- **A single agent**: revoke it (`POST …/agent/revoke`) and re-enroll with a new token.
