#!/bin/bash
set -e

cd /app

# Hash the bind-mounted source to detect customizations.
# The image stores the hash of the original source at build time in /app/dist/.src-hash.
# If it matches, skip recompilation entirely and use the pre-built dist.
SRC_HASH=$(find src -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1)
IMAGE_HASH=$(cat /app/dist/.src-hash 2>/dev/null || echo "")

if [ -n "$IMAGE_HASH" ] && [ "$SRC_HASH" = "$IMAGE_HASH" ]; then
  # Source unchanged from image build — use pre-built dist
  DIST_DIR=/app/dist
else
  # Source was customized — recompile
  npx tsc --outDir /tmp/dist 2>&1 >&2
  ln -sf /app/node_modules /tmp/dist/node_modules
  chmod -R a-w /tmp/dist
  DIST_DIR=/tmp/dist
fi

cat > /tmp/input.json
node "$DIST_DIR/index.js" < /tmp/input.json
