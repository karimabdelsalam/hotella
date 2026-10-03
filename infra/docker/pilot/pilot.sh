#!/usr/bin/env bash
# Hotella pilot operations (BUILD_PLAN §5.8, ADR-0013). Runbooks: docs/runbooks/.
#
#   pilot.sh init                 generate local credentials, TLS material and service configs (idempotent)
#   pilot.sh up                   build images and start postgres, valkey, s3, openbao
#   pilot.sh vault-init           initialise (first time) or unseal OpenBao; configure KV, AppRole, app secrets
#   pilot.sh unseal               unseal OpenBao after a restart
#   pilot.sh migrate              create/refresh the application DB role, apply migrations, grant the role
#   pilot.sh start                start api + worker and wait for readiness
#   pilot.sh admin <email> <name> create a platform administrator (password: $HOTELLA_ADMIN_PASSWORD or prompt)
#   pilot.sh backup [full|diff]   pgBackRest backup (creates the stanza on first use) + archive check
#   pilot.sh restore-drill        restore the latest backup into a throwaway instance and verify it
#   pilot.sh status               containers, readiness, backups
#   pilot.sh down                 stop everything (volumes are kept)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOCKER_DIR="$(dirname "$HERE")"
SECRETS="$HERE/.secrets"
PROJECT="hotella-pilot"
compose() { docker compose -p "$PROJECT" -f "$DOCKER_DIR/compose.pilot.yml" "$@"; }
log() { printf '\033[1m[pilot]\033[0m %s\n' "$*"; }
die() { printf '[pilot] error: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null || die "$1 is required"; }
rand() { openssl rand -base64 48 | tr -d '/+=\n' | cut -c1-"${1:-40}"; }
secret_file() { [ -s "$SECRETS/$1" ] || { "${@:2}" >"$SECRETS/$1"; chmod 0644 "$SECRETS/$1"; }; }

cmd_init() {
  need openssl; need python3
  umask 077
  mkdir -p "$SECRETS/tls" "$SECRETS/ca" "$SECRETS/approle/api" "$SECRETS/approle/worker"
  # The 0700 parent protects everything on the host. Directories that are bind-mounted into containers must be
  # traversable by the (non-root) container users; the CA private key lives outside every mounted directory.
  chmod 0700 "$SECRETS" "$SECRETS/ca"
  chmod 0755 "$SECRETS/tls" "$SECRETS/approle" "$SECRETS/approle/api" "$SECRETS/approle/worker"
  # Files are 0644 so container users can read their bind mounts; the 0700 directory protects them on the host.
  secret_file pg_admin_password rand 40
  secret_file db_app_password rand 40
  secret_file valkey_password rand 40
  secret_file s3_access_key rand 20
  secret_file s3_secret_key rand 40
  secret_file mfa_key openssl rand -base64 32
  secret_file jwt_private_key.pem openssl genpkey -algorithm ed25519
  [ -s "$SECRETS/valkey.conf" ] || {
    printf 'requirepass %s\nappendonly yes\nprotected-mode yes\n' "$(cat "$SECRETS/valkey_password")" >"$SECRETS/valkey.conf"
    chmod 0644 "$SECRETS/valkey.conf"
  }
  [ -s "$SECRETS/s3.json" ] || {
    python3 - "$SECRETS" <<'PY'
import json, sys, pathlib
d = pathlib.Path(sys.argv[1])
cfg = {"identities": [{"name": "hotella", "credentials": [{"accessKey": (d/"s3_access_key").read_text().strip(),
       "secretKey": (d/"s3_secret_key").read_text().strip()}], "actions": ["Admin", "Read", "Write", "List", "Tagging"]}]}
(d/"s3.json").write_text(json.dumps(cfg))
PY
    chmod 0644 "$SECRETS/s3.json"
  }
  if [ ! -s "$SECRETS/tls/server.crt" ]; then
    log "generating the pilot CA and the OpenBao server certificate"
    openssl req -x509 -newkey rsa:3072 -nodes -days 3650 -subj "/CN=Hotella Pilot CA" \
      -keyout "$SECRETS/ca/ca.key" -out "$SECRETS/tls/ca.crt" 2>/dev/null
    openssl req -newkey rsa:3072 -nodes -subj "/CN=openbao" -keyout "$SECRETS/tls/server.key" \
      -out "$SECRETS/ca/server.csr" 2>/dev/null
    printf 'subjectAltName=DNS:openbao,DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n' >"$SECRETS/ca/ext.cnf"
    openssl x509 -req -in "$SECRETS/ca/server.csr" -CA "$SECRETS/tls/ca.crt" -CAkey "$SECRETS/ca/ca.key" \
      -CAcreateserial -CAserial "$SECRETS/ca/ca.srl" -days 825 -extfile "$SECRETS/ca/ext.cnf" \
      -out "$SECRETS/tls/server.crt" 2>/dev/null
    chmod 0644 "$SECRETS/tls/server.key" "$SECRETS/tls/server.crt" "$SECRETS/tls/ca.crt"
  fi
  log "credentials ready in $SECRETS (back this directory up offline; never commit it)"
}

wait_healthy() {
  local svc="$1" tries="${2:-60}"
  for _ in $(seq 1 "$tries"); do
    local id; id="$(compose ps -q "$svc")"
    [ -n "$id" ] && [ "$(docker inspect -f '{{.State.Health.Status}}' "$id" 2>/dev/null)" = healthy ] && return 0
    sleep 2
  done
  die "$svc did not become healthy"
}

cmd_up() {
  need docker
  [ -s "$SECRETS/pg_admin_password" ] || die "run: pilot.sh init"
  log "building images"
  compose build
  compose up -d postgres valkey s3 openbao
  wait_healthy postgres; wait_healthy valkey
  log "infrastructure up"
}

bao() { compose exec -T ${BAO_TOKEN:+-e BAO_TOKEN="$BAO_TOKEN"} openbao bao "$@"; }
bao_status() { bao status -format=json 2>/dev/null || true; }
json_get() { python3 -c "import json,sys; v=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1"; }

cmd_unseal() {
  [ -s "$SECRETS/openbao-init.json" ] || die "OpenBao has not been initialised by this host (missing openbao-init.json)"
  if [ "$(bao_status | json_get "v['sealed']")" = "True" ]; then
    for i in 0 1; do
      bao operator unseal "$(json_get "v['unseal_keys_b64'][$i]" <"$SECRETS/openbao-init.json")" >/dev/null
    done
  fi
  log "OpenBao unsealed"
}

cmd_vault_init() {
  for _ in $(seq 1 30); do [ -n "$(bao_status)" ] && break; sleep 2; done
  if [ "$(bao_status | json_get "v['initialized']")" != "True" ]; then
    log "initialising OpenBao (3 key shares, threshold 2)"
    ( umask 077; bao operator init -key-shares=3 -key-threshold=2 -format=json >"$SECRETS/openbao-init.json" )
  fi
  cmd_unseal
  BAO_TOKEN="$(json_get "v['root_token']" <"$SECRETS/openbao-init.json")"; export BAO_TOKEN
  for _ in $(seq 1 30); do bao token lookup >/dev/null 2>&1 && break; sleep 1; done
  bao secrets list -format=json | grep -q '"kv/"' || bao secrets enable -path=kv kv-v2 >/dev/null
  bao auth list -format=json | grep -q '"approle/"' || bao auth enable approle >/dev/null
  printf 'path "kv/data/hotella/*" { capabilities = ["read"] }\n' | bao policy write hotella-app - >/dev/null
  log "writing application secrets to kv/hotella/app"
  python3 - "$SECRETS" <<'PY' | bao write kv/data/hotella/app - >/dev/null
import json, sys, pathlib
d = pathlib.Path(sys.argv[1])
r = lambda n: (d/n).read_text().strip() if not n.endswith(".pem") else (d/n).read_text()
print(json.dumps({"data": {"db_password": r("db_app_password"), "valkey_password": r("valkey_password"),
  "s3_access_key": r("s3_access_key"), "s3_secret_key": r("s3_secret_key"), "mfa_key": r("mfa_key"),
  "jwt_private_key": r("jwt_private_key.pem")}}))
PY
  for role in api worker; do
    bao write "auth/approle/role/hotella-$role" token_policies=hotella-app token_ttl=1h token_max_ttl=24h \
      secret_id_ttl=0 secret_id_num_uses=0 >/dev/null
    bao read -field=role_id "auth/approle/role/hotella-$role/role-id" >"$SECRETS/approle/$role/role_id"
    [ -s "$SECRETS/approle/$role/secret_id" ] ||
      bao write -f -field=secret_id "auth/approle/role/hotella-$role/secret-id" >"$SECRETS/approle/$role/secret_id"
    chmod 0644 "$SECRETS/approle/$role/role_id" "$SECRETS/approle/$role/secret_id"
  done
  log "OpenBao ready (AppRoles hotella-api, hotella-worker; policy hotella-app is read-only on kv/hotella/*)"
}

cmd_migrate() {
  log "ensuring the application database role (ordinary role, bound by row-level security)"
  compose exec -T postgres psql -U hotella_admin -d hotella -v ON_ERROR_STOP=1 -q \
    -v pw="$(cat "$SECRETS/db_app_password")" <<'SQL'
SELECT 'CREATE ROLE hotella_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hotella_app') \gexec
ALTER ROLE hotella_app WITH PASSWORD :'pw';
SQL
  log "applying migrations and grants"
  compose run --rm -T migrate
}

wait_ready() {
  local url="http://127.0.0.1:${HOTELLA_API_PORT:-3000}/api/v1/ready"
  for _ in $(seq 1 90); do curl -fsS -m 3 "$url" >/dev/null 2>&1 && { log "api ready: $url"; return 0; }; sleep 2; done
  compose logs --tail=80 api >&2 || true
  die "api not ready"
}

cmd_start() { compose up -d api worker; wait_ready; }

cmd_admin() {
  local email="${1:?email}" name="${2:?given name}" pw="${HOTELLA_ADMIN_PASSWORD:-}"
  if [ -z "$pw" ]; then read -r -s -p "Password for $email: " pw; echo; fi
  printf '%s' "$pw" | compose run --rm -T api node dist/cli/bootstrap-admin.js --email "$email" --given-name "$name"
}

pgbr() { compose exec -T -u postgres postgres pgbackrest --stanza=hotella "$@"; }

cmd_backup() {
  local type="${1:-full}"
  pgbr stanza-create >/dev/null 2>&1 || pgbr stanza-upgrade >/dev/null 2>&1 || true
  pgbr check
  pgbr --type="$type" backup
  pgbr info
}

cmd_restore_drill() {
  docker volume rm -f "${PROJECT}_drilldata" >/dev/null 2>&1 || true
  compose run --rm -T restore-drill
  docker volume rm -f "${PROJECT}_drilldata" >/dev/null 2>&1 || true
}

cmd_status() {
  compose ps
  curl -s -m 3 "http://127.0.0.1:${HOTELLA_API_PORT:-3000}/api/v1/ready" || true; echo
  pgbr info 2>/dev/null || true
}

cmd_down() { compose down; }

case "${1:-}" in
  init) cmd_init ;;
  up) cmd_up ;;
  vault-init) cmd_vault_init ;;
  unseal) cmd_unseal ;;
  migrate) cmd_migrate ;;
  start) cmd_start ;;
  admin) shift; cmd_admin "$@" ;;
  backup) shift; cmd_backup "$@" ;;
  restore-drill) cmd_restore_drill ;;
  status) cmd_status ;;
  down) cmd_down ;;
  *) sed -n '2,15p' "$0"; exit 1 ;;
esac
