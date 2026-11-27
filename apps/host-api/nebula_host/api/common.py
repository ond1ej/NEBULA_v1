"""Shared API helpers: idempotency keys, job responses."""

from __future__ import annotations

import json
from typing import Any

from fastapi import Request
from fastapi.responses import JSONResponse
from sqlalchemy import delete, select

from nebula_host import db, models
from nebula_host.errors import request_id_var


def ok(data: Any, status: int = 200, job_id: str | None = None) -> JSONResponse:
    body = {"data": data, "request_id": request_id_var.get()}
    if job_id:
        body["job_id"] = job_id
    return JSONResponse(body, status_code=status)


def idem_lookup(request: Request) -> JSONResponse | None:
    key = request.headers.get("idempotency-key")
    if not key:
        return None
    if len(key) > 128:
        return None
    with db.engine().connect() as c:
        r = c.execute(select(models.idempotency_keys).where(models.idempotency_keys.c.key == key)).first()
    if r and r.route == f"{request.method} {request.url.path}":
        resp = JSONResponse(r.response, status_code=r.status_code)
        resp.headers["Idempotent-Replay"] = "true"
        return resp
    return None


def idem_store(request: Request, resp: JSONResponse) -> JSONResponse:
    key = request.headers.get("idempotency-key")
    if key and len(key) <= 128 and resp.status_code < 500:
        with db.engine().begin() as c:
            c.execute(delete(models.idempotency_keys).where(models.idempotency_keys.c.created_at < db.now() - 86400))
            c.execute(models.idempotency_keys.insert().prefix_with("OR IGNORE").values(
                key=key, route=f"{request.method} {request.url.path}", status_code=resp.status_code,
                response=json.loads(resp.body), created_at=db.now()))
    return resp


# ----------------------------------------------------------------------------- in-route authorization (V3.3 model)
def _denied(d) -> Exception:
    from nebula_host.errors import ApiError

    return ApiError(d.status, d.code, d.message, details=d.details)


def require_owner_remote(message: str = "only the NEBULA owner can do this") -> None:
    """Remote (gateway) callers must be the owner; the local dashboard is the owner."""
    from nebula_host import authz

    try:
        authz.require_owner(message)
    except authz.Denied as d:
        raise _denied(d) from None


def require_fresh_owner_remote(message: str = "only the NEBULA owner can do this") -> None:
    """Remote callers must be the owner AND have re-verified themselves recently (admin! inside a route)."""
    from nebula_host import authz

    try:
        authz.require_owner(message)
        authz.require_fresh()
    except authz.Denied as d:
        raise _denied(d) from None


def agent_scope() -> str | None:
    """None: unrestricted; otherwise the one agent id an agent-bot session may see ("" = none)."""
    from nebula_host import authz

    return authz.agent_scope()


def require_agent_in_scope(agent_id: str | None) -> None:
    scope = agent_scope()
    if scope is not None and (not scope or agent_id != scope):
        from nebula_host.errors import ApiError

        raise ApiError(403, "not_your_agent", "this bot can only reach its own agent")
