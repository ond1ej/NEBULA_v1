"""NEBULA 3.2 REST API: conversations (several chats per agent) and the local Password Vault.

Conversations work everywhere (dashboard, Mini App gateway). Vault endpoints come in two classes:
* metadata (status, credential names/origins, grants, redacted audit) + the protective actions lock and revoke —
  available to the owner everywhere, including the Mini App;
* management (create, unlock, re-authenticate, add/edit/delete/reveal credentials, grants, passphrase rotation,
  export/import, settings) — only from this Mac (loopback, never through the Mini App gateway or any forwarding
  proxy); optionally also over the LAN **https** listener if the owner enabled that locally.
Every vault response is ``Cache-Control: no-store``; request bodies are never logged; validation errors never echo
input values (see errors.py).
"""

from __future__ import annotations

import asyncio
import ipaddress
import os
from typing import Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from nebula_host import agents_service, auth, db
from nebula_host import conversations as convsvc
from nebula_host import vault as vaultmod
from nebula_host.api.common import agent_scope, idem_lookup, idem_store, ok, require_agent_in_scope
from nebula_host.errors import ApiError
from nebula_host.events import audit
from nebula_host.state import svc

MAX_BODY = {"/api/v1/vault/import": 8 * 1024 * 1024}  # encrypted export files
DEFAULT_MAX_BODY = 256 * 1024


async def _body_limit(request: Request) -> None:
    """Request-size limit for every V3.2 route (checked before the body is parsed)."""
    limit = MAX_BODY.get(request.url.path, DEFAULT_MAX_BODY)
    try:
        n = int(request.headers.get("content-length") or 0)
    except ValueError:
        n = limit + 1
    if n > limit:
        raise ApiError(413, "too_large", "request body too large")


router = APIRouter(prefix="/api/v1", dependencies=[Depends(_body_limit)])
U = Depends(auth.require_session)
_FORWARD_HEADERS = ("x-nebula-gateway", "x-nebula-via", "x-forwarded-for", "x-forwarded-host", "forwarded",
                    "x-real-ip", "tailscale-user-login", "tailscale-user-name", "cf-connecting-ip", "via")


# ============================================================================ conversations
def _conv_error(e: convsvc.ConversationError) -> ApiError:
    return ApiError(e.status, e.code, str(e))


class ConversationBody(BaseModel):
    agent_id: str = Field(min_length=1, max_length=64)
    title: str | None = Field(default=None, max_length=200)


class ConversationPatch(BaseModel):
    title: str | None = Field(default=None, max_length=200)
    archived: bool | None = None


class MessageBody(BaseModel):
    content: str = Field(min_length=1, max_length=20000)
    client_id: str = Field(min_length=8, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    attachment_ids: list[str] = Field(default_factory=list, max_length=20)
    max_model_calls: int | None = Field(default=None, ge=1, le=500)  # optional hard cap on model requests


@router.get("/conversations")
async def conversations_list(agent_id: str | None = None, archived: bool = False, limit: int = 100,
                             p: auth.Principal = U):
    if (scope := agent_scope()) is not None:  # H-02: an agent's own bot lists only its agent's conversations
        if not scope or (agent_id and agent_id != scope):
            return ok([])
        agent_id = scope
    return ok(convsvc.list_(agent_id, archived, limit))


@router.get("/conversations/search")
async def conversations_search(q: str = "", limit: int = 30, p: auth.Principal = U):
    return ok(convsvc.search(q, limit))


@router.post("/conversations")
async def conversations_create(body: ConversationBody, request: Request, p: auth.Principal = U):
    require_agent_in_scope(body.agent_id)  # H-02: never a conversation with another agent
    if (cached := idem_lookup(request)) is not None:
        return cached
    try:
        c = convsvc.create(body.agent_id, body.title, p.user_id)
    except convsvc.ConversationError as e:
        raise _conv_error(e) from e
    audit(p.actor, "conversation.create", c["id"], {"agent_id": body.agent_id})
    return idem_store(request, ok(c, 201))


@router.get("/agents/{agent_id}/conversation")
async def agent_default_conversation(agent_id: str, p: auth.Principal = U):
    agents_service.get(agent_id)
    return ok(convsvc.get(convsvc.default_for(agent_id)))


@router.get("/conversations/{cid}")
async def conversations_get(cid: str, p: auth.Principal = U):
    try:
        return ok(convsvc.get(cid))
    except convsvc.ConversationError as e:
        raise _conv_error(e) from e


@router.patch("/conversations/{cid}")
async def conversations_patch(cid: str, body: ConversationPatch, p: auth.Principal = U):
    try:
        c = convsvc.update_(cid, title=body.title, archived=body.archived)
    except convsvc.ConversationError as e:
        raise _conv_error(e) from e
    audit(p.actor, "conversation.update", cid, {"archived": body.archived, "renamed": body.title is not None})
    return ok(c)


@router.post("/conversations/{cid}/read")
async def conversations_read(cid: str, p: auth.Principal = U):
    try:
        return ok(convsvc.mark_read(cid))
    except convsvc.ConversationError as e:
        raise _conv_error(e) from e


@router.get("/conversations/{cid}/messages")
async def conversations_messages(cid: str, before: float | None = None, limit: int = 50, p: auth.Principal = U):
    try:
        return ok(convsvc.messages(cid, before, limit))
    except convsvc.ConversationError as e:
        raise _conv_error(e) from e


@router.post("/conversations/{cid}/messages")
async def conversations_post(cid: str, body: MessageBody, request: Request, p: auth.Principal = U):
    try:
        conv = convsvc.get(cid)
    except convsvc.ConversationError as e:
        raise _conv_error(e) from e
    a = agents_service.get(conv["agent_id"])
    if a["status"] in ("CREATING", "DELETING", "ERROR"):
        raise ApiError(409, "agent_not_ready", f"agent is {a['status']}")
    if not a["provider_id"] or not a["model_id"]:
        raise ApiError(409, "no_model", "choose an AI provider and model for this agent first")
    if body.attachment_ids:
        from sqlalchemy import and_, select

        from nebula_host import models

        with db.engine().connect() as c:
            n = c.execute(select(models.attachments.c.id).where(and_(
                models.attachments.c.id.in_(body.attachment_ids), models.attachments.c.agent_id == conv["agent_id"],
                models.attachments.c.task_id.is_(None)))).all()
        replay = convsvc.message_by_client_id(cid, body.client_id)
        if len(n) != len(set(body.attachment_ids)) and not replay:
            raise ApiError(400, "invalid_attachments", "attachments must belong to this agent and not be used yet")
    source = "telegram" if p.via else "web"
    try:
        msg, task, replayed = convsvc.post_message(svc.orch, cid, body.content, body.client_id,
                                                   body.attachment_ids, source=source,
                                                   max_model_calls=body.max_model_calls)
    except convsvc.ConversationError as e:
        raise _conv_error(e) from e
    if replayed:
        resp = ok({"message": msg, "task": task}, 200)
        resp.headers["Idempotent-Replay"] = "true"
        return resp
    audit(p.actor, "task.create", task["id"] if task else None,
          {"agent_id": conv["agent_id"], "conversation_id": cid, "attachments": len(body.attachment_ids)})
    return ok({"message": msg, "task": task}, 201)


# ============================================================================ vault guards
def _no_store(resp: JSONResponse) -> JSONResponse:
    resp.headers["Cache-Control"] = "no-store, max-age=0"
    resp.headers["Pragma"] = "no-cache"
    return resp


def vok(data: Any, status: int = 200) -> JSONResponse:
    return _no_store(ok(data, status))


def _vault_settings() -> dict[str, Any]:
    return {"allow_lan_https": False, **(db.get_setting("vault", {}) or {})}


def is_physically_local(request: Request, p: auth.Principal) -> bool:
    """The dashboard on this Mac (loopback, no proxy, no Mini App session) — used for the remote PIN rules."""
    if p.via:
        return False
    return local_management_allowed(request, p)[0]


def local_management_allowed(request: Request, p: auth.Principal) -> tuple[bool, str]:
    if p.via:
        # V3.3: the owner's verified Mini App session (through the gateway, policy + step-up enforced centrally)
        from nebula_host import authz

        ctx = authz.current()
        if ctx is not None and ctx.owner:
            return True, ""
        return False, "Vault management is only available to the NEBULA owner"
    if any(request.headers.get(h) for h in _FORWARD_HEADERS):
        return False, "Vault management requires local authenticated access (proxied requests are refused)"
    client = request.client.host if request.client else ""
    if os.environ.get("NEBULA_TESTING") == "1" and client == "testclient":
        return True, ""
    try:
        loop = ipaddress.ip_address(client).is_loopback
    except ValueError:
        loop = False
    if loop and auth.is_loopback_request(request.headers.get("host")):
        return True, ""
    if request.url.scheme == "https" and _vault_settings().get("allow_lan_https"):
        return True, ""
    return False, "Vault management requires local authenticated access on this Mac (http://127.0.0.1)"


def require_local(request: Request, p: auth.Principal) -> None:
    allowed, why = local_management_allowed(request, p)
    if not allowed:
        audit(p.actor, "vault.refused_remote", None, {"path": request.url.path})
        raise ApiError(403, "vault_local_only", why)


def _verr(e: vaultmod.VaultError) -> ApiError:
    return ApiError(e.status, e.code, str(e), details={k: v for k, v in e.extra.items()
                                                      if k in ("retry_after", "attempts_left")})


def _login_password_check(p: auth.Principal):
    from sqlalchemy import select

    from nebula_host import models

    def check(candidate: str) -> bool:
        with db.engine().connect() as c:
            h = c.execute(select(models.users.c.password_hash).where(models.users.c.id == p.user_id)).scalar()
        return bool(h) and auth.verify_password(h, candidate)

    return check


V = vaultmod.VAULT


async def _run(fn, *a, **kw):
    """Vault calls that derive keys (Argon2id ~0.3 s, 128 MiB) run off the event loop."""
    try:
        return await asyncio.to_thread(fn, *a, **kw)
    except vaultmod.VaultError as e:
        raise _verr(e) from e


def _sync(fn, *a, **kw):
    try:
        return fn(*a, **kw)
    except vaultmod.VaultError as e:
        raise _verr(e) from e


# ============================================================================ vault: metadata (everywhere)
async def _full_status(request: Request, p: auth.Principal, base: dict[str, Any] | None = None) -> dict[str, Any]:
    s = dict(base) if base is not None else V.status()
    if p.via:
        s.pop("kdf", None)
    from nebula_host import vault_broker

    if vault_broker._guest_capability() is None:  # stale: re-run the guest's isolation self-test (bounded)
        try:
            await asyncio.wait_for(vault_broker.refresh_capability(svc.guest), 5)
        except Exception:  # noqa: BLE001 - VM down: reported as unavailable
            pass
    s["broker"] = vault_broker.status()
    s["management_local"] = local_management_allowed(request, p)[0]
    vs = _vault_settings()
    s["settings"] = {"allow_lan_https": bool(vs.get("allow_lan_https")),
                     "broker_enabled": bool(vs.get("broker_enabled", True))}
    return s


@router.get("/vault/status")
async def vault_status(request: Request, p: auth.Principal = U):
    return vok(await _full_status(request, p))


@router.get("/vault/entries")
async def vault_entries(q: str | None = None, p: auth.Principal = U):
    return vok(V.list_entries(q))


@router.get("/vault/grants")
async def vault_grants(p: auth.Principal = U):
    return vok(V.grants())


@router.get("/vault/audit")
async def vault_audit(limit: int = 50, agent_id: str | None = None, p: auth.Principal = U):
    return vok(vaultmod.audit_rows(limit, agent_id))


@router.get("/agents/{agent_id}/vault")
async def agent_vault(agent_id: str, p: auth.Principal = U):
    agents_service.get(agent_id)
    return vok(V.agent_view(agent_id))


@router.post("/vault/lock")
async def vault_lock(p: auth.Principal = U):
    return vok(V.lock("owner", actor=p.actor))


@router.post("/vault/grants/{grant_id}/revoke")
async def vault_grant_revoke(grant_id: str, p: auth.Principal = U):
    return vok(_sync(V.revoke_grant, grant_id, actor=p.actor))


# ============================================================================ vault: management (local only)
class PassBody(BaseModel):
    passphrase: str = Field(min_length=1, max_length=1024)


class RotateBody(BaseModel):
    current_passphrase: str = Field(min_length=1, max_length=1024)
    new_passphrase: str = Field(min_length=1, max_length=1024)


class EntryBody(BaseModel):
    display_name: str = Field(min_length=1, max_length=200)
    app_name: str | None = Field(default=None, max_length=200)
    origin: str | None = Field(default=None, max_length=2000)
    credential_type: str = Field(default="website", pattern="^(website|application|api_token)$")
    tags: list[str] = Field(default_factory=list, max_length=10)
    username: str | None = Field(default=None, max_length=512)
    password: str | None = Field(default=None, max_length=4096)
    notes: str | None = Field(default=None, max_length=4000)
    login_url: str | None = Field(default=None, max_length=2000)


class EntryPatch(BaseModel):
    display_name: str | None = Field(default=None, min_length=1, max_length=200)
    app_name: str | None = Field(default=None, max_length=200)
    origin: str | None = Field(default=None, max_length=2000)
    credential_type: str | None = Field(default=None, pattern="^(website|application|api_token)$")
    tags: list[str] | None = Field(default=None, max_length=10)
    username: str | None = Field(default=None, max_length=512)
    password: str | None = Field(default=None, max_length=4096)
    notes: str | None = Field(default=None, max_length=4000)
    login_url: str | None = Field(default=None, max_length=2000)


class RevealBody(BaseModel):
    field: str = Field(default="password", pattern="^(password|username|notes)$")


class SettingsBody(BaseModel):
    auto_lock_minutes: int | None = None
    allow_lan_https: bool | None = None
    broker_enabled: bool | None = None  # agent credential use (sign-in broker) on/off


class ExportBody(BaseModel):
    export_passphrase: str = Field(min_length=1, max_length=1024)


class ImportBody(BaseModel):
    export_passphrase: str = Field(min_length=1, max_length=1024)
    export: dict[str, Any]
    confirm: bool = False


class ModeBody(BaseModel):
    mode: str = Field(pattern="^(NONE|SELECTED|MANAGED)$")
    managed_tags: list[str] = Field(default_factory=list, max_length=10)


class GrantBody(BaseModel):
    entry_id: str = Field(min_length=1, max_length=64)
    allowed_origins: list[str] | None = Field(default=None, max_length=10)
    allowed_actions: list[str] = Field(default_factory=lambda: ["sign_in"], max_length=5)
    approval_policy: str = Field(default="always_ask", pattern="^(always_ask|once_per_task|auto)$")
    expires_at: float | None = None


class GrantPatch(BaseModel):
    allowed_origins: list[str] | None = Field(default=None, max_length=10)
    approval_policy: str | None = Field(default=None, pattern="^(always_ask|once_per_task|auto)$")
    expires_at: float | None = None
    clear_expiry: bool = False
    enabled: bool | None = None


@router.post("/vault")
async def vault_create(body: PassBody, request: Request, p: auth.Principal = U):
    require_local(request, p)
    st = await _run(V.create, body.passphrase, actor=p.actor, login_password_check=_login_password_check(p),
                    session_id=p.session_id)
    return vok(await _full_status(request, p, st), 201)


@router.post("/vault/unlock")
async def vault_unlock(body: PassBody, request: Request, p: auth.Principal = U):
    require_local(request, p)
    return vok(await _full_status(request, p, await _run(V.unlock, body.passphrase, actor=p.actor,
                                                         session_id=p.session_id)))


@router.post("/vault/reauth")
async def vault_reauth(body: PassBody, request: Request, p: auth.Principal = U):
    require_local(request, p)
    return vok(await _run(V.reauth, body.passphrase, actor=p.actor, session_id=p.session_id))


@router.post("/vault/passphrase")
async def vault_rotate(body: RotateBody, request: Request, p: auth.Principal = U):
    require_local(request, p)
    st = await _run(V.rotate, body.current_passphrase, body.new_passphrase, actor=p.actor,
                    login_password_check=_login_password_check(p), session_id=p.session_id)
    return vok(await _full_status(request, p, st))


@router.put("/vault/settings")
async def vault_settings(body: SettingsBody, request: Request, p: auth.Principal = U):
    require_local(request, p)
    if body.allow_lan_https is not None:
        db.set_setting("vault", {**_vault_settings(), "allow_lan_https": bool(body.allow_lan_https)})
        audit(p.actor, "vault.settings", None, {"allow_lan_https": bool(body.allow_lan_https)})
        vaultmod.record(p.actor, "settings", outcome="ok", reason=f"allow_lan_https_{bool(body.allow_lan_https)}")
    if body.broker_enabled is not None:
        db.set_setting("vault", {**_vault_settings(), "broker_enabled": bool(body.broker_enabled)})
        vaultmod.record(p.actor, "settings", outcome="ok", reason=f"broker_enabled_{bool(body.broker_enabled)}")
        if not body.broker_enabled:  # turning agent credential use off also ends pending requests
            vaultmod.expire_pending_approvals("broker_disabled")
    if body.auto_lock_minutes is not None:
        _sync(V.set_auto_lock, body.auto_lock_minutes, actor=p.actor)
    return vok(await _full_status(request, p))


@router.get("/vault/entries/{entry_id}")
async def vault_entry_detail(entry_id: str, request: Request, p: auth.Principal = U):
    require_local(request, p)
    return vok(_sync(V.entry_detail, entry_id))


@router.post("/vault/entries")
async def vault_entry_create(body: EntryBody, request: Request, p: auth.Principal = U):
    require_local(request, p)
    return vok(_sync(V.add_entry, body.model_dump(exclude_none=True), actor=p.actor), 201)


@router.patch("/vault/entries/{entry_id}")
async def vault_entry_update(entry_id: str, body: EntryPatch, request: Request, p: auth.Principal = U):
    require_local(request, p)
    return vok(_sync(V.update_entry, entry_id, body.model_dump(exclude_unset=True), actor=p.actor))


@router.delete("/vault/entries/{entry_id}")
async def vault_entry_delete(entry_id: str, request: Request, confirm: bool = False, p: auth.Principal = U):
    require_local(request, p)
    if not confirm:
        raise ApiError(400, "confirm_required", "deleting a credential needs confirm=true")
    return vok(_sync(V.delete_entry, entry_id, actor=p.actor))


@router.post("/vault/entries/{entry_id}/reveal")
async def vault_entry_reveal(entry_id: str, body: RevealBody, request: Request, p: auth.Principal = U):
    require_local(request, p)
    return vok(_sync(V.reveal, entry_id, actor=p.actor, field=body.field, session_id=p.session_id))


@router.post("/vault/export")
async def vault_export(body: ExportBody, request: Request, p: auth.Principal = U):
    require_local(request, p)
    data = await _run(V.export, body.export_passphrase, actor=p.actor, session_id=p.session_id)
    resp = vok(data)
    resp.headers["Content-Disposition"] = "attachment; filename=nebula-vault-export.json"
    return resp


@router.post("/vault/import")
async def vault_import(body: ImportBody, request: Request, p: auth.Principal = U):
    require_local(request, p)
    return vok(await _run(V.import_, body.export, body.export_passphrase, actor=p.actor, confirm=body.confirm))


@router.put("/agents/{agent_id}/vault")
async def agent_vault_mode(agent_id: str, body: ModeBody, request: Request, p: auth.Principal = U):
    require_local(request, p)
    agents_service.get(agent_id)
    return vok(_sync(V.set_agent_mode, agent_id, body.mode, body.managed_tags, actor=p.actor))


@router.post("/agents/{agent_id}/vault/grants")
async def agent_vault_grant(agent_id: str, body: GrantBody, request: Request, p: auth.Principal = U):
    require_local(request, p)
    agents_service.get(agent_id)
    return vok(_sync(V.create_grant, agent_id, body.entry_id, origins=body.allowed_origins,
                     actions=body.allowed_actions, policy=body.approval_policy, expires_at=body.expires_at,
                     actor=p.actor), 201)


@router.patch("/vault/grants/{grant_id}")
async def vault_grant_update(grant_id: str, body: GrantPatch, request: Request, p: auth.Principal = U):
    require_local(request, p)
    changes: dict[str, Any] = {"origins": body.allowed_origins, "policy": body.approval_policy,
                               "enabled": body.enabled}
    if body.clear_expiry:
        changes["expires_at"] = None
    elif body.expires_at is not None:
        changes["expires_at"] = body.expires_at
    return vok(_sync(V.update_grant, grant_id, actor=p.actor, **changes))


@router.delete("/vault/grants/{grant_id}")
async def vault_grant_delete(grant_id: str, request: Request, p: auth.Principal = U):
    require_local(request, p)
    return vok(_sync(V.delete_grant, grant_id, actor=p.actor))
