"""NEBULA 3.2.2 REST API: create and configure agents from the Telegram Mini App (also usable by the dashboard).

Privileged owner operation. Through the Mini App gateway it needs a session of a paired owner of the MAIN NEBULA
bot carrying the ``agents`` permission (agent-specific bots never get it), initData verified server-side by the
existing Mini App auth, Bearer session (no cookies, no CSRF surface), an Idempotency-Key for creation and a rate
limit. Agents never reach these endpoints: they are owner HTTP routes, not agent tools. Everything maps to the
existing agent service (see agent_composer.py); native macOS execution, vault grants and deletion stay on the Mac.
"""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, Depends, Request

from nebula_host import agent_composer as composer
from nebula_host import auth, miniapp
from nebula_host.api.common import idem_lookup, idem_store, ok
from nebula_host.api.routes_v32 import _body_limit
from nebula_host.errors import ApiError
from nebula_host.state import svc

router = APIRouter(prefix="/api/v1", dependencies=[Depends(_body_limit)])
U = Depends(auth.require_session)
_inflight: dict[str, asyncio.Lock] = {}  # Idempotency-Key -> lock: a double tap waits for the first request


def require_agent_admin(p: auth.Principal) -> None:
    """Dashboard owners always; Mini App sessions only for the main bot's paired owner (`agents` permission)."""
    if not p.via:
        return
    from nebula_host import authz

    ctx = authz.current()
    info = miniapp.session_info(p) or {}
    if ctx is None or not ctx.owner or info.get("bot") != "main":
        raise ApiError(403, "agents_permission", "creating or changing agents needs the NEBULA owner account of the "
                                                 "main bot")


@router.get("/miniapp/agent-options")
async def agent_options(p: auth.Principal = U):
    require_agent_admin(p)
    return ok(composer.options())


@router.get("/miniapp/agent-options/models")
async def agent_models(provider_id: str, refresh: bool = False, p: auth.Principal = U):
    require_agent_admin(p)
    return ok(await composer.models_for(provider_id[:64], refresh=refresh and not p.via))


@router.post("/miniapp/agents")
async def agent_create(request: Request, p: auth.Principal = U):
    require_agent_admin(p)
    key = request.headers.get("idempotency-key") or ""
    if not 8 <= len(key) <= 128:
        raise ApiError(400, "idempotency_key_required", "creating an agent needs an Idempotency-Key header")
    lock = _inflight.setdefault(key, asyncio.Lock())
    async with lock:  # concurrent duplicates wait here, then get the stored response
        try:
            if (cached := idem_lookup(request)) is not None:
                return cached  # repeated tap / network retry: the same agent, never a second one
            composer.rate_limit(p.actor)
            body: Any = await request.json()
            out = await composer.create(svc.guest, body, p.actor)
            return idem_store(request, ok(out, 201))
        finally:
            if not lock._waiters:  # noqa: SLF001 - last one out removes the entry
                _inflight.pop(key, None)


@router.get("/miniapp/agents/{agent_id}/settings")
async def agent_settings(agent_id: str, p: auth.Principal = U):
    require_agent_admin(p)
    return ok(composer.settings(agent_id))


@router.patch("/miniapp/agents/{agent_id}/settings")
async def agent_settings_update(agent_id: str, request: Request, p: auth.Principal = U):
    require_agent_admin(p)
    composer.rate_limit(f"edit:{p.actor}", n=60, per_s=600)
    body: Any = await request.json()
    if not isinstance(body, dict):
        raise ApiError(422, "invalid_body", "JSON object expected")
    return ok(await composer.update_settings(agent_id, body, p.actor))
