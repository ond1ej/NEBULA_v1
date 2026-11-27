#!/bin/bash
# Build the guest bundle tarball (guest service + shared contracts + desktop files).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/build/nebula-guest-bundle.tar.gz}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cp -R "$ROOT/guest/guest-service/nebula_guest" "$ROOT/packages/contracts/nebula_contracts" "$TMP/"
cp -R "$ROOT/guest/desktop" "$TMP/desktop"
cp "$ROOT/guest/scripts/provision.sh" "$TMP/provision.sh"
find "$TMP" -name __pycache__ -prune -exec rm -rf {} +
mkdir -p "$(dirname "$OUT")"
COPYFILE_DISABLE=1 tar --no-xattrs -czf "$OUT" -C "$TMP" .
echo "$OUT"
