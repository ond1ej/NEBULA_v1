#!/bin/bash
# Developer setup on Apple Silicon macOS: builds everything from the lockfiles, installs nothing system-wide.
# End users: use ./install.sh instead (it checks the Mac, offers missing tools and installs NEBULA).
set -euo pipefail
cd "$(dirname "$0")/.."
command -v uv >/dev/null || { echo "install uv: brew install uv (or ./install.sh, which offers it)"; exit 1; }
command -v pnpm >/dev/null || { echo "install pnpm: corepack enable pnpm (comes with Node.js)"; exit 1; }
xcode-select -p >/dev/null || { echo "install Xcode command line tools: xcode-select --install"; exit 1; }
# uv-managed CPython 3.13 (same as `make setup`): one interpreter path, survives Homebrew upgrades
[ -x .venv/bin/python ] || uv venv --python 3.13 .venv
uv sync --frozen
make helper
(cd apps/dashboard && pnpm install --frozen-lockfile && pnpm build)
echo "dev setup complete. Next: ./install.sh   (or: .venv/bin/nebula install --autostart ask)"
