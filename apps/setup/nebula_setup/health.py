"""HTTP health check of a running NEBULA host service (`GET /api/v1/health` on the loopback port)."""

from __future__ import annotations

import time
from typing import Any

import httpx


def probe(port: int, timeout: float = 3.0, host: str = "127.0.0.1") -> dict[str, Any]:
    """One request. Returns {"ok": bool, "status": ..., "version": ..., "detail": ...}; never raises."""
    url = f"http://{host}:{port}/api/v1/health"
    try:
        r = httpx.get(url, timeout=timeout)
    except httpx.HTTPError as e:
        return {"ok": False, "url": url, "status": "unreachable", "detail": type(e).__name__}
    try:
        body = r.json()
    except ValueError:
        body = {}
    data = body.get("data", body) if isinstance(body, dict) else {}
    api_ok = r.status_code == 200 and data.get("api") == "ok" and data.get("db") == "ok"
    return {"ok": api_ok, "url": url, "http": r.status_code, "status": data.get("status"),
            "version": data.get("version"), "vm": (data.get("vm") or {}).get("state"),
            "guest": (data.get("guest") or {}).get("status")}


def wait(port: int, timeout: float = 60.0, interval: float = 1.0, expect_version: str | None = None,
         sleep=time.sleep, clock=time.monotonic) -> dict[str, Any]:
    """Poll until the API and DB answer (and, if given, report expect_version) or the timeout passes.
    A degraded VM/guest is reported but is not a failure: the API itself is up."""
    end = clock() + max(timeout, 0)
    attempts = 0
    while True:
        attempts += 1
        r = probe(port)
        if r["ok"] and expect_version and r.get("version") != expect_version:
            r = {**r, "ok": False, "detail": f"version {r.get('version')} != expected {expect_version}"}
        if r["ok"] or clock() >= end:
            return {**r, "attempts": attempts}
        sleep(interval)
