#!/usr/bin/env bash
# Hotella pilot operations (BUILD_PLAN §5.8, ADR-0013). Runbooks: docs/runbooks/.
#
#   pilot.sh init                 generate local credentials, TLS material and service configs (idempotent)
#   pilot.sh up                   build images and start postgres, valkey, s3, openbao
#   pilot.sh vault-init           initialise (first time) or unseal OpenBao; configure KV, AppRole, app secrets
#   pilot.sh unseal               unseal OpenBao after a restart
#   pilot.sh migrate              create/refresh the application DB role, apply migrations, grant the role
#   pilot.sh start                start api, worker and the agent gateway; wait for readiness
#   pilot.sh simulate <token>     run the PMS simulator as a hotel agent: enroll, replay a scenario
#   pilot.sh admin <email> <name> create a platform administrator (password: $HOTELLA_ADMIN_PASSWORD or prompt)
#   pilot.sh backup [full|diff]   pgBackRest backup (creates the stanza on first use) + archive check
#   pilot.sh restore-drill        restore the latest backup into a throwaway instance and verify it
#   pilot.sh provision <profile.json> <token>
#                                 create the hotel from its profile (docs/pilot/README.md): tenant, pilot licence,
#                                 property, buildings, floors, room types, rooms, departments, starter catalog, settings
#   pilot.sh demo <profile.json> <demo.json> <token>
#                                 demo content for a provisioned hotel: brand, staff accounts, services, restaurants,
#                                 hotel information, a simulated PMS with demo stays (fictional data; README §4)
#   pilot.sh monitor [--dry-run]  check the platform and notify alerts (cron runs it every 5 minutes; monitor.py)
#   pilot.sh alert-setup webhook|telegram
#                                 where alerts go: a webhook taking {"text": …} or a Telegram bot (asked, never echoed)
#   pilot.sh push-setup <project-id> <service-account.json>
#                                 turn on pushes to the Hotella staff app (Firebase); the key goes to OpenBao
#   pilot.sh status               containers, readiness, backups
#   pilot.sh down                 stop everything (volumes are kept)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOCKER_DIR="$(dirname "$HERE")"
SECRETS="$HERE/.secrets"
# The installation's settings (public URLs, host ports) that Compose reads; the commands here use the same values.
# shellcheck disable=SC1091
if [ -f "$DOCKER_DIR/.env" ]; then set -a; . "$DOCKER_DIR/.env"; set +a; fi
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
  secret_file otp_hmac_key openssl rand -base64 32
  secret_file webhook_signing_key openssl rand -base64 32
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
  init_agent_pki
  log "credentials ready in $SECRETS (back this directory up offline; never commit it)"
}

# Hotel-agent PKI (ADR-0017): agent CA (ECDSA P-256) that signs device certificates, the gateway's TLS certificate
# (issued by the same CA, which agents pin) and the Ed25519 key that signs command frames. Private keys stay in the
# unmounted 0700 ca/ directory until vault-init moves them into OpenBao; agent/ holds only the public CA certificate.
init_agent_pki() {
  mkdir -p "$SECRETS/agent"; chmod 0755 "$SECRETS/agent"
  [ -s "$SECRETS/agent/ca.crt" ] && return 0
  log "generating the hotel-agent CA, gateway certificate and command-signing key"
  local host="${HOTELLA_AGENT_HOSTNAME:-localhost}"
  openssl ecparam -name prime256v1 -genkey -noout 2>/dev/null |
    openssl pkcs8 -topk8 -nocrypt -out "$SECRETS/ca/agent-ca.key"
  openssl req -x509 -new -key "$SECRETS/ca/agent-ca.key" -days 3650 -subj "/CN=Hotella Agent CA/O=Planova" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -out "$SECRETS/agent/ca.crt" 2>/dev/null
  openssl ecparam -name prime256v1 -genkey -noout 2>/dev/null |
    openssl pkcs8 -topk8 -nocrypt -out "$SECRETS/ca/agent-tls.key"
  openssl req -new -key "$SECRETS/ca/agent-tls.key" -subj "/CN=$host" -out "$SECRETS/ca/agent-tls.csr" 2>/dev/null
  printf 'subjectAltName=DNS:%s,DNS:localhost,DNS:agent-gateway,IP:127.0.0.1\nextendedKeyUsage=serverAuth\nkeyUsage=critical,digitalSignature\nbasicConstraints=critical,CA:FALSE\n' \
    "$host" >"$SECRETS/ca/agent-tls.cnf"
  openssl x509 -req -in "$SECRETS/ca/agent-tls.csr" -CA "$SECRETS/agent/ca.crt" -CAkey "$SECRETS/ca/agent-ca.key" \
    -CAcreateserial -CAserial "$SECRETS/ca/agent-ca.srl" -days 397 -extfile "$SECRETS/ca/agent-tls.cnf" \
    -out "$SECRETS/ca/agent-tls.crt" 2>/dev/null
  openssl genpkey -algorithm ed25519 -out "$SECRETS/ca/agent-command.key"
  chmod 0644 "$SECRETS/agent/ca.crt"
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
  ensure_stanza
  log "infrastructure up"
}

# WAL archiving starts with PostgreSQL; without the pgBackRest stanza every archive-push fails and PostgreSQL restarts
# its processes ("archive command was terminated by signal"), dropping live connections. Create it right away.
ensure_stanza() {
  for _ in $(seq 1 20); do
    if pgbr stanza-create >/dev/null 2>&1 || pgbr stanza-upgrade >/dev/null 2>&1; then
      log "pgBackRest stanza ready"
      return 0
    fi
    sleep 3
  done
  die "could not create the pgBackRest stanza"
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
  # Read each list whole before searching it: with pipefail, `bao … | grep -q` fails when grep stops reading early
  # (the writer gets SIGPIPE), which made a second installation try to enable what already exists.
  local mounts auths audits
  mounts="$(bao secrets list -format=json)"
  grep -q '"kv/"' <<<"$mounts" || bao secrets enable -path=kv kv-v2 >/dev/null
  auths="$(bao auth list -format=json)"
  grep -q '"approle/"' <<<"$auths" || bao auth enable approle >/dev/null
  # Audit: every request to OpenBao is logged with its identity (values HMAC-ed) — SECRETS_LIFECYCLE.md. The device is
  # declared in openbao.hcl (OpenBao 2.x refuses API-created audit devices); here we only check it is active.
  audits="$(bao audit list -format=json 2>/dev/null || true)"
  grep -q '"file/"' <<<"$audits" || die "OpenBao audit device missing (openbao.hcl)"
  # Least privilege: api/worker read only the application secrets, AI provider keys and channel credentials; the
  # agent gateway also reads the agent PKI.
  printf 'path "kv/data/hotella/app" { capabilities = ["read"] }\npath "kv/data/hotella/ai/*" { capabilities = ["read"] }\npath "kv/data/hotella/comms/*" { capabilities = ["read"] }\n' |
    bao policy write hotella-app - >/dev/null
  printf 'path "kv/data/hotella/app" { capabilities = ["read"] }\npath "kv/data/hotella/agent" { capabilities = ["read"] }\n' |
    bao policy write hotella-agent - >/dev/null
  log "writing application secrets to kv/hotella/app"
  python3 - "$SECRETS" <<'PY' | bao write kv/data/hotella/app - >/dev/null
import json, sys, pathlib
d = pathlib.Path(sys.argv[1])
r = lambda n: (d/n).read_text().strip() if not n.endswith(".pem") else (d/n).read_text()
print(json.dumps({"data": {"db_password": r("db_app_password"), "valkey_password": r("valkey_password"),
  "s3_access_key": r("s3_access_key"), "s3_secret_key": r("s3_secret_key"), "mfa_key": r("mfa_key"),
  "otp_hmac_key": r("otp_hmac_key"), "jwt_private_key": r("jwt_private_key.pem"),
  "webhook_signing_key": r("webhook_signing_key")}}))
PY
  log "writing hotel-agent PKI to kv/hotella/agent"
  python3 - "$SECRETS" <<'PY' | bao write kv/data/hotella/agent - >/dev/null
import json, sys, pathlib
d = pathlib.Path(sys.argv[1])
print(json.dumps({"data": {"ca_cert": (d/"agent/ca.crt").read_text(), "ca_key": (d/"ca/agent-ca.key").read_text(),
  "command_key": (d/"ca/agent-command.key").read_text(), "tls_cert": (d/"ca/agent-tls.crt").read_text(),
  "tls_key": (d/"ca/agent-tls.key").read_text()}}))
PY
  for role in api worker agent-gateway; do
    local policy=hotella-app; [ "$role" = agent-gateway ] && policy=hotella-agent
    mkdir -p "$SECRETS/approle/$role"; chmod 0755 "$SECRETS/approle/$role"
    bao write "auth/approle/role/hotella-$role" token_policies="$policy" token_ttl=1h token_max_ttl=24h \
      secret_id_ttl=0 secret_id_num_uses=0 >/dev/null
    bao read -field=role_id "auth/approle/role/hotella-$role/role-id" >"$SECRETS/approle/$role/role_id"
    [ -s "$SECRETS/approle/$role/secret_id" ] ||
      bao write -f -field=secret_id "auth/approle/role/hotella-$role/secret-id" >"$SECRETS/approle/$role/secret_id"
    chmod 0644 "$SECRETS/approle/$role/role_id" "$SECRETS/approle/$role/secret_id"
  done
  log "OpenBao ready (AppRoles hotella-api, hotella-worker, hotella-agent-gateway; read-only policies)"
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

wait_gateway() {
  local url="https://127.0.0.1:${HOTELLA_AGENT_PORT:-8443}/agent/v1/health"
  for _ in $(seq 1 60); do
    curl -fsS -m 3 --cacert "$SECRETS/agent/ca.crt" "$url" >/dev/null 2>&1 && { log "agent gateway ready: $url"; return 0; }
    sleep 2
  done
  compose logs --tail=80 agent-gateway >&2 || true
  die "agent gateway not ready"
}

wait_staff_web() {
  local url="http://127.0.0.1:${HOTELLA_STAFF_WEB_PORT:-3100}/en/login"
  for _ in $(seq 1 60); do curl -fsS -m 3 "$url" >/dev/null 2>&1 && { log "staff web ready: $url"; return 0; }; sleep 2; done
  compose logs --tail=80 staff-web >&2 || true
  die "staff web not ready"
}

wait_guest_web() {
  local url="http://127.0.0.1:${HOTELLA_GUEST_WEB_PORT:-3200}/en"
  for _ in $(seq 1 60); do curl -fsS -m 3 "$url" >/dev/null 2>&1 && { log "guest web ready: $url"; return 0; }; sleep 2; done
  compose logs --tail=80 guest-web >&2 || true
  die "guest web not ready"
}

cmd_start() {
  compose up -d api worker agent-gateway staff-web guest-web
  wait_ready; wait_gateway; wait_staff_web; wait_guest_web
}

# Runs the PMS simulator as a hotel agent against the gateway: enroll with a token, replay a scenario (one of the
# simulator's own, e.g. scenarios/basic-stay.yml, or a file on this host).
cmd_simulate() {
  local token="${1:?enrollment token}" scenario="${2:-scenarios/basic-stay.yml}" mount=()
  if [ -f "$scenario" ]; then
    mount=(-v "$(realpath "$scenario"):/tmp/scenario.yml:ro")
    scenario=/tmp/scenario.yml
  fi
  compose run --rm -T "${mount[@]}" --entrypoint sh simulator -c "
    node dist/main.js enroll --gateway https://agent-gateway:8443 --ca /run/agent-ca/ca.crt --token '$token' --state /tmp/sim &&
    node dist/main.js run --gateway https://agent-gateway:8443 --state /tmp/sim --scenario '$scenario'"
}

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

# Runs the hotel provisioner (provision.mjs) in the api image, so the host needs no Node.js. The token travels in the
# environment, never on a command line.
provisioner() {
  local profile="$1"; shift
  HOTELLA_TOKEN="$token" docker run --rm --network host -e HOTELLA_TOKEN \
    -v "$HERE/provision.mjs:/provision/provision.mjs:ro" -v "$profile:/provision/profile.json:ro" \
    --entrypoint node "hotella/api:${HOTELLA_VERSION:-local}" /provision/provision.mjs \
    --api "${HOTELLA_API:-http://127.0.0.1:${HOTELLA_API_PORT:-3000}/api/v1}" "$@" /provision/profile.json
}

# Creates (or completes) a hotel from its profile: validate, create the tenant, license it for the pilot (every module,
# license-pilot.sh), then everything else. Idempotent: run it again whenever the profile grows.
cmd_provision() {
  local profile token
  profile="$(realpath "${1:?hotel profile (JSON)}")"
  token="${2:?platform admin access token}"
  [ -s "$profile" ] || die "no such file: $profile"
  provisioner "$profile" --check || die "the profile is not ready; fill what it lists and run again"
  provisioner "$profile" --tenant-only
  "$HERE/license-pilot.sh" "$token" "$(json_get "v['tenant']['code']" <"$profile")"
  provisioner "$profile"
}

# Demo content for a provisioned hotel (docs/pilot/README.md §4): brand, staff accounts (passwords kept in
# .secrets/demo/accounts.json, 0600), the hotel's services, restaurants and information as its demo manager, and a
# simulated PMS whose demo stays are replayed with the PMS simulator. Idempotent.
cmd_demo() {
  local profile demo token dir="$SECRETS/demo"
  profile="$(realpath "${1:?hotel profile (JSON)}")"
  demo="$(realpath "${2:?demo content (JSON)}")"
  token="${3:?platform admin access token}"
  mkdir -p "$dir"; chmod 0700 "$dir"
  # Runs as this host user, so it can write the accounts file into the 0700 state directory.
  HOTELLA_TOKEN="$token" docker run --rm --network host -e HOTELLA_TOKEN --user "$(id -u):$(id -g)" \
    -v "$HERE/demo-content.mjs:/provision/demo-content.mjs:ro" -v "$profile:/provision/profile.json:ro" \
    -v "$demo:/provision/demo.json:ro" -v "$dir:/demo" \
    --entrypoint node "hotella/api:${HOTELLA_VERSION:-local}" /provision/demo-content.mjs \
    --api "${HOTELLA_API:-http://127.0.0.1:${HOTELLA_API_PORT:-3000}/api/v1}" --dir /demo \
    /provision/profile.json /provision/demo.json
  if [ -s "$dir/enrollment-token" ]; then
    log "replaying the demo stays with the PMS simulator"
    cmd_simulate "$(cat "$dir/enrollment-token")" "$dir/scenario.yml"
    rm -f "$dir/enrollment-token"
  fi
  log "demo accounts (hotel code, e-mail, password): sudo cat $dir/accounts.json"
}

# Platform monitor (checklist §17): probes, rules and delivery are in monitor.py.
cmd_monitor() { python3 "$HERE/monitor.py" run "$@"; }

# Where monitor alerts go. Values are asked for (not taken from the command line, which lands in shell history) and kept
# in .secrets/alerting.env (0600); a test message confirms the destination.
cmd_alert_setup() {
  local kind="${1:?webhook or telegram}" file="$SECRETS/alerting.env" url token chat
  touch "$file"; chmod 0600 "$file"
  case "$kind" in
    webhook)
      read -r -s -p "Webhook URL (receives {\"text\": …}): " url; echo
      [[ "$url" =~ ^https:// ]] || die "the webhook must be an https:// URL"
      set_env "$file" HOTELLA_ALERT_WEBHOOK_URL "$url" ;;
    telegram)
      read -r -s -p "Telegram bot token: " token; echo
      read -r -p "Telegram chat id: " chat
      [[ "$token" =~ ^[0-9]+:[A-Za-z0-9_-]+$ ]] || die "not a Telegram bot token"
      [[ "$chat" =~ ^-?[0-9]+$ ]] || die "not a Telegram chat id"
      set_env "$file" HOTELLA_ALERT_TELEGRAM_TOKEN "$token"
      set_env "$file" HOTELLA_ALERT_TELEGRAM_CHAT_ID "$chat" ;;
    *) die "alert-setup webhook | telegram" ;;
  esac
  python3 "$HERE/monitor.py" test
}
set_env() {
  local file="$1" key="$2" value="$3"
  { grep -v "^$key=" "$file" || true; printf '%s=%s\n' "$key" "$value"; } >"$file.tmp"
  chmod 0600 "$file.tmp"; mv "$file.tmp" "$file"
}

# Pushes to the Hotella staff app (ADR-0023, docs/runbooks/push-notifications.md): the Firebase service-account key
# goes to OpenBao (never to disk next to the code), the project id to the compose environment; api and worker restart.
cmd_push_setup() {
  local project="${1:?Firebase project id}" key="${2:?service-account JSON file}"
  [[ "$project" =~ ^[a-z][a-z0-9-]{4,29}$ ]] || die "not a Firebase project id: $project"
  [ -s "$key" ] || die "no such file: $key"
  python3 - "$key" "$project" <<'PY' || die "the file is not this project's service-account key"
import json, sys
k = json.load(open(sys.argv[1]))
assert k.get("type") == "service_account" and k.get("client_email") and k.get("private_key")
assert k.get("project_id") == sys.argv[2]
PY
  if [ -z "${BAO_TOKEN:-}" ]; then
    [ -s "$SECRETS/openbao-init.json" ] || die "set BAO_TOKEN (an OpenBao token allowed to write kv/hotella/app)"
    BAO_TOKEN="$(json_get "v['root_token']" <"$SECRETS/openbao-init.json")"
  fi
  export BAO_TOKEN
  python3 -c 'import json,sys; print(json.dumps({"fcm_service_account": open(sys.argv[1]).read()}))' "$key" |
    bao kv patch kv/hotella/app - >/dev/null
  local env="$DOCKER_DIR/.env"
  touch "$env"
  grep -v '^HOTELLA_FCM_PROJECT_ID=' "$env" >"$env.tmp" || true
  echo "HOTELLA_FCM_PROJECT_ID=$project" >>"$env.tmp"
  mv "$env.tmp" "$env"
  compose up -d api worker
  wait_ready
  log "pushes to the Hotella app are on (project $project); delete $key from this host"
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
  simulate) shift; cmd_simulate "$@" ;;
  admin) shift; cmd_admin "$@" ;;
  backup) shift; cmd_backup "$@" ;;
  restore-drill) cmd_restore_drill ;;
  provision) shift; cmd_provision "$@" ;;
  demo) shift; cmd_demo "$@" ;;
  monitor) shift; cmd_monitor "$@" ;;
  alert-setup) shift; cmd_alert_setup "$@" ;;
  push-setup) shift; cmd_push_setup "$@" ;;
  status) cmd_status ;;
  down) cmd_down ;;
  *) sed -n '2,26p' "$0"; exit 1 ;;
esac
