# Roll back a release

Application rollbacks are cheap; database rollbacks are restores. Decide which one you need.

## Application only (the usual case)
Migrations are forward-only and backward compatible for one release (expand → deploy → migrate → contract, ADR-0002), so the previous release runs on the current schema.
```bash
export HOTELLA_VERSION=<previous release tag>
docker compose -p hotella-pilot -f infra/docker/compose.pilot.yml pull api worker
infra/docker/pilot/pilot.sh start
```
Then open an incident note: what failed, which version is live, what has to be fixed before rolling forward again.

## Data damage (manual)
If a release damaged data (wrong bulk update, bad migration), restore to the moment before the deployment with point-in-time recovery — see backup-restore.md "Real restore". Every deployment starts with a backup, so its timestamp is the recovery target.

## What never to do
- Do not edit `migrations.journal` or delete rows from it to "undo" a migration.
- Do not hand-edit tables to reverse an application change; audit rows are append-only and the audit trail must stay complete.
