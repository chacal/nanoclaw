#!/bin/bash
# Query the Wolfram Alpha Simple API and save the result as a PNG.
# Auth is handled by the host-side proxy; containers never see the appid.
#
# Usage:
#   wolfram-alpha "integrate x^2 dx"
#   wolfram-alpha "population of Finland" /workspace/group/finland.png

set -euo pipefail

QUERY="${1:-}"
OUTPUT="${2:-}"

if [ -z "$QUERY" ]; then
  echo "Usage: wolfram-alpha <query> [output_path]" >&2
  echo "Examples:" >&2
  echo "  wolfram-alpha \"integrate x^2 dx\"" >&2
  echo "  wolfram-alpha \"weather in Helsinki\" /workspace/group/weather.png" >&2
  exit 1
fi

if [ -z "${WOLFRAM_API_URL:-}" ]; then
  echo "Error: WOLFRAM_API_URL environment variable not set" >&2
  exit 1
fi

# Auto-generate output path if not specified.
if [ -z "$OUTPUT" ]; then
  SLUG=$(echo "$QUERY" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | sed 's/--*/-/g' | head -c 50)
  OUTPUT="/workspace/group/wolfram-${SLUG}-$(date +%s).png"
fi

mkdir -p "$(dirname "$OUTPUT")"

# URL-encode the query. `node -e` is available in the container (Claude CLI
# runtime); it handles non-ASCII safely where shell escaping is awkward.
ENCODED_QUERY=$(node -e "console.log(encodeURIComponent(process.argv[1]))" "$QUERY")

# --get + --data-urlencode would also work, but we've already encoded once;
# passing the full URL is simplest. `appid` is injected by the host proxy's
# transformPath — the container doesn't know it.
HTTP_CODE=$(curl -s -w "%{http_code}" -o "$OUTPUT" \
  "${WOLFRAM_API_URL}/v1/simple?i=${ENCODED_QUERY}&units=metric")

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
