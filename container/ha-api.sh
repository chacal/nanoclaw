#!/bin/bash
# Query Home Assistant REST API directly.
# Reads HA URL and auth token from the project's .mcp.json.
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

# Find .mcp.json in workspace
MCP_FILE="/workspace/group/.mcp.json"
if [ ! -f "$MCP_FILE" ]; then
  echo "Error: $MCP_FILE not found" >&2
  exit 1
fi

# Extract HA URL and auth token from .mcp.json using Node (jq not available)
read -r HA_MCP_URL AUTH_HEADER < <(node -e "
  const c = require('$MCP_FILE');
  const ha = c.mcpServers?.homeassistant;
  console.log(ha?.url || '', ha?.headers?.Authorization || '');
")

if [ -z "$HA_MCP_URL" ] || [ -z "$AUTH_HEADER" ]; then
  echo "Error: Home Assistant MCP config not found in $MCP_FILE" >&2
  exit 1
fi

# Derive REST API base URL from MCP URL (strip /api/mcp suffix)
HA_BASE="${HA_MCP_URL%/api/mcp}"

CURL_ARGS=(
  -sf
  -X "$METHOD"
  -H "Authorization: $AUTH_HEADER"
  -H "Content-Type: application/json"
)

if [ -n "$BODY" ]; then
  CURL_ARGS+=(-d "$BODY")
fi

curl "${CURL_ARGS[@]}" "${HA_BASE}${ENDPOINT}"
