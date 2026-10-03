#!/usr/bin/env bash
# Phase 4–6 deployed-pipeline smoke (CI "pilot deployment smoke"), after smoke-agent.sh left SIM-C2 in house:
# a general manager signs in, issues an activation link, the guest asks for a code (the OTP key is read from OpenBao;
# the SMS channel here cannot deliver), front desk confirms the guest in person, the guest gets a session and sees
# their stay (through the guest web app's BFF); the printable room QR sheet renders; the realtime gateway accepts a
# WebSocket upgrade; the staff and guest web apps render in both directions.
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
# The guest finishes on the deployed guest web app: its BFF keeps the session in an httpOnly cookie (the token never
# reaches the page) and its same-origin proxy turns the cookie into the guest session header.
GUEST_WEB="${HOTELLA_GUEST_WEB:-http://localhost:3200}"
done_body=$(curl -fsS -D "$DIR/.guest-headers" "$GUEST_WEB/bff/complete" "${json[@]}" -d "{\"handle\":\"$handle\"}")
grep -qi '^set-cookie: hotella_gs=.*httponly' "$DIR/.guest-headers"
# The cookie is Secure in production; send it back explicitly (plain HTTP on the runner).
cookie=(-H "cookie: $(grep -i '^set-cookie: hotella_gs=' "$DIR/.guest-headers" | sed -E 's/^[Ss]et-[Cc]ookie: ([^;]*).*/\1/' | tr -d '\r')")
rm -f "$DIR/.guest-headers"
jq -e 'has("sessionToken") | not' <<<"$done_body" >/dev/null
me=$(curl -fsS "${cookie[@]}" "$GUEST_WEB/hotella/guest/me")
echo "guest me: $(jq -c '{guest: .guest.givenName, stay: .stay.status, room: .stay.room.number, scopes: (.scopes | length)}' <<<"$me")"
jq -e '.stay.status == "IN_HOUSE" and .stay.room.number == "504" and (.scopes | index("CHAT"))' <<<"$me" >/dev/null

# M1 (BUILD_PLAN §9.4) on the deployed stack: the starter catalog, an Arabic request through the guest web, the
# housekeeping task done by staff, the worker completing the request and telling the guest in Arabic.
for dept in HK:Housekeeping ENG:Engineering FO:Front\ office; do
  curl -fsS "$API/properties/$property/departments" "${auth[@]}" \
    -d "{\"code\":\"${dept%%:*}\",\"translations\":[{\"locale\":\"en\",\"name\":\"${dept#*:}\"}]}" >/dev/null
done
curl -fsS "$API/properties/$property/catalog/starter" "${auth[@]}" -d '{}' | jq -e '.created | index("EXTRA_TOWELS")' >/dev/null
ar=(-H 'accept-language: ar')
curl -fsS "${cookie[@]}" "${ar[@]}" "$GUEST_WEB/hotella/guest/services" | grep -q 'مناشف إضافية'
ask() { curl -fsS "${cookie[@]}" "${ar[@]}" "${json[@]}" "$GUEST_WEB/hotella/guest/requests" -d '{"serviceCode":"EXTRA_TOWELS","fields":{"quantity":2}}'; }
first=$(ask)
jq -e '.related == false' <<<"$first" >/dev/null
request_id=$(jq -r .request.id <<<"$first")
work_item=$(jq -r .request.workItemId <<<"$first")
ask | jq -e --arg id "$request_id" '.related == true and .request.id == $id' >/dev/null
work=$(curl -fsS "$API/properties/$property/work-items/$work_item" "${auth[@]}")
jq -e '.departmentCode == "HK" and .serviceCode == "EXTRA_TOWELS"' <<<"$work" >/dev/null
task=$(jq -r '.tasks[0].id' <<<"$work")
for action in accept start complete; do
  curl -fsS "$API/properties/$property/tasks/$task/$action" "${auth[@]}" -d '{}' >/dev/null
done
status=""
for _ in $(seq 1 30); do
  status=$(curl -fsS "${cookie[@]}" "$GUEST_WEB/hotella/guest/requests/$request_id" | jq -r .status)
  [ "$status" = COMPLETED ] && break
  sleep 1
done
echo "request: $status"
[ "$status" = COMPLETED ]
told=""
for _ in $(seq 1 15); do
  told=$(curl -fsS "${cookie[@]}" "$GUEST_WEB/hotella/guest/conversation" |
    jq -r '[.messages[] | select(.senderType == "SYSTEM") | .body] | join(" | ")')
  grep -q 'تم: مناشف إضافية' <<<"$told" && break
  sleep 1
done
echo "guest told: $told"
grep -q 'تم: مناشف إضافية' <<<"$told"
# Every step is audited with a correlation id (the guest's ask, then the worker following the work).
[ "$(psql "select count(*) from audit.audit_log where entity_id = '$request_id' and correlation_id is not null
  and ((action = 'catalog.request.create' and actor_type = 'GUEST') or (action = 'catalog.request.status' and actor_type = 'SYSTEM'))")" -ge 2 ]
echo "M1 service request: OK"

# M2 (BUILD_PLAN 6.5) on the deployed stack: the same guest writes in natural language; the worker runs the Guest
# Concierge on background-ai through the real OPENAI_COMPATIBLE adapter (a stand-in model on the backend network),
# which creates AC_PROBLEM for Engineering and answers in Arabic; the execution is on record.
compose() { docker compose -p hotella-pilot -f "$DIR/../compose.pilot.yml" "$@"; }
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
compose --profile tools up -d model-mock >/dev/null
provider=$(call "$API/ai/providers" -H "authorization: Bearer $admin" "${json[@]}" \
  -d '{"code":"PILOT_MODEL_MOCK","kind":"OPENAI_COMPATIBLE","baseUrl":"http://model-mock:8080/v1","egress":"ON_PREM","maxDataClass":"CONFIDENTIAL"}' | jq -r .id)
model=$(call "$API/ai/models" -H "authorization: Bearer $admin" "${json[@]}" \
  -d "{\"providerId\":\"$provider\",\"code\":\"concierge-mock\",\"capabilities\":[\"REASONING_HIGH\"]}" | jq -r .id)
# The stand-in is the installation's on-prem model: the platform default route (a property GM cannot change the
# tenant-wide routing; ai.routing.manage needs a tenant-wide membership).
call -X PUT "$API/ai/routing-rules/platform" -H "authorization: Bearer $admin" "${json[@]}" \
  -d "{\"capability\":\"REASONING_HIGH\",\"modelIds\":[\"$model\"]}" >/dev/null
conversation=$(call "${cookie[@]}" "$GUEST_WEB/hotella/guest/conversation" | jq -r .conversation.id)
call "$API/properties/$property/conversations/$conversation/ai-mode" "${auth[@]}" -d '{"mode":"AUTO"}' |
  jq -e '.aiMode == "AUTO"' >/dev/null
call "${cookie[@]}" "${json[@]}" "$GUEST_WEB/hotella/guest/conversation/messages" -d '{"body":"الجو حر أوي هنا"}' >/dev/null
answered=""
for _ in $(seq 1 60); do
  answered=$(call "${cookie[@]}" "$GUEST_WEB/hotella/guest/conversation" |
    jq -r '[.messages[] | select(.senderType == "AI") | .body] | last // ""')
  [ -n "$answered" ] && break
  sleep 1
done
echo "concierge answered: $answered"
grep -q 'التكييف' <<<"$answered"
call "${cookie[@]}" "$GUEST_WEB/hotella/guest/requests" | jq -e '[.[] | select(.serviceCode == "AC_PROBLEM")] | length == 1' >/dev/null
execution=$(call "$API/properties/$property/ai/executions?conversationId=$conversation&limit=1" "${auth[@]}" | jq '.[0]')
echo "execution: $(jq -c '{agentCode, status, tokensIn, trigger}' <<<"$execution")"
jq -e '.status == "COMPLETED" and .agentCode == "GUEST_CONCIERGE" and .tokensIn == 360' <<<"$execution" >/dev/null
[ "$(psql "select count(*) from audit.audit_log a join catalog.service_requests r on r.id::text = a.entity_id
  where r.property_id = '$property' and r.service_code = 'AC_PROBLEM' and a.action = 'catalog.request.create' and a.actor_type = 'AI_AGENT'")" = 1 ]
echo "M2 concierge: OK"

# Housekeeping (BUILD_PLAN 7.4) on the deployed stack: SIM-C1's check-out from 506 (2026-10-06, before the property had
# departments, so its work is unrouted) made the room dirty and created its CHECKOUT clean; the GM takes and finishes
# it, and the worker moves the room to CLEAN, which makes it ready.
hk="$API/properties/$property/housekeeping"
job=$(call "$hk/jobs?day=2026-10-06" "${auth[@]}" |
  jq -c '[.[] | select(.roomNumber == "506" and .cleaningType == "CHECKOUT")] | first')
echo "checkout clean: $(jq -c '{cleaningType, credits, status}' <<<"$job")"
jq -e '.status == "OPEN" and .credits == 1' <<<"$job" >/dev/null
for action in start complete; do
  call "$API/properties/$property/tasks/$(jq -r .taskId <<<"$job")/$action" "${auth[@]}" -d '{}' >/dev/null
done
room=""
for _ in $(seq 1 30); do
  room=$(call "$hk/rooms" "${auth[@]}" | jq -r '.[] | select(.roomNumber == "506") | "\(.housekeeping) ready=\(.ready)"')
  [ "$room" = "CLEAN ready=true" ] && break
  sleep 1
done
echo "room 506 after its clean: $room"
[ "$room" = "CLEAN ready=true" ]
echo "housekeeping: OK"
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
# The staff web portal: both directions render, and its BFF signs the manager in against the deployed API (refresh
# token only in an httpOnly cookie) and proxies API calls on the same origin.
WEB="${HOTELLA_STAFF_WEB:-http://localhost:3100}"
curl -fsS "$WEB/en/login" | grep -q 'dir="ltr"'
curl -fsS "$WEB/ar/login" | grep -q 'dir="rtl"'
bff=$(curl -fsS -D "$DIR/.bff-headers" "$WEB/bff/login" "${json[@]}" \
  -d "{\"tenantCode\":\"PILOT\",\"email\":\"gm@pilot.example\",\"password\":\"$password\"}")
grep -qi '^set-cookie: hotella_rt=.*httponly' "$DIR/.bff-headers"; rm -f "$DIR/.bff-headers"
jq -e 'has("refreshToken") | not' <<<"$bff" >/dev/null
curl -fsS "$WEB/hotella/properties/$property/conversations" -H "authorization: Bearer $(jq -r .accessToken <<<"$bff")" | jq -e 'type == "array"' >/dev/null
echo "staff web: OK"
# The guest web app renders both directions and its proxy serves guest routes only.
curl -fsS "$GUEST_WEB/en" | grep -q 'dir="ltr"'
curl -fsS "$GUEST_WEB/ar" | grep -q 'dir="rtl"'
[ "$(curl -s -o /dev/null -w '%{http_code}' "${cookie[@]}" "$GUEST_WEB/hotella/properties")" = 404 ]
curl -fsS "${cookie[@]}" -X POST "$GUEST_WEB/bff/logout" -o /dev/null
# Signing out ended the session on the API, not only the cookie.
[ "$(curl -s -o /dev/null -w '%{http_code}' "${cookie[@]}" "$GUEST_WEB/hotella/guest/me")" = 401 ]
echo "guest web: OK"
echo "guest smoke: OK"
