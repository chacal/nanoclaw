#!/bin/bash
# Query the Wolfram Alpha Simple API and save the result as a PNG.
#
# Wolfram authenticates via a query-param appid. OneCLI's header-based
# host-pattern injection doesn't cover query params, so the appid is
# baked into the WOLFRAM_APP_ID env var passed in by the host. The
# Wolfram appid is a low-value, rate-limited credential — clear-text in
# the container env is acceptable per the v2 fork integration policy.
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

if [ -z "${WOLFRAM_APP_ID:-}" ]; then
  echo "Error: WOLFRAM_APP_ID environment variable not set (the host has not enabled Wolfram for this install)" >&2
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

HTTP_CODE=$(curl -s -w "%{http_code}" -o "$OUTPUT" \
  "https://api.wolframalpha.com/v1/simple?i=${ENCODED_QUERY}&units=metric&appid=${WOLFRAM_APP_ID}")

if [ "$HTTP_CODE" != "200" ]; then
  rm -f "$OUTPUT"
  if [ "$HTTP_CODE" = "501" ]; then
    echo "Error: Wolfram Alpha could not understand the query: $QUERY" >&2
  else
    echo "Error: Wolfram Alpha API returned HTTP $HTTP_CODE" >&2
  fi
  exit 1
fi

echo "$OUTPUT"
