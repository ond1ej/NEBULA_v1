"""NEBULA 3.2.1 REST API: Smart Authentication (sign-in assistance during agent tasks).

Remote-safe surface (also forwarded by the Mini App gateway, see remote.py): read pending request metadata, get a
single-use submission token, submit ONE answer to ONE pending request (credentials / verification code / saved
account / destination decision / manual step done), cancel. Typed secrets go from this request straight to the
isolated broker; they are never stored, logged, echoed or sent anywhere else. Remote secret entry (anything that is
not a one-time code) additionally requires the owner's remote sign-in PIN, which can only be set on this Mac.

Local-only: settings and the remote PIN (same rule as vault management: loopback, no Mini App session, no proxy).
Every response is ``Cache-Control: no-store``; request bodies are never logged and validation errors never echo
input values.
"""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field

from nebula_host import auth
from nebula_host import smart_auth as sa
from nebula_host.api.routes_v32 import _body_limit, is_physically_local, require_local, vok
from nebula_host.errors import ApiError

router = APIRouter(prefix="/api/v1", dependencies=[Depends(_body_limit)])
U = Depends(auth.require_session)


def _err(e: sa.AuthError) -> ApiError:
    details = {k: v for k, v in e.extra.items() if k in ("retry_after", "attempts_left", "level", "vault_state")}
    if e.code == "stepup_required":
        from nebula_host import authz

        ctx = authz.current()
        details["methods"] = authz.stepup_methods(ctx) if ctx else ["password"]
    return ApiError(e.status, e.code, str(e), details=details)


def _local(request: Request, p: auth.Principal) -> bool:
    """Physically on this Mac (loopback dashboard): the remote PIN rules do not apply there."""
    return is_physically_local(request, p)


def _who(request: Request, p: auth.Principal) -> dict[str, Any]:
    from nebula_host import authz

    local = _local(request, p)
    ctx = authz.current()
    if not p.via:
        return {"local": local, "fresh": True, "owner": True}
    return {"local": False, "fresh": bool(ctx and ctx.fresh), "owner": bool(ctx and ctx.owner)}


@router.get("/smart-auth/sessions")
async def sessions(request: Request, conversation_id: str | None = None, agent_id: str | None = None,
                   task_id: str | None = None, active: bool | None = None, limit: int = 30,
                   p: auth.Principal = U):
    return vok(sa.list_sessions(conversation_id=conversation_id, agent_id=agent_id, task_id=task_id, active=active,
                                limit=limit, **_who(request, p)))


@router.get("/smart-auth/sessions/{sid}")
async def session_detail(sid: str, request: Request, p: auth.Principal = U):
    try:
        return vok(sa.detail(sid, **_who(request, p)))
    except sa.AuthError as e:
        raise _err(e) from None


def _owner(request: Request, p: auth.Principal) -> None:
    """M-04: answering an agent's sign-in request (and taking its form token) is the owner's decision only."""
    if not _who(request, p)["owner"]:
        raise ApiError(403, "owner_only", "only the NEBULA owner can answer sign-in requests")


@router.post("/smart-auth/sessions/{sid}/token")
async def session_token(sid: str, request: Request, p: auth.Principal = U):
    _owner(request, p)
    try:
        sa._rate_limit(f"token:{p.actor}", 30, 60)
        return vok(sa.issue_token(sid, actor=p.actor))
    except sa.AuthError as e:
        raise _err(e) from None


class SubmitBody(BaseModel):
    request_id: str = Field(min_length=3, max_length=64)
    token: str = Field(min_length=20, max_length=64)
    action: str = Field(min_length=3, max_length=32)
    values: dict[str, str] | None = None
    entry_id: str | None = Field(default=None, max_length=64)
    save: str | None = Field(default=None, max_length=8)
    allow_future: bool | None = None
    name: str | None = Field(default=None, max_length=200)
    review_confirmed: bool | None = None
    pin: str | None = Field(default=None, max_length=64)
    alternative: str | None = Field(default=None, max_length=16)


@router.post("/smart-auth/sessions/{sid}/submit")
async def session_submit(sid: str, body: SubmitBody, request: Request, p: auth.Principal = U):
    _owner(request, p)
    data: dict[str, Any] = body.model_dump()
    body.values = None
    body.pin = None
    try:
        out = await sa.submit(sid, data, actor=p.actor, **_who(request, p))
    except sa.AuthError as e:
        raise _err(e) from None
    finally:
        for k in ("values", "pin"):
            v = data.get(k)
            if isinstance(v, dict):
                v.clear()
            data[k] = None
    return vok(out, 202)


@router.post("/smart-auth/sessions/{sid}/cancel")
async def session_cancel(sid: str, request: Request, p: auth.Principal = U):
    _owner(request, p)
    try:
        return vok(await sa.cancel(sid, actor=p.actor, reason="owner_cancelled"))
    except sa.AuthError as e:
        raise _err(e) from None


# ---------------------------------------------------------------- local only
@router.get("/smart-auth/settings")
async def get_settings(request: Request, p: auth.Principal = U):
    return vok({**sa.settings(), "pin": sa.pin_status(), "local": _local(request, p)})


class SettingsBody(BaseModel):
    enabled: bool | None = None
    remote_submission: bool | None = None
    allow_local_network: bool | None = None
    request_ttl_s: int | None = None
    otp_ttl_s: int | None = None
    token_ttl_s: int | None = None
    max_retries: int | None = None
    max_per_agent: int | None = None
    max_global: int | None = None
    max_credential_attempts: int | None = None
    max_otp_attempts: int | None = None
    session_max_s: int | None = None
    observe_interval_s: int | None = None
    max_steps: int | None = None
    loop_threshold: int | None = None
    passkey_fallback: Literal["password", "ask"] | None = None  # V3.4: passkey / security key -> "use your password"


@router.put("/smart-auth/settings")
async def put_settings(body: SettingsBody, request: Request, p: auth.Principal = U):
    require_local(request, p)
    try:
        return vok({**sa.update_settings(body.model_dump(exclude_none=True), actor=p.actor), "pin": sa.pin_status()})
    except sa.AuthError as e:
        raise _err(e) from None


class PinBody(BaseModel):
    pin: str = Field(min_length=1, max_length=64)
    current_pin: str | None = Field(default=None, max_length=64)


@router.put("/smart-auth/pin")
async def put_pin(body: PinBody, request: Request, p: auth.Principal = U):
    require_local(request, p)
    try:
        return vok(sa.set_pin(body.pin, actor=p.actor, current=body.current_pin))
    except sa.AuthError as e:
        raise _err(e) from None
    finally:
        body.pin = ""
        body.current_pin = None


@router.delete("/smart-auth/pin")
async def delete_pin(request: Request, p: auth.Principal = U):
    require_local(request, p)
    return vok(sa.clear_pin(actor=p.actor))
