#!/usr/bin/env python3
"""License gate for NEBULA's runtime dependencies (used by .github/workflows/license-check.yml).

Python: every distribution installed in the current interpreter's environment, except the project itself. Run it
from an environment created with `uv sync --locked --no-dev`, so only runtime dependencies are present.
npm: the JSON printed by `pnpm licenses list --prod --json` (production dependencies of the dashboard), passed with
--npm-json.

A dependency passes when every license it declares is on the allowlist below. Anything else (copyleft licenses such as
GPL, AGPL or LGPL, "UNKNOWN", an empty license) fails the check unless it is listed in REVIEWED with a reason.
Standard library only.
"""

from __future__ import annotations

import argparse
import importlib.metadata as md
import json
import re
import sys

# SPDX ids (and the classifier / free-text spellings packages actually use) that are compatible with shipping NEBULA
# under MIT. MPL-2.0 is file-level copyleft: fine for unmodified libraries, which is how NEBULA uses them.
ALLOWED = {
    "MIT", "MIT-0", "MIT-CMU", "HPND", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "ISC", "PSF-2.0",
    "Python-2.0", "MPL-2.0", "0BSD", "Unlicense", "Zlib", "BlueOak-1.0.0", "CC0-1.0",
}
ALIASES = {
    "mit license": "MIT",
    "mit": "MIT",
    "bsd license": "BSD-3-Clause",
    "bsd": "BSD-3-Clause",
    "new bsd license": "BSD-3-Clause",
    "bsd 3-clause": "BSD-3-Clause",
    "apache software license": "Apache-2.0",
    "apache license 2.0": "Apache-2.0",
    "apache 2.0": "Apache-2.0",
    "apache-2": "Apache-2.0",
    "mozilla public license 2.0 (mpl 2.0)": "MPL-2.0",
    "python software foundation license": "PSF-2.0",
    "historical permission notice and disclaimer (hpnd)": "HPND",
    "isc license (iscl)": "ISC",
    "mit no attribution license (mit-0)": "MIT-0",
}
# Packages whose metadata is unusual but whose license was checked by hand: name -> reason.
REVIEWED: dict[str, str] = {}
PROJECT = {"nebula"}


def normalise(text: str) -> set[str]:
    """Split an SPDX expression or a free-text license into normalised ids."""
    text = (text or "").strip()
    if not text:
        return set()
    key = text.lower()
    if key in ALIASES:
        return {ALIASES[key]}
    parts = re.split(r"\s+(?:OR|AND|WITH)\s+|[()/;,]", text)
    out = set()
    for p in parts:
        p = p.strip()
        if not p:
            continue
        out.add(ALIASES.get(p.lower(), p))
    return out


def is_choice(expr: str) -> bool:
    """True for a pure "A OR B" expression, where one allowed alternative is enough."""
    return bool(re.search(r"\sOR\s", expr or "")) and not re.search(r"\s(AND|WITH)\s", expr or "")


Row = tuple[str, str, set[str], bool]


def python_licenses() -> list[Row]:
    rows = []
    for dist in md.distributions():
        name = dist.metadata["Name"] or "?"
        if name.lower() in PROJECT:
            continue
        meta = dist.metadata
        ids: set[str] = set()
        expr = meta.get("License-Expression")
        choice = False
        if expr:
            ids = normalise(expr)
            choice = is_choice(expr)
        else:
            for c in meta.get_all("Classifier") or []:
                if c.startswith("License :: OSI Approved :: ") or c.startswith("License :: "):
                    label = c.split("::")[-1].strip()
                    if label not in ("OSI Approved",):
                        ids |= normalise(label)
                # several license classifiers on one package mean the user may choose among them
                choice = len(ids) > 1
            if not ids:
                ids = normalise((meta.get("License") or "").splitlines()[0] if meta.get("License") else "")
        rows.append((name, dist.version, ids, choice))
    return sorted(rows, key=lambda r: r[0].lower())


def npm_licenses(path: str) -> list[Row]:
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    rows = []
    for license_key, pkgs in data.items():
        for p in pkgs:
            expr = p.get("license") or license_key
            rows.append((p["name"], ",".join(p.get("versions") or []), normalise(expr), is_choice(expr)))
    return sorted(rows, key=lambda r: r[0].lower())


def check(kind: str, rows: list[Row]) -> int:
    bad = 0
    for name, version, ids, choice in rows:
        ok = bool(ids) and ids <= ALLOWED
        if not ok and choice and ids & ALLOWED:
            ok = True
        if not ok and name in REVIEWED:
            print(f"  reviewed  {kind:6} {name} {version}: {sorted(ids) or ['(none)']} ({REVIEWED[name]})")
            continue
        status = "ok" if ok else "FAIL"
        if not ok:
            bad += 1
        print(f"  {status:8}  {kind:6} {name} {version}: {', '.join(sorted(ids)) or '(no license metadata)'}")
    return bad


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--python", action="store_true", help="check the current Python environment")
    ap.add_argument("--npm-json", help="output of `pnpm licenses list --prod --json`")
    a = ap.parse_args()
    if not a.python and not a.npm_json:
        ap.error("nothing to check: pass --python and/or --npm-json")
    failures = 0
    if a.python:
        print("Python runtime dependencies")
        failures += check("python", python_licenses())
    if a.npm_json:
        print("npm production dependencies")
        failures += check("npm", npm_licenses(a.npm_json))
    if failures:
        print(f"\n{failures} dependency/dependencies with a license that is not on the allowlist. "
              "Replace the dependency, or review it and add it to REVIEWED with a reason.")
        return 1
    print("\nall licenses allowed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
