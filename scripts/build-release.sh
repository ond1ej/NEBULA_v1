#!/bin/bash
# Reproducible developer release: signed (ad-hoc) helper, dashboard build, guest bundle, sdist/wheel, SBOM, checksums.
# A notarized .dmg requires an Apple Developer ID (not available here) -> output is an explicit UNSIGNED developer build.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=build/release
rm -rf "$OUT" && mkdir -p "$OUT"
make helper dashboard
scripts/build-guest-bundle.sh "$OUT/nebula-guest-bundle.tar.gz"
.venv/bin/python -m pip wheel --no-deps -w "$OUT" . >/dev/null 2>&1 || uv build -o "$OUT"
cp apps/host-vm-helper/.build/release/nebula-vm "$OUT/"
tar -czf "$OUT/nebula-dashboard.tar.gz" -C apps/dashboard dist
cp LICENSE THIRD_PARTY_NOTICES.md "$OUT/"  # the release ships third-party code (noVNC, Python and JS packages)
.venv/bin/python scripts/sbom.py > "$OUT/SBOM.json"
(cd "$OUT" && shasum -a 256 * > SHA256SUMS)
echo "UNSIGNED DEVELOPER BUILD (not notarized) -> $OUT"
ls -la "$OUT"
