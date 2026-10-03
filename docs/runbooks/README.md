# Operations runbooks (pilot, ADR-0013)

The pilot runs on one hardened Linux host with Docker Compose (`infra/docker/compose.pilot.yml`), driven by
`infra/docker/pilot/pilot.sh`. Kubernetes (k3s/RKE2) and Helm charts follow when the second tenant is onboarded.

| Runbook | When |
|---|---|
| [deploy.md](deploy.md) | First installation, upgrades, host hardening |
| [rollback.md](rollback.md) | A release misbehaves |
| [backup-restore.md](backup-restore.md) | Backup schedule, restore drill, real restore, point-in-time recovery |
| [secret-rotation.md](secret-rotation.md) | Rotating any credential or key; OpenBao unseal and root token handling |

Ground rules that apply to every procedure:

- Every change starts with `pilot.sh backup diff` (or `full` before upgrades) and is written down in the change log with who, when and why.
- Credentials live in OpenBao (`kv/hotella/app`) and in `infra/docker/pilot/.secrets` on the host (0700). Neither is ever copied into tickets, chat or e-mail.
- The application connects to PostgreSQL as `hotella_app`, an ordinary role bound by row-level security. Never point it at `hotella_admin` (a superuser bypasses RLS).
- CI runs the same scripts on every push (job "pilot deployment smoke"): a procedure that is not exercised there is marked **manual** below.
