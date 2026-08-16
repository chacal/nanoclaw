#!/bin/bash
# Query Home Assistant REST API.
#
# The shim calls HA directly. Authorization is injected by OneCLI's
# gateway using a host-pattern secret (configure with
# `onecli secrets create --type api_key --value <token>
# --host-pattern <ha-host>` at install time). The container never sees
# the HA token.
#
# Usage:
#   ha-api GET /api/states/sensor.nordpool
#   ha-api POST /api/services/light/turn_on '{"entity_id":"light.kitchen"}'
#   ha-api GET /api/history/period/2026-03-22T00:00:00Z?filter_entity_id=sensor.temp

set -euo pipefail

METHOD="${1:-}"
ENDPOINT="${2:-}"
BODY="${3:-}"

if [ -z "$METHOD" ] || [ -z "$ENDPOINT" ]; then
  echo "Usage: ha-api <METHOD> <endpoint> [json_body]" >&2
  echo "Examples:" >&2
  echo "  ha-api GET /api/states/sensor.nordpool" >&2
  echo "  ha-api POST /api/services/light/turn_on '{\"entity_id\":\"light.kitchen\"}'" >&2
  exit 1
fi

if [ -z "${HA_BASE_URL:-}" ]; then
  echo "Error: HA_BASE_URL environment variable not set (the host has not enabled HA for this install)" >&2
  exit 1
fi

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

curl "${CURL_ARGS[@]}" "${HA_BASE_URL}${ENDPOINT}"
