# Backups and restores (pgBackRest)

Targets for the pilot (ADR-0013): **RPO ≤ 15 minutes, RTO ≤ 2 hours**, quarterly restore drill.

## How it works
- WAL is archived continuously (`archive_command` → pgBackRest, asynchronous, zstd) and at least every 60 s (`archive_timeout`), which bounds data loss to about a minute while the repository is healthy.
- The stanza (`hotella`) is created by `pilot.sh up` as soon as PostgreSQL is healthy. Without it every archive-push fails and PostgreSQL restarts its processes, dropping live connections — if `pilot.sh status` shows no stanza, run `pilot.sh up` again before anything else.
- Backups go to the `pgbackrest` volume (`/var/lib/pgbackrest` in the postgres container). Retention keeps 4 full backups and the WAL needed to restore any point since the oldest.
- The repository must also leave the host: copy the volume to the off-site store after each full backup (manual until the object-store repository is configured; see "Off-site copy").

## Schedule (install once, manual)
`/etc/systemd/system/hotella-backup@.service`:
```ini
[Unit]
Description=Hotella pgBackRest %i backup
[Service]
Type=oneshot
WorkingDirectory=/opt/hotella
ExecStart=/opt/hotella/infra/docker/pilot/pilot.sh backup %i
```
`/etc/systemd/system/hotella-backup-full.timer` (Sunday 02:15) and `hotella-backup-diff.timer` (daily 02:15 except Sunday):
```ini
[Timer]
OnCalendar=Sun *-*-* 02:15
Persistent=true
Unit=hotella-backup@full.service
[Install]
WantedBy=timers.target
```
Enable both timers; check `systemctl list-timers` and `pilot.sh status`.

## Restore drill (quarterly; automated in CI)
```bash
infra/docker/pilot/pilot.sh restore-drill
```
Restores the latest backup plus archived WAL into a throwaway data directory (never the live one), starts a private PostgreSQL on it, prints table/tenant/audit counts and the last audit timestamp, and reports the elapsed time. Record the output in the drill log with the date and the live counts for comparison. A drill that fails is a P1 incident.

## Real restore (manual)
1. Announce the outage; stop writers: `docker compose -p hotella-pilot -f infra/docker/compose.pilot.yml stop api worker`.
2. Note the recovery target: latest (default) or a time just before the incident.
3. Stop PostgreSQL and restore in place with `--delta` (only changed files are rewritten):
   ```bash
   C="docker compose -p hotella-pilot -f infra/docker/compose.pilot.yml"
   $C stop postgres
   $C run --rm --no-deps -u postgres --entrypoint pgbackrest postgres --stanza=hotella --delta restore
   # point in time instead:  ... --delta --type=time --target="2026-10-03 14:05:00+00" --target-action=promote restore
   $C up -d postgres
   ```
4. Wait for recovery to finish (`select pg_is_in_recovery()` returns `f`), run `pilot.sh start`, check `/api/v1/ready`, sign in, and look at the latest audit entries.
5. Take a new full backup (`pilot.sh backup full`): a restore starts a new timeline.

## Off-site copy (manual until automated)
After each full backup: `docker run --rm -v hotella-pilot_pgbackrest:/repo:ro -v /mnt/offsite:/out alpine tar -C /repo -czf /out/pgbackrest-$(date +%F).tgz .` and ship it to the off-site store. Next step (tracked): configure a second pgBackRest repository on the S3-compatible store with encryption (`repo2-type=s3`, `repo2-cipher-type=aes-256-cbc`).
