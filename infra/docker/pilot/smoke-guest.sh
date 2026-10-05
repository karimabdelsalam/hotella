#!/usr/bin/env bash
# Phase 4–9, 12 and 13 deployed-pipeline smoke (CI "pilot deployment smoke"), after smoke-agent.sh left SIM-C2 in house:
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

# Engineering (BUILD_PLAN 8.4) on the deployed stack: the guest's AC_PROBLEM request from M2 becomes a corrective work
# order on the fan-coil unit of their room; the Engineering Copilot answers about that unit through the same on-prem
# model adapter (it only reads, through engineering's tools); the engineer codes and closes the work; arrivals are
# scored by the rules.
eng="$API/properties/$property/eng"
# Failure codes and equipment types are the hotel group's (tenant-wide): its chief engineer sets them up.
chief_invite=$(curl -fsS "$API/tenants/$tenant/users" -H "authorization: Bearer $admin" "${json[@]}" \
  -d '{"email":"chief@pilot.example","givenName":"Pilot Chief Engineer","memberships":[{"propertyId":null,"roleCodes":["CHIEF_ENGINEER"]}]}' |
  jq -r .invitation.token)
curl -fsS "$API/auth/invitations/accept" "${json[@]}" -d "{\"token\":\"$chief_invite\",\"password\":\"$password\"}" >/dev/null
chief=$(curl -fsS "$API/auth/login" "${json[@]}" -d "{\"tenantCode\":\"PILOT\",\"email\":\"chief@pilot.example\",\"password\":\"$password\"}" | jq -r .accessToken)
chief_auth=(-H "authorization: Bearer $chief" "${json[@]}")
call -X POST "$API/eng/failure-codes/starter" "${chief_auth[@]}" >/dev/null
fcu=$(call "$API/eng/asset-types" "${chief_auth[@]}" \
  -d '{"code":"FCU","translations":[{"locale":"en","name":"Fan-coil unit"},{"locale":"ar","name":"وحدة ملف مروحة"}]}' | jq -r .id)
work_item=$(psql "select work_item_id from catalog.service_requests where property_id = '$property' and service_code = 'AC_PROBLEM'")
guest_room=$(psql "select location_id from ops.work_items where id = '$work_item'")
asset=$(call "$eng/assets" "${auth[@]}" \
  -d "{\"assetNumber\":\"FCU-SMOKE\",\"assetTypeId\":\"$fcu\",\"locationId\":\"$guest_room\",\"name\":\"Guest room fan-coil\"}" | jq -r .id)
order=$(call "$eng/work-orders/from-request" "${auth[@]}" -d "{\"workItemId\":\"$work_item\",\"symptomCode\":\"NOT_COOLING\"}")
echo "work order: $(jq -c '{number, type, source, status}' <<<"$order")"
jq -e --arg asset "$asset" '.assetId == $asset and .source == "GUEST_REQUEST" and .type == "CORRECTIVE"' <<<"$order" >/dev/null
copilot=$(call "$eng/copilot" "${auth[@]}" -d "{\"question\":\"Why is this unit not cooling?\",\"assetId\":\"$asset\"}")
echo "copilot: $(jq -c '{outcome, answer}' <<<"$copilot")"
jq -e '.outcome == "ANSWERED" and (.answer | contains("FCU-SMOKE"))' <<<"$copilot" >/dev/null
call "$API/properties/$property/ai/executions/$(jq -r .executionId <<<"$copilot")" "${auth[@]}" |
  jq -e '.agentCode == "ENGINEERING_COPILOT" and .trigger == "STAFF" and .status == "COMPLETED"
    and ([.steps[] | select(.type == "TOOL_CALL" and .outcome == "OK")] | length) == 1' >/dev/null
call "$eng/work-orders/$(jq -r .id <<<"$order")/complete" "${auth[@]}" \
  -d '{"failureModeCode":"COMPRESSOR_NOT_STARTING","causeCode":"CAPACITOR_FAILED","resolutionCode":"CAPACITOR_REPLACED"}' |
  jq -e '.status == "DONE"' >/dev/null
call "$hk/arrival-risk?day=tomorrow" "${auth[@]}" | jq -e '(.arrivals | type) == "array"' >/dev/null
echo "engineering: OK"

# Phase 9 (BUILD_PLAN 9.4) on the deployed stack. Checklists and complaint categories are the hotel group's
# (tenant-wide): its general manager sets them up and decides approvals; the property's GM works the hotel.
group_invite=$(curl -fsS "$API/tenants/$tenant/users" -H "authorization: Bearer $admin" "${json[@]}" \
  -d '{"email":"group-gm@pilot.example","givenName":"Pilot Group GM","memberships":[{"propertyId":null,"roleCodes":["GENERAL_MANAGER"]}]}' |
  jq -r .invitation.token)
curl -fsS "$API/auth/invitations/accept" "${json[@]}" -d "{\"token\":\"$group_invite\",\"password\":\"$password\"}" >/dev/null
group=$(curl -fsS "$API/auth/login" "${json[@]}" -d "{\"tenantCode\":\"PILOT\",\"email\":\"group-gm@pilot.example\",\"password\":\"$password\"}" | jq -r .accessToken)
group_auth=(-H "authorization: Bearer $group" "${json[@]}")
P="$API/properties/$property"
# Inspections: a published room checklist, run on the guest's room; a critical failure opens urgent work at once.
template=$(call "$API/inspection/templates" "${group_auth[@]}" -d '{"code":"ROOM_SAFETY","scope":"ROOM","departmentCode":"ENG",
  "names":[{"locale":"en","name":"Room safety"},{"locale":"ar","name":"سلامة الغرفة"}],
  "sections":[{"code":"SAFETY","titles":[{"locale":"en","title":"Safety"}],"items":[
    {"code":"SMOKE_DETECTOR","rule":{"kind":"PASS_FAIL","failSeverity":"CRITICAL"},"labels":[{"locale":"en","label":"Smoke detector works"}]},
    {"code":"DOOR_LOCK","rule":{"kind":"YES_NO","expected":"YES"},"labels":[{"locale":"en","label":"Door locks"}]}]}]}')
call -X POST "$API/inspection/templates/versions/$(jq -r .draftVersionId <<<"$template")/publish" "${group_auth[@]}" >/dev/null
# The hotel's GM (a property membership) sees the group's published checklist from the hotel.
call "$P/inspection-templates" "${auth[@]}" | jq -e '[.[] | select(.code == "ROOM_SAFETY" and .publishedVersionNo == 1)] | length == 1' >/dev/null
inspection=$(call "$P/inspections" "${auth[@]}" -d "{\"templateId\":\"$(jq -r .id <<<"$template")\",\"locationId\":\"$guest_room\"}" | jq -r .id)
call -X PUT "$P/inspections/$inspection/answers" "${auth[@]}" -d '{"itemCode":"SMOKE_DETECTOR","answer":{"kind":"PASS_FAIL","value":"FAIL"}}' >/dev/null
call -X PUT "$P/inspections/$inspection/answers" "${auth[@]}" -d '{"itemCode":"DOOR_LOCK","answer":{"kind":"YES_NO","value":"YES"}}' >/dev/null
call -X POST "$P/inspections/$inspection/complete" "${auth[@]}" >/dev/null
completed=$(call "$P/inspections/$inspection" "${auth[@]}")
echo "inspection: $(jq -c '{result, score, findings: [.findings[] | {severity, status}]}' <<<"$completed")"
jq -e '.result == "FAIL" and ([.findings[] | select(.severity == "CRITICAL" and .status == "LINKED")] | length) == 1' <<<"$completed" >/dev/null
echo "inspections: OK"
# Guest relations: the group's categories, a complaint on the stay, a discount that waits for the group GM's approval.
call -X POST "$API/relations/categories/starter" "${group_auth[@]}" | jq -e '.created >= 8' >/dev/null
noise=$(call "$P/complaint-categories" "${auth[@]}" | jq -r '.[] | select(.code == "NOISE") | .id')
complaint=$(call "$P/complaints" "${auth[@]}" -d "{\"categoryId\":\"$noise\",\"summary\":\"Loud music next door after midnight\",\"stayId\":\"$stay\"}")
recovery=$(call "$P/complaints/$(jq -r .id <<<"$complaint")/recovery" "${auth[@]}" -d '{"kind":"DISCOUNT","amountMinor":20000,"note":"One night"}')
jq -e '.status == "PENDING_APPROVAL"' <<<"$recovery" >/dev/null
call "$P/approvals/$(jq -r .approvalId <<<"$recovery")/decision" "${group_auth[@]}" -d '{"decision":"APPROVE"}' >/dev/null
call "$P/complaints/$(jq -r .id <<<"$complaint")" "${auth[@]}" | jq -e '.recovery[0].status == "DONE" and .number == 1' >/dev/null
echo "guest relations: OK"
# Lost & Found: a phone found in the guest's room matches the guest's report by rules; it goes back against a claim.
found=$(call "$P/lostfound/items" "${auth[@]}" -d "{\"kind\":\"FOUND\",\"category\":\"PHONE\",\"colour\":\"BLACK\",\"brand\":\"Samsung\",\"description\":\"Black phone under the bed\",\"locationId\":\"$guest_room\"}")
call "$P/lostfound/items" "${auth[@]}" -d "{\"kind\":\"LOST\",\"category\":\"PHONE\",\"colour\":\"BLACK\",\"description\":\"Guest lost a black Samsung phone\",\"stayId\":\"$stay\"}" >/dev/null
match=$(call "$P/lostfound/matches" "${auth[@]}" | jq -c '.[0]')
echo "match: $(jq -c '{score, reasons}' <<<"$match")"
call -X POST "$P/lostfound/matches/$(jq -r .id <<<"$match")/confirm" "${auth[@]}" -d "{\"version\":$(jq .version <<<"$match")}" >/dev/null
call -X POST "$P/lostfound/items/$(jq -r .id <<<"$found")/release" "${auth[@]}" \
  -d '{"version":2,"claimantName":"Pilot Guest","stayId":"'"$stay"'","idDocument":"PASSPORT","verificationNote":"Unlocked the phone at the desk"}' |
  jq -e '.item.status == "RELEASED"' >/dev/null
echo "lost & found: OK"
# Logbook: an incident on the running shift; the SHIFT_HANDOVER assistant drafts the handover from facts the platform
# counted (through the same on-prem model adapter, reading only through the logbook's tool); the group GM takes over.
call "$P/logbook/entries" "${auth[@]}" -d "{\"departmentCode\":\"ENG\",\"kind\":\"INCIDENT\",\"text\":\"Smoke detector failed in the guest room\",\"roomId\":\"$guest_room\"}" >/dev/null
handover=$(call "$P/logbook/handovers" "${auth[@]}" -d '{"departmentCode":"ENG"}')
echo "handover: $(jq -c '{source, summary, work: .facts.work, entries: .facts.entries}' <<<"$handover")"
jq -e '.source == "AI" and .facts.entries.incidents == 1 and (.summary | contains("1 incident"))' <<<"$handover" >/dev/null
call "$P/ai/executions/$(jq -r .executionId <<<"$handover")" "${auth[@]}" |
  jq -e '.agentCode == "SHIFT_HANDOVER" and .status == "COMPLETED"
    and ([.steps[] | select(.type == "TOOL_CALL" and .outcome == "OK")] | length) == 1' >/dev/null
[ "$(curl -s -o /dev/null -w '%{http_code}' "$P/logbook/handovers/$(jq -r .id <<<"$handover")/acknowledge" "${auth[@]}" -d '{"version":1}')" = 409 ]
call "$P/logbook/handovers/$(jq -r .id <<<"$handover")/acknowledge" "${group_auth[@]}" -d '{"version":1}' |
  jq -e '.status == "ACKNOWLEDGED"' >/dev/null
echo "logbook: OK"
# Intelligence (Phase 12): the worker's twin consumer projected the stay and its room from the events the stack
# produced; the detectors run; the pulse and the AI quality of today are counted by code, through the deployed api.
for _ in $(seq 1 30); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$P/twin/stay/$stay?depth=2" "${auth[@]}")" = 200 ] && break
  sleep 1
done
twin=$(call "$P/twin/stay/$stay?depth=2" "${auth[@]}")
echo "twin: $(jq -c '{root: .root.kind, nodes: [.nodes[].kind] | group_by(.) | map({(.[0]): length}) | add}' <<<"$twin")"
jq -e '.root.kind == "STAY" and ([.nodes[] | select(.kind == "LOCATION")] | length) >= 1' <<<"$twin" >/dev/null
call "$P/insights/detect" "${auth[@]}" -d '{}' | jq -e 'has("raised") and has("expired")' >/dev/null
call "$P/insights" "${auth[@]}" | jq -e 'type == "array"' >/dev/null
pulse=$(call "$P/ai/pulse" "${auth[@]}")
echo "pulse: $(jq -c '{work: .openWork.total, complaints: .openComplaints.total, arrivals: .arrivalsTomorrow.count}' <<<"$pulse")"
jq -e '(.openWork.total | type) == "number" and (.arrivalsTomorrow.count | type) == "number"' <<<"$pulse" >/dev/null
call "$P/ai/quality/recompute" "${auth[@]}" -d "{\"day\":\"$(date -u +%F)\"}" | jq -e '.metrics >= 1' >/dev/null
call "$P/ai/quality?from=$(date -u +%F)&to=$(date -u +%F)" "${auth[@]}" |
  jq -e '[.[] | select(.metric == "executions")] | length >= 1' >/dev/null
echo "intelligence: OK"
# Building telemetry (Phase 13): a BMS gateway posts signed sample batches to its inbound endpoint (Connector SDK v2);
# the worker keeps minute aggregates, a threshold rule raises an alarm with an alert and predictive work, and the
# alarm clears once the value is back below the clear level (hysteresis).
admin_auth=(-H "authorization: Bearer $admin" "${json[@]}")
bms=$(call "$API/properties/$property/integrations" "${admin_auth[@]}" \
  -d '{"connectorCode":"BMS_STANDARD","name":"Pilot BMS","capabilities":["TELEMETRY_READ"]}' | jq -r .id)
call -X PATCH "$API/properties/$property/integrations/$bms" "${admin_auth[@]}" -d '{"version":1,"status":"ACTIVE"}' >/dev/null
inbound=$(call "$API/properties/$property/integrations/$bms/inbound-endpoints" "${admin_auth[@]}" -d '{}')
endpoint=$(jq -r .endpoint.id <<<"$inbound")
secret=$(jq -r .secret <<<"$inbound")
point=$(call "$P/eng/telemetry/points" "${auth[@]}" -d "{\"instanceId\":\"$bms\",\"externalCode\":\"CH-1.SUPPLY_T\",\"locationId\":\"$(psql "select id from org.locations where property_id = '$property' and parent_id is null")\",\"quantity\":\"TEMPERATURE\",\"unit\":\"°C\"}" | jq -r .id)
call "$P/eng/telemetry/rules" "${auth[@]}" \
  -d "{\"pointId\":\"$point\",\"kind\":\"THRESHOLD\",\"params\":{\"above\":8,\"clear_at\":7},\"severity\":\"CRITICAL\",\"action\":\"WORK_ORDER\"}" >/dev/null
post_samples() {
  local body t sig
  body="{\"messages\":[{\"message_type\":\"TELEMETRY_BATCH\",\"source_message_id\":\"pilot-bms-$2\",\"payload\":{\"samples\":[{\"point\":\"CH-1.SUPPLY_T\",\"value\":$1,\"at\":\"$3\"}]}}]}"
  t=$(date -u +%s)
  sig=$(printf '%s.%s' "$t" "$body" | openssl dgst -sha256 -hmac "$secret" -hex | sed 's/^.* //')
  call "$API/integrations/inbound/$endpoint" "${json[@]}" -H "x-hotella-signature: t=$t,v1=$sig" -d "$body" |
    jq -e '.results[0].status == "PROCESSED"' >/dev/null
}
# A forged batch is refused before anything is stored.
[ "$(curl -s -o /dev/null -w '%{http_code}' "$API/integrations/inbound/$endpoint" "${json[@]}" \
  -H "x-hotella-signature: t=$(date -u +%s),v1=$(printf '0%.0s' $(seq 1 64))" -d '{"messages":[]}')" = 401 ]
post_samples 9.5 1 "$(date -u -d '-2 minutes' +%FT%TZ)"
for _ in $(seq 1 30); do
  alarm=$(call "$P/eng/telemetry/alarms?live=true" "${auth[@]}" | jq -c "[.[] | select(.pointId == \"$point\")][0] // empty")
  [ -n "$alarm" ] && break
  sleep 1
done
echo "telemetry alarm: $(jq -c '{status, value, workOrder: (.workOrderId != null)}' <<<"$alarm")"
jq -e '.status == "OPEN" and .value == 9.5 and .workOrderId != null' <<<"$alarm" >/dev/null
[ "$(psql "select type || '/' || source from eng.work_orders where id = '$(jq -r .workOrderId <<<"$alarm")'")" = PREDICTIVE/TELEMETRY ]
[ "$(psql "select count(*) from ops.alerts where dedupe_key = 'telemetry:$(jq -r .id <<<"$alarm")'")" = 1 ]
post_samples 6.5 2 "$(date -u -d '-1 minutes' +%FT%TZ)"
for _ in $(seq 1 30); do
  [ "$(call "$P/eng/telemetry/alarms" "${auth[@]}" | jq -r "[.[] | select(.id == $(jq .id <<<"$alarm"))][0].status")" = CLEARED ] && break
  sleep 1
done
[ "$(call "$P/eng/telemetry/alarms" "${auth[@]}" | jq -r "[.[] | select(.id == $(jq .id <<<"$alarm"))][0].status")" = CLEARED ]
echo "telemetry: OK"
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
for page in en/engineering ar/engineering en/arrivals ar/arrivals ar/branding en/inspections ar/relations \
  en/lostfound ar/logbook en/intelligence ar/intelligence en/telemetry ar/telemetry en/keys ar/keys; do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$WEB/$page")" = 200 ]
done
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
