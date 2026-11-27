#!/usr/bin/env python3
"""Minimal dependency report (SBOM-style) for Python, Node and guest components with licenses."""
import json
import subprocess
import sys
from importlib import metadata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
py = []
for d in sorted(metadata.distributions(), key=lambda d: d.metadata["Name"].lower()):
    lic = d.metadata.get("License-Expression") or d.metadata.get("License") or ""
    if not lic or len(lic) > 80:
        lic = next((c.split("::")[-1].strip() for c in (d.metadata.get_all("Classifier") or []) if c.startswith("License")), lic[:80])
    py.append({"name": d.metadata["Name"], "version": d.version, "license": lic})
node = []
pkg = ROOT / "apps/dashboard/node_modules/.pnpm"
try:
    out = subprocess.run(["pnpm", "licenses", "list", "--json", "--prod"], cwd=ROOT / "apps/dashboard",
                         capture_output=True, text=True, timeout=120).stdout
    for lic, items in json.loads(out or "{}").items():
        for it in items:
            node.append({"name": it["name"], "versions": it.get("versions"), "license": lic})
except Exception as e:  # noqa: BLE001
    node.append({"error": str(e)})
guest = [
    {"name": "Ubuntu 24.04 LTS cloud image (arm64)", "license": "various (Ubuntu archive; see image manifest)"},
    {"name": "TigerVNC", "license": "GPL-2.0"}, {"name": "XFCE", "license": "GPL-2.0+/LGPL"},
    {"name": "Playwright (python)", "license": "Apache-2.0"}, {"name": "Chromium (Playwright build)", "license": "BSD-3-Clause and others"},
    {"name": "noVNC", "license": "MPL-2.0"},
]
json.dump({"project": "nebula", "python": py, "node": node, "guest": guest}, sys.stdout, indent=2)
