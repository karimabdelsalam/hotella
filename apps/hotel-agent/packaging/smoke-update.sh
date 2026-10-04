#!/usr/bin/env bash
# End-to-end check of the published agent and its signed self-update, as CI runs it:
#   packaging/smoke-update.sh <dist-dir>   (needs hotella-agent-0.10.1- and 0.10.2-linux-x64.zip there)
# Lays out an install, signs a release with a throwaway update key, serves it on loopback, then
# check → apply → the new version runs → status shows probation → rollback → the old version runs again.
set -euo pipefail
dist="$(cd "${1:?dist dir}" && pwd)"
here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'kill "${server:-0}" 2>/dev/null || true; rm -rf "$work"' EXIT
root="$work/opt"
mkdir -p "$root/versions/0.10.1" "$work/www"
unzip -q "$dist/hotella-agent-0.10.1-linux-x64.zip" -d "$root/versions/0.10.1"
ln -s "$root/versions/0.10.1" "$root/current"
agent() { "$root/current/hotella-agent" "$@" --Agent:DataDirectory="$work/data" \
  --Updates:ManifestUrl="http://127.0.0.1:$port/stable.json" --Updates:PublicKeyFile="$work/update-public.pem"; }

openssl genpkey -algorithm ed25519 -out "$work/update-key.pem" 2>/dev/null
openssl pkey -in "$work/update-key.pem" -pubout -out "$work/update-public.pem"
cp "$dist/hotella-agent-0.10.2-linux-x64.zip" "$work/www/"
port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')
node "$here/sign-manifest.mjs" --version 0.10.2 --package "$work/www/hotella-agent-0.10.2-linux-x64.zip" \
  --url "http://127.0.0.1:$port/hotella-agent-0.10.2-linux-x64.zip" --key "$work/update-key.pem" > "$work/www/stable.json"
(cd "$work/www" && python3 -m http.server "$port" --bind 127.0.0.1 >/dev/null 2>&1) & server=$!
for _ in $(seq 1 50); do curl -fsS "http://127.0.0.1:$port/stable.json" >/dev/null 2>&1 && break; sleep 0.1; done

[[ "$(agent version)" == "0.10.1" ]]
agent update check | tee /dev/stderr | grep -q 'available: 0.10.2'
agent update apply | grep -q 'switched to 0.10.2'
[[ "$("$root/current/hotella-agent" version)" == "0.10.2" ]]
agent update status | grep -q '0.10.2 on probation'
agent update check | grep -q '0.10.2 is current'
agent update rollback | grep -q 'rolled back to 0.10.1'
[[ "$("$root/current/hotella-agent" version)" == "0.10.1" ]]
agent update check | grep -q '0.10.1 is current'   # the rolled-back release is blocked
# A manifest signed by another key is refused.
openssl genpkey -algorithm ed25519 -out "$work/other.pem" 2>/dev/null
node "$here/sign-manifest.mjs" --version 0.10.3 --package "$work/www/hotella-agent-0.10.2-linux-x64.zip" \
  --url "http://127.0.0.1:$port/x.zip" --key "$work/other.pem" > "$work/www/stable.json"
refused="$(agent update check 2>&1 || true)"   # exits 4 (refused) by design
grep -q "update refused: update manifest is not signed by the pinned update key" <<<"$refused"
echo "agent update smoke: OK"
