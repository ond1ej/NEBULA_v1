#!/bin/bash
# Update NEBULA from this git checkout: newest release tag (or --ref), database backup, build, deploy,
# migrations, health check, automatic rollback on failure. Thin wrapper around `nebula update`.
#
#   ./update.sh [--instance ID] [--ref TAG|BRANCH|COMMIT] [--dry-run] [--no-build] [--force]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
for d in /opt/homebrew/bin "$HOME/.local/bin" "$HOME/.cargo/bin"; do
  case ":$PATH:" in *":$d:"*) ;; *) [ -d "$d" ] && PATH="$PATH:$d" ;; esac
done
export PATH
case "${1:-}" in -h|--help) sed -n '2,5p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;; esac
[ -x .venv/bin/nebula ] || { echo "NEBULA is not set up in this checkout; run ./install.sh first" >&2; exit 1; }
GLOBAL=()
ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --instance) GLOBAL=(--instance "${2:?--instance needs a value}"); shift ;;
    --instance=*) GLOBAL=(--instance "${1#*=}") ;;
    *) ARGS+=("$1") ;;
  esac
  shift
done
exec .venv/bin/nebula "${GLOBAL[@]+"${GLOBAL[@]}"}" update "${ARGS[@]+"${ARGS[@]}"}"
