#!/usr/bin/env bash
# Phase 11 licensing for a pilot tenant (and the CI "pilot deployment smoke"): through the control plane, publish a
# plan that carries the whole catalog once (code PILOT_ALL) and subscribe the tenant to it, so the real entitlement
# stage lets the hotel use every module. Idempotent: an existing plan or an in-force subscription is reused.
# Needs a signed-in platform admin token. Usage: license-pilot.sh <token> [TENANT_CODE=PILOT]
set -euo pipefail
API="${HOTELLA_API:-http://localhost:3000/api/v1}"
token="${1:?platform admin access token}"
code="${2:-PILOT}"
auth=(-H "authorization: Bearer $token" -H 'content-type: application/json')

tenant=$(curl -fsS "$API/tenants" "${auth[@]}" | jq -r --arg c "$code" '.[] | select(.code==$c) | .id')
[ -n "$tenant" ] || { echo "tenant $code not found" >&2; exit 1; }

plan=$(curl -fsS "$API/control/license/plans" "${auth[@]}" | jq -r '.[] | select(.code=="PILOT_ALL") | .id')
if [ -z "$plan" ]; then
  created=$(curl -fsS "$API/control/license/plans" "${auth[@]}" \
    -d '{"code":"PILOT_ALL","translations":[{"locale":"en","name":"Pilot (all modules)"},{"locale":"ar","name":"التجربة (كل الوحدات)"}]}')
  plan=$(echo "$created" | jq -r .id)
  draft=$(echo "$created" | jq -c '.versions[0]')
  items=$(curl -fsS "$API/control/license/catalog" "${auth[@]}" \
    | jq -c '[.capabilities[] | select(.status=="ACTIVE" and .kind!="FEATURE") | .code]')
  saved=$(curl -fsS -X PUT "$API/control/license/plans/$plan/versions/$(echo "$draft" | jq -r .id)" "${auth[@]}" \
    -d "{\"version\":$(echo "$draft" | jq .version),\"notes\":\"Pilot: every module\",\"items\":$items}")
  curl -fsS "$API/control/license/plans/$plan/versions/$(echo "$saved" | jq -r .id)/publish" "${auth[@]}" \
    -d "{\"version\":$(echo "$saved" | jq .version)}" | jq -e '.status == "PUBLISHED"' >/dev/null
fi
version=$(curl -fsS "$API/control/license/plans/$plan" "${auth[@]}" \
  | jq -r '[.versions[] | select(.status=="PUBLISHED")][0].id')

in_force=$(curl -fsS "$API/control/tenants/$tenant/subscriptions" "${auth[@]}" \
  | jq '[.[] | select(.status=="ACTIVE" or .status=="TRIAL")] | length')
if [ "$in_force" = "0" ]; then
  curl -fsS "$API/control/tenants/$tenant/subscriptions" "${auth[@]}" \
    -d "{\"planVersionId\":\"$version\",\"reason\":\"Pilot licence\"}" | jq -e '.status == "ACTIVE"' >/dev/null
fi
curl -fsS "$API/control/tenants/$tenant/entitlements" "${auth[@]}" \
  | jq -e '[.entitlements[].code] | index("CORE") and index("HOUSEKEEPING") and index("CONNECTOR_PMS")' >/dev/null
echo "tenant $code licensed with PILOT_ALL"
