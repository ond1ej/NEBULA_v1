#!/bin/bash
# NEBULA one-command installer for Apple-silicon Macs.
#
#   ./install.sh            check this Mac, offer missing tools, build, install, offer autostart
#   ./install.sh --check    report only: changes nothing (no installs, builds, files or services)
#   ./install.sh --yes      non-interactive: accept every offer (tool installs, autostart)
#
# Options: --instance ID (a separate install beside the default one), --port N, --vm-ram-mb N,
#          --autostart yes|no|ask, --offline-image FILE, --no-open, --reprovision, -h|--help
#
# Never uses sudo, never installs anything without asking (or --yes), never deletes user data. Safe to re-run:
# finished steps are skipped and an installed, healthy NEBULA reports "already READY - nothing to do"
# (--check on an installed Mac says "already installed" and points to ./update.sh).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

MIN_MACOS_MAJOR=13
MIN_RAM_GB=8
REC_RAM_GB=16
MIN_FREE_GB=25   # 20 GB for the VM disk + room for the build and the image download
# Node.js the dashboard build runs on: Vite 7's "engines.node" (apps/dashboard/pnpm-lock.yaml), also the dashboard's
# package.json engines field. Keep in sync (tests/unit/test_fixround_lifecycle.py checks it).
NODE_ENGINES="^20.19.0 || >=22.12.0"
NODE_NEED="Node.js 20.19+ on Node 20, or 22.12+"

# node_version_ok X.Y.Z -> success when the version satisfies NODE_ENGINES (^20.19.0 || >=22.12.0)
node_version_ok() {
  local v="${1#v}" maj min rest
  maj="${v%%.*}"; rest="${v#*.}"
  [ "$rest" != "$v" ] || return 1
  min="${rest%%.*}"
  case "$maj" in ''|*[!0-9]*) return 1 ;; esac
  case "$min" in ''|*[!0-9]*) return 1 ;; esac
  if [ "$maj" -eq 20 ]; then [ "$min" -ge 19 ]; return; fi
  if [ "$maj" -eq 22 ]; then [ "$min" -ge 12 ]; return; fi
  [ "$maj" -ge 23 ]
}

# recorded_instance FILE -> instance.id from a NEBULA config.yaml (empty when it has none)
recorded_instance() {
  awk '/^instance:/ {s = 1; next}
       s && /^[^[:space:]#]/ {s = 0}
       s && /^[[:space:]]+id:/ {sub(/^[[:space:]]+id:[[:space:]]*/, ""); sub(/[[:space:]]*#.*$/, ""); print; exit}' \
    "$1" 2>/dev/null | tr -d "\"'"
}

# real_path PATH -> PATH with symlinks in its parent directory resolved (when the parent exists)
real_path() {
  local p="${1%/}" parent
  parent="$(dirname "$p")"
  if [ -d "$parent" ]; then printf '%s/%s\n' "$(cd "$parent" && pwd -P)" "$(basename "$p")"; else printf '%s\n' "$p"; fi
}

# same_dir A B -> success when A and B are the same path, or both exist and are one directory (same device and
# inode: a symlink, or another letter case on a case-insensitive volume), like nebula_host.config._same_dir
same_dir() {
  [ "$1" = "$2" ] && return 0
  [ -d "$1" ] && [ -d "$2" ] || return 1
  local a b
  a="$(stat -L -f '%d:%i' "$1" 2>/dev/null || true)"
  b="$(stat -L -f '%d:%i' "$2" 2>/dev/null || true)"
  [ -n "$a" ] && [ "$a" = "$b" ]
}

lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
valid_id() { printf '%s' "$1" | grep -Eq '^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$'; }

# pnpm_is_corepack_shim PATH -> success when PATH is corepack's pnpm shim, which downloads pnpm on its first run
pnpm_is_corepack_shim() {
  local p="$1" target n=0
  while [ -L "$p" ] && [ "$n" -lt 20 ]; do
    target="$(readlink "$p")"
    case "$target" in /*) p="$target" ;; *) p="$(dirname "$p")/$target" ;; esac
    n=$((n + 1))
  done
  case "$p" in */corepack/*|*/corepack) return 0 ;; esac
  [ -f "$p" ] || return 1
  local start
  start="$(head -c 512 "$p" 2>/dev/null | LC_ALL=C tr -d '\000' || true)"
  case "$start" in *corepack*) return 0 ;; esac
  return 1
}

# corepack_pnpm_version -> the pnpm version corepack would run for the dashboard build, read from files only:
# packageManager in apps/dashboard/package.json, else corepack's lastKnownGood.json (empty when neither names one)
COREPACK_DIR="${COREPACK_HOME:-${XDG_CACHE_HOME:-$HOME/.cache}/node/corepack}"
corepack_pnpm_version() {
  local v
  v="$(sed -n 's/.*"packageManager"[[:space:]]*:[[:space:]]*"pnpm@\([^"]*\)".*/\1/p' apps/dashboard/package.json 2>/dev/null | head -n 1)"
  [ -n "$v" ] || v="$(sed -n 's/.*"pnpm"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$COREPACK_DIR/lastKnownGood.json" 2>/dev/null | head -n 1)"
  printf '%s\n' "${v%%+*}"
}

CHECK=0
YES=0
UV_PINNED="0.9.28"  # the uv release this version of NEBULA was built and tested with (used only by the curl installer)
AUTOSTART=ask
INSTANCE="${NEBULA_INSTANCE:-}"
PORT=""
VM_RAM_MB=""
OFFLINE_IMAGE=""
OPEN=1
REPROVISION=0

usage() { sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK=1 ;;
    -y|--yes) YES=1 ;;
    --instance) INSTANCE="${2:?--instance needs a value}"; shift ;;
    --instance=*) INSTANCE="${1#*=}" ;;
    --port) PORT="${2:?--port needs a value}"; shift ;;
    --port=*) PORT="${1#*=}" ;;
    --vm-ram-mb) VM_RAM_MB="${2:?--vm-ram-mb needs a value}"; shift ;;
    --vm-ram-mb=*) VM_RAM_MB="${1#*=}" ;;
    --autostart) AUTOSTART="${2:?--autostart needs yes, no or ask}"; shift ;;
    --autostart=*) AUTOSTART="${1#*=}" ;;
    --no-autostart) AUTOSTART=no ;;
    --offline-image) OFFLINE_IMAGE="${2:?--offline-image needs a file}"; shift ;;
    --offline-image=*) OFFLINE_IMAGE="${1#*=}" ;;
    --no-open) OPEN=0 ;;
    --reprovision) REPROVISION=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done
case "$AUTOSTART" in yes|no|ask) ;; *) echo "--autostart must be yes, no or ask" >&2; exit 2 ;; esac
if [ -n "$INSTANCE" ] && ! printf '%s' "$INSTANCE" | grep -Eq '^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$'; then
  echo "--instance must be 1-32 characters a-z, 0-9 or '-'" >&2; exit 2
fi
if [ -n "$PORT" ] && ! printf '%s' "$PORT" | grep -Eq '^[0-9]{4,5}$'; then echo "--port must be a number" >&2; exit 2; fi
if [ -n "$VM_RAM_MB" ] && ! printf '%s' "$VM_RAM_MB" | grep -Eq '^[0-9]{4,6}$'; then
  echo "--vm-ram-mb must be a number" >&2; exit 2
fi

if [ -t 1 ]; then B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; N=$'\033[0m'; else B=""; G=""; Y=""; R=""; N=""; fi
ok()   { printf '  %s[ok]%s   %s\n' "$G" "$N" "$*"; }
warn() { printf '  %s[warn]%s %s\n' "$Y" "$N" "$*"; }
bad()  { printf '  %s[fail]%s %s\n' "$R" "$N" "$*"; }
todo() { printf '  %s[todo]%s %s\n' "$Y" "$N" "$*"; }
step() { printf '\n%s==> %s%s\n' "$B" "$*" "$N"; }
die()  { printf '\n%serror:%s %s\n' "$R" "$N" "$*" >&2; exit 1; }

INTERACTIVE=0
if [ -t 0 ] && [ -t 1 ]; then INTERACTIVE=1; fi

# confirm "question" -> 0 = yes. --yes answers yes; without a terminal (and without --yes) the answer is no.
confirm() {
  if [ "$YES" = 1 ]; then echo "  $1 [y/N] y (--yes)"; return 0; fi
  if [ "$INTERACTIVE" != 1 ]; then echo "  $1 [y/N] n (no terminal; re-run with --yes to accept)"; return 1; fi
  local ans=""
  read -r -p "  $1 [y/N] " ans || ans=""
  case "$ans" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

have() { command -v "$1" >/dev/null 2>&1; }

# Homebrew / uv / corepack may be installed but not on PATH yet in this shell
for d in /opt/homebrew/bin "$HOME/.local/bin" "$HOME/.cargo/bin"; do
  case ":$PATH:" in *":$d:"*) ;; *) [ -d "$d" ] && PATH="$PATH:$d" ;; esac
done
export PATH

STD_DATA_DIR="$HOME/Library/Application Support/NEBULA"
if [ -n "$INSTANCE" ] && [ "$INSTANCE" != default ]; then
  DATA_DIR="${NEBULA_DATA_DIR:-$STD_DATA_DIR-$INSTANCE}"
  LABEL="dev.nebula.host.$INSTANCE"
else
  DATA_DIR="${NEBULA_DATA_DIR:-$STD_DATA_DIR}"
  LABEL="dev.nebula.host"
fi
INSTANCE_ID="${INSTANCE:-default}"

HARD_FAIL=0
MISSING_CLT=0; MISSING_UV=0; MISSING_NODE=0; MISSING_PNPM=0; MISSING_GPG=0

# Install state of this instance, from files only (nothing is opened for writing): installed = database, VM bundle
# and an install report without a top-level "error" (written by `nebula install`, json indent 2).
INSTALL_STATE=none
if [ -f "$DATA_DIR/nebula.db" ] && [ -f "$DATA_DIR/vm/shared/config.json" ] && [ -f "$DATA_DIR/install-report.json" ] \
    && ! grep -Eq '^  "error":' "$DATA_DIR/install-report.json"; then
  INSTALL_STATE=installed
elif [ -f "$DATA_DIR/config.yaml" ] || [ -f "$DATA_DIR/nebula.db" ]; then
  INSTALL_STATE=partial
fi

# Which instance does DATA_DIR belong to? Refuse to install instance X into another instance's data dir (it would
# rewrite that instance's config.yaml and share its database, VM and Keychain service).
# The same rules as nebula_host.config (conventional_instance_id / recorded_instance_id).
OWNER=""
DATA_REAL="$(real_path "$DATA_DIR")"
STD_REAL="$(real_path "$STD_DATA_DIR")"
if same_dir "$DATA_REAL" "$STD_REAL"; then OWNER=default
else
  STD_BASE="$(basename "$STD_REAL")"
  DATA_BASE="$(basename "$DATA_REAL")"
  DATA_HEAD="${DATA_BASE:0:${#STD_BASE}+1}"
  if [ "$(lower "$DATA_HEAD")" = "$(lower "$STD_BASE-")" ] && same_dir "$(dirname "$DATA_REAL")" "$(dirname "$STD_REAL")"; then
    CAND="$(lower "${DATA_BASE:${#STD_BASE}+1}")"
    if valid_id "$CAND" && [ "$CAND" != default ]; then
      if [ "$DATA_HEAD" = "$STD_BASE-" ] || same_dir "$DATA_REAL" "$(dirname "$STD_REAL")/$STD_BASE-$CAND"; then
        OWNER="$CAND"
      fi
    fi
  fi
fi
REC=""
[ -f "$DATA_DIR/config.yaml" ] && REC="$(recorded_instance "$DATA_DIR/config.yaml" || true)"
if [ -z "$REC" ] && [ -f "$DATA_DIR/instance-id" ]; then
  REC="$(lower "$(head -n 1 "$DATA_DIR/instance-id" | tr -d '[:space:]')")"
  valid_id "$REC" || REC=""
fi
if [ -n "$REC" ]; then OWNER="$REC"
elif [ -f "$DATA_DIR/nebula.db" ]; then OWNER="${OWNER:-default}"   # a database that names no instance: installed before instance ids existed
fi
WRONG_OWNER=0
if [ -n "$OWNER" ] && [ "$OWNER" != "$INSTANCE_ID" ]; then WRONG_OWNER=1; INSTALL_STATE=foreign; fi

printf '%sCompatibility check%s: this Mac, its tools and NEBULA%s\n' "$B" "$N" "${INSTANCE:+ instance $INSTANCE}"
step "Checking this Mac${INSTANCE:+ (instance: $INSTANCE)}"
MACOS="$(sw_vers -productVersion 2>/dev/null || echo 0)"
if [ "${MACOS%%.*}" -ge "$MIN_MACOS_MAJOR" ] 2>/dev/null; then ok "macOS $MACOS"; else bad "macOS $MACOS (needs $MIN_MACOS_MAJOR or newer)"; HARD_FAIL=1; fi
ARCH="$(uname -m)"
if [ "$ARCH" = arm64 ]; then ok "Apple silicon ($ARCH)"; else bad "CPU $ARCH (needs Apple silicon, arm64)"; HARD_FAIL=1; fi
if [ "$(sysctl -n kern.hv_support 2>/dev/null || echo 0)" = 1 ]; then ok "Virtualization supported (kern.hv_support=1)"
else bad "Virtualization is not available on this Mac (kern.hv_support)"; HARD_FAIL=1; fi
MEM_BYTES="$(sysctl -n hw.memsize 2>/dev/null || echo 0)"
RAM_GB=$(( MEM_BYTES / 1073741824 ))
if [ "$RAM_GB" -ge "$REC_RAM_GB" ]; then ok "${RAM_GB} GB RAM"
elif [ "$RAM_GB" -ge "$MIN_RAM_GB" ]; then warn "${RAM_GB} GB RAM (works; ${REC_RAM_GB} GB recommended; the VM gets 4096 MB)"
else bad "${RAM_GB} GB RAM (needs at least ${MIN_RAM_GB} GB)"; HARD_FAIL=1; fi
DF_PATH="$DATA_DIR"
while [ ! -d "$DF_PATH" ]; do DF_PATH="$(dirname "$DF_PATH")"; done
FREE_GB=$(( $(df -Pk "$DF_PATH" | awk 'NR==2{print $4}') / 1048576 ))
if [ "$FREE_GB" -ge "$MIN_FREE_GB" ]; then ok "${FREE_GB} GB free disk"
elif [ "$INSTALL_STATE" = installed ]; then warn "${FREE_GB} GB free disk (a new install needs ${MIN_FREE_GB} GB; the existing VM disk grows into it)"
else bad "${FREE_GB} GB free disk (needs ${MIN_FREE_GB} GB)"; HARD_FAIL=1; fi

step "Checking tools"
if xcode-select -p >/dev/null 2>&1 && have swift; then ok "Xcode Command Line Tools ($(xcode-select -p))"
else todo "Xcode Command Line Tools (swift, codesign, make) — needed to build the VM helper"; MISSING_CLT=1; fi
BREW=""
if have brew; then BREW="$(command -v brew)"; ok "Homebrew ($BREW)"; else warn "Homebrew not found (optional; used to install uv/Node/gnupg if present)"; fi
if have uv; then ok "uv $(uv --version 2>/dev/null | awk '{print $2}')"; else todo "uv (Python package manager; installs the locked dependencies and Python 3.13)"; MISSING_UV=1; fi
NODE_VERSION=""
if have node; then NODE_VERSION="$(node -p 'process.versions.node' 2>/dev/null || true)"; fi
NODE_BREW_CMD="brew install node"
if [ -n "$NODE_VERSION" ] && node_version_ok "$NODE_VERSION"; then ok "Node.js v$NODE_VERSION"
elif [ -n "$NODE_VERSION" ]; then
  todo "Node.js v$NODE_VERSION is not supported by the dashboard build: it needs $NODE_NEED ($NODE_ENGINES)"
  MISSING_NODE=1
  if [ -n "$BREW" ] && brew list --versions node >/dev/null 2>&1; then NODE_BREW_CMD="brew upgrade node"; fi
else todo "$NODE_NEED (to build the dashboard; $NODE_ENGINES)"; MISSING_NODE=1; fi
PNPM=""
if have pnpm; then
  PNPM="pnpm"
  if pnpm_is_corepack_shim "$(command -v pnpm)"; then
    # never run corepack here: with an empty cache it downloads pnpm first (--check must change nothing)
    CP_PNPM="$(corepack_pnpm_version)"
    if [ -n "$CP_PNPM" ] && { [ -d "$COREPACK_DIR/v1/pnpm/$CP_PNPM" ] || [ -d "$COREPACK_DIR/pnpm/$CP_PNPM" ]; }; then
      ok "pnpm $CP_PNPM (through corepack, already downloaded)"
    else
      ok "pnpm (through corepack: the build downloads pnpm${CP_PNPM:+ $CP_PNPM} first; not run by this check)"
    fi
  else
    # a real pnpm binary; outside any project and with downloads off, so it cannot switch to another pnpm version
    ok "pnpm $(cd / && COREPACK_ENABLE_NETWORK=0 COREPACK_ENABLE_DOWNLOAD_PROMPT=0 COREPACK_ENABLE_AUTO_PIN=0 \
      npm_config_manage_package_manager_versions=false pnpm --version 2>/dev/null < /dev/null)"
  fi
elif have corepack; then todo "pnpm (will be enabled through corepack)"; MISSING_PNPM=1
else todo "pnpm (comes with Node.js through corepack)"; MISSING_PNPM=1; fi
if have gpg; then ok "gnupg (verifies Ubuntu's signed image checksums too)"
else warn "gnupg not found (recommended: adds Ubuntu's own signature check on top of the pinned SHA-256)"; MISSING_GPG=1; fi

step "Checking NEBULA"
OWNER_MSG="data dir $DATA_DIR belongs to instance '$OWNER', not '$INSTANCE_ID': use --instance $OWNER for that instance, or unset NEBULA_DATA_DIR"
case "$INSTALL_STATE" in
  foreign)   bad "$OWNER_MSG" ;;
  installed) ok "data dir: $DATA_DIR — instance '$INSTANCE_ID' is already installed" ;;
  partial)   ok "data dir: $DATA_DIR — exists, install not finished; a re-run finishes it and keeps all data" ;;
  *)         ok "data dir: $DATA_DIR — not installed yet" ;;
esac
if [ -f "$HOME/Library/LaunchAgents/$LABEL.plist" ]; then ok "autostart: LaunchAgent $LABEL installed"
elif [ "$INSTALL_STATE" = installed ]; then ok "autostart: off (start with .venv/bin/nebula ${INSTANCE:+--instance $INSTANCE }serve)"; fi
[ -x .venv/bin/python ] && ok "Python environment .venv" || todo "Python environment .venv (uv sync --frozen)"
[ -x apps/host-vm-helper/.build/release/nebula-vm ] && ok "VM helper built" || todo "build the VM helper (make helper)"
[ -f apps/dashboard/dist/index.html ] && ok "dashboard built" || todo "build the dashboard (pnpm build)"

if [ "$CHECK" = 1 ]; then
  step "Plan (--check: nothing was changed)"
  [ "$MISSING_CLT" = 1 ] && echo "  - offer: xcode-select --install"
  if [ "$MISSING_UV" = 1 ]; then
    if [ -n "$BREW" ]; then echo "  - offer: brew install uv"; else echo "  - offer: uv official installer (https://astral.sh/uv/install.sh)"; fi
  fi
  if [ "$MISSING_NODE" = 1 ]; then
    if [ -n "$BREW" ]; then echo "  - offer: $NODE_BREW_CMD ($NODE_NEED)"; else echo "  - you install $NODE_NEED from https://nodejs.org (no Homebrew)"; fi
  fi
  [ "$MISSING_PNPM" = 1 ] && echo "  - offer: corepack enable pnpm"
  [ "$MISSING_GPG" = 1 ] && [ -n "$BREW" ] && echo "  - offer (recommended): brew install gnupg"
  if [ "$INSTALL_STATE" = installed ]; then
    echo "  - nothing to install: NEBULA${INSTANCE:+ instance $INSTANCE} is already installed in $DATA_DIR"
    echo "  - update it: ./update.sh${INSTANCE:+ --instance $INSTANCE}"
    echo "  - see its state: .venv/bin/nebula ${INSTANCE:+--instance $INSTANCE }status"
  elif [ "$INSTALL_STATE" = foreign ]; then
    echo "  - nothing: the data dir belongs to instance '$OWNER', so installing '$INSTANCE_ID' there is refused"
  else
    echo "  - build: uv sync --frozen, make helper, pnpm install --frozen-lockfile && pnpm build"
    echo "  - run: nebula ${INSTANCE:+--instance $INSTANCE }install --autostart $AUTOSTART (verified Ubuntu image, VM, guest, health check)"
  fi
  if [ "$WRONG_OWNER" = 1 ]; then echo; bad "$OWNER_MSG"; exit 1; fi
  if [ "$HARD_FAIL" = 1 ]; then echo; bad "this Mac does not meet the requirements above"; exit 1; fi
  echo
  if [ "$INSTALL_STATE" = installed ]; then
    ok "already installed: run ./update.sh${INSTANCE:+ --instance $INSTANCE} to update, or .venv/bin/nebula ${INSTANCE:+--instance $INSTANCE }status to see its state"
  else
    ok "ready to install: run ./install.sh"
  fi
  exit 0
fi

[ "$WRONG_OWNER" = 1 ] && die "$OWNER_MSG"
[ "$HARD_FAIL" = 1 ] && die "this Mac does not meet the requirements above"

step "Installing missing tools (each one asks first)"
if [ "$MISSING_CLT" = 1 ]; then
  if confirm "Install the Xcode Command Line Tools now (opens Apple's installer)?"; then
    xcode-select --install || true
    die "finish the Command Line Tools installer, then run ./install.sh again"
  fi
  die "the Xcode Command Line Tools are required (xcode-select --install)"
fi
if [ "$MISSING_UV" = 1 ]; then
  if [ -n "$BREW" ]; then
    confirm "Install uv with Homebrew (brew install uv)?" && brew install uv || die "uv is required: https://docs.astral.sh/uv/"
  else
    # A downloaded installer script is never run unattended: --yes does not answer this question.
    UV_INSTALLER="https://astral.sh/uv/$UV_PINNED/install.sh"
    if [ "$YES" = 1 ]; then
      die "uv is required. --yes never runs a downloaded installer: install uv first (brew install uv, or $UV_INSTALLER)"
    fi
    if confirm "Install uv $UV_PINNED with its official installer (curl -LsSf $UV_INSTALLER | sh; installs to ~/.local/bin)?"; then
      curl --proto '=https' --tlsv1.2 -LsSf "$UV_INSTALLER" | sh
      PATH="$HOME/.local/bin:$PATH"
    else die "uv is required: https://docs.astral.sh/uv/"; fi
  fi
  have uv || die "uv was not found after installing it; open a new terminal and re-run ./install.sh"
fi
if [ "$MISSING_NODE" = 1 ]; then
  if [ -n "$BREW" ] && confirm "Install a supported Node.js with Homebrew ($NODE_BREW_CMD)?"; then $NODE_BREW_CMD
  else die "$NODE_NEED is required to build the dashboard ($NODE_ENGINES): https://nodejs.org (then re-run ./install.sh)"; fi
  hash -r
  NODE_VERSION="$(node -p 'process.versions.node' 2>/dev/null || true)"
  node_version_ok "$NODE_VERSION" || die "the node on PATH ($(command -v node || echo none), v${NODE_VERSION:-?}) is still not $NODE_NEED; put a supported Node.js first on PATH, then re-run ./install.sh"
fi
if [ -z "$PNPM" ]; then
  if have pnpm; then PNPM=pnpm
  elif have corepack && confirm "Enable pnpm through corepack (corepack enable pnpm)?"; then
    export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
    if corepack enable pnpm 2>/dev/null && have pnpm; then PNPM=pnpm; else PNPM="corepack pnpm"; fi
  else die "pnpm is required: corepack enable pnpm (comes with Node.js)"; fi
fi
if [ "$MISSING_GPG" = 1 ] && [ -n "$BREW" ]; then
  confirm "Install gnupg with Homebrew (recommended, brew install gnupg)?" && brew install gnupg || warn "continuing without gnupg"
fi

step "Building NEBULA"
if [ ! -x .venv/bin/python ] || ! .venv/bin/python -c 'import sys' >/dev/null 2>&1; then
  uv venv --python 3.13 .venv
fi
uv sync --frozen
make helper
(cd apps/dashboard && $PNPM install --frozen-lockfile && $PNPM build)

step "Installing NEBULA${INSTANCE:+ instance $INSTANCE}"
if [ "$AUTOSTART" = ask ]; then
  if [ "$YES" = 1 ]; then AUTOSTART=yes
  elif [ "$INTERACTIVE" = 1 ]; then
    if confirm "Start NEBULA automatically after you log in (LaunchAgent)?"; then AUTOSTART=yes; else AUTOSTART=no; fi
  else AUTOSTART=no; fi
fi
ARGS=(install --autostart "$AUTOSTART")
[ -n "$PORT" ] && ARGS+=(--port "$PORT")
if [ -n "$VM_RAM_MB" ]; then ARGS+=(--vm-ram-mb "$VM_RAM_MB")
elif [ "$RAM_GB" -le "$REC_RAM_GB" ] && [ ! -f "$DATA_DIR/config.yaml" ]; then ARGS+=(--vm-ram-mb 4096); fi
[ -n "$OFFLINE_IMAGE" ] && ARGS+=(--offline-image "$OFFLINE_IMAGE")
[ "$REPROVISION" = 1 ] && ARGS+=(--reprovision)
[ "$OPEN" = 1 ] && [ "$INTERACTIVE" = 1 ] && ARGS+=(--open)
GLOBAL=()
[ -n "$INSTANCE" ] && GLOBAL=(--instance "$INSTANCE")
set +e
.venv/bin/nebula "${GLOBAL[@]+"${GLOBAL[@]}"}" "${ARGS[@]}"
RC=$?
set -e
if [ "$RC" -ne 0 ]; then
  echo
  [ "$RC" = 3 ] && warn "installed, but the service did not pass its health check; run: .venv/bin/nebula ${INSTANCE:+--instance $INSTANCE }diagnostics"
  [ "$RC" != 3 ] && die "nebula install failed (exit $RC); your data was not deleted. Fix the problem above and re-run ./install.sh"
  exit "$RC"
fi

step "Done"
echo "  Command line: $ROOT/.venv/bin/nebula ${INSTANCE:+--instance $INSTANCE }status | health | restart | update | diagnostics"
if [ "$AUTOSTART" = no ]; then
  echo "  Autostart is off: start NEBULA with  .venv/bin/nebula ${INSTANCE:+--instance $INSTANCE }serve"
  echo "  (or enable it later: .venv/bin/nebula ${INSTANCE:+--instance $INSTANCE }autostart enable)"
fi
echo "  First-run URL again: .venv/bin/nebula ${INSTANCE:+--instance $INSTANCE }setup-url"
