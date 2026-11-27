"""Agent skills & plugins (V2 module 9).

A skill is a named bundle of tools. Built-in skills map onto the real tool catalogue (nebula_runtime.tools).
Plugins are UNTRUSTED code: they are installed only from a local .zip the owner uploads (never downloaded
automatically), validated (manifest schema, paths, size, checksum) and executed only inside the Ubuntu VM as the
calling agent's unprivileged Linux user (guest tool `plugin.run`), never on macOS. Every plugin tool goes through
the normal policy engine; declared risk categories require the owner's approval.
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
import re
import zipfile
from dataclasses import dataclass
from typing import Any

from nebula_runtime.tools import BUILTIN_SKILLS, LEVELS, TOOLS, Tool
from sqlalchemy import and_, delete, select, update

from nebula_host import db, models
from nebula_host.config import APP_VERSION
from nebula_host.events import audit

PLUGIN_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_.-]{1,63}$")
VERSION_RE = re.compile(r"^(\d+)\.(\d+)\.(\d+)$")
TOOL_NAME_RE = re.compile(r"^[a-z][a-z0-9_]{0,31}$")
MAX_ZIP = 5 * 1024 * 1024
MAX_FILES = 200
RISKS = {"privileged", "mass_delete", "external_share", "payment", "credential_entry", "outbound_message",
         "system_change", "system_install"}

BUILTIN_META: dict[str, dict[str, Any]] = {
    "computer": {"name": "Computer control", "description": "Mouse, keyboard, drag & drop, windows and apps on the "
                 "agent's own XFCE desktop.", "deps": []},
    "browser": {"name": "Browser", "description": "Visible Chromium: navigate, read pages, click, type, tabs, "
                "downloads.", "deps": []},
    "filesystem": {"name": "Filesystem", "description": "Read, write, edit, search, move and copy files in the "
                   "workspace and team directories.", "deps": []},
    "terminal": {"name": "Terminal", "description": "Shell commands and background processes as the agent's "
                 "unprivileged user; approved package installs.", "deps": []},
    "git": {"name": "Git", "description": "git clone/status/commit/... in the workspace; push needs approval.",
            "deps": ["git"]},
    "github": {"name": "GitHub", "description": "GitHub REST API (public read; writes need a token and approval).",
               "deps": []},
    "python": {"name": "Python", "description": "Run Python 3 code and scripts.", "deps": ["python3"]},
    "nodejs": {"name": "Node.js", "description": "Run JavaScript with Node.js.", "deps": ["node"]},
    "pdf": {"name": "PDF", "description": "Extract text from PDF documents (poppler).", "deps": ["pdftotext"]},
    "csv_json": {"name": "CSV / JSON", "description": "Convert and inspect CSV and JSON data files.", "deps": []},
    "web_research": {"name": "Web research", "description": "Web search plus page reading in the agent's browser.",
                     "deps": []},
    "documents": {"name": "Document processing", "description": "Markdown/text to HTML, HTML to text, word counts.",
                  "deps": []},
    "screenshot": {"name": "Screenshot", "description": "Capture the real desktop for the owner and vision models.",
                   "deps": []},
    "data_analysis": {"name": "Basic data analysis", "description": "Column types, statistics, grouping and sums "
                      "for CSV/JSON.", "deps": []},
}


class SkillError(ValueError):
    pass


@dataclass(frozen=True)
class PluginTool(Tool):
    plugin_id: str = ""
    plugin_tool: str = ""
    plugin_risks: tuple[str, ...] = ()


def _tools_of(skill_id: str) -> list[str]:
    return [t.wire for t in TOOLS if skill_id in t.skills]


def _min_level(tools: list[str]) -> str:
    lv = [next(t.min_level for t in TOOLS if t.wire == w) for w in tools]
    return min(lv, key=LEVELS.index) if lv else "READ_ONLY"


def ensure_builtins() -> None:
    now = db.now()
    with db.engine().begin() as c:
        have = {r.id for r in c.execute(select(models.skills.c.id))}
        for sid in BUILTIN_SKILLS:
            meta = BUILTIN_META[sid]
            tools = _tools_of(sid)
            manifest = {"schema_version": 1, "id": sid, "name": meta["name"], "version": "1.0.0",
                        "description": meta["description"], "tools": tools,
                        "permissions": {"min_level": _min_level(tools),
                                        "levels": {t.wire: t.min_level for t in TOOLS if t.wire in tools}},
                        "config_schema": {"type": "object", "properties": {}},
                        "dependencies": {"guest": meta["deps"]},
                        "security": {"runs_in": "Ubuntu VM as the agent's Linux user", "approvals": "policy engine"}}
            if sid in have:
                c.execute(update(models.skills).where(models.skills.c.id == sid)
                          .values(manifest=manifest, name=meta["name"], description=meta["description"], updated_at=now))
            else:
                c.execute(models.skills.insert().values(id=sid, name=meta["name"], version="1.0.0",
                                                        description=meta["description"], kind="builtin",
                                                        manifest=manifest, enabled=True, installed_at=now,
                                                        updated_at=now))


def list_skills() -> list[dict[str, Any]]:
    with db.engine().connect() as c:
        rows = db.rows(c.execute(select(models.skills).order_by(models.skills.c.kind, models.skills.c.name)))
        counts: dict[str, int] = {}
        for r in c.execute(select(models.agent_skills.c.skill_id).where(models.agent_skills.c.enabled.is_(True))):
            counts[r.skill_id] = counts.get(r.skill_id, 0) + 1
        usage: dict[str, int] = {}
        for r in c.execute(select(models.skill_usage.c.skill_id)):
            usage[r.skill_id] = usage.get(r.skill_id, 0) + 1
    for r in rows:
        r["assigned_agents"] = counts.get(r["id"], 0)
        r["usage_count"] = usage.get(r["id"], 0)
    return rows


def get_skill(skill_id: str) -> dict[str, Any]:
    with db.engine().connect() as c:
        r = db.row(c.execute(select(models.skills).where(models.skills.c.id == skill_id)).first())
    if not r:
        raise KeyError(skill_id)
    return r


def set_enabled(skill_id: str, enabled: bool, actor: str) -> dict[str, Any]:
    get_skill(skill_id)
    with db.engine().begin() as c:
        c.execute(update(models.skills).where(models.skills.c.id == skill_id).values(enabled=enabled, updated_at=db.now()))
    audit(actor, "skill.enable" if enabled else "skill.disable", skill_id)
    return get_skill(skill_id)


# ----------------------------------------------------------------------------- per-agent
def agent_skills(agent_id: str) -> list[dict[str, Any]]:
    """All skills with this agent's assignment state; agents without explicit assignments use every built-in."""
    with db.engine().connect() as c:
        rows = {r.skill_id: dict(r._mapping) for r in c.execute(
            select(models.agent_skills).where(models.agent_skills.c.agent_id == agent_id))}
    explicit = bool(rows)
    out = []
    for s in list_skills():
        a = rows.get(s["id"])
        assigned = a["enabled"] if a else (not explicit and s["kind"] == "builtin")
        out.append({**s, "assigned": bool(assigned) and s["enabled"], "config": (a or {}).get("config") or {},
                    "explicit": a is not None})
    return out


def assign(agent_id: str, skill_ids: list[str], actor: str, configs: dict[str, dict] | None = None) -> list[dict]:
    known = {s["id"] for s in list_skills()}
    bad = [s for s in skill_ids if s not in known]
    if bad:
        raise SkillError(f"unknown skills: {', '.join(bad)}")
    now = db.now()
    with db.engine().begin() as c:
        c.execute(delete(models.agent_skills).where(models.agent_skills.c.agent_id == agent_id))
        for sid in known:  # explicit rows for every skill: unassigned ones are stored as disabled
            c.execute(models.agent_skills.insert().values(agent_id=agent_id, skill_id=sid, enabled=sid in skill_ids,
                                                          config=(configs or {}).get(sid, {}), assigned_at=now))
    audit(actor, "skill.assign", agent_id, {"skills": sorted(skill_ids)})
    return agent_skills(agent_id)


def skill_set(agent_id: str) -> set[str]:
    return {s["id"] for s in agent_skills(agent_id) if s["assigned"]}


def plugin_tools_for(agent_id: str) -> list[PluginTool]:
    out: list[PluginTool] = []
    for s in agent_skills(agent_id):
        if s["kind"] != "plugin" or not s["assigned"]:
            continue
        m = s["manifest"]
        for t in m.get("tools", []):
            out.append(plugin_tool(m, t))
    return out


def plugin_tool(m: dict[str, Any], t: dict[str, Any]) -> PluginTool:
    wire = ("plug_" + re.sub(r"[^a-z0-9]", "_", m["id"]) + "_" + t["name"])[:64]
    perms = m.get("permissions") or {}
    return PluginTool(wire, "plugin.run", f"[plugin {m['name']}] {t.get('description', '')}"[:900],
                      t.get("parameters") or {"type": "object", "properties": {}},
                      perms.get("min_level", "ADVANCED"),
                      side_effect=(m.get("security") or {}).get("side_effects", True) is not False, skills=(m["id"],),
                      plugin_id=m["id"], plugin_tool=t["name"],
                      plugin_risks=tuple(r for r in perms.get("risk_categories", []) if r in RISKS))


def record_usage(agent_id: str, task_id: str, tool: Tool, status: str, skills_enabled: set[str]) -> None:
    sid = next((s for s in tool.skills if s in skills_enabled), tool.skills[0] if tool.skills else None)
    if not sid:
        return
    with db.engine().begin() as c:
        c.execute(models.skill_usage.insert().values(skill_id=sid, agent_id=agent_id, task_id=task_id, tool=tool.wire,
                                                     status=status, ts=db.now()))


# ----------------------------------------------------------------------------- plugins
def _ver(v: str) -> tuple[int, int, int]:
    m = VERSION_RE.match(v)
    if not m:
        raise SkillError("version must be MAJOR.MINOR.PATCH")
    return int(m.group(1)), int(m.group(2)), int(m.group(3))


def validate_manifest(m: Any) -> dict[str, Any]:
    if not isinstance(m, dict) or m.get("schema_version") != 1:
        raise SkillError("nebula-plugin.json must be an object with schema_version 1")
    pid = m.get("id")
    if not isinstance(pid, str) or not PLUGIN_ID_RE.match(pid) or pid in BUILTIN_SKILLS:
        raise SkillError("id must match [a-z0-9][a-z0-9_.-]{1,63} and not shadow a built-in skill")
    for k in ("name", "version", "description", "entrypoint"):
        if not isinstance(m.get(k), str) or not m[k].strip():
            raise SkillError(f"{k} is required")
    _ver(m["version"])
    if not re.match(r"^[\w./-]{1,120}\.py$", m["entrypoint"]) or ".." in m["entrypoint"]:
        raise SkillError("entrypoint must be a relative .py path inside the plugin")
    tools = m.get("tools")
    if not isinstance(tools, list) or not 1 <= len(tools) <= 20:
        raise SkillError("tools must list 1-20 tools")
    names = set()
    for t in tools:
        if not isinstance(t, dict) or not TOOL_NAME_RE.match(str(t.get("name", ""))):
            raise SkillError("each tool needs a name matching [a-z][a-z0-9_]{0,31}")
        if t["name"] in names:
            raise SkillError(f"duplicate tool {t['name']}")
        names.add(t["name"])
        params = t.get("parameters", {"type": "object", "properties": {}})
        if not isinstance(params, dict) or params.get("type") != "object":
            raise SkillError(f"tool {t['name']}: parameters must be a JSON schema object")
    perms = m.setdefault("permissions", {})
    if not isinstance(perms, dict):
        raise SkillError("permissions must be an object")
    lvl = perms.setdefault("min_level", "ADVANCED")
    if lvl not in ("READ_ONLY", "STANDARD", "ADVANCED"):
        raise SkillError("permissions.min_level must be READ_ONLY|STANDARD|ADVANCED")
    sec = m.setdefault("security", {})
    if sec.get("network") and lvl != "ADVANCED":
        raise SkillError("plugins that use the network must require ADVANCED agents")
    unknown = [r for r in perms.get("risk_categories", []) if r not in RISKS]
    if unknown:
        raise SkillError(f"unknown risk categories: {', '.join(unknown)}")
    m.setdefault("config_schema", {"type": "object", "properties": {}})
    m.setdefault("dependencies", {})
    req = (m["dependencies"] or {}).get("nebula")
    if req and req.startswith(">="):
        if _ver(_pad(req[2:])) > _ver(_pad(APP_VERSION)):
            raise SkillError(f"plugin needs NEBULA {req} (this is {APP_VERSION})")
    m["timeout_s"] = max(1, min(int(m.get("timeout_s", 60)), 300))
    return m


def _pad(v: str) -> str:
    parts = (v.strip().split(".") + ["0", "0", "0"])[:3]
    return ".".join(p if p.isdigit() else "0" for p in parts)


def read_plugin_zip(data: bytes) -> tuple[dict[str, Any], dict[str, str], str]:
    if len(data) > MAX_ZIP:
        raise SkillError("plugin archive exceeds 5 MiB")
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as e:
        raise SkillError("not a valid .zip archive") from e
    infos = [i for i in zf.infolist() if not i.is_dir()]
    if len(infos) > MAX_FILES:
        raise SkillError("too many files in plugin")
    total = sum(i.file_size for i in infos)
    if total > 20 * 1024 * 1024:
        raise SkillError("plugin unpacks to more than 20 MiB")
    names = [i.filename for i in infos]
    prefix = ""
    if "nebula-plugin.json" not in names:  # allow a single top-level folder
        tops = {n.split("/", 1)[0] for n in names}
        if len(tops) == 1 and f"{next(iter(tops))}/nebula-plugin.json" in names:
            prefix = next(iter(tops)) + "/"
        else:
            raise SkillError("nebula-plugin.json not found at the archive root")
    files: dict[str, str] = {}
    for i in infos:
        if (i.external_attr >> 16) & 0o170000 == 0o120000:
            raise SkillError(f"symlinks are not allowed ({i.filename})")
        rel = i.filename[len(prefix):]
        if not rel or rel.startswith("/") or ".." in rel.split("/") or "\\" in rel:
            raise SkillError(f"unsafe path in archive: {i.filename}")
        files[rel] = base64.b64encode(zf.read(i)).decode()
    manifest = validate_manifest(json.loads(base64.b64decode(files["nebula-plugin.json"])))
    if manifest["entrypoint"] not in files:
        raise SkillError(f"entrypoint {manifest['entrypoint']} missing from archive")
    return manifest, files, hashlib.sha256(data).hexdigest()


async def install_plugin(guest, data: bytes, actor: str, allow_downgrade: bool = False) -> dict[str, Any]:
    manifest, files, checksum = read_plugin_zip(data)
    try:
        cur = get_skill(manifest["id"])
    except KeyError:
        cur = None
    if cur and cur["kind"] != "plugin":
        raise SkillError("id collides with a built-in skill")
    if cur and _ver(manifest["version"]) <= _ver(cur["version"]) and not allow_downgrade:
        raise SkillError(f"version {manifest['version']} is not newer than installed {cur['version']}")
    caps = await guest.call("guest.capabilities", {}, timeout=30)
    missing = [d for d in (manifest.get("dependencies") or {}).get("guest", []) if not caps.get(d)]
    if missing:
        raise SkillError(f"missing in the VM: {', '.join(missing)}")
    await guest.call("plugins.install", {"plugin_id": manifest["id"], "version": manifest["version"],
                                         "files": files}, timeout=120)
    now = db.now()
    with db.engine().begin() as c:
        if cur:
            c.execute(update(models.skills).where(models.skills.c.id == manifest["id"]).values(
                name=manifest["name"], version=manifest["version"], description=manifest["description"],
                manifest=manifest, checksum=checksum, updated_at=now))
        else:
            c.execute(models.skills.insert().values(
                id=manifest["id"], name=manifest["name"], version=manifest["version"],
                description=manifest["description"], kind="plugin", manifest=manifest, enabled=True,
                checksum=checksum, installed_at=now, updated_at=now))
    audit(actor, "plugin.update" if cur else "plugin.install", manifest["id"],
          {"version": manifest["version"], "sha256": checksum})
    return get_skill(manifest["id"])


async def uninstall_plugin(guest, plugin_id: str, actor: str) -> dict[str, Any]:
    s = get_skill(plugin_id)
    if s["kind"] != "plugin":
        raise SkillError("built-in skills cannot be uninstalled (disable them instead)")
    await guest.call("plugins.remove", {"plugin_id": plugin_id}, timeout=60)
    with db.engine().begin() as c:
        c.execute(delete(models.skills).where(models.skills.c.id == plugin_id))
    audit(actor, "plugin.uninstall", plugin_id)
    return {"uninstalled": plugin_id}


def usage(skill_id: str | None = None, limit: int = 200) -> list[dict[str, Any]]:
    with db.engine().connect() as c:
        q = select(models.skill_usage)
        if skill_id:
            q = q.where(models.skill_usage.c.skill_id == skill_id)
        return db.rows(c.execute(q.order_by(models.skill_usage.c.id.desc()).limit(limit)))


def compatibility(caps: dict[str, Any]) -> dict[str, dict[str, Any]]:
    out = {}
    for s in list_skills():
        deps = (s["manifest"].get("dependencies") or {}).get("guest", [])
        missing = [d for d in deps if not caps.get(d)]
        out[s["id"]] = {"ok": not missing, "missing": missing}
    return out


def _unused() -> None:
    _ = and_
