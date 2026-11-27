"""Execution environments (V3): where an agent's task really runs.

* ``vm``   — the agent's own Linux user + XFCE desktop in the shared Ubuntu VM (V1/V2 behaviour, Live Desktop).
* ``host`` — native macOS execution inside an owner-authorised project folder (nebula_host.hostexec).

Resolution for company work (most specific wins):
    company.default_environment  <  project.environment  <  company member override  <  project assignment override
Standalone agent tasks use the agent's own setting (agents.config.execution, default ``vm``).
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import and_, select, update

from nebula_host import db, models
from nebula_host.events import audit, bus

ENVS = ("vm", "host")
LABELS = {"vm": "Ubuntu VM — Isolated Execution", "host": "Mac mini — Native Execution"}
ACTIVE_STATES = ("RECEIVED", "QUEUED", "PLANNING", "EXECUTING", "VERIFYING", "WAITING_APPROVAL", "WAITING_CONTROL",
                 "PAUSING", "PAUSED", "WAITING_PROVIDER")
HOST_UNAVAILABLE_SKILLS = ("computer", "browser", "web_research", "screenshot")


class EnvError(ValueError):
    def __init__(self, code: str, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


def describe() -> list[dict[str, Any]]:
    return [
        {"id": "host", "label": LABELS["host"],
         "benefits": ["Works on your real project folders with your installed toolchains (git, Node, Python, Swift, "
                      "Xcode, Flutter…)", "No VM memory needed; fastest builds on Apple silicon"],
         "limitations": ["Only folders you authorise; macOS sandbox blocks the rest of your Mac, Keychain and other "
                         "apps", "No desktop/browser control on macOS (terminal, files, git and dev tools only)",
                         "No Live Desktop"],
         "permissions": ["read/write the authorised folder (or read-only)", "run sandboxed commands",
                         "network per folder setting", "deletes and system changes need your approval"]},
        {"id": "vm", "label": LABELS["vm"],
         "benefits": ["Fully isolated Linux user and desktop per agent", "Browser + GUI automation, Live Desktop, "
                      "Take Control", "Cannot touch your Mac's files"],
         "limitations": ["Shares the VM's 4 GB RAM", "Files reach the Mac only through transfers"],
         "permissions": ["own workspace + team/company folders", "permission level READ_ONLY/STANDARD/ADVANCED",
                         "approvals for sensitive actions"]},
    ]


def agent_execution(agent: dict[str, Any]) -> dict[str, Any]:
    ex = ((agent.get("config") or {}).get("execution") or {})
    env = ex.get("env") if ex.get("env") in ENVS else "vm"
    return {"env": env, "root_id": ex.get("root_id"), "source": "agent"}


def _company_ctx(agent_id: str, project_id: str | None) -> dict[str, Any] | None:
    with db.engine().connect() as c:
        m = db.row(c.execute(select(models.company_members).where(models.company_members.c.agent_id == agent_id)).first())
        if not m:
            return None
        comp = db.row(c.execute(select(models.companies).where(models.companies.c.id == m["company_id"])).first())
        proj = pm = None
        if project_id:
            proj = db.row(c.execute(select(models.company_projects).where(and_(
                models.company_projects.c.id == project_id,
                models.company_projects.c.company_id == m["company_id"]))).first())
            pm = db.row(c.execute(select(models.project_members).where(and_(
                models.project_members.c.project_id == project_id,
                models.project_members.c.agent_id == agent_id))).first())
    return {"member": m, "company": comp, "project": proj, "assignment": pm}


def resolve(agent_id: str, project_id: str | None = None) -> dict[str, Any]:
    """Effective environment for an agent (inside a project when given) with the level that decided it."""
    with db.engine().connect() as c:
        agent = db.row(c.execute(select(models.agents).where(models.agents.c.id == agent_id)).first())
    if not agent:
        raise EnvError("agent_not_found", "agent not found", 404)
    ctx = _company_ctx(agent_id, project_id)
    if ctx is None:
        r = agent_execution(agent)
        return {**r, "label": LABELS[r["env"]], "chain": [{"level": "agent", "env": r["env"]}]}
    comp, proj, m, pm = ctx["company"], ctx["project"], ctx["member"], ctx["assignment"]
    chain = [{"level": "company", "env": comp["default_environment"]}]
    env, source = comp["default_environment"], "company"
    root_id = comp.get("default_root_id")
    if proj and proj.get("environment"):
        env, source = proj["environment"], "project"
        chain.append({"level": "project", "env": env})
    if proj and proj.get("host_root_id"):
        root_id = proj["host_root_id"]
    if m.get("environment"):
        env, source = m["environment"], "member"
        chain.append({"level": "member", "env": env})
    if pm and pm.get("environment"):
        env, source = pm["environment"], "assignment"
        chain.append({"level": "assignment", "env": env})
    if env == "host" and not root_id:
        root_id = agent_execution(agent).get("root_id")
    return {"env": env, "root_id": root_id if env == "host" else None, "source": source, "label": LABELS[env],
            "chain": chain}


def check_ready(env: str, root_id: str | None) -> list[str]:
    """Problems that would make tasks in this environment fail (empty = ready)."""
    problems: list[str] = []
    if env == "host":
        from nebula_host import hostexec

        if not hostexec.sandbox_available():
            problems.append("macOS sandbox-exec is unavailable")
        if not root_id:
            problems.append("no authorised host project folder selected")
        else:
            try:
                r = hostexec.get_root(root_id)
                if not r["enabled"]:
                    problems.append("the host project folder is disabled")
                if not r.get("exists", True) and not __import__("pathlib").Path(r["path"]).is_dir():
                    problems.append(f"{r['path']} no longer exists")
            except hostexec.HostExecError as e:
                problems.append(e.message)
    return problems


def active_tasks(agent_id: str) -> list[dict[str, Any]]:
    with db.engine().connect() as c:
        return db.rows(c.execute(select(models.tasks.c.id, models.tasks.c.state).where(and_(
            models.tasks.c.agent_id == agent_id, models.tasks.c.state.in_(ACTIVE_STATES)))))


async def switch(agent_id: str, env: str, root_id: str | None, actor: str, guest=None) -> dict[str, Any]:
    """Change an agent's own execution environment safely (memory, history, skills and workspace are kept)."""
    if env not in ENVS:
        raise EnvError("invalid_environment", "environment must be vm or host")
    with db.engine().connect() as c:
        agent = db.row(c.execute(select(models.agents).where(models.agents.c.id == agent_id)).first())
    if not agent:
        raise EnvError("agent_not_found", "agent not found", 404)
    busy = active_tasks(agent_id)
    if busy:
        raise EnvError("agent_busy", f"the agent has {len(busy)} active/paused task(s); finish or stop them before "
                                     "switching environments", 409)
    problems = check_ready(env, root_id)
    if env == "vm" and guest is not None:
        try:
            await guest.ping(timeout=5)
        except Exception as e:  # noqa: BLE001
            problems.append(f"VM unavailable: {type(e).__name__}")
    if problems:
        raise EnvError("environment_not_ready", "; ".join(problems), 409)
    before = agent_execution(agent)
    cfg = dict(agent.get("config") or {})
    cfg["execution"] = {"env": env, "root_id": root_id if env == "host" else None, "changed_at": db.now(),
                        "changed_by": actor}
    with db.engine().begin() as c:
        c.execute(update(models.agents).where(models.agents.c.id == agent_id).values(config=cfg, updated_at=db.now()))
    audit(actor, "agent.environment.switch", agent_id, {"from": before["env"], "to": env, "root_id": root_id})
    bus.publish("environment.changed", {"from": before["env"], "to": env, "root_id": root_id, "by": actor},
                agent_id=agent_id)
    return summary(agent_id)


def summary(agent_id: str, project_id: str | None = None) -> dict[str, Any]:
    from nebula_runtime.tools import allowed_tools

    from nebula_host import skills as skillsvc

    with db.engine().connect() as c:
        agent = db.row(c.execute(select(models.agents).where(models.agents.c.id == agent_id)).first())
    eff = resolve(agent_id, project_id)
    skill_ids = skillsvc.skill_set(agent_id)
    tools = [t.wire for t in allowed_tools(agent["permission_level"], skill_ids, env=eff["env"])]
    root = None
    if eff.get("root_id"):
        from nebula_host import hostexec

        try:
            root = hostexec.get_root(eff["root_id"])
        except hostexec.HostExecError:
            root = None
    unavailable = [s for s in sorted(skill_ids or []) if eff["env"] == "host" and s in HOST_UNAVAILABLE_SKILLS]
    with db.engine().connect() as c:
        co = c.execute(select(models.companies.c.id, models.companies.c.name).join(
            models.company_members, models.company_members.c.company_id == models.companies.c.id)
            .where(models.company_members.c.agent_id == agent_id)).first()
    return {"agent_id": agent_id, "effective": eff, "root": root, "tools": tools,
            "skills_unavailable_here": unavailable, "problems": check_ready(eff["env"], eff.get("root_id")),
            "live_desktop": eff["env"] == "vm", "company": {"id": co.id, "name": co.name} if co else None}
