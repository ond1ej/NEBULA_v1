"""NEBULA V2 REST API: memory, teams, schedules, workflows, owner approvals, files, skills, resources, voice, overview.

Same guarantees as V1 (routes.py): session cookie + CSRF header on every mutation, Host/Origin checks in the
middleware, audit log entries, destructive operations need confirm=true.
"""

from __future__ import annotations

import time
from typing import Any

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import and_, func, select, update

from nebula_host import approvals_v2, auth, db, memory, models, skills, stt
from nebula_host import schedules as schedsvc
from nebula_host import teams as teamsvc
from nebula_host import workflows as wfsvc
from nebula_host.api.common import ok, require_fresh_owner_remote, require_owner_remote
from nebula_host.errors import ApiError
from nebula_host.events import audit, bus
from nebula_host.files_service import FileError
from nebula_host.hosttools import GITHUB_TOKEN_REF
from nebula_host.state import svc

router = APIRouter(prefix="/api/v1")
U = Depends(auth.require_session)


def _agent(agent_id: str) -> dict[str, Any]:
    with db.engine().connect() as c:
        a = db.row(c.execute(select(models.agents).where(models.agents.c.id == agent_id)).first())
    if not a:
        raise ApiError(404, "agent_not_found", "agent not found")
    return a


def _bad(e: Exception, code: str = "invalid_request") -> ApiError:
    return ApiError(400, code, str(e))


# ============================================================================ Module 1: memory
class MemoryBody(BaseModel):
    key: str = Field(min_length=1, max_length=200)
    value: str = Field(min_length=1, max_length=memory.MAX_VALUE)
    kind: str = "fact"
    tags: str = ""
    importance: int = Field(default=3, ge=1, le=5)
    pinned: bool = False
    project: str | None = None
    scope: str = "private"
    shared_with: list[str] = []


class MemoryPatch(BaseModel):
    key: str | None = None
    value: str | None = None
    kind: str | None = None
    tags: str | None = None
    importance: int | None = Field(default=None, ge=1, le=5)
    pinned: bool | None = None
    project: str | None = None
    scope: str | None = None
    shared_with: list[str] | None = None


@router.get("/agents/{agent_id}/memory")
async def memory_list(agent_id: str, q: str | None = None, kind: str | None = None, shared: bool = False,
                      limit: int = 200, p: auth.Principal = U):
    _agent(agent_id)
    return ok(memory.list_entries(agent_id, kind=kind, q=q, limit=limit, include_shared=shared))


@router.get("/agents/{agent_id}/memory/stats")
async def memory_stats(agent_id: str, p: auth.Principal = U):
    _agent(agent_id)
    return ok(memory.stats(agent_id))


@router.post("/agents/{agent_id}/memory")
async def memory_create(agent_id: str, body: MemoryBody, p: auth.Principal = U):
    _agent(agent_id)
    try:
        r = memory.store(agent_id, body.key, body.value, kind=body.kind, tags=body.tags, source=f"owner:{p.username}",
                         trust="owner", importance=body.importance, project=body.project, scope=body.scope,
                         shared_with=body.shared_with, pinned=body.pinned)
    except memory.MemoryError_ as e:
        raise _bad(e, "memory_rejected") from e
    audit(p.actor, "memory.create", r["id"], {"agent_id": agent_id, "kind": body.kind})
    bus.publish("memory.changed", {"op": "create", "memory_id": r["id"]}, agent_id=agent_id)
    return ok(memory.get(agent_id, r["id"]), 201)


@router.patch("/agents/{agent_id}/memory/{memory_id}")
async def memory_patch(agent_id: str, memory_id: str, body: MemoryPatch, p: auth.Principal = U):
    try:
        r = memory.update_entry(agent_id, memory_id, **body.model_dump(exclude_none=True))
    except KeyError as e:
        raise ApiError(404, "memory_not_found", "memory entry not found") from e
    except memory.MemoryError_ as e:
        raise _bad(e, "memory_rejected") from e
    audit(p.actor, "memory.update", memory_id, {"agent_id": agent_id})
    bus.publish("memory.changed", {"op": "update", "memory_id": memory_id}, agent_id=agent_id)
    return ok(r)


@router.delete("/agents/{agent_id}/memory/{memory_id}")
async def memory_delete(agent_id: str, memory_id: str, p: auth.Principal = U):
    n = memory.delete_entries(agent_id, [memory_id])
    audit(p.actor, "memory.delete", memory_id, {"agent_id": agent_id})
    bus.publish("memory.changed", {"op": "delete", "memory_id": memory_id}, agent_id=agent_id)
    return ok({"deleted": n})


@router.delete("/agents/{agent_id}/memory")
async def memory_clear(agent_id: str, kind: str | None = None, confirm: bool = False, p: auth.Principal = U):
    _agent(agent_id)
    if not confirm:
        raise ApiError(400, "confirmation_required", "pass confirm=true to delete memory entries")
    n = memory.delete_entries(agent_id, None, kind)
    audit(p.actor, "memory.clear", agent_id, {"kind": kind, "deleted": n})
    bus.publish("memory.changed", {"op": "clear", "kind": kind}, agent_id=agent_id)
    return ok({"deleted": n})


class AgentConfigBody(BaseModel):
    memory_auto_save: bool | None = None
    idle_sleep_minutes: int | None = Field(default=None, ge=0, le=1440)


@router.patch("/agents/{agent_id}/config")
async def agent_config(agent_id: str, body: AgentConfigBody, p: auth.Principal = U):
    a = _agent(agent_id)
    cfg = {**(a.get("config") or {}), **body.model_dump(exclude_none=True)}
    with db.engine().begin() as c:
        c.execute(update(models.agents).where(models.agents.c.id == agent_id).values(config=cfg, updated_at=db.now()))
    audit(p.actor, "agent.config", agent_id, body.model_dump(exclude_none=True))
    return ok({"config": cfg})


class SemanticBody(BaseModel):
    enabled: bool
    model: str = Field(default="nomic-embed-text", max_length=128)


@router.get("/memory/semantic")
async def semantic_get(p: auth.Principal = U):
    s = db.get_setting("memory.semantic", {}) or {}
    avail = memory.OllamaEmbedder.available(svc.cfg.providers.ollama_base_url, s.get("model") or "nomic-embed-text")
    return ok({**memory.semantic_status(), "configured": s, "model_installed": avail})


@router.post("/memory/semantic")
async def semantic_set(body: SemanticBody, p: auth.Principal = U):
    if body.enabled and not memory.OllamaEmbedder.available(svc.cfg.providers.ollama_base_url, body.model):
        raise ApiError(409, "model_missing", f"embedding model {body.model} is not installed in Ollama "
                                             f"(ollama pull {body.model}); FTS search stays active")
    db.set_setting("memory.semantic", {"enabled": body.enabled, "model": body.model})
    memory.configure_semantic(memory.OllamaEmbedder(svc.cfg.providers.ollama_base_url, body.model) if body.enabled else None)
    audit(p.actor, "memory.semantic", None, body.model_dump())
    return ok(memory.semantic_status())


# ============================================================================ Module 2: teams
@router.get("/teams")
async def teams_list(p: auth.Principal = U):
    return ok(teamsvc.list_teams())


@router.post("/teams")
async def teams_create(request: Request, p: auth.Principal = U):
    try:
        return ok(await svc.teams.create(await request.json(), p.actor), 201)
    except teamsvc.TeamError as e:
        raise _bad(e, "team_invalid") from e


@router.get("/teams/{team_id}")
async def teams_get(team_id: str, p: auth.Principal = U):
    try:
        return ok(teamsvc.get_team(team_id))
    except KeyError as e:
        raise ApiError(404, "team_not_found", "team not found") from e


@router.patch("/teams/{team_id}")
async def teams_patch(team_id: str, request: Request, p: auth.Principal = U):
    try:
        return ok(await svc.teams.update(team_id, await request.json(), p.actor))
    except KeyError as e:
        raise ApiError(404, "team_not_found", "team not found") from e
    except teamsvc.TeamError as e:
        raise _bad(e, "team_invalid") from e


@router.delete("/teams/{team_id}")
async def teams_delete(team_id: str, confirm: bool = False, delete_files: bool = False, p: auth.Principal = U):
    if not confirm:
        raise ApiError(400, "confirmation_required", "pass confirm=true to delete the team")
    try:
        return ok(await svc.teams.delete(team_id, p.actor, delete_files))
    except KeyError as e:
        raise ApiError(404, "team_not_found", "team not found") from e
    except teamsvc.TeamError as e:
        raise ApiError(409, "team_busy", str(e)) from e


class TeamRunBody(BaseModel):
    prompt: str = Field(min_length=1, max_length=20000)
    max_model_calls: int | None = Field(default=None, ge=1, le=100)


@router.post("/teams/{team_id}/runs")
async def team_run_start(team_id: str, body: TeamRunBody, p: auth.Principal = U):
    try:
        return ok(await svc.teams.start_run(team_id, body.prompt, source="web", max_model_calls=body.max_model_calls,
                                            actor=p.actor), 201)
    except KeyError as e:
        raise ApiError(404, "team_not_found", "team not found") from e
    except teamsvc.TeamError as e:
        raise ApiError(409, "team_run_refused", str(e)) from e


@router.get("/team-runs")
async def team_runs(team_id: str | None = None, limit: int = 50, p: auth.Principal = U):
    return ok(svc.teams.list_runs(team_id, limit))


@router.get("/team-runs/{run_id}")
async def team_run_get(run_id: str, p: auth.Principal = U):
    try:
        return ok(svc.teams.get_run(run_id))
    except KeyError as e:
        raise ApiError(404, "run_not_found", "team run not found") from e


@router.post("/team-runs/{run_id}/cancel")
async def team_run_cancel(run_id: str, p: auth.Principal = U):
    try:
        return ok(await svc.teams.cancel_run(run_id, p.actor))
    except KeyError as e:
        raise ApiError(404, "run_not_found", "team run not found") from e


# ============================================================================ Module 3: schedules
@router.get("/schedules")
async def schedules_list(p: auth.Principal = U):
    return ok(schedsvc.list_all())


@router.post("/schedules")
async def schedules_create(request: Request, p: auth.Principal = U):
    try:
        return ok(svc.schedules.create(await request.json(), p.actor), 201)
    except schedsvc.ScheduleError as e:
        raise _bad(e, "schedule_invalid") from e


class PreviewBody(BaseModel):
    kind: str
    spec: dict[str, Any] = {}
    timezone: str = "UTC"
    count: int = Field(default=5, ge=1, le=20)
    created_at: float | None = None  # interval schedules are anchored at creation (or spec.start_at)


@router.post("/schedules/preview")
async def schedules_preview(body: PreviewBody, p: auth.Principal = U):
    from nebula_host import cron

    try:
        spec = dict(body.spec)
        if body.kind == "interval" and body.created_at and not spec.get("start_at"):
            spec["start_at"] = body.created_at
        return ok({"next": cron.preview(body.kind, spec, body.timezone, time.time(), body.count)})
    except cron.CronError as e:
        raise _bad(e, "schedule_invalid") from e


@router.get("/schedules/{schedule_id}")
async def schedules_get(schedule_id: str, p: auth.Principal = U):
    try:
        return ok({**schedsvc.get(schedule_id), "runs": schedsvc.runs(schedule_id, 50)})
    except KeyError as e:
        raise ApiError(404, "schedule_not_found", "schedule not found") from e


@router.patch("/schedules/{schedule_id}")
async def schedules_patch(schedule_id: str, request: Request, p: auth.Principal = U):
    try:
        return ok(svc.schedules.update(schedule_id, await request.json(), p.actor))
    except KeyError as e:
        raise ApiError(404, "schedule_not_found", "schedule not found") from e
    except schedsvc.ScheduleError as e:
        raise _bad(e, "schedule_invalid") from e


@router.delete("/schedules/{schedule_id}")
async def schedules_delete(schedule_id: str, confirm: bool = False, p: auth.Principal = U):
    if not confirm:
        raise ApiError(400, "confirmation_required", "pass confirm=true")
    try:
        return ok(svc.schedules.delete(schedule_id, p.actor))
    except KeyError as e:
        raise ApiError(404, "schedule_not_found", "schedule not found") from e


@router.post("/schedules/{schedule_id}/run")
async def schedules_run_now(schedule_id: str, p: auth.Principal = U):
    try:
        return ok(await svc.schedules.run_now(schedule_id, p.actor), 201)
    except KeyError as e:
        raise ApiError(404, "schedule_not_found", "schedule not found") from e
    except schedsvc.ScheduleError as e:
        raise ApiError(409, "schedule_busy", str(e)) from e


@router.get("/schedule-runs")
async def schedule_runs(schedule_id: str | None = None, limit: int = 100, p: auth.Principal = U):
    return ok(schedsvc.runs(schedule_id, limit))


# ============================================================================ Module 6: workflows
@router.get("/workflows/catalog")
async def workflows_catalog(p: auth.Principal = U):
    return ok({"blocks": wfsvc.CATALOG, "schema_version": 1, "limits": {"max_nodes": wfsvc.MAX_NODES,
                                                                        "max_loop": wfsvc.MAX_LOOP,
                                                                        "max_depth": wfsvc.MAX_DEPTH}})


@router.get("/workflows")
async def workflows_list(p: auth.Principal = U):
    return ok(wfsvc.list_all())


@router.post("/workflows")
async def workflows_create(request: Request, p: auth.Principal = U):
    try:
        return ok(svc.workflows.create(await request.json(), p.actor), 201)
    except (wfsvc.WorkflowError, schedsvc.ScheduleError) as e:
        raise _bad(e, "workflow_invalid") from e


class ValidateBody(BaseModel):
    definition: dict[str, Any]


@router.post("/workflows/validate")
async def workflows_validate(body: ValidateBody, p: auth.Principal = U):
    try:
        wfsvc.validate(body.definition)
        return ok({"valid": True})
    except wfsvc.WorkflowError as e:
        return ok({"valid": False, "error": str(e)})


@router.post("/workflows/import")
async def workflows_import(request: Request, p: auth.Principal = U):
    try:
        return ok(svc.workflows.import_(await request.json(), p.actor), 201)
    except (wfsvc.WorkflowError, schedsvc.ScheduleError) as e:
        raise _bad(e, "workflow_invalid") from e


@router.get("/workflows/{workflow_id}")
async def workflows_get(workflow_id: str, p: auth.Principal = U):
    try:
        return ok(wfsvc.get(workflow_id))
    except KeyError as e:
        raise ApiError(404, "workflow_not_found", "workflow not found") from e


@router.patch("/workflows/{workflow_id}")
async def workflows_patch(workflow_id: str, request: Request, p: auth.Principal = U):
    try:
        return ok(svc.workflows.update(workflow_id, await request.json(), p.actor))
    except KeyError as e:
        raise ApiError(404, "workflow_not_found", "workflow not found") from e
    except (wfsvc.WorkflowError, schedsvc.ScheduleError) as e:
        raise _bad(e, "workflow_invalid") from e


@router.delete("/workflows/{workflow_id}")
async def workflows_delete(workflow_id: str, confirm: bool = False, p: auth.Principal = U):
    if not confirm:
        raise ApiError(400, "confirmation_required", "pass confirm=true")
    try:
        return ok(svc.workflows.delete(workflow_id, p.actor))
    except KeyError as e:
        raise ApiError(404, "workflow_not_found", "workflow not found") from e


@router.post("/workflows/{workflow_id}/duplicate")
async def workflows_duplicate(workflow_id: str, p: auth.Principal = U):
    try:
        return ok(svc.workflows.duplicate(workflow_id, p.actor), 201)
    except KeyError as e:
        raise ApiError(404, "workflow_not_found", "workflow not found") from e


@router.get("/workflows/{workflow_id}/export")
async def workflows_export(workflow_id: str, p: auth.Principal = U):
    try:
        return ok(svc.workflows.export(workflow_id))
    except KeyError as e:
        raise ApiError(404, "workflow_not_found", "workflow not found") from e


class WfRunBody(BaseModel):
    payload: dict[str, Any] = {}


@router.post("/workflows/{workflow_id}/run")
async def workflows_run(workflow_id: str, body: WfRunBody | None = None, p: auth.Principal = U):
    try:
        return ok(await svc.workflows.start(workflow_id, trigger="manual", payload=(body.payload if body else {}),
                                            actor=p.actor), 201)
    except KeyError as e:
        raise ApiError(404, "workflow_not_found", "workflow not found") from e
    except wfsvc.WorkflowError as e:
        raise ApiError(409, "workflow_refused", str(e)) from e


@router.get("/workflow-runs")
async def workflow_runs(workflow_id: str | None = None, limit: int = 50, p: auth.Principal = U):
    return ok(wfsvc.list_runs(workflow_id, limit))


@router.get("/workflow-runs/{run_id}")
async def workflow_run_get(run_id: str, p: auth.Principal = U):
    try:
        return ok(wfsvc.get_run(run_id))
    except KeyError as e:
        raise ApiError(404, "run_not_found", "workflow run not found") from e


@router.post("/workflow-runs/{run_id}/stop")
async def workflow_run_stop(run_id: str, p: auth.Principal = U):
    try:
        return ok(await svc.workflows.stop_run(run_id, p.actor))
    except KeyError as e:
        raise ApiError(404, "run_not_found", "workflow run not found") from e


# ============================================================================ owner approvals
class DecisionBody(BaseModel):
    decision: str = Field(pattern="^(approved|denied)$")


@router.get("/owner-approvals")
async def owner_approvals(p: auth.Principal = U):
    require_owner_remote()  # N9: pending owner approvals are listed to the owner only
    return ok(approvals_v2.pending())


@router.post("/owner-approvals/{approval_id}")
async def owner_approval_resolve(approval_id: str, body: DecisionBody, p: auth.Principal = U):
    require_owner_remote()  # VM-01: owner approvals are the owner's decision only
    try:
        a = approvals_v2.get(approval_id)
    except KeyError as e:
        raise ApiError(404, "approval_not_found", "approval not found") from e
    if not a.get("decision") and approvals_v2.needs_stepup(a):
        require_fresh_owner_remote()  # system-level approvals (commands, packages, plugins) need a fresh owner
    try:
        return ok(await approvals_v2.resolve(approval_id, body.decision, p.actor))
    except KeyError as e:
        raise ApiError(404, "approval_not_found", "approval not found") from e


# ============================================================================ Module 8: files
def _ferr(e: FileError) -> ApiError:
    return ApiError(e.status, e.code, str(e))


@router.get("/files/roots")
async def files_roots(p: auth.Principal = U):
    from nebula_host.files_service import list_roots, mac_root, owner_caller

    roots = list_roots(svc.cfg)
    if not owner_caller():  # H-01: the Mac's own folders are listed (and reachable) for the owner only
        roots = [r for r in roots if not mac_root(r["id"])]
    return ok(roots)


async def _fop(root: str, op: str, actor: str | None = None, **kw):
    try:
        return await svc.files.op(root, op, actor, **kw)
    except FileError as e:
        raise _ferr(e) from e


@router.get("/files/list")
async def files_list(root: str, path: str = ".", p: auth.Principal = U):
    return ok(await _fop(root, "list", path=path))


@router.get("/files/stat")
async def files_stat(root: str, path: str, p: auth.Principal = U):
    return ok(await _fop(root, "stat", path=path))


@router.get("/files/search")
async def files_search(root: str, q: str = Query(min_length=1, max_length=200), path: str = ".",
                       p: auth.Principal = U):
    return ok(await _fop(root, "search", path=path, query=q))


@router.get("/files/usage")
async def files_usage(root: str, path: str = ".", p: auth.Principal = U):
    return ok(await _fop(root, "usage", path=path))


@router.get("/files/versions")
async def files_versions(root: str, path: str, p: auth.Principal = U):
    return ok(await _fop(root, "versions", path=path))


@router.get("/files/preview")
async def files_preview(root: str, path: str, p: auth.Principal = U):
    try:
        return ok(await svc.files.preview(root, path))
    except FileError as e:
        raise _ferr(e) from e


@router.get("/files/history")
async def files_history(root: str | None = None, limit: int = 200, p: auth.Principal = U):
    return ok(svc.files.history(root, limit))


@router.get("/files/download")
async def files_download(root: str, path: str, p: auth.Principal = U):
    st = await _fop(root, "stat", path=path)
    if st["type"] != "file":
        raise ApiError(400, "not_a_file", "only files can be downloaded")
    from urllib.parse import quote

    name = path.rsplit("/", 1)[-1]
    ascii_name = name.encode("ascii", "replace").decode().replace("?", "_").replace('"', "_")
    audit(p.actor, "files.download", f"{root}:{path}")

    async def body():
        # an error mid-stream must abort the response (the client sees an incomplete transfer, never a short file)
        async for ch in svc.files.read_all(root, path):
            yield ch

    return StreamingResponse(body(), media_type="application/octet-stream",
                             headers={"Content-Disposition": f"attachment; filename=\"{ascii_name}\"; "
                                                             f"filename*=UTF-8''{quote(name)}",
                                      "Content-Length": str(st["size"]), "Cache-Control": "no-store"})


@router.post("/files/upload")
async def files_upload(request: Request, root: str, path: str, overwrite: bool = False, p: auth.Principal = U):
    if not overwrite:
        try:
            await svc.files.op(root, "stat", path=path)
            raise ApiError(409, "exists", f"{path} already exists (overwrite=true replaces it)")
        except FileError as e:
            if e.status != 404:
                raise _ferr(e) from e
    try:
        r = await svc.files.write_stream(root, path, request.stream(), p.actor, keep_version=overwrite)
    except FileError as e:
        raise _ferr(e) from e
    return ok(r, 201)


class TextBody(BaseModel):
    root: str
    path: str
    content: str = Field(max_length=4 * 1024 * 1024)


@router.put("/files/text")
async def files_text(body: TextBody, p: auth.Principal = U):
    async def gen():
        yield body.content.encode()

    try:
        return ok(await svc.files.write_stream(body.root, body.path, gen(), p.actor, keep_version=True))
    except FileError as e:
        raise _ferr(e) from e


class PathBody(BaseModel):
    root: str
    path: str
    dest: str | None = None
    overwrite: bool = False


@router.post("/files/mkdir")
async def files_mkdir(body: PathBody, p: auth.Principal = U):
    return ok(await _fop(body.root, "mkdir", p.actor, path=body.path), 201)


@router.post("/files/move")
async def files_move(body: PathBody, p: auth.Principal = U):
    return ok(await _fop(body.root, "move", p.actor, path=body.path, dest=body.dest, overwrite=body.overwrite))


@router.post("/files/rename")
async def files_rename(body: PathBody, p: auth.Principal = U):
    return ok(await _fop(body.root, "rename", p.actor, path=body.path, dest=body.dest, overwrite=body.overwrite))


@router.post("/files/copy")
async def files_copy(body: PathBody, p: auth.Principal = U):
    return ok(await _fop(body.root, "copy", p.actor, path=body.path, dest=body.dest, overwrite=body.overwrite))


@router.delete("/files")
async def files_delete(root: str, path: str, recursive: bool = False, confirm: bool = False, p: auth.Principal = U):
    if not confirm:
        raise ApiError(400, "confirmation_required", "deleting needs confirm=true (the dashboard asks first)")
    return ok(await _fop(root, "delete", p.actor, path=path, recursive=recursive))


class TransferBody(BaseModel):
    src_root: str
    src_path: str
    dst_root: str
    dst_path: str
    overwrite: bool = False


@router.post("/files/transfer")
async def files_transfer(body: TransferBody, p: auth.Principal = U):
    if not body.overwrite:
        try:
            await svc.files.op(body.dst_root, "stat", path=body.dst_path)
            raise ApiError(409, "exists", f"{body.dst_path} already exists there (overwrite=true replaces it)")
        except FileError as e:
            if e.status != 404:
                raise _ferr(e) from e
    try:
        r = await svc.files.transfer(body.src_root, body.src_path, body.dst_root, body.dst_path, p.actor)
    except FileError as e:
        raise _ferr(e) from e
    audit(p.actor, "files.transfer", r["from"], {"to": r["to"], "size": r["size"]})
    return ok(r, 201)


# ============================================================================ Module 9: skills & plugins
@router.get("/skills")
async def skills_list(p: auth.Principal = U):
    return ok(skills.list_skills())


@router.get("/skills/usage")
async def skills_usage(skill_id: str | None = None, limit: int = 200, p: auth.Principal = U):
    return ok(skills.usage(skill_id, limit))


@router.get("/skills/compatibility")
async def skills_compat(p: auth.Principal = U):
    try:
        caps = await svc.guest.call("guest.capabilities", {}, timeout=30)
    except Exception as e:  # noqa: BLE001
        raise ApiError(503, "vm_unavailable", str(e)) from e
    return ok({"capabilities": caps, "skills": skills.compatibility(caps)})


@router.get("/permissions/matrix")
async def permission_matrix(p: auth.Principal = U):
    from nebula_runtime.tools import LEVEL_PERMISSIONS, permission_matrix

    return ok({"levels": ["READ_ONLY", "STANDARD", "ADVANCED"], "tools": permission_matrix(),
               "level_permissions": LEVEL_PERMISSIONS,
               "rules": ["ADVANCED never bypasses approvals: risky categories always ask the owner while "
                         "'require approval for sensitive actions' is on; package installs always ask.",
                         "Other agents' homes and NEBULA secrets are forbidden at every level.",
                         "A denied category stays denied for the rest of the task, through any tool."]})


@router.get("/skills/{skill_id}")
async def skills_get(skill_id: str, p: auth.Principal = U):
    try:
        return ok({**skills.get_skill(skill_id), "usage": skills.usage(skill_id, 50)})
    except KeyError as e:
        raise ApiError(404, "skill_not_found", "skill not found") from e


class EnableBody(BaseModel):
    enabled: bool


@router.post("/skills/{skill_id}/enabled")
async def skills_enable(skill_id: str, body: EnableBody, p: auth.Principal = U):
    try:
        r = skills.set_enabled(skill_id, body.enabled, p.actor)
    except KeyError as e:
        raise ApiError(404, "skill_not_found", "skill not found") from e
    bus.publish("skill.changed", {"skill_id": skill_id, "enabled": body.enabled})
    return ok(r)


@router.post("/skills/plugins")
async def plugin_install(request: Request, allow_downgrade: bool = False, p: auth.Principal = U):
    data = b""
    async for ch in request.stream():
        data += ch
        if len(data) > skills.MAX_ZIP:
            raise ApiError(413, "too_large", "plugin archive exceeds 5 MiB")
    try:
        r = await skills.install_plugin(svc.guest, data, p.actor, allow_downgrade)
    except skills.SkillError as e:
        raise _bad(e, "plugin_invalid") from e
    bus.publish("skill.changed", {"skill_id": r["id"], "installed": r["version"]})
    return ok(r, 201)


@router.delete("/skills/plugins/{plugin_id}")
async def plugin_uninstall(plugin_id: str, confirm: bool = False, p: auth.Principal = U):
    if not confirm:
        raise ApiError(400, "confirmation_required", "pass confirm=true")
    try:
        r = await skills.uninstall_plugin(svc.guest, plugin_id, p.actor)
    except KeyError as e:
        raise ApiError(404, "skill_not_found", "plugin not found") from e
    except skills.SkillError as e:
        raise _bad(e) from e
    bus.publish("skill.changed", {"skill_id": plugin_id, "uninstalled": True})
    return ok(r)


@router.get("/agents/{agent_id}/skills")
async def agent_skills_get(agent_id: str, p: auth.Principal = U):
    _agent(agent_id)
    return ok(skills.agent_skills(agent_id))


class AssignBody(BaseModel):
    skills: list[str]
    configs: dict[str, dict[str, Any]] = {}


@router.put("/agents/{agent_id}/skills")
async def agent_skills_put(agent_id: str, body: AssignBody, p: auth.Principal = U):
    _agent(agent_id)
    try:
        return ok(skills.assign(agent_id, body.skills, p.actor, body.configs))
    except skills.SkillError as e:
        raise _bad(e) from e


class TokenBody(BaseModel):
    token: str = Field(min_length=10, max_length=300)


@router.get("/skills/github/token")
async def github_token_status(p: auth.Principal = U):
    from nebula_host import secrets as sec

    return ok({"configured": bool(sec.store().get(GITHUB_TOKEN_REF))})  # never returns the token itself


@router.post("/skills/github/token")
async def github_token(body: TokenBody, p: auth.Principal = U):
    from nebula_host import secrets as sec

    sec.store().set(GITHUB_TOKEN_REF, body.token.strip())
    audit(p.actor, "github.token_set", None)
    return ok({"configured": True})


@router.delete("/skills/github/token")
async def github_token_delete(p: auth.Principal = U):
    from nebula_host import secrets as sec

    sec.store().delete(GITHUB_TOKEN_REF)
    audit(p.actor, "github.token_removed", None)
    return ok({"configured": False})


# ============================================================================ Module 7: resources
@router.get("/resources")
async def resources_now(p: auth.Principal = U):
    return ok(await svc.resources.snapshot(max_age=2.0))


@router.get("/resources/history")
async def resources_history(range_s: int = Query(default=3600, ge=300, le=3 * 86400), p: auth.Principal = U):
    return ok(svc.resources.history(range_s))


class ProfileBody(BaseModel):
    profile: str = Field(pattern="^(ECO|BALANCED|PERFORMANCE)$")


class PressureDrillBody(BaseModel):
    pressure: str | None = Field(default=None, pattern="^(warning|critical)$")
    minutes: float = Field(default=5, ge=0.5, le=30)


@router.post("/resources/simulate")
async def resources_simulate(body: PressureDrillBody, p: auth.Principal = U):
    """Owner-started memory-pressure drill (more conservative scheduling only; expires by itself)."""
    r = svc.resources.simulate(body.pressure, body.minutes)
    audit(p.actor, "resources.pressure_drill", body.pressure or "end", {"minutes": body.minutes})
    return ok(r)


@router.post("/resources/profile")
async def resources_profile(body: ProfileBody, p: auth.Principal = U):
    r = svc.resources.set_profile(body.profile)
    audit(p.actor, "resources.profile", body.profile)
    return ok(r)


# ============================================================================ voice (Telegram STT)
class VoiceBody(BaseModel):
    cloud_consent: bool | None = None
    cloud_model: str | None = Field(default=None, max_length=64)
    language: str | None = Field(default=None, max_length=8)


@router.get("/voice/stt")
async def voice_status(p: auth.Principal = U):
    return ok(stt.status(svc.cfg))


@router.patch("/voice/stt")
async def voice_update(body: VoiceBody, p: auth.Principal = U):
    cur = stt.settings()
    cur.update(body.model_dump(exclude_none=True))
    db.set_setting("voice.stt", cur)
    audit(p.actor, "voice.stt", None, body.model_dump(exclude_none=True))
    return ok(stt.status(svc.cfg))


# ============================================================================ overview / command center
@router.get("/overview")
async def overview(p: auth.Principal = U):
    now = time.time()
    with db.engine().connect() as c:
        agents = db.rows(c.execute(select(models.agents.c.id, models.agents.c.name, models.agents.c.status,
                                          models.agents.c.provider_id, models.agents.c.model_id,
                                          models.agents.c.last_active_at)))
        running = db.rows(c.execute(
            select(models.tasks.c.id, models.tasks.c.agent_id, models.tasks.c.state, models.tasks.c.prompt,
                   models.tasks.c.current_step, models.tasks.c.started_at, models.tasks.c.source_channel,
                   models.tasks.c.max_steps, models.tasks.c.execution, models.tasks.c.created_at,
                   models.tasks.c.failure_reason, models.agents.c.name.label("agent_name"))
            .join(models.agents, models.agents.c.id == models.tasks.c.agent_id)
            .where(models.tasks.c.state.not_in(["COMPLETED", "FAILED", "CANCELLED"]))
            .order_by(models.tasks.c.created_at.desc()).limit(20)))
        results = db.rows(c.execute(
            select(models.tasks.c.id, models.tasks.c.agent_id, models.tasks.c.state, models.tasks.c.prompt,
                   models.tasks.c.result, models.tasks.c.failure_reason, models.tasks.c.finished_at,
                   models.agents.c.name.label("agent_name"))
            .join(models.agents, models.agents.c.id == models.tasks.c.agent_id)
            .where(models.tasks.c.state.in_(["COMPLETED", "FAILED"]))
            .order_by(models.tasks.c.finished_at.desc()).limit(6)))
        team_runs = db.rows(c.execute(select(models.team_runs.c.id, models.team_runs.c.team_id,
                                             models.team_runs.c.state, models.team_runs.c.prompt,
                                             models.team_runs.c.created_at, models.teams.c.name.label("team_name"))
                                      .join(models.teams, models.teams.c.id == models.team_runs.c.team_id)
                                      .where(models.team_runs.c.state == "RUNNING")))
        upcoming = db.rows(c.execute(select(models.schedules.c.id, models.schedules.c.name,
                                            models.schedules.c.next_run_at, models.schedules.c.target_type)
                                     .where(and_(models.schedules.c.enabled.is_(True),
                                                 models.schedules.c.next_run_at.is_not(None)))
                                     .order_by(models.schedules.c.next_run_at).limit(5)))
        providers = db.rows(c.execute(select(models.providers.c.id, models.providers.c.display_name,
                                             models.providers.c.state, models.providers.c.auth_mode)))
        pending = c.execute(select(func.count()).select_from(models.approvals).where(and_(
            models.approvals.c.decision.is_(None), models.approvals.c.expires_at > now))).scalar() or 0
        wf_active = c.execute(select(func.count()).select_from(models.workflow_runs).where(
            models.workflow_runs.c.state.in_(["RUNNING", "WAITING"]))).scalar() or 0
    for r in running:
        r["prompt"] = r["prompt"][:160]
    for r in results:
        r["prompt"] = r["prompt"][:160]
        r["summary"] = ((r.pop("result") or {}).get("summary") or r.get("failure_reason") or "")[:300]
    events = bus.since(max(0, (_last_seq() or 0) - 40), 40)
    res = svc.resources._last or {}
    return ok({"agents": agents, "running_tasks": running, "recent_results": results, "active_team_runs": team_runs,
               "upcoming_schedules": upcoming, "providers": providers,
               "approvals_pending": pending + len(approvals_v2.pending()), "workflow_runs_active": wf_active,
               "recent_events": [{k: e[k] for k in ("sequence", "type", "agent_id", "task_id", "timestamp", "payload")}
                                 for e in events][-25:],
               "resources": {"host": res.get("host"), "guest": res.get("guest"), "limits": svc.resources.limits(),
                             "active_workers": svc.orch.active_count(), "queue_length": len(res.get("queue") or [])},
               "telegram": {"polling": bool(svc.telegram and svc.telegram.running)}})


def _last_seq() -> int:
    with db.engine().connect() as c:
        return c.execute(select(func.max(models.events.c.sequence))).scalar() or 0
