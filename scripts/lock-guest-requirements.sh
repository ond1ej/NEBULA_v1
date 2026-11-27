#!/bin/bash
# Re-lock the guest VM's Python packages with hashes (Ubuntu 24.04 ARM64 guest, CPython 3.12).
# Input:  guest/image-builder/requirements-guest.in   Output: guest/image-builder/requirements-guest.txt
# The guest installs them with `pip install --require-hashes -r requirements-guest.txt` (guest/scripts/provision.sh).
# Needs uv and network access to PyPI. Review the diff before committing.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$ROOT/guest/image-builder"
command -v uv >/dev/null 2>&1 || { echo "uv is required (https://docs.astral.sh/uv/)" >&2; exit 1; }
PW="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["playwright_version"])' "$DIR/manifest.json")"
grep -q "^playwright==${PW}\$" "$DIR/requirements-guest.in" || {
  echo "requirements-guest.in must pin playwright==${PW} (manifest.json playwright_version)" >&2; exit 1; }
uv pip compile "$DIR/requirements-guest.in" --python-version 3.12 --python-platform aarch64-unknown-linux-gnu \
  --generate-hashes --no-annotate --custom-compile-command "scripts/lock-guest-requirements.sh" \
  -o "$DIR/requirements-guest.txt"
echo "wrote $DIR/requirements-guest.txt"
