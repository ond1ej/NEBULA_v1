#!/bin/bash
# Quick smoke test of a running NEBULA host service (no credentials needed).
set -euo pipefail
# instance under test: NEBULA_DATA_DIR, else the data dir of NEBULA_INSTANCE (default instance when unset)
INSTANCE="${NEBULA_INSTANCE:-default}"
if [ "$INSTANCE" = default ]; then DEFAULT_DATA="$HOME/Library/Application Support/NEBULA"
else DEFAULT_DATA="$HOME/Library/Application Support/NEBULA-$INSTANCE"; fi
DATA="${NEBULA_DATA_DIR:-$DEFAULT_DATA}"
PORT="${NEBULA_PORT:-$(awk '/^ *port:/{print $2; exit}' "$DATA/config.yaml" 2>/dev/null || true)}"
PORT="${PORT:-3100}"
URL="http://127.0.0.1:${PORT}"
echo "health:"; curl -sf "$URL/api/v1/health" | python3 -m json.tool
echo "openapi paths: $(curl -sf "$URL/api/openapi.json" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["paths"]))')"
code=$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: evil.example' "$URL/api/v1/health")
[ "$code" = 403 ] && echo "dns-rebinding guard: OK (403)" || { echo "dns-rebinding guard FAILED ($code)"; exit 1; }
code=$(curl -s -o /dev/null -w '%{http_code}' "$URL/api/v1/agents")
[ "$code" = 401 ] && echo "auth required: OK (401)" || { echo "auth check FAILED ($code)"; exit 1; }
lsof -nP -iTCP:"$PORT" -sTCP:LISTEN | awk 'NR>1{print "listening:", $9}'
