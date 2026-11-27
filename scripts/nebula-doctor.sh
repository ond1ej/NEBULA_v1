#!/bin/bash
# Preflight + live health-check of the installed NEBULA (VM, guest RPC, X server, browser, screenshot).
cd "$(dirname "$0")/.." && exec .venv/bin/python -m nebula_setup.cli doctor "$@"
