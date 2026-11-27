"""Visual workflow engine (V2 module 6) — executed by the backend, persistent and auditable.

Definition format (schema_version 1):
  {"schema_version": 1, "nodes": [{"id", "type", "label"?, "params": {...}, "position": {"x","y"}}],
                         "edges": [{"id"?, "source", "target", "handle"?: out|true|false|body|done|error|<case>}]}

The graph must be acyclic (loops are explicit `logic.loop` nodes with a bounded body). Runs snapshot the definition,
every node execution is a workflow_steps row, and long actions store a reference (task id, resume time) BEFORE
waiting, so a restarted host re-attaches instead of repeating them. A node whose side effect may have happened
before a crash (e.g. Telegram send) is marked UNKNOWN and never replayed. Automation depth and a per-workflow
hourly run limit stop workflows from triggering each other endlessly.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
import uuid
from typing import Any

from sqlalchemy import and_, func, select, update

from nebula_host import db, models
from nebula_host.events import audit, bus

log = logging.getLogger("nebula.workflows")
MAX_NODES = 60
MAX_DEPTH = 3
MAX_LOOP = 50
NODE_PARALLEL = 4
TERMINAL_STEP = {"COMPLETED", "FAILED", "SKIPPED", "UNKNOWN", "CANCELLED"}

TRIGGERS = {"trigger.manual", "trigger.schedule", "trigger.telegram_message", "trigger.task_completed",
            "trigger.file_created"}
ACTIONS = {"action.run_agent", "action.run_team", "action.read_file", "action.write_file", "action.browser_task",
           "action.generate_report", "action.send_telegram", "action.create_task", "action.execute_command"}
LOGIC = {"logic.condition", "logic.branch", "logic.delay", "logic.retry", "logic.loop", "logic.parallel",
         "logic.wait_approval"}
NODE_TYPES = TRIGGERS | ACTIONS | LOGIC
REQUIRED = {"action.run_agent": ["agent_id", "prompt"], "action.run_team": ["team_id", "prompt"],
            "action.read_file": ["root", "path"], "action.write_file": ["root", "path", "content"],
            "action.browser_task": ["agent_id", "url", "instructions"], "action.generate_report": ["template"],
            "action.send_telegram": ["text"], "action.create_task": ["agent_id", "prompt"],
            "action.execute_command": ["agent_id", "command"], "logic.condition": ["left", "op"],
            "logic.branch": ["value", "cases"], "logic.delay": ["seconds"], "logic.retry": ["max_attempts"],
            "logic.loop": [], "logic.wait_approval": ["summary"], "trigger.schedule": ["kind"],
            "trigger.telegram_message": ["command"]}
# nodes whose interrupted execution may already have had an external effect: never replay
NON_IDEMPOTENT = {"action.send_telegram", "action.execute_command", "action.write_file", "action.create_task"}
OPS = {"equals", "not_equals", "contains", "not_contains", "gt", "lt", "exists", "empty", "matches"}

CATALOG = [
    {"type": "trigger.manual", "group": "Triggers", "label": "Manual", "params": {}},
    {"type": "trigger.schedule", "group": "Triggers", "label": "Schedule",
     "params": {"kind": "daily", "spec": {"time": "08:00"}, "timezone": "Europe/Prague"}},
    {"type": "trigger.telegram_message", "group": "Triggers", "label": "Telegram Message",
     "params": {"command": "report"}},
    {"type": "trigger.task_completed", "group": "Triggers", "label": "Task Completed",
     "params": {"agent_id": "", "state": "COMPLETED"}},
    {"type": "trigger.file_created", "group": "Triggers", "label": "File Created",
     "params": {"root": "", "path_prefix": ""}},
    {"type": "action.run_agent", "group": "Actions", "label": "Run Agent",
     "params": {"agent_id": "", "prompt": "", "max_model_calls": 15}},
    {"type": "action.run_team", "group": "Actions", "label": "Run Team", "params": {"team_id": "", "prompt": ""}},
    {"type": "action.read_file", "group": "Actions", "label": "Read File", "params": {"root": "", "path": ""}},
    {"type": "action.write_file", "group": "Actions", "label": "Write File",
     "params": {"root": "", "path": "", "content": "{{last.text}}"}},
    {"type": "action.browser_task", "group": "Actions", "label": "Browser Task",
     "params": {"agent_id": "", "url": "https://", "instructions": ""}},
    {"type": "action.generate_report", "group": "Actions", "label": "Generate Report",
     "params": {"title": "Report", "template": "# {{title}}\n\n{{last.summary}}"}},
    {"type": "action.send_telegram", "group": "Actions", "label": "Send Telegram Message",
     "params": {"text": "{{last.summary}}", "attach_last_file": False}},
    {"type": "action.create_task", "group": "Actions", "label": "Create Task", "params": {"agent_id": "", "prompt": ""}},
    {"type": "action.execute_command", "group": "Actions", "label": "Execute Approved Command",
     "params": {"agent_id": "", "command": ""}},
    {"type": "logic.condition", "group": "Logic", "label": "Condition",
     "params": {"left": "{{last.state}}", "op": "equals", "right": "COMPLETED"}},
    {"type": "logic.branch", "group": "Logic", "label": "Branch", "params": {"value": "{{last.text}}", "cases": ["a", "b"]}},
    {"type": "logic.delay", "group": "Logic", "label": "Delay", "params": {"seconds": 60}},
    {"type": "logic.retry", "group": "Logic", "label": "Retry", "params": {"max_attempts": 2, "delay_s": 30}},
    {"type": "logic.loop", "group": "Logic", "label": "Loop (limited)", "params": {"items": "", "count": 3,
                                                                                    "max_iterations": 10}},
    {"type": "logic.parallel", "group": "Logic", "label": "Parallel Execution", "params": {}},
    {"type": "logic.wait_approval", "group": "Logic", "label": "Wait for Approval",
     "params": {"summary": "Continue the workflow?"}},
]


class WorkflowError(ValueError):
    pass


# ============================================================================ validation
def handles_of(ntype: str, params: dict[str, Any]) -> set[str]:
    if ntype == "logic.condition":
        return {"true", "false", "error"}
    if ntype == "logic.branch":
        return {str(c) for c in (params.get("cases") or [])} | {"default", "error"}
    if ntype == "logic.loop":
        return {"body", "done", "error"}
    if ntype == "logic.wait_approval":
        return {"out", "denied"}
    return {"out", "error"}


def validate(defn: Any) -> dict[str, Any]:
    if not isinstance(defn, dict) or defn.get("schema_version") != 1:
        raise WorkflowError("definition must be an object with schema_version 1")
    nodes, edges = defn.get("nodes"), defn.get("edges", [])
    if not isinstance(nodes, list) or not 1 <= len(nodes) <= MAX_NODES:
        raise WorkflowError(f"a workflow needs 1..{MAX_NODES} nodes")
    if not isinstance(edges, list):
        raise WorkflowError("edges must be a list")
    by_id: dict[str, dict[str, Any]] = {}
    for n in nodes:
        if not isinstance(n, dict) or not re.match(r"^[\w-]{1,64}$", str(n.get("id", ""))):
            raise WorkflowError("every node needs an id ([A-Za-z0-9_-], max 64)")
        if n["id"] in by_id:
            raise WorkflowError(f"duplicate node id {n['id']}")
        if n.get("type") not in NODE_TYPES:
            raise WorkflowError(f"node {n['id']}: unknown type {n.get('type')!r}")
        p = n.setdefault("params", {})
        if not isinstance(p, dict):
            raise WorkflowError(f"node {n['id']}: params must be an object")
        for k in REQUIRED.get(n["type"], []):
            if p.get(k) in (None, "", []):
                raise WorkflowError(f"node {n['id']} ({n['type']}): '{k}' is required")
        _check_params(n)
        by_id[n["id"]] = n
    triggers = [n for n in nodes if n["type"] in TRIGGERS]
    if not triggers:
        raise WorkflowError("add at least one trigger block")
    seen_edges = set()
    for e in edges:
        if not isinstance(e, dict) or e.get("source") not in by_id or e.get("target") not in by_id:
            raise WorkflowError("every edge must connect two existing nodes")
        if e["source"] == e["target"]:
            raise WorkflowError("a block cannot connect to itself")
        h = e.setdefault("handle", "out")
        if h not in handles_of(by_id[e["source"]]["type"], by_id[e["source"]]["params"]):
            raise WorkflowError(f"edge {e['source']}→{e['target']}: handle {h!r} is not valid for "
                                f"{by_id[e['source']]['type']}")
        if by_id[e["target"]]["type"] in TRIGGERS:
            raise WorkflowError(f"trigger {e['target']} cannot have incoming connections")
        key = (e["source"], e["target"], h)
        if key in seen_edges:
            raise WorkflowError("duplicate connection")
        seen_edges.add(key)
        e.setdefault("id", f"{e['source']}-{h}-{e['target']}")
    # acyclic (Kahn)
    indeg = {i: 0 for i in by_id}
    out: dict[str, list[str]] = {i: [] for i in by_id}
    for e in edges:
        indeg[e["target"]] += 1
        out[e["source"]].append(e["target"])
    q = [i for i, d in indeg.items() if d == 0]
    seen = 0
    while q:
        i = q.pop()
        seen += 1
        for t in out[i]:
            indeg[t] -= 1
            if indeg[t] == 0:
                q.append(t)
    if seen != len(by_id):
        raise WorkflowError("the workflow contains a cycle — use a Loop block (with a limit) for repetition")
    # loop bodies must be self-contained
    for n in nodes:
        if n["type"] == "logic.loop":
            body = loop_body(n["id"], edges)
            for e in edges:
                if e["target"] in body and e["source"] not in body and not (e["source"] == n["id"] and e["handle"] == "body"):
                    raise WorkflowError(f"loop {n['id']}: block {e['target']} is in the loop body and cannot also be "
                                        "reached from outside it")
                if e["source"] in body and e["target"] not in body:
                    raise WorkflowError(f"loop {n['id']}: the loop body must not connect outside the loop "
                                        "(continue from the loop's 'done' output)")
            if any(by_id[b]["type"] in ("logic.loop", "logic.wait_approval", "logic.delay") for b in body):
                raise WorkflowError(f"loop {n['id']}: nested loops, delays and approvals are not allowed in a loop body")
    for n in nodes:
        if n["type"] == "logic.retry":
            targets = [e for e in edges if e["source"] == n["id"]]
            if len(targets) != 1 or by_id[targets[0]["target"]]["type"] not in ACTIONS:
                raise WorkflowError(f"retry {n['id']} must connect to exactly one action block")
    return {"schema_version": 1, "nodes": nodes, "edges": edges}


def _check_params(n: dict[str, Any]) -> None:
    try:
        _check_params_inner(n)
    except (TypeError, ValueError) as e:
        if isinstance(e, WorkflowError):
            raise
        raise WorkflowError(f"node {n['id']}: invalid parameter value ({e})") from e


def _check_params_inner(n: dict[str, Any]) -> None:
    p, t = n["params"], n["type"]
    if t == "logic.delay" and not 0 <= float(p.get("seconds", 0)) <= 86400:
        raise WorkflowError(f"node {n['id']}: delay must be 0..86400 s")
    if t == "logic.loop":
        mx = int(p.get("max_iterations", 10))
        if not 1 <= mx <= MAX_LOOP:
            raise WorkflowError(f"node {n['id']}: max_iterations must be 1..{MAX_LOOP}")
    if t == "logic.retry" and not 1 <= int(p.get("max_attempts", 2)) <= 5:
        raise WorkflowError(f"node {n['id']}: max_attempts must be 1..5")
    if t == "logic.condition" and p.get("op") not in OPS:
        raise WorkflowError(f"node {n['id']}: op must be one of {', '.join(sorted(OPS))}")
    if t in ("action.run_agent", "action.browser_task") and not 1 <= int(p.get("max_model_calls", 15)) <= 50:
        raise WorkflowError(f"node {n['id']}: max_model_calls must be 1..50")
    if t == "logic.branch" and (not isinstance(p.get("cases"), list) or not 1 <= len(p["cases"]) <= 10):
        raise WorkflowError(f"node {n['id']}: cases must list 1..10 values")
    if t == "trigger.schedule":
        from nebula_host import cron

        try:
            cron.next_run(p.get("kind", ""), p.get("spec") or {}, p.get("timezone") or "UTC", time.time(), time.time())
            cron.tz(p.get("timezone") or "UTC")
        except cron.CronError as e:
            raise WorkflowError(f"node {n['id']}: {e}") from e
        # a one-time date in the past is not an error: that trigger has simply fired (or is exhausted)
        if p.get("misfire_policy") not in (None, "skip", "run_once", "ask"):
            raise WorkflowError(f"node {n['id']}: misfire_policy must be skip, run_once or ask")
    if t == "trigger.telegram_message" and not re.match(r"^[a-z0-9_]{1,32}$", str(p.get("command", ""))):
        raise WorkflowError(f"node {n['id']}: command must be [a-z0-9_]{{1,32}} (used as /wf <command> ...)")


def loop_body(loop_id: str, edges: list[dict[str, Any]]) -> set[str]:
    body: set[str] = set()
    stack = [e["target"] for e in edges if e["source"] == loop_id and e.get("handle") == "body"]
    while stack:
        i = stack.pop()
        if i in body:
            continue
        body.add(i)
        stack += [e["target"] for e in edges if e["source"] == i]
    return body


# ============================================================================ templating
TPL = re.compile(r"\{\{\s*([\w.\-]+)\s*\}\}")


def _lookup(ctx: dict[str, Any], path: str) -> Any:
    cur: Any = ctx
    for part in path.split("."):
        if isinstance(cur, dict):
            cur = cur.get(part)
        elif isinstance(cur, list) and part.isdigit() and int(part) < len(cur):
            cur = cur[int(part)]
        else:
            return None
    return cur


def render(s: Any, ctx: dict[str, Any]) -> str:
    """{{trigger.text}}, {{nodes.<id>.summary}}, {{last.summary}}, {{loop.item}} — plain substitution, no code."""
    def sub(m: re.Match[str]) -> str:
        v = _lookup(ctx, m.group(1))
        if v is None:
            return ""
        return v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)

    return TPL.sub(sub, str(s or ""))


# ============================================================================ CRUD
def get(workflow_id: str) -> dict[str, Any]:
    with db.engine().connect() as c:
        r = db.row(c.execute(select(models.workflows).where(models.workflows.c.id == workflow_id)).first())
    if not r:
        raise KeyError(workflow_id)
    return r


def list_all() -> list[dict[str, Any]]:
    with db.engine().connect() as c:
        rows = db.rows(c.execute(select(models.workflows).order_by(models.workflows.c.name)))
        for r in rows:
            r["last_run"] = db.row(c.execute(select(models.workflow_runs.c.id, models.workflow_runs.c.state,
                                                    models.workflow_runs.c.created_at)
                                             .where(models.workflow_runs.c.workflow_id == r["id"])
                                             .order_by(models.workflow_runs.c.created_at.desc()).limit(1)).first())
    return rows


def get_run(run_id: str) -> dict[str, Any]:
    with db.engine().connect() as c:
        r = db.row(c.execute(select(models.workflow_runs).where(models.workflow_runs.c.id == run_id)).first())
        if not r:
            raise KeyError(run_id)
        r["steps"] = db.rows(c.execute(select(models.workflow_steps).where(models.workflow_steps.c.run_id == run_id)
                                       .order_by(models.workflow_steps.c.started_at)))
        r["workflow_name"] = c.execute(select(models.workflows.c.name).where(
            models.workflows.c.id == r["workflow_id"])).scalar()
    return r


def list_runs(workflow_id: str | None = None, limit: int = 50) -> list[dict[str, Any]]:
    with db.engine().connect() as c:
        q = select(models.workflow_runs.c.id, models.workflow_runs.c.workflow_id, models.workflow_runs.c.state,
                   models.workflow_runs.c.trigger, models.workflow_runs.c.created_at, models.workflow_runs.c.finished_at,
                   models.workflow_runs.c.error, models.workflow_runs.c.workflow_version,
                   models.workflows.c.name.label("workflow_name")).outerjoin(
            models.workflows, models.workflows.c.id == models.workflow_runs.c.workflow_id)
        if workflow_id:
            q = q.where(models.workflow_runs.c.workflow_id == workflow_id)
        return db.rows(c.execute(q.order_by(models.workflow_runs.c.created_at.desc()).limit(min(limit, 500))))


# ============================================================================ engine
class WorkflowEngine:
    def __init__(self, orch, teams, files, telegram_sender=None, schedules=None) -> None:
        self.orch = orch
        self.teams = teams
        self.files = files
        self.telegram_sender = telegram_sender  # async (text, file: tuple[name, bytes] | None) -> int
        self.schedules = schedules
        self.running: dict[str, asyncio.Task] = {}
        self.waiters: dict[str, asyncio.Event] = {}

    # ---------------------------------------------------------------- definitions
    def create(self, body: dict[str, Any], actor: str) -> dict[str, Any]:
        name = str(body.get("name") or "").strip()
        if not 1 <= len(name) <= 128:
            raise WorkflowError("name is required")
        defn = validate(body.get("definition"))
        wid = str(uuid.uuid4())
        now = db.now()
        with db.engine().begin() as c:
            c.execute(models.workflows.insert().values(
                id=wid, name=name, description=str(body.get("description") or "")[:2000], version=1, definition=defn,
                enabled=bool(body.get("enabled", True)), trigger_types=sorted({n["type"] for n in defn["nodes"]
                                                                               if n["type"] in TRIGGERS}),
                max_runs_per_hour=max(1, min(int(body.get("max_runs_per_hour", 20)), 120)), created_at=now,
                updated_at=now))
        try:
            self._sync_schedules(wid, actor)
        except Exception:
            from sqlalchemy import delete

            with db.engine().begin() as c:  # nothing half-created: the workflow goes away with its schedules
                c.execute(delete(models.workflows).where(models.workflows.c.id == wid))
            raise
        audit(actor, "workflow.create", wid, {"name": name})
        return get(wid)

    def update(self, workflow_id: str, body: dict[str, Any], actor: str) -> dict[str, Any]:
        cur = get(workflow_id)
        vals: dict[str, Any] = {"updated_at": db.now()}
        if body.get("definition") is not None:
            vals["definition"] = validate(body["definition"])
            vals["version"] = cur["version"] + 1
            vals["trigger_types"] = sorted({n["type"] for n in vals["definition"]["nodes"] if n["type"] in TRIGGERS})
        for k in ("name", "description", "enabled", "max_runs_per_hour"):
            if body.get(k) is not None:
                vals[k] = body[k]
        with db.engine().begin() as c:
            c.execute(update(models.workflows).where(models.workflows.c.id == workflow_id).values(**vals))
        self._sync_schedules(workflow_id, actor)
        audit(actor, "workflow.update", workflow_id, {"version": vals.get("version", cur["version"])})
        return get(workflow_id)

    def duplicate(self, workflow_id: str, actor: str) -> dict[str, Any]:
        w = get(workflow_id)
        return self.create({"name": f"{w['name']} (copy)"[:128], "description": w["description"],
                            "definition": w["definition"], "enabled": False}, actor)

    def delete(self, workflow_id: str, actor: str) -> dict[str, Any]:
        get(workflow_id)
        from sqlalchemy import delete

        for rid, t in list(self.running.items()):
            if get_run(rid)["workflow_id"] == workflow_id:
                t.cancel()
        with db.engine().begin() as c:
            c.execute(delete(models.schedules).where(and_(models.schedules.c.target_type == "workflow",
                                                          models.schedules.c.target_id == workflow_id)))
            c.execute(delete(models.workflows).where(models.workflows.c.id == workflow_id))
        audit(actor, "workflow.delete", workflow_id)
        return {"deleted": workflow_id}

    def export(self, workflow_id: str) -> dict[str, Any]:
        w = get(workflow_id)
        return {"nebula_workflow": 1, "name": w["name"], "description": w["description"], "definition": w["definition"],
                "exported_at": db.now(), "version": w["version"]}

    def import_(self, doc: dict[str, Any], actor: str) -> dict[str, Any]:
        if not isinstance(doc, dict) or doc.get("nebula_workflow") != 1:
            raise WorkflowError("not a NEBULA workflow export (nebula_workflow: 1)")
        return self.create({"name": doc.get("name") or "Imported workflow", "description": doc.get("description", ""),
                            "definition": doc.get("definition"), "enabled": False}, actor)

    def _sync_schedules(self, workflow_id: str, actor: str) -> None:
        """A Schedule trigger block owns a managed schedule row (target_type=workflow)."""
        if self.schedules is None:
            return
        from sqlalchemy import delete

        w = get(workflow_id)
        nodes = [n for n in w["definition"]["nodes"] if n["type"] == "trigger.schedule"]
        with db.engine().connect() as c:
            existing = db.rows(c.execute(select(models.schedules).where(and_(
                models.schedules.c.target_type == "workflow", models.schedules.c.target_id == workflow_id))))
        keep = set()
        for n in nodes:
            p = n["params"]
            spec = {**(p.get("spec") or {}), "managed_by": {"workflow_id": workflow_id, "node_id": n["id"]}}
            cur = next((s for s in existing if (s["spec"] or {}).get("managed_by", {}).get("node_id") == n["id"]), None)
            if p.get("kind") == "once" and float((p.get("spec") or {}).get("at") or 0) <= time.time():
                if cur:
                    keep.add(cur["id"])  # already fired: keep its history, nothing to (re)schedule
                continue
            body = {"name": f"Workflow · {w['name']}", "target_type": "workflow", "target_id": workflow_id,
                    "prompt": p.get("prompt", ""), "kind": p.get("kind"), "spec": spec,
                    "timezone": p.get("timezone") or "UTC", "enabled": bool(w["enabled"]),
                    "misfire_policy": p.get("misfire_policy", "run_once"), "notify": {"telegram": False}}
            if cur:
                self.schedules.update(cur["id"], body, actor)
                keep.add(cur["id"])
            else:
                keep.add(self.schedules.create(body, actor)["id"])
        with db.engine().begin() as c:
            for s in existing:
                if s["id"] not in keep:
                    c.execute(delete(models.schedules).where(models.schedules.c.id == s["id"]))

    # ---------------------------------------------------------------- runs
    async def start(self, workflow_id: str, *, trigger: str = "manual", payload: dict | None = None,
                    actor: str = "user", parent_ref: dict | None = None, origin_depth: int = 0) -> dict[str, Any]:
        w = get(workflow_id)
        if not w["enabled"] and trigger != "manual":
            raise WorkflowError("workflow is disabled")
        if origin_depth >= MAX_DEPTH:
            raise WorkflowError("automation depth limit reached: workflows cannot trigger each other endlessly")
        with db.engine().connect() as c:
            recent = c.execute(select(func.count()).select_from(models.workflow_runs).where(and_(
                models.workflow_runs.c.workflow_id == workflow_id,
                models.workflow_runs.c.created_at > time.time() - 3600))).scalar() or 0
            active = c.execute(select(func.count()).select_from(models.workflow_runs).where(and_(
                models.workflow_runs.c.workflow_id == workflow_id,
                models.workflow_runs.c.state.in_(["RUNNING", "WAITING"])))).scalar() or 0
        if recent >= w["max_runs_per_hour"]:
            raise WorkflowError(f"rate limit: {w['max_runs_per_hour']} runs per hour")
        if active >= 3:
            raise WorkflowError("3 runs of this workflow are already active")
        rid = str(uuid.uuid4())
        now = db.now()
        ctx = {"trigger": {"type": trigger, **(payload or {})}, "nodes": {}, "last": {}}
        with db.engine().begin() as c:
            c.execute(models.workflow_runs.insert().values(
                id=rid, workflow_id=workflow_id, workflow_version=w["version"], definition=w["definition"],
                state="RUNNING", trigger=trigger, trigger_payload=payload or {}, context=ctx,
                origin_depth=origin_depth, created_at=now, updated_at=now))
        audit(actor, "workflow.run.start", rid, {"workflow_id": workflow_id, "trigger": trigger,
                                                 "parent_ref": parent_ref})
        if parent_ref:
            with db.engine().begin() as c:
                c.execute(update(models.workflow_runs).where(models.workflow_runs.c.id == rid)
                          .values(context={**ctx, "parent_ref": parent_ref}))
        bus.publish("workflow.run.started", {"run_id": rid, "workflow_id": workflow_id, "name": w["name"],
                                             "trigger": trigger})
        self._spawn(rid)
        return get_run(rid)

    def _spawn(self, run_id: str) -> None:
        t = asyncio.create_task(self._execute(run_id), name=f"workflow-{run_id[:8]}")
        self.running[run_id] = t
        t.add_done_callback(lambda _t: self.running.pop(run_id, None))

    async def resume_all(self) -> None:
        with db.engine().connect() as c:
            ids = [r.id for r in c.execute(select(models.workflow_runs.c.id).where(
                models.workflow_runs.c.state.in_(["RUNNING", "WAITING"])))]
        for rid in ids:
            log.info("resuming workflow run %s after restart", rid)
            self._spawn(rid)

    async def stop_run(self, run_id: str, actor: str) -> dict[str, Any]:
        run = get_run(run_id)
        if run["state"] not in ("RUNNING", "WAITING"):
            return run
        t = self.running.get(run_id)
        if t:
            t.cancel()
        for s in run["steps"]:
            if s["state"] in ("RUNNING", "WAITING") and (s.get("ref") or {}).get("task_id"):
                try:
                    await self.orch.stop(s["ref"]["task_id"], "cancel")
                except KeyError:
                    pass
            if s["state"] in ("RUNNING", "WAITING"):
                self._step_update(s["id"], "CANCELLED", error="stopped by owner")
        self._finish(run_id, "CANCELLED", error=f"stopped by {actor}")
        audit(actor, "workflow.run.stop", run_id)
        return get_run(run_id)

    # ---------------------------------------------------------------- step persistence
    def _steps(self, run_id: str) -> list[dict[str, Any]]:
        with db.engine().connect() as c:
            return db.rows(c.execute(select(models.workflow_steps).where(models.workflow_steps.c.run_id == run_id)
                                     .order_by(models.workflow_steps.c.started_at)))

    def _step_start(self, run_id: str, node: dict[str, Any], attempt: int, scope: str = "") -> str:
        sid = str(uuid.uuid4())
        with db.engine().begin() as c:
            c.execute(models.workflow_steps.insert().values(
                id=sid, run_id=run_id, node_id=node["id"] + scope, node_type=node["type"], state="RUNNING",
                attempt=attempt, started_at=db.now()))
        bus.publish("workflow.step", {"run_id": run_id, "node_id": node["id"] + scope, "state": "RUNNING",
                                      "type": node["type"], "attempt": attempt})
        return sid

    def _step_update(self, step_id: str, state: str, *, output: Any = None, ref: dict | None = None,
                     error: str | None = None) -> None:
        vals: dict[str, Any] = {"state": state}
        if output is not None:
            vals["output"] = output
        if ref is not None:
            vals["ref"] = ref
        if error is not None:
            vals["error"] = error[:4000]
        if state in TERMINAL_STEP:
            vals["finished_at"] = db.now()
        with db.engine().begin() as c:
            c.execute(update(models.workflow_steps).where(models.workflow_steps.c.id == step_id).values(**vals))
            r = c.execute(select(models.workflow_steps.c.run_id, models.workflow_steps.c.node_id)
                          .where(models.workflow_steps.c.id == step_id)).first()
        if r and state != "RUNNING":
            bus.publish("workflow.step", {"run_id": r.run_id, "node_id": r.node_id, "state": state,
                                          "error": (error or "")[:300]})

    def _save_ctx(self, run_id: str, ctx: dict[str, Any]) -> None:
        with db.engine().begin() as c:
            c.execute(update(models.workflow_runs).where(models.workflow_runs.c.id == run_id)
                      .values(context=ctx, updated_at=db.now()))

    def _finish(self, run_id: str, state: str, *, error: str | None = None, summary: str | None = None) -> None:
        with db.engine().begin() as c:
            n = c.execute(update(models.workflow_runs).where(and_(models.workflow_runs.c.id == run_id,
                                                                  models.workflow_runs.c.state.in_(["RUNNING", "WAITING"])))
                          .values(state=state, error=error, finished_at=db.now(), updated_at=db.now())).rowcount
        if n:
            run = get_run(run_id)
            bus.publish("workflow.run.finished", {"run_id": run_id, "workflow_id": run["workflow_id"],
                                                  "name": run["workflow_name"], "state": state, "error": error,
                                                  "summary": summary,
                                                  "parent_ref": (run.get("context") or {}).get("parent_ref")})

    # ---------------------------------------------------------------- executor
    async def _execute(self, run_id: str) -> None:
        try:
            await self._execute_inner(run_id)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            log.exception("workflow run %s crashed", run_id)
            self._finish(run_id, "FAILED", error=f"engine error: {type(e).__name__}: {e}")

    async def _execute_inner(self, run_id: str) -> None:
        run = get_run(run_id)
        defn = run["definition"]
        nodes = {n["id"]: n for n in defn["nodes"]}
        edges = defn["edges"]
        ctx = run["context"] or {"trigger": {}, "nodes": {}, "last": {}}
        body_nodes = set().union(*[loop_body(n, edges) for n in nodes if nodes[n]["type"] == "logic.loop"]) \
            if any(n["type"] == "logic.loop" for n in nodes.values()) else set()
        # node state from persisted steps (latest attempt wins)
        status: dict[str, str] = {}
        handle_of: dict[str, str] = {}
        attempts: dict[str, int] = {}
        for s in self._steps(run_id):
            if "#" in s["node_id"]:
                continue  # loop-body iterations are internal to their loop node
            status[s["node_id"]] = s["state"]
            attempts[s["node_id"]] = max(attempts.get(s["node_id"], 0), s["attempt"])
            out = s.get("output") or {}
            handle_of[s["node_id"]] = out.get("_handle", "out") if isinstance(out, dict) else "out"
            if s["state"] in ("RUNNING", "WAITING"):
                await self._recover_step(run_id, s, nodes.get(s["node_id"]), ctx, status, handle_of)
        # trigger nodes
        ttype = "trigger." + (run["trigger"] if run["trigger"] != "manual" else "manual")
        fired = [n for n in nodes.values() if n["type"] == ttype] or [n for n in nodes.values() if n["type"] in TRIGGERS][:1]
        for n in nodes.values():
            if n["type"] in TRIGGERS and n["id"] not in status:
                st = "COMPLETED" if n in fired else "SKIPPED"
                sid = self._step_start(run_id, n, 1)
                self._step_update(sid, st, output={"_handle": "out", **(ctx.get("trigger") or {})})
                status[n["id"]] = st
                if st == "COMPLETED":
                    ctx["nodes"][n["id"]] = ctx.get("trigger") or {}
        failed_unhandled: list[str] = []
        sem = asyncio.Semaphore(NODE_PARALLEL)
        while True:
            ready, skip = [], []
            for nid in nodes:
                if nid in status or nid in body_nodes:
                    continue
                inc = [e for e in edges if e["target"] == nid]
                if not inc:
                    skip.append(nid)
                    continue
                if any(status.get(e["source"]) not in TERMINAL_STEP for e in inc):
                    continue
                active = [e for e in inc if status.get(e["source"]) == "COMPLETED"
                          and handle_of.get(e["source"], "out") == e["handle"]]
                (ready if active else skip).append(nid)
            for nid in skip:
                sid = self._step_start(run_id, nodes[nid], 1)
                self._step_update(sid, "SKIPPED")
                status[nid] = "SKIPPED"
            if not ready:
                if skip:
                    continue
                break

            async def run_one(nid: str) -> None:
                async with sem:
                    st, handle = await self._run_node(run_id, nodes[nid], ctx, edges, nodes,
                                                      attempts.get(nid, 0) + 1)
                    status[nid], handle_of[nid] = st, handle
                    if st in ("FAILED", "UNKNOWN") and not any(e["source"] == nid and e["handle"] == "error"
                                                               for e in edges):
                        failed_unhandled.append(nid)
                    if st in ("FAILED", "UNKNOWN") and handle == "error":
                        status[nid] = "COMPLETED"  # failure routed to the error branch

            await asyncio.gather(*(run_one(n) for n in ready))
            self._save_ctx(run_id, ctx)
            if failed_unhandled:
                for nid, n in nodes.items():  # nothing else starts after an unhandled failure
                    if nid not in status and nid not in body_nodes:
                        sid = self._step_start(run_id, n, 1)
                        self._step_update(sid, "SKIPPED", error="skipped: an earlier block failed")
                        status[nid] = "SKIPPED"
                break
        last = ctx.get("last") or {}
        if failed_unhandled:
            self._finish(run_id, "FAILED", error=f"block(s) failed: {', '.join(failed_unhandled)}",
                         summary=str(last.get("summary") or "")[:1500])
        else:
            self._finish(run_id, "COMPLETED", summary=str(last.get("summary") or last.get("text") or "")[:1500])

    async def _recover_step(self, run_id: str, s: dict[str, Any], node: dict | None, ctx: dict[str, Any],
                            status: dict[str, str], handle_of: dict[str, str]) -> None:
        """A step that was running when the host stopped: re-attach, re-run (idempotent) or mark UNKNOWN."""
        ref = s.get("ref") or {}
        if node is None:
            self._step_update(s["id"], "FAILED", error="node removed")
            status[s["node_id"]] = "FAILED"
            return
        if ref.get("task_id") or ref.get("team_run_id") or ref.get("resume_at") or ref.get("approval_id"):
            status.pop(s["node_id"], None)  # re-executed below via _run_node, which re-attaches through ref
            self._step_update(s["id"], "CANCELLED", error="host restarted; re-attached in a new attempt")
            ctx.setdefault("_reattach", {})[s["node_id"]] = ref
            return
        risky_loop = node["type"] == "logic.loop" and any(
            n["type"] in NON_IDEMPOTENT or n["type"] in ("action.run_agent", "action.run_team", "action.browser_task")
            for n in get_run(run_id)["definition"]["nodes"] if n["id"] in loop_body(node["id"], get_run(run_id)["definition"]["edges"]))
        if node["type"] in NON_IDEMPOTENT or risky_loop:
            self._step_update(s["id"], "UNKNOWN", error="NEBULA restarted while this block ran; it was NOT repeated "
                                                        "(its effect may or may not have happened)")
            status[s["node_id"]] = "UNKNOWN"
            handle_of[s["node_id"]] = "error"
            return
        status.pop(s["node_id"], None)
        self._step_update(s["id"], "CANCELLED", error="host restarted; re-run (idempotent block)")

    async def _run_node(self, run_id: str, node: dict[str, Any], ctx: dict[str, Any], edges: list[dict],
                        nodes: dict[str, dict], attempt: int, scope: str = "") -> tuple[str, str]:
        retry = next((nodes[e["source"]]["params"] for e in edges
                      if e["target"] == node["id"] and nodes[e["source"]]["type"] == "logic.retry"), None)
        max_attempts = int(retry.get("max_attempts", 1)) if retry else 1
        while True:
            sid = self._step_start(run_id, node, attempt, scope)
            try:
                out = await self._exec(run_id, sid, node, ctx, edges, nodes, scope)
                handle = out.pop("_handle", "out") if isinstance(out, dict) else "out"
                self._step_update(sid, "COMPLETED", output={**out, "_handle": handle})
                ctx["nodes"][node["id"]] = out
                if node["type"] not in LOGIC or node["type"] == "logic.loop":
                    ctx["last"] = out
                return "COMPLETED", handle
            except asyncio.CancelledError:
                self._step_update(sid, "CANCELLED", error="cancelled")
                raise
            except Exception as e:  # noqa: BLE001 - recorded on the step
                msg = str(e) if isinstance(e, WorkflowError | ValueError | KeyError) else f"{type(e).__name__}: {e}"
                self._step_update(sid, "FAILED", error=msg)
                ctx["nodes"][node["id"]] = {"error": msg, "state": "FAILED"}
                if attempt < max_attempts:
                    attempt += 1
                    await asyncio.sleep(min(float(retry.get("delay_s", 30)), 3600))
                    continue
                return "FAILED", "error" if any(e["source"] == node["id"] and e["handle"] == "error"
                                                for e in edges) else "out"

    async def _wait_task(self, task_id: str) -> dict[str, Any]:
        from nebula_runtime.orchestrator import get_task

        while True:
            t = get_task(task_id)
            if t["state"] in ("COMPLETED", "FAILED", "CANCELLED"):
                return t
            ev = self.waiters.setdefault(task_id, asyncio.Event())
            try:
                await asyncio.wait_for(ev.wait(), 5)
            except TimeoutError:
                pass
            ev.clear()

    async def _exec(self, run_id: str, step_id: str, node: dict[str, Any], ctx: dict[str, Any], edges: list[dict],
                    nodes: dict[str, dict], scope: str) -> dict[str, Any]:
        t, p = node["type"], node["params"]
        run = get_run(run_id)
        depth = run["origin_depth"] + 1
        reattach = (ctx.get("_reattach") or {}).pop(node["id"], None) if not scope else None
        R = lambda v: render(v, {**ctx, "params": p, "title": p.get("title", "")})  # noqa: E731
        if t in ("action.run_agent", "action.browser_task"):
            if reattach and reattach.get("task_id"):
                tid = reattach["task_id"]
            else:
                prompt = R(p["prompt"]) if t == "action.run_agent" else (
                    f"Open {R(p['url'])} in your browser. {R(p['instructions'])}")
                task = self.orch.enqueue(p["agent_id"], prompt, source="workflow", max_steps=int(p.get("max_model_calls", 15)),
                                         parent_ref={"type": "workflow_run", "id": run_id, "node_id": node["id"]},
                                         max_runtime_s=float(p.get("max_runtime_s", 1800)), origin_depth=depth)
                tid = task["id"]
            self._step_update(step_id, "RUNNING", ref={"task_id": tid})
            done = await self._wait_task(tid)
            res = done.get("result") or {}
            out = {"task_id": tid, "state": done["state"], "summary": res.get("summary") or done.get("failure_reason"),
                   "artifacts": res.get("verified_artifacts", []), "text": res.get("summary") or ""}
            if done["state"] != "COMPLETED":
                raise WorkflowError(f"agent task {done['state']}: {done.get('failure_reason')}")
            return out
        if t == "action.run_team":
            if reattach and reattach.get("team_run_id"):
                trid = reattach["team_run_id"]
            else:
                tr = await self.teams.start_run(p["team_id"], R(p["prompt"]), source="workflow",
                                                parent_ref={"type": "workflow_run", "id": run_id, "node_id": node["id"]},
                                                origin_depth=depth, actor=f"workflow:{run_id}")
                trid = tr["id"]
            self._step_update(step_id, "RUNNING", ref={"team_run_id": trid})
            while True:
                tr = self.teams.get_run(trid)
                if tr["state"] != "RUNNING":
                    break
                await asyncio.sleep(3)
            res = tr.get("result") or {}
            if tr["state"] != "COMPLETED":
                raise WorkflowError(f"team run {tr['state']}: {tr.get('error')}")
            return {"team_run_id": trid, "state": tr["state"], "summary": res.get("summary"),
                    "artifacts": res.get("artifacts", []), "text": res.get("summary") or ""}
        if t == "action.read_file":
            data = b""
            async for ch in self.files.read_all(R(p["root"]), R(p["path"]), limit=2 * 1024 * 1024):
                data += ch
            text = data.decode(errors="replace")
            return {"path": R(p["path"]), "size": len(data), "text": text, "summary": text[:1500]}
        if t == "action.write_file":
            content = R(p["content"]).encode()

            async def gen():
                yield content

            r = await self.files.write_stream(R(p["root"]), R(p["path"]), gen(), f"workflow:{run_id}")
            return {"path": R(p["path"]), "root": R(p["root"]), "size": r["size"], "summary": f"wrote {R(p['path'])}",
                    "file": {"root": R(p["root"]), "path": R(p["path"])}}
        if t == "action.generate_report":
            text = R(p["template"])
            out: dict[str, Any] = {"text": text, "summary": text[:1500], "title": p.get("title", "")}
            if p.get("save_root") and p.get("save_path"):
                async def gen2():
                    yield text.encode()

                await self.files.write_stream(R(p["save_root"]), R(p["save_path"]), gen2(), f"workflow:{run_id}")
                out["file"] = {"root": R(p["save_root"]), "path": R(p["save_path"])}
            return out
        if t == "action.send_telegram":
            if not self.telegram_sender:
                raise WorkflowError("Telegram is not configured")
            attach = None
            last_file = (ctx.get("last") or {}).get("file")
            if p.get("attach_last_file") and last_file:
                data = b""
                async for ch in self.files.read_all(last_file["root"], last_file["path"], limit=20 * 1024 * 1024):
                    data += ch
                attach = (last_file["path"].rsplit("/", 1)[-1], data)
            n = await self.telegram_sender(R(p["text"])[:3900], attach)
            if not n:
                raise WorkflowError("no approved Telegram chat to send to")
            return {"sent_to": n, "summary": (ctx.get("last") or {}).get("summary", "")}
        if t == "action.create_task":
            task = self.orch.enqueue(p["agent_id"], R(p["prompt"]), source="workflow",
                                     parent_ref={"type": "workflow_run", "id": run_id, "node_id": node["id"],
                                                 "detached": True}, origin_depth=depth)
            return {"task_id": task["id"], "summary": f"task {task['id'][:8]} queued"}
        if t == "action.execute_command":
            return await self._approved_command(run_id, step_id, node, R, reattach)
        if t == "logic.condition":
            return {"result": _compare(R(p["left"]), p["op"], R(p.get("right", ""))),
                    "_handle": "true" if _compare(R(p["left"]), p["op"], R(p.get("right", ""))) else "false"}
        if t == "logic.branch":
            v = R(p["value"]).strip()
            case = next((str(c) for c in p["cases"] if str(c) == v), "default")
            return {"value": v, "case": case, "_handle": case}
        if t == "logic.delay":
            resume_at = (reattach or {}).get("resume_at") or time.time() + float(p["seconds"])
            self._step_update(step_id, "RUNNING", ref={"resume_at": resume_at})
            await asyncio.sleep(max(0.0, resume_at - time.time()))
            return {"waited_s": float(p["seconds"])}
        if t in ("logic.retry", "logic.parallel"):
            return {"passthrough": True}
        if t == "logic.wait_approval":
            from nebula_host import approvals_v2

            aid = (reattach or {}).get("approval_id") or approvals_v2.request(
                "workflow", {"run_id": run_id, "node_id": node["id"]}, R(p["summary"]),
                {"workflow": run.get("workflow_name")})
            self._step_update(step_id, "WAITING", ref={"approval_id": aid})
            with db.engine().begin() as c:
                c.execute(update(models.workflow_runs).where(models.workflow_runs.c.id == run_id).values(state="WAITING"))
            decision = await self._wait_approval(aid)
            with db.engine().begin() as c:
                c.execute(update(models.workflow_runs).where(models.workflow_runs.c.id == run_id).values(state="RUNNING"))
            if decision != "approved":
                if any(e["source"] == node["id"] and e["handle"] == "denied" for e in edges):
                    return {"decision": decision, "_handle": "denied"}
                raise WorkflowError(f"owner decision: {decision}")
            return {"decision": decision}
        if t == "logic.loop":
            return await self._loop(run_id, node, ctx, edges, nodes, R)
        raise WorkflowError(f"block type {t} cannot be executed")

    async def _wait_approval(self, approval_id: str) -> str:
        from nebula_host import approvals_v2

        while True:
            a = approvals_v2.get(approval_id)
            if a["decision"]:
                return a["decision"]
            if a["expires_at"] < time.time():
                await approvals_v2.resolve(approval_id, "denied", "system:ttl")
                continue
            ev = self.waiters.setdefault(f"approval:{approval_id}", asyncio.Event())
            try:
                await asyncio.wait_for(ev.wait(), 10)
            except TimeoutError:
                pass
            ev.clear()

    async def _approved_command(self, run_id: str, step_id: str, node: dict[str, Any], R, reattach) -> dict[str, Any]:
        """Run a shell command in an agent's workspace ONLY after the owner approved this exact command."""
        from nebula_runtime import policy
        from nebula_runtime.orchestrator import get_agent
        from nebula_runtime.tools import BY_WIRE

        from nebula_host import approvals_v2

        p = node["params"]
        agent = get_agent(p["agent_id"])
        if not agent:
            raise WorkflowError("agent not found")
        cmd = R(p["command"])
        dec = policy.decide(BY_WIRE["shell_execute"], {"command": cmd}, level="ADVANCED",
                            linux_user=agent["linux_user"], st=policy.TaskPolicyState(), require_approval=True)
        if dec.action == "deny":
            raise WorkflowError(f"command refused by policy: {dec.reason}")
        aid = (reattach or {}).get("approval_id") or approvals_v2.request(
            "command", {"run_id": run_id, "node_id": node["id"]}, f"Workflow wants to run on {agent['name']}: {cmd}"[:1900],
            {"command": cmd, "agent": agent["name"], "categories": dec.categories})
        self._step_update(step_id, "WAITING", ref={"approval_id": aid})
        decision = await self._wait_approval(aid)
        if decision != "approved":
            raise WorkflowError(f"command not approved ({decision})")
        self._step_update(step_id, "RUNNING", ref={"approval_id": aid, "executing": True})
        if agent["status"] in ("SLEEP", "STOPPED"):
            await self.orch.guest.call("workspace.start", {"agent_id": agent["id"]}, timeout=120)
        r = await self.orch.guest.tool(agent["id"], "shell.execute", {"command": cmd, "timeout": int(p.get("timeout", 120))},
                                       timeout=float(p.get("timeout", 120)) + 30)
        if not r.get("ok"):
            raise WorkflowError(f"command failed: {(r.get('error') or {}).get('message')}")
        res = r["result"]
        audit(f"workflow:{run_id}", "workflow.command", agent["id"], {"command": cmd, "exit_code": res["exit_code"]})
        out = {"exit_code": res["exit_code"], "stdout": res["stdout"][-8000:], "stderr": res["stderr"][-4000:],
               "summary": res["stdout"][-1500:], "text": res["stdout"]}
        if res["exit_code"] != 0:
            raise WorkflowError(f"command exited with {res['exit_code']}: {res['stderr'][-300:]}")
        return out

    async def _loop(self, run_id: str, node: dict[str, Any], ctx: dict[str, Any], edges: list[dict],
                    nodes: dict[str, dict], R) -> dict[str, Any]:
        p = node["params"]
        items: list[Any]
        raw = R(p.get("items", "")) if p.get("items") else ""
        if raw.strip():
            try:
                items = json.loads(raw)
                if not isinstance(items, list):
                    items = [items]
            except json.JSONDecodeError:
                items = [x for x in raw.splitlines() if x.strip()]
        else:
            items = list(range(int(p.get("count", 1))))
        limit = min(int(p.get("max_iterations", 10)), MAX_LOOP)
        body = loop_body(node["id"], edges)
        order = _topo([n for n in nodes if n in body], [e for e in edges if e["source"] in body and e["target"] in body])
        results = []
        for i, item in enumerate(items[:limit]):
            ctx["loop"] = {"item": item, "index": i}
            for nid in order:
                st, _ = await self._run_node(run_id, nodes[nid], ctx, edges, nodes, 1, scope=f"#{i}")
                if st != "COMPLETED":
                    raise WorkflowError(f"loop iteration {i}: block {nid} failed")
            results.append((ctx.get("last") or {}).get("summary"))
        ctx.pop("loop", None)
        return {"iterations": len(results), "results": results, "truncated": len(items) > limit,
                "summary": "\n".join(str(r) for r in results if r)[:1500], "_handle": "done"}

    # ---------------------------------------------------------------- triggers
    async def on_event(self, ev: dict[str, Any]) -> None:
        t = ev["type"]
        p = ev.get("payload") or {}
        if t in ("task.completed", "task.failed", "task.cancelled") and ev.get("task_id"):
            w = self.waiters.get(ev["task_id"])
            if w:
                w.set()
        if t == "owner.approval.resolved":
            w = self.waiters.get(f"approval:{p.get('approval_id')}")
            if w:
                w.set()
        depth = int(p.get("origin_depth") or 0)
        if t in ("task.completed", "task.failed"):
            await self._fire("trigger.task_completed", lambda prm: (not prm.get("agent_id") or prm["agent_id"] == ev["agent_id"])
                             and (prm.get("state", "any") in ("any", t.split(".")[1].upper())),
                             {"task_id": ev["task_id"], "agent_id": ev["agent_id"], "state": t.split(".")[1].upper(),
                              "summary": (p.get("result") or {}).get("summary") or p.get("reason")}, depth)
        elif t == "file.created":
            by = str(p.get("by", ""))
            fdepth = MAX_DEPTH if by.startswith("workflow:") else depth  # files written by workflows never re-trigger
            await self._fire("trigger.file_created", lambda prm: (not prm.get("root") or prm["root"] == p.get("root"))
                             and str(p.get("path", "")).startswith(prm.get("path_prefix") or ""),
                             {"root": p.get("root"), "path": p.get("path"), "size": p.get("size")}, fdepth)

    async def on_telegram(self, command: str, text: str, chat: dict[str, Any]) -> list[str]:
        started = []
        for w in list_all():
            if not w["enabled"] or "trigger.telegram_message" not in (w["trigger_types"] or []):
                continue
            if any(n["type"] == "trigger.telegram_message" and n["params"].get("command") == command
                   for n in w["definition"]["nodes"]):
                r = await self.start(w["id"], trigger="telegram_message", payload={"text": text, "chat": chat},
                                     actor="telegram")
                started.append(r["id"])
        return started

    async def _fire(self, ttype: str, match, payload: dict[str, Any], depth: int) -> None:
        if depth >= MAX_DEPTH - 1:
            return  # events produced by deep automation never start further workflows
        for w in list_all():
            if not w["enabled"] or ttype not in (w["trigger_types"] or []):
                continue
            if any(n["type"] == ttype and match(n["params"]) for n in w["definition"]["nodes"]):
                try:
                    await self.start(w["id"], trigger=ttype.split(".", 1)[1], payload=payload, actor="trigger",
                                     origin_depth=depth + 1)
                except WorkflowError as e:
                    log.info("workflow %s not started by %s: %s", w["id"], ttype, e)


def _compare(left: str, op: str, right: str) -> bool:
    if op == "equals":
        return left.strip() == right.strip()
    if op == "not_equals":
        return left.strip() != right.strip()
    if op == "contains":
        return right.lower() in left.lower()
    if op == "not_contains":
        return right.lower() not in left.lower()
    if op == "exists":
        return bool(left.strip())
    if op == "empty":
        return not left.strip()
    if op == "matches":
        try:
            return re.search(right, left[:100000]) is not None
        except re.error:
            return False
    try:
        a, b = float(left), float(right)
    except ValueError:
        return False
    return a > b if op == "gt" else a < b


def _topo(ids: list[str], edges: list[dict[str, Any]]) -> list[str]:
    indeg = {i: 0 for i in ids}
    for e in edges:
        indeg[e["target"]] += 1
    order, q = [], [i for i in ids if indeg[i] == 0]
    while q:
        i = q.pop(0)
        order.append(i)
        for e in edges:
            if e["source"] == i:
                indeg[e["target"]] -= 1
                if indeg[e["target"]] == 0:
                    q.append(e["target"])
    return order
