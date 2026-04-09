#!/bin/bash
# Query Wolfram Alpha Simple API and save result as PNG image.
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

if [ -z "${WOLFRAM_APP_ID:-}" ]; then
  echo "Error: WOLFRAM_APP_ID environment variable not set" >&2
  exit 1
fi

# Auto-generate output path if not specified
if [ -z "$OUTPUT" ]; then
  SLUG=$(echo "$QUERY" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | sed 's/--*/-/g' | head -c 50)
  OUTPUT="/workspace/group/wolfram-${SLUG}-$(date +%s).png"
fi

# Ensure output directory exists
mkdir -p "$(dirname "$OUTPUT")"

# URL-encode the query
ENCODED_QUERY=$(node -e "console.log(encodeURIComponent(process.argv[1]))" "$QUERY")

HTTP_CODE=$(curl -s -w "%{http_code}" -o "$OUTPUT" \
  "https://api.wolframalpha.com/v1/simple?appid=${WOLFRAM_APP_ID}&i=${ENCODED_QUERY}&units=metric")

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
