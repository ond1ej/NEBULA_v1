#!/bin/bash
# Uninstall NEBULA (this instance only). Thin wrapper around `nebula uninstall`.
#
#   ./uninstall.sh [--instance ID]                 stop the VM, remove the LaunchAgent; KEEPS all data
#   ./uninstall.sh [--instance ID] --remove-data   also deletes this instance's VM, database, workspaces and
#                                                  Keychain items, after you type the confirmation phrase
#                                                  (non-interactive: add --confirm DELETE-ALL-NEBULA-DATA)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
PHRASE="DELETE-ALL-NEBULA-DATA"
GLOBAL=()
REMOVE=0
CONFIRM=""
while [ $# -gt 0 ]; do
  case "$1" in
    --instance) GLOBAL=(--instance "${2:?--instance needs a value}"); shift ;;
    --instance=*) GLOBAL=(--instance "${1#*=}") ;;
    --remove-data) REMOVE=1 ;;
    --confirm) CONFIRM="${2:?--confirm needs the phrase}"; shift ;;
    --confirm=*) CONFIRM="${1#*=}" ;;
    -h|--help) sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done
[ -x .venv/bin/nebula ] || { echo "NEBULA is not set up in this checkout (.venv/bin/nebula missing)" >&2; exit 1; }
if [ "$REMOVE" = 0 ]; then
  exec .venv/bin/nebula "${GLOBAL[@]+"${GLOBAL[@]}"}" uninstall
fi
if [ -z "$CONFIRM" ]; then
  if [ -t 0 ] && [ -t 1 ]; then
    echo "This permanently deletes this NEBULA instance's VM, agent workspaces, database and Keychain items."
    echo "Other instances and the checkout are not touched. It cannot be undone."
    read -r -p "Type $PHRASE to continue: " CONFIRM || CONFIRM=""
  fi
fi
if [ "$CONFIRM" != "$PHRASE" ]; then
  echo "Not confirmed: nothing was deleted. (Plain ./uninstall.sh keeps your data.)" >&2
  exit 2
fi
exec .venv/bin/nebula "${GLOBAL[@]+"${GLOBAL[@]}"}" uninstall --remove-data --confirm "$PHRASE"
