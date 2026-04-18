#!/bin/bash
# Query Home Assistant REST API via credential proxy.
# Auth is handled by the host-side proxy; containers never see HA tokens.
#
# Usage:
#   ha-api.sh GET /api/states/sensor.nordpool
#   ha-api.sh POST /api/services/light/turn_on '{"entity_id":"light.kitchen"}'
#   ha-api.sh GET /api/history/period/2026-03-22T00:00:00Z?filter_entity_id=sensor.temp

set -euo pipefail

METHOD="${1:-}"
ENDPOINT="${2:-}"
BODY="${3:-}"

if [ -z "$METHOD" ] || [ -z "$ENDPOINT" ]; then
  echo "Usage: ha-api.sh <METHOD> <endpoint> [json_body]" >&2
  echo "Examples:" >&2
  echo "  ha-api.sh GET /api/states/sensor.nordpool" >&2
  echo "  ha-api.sh POST /api/services/light/turn_on '{\"entity_id\":\"light.kitchen\"}'" >&2
  exit 1
fi

if [ -z "${HA_API_URL:-}" ]; then
  echo "Error: HA_API_URL environment variable not set" >&2
  exit 1
fi

HA_BASE="${HA_API_URL}"

CURL_ARGS=(
  -sf
  -X "$METHOD"
  -H "Content-Type: application/json"
)

if [ -n "$BODY" ]; then
  # --data-raw (not -d / --data): `-d @file` would read a local file when the
  # body starts with '@'. We pass the body literally, as advertised.
  CURL_ARGS+=(--data-raw "$BODY")
fi

curl "${CURL_ARGS[@]}" "${HA_BASE}${ENDPOINT}"
