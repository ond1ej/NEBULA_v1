"""REST + SSE + WebSocket API (spec §10). All mutations: session cookie + CSRF header + Origin/Host check."""

from __future__ import annotations

import asyncio
import base64
import io
import json
import logging
import os
import platform
import shutil
import subprocess
import tarfile
import threading
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, Query, Request, WebSocket
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse, Response, StreamingResponse
from nebula_providers.base import ProviderError
from nebula_runtime.orchestrator import get_task
from nebula_runtime.tools import LEVEL_PERMISSIONS, TOOLS
from pydantic import BaseModel, Field
from sqlalchemy import and_, func, select

from nebula_host import agents_service, auth, db, models
from nebula_host import providers_service as provs
from nebula_host.api.common import (
    agent_scope,
    idem_lookup,
    idem_store,
    ok,
    require_fresh_owner_remote,
    require_owner_remote,
)
from nebula_host.config import APP_VERSION, save_config
from nebula_host.errors import ApiError
from nebula_host.events import audit, bus
from nebula_host.guest import GuestError, GuestUnavailable
from nebula_host.state import svc
from nebula_host.vm import VMError, host_resources

router = APIRouter(prefix="/api/v1")
U = Depends(auth.require_session)


# =================================================================== auth
class SetupBody(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=256)
    setup_token: str = Field(min_length=1, max_length=128)


class LoginBody(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=256)


@router.get("/auth/state")
async def auth_state(request: Request):
    p = auth._session_from_token(request.cookies.get(auth.COOKIE))
    return ok({"initialized": auth.user_count() > 0, "authenticated": p is not None,
               "user": {"username": p.username} if p else None, "csrf_token": p.csrf_token if p else None})


@router.post("/auth/setup")
async def auth_setup(body: SetupBody, request: Request):
    u = auth.create_admin(body.username, body.password, body.setup_token)
    audit(f"user:{u['username']}", "auth.admin_created", u["id"])
    token, info = auth.login(body.username, body.password, request.client.host if request.client else "?",
                             request.headers.get("user-agent"))
    resp = ok(info, 201)
    _set_cookie(resp, token, request)
    return resp


@router.post("/auth/login")
async def auth_login(body: LoginBody, request: Request):
    token, info = auth.login(body.username, body.password, request.client.host if request.client else "?",
                             request.headers.get("user-agent"))
    audit(f"user:{body.username}", "auth.login", None)
    resp = ok(info)
    _set_cookie(resp, token, request)
    return resp


def _set_cookie(resp: Response, token: str, request: Request) -> None:
    # Secure on HTTPS listeners; host-only cookie, so a LAN login and a 127.0.0.1 login are separate sessions
    resp.set_cookie(auth.COOKIE, token, httponly=True, samesite="strict", path="/",
                    secure=request.url.scheme == "https", max_age=svc.cfg.security.session_ttl_hours * 3600)


@router.post("/auth/logout")
async def auth_logout(p: auth.Principal = U):
    auth.logout(p.session_id)
    resp = ok({"logged_out": True})
    resp.delete_cookie(auth.COOKIE, path="/")
    return resp


class PasswordBody(BaseModel):
    current_password: str
    new_password: str


@router.post("/auth/password")
async def auth_password(body: PasswordBody, p: auth.Principal = U):
    auth.change_password(p.user_id, body.current_password, body.new_password)
    audit(p.actor, "auth.password_changed", p.user_id)
    return ok({"changed": True, "note": "all sessions were signed out"})


# =================================================================== health / system
async def _guest_health() -> dict[str, Any]:
    try:
        t = time.perf_counter()
        p = await svc.guest.ping(timeout=3)
        return {"status": "ok", "latency_ms": round((time.perf_counter() - t) * 1000, 2), **p}
    except (GuestUnavailable, GuestError) as e:
        return {"status": "unavailable", "detail": str(e)}


@router.get("/health")
async def health():
    db_ok = True
    try:
        with db.engine().connect() as c:
            c.execute(select(func.count()).select_from(models.agents)).scalar()
    except Exception:  # noqa: BLE001
        db_ok = False
    # a guest that answers its RPC ping proves the VM is running: only ask the VM helper (a subprocess, ~15 ms)
    # when it does not (perf audit 2026-11-16; /health is polled by every open dashboard and Mini App)
    guest = await _guest_health()
    if guest.get("status") == "ok":
        vm = {"state": "running"}
    else:
        vm = await svc.vm.astatus()
        if vm.get("state") != "running":
            guest = {"status": "vm_not_running"}
    with db.engine().connect() as c:
        prov = {r.id: r.state for r in c.execute(select(models.providers.c.id, models.providers.c.state))}
    if guest.get("status") == "ok" and guest.get("root_fs_writable") is False:
        guest["status"] = "filesystem_read_only"  # guest kernel hit an fs error; see VM console log / Repair
    status = "ok" if db_ok and guest.get("status") == "ok" else "degraded"
    return ok({"status": status, "api": "ok", "db": "ok" if db_ok else "error",
               "vm": {"state": vm.get("state")}, "guest": {"status": guest.get("status"),
                                                            "latency_ms": guest.get("latency_ms")},
               "providers": prov, "telegram": {"polling": svc.telegram.running if svc.telegram else False},
               "version": APP_VERSION})


@router.get("/system")
async def system(p: auth.Principal = U):
    res = await asyncio.to_thread(host_resources, svc.cfg.data_dir)
    vm = await svc.vm.astatus()
    guest = await _guest_health() if vm.get("state") == "running" else {"status": "vm_not_running"}
    from nebula_setup.installer import get_installation

    inst = get_installation()
    data_size = await asyncio.to_thread(_dir_size, svc.cfg.artifacts_dir)
    return ok({"host": {**res, "os": f"macOS {platform.mac_ver()[0]}", "arch": platform.machine(),
                        "app_version": APP_VERSION}, "vm": vm, "guest": guest, "installation": inst,
               "storage": {"artifacts_bytes": data_size, "data_dir": str(svc.cfg.data_dir)},
               "limits": {"active_gui_agents": svc.cfg.agents.default_active_limit,
                          "running_workers": svc.orch.active_count()},
               "live": {"active_streams": svc.live.active_streams()}})


def _dir_size(p: Path) -> int:
    total = 0
    for root, _, files in os.walk(p):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return total


@router.post("/system/vm/start")
async def vm_start(p: auth.Principal = U):
    try:
        st = await asyncio.to_thread(svc.vm.start, 60)
    except VMError as e:
        raise ApiError(409, e.code, str(e)) from e
    db.set_setting("vm.desired_state", "running")
    audit(p.actor, "vm.start", None)
    bus.publish("vm.state.changed", {"state": st.get("state")})
    return ok(st)


@router.post("/system/vm/stop")
async def vm_stop(p: auth.Principal = U):
    for r in list(svc.orch.runners.values()):
        svc.orch.pause(r.task_id, "smart")
    st = await asyncio.to_thread(svc.vm.stop, False)
    db.set_setting("vm.desired_state", "stopped")
    audit(p.actor, "vm.stop", None)
    bus.publish("vm.state.changed", {"state": st.get("state")})
    return ok(st)


@router.post("/system/services/restart")
async def services_restart(p: auth.Principal = U):
    """Restart the host service via launchd (KeepAlive brings it back); DB/agents persist."""
    audit(p.actor, "system.restart", None)

    def later() -> None:
        time.sleep(0.5)
        os._exit(75)  # non-zero => launchd KeepAlive restarts us

    from nebula_setup import launchd

    if not launchd.status().get("loaded"):
        raise ApiError(409, "not_managed", "host service is not running under launchd (dev mode); restart it manually")
    threading.Thread(target=later, daemon=True).start()
    return ok({"restarting": True})


@router.post("/system/repair")
async def system_repair(p: auth.Principal = U):
    from nebula_setup import installer

    job = installer.Job("repair")
    threading.Thread(target=installer.repair, args=(svc.cfg,), kwargs={"job": job}, daemon=True).start()
    audit(p.actor, "system.repair", job.id)
    return ok({"job_id": job.id}, 202, job_id=job.id)


@router.get("/system/logs")
async def system_logs(name: str = "host", lines: int = 200, p: auth.Principal = U):
    allowed = {"host": "host.log", "vm-helper": "vm-helper.log", "guest-provision": "guest-provision.log"}
    if name not in allowed:
        raise ApiError(404, "unknown_log", f"log must be one of {sorted(allowed)}")
    path = svc.cfg.log_dir / allowed[name]
    if not path.exists():
        return ok({"name": name, "lines": []})
    from nebula_host.secrets import redact

    tail = path.read_text(errors="replace").splitlines()[-min(max(lines, 1), 2000):]
    return ok({"name": name, "lines": [redact(x) for x in tail]})


@router.get("/system/diagnostics")
async def diagnostics(p: auth.Principal = U):
    """Redacted diagnostics bundle (no secrets, no DB dump, no workspace data)."""
    from nebula_host.secrets import redact, redact_obj

    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        def add(name: str, content: str) -> None:
            data = content.encode()
            ti = tarfile.TarInfo(name)
            ti.size = len(data)
            ti.mtime = int(time.time())
            tar.addfile(ti, io.BytesIO(data))
        sysinfo = (await system(p)).body.decode()
        add("system.json", json.dumps(redact_obj(json.loads(sysinfo)), indent=2))
        add("health.json", (await health()).body.decode())
        with db.engine().connect() as c:
            add("providers.json", json.dumps([{k: v for k, v in r.items() if k != "keychain_ref"}
                                              for r in db.rows(c.execute(select(models.providers)))], indent=2, default=str))
            add("recent_events.json", json.dumps(db.rows(c.execute(select(models.events)
                                                                   .order_by(models.events.c.sequence.desc()).limit(300))),
                                                 indent=2, default=str))
        for f in ("host.log", "vm-helper.log", "guest-provision.log"):
            fp = svc.cfg.log_dir / f
            if fp.exists():
                add(f"logs/{f}", redact("\n".join(fp.read_text(errors="replace").splitlines()[-3000:])))
        cfg = svc.cfg.yaml_dict()
        add("config.json", json.dumps(cfg, indent=2))
    audit(p.actor, "system.diagnostics_export", None)
    return Response(buf.getvalue(), media_type="application/gzip",
                    headers={"Content-Disposition": f"attachment; filename=nebula-diagnostics-{int(time.time())}.tar.gz"})


@router.post("/system/backup")
async def backup(p: auth.Principal = U):
    """Consistent SQLite backup (online API). Secrets are not in the DB; Keychain items are not exported."""
    import sqlite3

    dest_dir = svc.cfg.data_dir / "backups"
    dest_dir.mkdir(exist_ok=True)
    dest = dest_dir / f"nebula-db-{time.strftime('%Y%m%d-%H%M%S')}.sqlite"
    src = sqlite3.connect(svc.cfg.db_path)
    dst = sqlite3.connect(dest)
    with dst:
        src.backup(dst)
    src.close()
    dst.close()
    dest.chmod(0o600)
    audit(p.actor, "system.backup", str(dest))
    return ok({"path": str(dest), "size_bytes": dest.stat().st_size,
               "note": "contains no secrets (Keychain items are never exported)"})


# =================================================================== setup
@router.post("/setup/preflight")
async def setup_preflight(p: auth.Principal = U):
    from nebula_setup.preflight import run_preflight

    r = await asyncio.to_thread(run_preflight, svc.cfg.data_dir, svc.cfg.instance.port, svc.cfg.helper_binary(),
                                svc.cfg.vm.ram_mb, False, svc.vm.exists() and svc.vm.is_running())
    return ok(r)


@router.post("/setup/install")
async def setup_install(request: Request, p: auth.Principal = U):
    if (cached := idem_lookup(request)) is not None:
        return cached
    from nebula_setup import installer

    with db.engine().connect() as c:
        running = c.execute(select(models.install_jobs.c.id).where(and_(models.install_jobs.c.kind == "install",
                                                                         models.install_jobs.c.state == "RUNNING"))).first()
    if running:
        return ok({"job_id": running.id, "already_running": True}, 202, job_id=running.id)
    job = installer.Job("install")
    threading.Thread(target=installer.install, args=(svc.cfg,), kwargs={"job": job}, daemon=True).start()
    audit(p.actor, "setup.install", job.id)
    return idem_store(request, ok({"job_id": job.id}, 202, job_id=job.id))


@router.get("/setup/jobs/{job_id}")
async def setup_job(job_id: str, p: auth.Principal = U):
    with db.engine().connect() as c:
        r = db.row(c.execute(select(models.install_jobs).where(models.install_jobs.c.id == job_id)).first())
    if r is None:
        raise ApiError(404, "job_not_found", "unknown job")
    return ok(r)


# =================================================================== agents
@router.get("/agents")
async def agents_list(p: auth.Principal = U):
    with db.engine().connect() as c:  # V3: company membership + execution environment for list views
        member = {r.agent_id: (r.company_id, r.name) for r in c.execute(
            select(models.company_members.c.agent_id, models.company_members.c.company_id, models.companies.c.name)
            .join(models.companies, models.companies.c.id == models.company_members.c.company_id))}
    out = []
    scope = agent_scope()  # an agent's own bot lists only its agent
    for a in agents_service.list_all():
        if scope is not None and a["id"] != scope:
            continue
        pub = agents_service.public(a)
        co = member.get(a["id"])
        pub["company_id"], pub["company_name"] = (co[0], co[1]) if co else (None, None)
        pub["execution_env"] = ((a.get("config") or {}).get("execution") or {}).get("env") or "vm"
        out.append(pub)
    return ok(out)


@router.post("/agents")
async def agents_create(request: Request, p: auth.Principal = U):
    if (cached := idem_lookup(request)) is not None:
        return cached
    body = await request.json()
    agent = await agents_service.create(svc.guest, body, p.actor)
    return idem_store(request, ok(agent, 201))


@router.get("/agents/{agent_id}")
async def agents_get(agent_id: str, p: auth.Principal = U):
    a = agents_service.public(agents_service.get(agent_id))
    a["permission_catalog"] = LEVEL_PERMISSIONS
    a["tools"] = [{"name": t.wire, "min_level": t.min_level} for t in TOOLS]
    a["live_streams"] = svc.live.active_streams(agent_id)
    a["control_held_by_user"] = svc.orch.control_held(agent_id)
    return ok(a)


@router.patch("/agents/{agent_id}")
async def agents_patch(agent_id: str, request: Request, p: auth.Principal = U):
    return ok(agents_service.patch(agent_id, await request.json(), p.actor))


@router.delete("/agents/{agent_id}")
async def agents_delete(agent_id: str, request: Request, confirm: bool = False, export: bool = False,
                        p: auth.Principal = U):
    if (cached := idem_lookup(request)) is not None:
        return cached
    r = await agents_service.delete_agent(svc.guest, svc.orch, agent_id, confirm=confirm, export=export, actor=p.actor,
                                          export_dir=svc.cfg.data_dir / "exports")
    return idem_store(request, ok(r))


@router.post("/agents/{agent_id}/sleep")
async def agents_sleep(agent_id: str, p: auth.Principal = U):
    return ok(await agents_service.sleep(svc.guest, agent_id, p.actor))


@router.post("/agents/{agent_id}/wake")
async def agents_wake(agent_id: str, p: auth.Principal = U):
    return ok(await agents_service.wake(svc.guest, agent_id, p.actor))


@router.post("/agents/{agent_id}/pause")
async def agents_pause(agent_id: str, p: auth.Principal = U):
    a = agents_service.set_paused(agent_id, True, p.actor)
    if a.get("current_task"):
        svc.orch.pause(a["current_task"]["id"], "smart")
    return ok(agents_service.public(agents_service.get(agent_id)))


@router.post("/agents/{agent_id}/resume")
async def agents_resume(agent_id: str, p: auth.Principal = U):
    agents_service.set_paused(agent_id, False, p.actor)
    with db.engine().connect() as c:
        paused = c.execute(select(models.tasks.c.id).where(and_(models.tasks.c.agent_id == agent_id,
                                                                models.tasks.c.state == "PAUSED"))).all()
    for r in paused:
        svc.orch.resume(r.id)
    return ok(agents_service.public(agents_service.get(agent_id)))


@router.post("/agents/{agent_id}/export")
async def agents_export(agent_id: str, p: auth.Principal = U):
    out = await agents_service.export_workspace(svc.guest, agent_id, svc.cfg.data_dir / "exports")
    audit(p.actor, "agent.export", agent_id, {"path": str(out)})
    return ok({"path": str(out), "size_bytes": out.stat().st_size})


@router.post("/agents/{agent_id}/restart-desktop")
async def agents_restart_desktop(agent_id: str, p: auth.Principal = U):
    agents_service.get(agent_id)
    r = await svc.guest.call("workspace.restart_desktop", {"agent_id": agent_id}, timeout=120)
    audit(p.actor, "agent.restart_desktop", agent_id)
    return ok(r)


@router.get("/agents/{agent_id}/screenshot")
async def agents_screenshot(agent_id: str, p: auth.Principal = U):
    agents_service.get(agent_id)
    why = agents_service.desktop_unavailable(agent_id)
    if why:
        raise ApiError(409, "desktop_not_running", why)
    try:
        r = await svc.guest.tool(agent_id, "desktop.screenshot", {}, timeout=30)
    except (GuestUnavailable, GuestError) as e:
        raise ApiError(503, "desktop_unavailable", str(e)) from e
    if not r.get("ok"):
        raise ApiError(502, "screenshot_failed", str(r.get("error")))
    res = r["result"]
    return Response(base64.b64decode(res["png_b64"]), media_type="image/png",
                    headers={"Cache-Control": "no-store", "X-Captured-At": str(res["captured_at"]),
                             "X-Desktop-Display": res["display"], "X-Non-Empty": str(res["non_empty"]).lower()})


@router.get("/agents/{agent_id}/messages")
async def agents_messages(agent_id: str, limit: int = 100, p: auth.Principal = U):
    with db.engine().connect() as c:
        rs = db.rows(c.execute(select(models.messages).where(models.messages.c.agent_id == agent_id)
                               .order_by(models.messages.c.created_at.desc()).limit(min(limit, 500))))
    return ok(list(reversed(rs)))


# =================================================================== tasks
class TaskBody(BaseModel):
    prompt: str = Field(min_length=1, max_length=20000)
    max_steps: int | None = Field(default=None, ge=1, le=500)
    max_model_calls: int | None = Field(default=None, ge=1, le=500)  # hard cap on model requests (cost control)
    attachment_ids: list[str] = Field(default_factory=list, max_length=20)  # V3 multimodal


@router.post("/agents/{agent_id}/tasks")
async def tasks_create(agent_id: str, body: TaskBody, request: Request, p: auth.Principal = U):
    if (cached := idem_lookup(request)) is not None:
        return cached
    a = agents_service.get(agent_id)
    if a["status"] in ("CREATING", "DELETING", "ERROR"):
        raise ApiError(409, "agent_not_ready", f"agent is {a['status']}")
    if not a["provider_id"] or not a["model_id"]:
        raise ApiError(409, "no_model", "choose an AI provider and model for this agent first")
    if body.attachment_ids:
        with db.engine().connect() as c:
            n = c.execute(select(models.attachments.c.id).where(and_(
                models.attachments.c.id.in_(body.attachment_ids), models.attachments.c.agent_id == agent_id,
                models.attachments.c.task_id.is_(None)))).all()
        if len(n) != len(set(body.attachment_ids)):
            raise ApiError(400, "invalid_attachments", "attachments must belong to this agent and not be used yet")
    t = svc.orch.enqueue(agent_id, body.prompt, source="web", max_steps=body.max_steps,
                         attachment_ids=body.attachment_ids or None, max_model_calls=body.max_model_calls)
    audit(p.actor, "task.create", t["id"], {"agent_id": agent_id, "attachments": len(body.attachment_ids)})
    return idem_store(request, ok(t, 201))


@router.get("/agents/{agent_id}/tasks")
async def tasks_list(agent_id: str, limit: int = 50, p: auth.Principal = U):
    with db.engine().connect() as c:
        return ok(db.rows(c.execute(select(models.tasks).where(models.tasks.c.agent_id == agent_id)
                                    .order_by(models.tasks.c.created_at.desc()).limit(min(limit, 500)))))


@router.get("/tasks")
async def tasks_all(state: str | None = None, limit: int = 100, p: auth.Principal = U):
    q = select(models.tasks, models.agents.c.name.label("agent_name")).join(
        models.agents, models.agents.c.id == models.tasks.c.agent_id)
    if state:
        q = q.where(models.tasks.c.state == state)
    if (scope := agent_scope()) is not None:  # an agent's own bot sees only its agent's tasks
        q = q.where(models.tasks.c.agent_id == scope)
    with db.engine().connect() as c:
        return ok(db.rows(c.execute(q.order_by(models.tasks.c.created_at.desc()).limit(min(limit, 500)))))


@router.get("/tasks/{task_id}")
async def tasks_get(task_id: str, p: auth.Principal = U):
    try:
        t = get_task(task_id)
    except KeyError as e:
        raise ApiError(404, "task_not_found", "no such task") from e
    with db.engine().connect() as c:
        t["steps"] = db.rows(c.execute(select(models.task_steps).where(models.task_steps.c.task_id == task_id)
                                       .order_by(models.task_steps.c.seq)))
        t["approvals"] = db.rows(c.execute(select(models.approvals).where(models.approvals.c.task_id == task_id)))
    return ok(t)


class StopBody(BaseModel):
    mode: str = Field(default="cancel", pattern="^(cancel|emergency)$")


class PauseBody(BaseModel):
    mode: str = Field(default="smart", pattern="^(smart|immediate)$")


@router.post("/tasks/{task_id}/pause")
async def tasks_pause(task_id: str, body: PauseBody | None = None, p: auth.Principal = U):
    _task_or_404(task_id)
    audit(p.actor, "task.pause", task_id, {"mode": (body or PauseBody()).mode})
    return ok(svc.orch.pause(task_id, (body or PauseBody()).mode))


@router.post("/tasks/{task_id}/resume")
async def tasks_resume(task_id: str, p: auth.Principal = U):
    _task_or_404(task_id)
    audit(p.actor, "task.resume", task_id)
    return ok(svc.orch.resume(task_id))


@router.post("/tasks/{task_id}/stop")
async def tasks_stop(task_id: str, body: StopBody | None = None, p: auth.Principal = U):
    _task_or_404(task_id)
    mode = (body or StopBody()).mode
    audit(p.actor, "task.stop", task_id, {"mode": mode})
    return ok(await svc.orch.stop(task_id, mode))


@router.post("/tasks/{task_id}/retry")
async def tasks_retry(task_id: str, p: auth.Principal = U):
    t = _task_or_404(task_id)
    if t["state"] not in ("FAILED", "CANCELLED"):
        raise ApiError(409, "not_retryable", "only failed or cancelled tasks can be retried")
    new = svc.orch.enqueue(t["agent_id"], t["prompt"], source="web", conversation_id=t.get("conversation_id"))
    with db.engine().begin() as c:
        from sqlalchemy import update

        c.execute(update(models.tasks).where(models.tasks.c.id == new["id"]).values(retry_count=t["retry_count"] + 1))
    return ok(get_task(new["id"]), 201)


def _task_or_404(task_id: str) -> dict[str, Any]:
    try:
        return get_task(task_id)
    except KeyError as e:
        raise ApiError(404, "task_not_found", "no such task") from e


@router.get("/approvals")
async def approvals_list(pending: bool = True, p: auth.Principal = U):
    require_owner_remote()  # N9: approval summaries are the owner's (policy admin; the local dashboard is the owner)
    q = select(models.approvals)
    if pending:
        q = q.where(and_(models.approvals.c.decision.is_(None), models.approvals.c.expires_at > time.time()))
    with db.engine().connect() as c:
        return ok(db.rows(c.execute(q.order_by(models.approvals.c.created_at.desc()).limit(200))))


class ApprovalBody(BaseModel):
    decision: str = Field(pattern="^(approved|denied)$")


# approvals whose release touches the Password Vault, the Mac itself or the system need a FRESH owner when they are
# resolved remotely (the policy table already makes resolving any approval an owner decision)
STEPUP_APPROVAL_CATEGORIES = frozenset({"credential_entry", "account_security", "privileged", "system_change",
                                        "system_install", "host_delete", "sensitive_file", "payment", "data_export"})


def approval_needs_stepup(a: dict[str, Any], execution_env: str | None = None) -> bool:
    import re as _re

    tool = str(a.get("tool") or "")
    cats = set(_re.split(r"[^a-z_]+", str(a.get("reason") or "")))
    return (tool.startswith(("vault", "credential")) or bool(cats & STEPUP_APPROVAL_CATEGORIES)
            or execution_env == "host")


@router.post("/approvals/{approval_id}")
async def approvals_resolve(approval_id: str, body: ApprovalBody, p: auth.Principal = U):
    require_owner_remote()  # VM-01: never an operator or an agent bot's user
    with db.engine().connect() as c:
        a = c.execute(select(models.approvals.c.tool, models.approvals.c.reason, models.approvals.c.decision,
                             models.tasks.c.execution).outerjoin(models.tasks, models.tasks.c.id ==
                                                                 models.approvals.c.task_id)
                      .where(models.approvals.c.id == approval_id)).first()
    if a is None:
        raise ApiError(404, "approval_not_found", "no such approval")
    env = ((a.execution or {}).get("env") if isinstance(a.execution, dict) else None)
    if not a.decision and approval_needs_stepup({"tool": a.tool, "reason": a.reason}, env):
        require_fresh_owner_remote()
    try:
        return ok(svc.orch.resolve_approval(approval_id, body.decision, p.actor))
    except KeyError as e:
        raise ApiError(404, "approval_not_found", "no such approval") from e


@router.get("/artifacts/{path:path}")
async def artifact(path: str, p: auth.Principal = U):
    base = svc.cfg.artifacts_dir.resolve()
    f = (base / path).resolve()
    if base not in f.parents or not f.is_file() or f.suffix != ".png":
        raise ApiError(404, "not_found", "artifact not found")
    return FileResponse(f, media_type="image/png", headers={"Cache-Control": "private, max-age=3600"})


# =================================================================== live desktop
@router.post("/agents/{agent_id}/live/connect")
async def live_connect(agent_id: str, p: auth.Principal = U):
    a = agents_service.get(agent_id)
    if a["status"] in ("SLEEP", "STOPPED", "CREATING", "DELETING", "ERROR"):
        raise ApiError(409, "desktop_not_running", f"agent desktop is {a['status']}; wake it first")
    from nebula_host import environments

    if environments.agent_execution(a)["env"] == "host":  # never show the idle VM desktop as if it were the Mac
        raise ApiError(409, "host_environment", "this agent works natively on the Mac (terminal/files only); there "
                                                "is no live desktop for host execution")
    return ok(svc.live.connect(agent_id, p.session_id), 201)


@router.delete("/live/sessions/{session_id}")
async def live_disconnect(session_id: str, p: auth.Principal = U):
    s = svc.live.get(session_id)
    if s is None or s["viewer_session_id"] != p.session_id:
        raise ApiError(404, "live_session_not_found", "no such live session")
    r = await svc.live.disconnect(session_id, "user")
    audit(p.actor, "live.disconnect", s["agent_id"], {"live_session_id": session_id})
    return ok(r)


class ControlBody(BaseModel):
    action: str = Field(pattern="^(acquire|renew|release)$")


@router.post("/live/sessions/{session_id}/control")
async def live_control(session_id: str, body: ControlBody, p: auth.Principal = U):
    s = svc.live.get(session_id)
    if s is None or s["viewer_session_id"] != p.session_id:
        raise ApiError(404, "live_session_not_found", "no such live session")
    try:
        r = await svc.live.control(session_id, body.action)
    except PermissionError as e:
        raise ApiError(409, "lease_conflict", str(e)) from e
    except LookupError as e:
        raise ApiError(409, "not_viewing", str(e)) from e
    except TimeoutError as e:
        raise ApiError(409, "agent_busy", "agent did not reach a safe GUI boundary in time") from e
    audit(p.actor, f"live.control.{body.action}", s["agent_id"])
    return ok(r)


@router.get("/live/sessions")
async def live_sessions(p: auth.Principal = U):
    with db.engine().connect() as c:
        rows = db.rows(c.execute(select(models.live_sessions).order_by(models.live_sessions.c.created_at.desc()).limit(50)))
    for r in rows:
        r.pop("token_hash", None)
    return ok({"sessions": rows, "active_streams": svc.live.active_streams()})


async def live_ws(ws: WebSocket, session_id: str, token: str = Query(...)):
    principal = auth.principal_for_ws(ws)
    if principal is None:
        await ws.close(code=4401)
        return
    try:
        s = svc.live.authorize_ws(session_id, token, principal.session_id)
        from nebula_host.remote import claim_live_session

        claim_live_session(session_id)  # L-04: atomic single use of the viewer token
    except PermissionError as e:
        await ws.close(code=4403, reason=str(e)[:100])
        return
    subproto = "binary" if "binary" in (ws.headers.get("sec-websocket-protocol") or "") else None
    await ws.accept(subprotocol=subproto)
    await svc.live.stream(ws, s)


# =================================================================== providers
@router.get("/providers")
async def providers_list(p: auth.Principal = U):
    rows = provs.list_rows()
    return ok(rows)


@router.get("/providers/{pid}/models")
async def providers_models(pid: str, refresh: bool = False, p: auth.Principal = U):
    try:
        models_ = await provs.list_models_cached(pid, refresh=refresh)
    except Exception as e:  # noqa: BLE001
        raise ApiError(502, "models_unavailable", str(e)) from e
    return ok([m.as_dict() for m in models_])


@router.post("/providers/{pid}/connect")
async def providers_connect(pid: str, request: Request, p: auth.Principal = U):
    body = await request.json() if request.headers.get("content-length", "0") != "0" else {}
    if pid == "openai-siwc" and not auth.is_loopback_request(request.headers.get("host")):
        raise ApiError(409, "loopback_required", "Sign in with ChatGPT must be started on the Mac mini itself "
                                                 f"(http://127.0.0.1:{svc.cfg.instance.port}/): OpenAI only allows a "
                                                 "127.0.0.1 callback. The connection is then usable from every device.")
    return ok(await provs.connect(pid, body or {}, p.actor))


@router.post("/providers/{pid}/test")
async def providers_test(pid: str, p: auth.Principal = U):
    return ok(await provs.test(pid))


@router.post("/providers/{pid}/disconnect")
async def providers_disconnect(pid: str, p: auth.Principal = U):
    return ok(await provs.disconnect(pid, p.actor))


class CapBody(BaseModel):
    daily_token_cap: int | None = Field(default=None, ge=1000)


@router.post("/providers/{pid}/limits")
async def providers_limits(pid: str, body: CapBody, p: auth.Principal = U):
    provs.set_cap(pid, body.daily_token_cap)
    audit(p.actor, "provider.cap", pid, {"daily_token_cap": body.daily_token_cap})
    return ok({"provider_id": pid, "daily_token_cap": body.daily_token_cap})


async def siwc_callback(request: Request):
    """OAuth loopback redirect target (http://127.0.0.1:<port>/auth/callback). Validated by state + PKCE."""
    params = request.query_params
    if params.get("error"):
        import html

        code = str(params.get("error"))[:100]
        return HTMLResponse(f"<h3>Sign in with ChatGPT failed: {html.escape(code)}</h3>"
                            "<p><a href='/#/providers'>Back to NEBULA</a></p>", status_code=400)
    try:
        info = await provs.siwc_session().complete(params.get("state", ""), params.get("code", ""),
                                                   callback_client_id=params.get("client_id"), iss=params.get("iss"))
    except ProviderError as e:  # an OAuth failure: its message is written for the person signing in
        import html

        return HTMLResponse(f"<h3>Sign in with ChatGPT failed</h3><p>{html.escape(str(e)[:400])}</p>"
                            "<p><a href='/#/providers'>Back to NEBULA</a></p>", status_code=400)
    except Exception:  # noqa: BLE001 - any other failure is internal: logged on the host, never echoed to the page
        logging.getLogger("nebula").exception("Sign in with ChatGPT: completing the sign-in failed")
        return HTMLResponse("<h3>Sign in with ChatGPT failed</h3><p>An internal error occurred; the details are in "
                            "the NEBULA log.</p><p><a href='/#/providers'>Back to NEBULA</a></p>", status_code=500)
    audit("user:oauth", "provider.siwc.connected", "openai-siwc",
          {"client_id": info.get("client_id"), "can_use_plan": info.get("can_use_plan")})
    # Sign-in succeeded and the credential is stored. Reachability of api.openai.com is checked separately so
    # a network problem is reported as such (provider state + diagnosis), not as a failed sign-in.
    try:
        st = await provs.test("openai-siwc")
        ok = st["state"].startswith("Connected")
    except Exception as e:  # noqa: BLE001
        provs.record_failure("openai-siwc", str(e))
        ok = False
    return RedirectResponse("/#/providers?siwc=" + ("connected" if ok else "signed_in_unreachable"), status_code=303)


# =================================================================== telegram
class TokenBody(BaseModel):
    token: str = Field(min_length=20, max_length=128)


@router.get("/telegram")
async def telegram_status(p: auth.Principal = U):
    return ok(svc.telegram.public_status())


@router.post("/telegram/token")
async def telegram_token(body: TokenBody, p: auth.Principal = U):
    from nebula_telegram.botapi import TelegramError

    try:
        return ok(await svc.telegram.set_token(body.token, p.actor))
    except ValueError as e:
        raise ApiError(422, "invalid_token_format", str(e)) from e
    except TelegramError as e:
        raise ApiError(400, "telegram_rejected", f"getMe failed: {e.description}") from e


@router.post("/telegram/test")
async def telegram_test(p: auth.Principal = U):
    from nebula_telegram.botapi import TelegramError

    try:
        return ok(await svc.telegram.test())
    except TelegramError as e:
        raise ApiError(400, "telegram_rejected", f"getMe failed: {e.description}") from e


@router.post("/telegram/pairing")
async def telegram_pairing(p: auth.Principal = U):
    try:
        return ok(svc.telegram.create_pairing(p.actor), 201)
    except ValueError as e:
        raise ApiError(409, "not_configured", str(e)) from e


@router.post("/telegram/pairing/{pid}/approve")
async def telegram_approve(pid: str, request: Request, p: auth.Principal = U):
    """Approve a pairing (or an already approved user row) of the main bot. M-02: an optional JSON body
    {"owner": true} designates this account as the owner's; the owner is never derived from approval order."""
    from nebula_host import authz

    make_owner = False
    raw = await request.body()
    if raw:
        if len(raw) > 1024:
            raise ApiError(413, "too_large", "request body too large")
        try:
            body = json.loads(raw)
        except ValueError as e:
            raise ApiError(422, "invalid_body", "JSON object expected") from e
        if not isinstance(body, dict) or not isinstance(body.get("owner", False), bool):
            raise ApiError(422, "invalid_body", '{"owner": true|false} expected')
        make_owner = body.get("owner") is True
    try:
        return ok(await svc.telegram.approve(pid, p.actor, make_owner=make_owner))
    except LookupError as e:
        raise ApiError(404, "pairing_not_found", str(e)) from e
    except authz.Denied as d:
        raise ApiError(d.status, d.code, d.message) from d


@router.post("/telegram/users/{uid}/revoke")
async def telegram_revoke(uid: str, p: auth.Principal = U):
    svc.telegram.revoke(uid, p.actor)
    return ok(svc.telegram.public_status())


@router.delete("/telegram")
async def telegram_disconnect(p: auth.Principal = U):
    return ok(await svc.telegram.disconnect(p.actor))


# =================================================================== LAN access
class LanBody(BaseModel):
    enabled: bool
    https: bool | None = None


@router.get("/system/lan")
async def lan_status(request: Request, p: auth.Principal = U):
    st = svc.lan.status()
    st["this_request"] = {"host": request.headers.get("host"), "scheme": request.url.scheme,
                          "client": request.client.host if request.client else None,
                          "via_loopback": auth.is_loopback_request(request.headers.get("host"))}
    return ok(st)


@router.post("/system/lan")
async def lan_update(body: LanBody, request: Request, p: auth.Principal = U):
    svc.cfg.lan.enabled = body.enabled
    if body.https is not None:
        svc.cfg.lan.https = body.https
    save_config(svc.cfg)  # persisted in config.yaml -> survives restarts and reboots
    await svc.lan.reconcile()
    audit(p.actor, "system.lan", None, {"enabled": body.enabled, "https": svc.cfg.lan.https,
                                        "from": request.client.host if request.client else None})
    return ok(svc.lan.status())


@router.get("/system/lan/ca.crt")
async def lan_ca(p: auth.Principal = U):
    if not svc.lan.tls:
        raise ApiError(404, "no_ca", "enable HTTPS for LAN access first")
    data = Path(svc.lan.tls["ca_cert"]).read_bytes()
    return Response(data, media_type="application/x-x509-ca-cert",
                    headers={"Content-Disposition": "attachment; filename=NEBULA-Local-CA.crt"})


# =================================================================== settings / audit / events
@router.get("/settings")
async def settings_get(p: auth.Principal = U):
    return ok({"config": svc.cfg.yaml_dict(), "permission_levels": LEVEL_PERMISSIONS})


class SettingsBody(BaseModel):
    require_approval_for_sensitive_actions: bool | None = None
    default_active_limit: int | None = Field(default=None, ge=1, le=8)  # same bound as config.yaml
    screenshot_retention_days: int | None = Field(default=None, ge=0, le=365)
    resource_policy: str | None = Field(default=None, pattern="^(queue_when_full|sleep_lru)$")
    max_steps_per_task: int | None = Field(default=None, ge=1, le=500)


@router.patch("/settings")
async def settings_patch(body: SettingsBody, p: auth.Principal = U):
    changes = body.model_dump(exclude_none=True)
    for k, v in changes.items():
        setattr(svc.cfg.agents, k, v)
    save_config(svc.cfg)
    audit(p.actor, "settings.update", None, changes)
    return ok({"config": svc.cfg.yaml_dict()})


@router.get("/audit")
async def audit_list(limit: int = 200, p: auth.Principal = U):
    with db.engine().connect() as c:
        return ok(db.rows(c.execute(select(models.audit_events).order_by(models.audit_events.c.id.desc())
                                    .limit(min(limit, 1000)))))


@router.get("/events")
async def events(request: Request, since: int | None = None, p: auth.Principal = U):
    q = bus.subscribe()
    last = since
    if last is None and request.headers.get("last-event-id", "").isdigit():
        last = int(request.headers["last-event-id"])  # browser EventSource auto-reconnect
    if last is None:
        with db.engine().connect() as c:
            last = c.execute(select(func.max(models.events.c.sequence))).scalar() or 0
    backlog = bus.since(last)
    scope = agent_scope()  # H-02: an agent's own bot streams only that agent's events (captured before streaming)

    def visible(ev: dict[str, Any]) -> bool:
        return scope is None or (bool(scope) and ev.get("agent_id") == scope)

    async def gen():
        nonlocal last
        try:
            yield "retry: 3000\n\n"
            for ev in backlog:
                last = ev["sequence"]
                if not visible(ev):
                    continue
                yield f"id: {ev['sequence']}\nevent: {ev['type']}\ndata: {json.dumps(ev, default=str)}\n\n"
            # current stages of queued/running tasks (no id / sequence: never moves the client's resume point)
            from nebula_runtime.orchestrator import live_stage_snapshot

            now = time.time()
            for st in live_stage_snapshot():
                pl = dict(st["payload"])
                if isinstance(pl.get("elapsed_ms"), (int, float)) and isinstance(pl.get("at"), (int, float)):
                    pl["elapsed_ms"] = int(pl["elapsed_ms"] + max(0.0, now - pl["at"]) * 1000)  # task time as of now
                ev = {"id": None, "sequence": None, "type": "task.stage", "agent_id": st["agent_id"],
                      "task_id": st["task_id"], "timestamp": now, "payload": pl, "replay": True}
                if not visible(ev):
                    continue
                yield f"event: task.stage\ndata: {json.dumps(ev, default=str)}\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    ev = await asyncio.wait_for(q.get(), timeout=15)
                except TimeoutError:
                    yield ": keepalive\n\n"
                    continue
                if not visible(ev):
                    if ev["sequence"] is not None and ev["sequence"] > last:
                        last = ev["sequence"]
                    continue
                if ev["sequence"] is None:  # V4.0 live-only event (streamed text): no id, never a resume point
                    yield f"event: {ev['type']}\ndata: {json.dumps(ev, default=str)}\n\n"
                    continue
                if ev["sequence"] <= last:
                    continue
                last = ev["sequence"]
                yield f"id: {ev['sequence']}\nevent: {ev['type']}\ndata: {json.dumps(ev, default=str)}\n\n"
        finally:
            bus.unsubscribe(q)

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})


def _unused() -> None:  # keep imports referenced for linters
    _ = (shutil, subprocess)
