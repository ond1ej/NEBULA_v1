"""NEBULA V3 REST API: execution environments + host roots, AI companies, Telegram bot network, notification levels,
voice 2.0 (STT/TTS, models, per-agent voice), multimodal attachments, remote access / Mini App sessions, approval
center, notifications and monitoring.

Same guarantees as V1/V2: session cookie + CSRF on mutations, Host/Origin checks in the middleware, audit entries,
destructive operations require confirm=true. Owner-only operations (host roots, bot tokens, remote access, model
downloads) are additionally refused for Telegram Mini App sessions.
"""

from __future__ import annotations

import asyncio
import os
import re
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, File, Query, Request, UploadFile
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field
from sqlalchemy import and_, func, select

from nebula_host import attachments as attsvc
from nebula_host import auth, db, environments, hostexec, miniapp, models, stt, tts
from nebula_host import companies as cosvc
from nebula_host import remote as remotesvc
from nebula_host import voice as voicesvc
from nebula_host.api.common import ok, require_fresh_owner_remote
from nebula_host.errors import ApiError
from nebula_host.events import audit
from nebula_host.state import svc

router = APIRouter(prefix="/api/v1")
U = Depends(auth.require_session)


def owner_only(p: auth.Principal) -> None:
    """V3.3: the owner may do this from the dashboard or from their verified Mini App session (the central policy
    already enforced the required assurance); other Telegram roles never."""
    if p.via:
        from nebula_host import authz

        ctx = authz.current()
        if ctx is None or not ctx.owner:
            raise ApiError(403, "owner_only", "only the NEBULA owner can do this")


def _agent(agent_id: str) -> dict[str, Any]:
    with db.engine().connect() as c:
        a = db.row(c.execute(select(models.agents).where(models.agents.c.id == agent_id)).first())
    if not a:
        raise ApiError(404, "agent_not_found", "agent not found")
    return a


def _co(e: Exception) -> ApiError:
    if isinstance(e, cosvc.CompanyError):
        return ApiError(e.status, e.code, e.message)
    if isinstance(e, hostexec.HostExecError):
        return ApiError(e.status, e.code, e.message)
    if isinstance(e, environments.EnvError):
        return ApiError(e.status, e.code, e.message)
    return ApiError(400, "invalid_request", str(e))


_ENV_KEYS = ("default_environment", "environment")
_ROOT_KEYS = ("default_root_id", "host_root_id", "root_id")


def _selects_host(body: Any) -> bool:
    """Does a company/project body move work onto native Mac execution (or pick a Mac folder), anywhere in it?"""
    if isinstance(body, dict):
        for k, v in body.items():
            if (k in _ENV_KEYS and v == "host") or (k in _ROOT_KEYS and v):
                return True
            if isinstance(v, (dict, list)) and _selects_host(v):
                return True
    elif isinstance(body, list):
        return any(_selects_host(x) for x in body)
    return False


def _guard_host_switch(body: Any) -> None:
    """VM-07: choosing native host execution is as sensitive as PUT /agents/{id}/environment (admin!), whichever
    route it goes through."""
    if _selects_host(body):
        require_fresh_owner_remote("only the NEBULA owner can move work onto this Mac")


def _company_uses_host(company_id: str | None) -> bool:
    """Does anything in this company resolve to native Mac execution (company default, a project, a member or a
    project assignment)? Members inherit through these levels (environments.resolve), so adding, changing or
    assigning a member there can put an agent on this Mac without naming `host` in the request body."""
    if not company_id:
        return False
    with db.engine().connect() as c:
        if c.execute(select(models.companies.c.id).where(and_(
                models.companies.c.id == company_id, models.companies.c.default_environment == "host"))).first():
            return True
        if c.execute(select(models.company_projects.c.id).where(and_(
                models.company_projects.c.company_id == company_id,
                models.company_projects.c.environment == "host"))).first():
            return True
        if c.execute(select(models.company_members.c.agent_id).where(and_(
                models.company_members.c.company_id == company_id,
                models.company_members.c.environment == "host"))).first():
            return True
        return c.execute(select(models.project_members.c.agent_id).select_from(models.project_members.join(
            models.company_projects, models.company_projects.c.id == models.project_members.c.project_id)).where(and_(
                models.company_projects.c.company_id == company_id,
                models.project_members.c.environment == "host"))).first() is not None


def _project_company(project_id: str) -> str | None:
    with db.engine().connect() as c:
        return c.execute(select(models.company_projects.c.company_id)
                         .where(models.company_projects.c.id == project_id)).scalar()


def _guard_host_members(company_id: str | None, changes_members: bool) -> None:
    """VM-07: membership and assignment changes in a company that runs work on this Mac need a fresh owner, like
    selecting `host` directly (an operator with `companies` could otherwise add an agent that inherits `host`)."""
    if changes_members and _company_uses_host(company_id):
        require_fresh_owner_remote("only the NEBULA owner can change who works on this Mac")


# ============================================================================ environments & host execution
@router.get("/environments")
async def environments_info(p: auth.Principal = U):
    vm = {"state": "unknown"}
    try:
        vm = await svc.vm.astatus() if svc.vm else vm
    except Exception as e:  # noqa: BLE001
        vm = {"state": "error", "detail": str(e)[:200]}
    from nebula_host.vm import host_resources

    res = await asyncio.to_thread(host_resources, svc.cfg.data_dir)
    return ok({"environments": environments.describe(), "host": {**svc.host.status(), "resources": res},
               "vm": {**vm, "active_streams": len(svc.live.active_streams()) if svc.live else 0}})


class RootBody(BaseModel):
    path: str = Field(min_length=1, max_length=1024)
    name: str | None = Field(default=None, max_length=128)
    mode: str = "read_write"
    allow_network: bool = False  # VM-03: a new Mac project folder has no network unless the owner turns it on
    allowed_tools: list[str] = []


class RootPatch(BaseModel):
    name: str | None = None
    mode: str | None = None
    allow_network: bool | None = None
    allowed_tools: list[str] | None = None
    enabled: bool | None = None


@router.get("/host/roots")
async def host_roots(p: auth.Principal = U):
    return ok(hostexec.list_roots())


@router.post("/host/roots")
async def host_root_add(body: RootBody, p: auth.Principal = U):
    owner_only(p)
    try:
        return ok(hostexec.add_root(svc.cfg, body.model_dump(), p.actor), 201)
    except hostexec.HostExecError as e:
        raise _co(e) from e


@router.patch("/host/roots/{root_id}")
async def host_root_patch(root_id: str, body: RootPatch, p: auth.Principal = U):
    owner_only(p)
    try:
        return ok(hostexec.update_root(root_id, body.model_dump(exclude_none=True), p.actor))
    except hostexec.HostExecError as e:
        raise _co(e) from e


@router.delete("/host/roots/{root_id}")
async def host_root_delete(root_id: str, confirm: bool = False, p: auth.Principal = U):
    owner_only(p)
    if not confirm:
        raise ApiError(400, "confirm_required", "revoking access needs confirm=true (the folder itself is never "
                                                "deleted)")
    with db.engine().connect() as c:
        used = c.execute(select(models.company_projects.c.name).where(
            models.company_projects.c.host_root_id == root_id)).all()
    try:
        hostexec.remove_root(root_id, p.actor)
    except hostexec.HostExecError as e:
        raise _co(e) from e
    return ok({"revoked": root_id, "projects_unlinked": [r.name for r in used]})


@router.post("/host/roots/{root_id}/selftest")
async def host_root_selftest(root_id: str, p: auth.Principal = U):
    try:
        return ok(await svc.host.selftest(root_id))
    except hostexec.HostExecError as e:
        raise _co(e) from e


@router.get("/host/tools")
async def host_tools(refresh: bool = False, p: auth.Principal = U):
    return ok({"tools": await asyncio.to_thread(hostexec.detect_tools, refresh), "sandbox": hostexec.sandbox_available(),
               "gui_control": hostexec.gui_permissions()})


@router.get("/host/commands")
async def host_commands(root_id: str | None = None, agent_id: str | None = None, limit: int = 100,
                        p: auth.Principal = U):
    return ok(svc.host.recent_commands(root_id, agent_id, limit))


@router.get("/host/browse")
async def host_browse(path: str | None = None, p: auth.Principal = U):
    """Directory picker for authorising a project folder (owner only; folder names only, no file contents)."""
    owner_only(p)
    home = Path.home().resolve()
    target = Path(os.path.expanduser(path)).resolve() if path else home
    if target != home and home not in target.parents and Path("/Volumes") not in target.parents and \
            target != Path("/Volumes"):
        raise ApiError(400, "outside_home", "browse your home folder or /Volumes")
    hidden = {home / "Library", home / ".ssh", home / ".gnupg", home / ".aws", Path(svc.cfg.data_dir).resolve()}
    try:
        dirs = sorted((d for d in target.iterdir() if d.is_dir() and not d.is_symlink() and not d.name.startswith(".")
                       and d.resolve() not in hidden), key=lambda d: d.name.lower())[:300]
    except PermissionError as e:
        raise ApiError(403, "not_readable", "macOS does not allow NEBULA to list this folder") from e
    out = []
    for d in dirs:
        try:
            ok_ = hostexec.validate_root_path(svc.cfg, str(d)) is not None
            why = None
        except hostexec.HostExecError as e:
            ok_, why = False, e.message
        out.append({"name": d.name, "path": str(d), "authorisable": ok_, "reason": why,
                    "git": (d / ".git").exists(), "project_markers": [m for m in ("package.json", "pyproject.toml",
                                                                                  "Package.swift", "pubspec.yaml",
                                                                                  "Cargo.toml", "go.mod", "Makefile")
                                                                      if (d / m).exists()]})
    try:
        hostexec.validate_root_path(svc.cfg, str(target))
        cur_ok, cur_why = True, None
    except hostexec.HostExecError as e:
        cur_ok, cur_why = False, e.message
    return ok({"path": str(target), "parent": str(target.parent) if target != home else None, "dirs": out,
               "authorisable": cur_ok, "reason": cur_why})


@router.get("/agents/{agent_id}/environment")
async def agent_env(agent_id: str, project_id: str | None = None, p: auth.Principal = U):
    _agent(agent_id)
    return ok(environments.summary(agent_id, project_id))


class EnvBody(BaseModel):
    env: str
    root_id: str | None = None


@router.put("/agents/{agent_id}/environment")
async def agent_env_set(agent_id: str, body: EnvBody, p: auth.Principal = U):
    owner_only(p)
    try:
        return ok(await environments.switch(agent_id, body.env, body.root_id, p.actor, svc.guest))
    except environments.EnvError as e:
        raise _co(e) from e


# ============================================================================ AI companies
@router.get("/companies/roles")
async def company_roles(p: auth.Principal = U):
    return ok([{"key": k, "title": v[0], "responsibilities": v[1], "stage": v[2]} for k, v in cosvc.ROLE_CATALOG.items()])


@router.get("/companies")
async def companies_list(p: auth.Principal = U):
    return ok(cosvc.list_companies())


@router.post("/companies")
async def companies_create(body: dict[str, Any], p: auth.Principal = U):
    _guard_host_switch(body)
    try:
        return ok(await svc.companies.create(body, p.actor), 201)
    except (cosvc.CompanyError, hostexec.HostExecError, ValueError, TypeError) as e:
        raise _co(e) from e


@router.get("/companies/{company_id}")
async def companies_get(company_id: str, p: auth.Principal = U):
    try:
        return ok(cosvc.get_company(company_id))
    except cosvc.CompanyError as e:
        raise _co(e) from e


@router.patch("/companies/{company_id}")
async def companies_patch(company_id: str, body: dict[str, Any], p: auth.Principal = U):
    _guard_host_switch(body)
    _guard_host_members(company_id, body.get("members") is not None)
    try:
        return ok(await svc.companies.update(company_id, body, p.actor))
    except (cosvc.CompanyError, hostexec.HostExecError, ValueError, TypeError) as e:
        raise _co(e) from e


@router.delete("/companies/{company_id}")
async def companies_delete(company_id: str, confirm: bool = False, delete_files: bool = False, p: auth.Principal = U):
    owner_only(p)
    if not confirm:
        raise ApiError(400, "confirm_required", "deleting a company needs confirm=true")
    try:
        return ok(await svc.companies.delete(company_id, p.actor, delete_files))
    except cosvc.CompanyError as e:
        raise _co(e) from e


@router.get("/companies/{company_id}/org")
async def companies_org(company_id: str, p: auth.Principal = U):
    try:
        co = cosvc.get_company(company_id)
    except cosvc.CompanyError as e:
        raise _co(e) from e
    nodes = [{"agent_id": m["agent_id"], "name": m["agent_name"], "role_key": m["role_key"], "role": m["role_title"],
              "title": m["title"], "reports_to": m["reports_to"] or (co["ceo_agent_id"] if m["role_key"] != "ceo"
                                                                     else None),
              "model": m["model_id"], "provider": m["provider_id"], "status": m["agent_status"],
              "lifecycle": m["lifecycle"], "environment": m["environment_effective"], "current_item": m["current_item"]}
             for m in co["members"]]
    return ok({"company_id": company_id, "nodes": nodes, "roles": co["roles"]})


@router.get("/companies/{company_id}/activity")
async def companies_activity(company_id: str, project_id: str | None = None, limit: int = 100, p: auth.Principal = U):
    return ok(cosvc.activity(company_id, limit, project_id))


@router.get("/companies/{company_id}/knowledge")
async def companies_knowledge(company_id: str, project_id: str | None = None, kind: str | None = None,
                              q: str | None = None, p: auth.Principal = U):
    return ok(cosvc.knowledge_list(company_id, project_id, kind, q))


@router.post("/companies/{company_id}/knowledge")
async def companies_knowledge_add(company_id: str, body: dict[str, Any], p: auth.Principal = U):
    try:
        return ok(cosvc.knowledge_add(company_id, body, p.actor), 201)
    except cosvc.CompanyError as e:
        raise _co(e) from e


@router.patch("/companies/{company_id}/knowledge/{kid}")
async def companies_knowledge_update(company_id: str, kid: str, body: dict[str, Any], p: auth.Principal = U):
    try:
        r = cosvc.knowledge_update(company_id, kid, body)
    except cosvc.CompanyError as e:
        raise _co(e) from e
    audit(p.actor, "company.knowledge.update", kid, {"company_id": company_id})
    return ok(r)


@router.delete("/companies/{company_id}/knowledge/{kid}")
async def companies_knowledge_delete(company_id: str, kid: str, p: auth.Principal = U):
    try:
        cosvc.knowledge_delete(company_id, kid)
    except cosvc.CompanyError as e:
        raise _co(e) from e
    audit(p.actor, "company.knowledge.delete", kid, {"company_id": company_id})
    return ok({"deleted": kid})


@router.post("/companies/{company_id}/projects")
async def projects_create(company_id: str, body: dict[str, Any], p: auth.Principal = U):
    _guard_host_switch(body)
    _guard_host_members(company_id, True)  # a new project always gets assignments (by default every employee)
    try:
        return ok(await svc.companies.create_project(company_id, body, p.actor), 201)
    except (cosvc.CompanyError, hostexec.HostExecError, ValueError, TypeError) as e:
        raise _co(e) from e


@router.get("/projects/{project_id}")
async def projects_get(project_id: str, p: auth.Principal = U):
    try:
        return ok(cosvc.get_project(project_id))
    except cosvc.CompanyError as e:
        raise _co(e) from e


@router.patch("/projects/{project_id}")
async def projects_patch(project_id: str, body: dict[str, Any], p: auth.Principal = U):
    _guard_host_switch(body)
    if body.get("assign") is not None:
        _guard_host_members(_project_company(project_id), True)
    try:
        return ok(await svc.companies.update_project(project_id, body, p.actor))
    except (cosvc.CompanyError, hostexec.HostExecError, ValueError, TypeError) as e:
        raise _co(e) from e


@router.delete("/projects/{project_id}")
async def projects_delete(project_id: str, confirm: bool = False, p: auth.Principal = U):
    owner_only(p)
    if not confirm:
        raise ApiError(400, "confirm_required", "deleting a project needs confirm=true (files are kept)")
    try:
        return ok(await svc.companies.delete_project(project_id, p.actor))
    except cosvc.CompanyError as e:
        raise _co(e) from e


@router.get("/projects/{project_id}/git")
async def projects_git(project_id: str, p: auth.Principal = U):
    try:
        return ok(await svc.companies.project_git(project_id))
    except cosvc.CompanyError as e:
        raise _co(e) from e


@router.get("/projects/{project_id}/runs")
async def projects_runs(project_id: str, p: auth.Principal = U):
    try:
        return ok(cosvc.get_project(project_id)["runs"])
    except cosvc.CompanyError as e:
        raise _co(e) from e


class RunBody(BaseModel):
    objective: str = Field(min_length=1, max_length=8000)
    planner: str = "template"
    max_model_calls: int | None = Field(default=None, ge=1, le=500)


@router.post("/projects/{project_id}/runs")
async def projects_run(project_id: str, body: RunBody, p: auth.Principal = U):
    try:
        return ok(await svc.companies.start_run(project_id, body.objective, planner=body.planner, actor=p.actor,
                                                source="miniapp" if p.via else "web",
                                                max_model_calls=body.max_model_calls), 201)
    except cosvc.CompanyError as e:
        raise _co(e) from e


@router.get("/company-runs/{run_id}")
async def company_run(run_id: str, p: auth.Principal = U):
    try:
        return ok(cosvc.get_run(run_id))
    except cosvc.CompanyError as e:
        raise _co(e) from e


@router.post("/company-runs/{run_id}/{action}")
async def company_run_action(run_id: str, action: str, p: auth.Principal = U):
    fn = {"pause": svc.companies.pause_run, "resume": svc.companies.resume_run,
          "cancel": svc.companies.cancel_run}.get(action)
    if not fn:
        raise ApiError(404, "not_found", "unknown action")
    try:
        return ok(await fn(run_id, p.actor))
    except cosvc.CompanyError as e:
        raise _co(e) from e


@router.post("/company-items/{item_id}/retry")
async def company_item_retry(item_id: str, p: auth.Principal = U):
    try:
        return ok(await svc.companies.retry_item(item_id, p.actor))
    except cosvc.CompanyError as e:
        raise _co(e) from e


# ============================================================================ Telegram bot network
@router.get("/bots")
async def bots_list(p: auth.Principal = U):
    main = svc.telegram.public_status() if svc.telegram else {}
    return ok({"main": {k: main.get(k) for k in ("enabled", "configured", "polling", "bot_username", "bot_id",
                                                 "last_poll_at", "last_error")} | {
        "users": [{k: u.get(k) for k in ("id", "telegram_user_id", "username", "display_name", "status",
                                         "notify_level", "pairing_id")} for u in main.get("users", [])]},
        "agent_bots": svc.bots.list(), "status": svc.bots.status()})


class BotBody(BaseModel):
    agent_id: str
    token: str = Field(min_length=20, max_length=128)
    configure: bool = True


@router.post("/bots")
async def bots_add(body: BotBody, p: auth.Principal = U):
    owner_only(p)
    from nebula_telegram.multibot import BotError

    try:
        return ok(await svc.bots.add(body.agent_id, body.token, p.actor, configure=body.configure), 201)
    except BotError as e:
        raise ApiError(e.status, e.code, e.message) from e


def _bot_err(fn):
    from nebula_telegram.multibot import BotError

    try:
        return fn()
    except BotError as e:
        raise ApiError(e.status, e.code, e.message) from e


@router.get("/bots/{bot_id}")
async def bots_get(bot_id: str, p: auth.Principal = U):
    from nebula_telegram.multibot import get_bot, public

    return ok(_bot_err(lambda: public(get_bot(bot_id), svc.bots.runners.get(bot_id))))


@router.post("/bots/{bot_id}/pairing")
async def bots_pairing(bot_id: str, p: auth.Principal = U):
    owner_only(p)
    return ok(_bot_err(lambda: svc.bots.create_pairing(bot_id, p.actor)), 201)


@router.post("/bots/{bot_id}/users/{user_row_id}/{action}")
async def bots_user(bot_id: str, user_row_id: str, action: str, p: auth.Principal = U):
    owner_only(p)
    if action not in ("approve", "revoke"):
        raise ApiError(404, "not_found", "unknown action")
    return ok(_bot_err(lambda: svc.bots.approve_user(bot_id, user_row_id, p.actor, action == "approve")))


class EnabledBody(BaseModel):
    enabled: bool


@router.post("/bots/{bot_id}/enabled")
async def bots_enabled(bot_id: str, body: EnabledBody, p: auth.Principal = U):
    owner_only(p)
    from nebula_telegram.multibot import BotError

    try:
        return ok(await svc.bots.set_enabled(bot_id, body.enabled, p.actor))
    except BotError as e:
        raise ApiError(e.status, e.code, e.message) from e


@router.post("/bots/{bot_id}/reconnect")
async def bots_reconnect(bot_id: str, p: auth.Principal = U):
    owner_only(p)
    from nebula_telegram.multibot import BotError

    try:
        return ok(await svc.bots.reconnect(bot_id, p.actor))
    except BotError as e:
        raise ApiError(e.status, e.code, e.message) from e


@router.post("/bots/{bot_id}/configure")
async def bots_configure(bot_id: str, p: auth.Principal = U):
    owner_only(p)
    from nebula_telegram.multibot import BotError

    try:
        return ok(await svc.bots.configure(bot_id))
    except BotError as e:
        raise ApiError(e.status, e.code, e.message) from e


@router.delete("/bots/{bot_id}")
async def bots_delete(bot_id: str, confirm: bool = False, p: auth.Principal = U):
    owner_only(p)
    if not confirm:
        raise ApiError(400, "confirm_required", "removing the binding needs confirm=true")
    from nebula_telegram.multibot import BotError

    try:
        return ok(await svc.bots.remove(bot_id, p.actor))
    except BotError as e:
        raise ApiError(e.status, e.code, e.message) from e


class NotifyBody(BaseModel):
    level: str


@router.patch("/telegram/users/{user_row_id}/notify")
async def telegram_notify_level(user_row_id: str, body: NotifyBody, p: auth.Principal = U):
    from nebula_telegram import cards

    if body.level not in cards.LEVELS:
        raise ApiError(400, "invalid_level", "level must be one of " + ", ".join(cards.LEVELS))
    with db.engine().begin() as c:
        n = c.execute(models.telegram_users.update().where(models.telegram_users.c.id == user_row_id)
                      .values(notify_level=body.level)).rowcount
        if not n:
            n = c.execute(models.telegram_bot_users.update().where(models.telegram_bot_users.c.id == user_row_id)
                          .values(notify_level=body.level)).rowcount
    if not n:
        raise ApiError(404, "not_found", "unknown Telegram user")
    audit(p.actor, "telegram.notify_level", user_row_id, {"level": body.level})
    return ok({"id": user_row_id, "notify_level": body.level})


# ============================================================================ voice 2.0
@router.get("/voice/status")
async def voice_status(p: auth.Principal = U):
    return ok({"stt": stt.status(svc.cfg), "tts": await asyncio.to_thread(tts.status)})


@router.get("/voice/tts")
async def voice_tts(p: auth.Principal = U):
    return ok({**await asyncio.to_thread(tts.status), "settings": tts.settings(),
               "voices": await asyncio.to_thread(tts.voices)})


@router.patch("/voice/tts")
async def voice_tts_patch(body: dict[str, Any], p: auth.Principal = U):
    owner_only(p)
    s = tts.settings()
    if "cloud_consent" in body:
        s["cloud_consent"] = bool(body["cloud_consent"])
    if "provider" in body:
        if body["provider"] not in ("macos", "openai"):
            raise ApiError(400, "invalid_provider", "provider must be macos or openai")
        if body["provider"] == "openai" and not s["cloud_consent"]:
            raise ApiError(409, "consent_required", "cloud TTS sends text to OpenAI: give explicit consent first")
        s["provider"] = body["provider"]
    if not s["cloud_consent"] and s["provider"] == "openai":
        s["provider"] = "macos"  # withdrawing consent always falls back to the local voice
    for k in ("cloud_model", "cloud_voice"):
        if body.get(k):
            s[k] = str(body[k])[:64]
    db.set_setting("voice.tts", s)
    audit(p.actor, "voice.tts.settings", None, s)
    return ok(s)


class PreviewBody(BaseModel):
    text: str = Field(min_length=1, max_length=1500)
    language: str = "en"  # English unless the caller asks for Czech ("cs")
    voice: str | None = None
    rate: float = Field(default=1.0, ge=0.5, le=2.0)
    provider: str | None = None
    format: str = "ogg"


@router.post("/voice/tts/preview")
async def voice_preview(body: PreviewBody, p: auth.Principal = U):
    try:
        r = await tts.synthesize(body.text, language=body.language, voice=body.voice, rate=body.rate,
                                 provider=body.provider, fmt=body.format if body.format in ("ogg", "m4a") else "ogg")
    except (tts.TTSError, OSError) as e:
        raise ApiError(400, "tts_failed", str(e)) from e
    except Exception as e:  # noqa: BLE001 - subprocess failures
        raise ApiError(500, "tts_failed", f"{type(e).__name__}: {e}") from e
    return Response(r["audio"], media_type=r["mime"], headers={"X-Voice": r["voice"] or "", "X-Provider": r["provider"],
                                                              "X-Duration": str(r.get("duration_s") or "")})


_downloads: dict[str, asyncio.Task] = {}
_download_errors: dict[str, str] = {}


@router.get("/voice/models")
async def voice_models(p: auth.Principal = U):
    return ok([{**m, "error": _download_errors.get(m["name"])} for m in stt.models_status(svc.cfg)])


@router.post("/voice/models/{name}/download")
async def voice_model_download(name: str, confirm: bool = False, p: auth.Principal = U):
    owner_only(p)
    if name not in stt.MODELS:
        raise ApiError(404, "unknown_model", "unknown model")
    if not confirm:
        raise ApiError(400, "confirm_required", f"downloads ggml-{name}.bin (~{stt.MODELS[name] // 1048576} MB) from "
                                                "huggingface.co/ggerganov/whisper.cpp; confirm=true required")
    if name in _downloads and not _downloads[name].done():
        return ok({"name": name, "downloading": True})

    async def run():
        _download_errors.pop(name, None)
        try:
            r = await stt.download_model(svc.cfg, name)
            audit(p.actor, "voice.model.download", name, {"bytes": r.get("bytes"), "sha256": r.get("sha256")})
        except Exception as e:  # noqa: BLE001
            _download_errors[name] = str(e)[:300]
            (svc.cfg.data_dir / "models" / f"ggml-{name}.bin.part").unlink(missing_ok=True)
            audit(p.actor, "voice.model.download_failed", name, {"error": str(e)[:300]})

    _downloads[name] = asyncio.create_task(run())
    audit(p.actor, "voice.model.download_start", name)
    return ok({"name": name, "downloading": True}, 202)


@router.get("/agents/{agent_id}/voice")
async def agent_voice_get(agent_id: str, p: auth.Principal = U):
    return ok(voicesvc.agent_voice(_agent(agent_id)))


@router.put("/agents/{agent_id}/voice")
async def agent_voice_put(agent_id: str, body: dict[str, Any], p: auth.Principal = U):
    a = _agent(agent_id)
    v = voicesvc.agent_voice(a)
    if "reply_mode" in body:
        if body["reply_mode"] not in voicesvc.REPLY_MODES:
            raise ApiError(400, "invalid_mode", "reply_mode must be one of " + ", ".join(voicesvc.REPLY_MODES))
        v["reply_mode"] = body["reply_mode"]
    if "provider" in body:
        if body["provider"] not in ("macos", "openai"):
            raise ApiError(400, "invalid_provider", "provider must be macos or openai")
        if body["provider"] == "openai" and not tts.settings()["cloud_consent"]:
            raise ApiError(409, "consent_required", "cloud TTS needs your explicit consent in Voice settings first")
        v["provider"] = body["provider"]
    if "voice" in body:
        v["voice"] = str(body["voice"])[:64] if body["voice"] else None
    if "language" in body:
        if body["language"] not in ("auto", "cs", "en"):
            raise ApiError(400, "invalid_language", "language must be auto, cs or en")
        v["language"] = body["language"]
    if "rate" in body:
        v["rate"] = max(0.5, min(float(body["rate"]), 2.0))
    cfg = dict(a.get("config") or {})
    cfg["voice"] = v
    with db.engine().begin() as c:
        c.execute(models.agents.update().where(models.agents.c.id == agent_id).values(config=cfg, updated_at=db.now()))
    audit(p.actor, "agent.voice", agent_id, v)
    return ok(v)


# ============================================================================ multimodal attachments
@router.post("/agents/{agent_id}/attachments")
async def attachments_upload(agent_id: str, file: UploadFile = File(...), p: auth.Principal = U):
    a = _agent(agent_id)
    data = await file.read(attsvc.MAX_BYTES["web"] + 1)
    try:
        att = await asyncio.to_thread(attsvc.intake, svc.cfg, data, file.filename or "upload",
                                      file.content_type or "application/octet-stream",
                                      source="api" if p.via else "web", agent_id=agent_id, user_id=p.user_id,
                                      conversation=f"web:{agent_id}",
                                      kind_hint="voice" if (file.filename or "").lower().startswith("voice.")
                                      else None)
    except attsvc.AttachmentError as e:
        raise ApiError(e.status, e.code, e.message) from e
    att = await attsvc.process(svc.cfg, att["id"])
    try:
        await attsvc.deliver_to_workspace(svc.cfg, att, svc.files, svc.host, environments.agent_execution(a)["env"])
    except Exception as e:  # noqa: BLE001 - extraction is still available to the task
        audit(p.actor, "attachment.workspace_failed", att["id"], {"error": str(e)[:200]})
    audit(p.actor, "attachment.upload", att["id"], {"agent_id": agent_id, "kind": att["kind"], "size": att["size"]})
    return ok(attsvc.get(att["id"]), 201)


@router.get("/agents/{agent_id}/attachments")
async def attachments_list(agent_id: str, task_id: str | None = None, p: auth.Principal = U):
    return ok(attsvc.list_for(agent_id=agent_id, task_id=task_id))


@router.get("/attachments/{att_id}")
async def attachments_get(att_id: str, p: auth.Principal = U):
    try:
        return ok(attsvc.get(att_id))
    except attsvc.AttachmentError as e:
        raise ApiError(e.status, e.code, e.message) from e


@router.get("/attachments/{att_id}/content")
async def attachments_content(att_id: str, derived: str | None = None, p: auth.Principal = U):
    try:
        a = attsvc.get(att_id)
        src = attsvc.path_of(svc.cfg, a)
    except attsvc.AttachmentError as e:
        raise ApiError(e.status, e.code, e.message) from e
    if derived:
        try:
            f = (src.parent / derived).resolve()
        except (ValueError, OSError):  # e.g. a NUL byte: no such file
            raise ApiError(404, "not_found", "no such derived file") from None
        if (src.parent / "derived").resolve() not in f.parents or not f.is_file():
            raise ApiError(404, "not_found", "no such derived file")
        return FileResponse(f, headers={"Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff"})
    return FileResponse(src, media_type=a["mime"] if a["kind"] in ("image", "pdf", "video", "audio", "voice")
                        else "application/octet-stream",
                        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{a['name']}",
                                 "Cache-Control": "private, max-age=300"})


@router.delete("/attachments/{att_id}")
async def attachments_delete(att_id: str, p: auth.Principal = U):
    import shutil

    try:
        a = attsvc.get(att_id)
    except attsvc.AttachmentError as e:
        raise ApiError(e.status, e.code, e.message) from e
    shutil.rmtree(attsvc.base_dir(svc.cfg) / a["id"], ignore_errors=True)
    with db.engine().begin() as c:
        c.execute(models.attachments.delete().where(models.attachments.c.id == att_id))
    audit(p.actor, "attachment.delete", att_id)
    return ok({"deleted": att_id})


@router.get("/attachments-settings")
async def attachments_settings(p: auth.Principal = U):
    return ok(attsvc.settings())


@router.patch("/attachments-settings")
async def attachments_settings_patch(body: dict[str, Any], p: auth.Principal = U):
    owner_only(p)
    s = attsvc.settings()
    if "retention_days" in body:
        s["retention_days"] = max(0, min(int(body["retention_days"]), 3650))
    if "video_max_frames" in body:
        s["video_max_frames"] = max(1, min(int(body["video_max_frames"]), 12))
    if "video_every_s" in body:
        s["video_every_s"] = max(1.0, float(body["video_every_s"])) if body["video_every_s"] else None
    if "video_transcribe" in body:
        s["video_transcribe"] = bool(body["video_transcribe"])
    if "vision_fallback" in body:
        vf = body["vision_fallback"] or None
        if vf and (not vf.get("provider_id") or not vf.get("model_id")):
            raise ApiError(400, "invalid_fallback", "vision_fallback needs provider_id and model_id")
        s["vision_fallback"] = {"provider_id": vf["provider_id"], "model_id": vf["model_id"]} if vf else None
    db.set_setting("attachments", s)
    audit(p.actor, "attachments.settings", None, s)
    return ok(s)


# ============================================================================ remote access / Mini App
@router.get("/remote")
async def remote_status(p: auth.Principal = U):
    return ok(svc.remote.status())


@router.patch("/remote")
async def remote_patch(body: dict[str, Any], p: auth.Principal = U):
    owner_only(p)
    try:
        return ok(await svc.remote.configure(body, p.actor))
    except (ValueError, TypeError) as e:
        raise ApiError(400, "invalid_request", str(e)) from e


class TunnelBody(BaseModel):
    kind: str
    confirm: bool = False


@router.post("/remote/tunnel/start")
async def remote_tunnel_start(body: TunnelBody, p: auth.Principal = U):
    owner_only(p)
    try:
        return ok(await svc.remote.start_tunnel(body.kind, p.actor, body.confirm))
    except ValueError as e:
        raise ApiError(400, "tunnel_failed", str(e)) from e


@router.post("/remote/tunnel/stop")
async def remote_tunnel_stop(p: auth.Principal = U):
    owner_only(p)
    return ok(await svc.remote.stop_tunnel(p.actor))


@router.post("/remote/menu-buttons")
async def remote_menu(p: auth.Principal = U):
    owner_only(p)
    return ok(await svc.remote.apply_menu_buttons(p.actor))


@router.get("/miniapp/sessions")
async def miniapp_sessions(p: auth.Principal = U):
    return ok(miniapp.list_sessions())


@router.delete("/miniapp/sessions")
async def miniapp_revoke_all(p: auth.Principal = U):
    owner_only(p)
    return ok({"revoked": miniapp.revoke(None, p.actor)})


@router.delete("/miniapp/sessions/{session_id}")
async def miniapp_revoke(session_id: str, p: auth.Principal = U):
    return ok({"revoked": miniapp.revoke(session_id, p.actor)})


@router.get("/miniapp/me")
async def miniapp_me(p: auth.Principal = U):
    from nebula_host import authz

    info = miniapp.session_info(p)
    ctx = authz.current() or authz.context_for(p, info if p.via else None)
    return ok({"mode": "telegram" if info else "dashboard", "username": p.username, **(info or {}),
               "permissions": list(info.get("permissions") or []) if info else miniapp.DEFAULT_PERMISSIONS,
               "public_url": remotesvc.public_base(),
               # V3.3: one role model for both interfaces (the dashboard session on this Mac is the owner)
               "role": ctx.role, "admin": ctx.owner,
               "assurance": {"fresh_until": ctx.fresh_until, "fresh": ctx.fresh}})


# ============================================================================ approval center, notifications, monitor
@router.get("/approval-center")
async def approval_center(request: Request, p: auth.Principal = U):
    from nebula_host import approvals_v2
    from nebula_host.api.common import require_owner_remote

    require_owner_remote()  # N9: pending and recent approvals are the owner's (the local dashboard is the owner)
    now = time.time()
    with db.engine().connect() as c:
        task_apps = db.rows(c.execute(
            select(models.approvals, models.agents.c.name.label("agent_name"), models.tasks.c.prompt,
                   models.tasks.c.execution, models.tasks.c.parent_ref)
            .join(models.agents, models.agents.c.id == models.approvals.c.agent_id)
            .join(models.tasks, models.tasks.c.id == models.approvals.c.task_id)
            .where(and_(models.approvals.c.decision.is_(None), models.approvals.c.expires_at > now))
            .order_by(models.approvals.c.created_at.desc())))
        recent = db.rows(c.execute(select(models.approvals.c.id, models.approvals.c.tool, models.approvals.c.decision,
                                          models.approvals.c.resolved_by, models.approvals.c.resolved_at,
                                          models.approvals.c.action_summary, models.approvals.c.agent_id,
                                          models.agents.c.name.label("agent_name"))
                                   .outerjoin(models.agents, models.agents.c.id == models.approvals.c.agent_id)
                                   .where(models.approvals.c.decision.is_not(None))
                                   .order_by(models.approvals.c.resolved_at.desc()).limit(20)))
        owner_recent = db.rows(c.execute(select(models.owner_approvals).where(
            models.owner_approvals.c.decision.is_not(None)).order_by(models.owner_approvals.c.resolved_at.desc())
            .limit(20)))
    for a in task_apps:
        a["kind"] = "task"
        a["environment"] = (a.pop("execution") or {}).get("env", "vm")
        a["prompt"] = (a.get("prompt") or "")[:300]
        a["categories"] = _categories(a.get("reason"))
    for r in recent:
        r["kind"] = "task"
    for r in owner_recent:
        r["action_summary"] = r.get("summary")
    merged = sorted(recent + owner_recent, key=lambda x: x.get("resolved_at") or 0, reverse=True)[:30]
    # sign-in requests are their own objects (one per session) — listed here, not duplicated as approvals
    from nebula_host import authz, smart_auth
    from nebula_host.api.routes_v32 import is_physically_local

    actx = authz.current()
    sign_ins = [{**s, "kind": "sign_in"} for s in smart_auth.pending_for_approval_center(
        local=is_physically_local(request, p), fresh=True if not p.via else bool(actx and actx.fresh),
        owner=True if not p.via else bool(actx and actx.owner))]
    return ok({"pending": task_apps + [{**a, "kind": a["kind"]} for a in approvals_v2.pending()], "recent": merged,
               "sign_ins": sign_ins})


def _categories(reason: str | None) -> list[str]:
    from nebula_runtime.policy import APPROVAL_CATEGORIES, FORBIDDEN_CATEGORIES

    known = APPROVAL_CATEGORIES | FORBIDDEN_CATEGORIES | {"explicit_request"}
    return [c for c in re.split(r"[^a-z_]+", reason or "") if c in known]


NOTIFY_TYPES = ("task.completed", "task.failed", "task.approval.requested", "owner.approval.requested",
                "company.run.finished", "company.run.started", "team.run.completed", "team.run.failed",
                "schedule.run.finished", "workflow.run.finished", "resource.alert", "vm.state.changed",
                "bot.state.changed", "attachment.processed", "vault.access", "auth.request")


@router.get("/notifications")
async def notifications(limit: int = 50, before: int | None = None, p: auth.Principal = U):
    with db.engine().connect() as c:
        q = select(models.events).where(models.events.c.type.in_(NOTIFY_TYPES))
        if before:
            q = q.where(models.events.c.sequence < before)
        rows = db.rows(c.execute(q.order_by(models.events.c.sequence.desc()).limit(min(limit, 200))))
        names = dict(c.execute(select(models.agents.c.id, models.agents.c.name)).all())
    for r in rows:
        r["agent_name"] = names.get(r["agent_id"])
        pl = r.get("payload") or {}
        r["payload"] = {k: pl.get(k) for k in ("reason", "summary", "state", "company", "project", "run_id",
                                               "approval_id", "kind", "message", "level", "status", "tool",
                                               "operation", "outcome", "reason_code", "destination_origin",
                                               "session_id", "site", "request_type", "origin", "step")
                        if k in pl}
        if (pl.get("result") or {}).get("summary"):
            r["payload"]["summary"] = pl["result"]["summary"][:400]
    return ok(rows)


@router.get("/monitor")
async def monitor(p: auth.Principal = U):
    from nebula_host.vm import host_resources

    res = await asyncio.to_thread(host_resources, svc.cfg.data_dir)
    day = time.time() - 86400
    with db.engine().connect() as c:
        by_state = dict(c.execute(select(models.tasks.c.state, func.count()).where(
            models.tasks.c.state.notin_(["COMPLETED", "FAILED", "CANCELLED"])).group_by(models.tasks.c.state)).all())
        failed_tasks = c.execute(select(func.count()).select_from(models.tasks).where(and_(
            models.tasks.c.state == "FAILED", models.tasks.c.finished_at > day))).scalar()
        host_err = c.execute(select(func.count()).select_from(models.host_commands).where(and_(
            models.host_commands.c.status.in_(["error", "timeout", "denied"]), models.host_commands.c.ts > day))).scalar()
        active_agents = c.execute(select(func.count()).select_from(models.agents).where(
            models.agents.c.status == "ACTIVE")).scalar()
    from nebula_host import stt as sttsvc

    return ok({"host": res, "resource_profile": {"profile": svc.resources.profile(), "limits": svc.resources.limits(),
                                                    "host_task_limit": svc.resources.host_limit()}
               if svc.resources else None,
               "active_agents": active_agents, "workers": {"vm": svc.orch.active_count("vm"),
                                                           "host": svc.orch.active_count("host")},
               "task_queue": by_state, "bots": {"main_polling": bool(svc.telegram and svc.telegram.running),
                                                **svc.bots.status()},
               "desktop_streams": len(svc.live.active_streams()), "voice_jobs": dict(sttsvc._jobs),
               "company_workloads": svc.companies.workload(),
               "company_names": {c["id"]: c["name"] for c in cosvc.list_companies()}, "host_exec": svc.host.status(),
               "failed_last_24h": {"tasks": failed_tasks, "host_commands": host_err},
               "remote": {"listening": svc.remote.status()["listening"], "public": bool(remotesvc.public_base())}})


@router.get("/v3/capabilities")
async def capabilities(request: Request, p: auth.Principal = U):
    """What this installation can really do right now (for honest UI states)."""
    s = stt.status(svc.cfg)
    return ok({"stt": s["backend"], "tts_local": bool(await asyncio.to_thread(tts.voices)),
               "host_sandbox": hostexec.sandbox_available(), "host_gui_control": False,
               "mini_app_public": bool(remotesvc.public_base()), "remote_gateway": svc.remote.status()["listening"],
               "vision_fallback": bool((attsvc.settings().get("vision_fallback") or {}).get("model_id"))})


def _unused(q: Query) -> None:  # keep FastAPI Query import for future filters
    _ = q
