#!/usr/bin/env bash
# Phase 2 deployed-pipeline smoke (CI "pilot deployment smoke"): a simulated hotel agent enrolls at the agent gateway
# over mutual TLS and replays a stay; the platform must process every message and the worker must project the stay
# (gateway → integration inbox → outbox → relay → BullMQ → StayProjector). Needs a signed-in platform admin token.
# The scenario also leaves a second guest in house for the guest activation smoke (smoke-guest.sh).
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
API="${HOTELLA_API:-http://localhost:3000/api/v1}"
token="${1:?platform admin access token}"
auth=(-H "authorization: Bearer $token" -H 'content-type: application/json')
psql() { docker compose -p hotella-pilot -f "$DIR/../compose.pilot.yml" exec -T postgres psql -U hotella_admin -d hotella -Atc "$1"; }

tenant=$(curl -fsS "$API/tenants" "${auth[@]}" | jq -r '.[] | select(.code=="PILOT") | .id')
property=$(curl -fsS "$API/properties" "${auth[@]}" -d "{\"tenantId\":\"$tenant\",\"code\":\"SIM\",\"name\":\"Simulated Hotel\",\"timezone\":\"Africa/Cairo\",\"currency\":\"EGP\"}" | jq -r .id)
root=$(curl -fsS "$API/properties/$property/locations" "${auth[@]}" | jq -r 'if type=="array" then .[0].id else .id end')
for room in 504 505 506; do
  curl -fsS "$API/properties/$property/rooms" "${auth[@]}" -d "{\"parentId\":\"$root\",\"roomNumber\":\"$room\"}" >/dev/null
done
instance=$(curl -fsS "$API/properties/$property/integrations" "${auth[@]}" \
  -d '{"connectorCode":"SIM_PMS","name":"Simulator agent","capabilities":["CHECKIN_EVENT","CHECKOUT_EVENT","ROOM_MOVE_EVENT","PROFILE_EVENT","ROOM_STATUS_READ","RESERVATION_READ","GUEST_READ","RECONCILIATION_READ"]}' | jq -r .id)
curl -fsS -X PATCH "$API/properties/$property/integrations/$instance" "${auth[@]}" -d '{"version":1,"status":"ACTIVE"}' >/dev/null
curl -fsS -X POST "$API/properties/$property/integrations/$instance/mappings/rooms-by-number" "${auth[@]}" | jq -e '.created == 3' >/dev/null
enroll=$(curl -fsS -X POST "$API/properties/$property/integrations/$instance/enrollment-tokens" "${auth[@]}" | jq -r .token)

"$DIR/pilot.sh" simulate "$enroll" scenarios/pilot-stay.yml

curl -fsS "$API/properties/$property/integrations/$instance/agent" "${auth[@]}" | jq -e '.enrolled == true' >/dev/null
statuses=$(curl -fsS "$API/properties/$property/integrations/$instance/messages?limit=200" "${auth[@]}" | jq -r '[.[].status] | group_by(.) | map("\(.[0])=\(length)") | join(",")')
echo "integration messages: $statuses"
echo "$statuses" | grep -qv 'FAILED\|PENDING_MAPPING\|HELD\|RECEIVED' || { echo "unprocessed messages" >&2; exit 1; }

# The worker relays the canonical events and the StayProjector applies them (asynchronously).
stay_of() { psql "select s.id from guest.stays s join guest.reservation_references r on r.stay_id = s.id
  where s.property_id = '$property' and r.confirmation_number = '$1' limit 1"; }
for _ in $(seq 1 60); do
  state=$(psql "select string_agg(r.confirmation_number || '=' || s.status, ',' order by r.confirmation_number)
    from guest.stays s join guest.reservation_references r on r.stay_id = s.id where s.property_id = '$property'")
  [ "$state" = "SIM-C1=CHECKED_OUT,SIM-C2=IN_HOUSE" ] && break
  sleep 2
done
echo "stays: ${state:-none}"
[ "$state" = "SIM-C1=CHECKED_OUT,SIM-C2=IN_HOUSE" ]
stay1=$(stay_of SIM-C1)
# Room history: check-in 505, move 506 (closed at check-out), after the 504 pre-assignment when the reservation
# snapshot was projected first — events of one stay run concurrently, and a late, older snapshot is ignored.
history=$(psql "select string_agg(r.room_number || ':' || a.reason, ',' order by a.assigned_at, a.id)
  from guest.room_assignments a join org.rooms r on r.location_id = a.room_id where a.stay_id = '$stay1'")
echo "room history: $history"
case "$history" in
  "504:PRE_ASSIGNMENT,505:INITIAL,506:ROOM_MOVE" | "505:INITIAL,506:ROOM_MOVE") ;;
  *) echo "unexpected room history" >&2; exit 1 ;;
esac
echo "agent smoke: OK"
