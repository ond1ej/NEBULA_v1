"""Static dashboard / Mini App files: precompressed variants and long-lived caching (perf audit 2026-11-16).

`pnpm build` writes `<file>.br` and `<file>.gz` next to every larger asset. Serving them cut the dashboard's first
load from ~0.9 MB to well under a third on the wire, which matters most for the Mini App on a mobile network and for
LAN/HTTPS clients. Hashed files under /assets/ never change, so browsers may cache them for a year; HTML pages stay
`no-store` so a deploy is picked up immediately.
"""

from __future__ import annotations

import mimetypes
from pathlib import Path

from fastapi.responses import FileResponse

IMMUTABLE = "public, max-age=31536000, immutable"
ENCODINGS = (("br", ".br"), ("gzip", ".gz"))


def accepted(accept_encoding: str | None) -> set[str]:
    out: set[str] = set()
    for part in (accept_encoding or "").lower().split(","):
        name, _, params = part.strip().partition(";")
        q = 1.0
        if params.strip().startswith("q="):
            try:
                q = float(params.strip()[2:])
            except ValueError:
                q = 0.0
        if name and q > 0:
            out.add(name.strip())
    return out


def file_response(path: Path, accept_encoding: str | None, *, immutable: bool = False,
                  cache_control: str | None = None) -> FileResponse:
    media_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    if media_type in ("application/javascript", "text/javascript"):
        media_type = "text/javascript; charset=utf-8"
    headers = {"Vary": "Accept-Encoding"}
    if immutable:
        headers["Cache-Control"] = IMMUTABLE
    elif cache_control:
        headers["Cache-Control"] = cache_control
    ok = accepted(accept_encoding)
    for enc, suffix in ENCODINGS:
        variant = path.with_name(path.name + suffix)
        if enc in ok and variant.is_file():
            headers["Content-Encoding"] = enc
            return FileResponse(variant, media_type=media_type, headers=headers)
    return FileResponse(path, media_type=media_type, headers=headers)
