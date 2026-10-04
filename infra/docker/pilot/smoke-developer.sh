#!/usr/bin/env bash
# Phase 11 deployed-pipeline smoke (CI "pilot deployment smoke"), after smoke-guest.sh:
# - entitlements: a staff action of an unlicensed tenant is refused with license.not_entitled and allowed after a grant;
# - developer platform: the PILOT group GM creates an API client; its key reads within its scope, is refused outside
#   it, is metered as API_CALLS and stops working when revoked; a webhook refuses a private target, its secret comes
#   from OpenBao, and a lost & found event reaches the worker's sweep as a signed delivery attempt (the target cannot
#   resolve on the runner, so the attempt is recorded and a retry scheduled).
# Needs a signed-in platform admin token.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
API="${HOTELLA_API:-http://localhost:3000/api/v1}"
admin="${1:?platform admin access token}"
json=(-H 'content-type: application/json')
as_admin=(-H "authorization: Bearer $admin" "${json[@]}")
psql() { docker compose -p hotella-pilot -f "$DIR/../compose.pilot.yml" exec -T postgres psql -U hotella_admin -d hotella -Atc "$1"; }
# Like curl -fsS, but a refused call prints the problem details (curl -f hides them).
call() {
  local out code
  out=$(curl -sS -w '\n%{http_code}' "$@") || return 1
  code=${out##*$'\n'}
  out=${out%$'\n'*}
  if [ "$code" -ge 400 ]; then
    echo "HTTP $code: $out" >&2
    return 22
  fi
  printf '%s\n' "$out"
}
# Expects a refusal: prints "<status> <problem code>".
refused() { curl -sS -o "$DIR/.refused" -w '%{http_code}' "$@" | tr -d '\n'; echo " $(jq -r .code "$DIR/.refused")"; rm -f "$DIR/.refused"; }
root_of() { call "$API/properties/$1/locations" -H "authorization: Bearer $2" | jq -r 'if type == "array" then .[0].id else .id end'; }
password='pilot developer smoke passphrase 2026'
user_token() { # <tenant id> <tenant code> <email>: a tenant-wide general manager, signed in
  local invite
  invite=$(call "$API/tenants/$1/users" "${as_admin[@]}" \
    -d "{\"email\":\"$3\",\"givenName\":\"Smoke GM\",\"memberships\":[{\"propertyId\":null,\"roleCodes\":[\"GENERAL_MANAGER\"]}]}" |
    jq -r .invitation.token)
  call "$API/auth/invitations/accept" "${json[@]}" -d "{\"token\":\"$invite\",\"password\":\"$password\"}" >/dev/null
  call "$API/auth/login" "${json[@]}" -d "{\"tenantCode\":\"$2\",\"email\":\"$3\",\"password\":\"$password\"}" | jq -r .accessToken
}

# --- Entitlements: refused without a licence, allowed after a grant (Spec §58–§60) ---
other=$(call "$API/tenants" "${as_admin[@]}" -d '{"code":"UNLICENSED","name":"Unlicensed Hotels"}' | jq -r .id)
other_property=$(call "$API/properties" "${as_admin[@]}" \
  -d "{\"tenantId\":\"$other\",\"code\":\"UNL\",\"name\":\"Unlicensed\",\"timezone\":\"Africa/Cairo\",\"currency\":\"EGP\"}" | jq -r .id)
unlicensed=$(user_token "$other" UNLICENSED gm@unlicensed.example)
root=$(root_of "$other_property" "$unlicensed")
room='{"parentId":"'"$root"'","roomNumber":"101"}'
verdict=$(refused "$API/properties/$other_property/rooms" -H "authorization: Bearer $unlicensed" "${json[@]}" -d "$room")
[ "$verdict" = "403 license.not_entitled" ] || { echo "expected a licence refusal, got: $verdict" >&2; exit 1; }
call "$API/control/tenants/$other/grants" "${as_admin[@]}" -d '{"capabilityCode":"CORE","reason":"Smoke: core grant"}' >/dev/null
call "$API/properties/$other_property/rooms" -H "authorization: Bearer $unlicensed" "${json[@]}" -d "$room" >/dev/null
echo "entitlements: refused without CORE, allowed after a grant"

# --- Developer platform (Spec §75): API client of the PILOT tenant ---
tenant=$(call "$API/tenants" -H "authorization: Bearer $admin" | jq -r '.[] | select(.code=="PILOT") | .id')
property=$(psql "select id from org.properties where tenant_id = '$tenant' and code = 'SIM'")
group=$(user_token "$tenant" PILOT developer-gm@pilot.example)
group_auth=(-H "authorization: Bearer $group" "${json[@]}")
created=$(call "$API/tenants/$tenant/api-clients" "${group_auth[@]}" \
  -d "{\"name\":\"Smoke integration\",\"propertyId\":\"$property\",\"scopes\":[\"org.property.read\"]}")
key=$(jq -r .key <<<"$created")
client=$(jq -r .client.id <<<"$created")
[[ "$key" =~ ^hk_[A-Za-z0-9]{12}_[A-Za-z0-9_-]{43}$ ]] || { echo "unexpected key format" >&2; exit 1; }
call "$API/properties/$property/rooms" -H "authorization: Bearer $key" | jq -e 'length > 0' >/dev/null
verdict=$(refused "$API/tenants/$tenant/users" -H "authorization: Bearer $key")
[ "${verdict%% *}" = 403 ] || { echo "a key outside its scopes must be refused, got: $verdict" >&2; exit 1; }
calls=$(psql "select count(*) from license.usage_events where tenant_id = '$tenant' and metric_code = 'API_CALLS'")
[ "$calls" -ge 1 ] || { echo "API calls were not metered" >&2; exit 1; }
call -X POST "$API/tenants/$tenant/api-clients/$client/revoke" "${group_auth[@]}" -d '{"reason":"Smoke finished"}' >/dev/null
verdict=$(refused "$API/properties/$property/rooms" -H "authorization: Bearer $key")
[ "${verdict%% *}" = 401 ] || { echo "a revoked key must be refused, got: $verdict" >&2; exit 1; }
echo "api client: scoped, metered ($calls API_CALLS), revoked"

# --- Outbound webhooks ---
verdict=$(refused "$API/tenants/$tenant/webhooks" "${group_auth[@]}" \
  -d '{"url":"https://10.1.2.3/hook","eventTypes":["lostfound.item.registered.v1"]}')
[ "$verdict" = "422 integration.webhook.url_private" ] || { echo "private target accepted: $verdict" >&2; exit 1; }
hook=$(call "$API/tenants/$tenant/webhooks" "${group_auth[@]}" \
  -d '{"url":"https://hooks.hotella-smoke.invalid/events","eventTypes":["lostfound.item.registered.v1"]}')
jq -e '.secret | test("^whsec_")' <<<"$hook" >/dev/null
endpoint=$(jq -r .endpoint.id <<<"$hook")
property_root=$(root_of "$property" "$group")
call "$API/properties/$property/lostfound/items" "${group_auth[@]}" \
  -d "{\"kind\":\"FOUND\",\"category\":\"KEYS\",\"colour\":\"SILVER\",\"description\":\"Keys at the pool bar\",\"locationId\":\"$property_root\"}" >/dev/null
# Outbox → relay → queue → inbox consumer → delivery row → the 30-second sweep signs and sends it.
for _ in $(seq 1 45); do
  attempt=$(call "$API/tenants/$tenant/webhooks/$endpoint/deliveries" "${group_auth[@]}" | jq -c '.[0] // empty')
  if [ -n "$attempt" ] && jq -e '.attempts >= 1' <<<"$attempt" >/dev/null; then break; fi
  sleep 2
done
echo "webhook: $(jq -c '{eventType, status, attempts, lastError}' <<<"${attempt:-{\}}")"
jq -e '.eventType == "lostfound.item.registered.v1" and .attempts >= 1 and .status == "PENDING" and .lastError != null' \
  <<<"${attempt:-{\}}" >/dev/null
echo "developer platform: OK"
