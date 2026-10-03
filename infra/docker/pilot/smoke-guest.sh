#!/usr/bin/env bash
# Phase 4 deployed-pipeline smoke (CI "pilot deployment smoke"), after smoke-agent.sh left SIM-C2 in house:
# a general manager signs in, issues an activation link, the guest asks for a code (the OTP key is read from OpenBao;
# the SMS channel here cannot deliver), front desk confirms the guest in person, the guest gets a session and sees
# their stay; the printable room QR sheet renders; the realtime gateway accepts a WebSocket upgrade.
# Needs a signed-in platform admin token.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
API="${HOTELLA_API:-http://localhost:3000/api/v1}"
admin="${1:?platform admin access token}"
json=(-H 'content-type: application/json')
psql() { docker compose -p hotella-pilot -f "$DIR/../compose.pilot.yml" exec -T postgres psql -U hotella_admin -d hotella -Atc "$1"; }

tenant=$(curl -fsS "$API/tenants" -H "authorization: Bearer $admin" | jq -r '.[] | select(.code=="PILOT") | .id')
property=$(psql "select id from org.properties where tenant_id = '$tenant' and code = 'SIM'")
stay=$(psql "select s.id from guest.stays s join guest.reservation_references r on r.stay_id = s.id
  where s.property_id = '$property' and r.confirmation_number = 'SIM-C2' and s.status = 'IN_HOUSE'")
[ -n "$stay" ] || { echo "no in-house stay SIM-C2" >&2; exit 1; }

# A general manager of the property (invitation accepted with a password), signed in.
password='pilot guest smoke passphrase 2026'
invite=$(curl -fsS "$API/tenants/$tenant/users" -H "authorization: Bearer $admin" "${json[@]}" \
  -d "{\"email\":\"gm@pilot.example\",\"givenName\":\"Pilot GM\",\"memberships\":[{\"propertyId\":\"$property\",\"roleCodes\":[\"GENERAL_MANAGER\"]}]}" |
  jq -r .invitation.token)
curl -fsS "$API/auth/invitations/accept" "${json[@]}" -d "{\"token\":\"$invite\",\"password\":\"$password\"}" >/dev/null
gm=$(curl -fsS "$API/auth/login" "${json[@]}" -d "{\"tenantCode\":\"PILOT\",\"email\":\"gm@pilot.example\",\"password\":\"$password\"}" | jq -r .accessToken)
auth=(-H "authorization: Bearer $gm" "${json[@]}")

# An SMS channel whose provider cannot deliver: the code is still derived (OTP key from OpenBao) and the failure is
# recorded, so the guest falls back to front desk.
curl -fsS "$API/properties/$property/channels" "${auth[@]}" \
  -d '{"type":"SMS","name":"SMS (smoke)","providerCode":"SMS_HTTP_JSON","config":{"url":"http://api:3000/api/v1/health","senderId":"HOTELLA"},"credentialRef":"vault://kv/hotella/app#otp_hmac_key"}' >/dev/null

link=$(curl -fsS "$API/properties/$property/stays/$stay/activation-tokens" "${auth[@]}" -d '{}')
token=$(jq -r .token <<<"$link")
jq -e '.url | test("/a/")' <<<"$link" >/dev/null
curl -fsS "$API/guest/activation/start" "${json[@]}" -d "{\"token\":\"$token\"}" | jq -e '.propertyId' >/dev/null
otp=$(curl -fsS "$API/guest/activation/otp/request" "${json[@]}" -d "{\"token\":\"$token\",\"phone\":\"+201001234567\"}")
echo "otp request: $(jq -c '{sentVia, reference}' <<<"$otp")"
handle=$(jq -r .handle <<<"$otp")
reference=$(jq -r .reference <<<"$otp")
psql "select count(*) from comms.verification_deliveries d join comms.verification_sessions s on s.id = d.session_id
  where s.reference = '$reference' and d.status = 'FAILED'" | grep -qv '^0$'

session=$(curl -fsS "$API/properties/$property/verification-sessions?reference=$reference" "${auth[@]}" | jq -r '.[0].id')
curl -fsS "$API/properties/$property/verification-sessions/$session/assist" "${auth[@]}" \
  -d '{"reason":"Identity confirmed at the front desk (pilot smoke)"}' | jq -e '.verified == true' >/dev/null
guest=$(curl -fsS "$API/guest/activation/complete" "${json[@]}" -d "{\"handle\":\"$handle\",\"device\":\"smoke\"}" | jq -r .sessionToken)
me=$(curl -fsS "$API/guest/me" -H "x-guest-session: $guest")
echo "guest me: $(jq -c '{guest: .guest.givenName, stay: .stay.status, room: .stay.room.number, scopes: (.scopes | length)}' <<<"$me")"
jq -e '.stay.status == "IN_HOUSE" and .stay.room.number == "504" and (.scopes | index("CHAT"))' <<<"$me" >/dev/null
# The link was single use.
[ "$(curl -s -o /dev/null -w '%{http_code}' "$API/guest/activation/start" "${json[@]}" -d "{\"token\":\"$token\"}")" = 410 ]

# Printable room QR sheet.
curl -fsS "$API/properties/$property/room-qr-codes/sheet" "${auth[@]}" -d '{}' | grep -c '<svg' | grep -qx 3

# The realtime gateway answers a WebSocket upgrade on the API port.
status=$(curl -s --http1.1 -o /dev/null -w '%{http_code}' --max-time 3 "$API/realtime" \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
  -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' || true)
echo "realtime upgrade: $status"
[ "$status" = 101 ]
echo "guest smoke: OK"
