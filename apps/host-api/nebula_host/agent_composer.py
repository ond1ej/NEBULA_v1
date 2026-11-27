"""Agent composer (V3.2.2): create and configure a real NEBULA agent from the Telegram Mini App (and the dashboard).

It is NOT a second agent system: creation goes through ``agents_service.create`` (DB row + the agent's own Linux
user, desktop and browser profile in the VM) and every option maps to an existing backend mechanism:

=====================  ==================================================================================
Mini App field         Backend
=====================  ==================================================================================
name / description     agents.name / agents.description (existing rules: NAME_RE, 1000 chars)
avatar                 agents.config.avatar  {kind: emoji|initials|icon, value}
provider / model       agents.provider_id / model_id — provider must be connected, model must be in the
                       provider's live model list (never an invented id)
instructions           agents.config.instructions — added to the agent's system prompt (owner-defined, below
                       NEBULA's safety rules)
environment            ``vm`` only from here; native macOS execution is set up on the Mac (owner_only, as in V3)
capabilities           skills (browser, web_research, filesystem, terminal, computer + extra skills) and the
                       permission level (READ_ONLY / STANDARD / ADVANCED; HOST_CONTROL never)
memory                 agents.config.memory_auto_save
vault access           agents.config.sign_in_assistance (Smart sign-in tool on/off). Vault grants are never
                       created here — they stay local-only (V3.2.1)
resources              resource_mode (ACTIVE | SLEEP at creation), config.idle_sleep_minutes, desktop_resolution
=====================  ==================================================================================

Approvals are not configurable per agent: the global policy and the always-approve categories apply to every agent.
"""

from __future__ import annotations

import logging
import re
import time
import unicodedata
from typing import Any

from nebula_runtime.tools import LEVELS
from sqlalchemy import func, select, update

from nebula_host import agents_service, db, models
from nebula_host import providers_service as provs
from nebula_host import skills as skillsvc
from nebula_host.errors import ApiError
from nebula_host.events import audit, bus

log = logging.getLogger("nebula.agent_composer")

CAPABILITIES: dict[str, dict[str, Any]] = {
    "browser": {"label": "Browser", "skills": ["browser", "screenshot"], "default": True,
                "description": "Visible Chromium in its own desktop: open pages, read, click and type."},
    "web_research": {"label": "Web research", "skills": ["web_research"], "default": True,
                     "description": "Web search plus page reading."},
    "files": {"label": "Files", "skills": ["filesystem"], "default": True,
              "description": "Read and write files in its own workspace (never your Mac's files)."},
    "terminal": {"label": "Terminal", "skills": ["terminal"], "default": False, "requires_level": "ADVANCED",
                 "description": "Shell commands as its unprivileged Linux user in the VM. Needs the Advanced level."},
    "desktop": {"label": "Desktop control", "skills": ["computer"], "default": False,
                "description": "Mouse and keyboard on its own VM desktop (you can always watch in Live Desktop)."},
}
CORE_SKILLS = {s for c in CAPABILITIES.values() for s in c["skills"]}
LEVEL_CHOICES = ("READ_ONLY", "STANDARD", "ADVANCED")
LEVEL_INFO = {"READ_ONLY": "Can read pages and files, cannot change anything.",
              "STANDARD": "Browser, desktop and its own files. No terminal.",
              "ADVANCED": "Everything in Standard plus terminal, Python, Node.js and git in the VM."}
VAULT_OPTIONS = ("none", "ask")
AVATAR_ICONS = ("robot", "spark", "brain", "code", "search", "chart", "briefcase", "globe", "shield", "book", "bolt",
                "star", "mail", "calendar", "music", "camera")
RESOURCE_MODES = ("ACTIVE", "SLEEP")
MAX_INSTRUCTIONS = 4000
DEFAULT_INSTRUCTIONS = ("Be concise and accurate. Explain what you did and what you found. Ask me before doing "
                        "anything irreversible.")
_INITIALS = re.compile(r"^[^\W_]{1,2}$", re.UNICODE)
_rate: dict[str, list[float]] = {}


class ComposeError(ApiError):
    pass


def _err(status: int, code: str, message: str, **details: Any) -> ComposeError:
    return ComposeError(status, code, message, details=details or None)


def rate_limit(actor: str, n: int = 6, per_s: float = 600.0) -> None:
    now = time.time()
    hits = [t for t in _rate.get(actor, []) if now - t < per_s]
    if len(hits) >= n:
        raise _err(429, "rate_limited", "too many agents created recently; try again in a few minutes",
                   retry_after=int(per_s - (now - hits[0])))
    hits.append(now)
    _rate[actor] = hits


# ============================================================================ catalogue for the form
def _skill_level(skill: dict[str, Any]) -> str:
    """Level at which every tool of the skill is usable (a toggle must never be decorative)."""
    levels = [lv for lv in ((skill.get("manifest") or {}).get("permissions") or {}).get("levels", {}).values()
              if lv in LEVELS]
    if not levels:
        levels = [((skill.get("manifest") or {}).get("permissions") or {}).get("min_level", "ADVANCED")]
    return max(levels, key=LEVELS.index)


def _connected(row: dict[str, Any]) -> bool:
    return str(row.get("state") or "").startswith("Connected")


def provider_choices() -> list[dict[str, Any]]:
    out = []
    for r in provs.list_rows():
        if r.get("adapter_type") == "cli_mode":
            continue  # detection-only integrations can never run an agent
        ok = _connected(r)
        out.append({"id": r["id"], "name": r["display_name"], "state": r["state"], "connected": ok,
                    "reason": None if ok else (
                        "Sign in again on your Mac (Settings → AI providers)" if "Re-auth" in str(r["state"])
                        else "Not connected — connect it on your Mac (Settings → AI providers)")})
    return out


def options() -> dict[str, Any]:
    from nebula_host import smart_auth
    from nebula_host.config import get_config

    extra = []
    for s in skillsvc.list_skills():
        if not s["enabled"] or s["id"] in CORE_SKILLS:
            continue
        extra.append({"id": s["id"], "name": s["name"], "description": s["description"], "kind": s["kind"],
                      "requires_level": _skill_level(s)})
    with db.engine().connect() as c:
        names = [r.name for r in c.execute(select(models.agents.c.name).where(models.agents.c.status != "DELETING"))]
    host_roots = 0
    try:
        from nebula_host import hostexec

        host_roots = len([r for r in hostexec.list_roots() if r.get("enabled")])
    except Exception:  # noqa: BLE001 - host execution not configured
        pass
    return {
        "providers": provider_choices(),
        "environments": [
            {"id": "vm", "label": "Ubuntu VM", "available": True, "default": True,
             "description": "Its own isolated Linux user, desktop and browser. Cannot touch your Mac's files."},
            {"id": "host", "label": "macOS host", "available": False, "default": False,
             "description": "Native execution in a project folder you authorised on the Mac.",
             "reason": "Native Mac execution can only be enabled on the Mac itself (Dashboard → agent → "
                       "Environment): it reaches your real files, so it is never switched remotely.",
             "authorised_folders": host_roots}],
        "capabilities": [{"id": k, "label": v["label"], "description": v["description"], "default": v["default"],
                          "requires_level": v.get("requires_level", "STANDARD")} for k, v in CAPABILITIES.items()],
        "memory": {"default": True, "description": "Remember useful facts between tasks (you can view and delete "
                                                   "them)."},
        "extra_skills": extra,
        "levels": [{"id": lv, "description": LEVEL_INFO[lv]} for lv in LEVEL_CHOICES],
        "default_level": "STANDARD",
        "vault": {"options": [
            {"id": "none", "label": "No access", "default": True,
             "description": "The agent cannot sign in anywhere with your help and has no saved credentials."},
            {"id": "ask", "label": "Ask me when a sign-in is needed",
             "description": "Smart sign-in: the agent asks, you answer in a secure form, it never sees passwords."
                            + ("" if smart_auth.settings()["enabled"] else " (Smart sign-in is turned off on "
                                                                          "the Mac.)")}],
            "granted_note": "Using credentials saved in the Password Vault needs a grant you create on your Mac "
                            "(Agents → Security). Grants are never created from the Mini App."},
        "approvals": {"sensitive_actions_need_approval": bool(get_config().agents.require_approval_for_sensitive_actions),
                      "always": ["payments", "password / security / MFA changes", "account deletion",
                                 "data export", "messages to other people"],
                      "note": "Approvals are the same for every agent and cannot be weakened here."},
        "advanced": {"resource_modes": list(RESOURCE_MODES), "resolutions": sorted(agents_service.GEOMETRIES),
                     "default_resolution": "1280x800", "idle_sleep_minutes": {"min": 0, "max": 1440, "default": None},
                     "not_here": "Maximum steps, model calls and time-outs are set per task."},
        "avatar": {"kinds": ["emoji", "initials", "icon"], "icons": list(AVATAR_ICONS)},
        "name_rules": {"max": 64, "pattern": "letters, digits, spaces and . - _ ( )"},
        "existing_names": names,
        "default_instructions": DEFAULT_INSTRUCTIONS,
        "limits": {"instructions_max": MAX_INSTRUCTIONS, "description_max": 1000},
    }


async def models_for(provider_id: str, *, refresh: bool = False) -> list[dict[str, Any]]:
    row = provs.get_row(provider_id)
    if row.get("adapter_type") == "cli_mode":
        raise _err(422, "provider_unsupported", "this provider cannot run agents")
    if not _connected(row):
        raise _err(409, "provider_disconnected", f"{row['display_name']} is not connected; connect it on your Mac "
                                                 "(Settings → AI providers)")
    try:
        ms = await provs.list_models_cached(provider_id, refresh=refresh)
    except Exception as e:  # noqa: BLE001 - provider/network error: sanitized
        raise _err(502, "models_unavailable", f"could not load the models of {row['display_name']} "
                                              f"({type(e).__name__})") from None
    return [{"id": m.id, "name": m.display_name or m.id, "supports_tools": bool(m.supports_tools),
             "supports_images": bool(m.supports_images), "context_tokens": m.context_tokens} for m in ms]


# ============================================================================ validation
def _avatar(v: Any) -> dict[str, str] | None:
    if v in (None, {}, ""):
        return None
    if not isinstance(v, dict) or v.get("kind") not in ("emoji", "initials", "icon"):
        raise _err(422, "invalid_avatar", "avatar.kind must be emoji, initials or icon")
    val = str(v.get("value") or "").strip()
    if v["kind"] == "icon":
        if val not in AVATAR_ICONS:
            raise _err(422, "invalid_avatar", "unknown avatar icon")
    elif v["kind"] == "initials":
        if not _INITIALS.match(val):
            raise _err(422, "invalid_avatar", "initials: 1-2 letters or digits")
        val = val.upper()
    else:  # emoji: a short pictographic sequence, nothing else
        if not 1 <= len(val) <= 8 or any(unicodedata.category(ch)[0] in ("L", "N", "C", "Z") and ch not in
                                         ("‍", "️") for ch in val):
            raise _err(422, "invalid_avatar", "emoji avatar: one emoji")
    return {"kind": v["kind"], "value": val}


def _instructions(v: Any) -> str:
    s = str(v or "").replace("\r\n", "\n").strip()
    if len(s) > MAX_INSTRUCTIONS:
        raise _err(422, "instructions_too_long", f"instructions: at most {MAX_INSTRUCTIONS} characters")
    if any(unicodedata.category(ch) == "Cc" and ch not in "\n\t" for ch in s):
        raise _err(422, "invalid_instructions", "instructions contain control characters")
    return s


def _skills_from(caps: dict[str, Any] | None, extra: list[Any] | None, level: str) -> list[str]:
    caps = caps if isinstance(caps, dict) else {}
    unknown = set(caps) - set(CAPABILITIES) - {"memory"}
    if unknown:
        raise _err(422, "unsupported_capability", f"unsupported capabilities: {sorted(unknown)}")
    catalog = {s["id"]: s for s in skillsvc.list_skills()}
    chosen: list[str] = []
    for key, spec in CAPABILITIES.items():
        on = caps.get(key, spec["default"])
        if not isinstance(on, bool):
            raise _err(422, "invalid_capability", f"{key} must be true or false")
        if on:
            need = spec.get("requires_level", "STANDARD")
            if LEVELS.index(need) > LEVELS.index(level):
                raise _err(422, "capability_requires_level", f"{spec['label']} needs the {need} permission level",
                           capability=key, requires_level=need)
            chosen += spec["skills"]
    for sid in extra or []:
        if not isinstance(sid, str) or sid not in catalog or sid in CORE_SKILLS:
            raise _err(422, "unsupported_skill", "unknown or not selectable skill", skill=str(sid)[:64])
        s = catalog[sid]
        if not s["enabled"]:
            raise _err(422, "unsupported_skill", f"the skill {s['name']} is disabled", skill=sid)
        need = _skill_level(s)
        if LEVELS.index(need) > LEVELS.index(level):
            raise _err(422, "capability_requires_level", f"{s['name']} needs the {need} permission level",
                       capability=sid, requires_level=need)
        chosen.append(sid)
    return sorted(set(chosen))


async def _check_model(provider_id: str, model_id: str) -> dict[str, Any]:
    if not provider_id or not model_id:
        raise _err(422, "model_required", "choose an AI provider and a model")
    try:
        ms = await models_for(provider_id)
    except ApiError as e:
        if e.code == "provider_not_found":
            raise _err(422, "invalid_provider", "unknown AI provider") from None
        raise
    m = next((x for x in ms if x["id"] == model_id), None)
    if m is None:
        raise _err(422, "model_unavailable", f"{model_id[:80]} is not offered by this provider")
    if not m["supports_tools"]:
        raise _err(422, "model_without_tools", "this model cannot use tools, so it cannot work as an agent")
    return m


def _name(v: Any, *, allow_duplicate: bool, exclude_id: str | None = None) -> str:
    name = re.sub(r"\s+", " ", str(v or "")).strip()
    if not agents_service.NAME_RE.match(name):
        raise _err(422, "invalid_name", "name: 1-64 letters, digits, spaces, . - _ ( )")
    if not allow_duplicate:
        q = select(models.agents.c.id).where(func.lower(models.agents.c.name) == name.lower())
        if exclude_id:
            q = q.where(models.agents.c.id != exclude_id)
        with db.engine().connect() as c:
            if c.execute(q).first():
                raise _err(409, "duplicate_name", f"an agent named {name} already exists")
    return name


def _level(v: Any) -> str:
    level = v or "STANDARD"
    if level not in LEVEL_CHOICES:
        raise _err(422, "invalid_permission_level", "permission level: READ_ONLY, STANDARD or ADVANCED")
    return level


def _idle(v: Any) -> int | None:
    if v is None or v == "":
        return None
    if not isinstance(v, int) or isinstance(v, bool) or not 0 <= v <= 1440:
        raise _err(422, "invalid_idle_sleep", "idle sleep: 0-1440 minutes")
    return v


# ============================================================================ create
async def create(guest, body: dict[str, Any], actor: str) -> dict[str, Any]:
    if not isinstance(body, dict):
        raise _err(422, "invalid_body", "JSON object expected")
    allowed = {"name", "description", "avatar", "provider_id", "model_id", "instructions", "environment",
               "capabilities", "extra_skills", "vault_access", "permission_level", "resource_mode",
               "idle_sleep_minutes", "desktop_resolution", "allow_duplicate_name"}
    unknown = set(body) - allowed
    if unknown:  # e.g. linux_user, permissions, host roots, executable paths: never accepted
        raise _err(422, "unsupported_fields", f"fields not accepted: {sorted(unknown)}")
    if body.get("environment", "vm") != "vm":
        raise _err(422, "environment_local_only", "native macOS execution can only be enabled on the Mac "
                                                  "(Dashboard → agent → Environment)")
    name = _name(body.get("name"), allow_duplicate=body.get("allow_duplicate_name") is True)
    level = _level(body.get("permission_level"))
    caps = body.get("capabilities") if isinstance(body.get("capabilities"), dict) else {}
    skills_on = _skills_from(caps, body.get("extra_skills"), level)
    memory_on = caps.get("memory", True)
    if not isinstance(memory_on, bool):
        raise _err(422, "invalid_capability", "memory must be true or false")
    vault = body.get("vault_access", "none")
    if vault not in VAULT_OPTIONS:
        raise _err(422, "invalid_vault_access", "vault access: none or ask (grants are created on the Mac)")
    avatar = _avatar(body.get("avatar"))
    instructions = _instructions(body.get("instructions"))
    idle = _idle(body.get("idle_sleep_minutes"))
    mode = body.get("resource_mode") or "ACTIVE"
    if mode not in RESOURCE_MODES:
        raise _err(422, "invalid_resource_mode", "start the agent ACTIVE or SLEEP")
    desc = str(body.get("description") or "").strip()
    if len(desc) > 1000:
        raise _err(422, "description_too_long", "description: at most 1000 characters")
    model = await _check_model(str(body.get("provider_id") or ""), str(body.get("model_id") or ""))
    agent = await agents_service.create(guest, {
        "name": name, "description": desc, "permission_level": level, "resource_mode": "ACTIVE",
        "desktop_resolution": body.get("desktop_resolution") or "1280x800", "provider_id": body["provider_id"],
        "model_id": model["id"], "task_type": "general"}, actor)
    aid = agent["id"]
    skillsvc.assign(aid, skills_on, actor)
    cfg = {"memory_auto_save": memory_on, "sign_in_assistance": vault == "ask", "instructions": instructions,
           "created_via": "miniapp" if actor.startswith("miniapp:") else "dashboard"}
    if avatar:
        cfg["avatar"] = avatar
    if idle is not None:
        cfg["idle_sleep_minutes"] = idle
    _merge_config(aid, cfg)
    if mode == "SLEEP":
        await agents_service.sleep(guest, aid, actor)
    audit(actor, "agent.compose", aid, {"skills": skills_on, "level": level, "vault_access": vault,
                                        "memory": memory_on, "provider_id": body["provider_id"],
                                        "model_id": model["id"]})
    return settings(aid)


def _merge_config(agent_id: str, changes: dict[str, Any]) -> dict[str, Any]:
    with db.engine().begin() as c:
        row = c.execute(select(models.agents.c.config).where(models.agents.c.id == agent_id)).first()
        cfg = {**dict((row.config if row else None) or {}), **changes}
        cfg = {k: v for k, v in cfg.items() if v is not None}
        c.execute(update(models.agents).where(models.agents.c.id == agent_id).values(config=cfg, updated_at=db.now()))
    return cfg


# ============================================================================ settings view / edit
def settings(agent_id: str) -> dict[str, Any]:
    a = agents_service.get(agent_id)
    cfg = a.get("config") or {}
    assigned = skillsvc.skill_set(agent_id)
    caps = {k: all(s in assigned for s in v["skills"][:1]) for k, v in CAPABILITIES.items()}
    caps["memory"] = cfg.get("memory_auto_save", True) is not False
    from nebula_host import environments
    from nebula_host import vault as vaultmod

    grants = [{"id": g["id"], "entry_name": g["entry_name"], "origins": g["allowed_origins"],
               "policy": g["approval_policy"], "enabled": g["enabled"]} for g in vaultmod.VAULT.grants(agent_id)]
    return {"agent": agents_service.public(a), "name": a["name"], "description": a["description"],
            "avatar": cfg.get("avatar"), "provider_id": a["provider_id"], "model_id": a["model_id"],
            "instructions": cfg.get("instructions", ""), "permission_level": a["permission_level"],
            "capabilities": caps, "extra_skills": sorted(assigned - CORE_SKILLS),
            "vault_access": "ask" if cfg.get("sign_in_assistance", True) else "none",
            "vault": {"mode": vaultmod.VAULT.agent_policy(agent_id)["mode"], "grants": grants},
            "environment": environments.agent_execution(a), "status": a["status"],
            "resource_mode": a["resource_mode"], "idle_sleep_minutes": cfg.get("idle_sleep_minutes"),
            "desktop_resolution": a["desktop_resolution"],
            "ready": a["status"] in ("READY", "SLEEP", "IDLE", "ACTIVE")}


async def update_settings(agent_id: str, body: dict[str, Any], actor: str) -> dict[str, Any]:
    a = agents_service.get(agent_id)
    if a["status"] in ("CREATING", "DELETING"):
        raise _err(409, "agent_not_editable", "the agent is being created or deleted")
    allowed = {"name", "description", "avatar", "provider_id", "model_id", "instructions", "capabilities",
               "extra_skills", "vault_access", "permission_level", "idle_sleep_minutes", "allow_duplicate_name"}
    unknown = set(body) - allowed
    if unknown:
        raise _err(422, "unsupported_fields", f"fields not editable here: {sorted(unknown)}")
    patch: dict[str, Any] = {}
    cfg: dict[str, Any] = {}
    if "name" in body:
        patch["name"] = _name(body["name"], allow_duplicate=body.get("allow_duplicate_name") is True,
                              exclude_id=agent_id)
    if "description" in body:
        d = str(body.get("description") or "").strip()
        if len(d) > 1000:
            raise _err(422, "description_too_long", "description: at most 1000 characters")
        patch["description"] = d
    if "provider_id" in body or "model_id" in body:
        pid = str(body.get("provider_id") or a["provider_id"] or "")
        mid = str(body.get("model_id") or "")
        m = await _check_model(pid, mid)
        patch["provider_id"], patch["model_id"] = pid, m["id"]
    level = _level(body["permission_level"]) if "permission_level" in body else a["permission_level"]
    if "permission_level" in body:
        patch["permission_level"] = level
    skills_new = None
    if "capabilities" in body or "extra_skills" in body or "permission_level" in body:
        cur = settings(agent_id)
        caps = {**{k: v for k, v in cur["capabilities"].items() if k != "memory"},
                **{k: v for k, v in (body.get("capabilities") or {}).items() if k != "memory"}}
        extra = body["extra_skills"] if "extra_skills" in body else cur["extra_skills"]
        skills_new = _skills_from(caps, extra, level)
        mem = (body.get("capabilities") or {}).get("memory")
        if mem is not None:
            if not isinstance(mem, bool):
                raise _err(422, "invalid_capability", "memory must be true or false")
            cfg["memory_auto_save"] = mem
    if "avatar" in body:
        cfg["avatar"] = _avatar(body["avatar"])  # None = remove
    if "instructions" in body:
        cfg["instructions"] = _instructions(body["instructions"])
    if "vault_access" in body:
        if body["vault_access"] not in VAULT_OPTIONS:
            raise _err(422, "invalid_vault_access", "vault access: none or ask (grants are created on the Mac)")
        cfg["sign_in_assistance"] = body["vault_access"] == "ask"
    if "idle_sleep_minutes" in body:
        cfg["idle_sleep_minutes"] = _idle(body["idle_sleep_minutes"])
    # apply (all validation passed)
    if patch:
        agents_service.patch(agent_id, patch, actor)
    if skills_new is not None:
        skillsvc.assign(agent_id, skills_new, actor)
    if cfg:
        with db.engine().begin() as c:
            row = c.execute(select(models.agents.c.config).where(models.agents.c.id == agent_id)).first()
            merged = dict((row.config if row else None) or {})
            for k, v in cfg.items():
                if v is None or v == {}:  # cleared (avatar / idle sleep)
                    merged.pop(k, None)
                else:
                    merged[k] = v
            c.execute(update(models.agents).where(models.agents.c.id == agent_id)
                      .values(config=merged, updated_at=db.now()))
    audit(actor, "agent.settings", agent_id, {k: (v if k not in ("instructions", "description") else len(str(v)))
                                              for k, v in body.items()})
    bus.publish("agent.state.changed", {"to": a["status"], "updated": sorted(body)}, agent_id=agent_id)
    return settings(agent_id)
