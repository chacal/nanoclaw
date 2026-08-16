#!/bin/bash
# Query the Wolfram Alpha Simple API and save the result as an image.
#
# Wolfram authenticates via a query-param appid. This shim does NOT send
# one: OneCLI's gateway appends it at the proxy boundary via a
# query-param-injecting secret (host pattern api.wolframalpha.com,
# paramName appid), so the container never holds the credential. Before
# 2026-08-16 the appid was passed in clear text via WOLFRAM_APP_ID —
# that env var is gone; do not reintroduce it.
#
# Usage:
#   wolfram-alpha "integrate x^2 dx"
#   wolfram-alpha "population of Finland" /workspace/agent/finland.png

set -euo pipefail

QUERY="${1:-}"
OUTPUT="${2:-}"

if [ -z "$QUERY" ]; then
  echo "Usage: wolfram-alpha <query> [output_path]" >&2
  echo "Examples:" >&2
  echo "  wolfram-alpha \"integrate x^2 dx\"" >&2
  echo "  wolfram-alpha \"weather in Helsinki\" /workspace/agent/weather.png" >&2
  exit 1
fi

# Auto-generate output path if not specified.
if [ -z "$OUTPUT" ]; then
  SLUG=$(echo "$QUERY" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | sed 's/--*/-/g' | head -c 50)
  OUTPUT="/workspace/agent/wolfram-${SLUG}-$(date +%s).png"
fi

mkdir -p "$(dirname "$OUTPUT")"

# URL-encode the query. `node -e` is available in the container; it handles
# non-ASCII safely where shell escaping is awkward.
ENCODED_QUERY=$(node -e "console.log(encodeURIComponent(process.argv[1]))" "$QUERY")

# No appid here on purpose — the OneCLI gateway appends it. See header.
HTTP_CODE=$(curl -s -w "%{http_code}" -o "$OUTPUT" \
  "https://api.wolframalpha.com/v1/simple?i=${ENCODED_QUERY}&units=metric")

if [ "$HTTP_CODE" != "200" ]; then
  rm -f "$OUTPUT"
  if [ "$HTTP_CODE" = "501" ]; then
    echo "Error: Wolfram Alpha could not understand the query: $QUERY" >&2
  elif [ "$HTTP_CODE" = "400" ] || [ "$HTTP_CODE" = "401" ]; then
    # Wolfram answers "appid missing" with 400, so this is what a
    # non-injected request looks like: either no 'Wolfram Alpha' secret in
    # the vault, or this agent is in selective secret mode without it.
    echo "Error: Wolfram Alpha rejected the credential (HTTP $HTTP_CODE) — the OneCLI gateway did not inject an appid for this agent" >&2
  else
    echo "Error: Wolfram Alpha API returned HTTP $HTTP_CODE" >&2
  fi
  exit 1
fi

echo "$OUTPUT"
