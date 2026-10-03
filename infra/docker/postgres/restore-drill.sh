#!/usr/bin/env bash
# Restore drill (ADR-0013): restores the latest backup + archived WAL into an EMPTY data directory, starts a
# throwaway PostgreSQL on it, and verifies the restored database answers. Runs inside the postgres image as the
# postgres user, with the backup repository mounted read-only. Never touches the production data directory.
set -euo pipefail
STANZA="${STANZA:-hotella}"
TARGET="${DRILL_PGDATA:-/var/lib/postgresql/drill}"
PORT="${DRILL_PORT:-5499}"

if [ -n "$(ls -A "$TARGET" 2>/dev/null || true)" ]; then
  echo "restore-drill: $TARGET is not empty; refusing to overwrite" >&2
  exit 2
fi
mkdir -p "$TARGET" && chmod 0700 "$TARGET"
started=$(date +%s)

pgbackrest --stanza="$STANZA" --pg1-path="$TARGET" --archive-mode=off --log-level-console=warn \
  --lock-path=/tmp/pgbackrest-drill --spool-path=/tmp/pgbackrest-drill-spool --log-path=/tmp \
  --type=default restore

# The restored cluster must not archive into the production repository.
cat >> "$TARGET/postgresql.auto.conf" <<CONF
archive_mode = off
port = $PORT
listen_addresses = ''
CONF

pg_ctl -D "$TARGET" -o "-k /tmp" -w -t 300 start
# Wait until recovery has replayed the archived WAL and the server is promoted.
for _ in $(seq 1 120); do
  if [ "$(psql -h /tmp -p "$PORT" -U hotella_admin -d hotella -Atc 'select pg_is_in_recovery()')" = "f" ]; then break; fi
  sleep 1
done

psql -h /tmp -p "$PORT" -U hotella_admin -d hotella -v ON_ERROR_STOP=1 -At <<'SQL'
\echo restored-tables:
select count(*) from information_schema.tables where table_schema in ('org','iam','audit','platform');
\echo restored-tenants:
select count(*) from org.tenants;
\echo restored-audit-rows:
select count(*) from audit.audit_log;
\echo last-audit-entry:
select coalesce(max(occurred_at)::text, 'none') from audit.audit_log;
\echo applied-migrations:
select count(*) from migrations.journal;
SQL

pg_ctl -D "$TARGET" -m fast -w stop
echo "restore-drill: OK in $(( $(date +%s) - started ))s (RTO target ≤ 2 h)"
