#!/bin/bash
# Hardware E2E matrix against the installed NEBULA (see scripts/e2e.py)
cd "$(dirname "$0")/.." && exec .venv/bin/python scripts/e2e.py "$@"
