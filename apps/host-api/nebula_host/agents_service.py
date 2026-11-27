"""Agent lifecycle (spec §4.1-4.2): DB record + real guest workspace (Linux user, desktop, browser profile)."""

from __future__ import annotations

import asyncio
import base64
import logging
import re
import uuid
from pathlib import Path
from typing import Any

from nebula_contracts.rpc import linux_user_for
from nebula_runtime.tools import LEVEL_PERMISSIONS, LEVELS
from sqlalchemy import delete, select, update

from nebula_host import db, models
from nebula_host.errors import ApiError
from nebula_host.events import audit, bus
from nebula_host.guest import GuestClient, GuestError, GuestUnavailable

log = logging.getLogger("nebula.agents")
NAME_RE = re.compile(r"^[\w .\-()]{1,64}$", re.UNICODE)
GEOMETRIES = {"1280x800", "1280x720", "1440x900", "1920x1080", "1024x768"}
SAFE_PATCH_FIELDS = {"name", "description", "provider_id", "model_id", "permission_level", "resource_mode",
                     "fallback_provider_id", "fallback_model_id", "task_type"}


def public(agent: dict[str, Any]) -> dict[str, Any]:
    a = dict(agent)
    a["state"] = a.pop("status")
    a["guest_user"] = a.get("linux_user")
    a["desktop_id"] = a.get("display_id")  # spec §10.2 name
    with db.engine().connect() as c:
        t = c.execute(select(models.telegram_topics.c.message_thread_id, models.telegram_topics.c.mapping_type)
                      .where(models.telegram_topics.c.agent_id == a["id"])).first()
        cur = c.execute(select(models.tasks.c.id, models.tasks.c.state)
                        .where(models.tasks.c.agent_id == a["id"])
                        .where(models.tasks.c.state.notin_(["COMPLETED", "FAILED", "CANCELLED"]))
                        .order_by(models.tasks.c.created_at.desc())).first()
    a["telegram_topic_id"] = t.message_thread_id if t else None
    a["telegram_mapping"] = t.mapping_type if t else None
    a["current_task"] = {"id": cur.id, "state": cur.state} if cur else None
    return a


def get(agent_id: str) -> dict[str, Any]:
    with db.engine().connect() as c:
        r = db.row(c.execute(select(models.agents).where(models.agents.c.id == agent_id)).first())
    if r is None:
        raise ApiError(404, "agent_not_found", "no such agent")
    return r


def list_all() -> list[dict[str, Any]]:
    with db.engine().connect() as c:
        return db.rows(c.execute(select(models.agents).order_by(models.agents.c.created_at)))


def validate_create(body: dict[str, Any]) -> dict[str, Any]:
    name = str(body.get("name", "")).strip()
    if not NAME_RE.match(name):
        raise ApiError(422, "invalid_name", "name: 1-64 letters, digits, spaces, . - _ ( )")
    level = body.get("permission_level", "STANDARD")
    if level not in LEVELS or level == "HOST_CONTROL":
        raise ApiError(422, "invalid_permission_level", "permission_level: READ_ONLY | STANDARD | ADVANCED "
                                                        "(HOST_CONTROL requires the separate Host Agent, disabled)")
    geom = body.get("desktop_resolution", "1280x800")
    if geom not in GEOMETRIES:
        raise ApiError(422, "invalid_resolution", f"desktop_resolution must be one of {sorted(GEOMETRIES)}")
    mode = body.get("resource_mode", "ACTIVE")
    if mode not in ("ACTIVE", "IDLE", "SLEEP"):
        raise ApiError(422, "invalid_resource_mode", "resource_mode: ACTIVE | IDLE | SLEEP")
    provider_id = body.get("provider_id") or None
    if provider_id:
        with db.engine().connect() as c:
            if c.execute(select(models.providers.c.id).where(models.providers.c.id == provider_id)).first() is None:
                raise ApiError(422, "invalid_provider", "unknown provider_id")
    return {"name": name, "description": str(body.get("description", ""))[:1000], "permission_level": level,
            "desktop_resolution": geom, "resource_mode": mode, "provider_id": provider_id,
            "model_id": (str(body.get("model_id"))[:128] if body.get("model_id") else None),
            "task_type": str(body.get("task_type", "general"))[:64],
            "fallback_provider_id": body.get("fallback_provider_id") or None,
            "fallback_model_id": (str(body.get("fallback_model_id"))[:128] if body.get("fallback_model_id") else None)}


async def create(guest: GuestClient, body: dict[str, Any], actor: str) -> dict[str, Any]:
    """Synchronous from the caller's view: returns only after the guest confirmed a real desktop session."""
    v = validate_create(body)
    agent_id = str(uuid.uuid4())
    user = linux_user_for(agent_id)
    now = db.now()
    with db.engine().begin() as c:
        c.execute(models.agents.insert().values(
            id=agent_id, status="CREATING", linux_user=user, permissions=LEVEL_PERMISSIONS[v["permission_level"]],
            capabilities=[], created_at=now, updated_at=now, **v))
    audit(actor, "agent.create", agent_id, {"name": v["name"], "linux_user": user})
    try:
        ws = await guest.call("workspace.create", {"agent_id": agent_id, "geometry": v["desktop_resolution"]},
                              timeout=180)
    except (GuestUnavailable, GuestError) as e:
        with db.engine().begin() as c:
            c.execute(update(models.agents).where(models.agents.c.id == agent_id)
                      .values(status="ERROR", last_error=f"provisioning failed: {e}", updated_at=db.now()))
        bus.publish("agent.state.changed", {"to": "ERROR", "detail": str(e)}, agent_id=agent_id)
        raise ApiError(502 if isinstance(e, GuestError) else 503, "provisioning_failed",
                       f"guest could not create the workspace: {e}", details={"agent_id": agent_id}) from e
    with db.engine().begin() as c:
        c.execute(update(models.agents).where(models.agents.c.id == agent_id).values(
            status="READY", display_id=ws["display_id"], capabilities=ws["capabilities"],
            desktop_health=ws["desktop_health"], updated_at=db.now()))
        c.execute(models.agent_workspaces.insert().values(id=ws["workspace_id"], agent_id=agent_id,
                                                          guest_path=ws["workspace_path"], quota_mb=8192,
                                                          created_at=db.now()))
    agent = public(get(agent_id))
    bus.publish("agent.created", {"name": agent["name"], "linux_user": user, "display_id": ws["display_id"]},
                agent_id=agent_id)
    if v["resource_mode"] == "SLEEP":
        await sleep(guest, agent_id, actor)
    return agent


def patch(agent_id: str, body: dict[str, Any], actor: str) -> dict[str, Any]:
    a = get(agent_id)
    unknown = set(body) - SAFE_PATCH_FIELDS
    if unknown:
        raise ApiError(422, "unsafe_fields", f"fields not editable: {sorted(unknown)}")
    merged = {**{k: a[k] for k in ("name", "description", "permission_level", "desktop_resolution",
                                   "resource_mode", "provider_id", "model_id", "task_type", "fallback_provider_id",
                                   "fallback_model_id")},
              **body}
    v = validate_create(merged)
    vals = {k: v[k] for k in body}
    if "permission_level" in body:
        vals["permissions"] = LEVEL_PERMISSIONS[v["permission_level"]]
    vals["updated_at"] = db.now()
    with db.engine().begin() as c:
        c.execute(update(models.agents).where(models.agents.c.id == agent_id).values(**vals))
    audit(actor, "agent.patch", agent_id, {k: body[k] for k in body})
    bus.publish("agent.state.changed", {"to": a["status"], "updated": sorted(body)}, agent_id=agent_id)
    return public(get(agent_id))


async def sleep(guest: GuestClient, agent_id: str, actor: str) -> dict[str, Any]:
    a = get(agent_id)
    if a["status"] == "ACTIVE":
        raise ApiError(409, "agent_busy", "pause or stop the running task first")
    await guest.call("workspace.stop", {"agent_id": agent_id}, timeout=60)
    _status(agent_id, "SLEEP")
    audit(actor, "agent.sleep", agent_id)
    return public(get(agent_id))


async def wake(guest: GuestClient, agent_id: str, actor: str) -> dict[str, Any]:
    get(agent_id)
    r = await guest.call("workspace.start", {"agent_id": agent_id}, timeout=120)
    with db.engine().begin() as c:
        c.execute(update(models.agents).where(models.agents.c.id == agent_id)
                  .values(desktop_health=r.get("desktop_health"), updated_at=db.now()))
    _status(agent_id, "READY")
    audit(actor, "agent.wake", agent_id)
    return public(get(agent_id))


def set_paused(agent_id: str, paused: bool, actor: str) -> dict[str, Any]:
    a = get(agent_id)
    _status(agent_id, "PAUSED" if paused else ("READY" if a["status"] == "PAUSED" else a["status"]))
    audit(actor, "agent.pause" if paused else "agent.resume", agent_id)
    return public(get(agent_id))


def _status(agent_id: str, status: str) -> None:
    from nebula_runtime.orchestrator import set_agent_status

    set_agent_status(agent_id, status)


async def export_workspace(guest: GuestClient, agent_id: str, dest_dir: Path) -> Path:
    get(agent_id)
    r = await guest.call("workspace.export", {"agent_id": agent_id}, timeout=600)
    dest_dir.mkdir(parents=True, exist_ok=True)
    out = dest_dir / Path(r["export_path"]).name
    offset = 0
    with open(out, "wb") as f:
        while True:
            ch = await guest.call("workspace.export_chunk", {"path": r["export_path"], "offset": offset,
                                                             "length": 4 << 20}, timeout=60)
            data = base64.b64decode(ch["data_b64"])
            f.write(data)
            offset += len(data)
            if ch["eof"] or not data:
                break
    out.chmod(0o600)
    return out


async def delete_agent(guest: GuestClient, orch, agent_id: str, *, confirm: bool, export: bool, actor: str,
                       export_dir: Path) -> dict[str, Any]:
    if not confirm:
        raise ApiError(409, "confirmation_required", "deleting an agent removes its Linux account and files; "
                                                     "send confirm=true")
    a = get(agent_id)
    result: dict[str, Any] = {"agent_id": agent_id}
    with db.engine().connect() as c:
        running = c.execute(select(models.tasks.c.id).where(models.tasks.c.agent_id == agent_id)
                            .where(models.tasks.c.state.notin_(["COMPLETED", "FAILED", "CANCELLED", "PAUSED"]))).all()
    for r in running:
        await orch.stop(r.id, "cancel")
    for _ in range(50):
        if agent_id not in orch.workers or orch.workers[agent_id].done():
            break
        await asyncio.sleep(0.2)
    prev_status = a["status"]
    try:
        await guest.ping(timeout=5)
    except GuestUnavailable as e:
        raise ApiError(503, "vm_unavailable", "the VM is not reachable; start it (System) and retry the deletion "
                                              "— nothing was deleted") from e
    _status(agent_id, "DELETING")
    try:
        if export:
            result["export_path"] = str(await export_workspace(guest, agent_id, export_dir))
        result["guest"] = await guest.call("workspace.delete", {"agent_id": agent_id, "confirm": True}, timeout=120)
    except GuestUnavailable as e:
        _status(agent_id, prev_status)
        raise ApiError(503, "vm_unavailable", f"guest became unreachable during deletion: {e}; retry") from e
    except GuestError as e:
        if e.code != "not_found":
            _status(agent_id, "ERROR")
            raise ApiError(502, "guest_delete_failed", str(e)) from e
    topics = []
    with db.engine().begin() as c:
        topics = db.rows(c.execute(select(models.telegram_topics).where(models.telegram_topics.c.agent_id == agent_id)))
        c.execute(delete(models.agents).where(models.agents.c.id == agent_id))
    result["telegram_topics"] = topics
    audit(actor, "agent.delete", agent_id, {"name": a["name"], "exported": export})
    bus.publish("agent.deleted", {"name": a["name"], "telegram_topics": topics}, agent_id=agent_id)
    return result


async def reconcile(guest: GuestClient) -> dict[str, Any]:
    """Startup: compare DB agents with guest registry; mark missing workspaces ERROR (never auto-delete)."""
    try:
        ws = {w["agent_id"]: w for w in await guest.call("workspace.list", timeout=30)}
    except (GuestUnavailable, GuestError) as e:
        return {"skipped": str(e)}
    out = {"missing": [], "ok": 0}
    for a in list_all():
        if a["status"] in ("CREATING",):
            _status(a["id"], "ERROR")
            continue
        w = ws.get(a["id"])
        if not w:
            out["missing"].append(a["id"])
            with db.engine().begin() as c:
                c.execute(update(models.agents).where(models.agents.c.id == a["id"])
                          .values(status="ERROR", last_error="workspace missing in guest (use Repair)"))
        else:
            out["ok"] += 1
            if w.get("state") == "STOPPED" and a["status"] not in ("SLEEP", "STOPPED"):
                _status(a["id"], "SLEEP")
    return out


DESKTOP_DOWN = ("SLEEP", "STOPPED", "CREATING", "DELETING", "ERROR")


def desktop_unavailable(agent_id: str) -> str | None:
    """Why this agent's desktop cannot be captured right now (None = it can). Asking a sleeping desktop for a
    screenshot used to block ~15 s inside the guest before failing with "[Errno 2] No such file or directory"
    (perf audit 2026-11-16); callers now answer at once."""
    from sqlalchemy import select

    with db.engine().connect() as c:
        st = c.execute(select(models.agents.c.status).where(models.agents.c.id == agent_id)).scalar()
    if st is None:
        return "agent not found"
    if st in DESKTOP_DOWN:
        return f"the agent's desktop is {st}" + (" — wake the agent first" if st in ("SLEEP", "STOPPED") else "")
    return None

