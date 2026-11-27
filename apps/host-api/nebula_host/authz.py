"""One authorization model for the local dashboard and the Telegram Mini App (V3.3).

Every API route has exactly one policy here (a test enforces full coverage). The same policy is applied to every
caller; what differs is who the caller is and how recently they proved it:

Roles
  owner      the NEBULA admin: the local dashboard session, or a Mini App session of the main bot's designated owner
             (verified Telegram initData). Full administration — no weaker "mobile" role. The owner's Telegram
             account is stored explicitly (setting OWNER_SETTING); it is never derived from approval order, so
             revoking the owner's pairing never promotes anybody else.
  operator   another approved Telegram user of the main bot: exactly the operational permissions stored for them
             (by default tasks, commands, screenshot), never administration and never approvals.
  agent_bot  a Mini App session opened from an individual agent's bot: a small fixed permission set and a deny-by-
             default route allowlist (AGENT_BOT_ROUTES); every reachable resource must belong to that bot's agent.

Assurance (authentication strength, separate from authorization)
  session    a valid session (dashboard login, or initData verified on the server — fresh, single use).
  fresh      the owner verified themselves again within FRESH_WINDOW_S on THIS session (NEBULA login password, or a
             Face ID / fingerprint confirmation through Telegram's BiometricManager on an enrolled device). The local
             dashboard on this Mac counts as fresh (physical presence + login).
  vault      plaintext vault operations additionally need the vault passphrase re-confirmed on this session
             (enforced by the vault itself: reauth window).

Policies
  public     no session needed (dashboard login/setup screens; never forwarded by the Mini App gateway)
  local      only on this Mac (never through the gateway)
  read       any signed-in role
  op:<perm>  owner, or operator/agent_bot holding <perm>
  admin      owner
  admin!     owner + fresh
"""

from __future__ import annotations

import contextvars
import hashlib
import hmac
import re
import secrets
import time
from dataclasses import dataclass
from typing import Any

from sqlalchemy import and_, select, update

from nebula_host import db, models

FRESH_WINDOW_S = 300
CHALLENGE_TTL_S = 60
MAX_DEVICES = 5

# ---------------------------------------------------------------------------------------------- policy table
POLICY: dict[str, str] = {
    # agents
    "GET /agents": "read", "POST /agents": "admin", "DELETE /agents/{agent_id}": "admin!",
    "GET /agents/{agent_id}": "read", "PATCH /agents/{agent_id}": "admin",
    "GET /agents/{agent_id}/attachments": "read", "POST /agents/{agent_id}/attachments": "op:tasks",
    "PATCH /agents/{agent_id}/config": "admin", "GET /agents/{agent_id}/conversation": "read",
    "GET /agents/{agent_id}/environment": "read", "PUT /agents/{agent_id}/environment": "admin!",
    "POST /agents/{agent_id}/export": "admin!", "POST /agents/{agent_id}/live/connect": "op:desktop",
    "DELETE /agents/{agent_id}/memory": "admin!", "GET /agents/{agent_id}/memory": "read",
    "POST /agents/{agent_id}/memory": "admin", "GET /agents/{agent_id}/memory/stats": "read",
    "DELETE /agents/{agent_id}/memory/{memory_id}": "admin", "PATCH /agents/{agent_id}/memory/{memory_id}": "admin",
    "GET /agents/{agent_id}/messages": "read", "POST /agents/{agent_id}/pause": "op:commands",
    "POST /agents/{agent_id}/restart-desktop": "admin", "POST /agents/{agent_id}/resume": "op:commands",
    "GET /agents/{agent_id}/screenshot": "op:screenshot", "GET /agents/{agent_id}/skills": "read",
    "PUT /agents/{agent_id}/skills": "admin", "POST /agents/{agent_id}/sleep": "op:commands",
    "GET /agents/{agent_id}/tasks": "read", "POST /agents/{agent_id}/tasks": "op:tasks",
    "GET /agents/{agent_id}/vault": "read", "PUT /agents/{agent_id}/vault": "admin!",
    "POST /agents/{agent_id}/vault/grants": "admin!", "GET /agents/{agent_id}/voice": "read",
    "PUT /agents/{agent_id}/voice": "op:commands", "POST /agents/{agent_id}/wake": "op:commands",
    # approvals, artifacts, attachments (reading and resolving approvals is the owner's business (N9); vault/host/
    # system approvals additionally need a fresh owner to be resolved, checked by the route)
    "GET /approval-center": "admin", "GET /approvals": "admin", "POST /approvals/{approval_id}": "admin",
    "GET /owner-approvals": "admin", "POST /owner-approvals/{approval_id}": "admin",
    "GET /artifacts/{path}": "read", "GET /attachments-settings": "read", "PATCH /attachments-settings": "admin",
    "DELETE /attachments/{att_id}": "op:tasks", "GET /attachments/{att_id}": "read",
    "GET /attachments/{att_id}/content": "read", "GET /audit": "admin",
    # dashboard sign-in (the Mini App has its own initData sign-in)
    "POST /auth/login": "public", "POST /auth/logout": "local", "POST /auth/password": "admin!",
    "POST /auth/setup": "public", "GET /auth/state": "public",
    # V3.3 assurance / step-up / devices
    "GET /auth/assurance": "read", "POST /auth/stepup/challenge": "read", "POST /auth/stepup": "read",
    "GET /auth/devices": "read", "POST /auth/devices": "admin!", "DELETE /auth/devices/{device_id}": "admin",
    # bots
    "GET /bots": "admin", "POST /bots": "admin!", "DELETE /bots/{bot_id}": "admin!", "GET /bots/{bot_id}": "admin",
    "POST /bots/{bot_id}/configure": "admin!", "POST /bots/{bot_id}/enabled": "admin",
    "POST /bots/{bot_id}/pairing": "admin!", "POST /bots/{bot_id}/reconnect": "admin",
    "POST /bots/{bot_id}/users/{user_row_id}/{action}": "admin!",
    # companies / projects
    "GET /companies": "read", "POST /companies": "op:companies", "GET /companies/roles": "read",
    "DELETE /companies/{company_id}": "admin!", "GET /companies/{company_id}": "read",
    "PATCH /companies/{company_id}": "op:companies", "GET /companies/{company_id}/activity": "read",
    "GET /companies/{company_id}/knowledge": "read", "POST /companies/{company_id}/knowledge": "op:companies",
    "DELETE /companies/{company_id}/knowledge/{kid}": "admin",
    "PATCH /companies/{company_id}/knowledge/{kid}": "op:companies", "GET /companies/{company_id}/org": "read",
    "POST /companies/{company_id}/projects": "op:companies", "POST /company-items/{item_id}/retry": "op:companies",
    "GET /company-runs/{run_id}": "read", "POST /company-runs/{run_id}/{action}": "op:companies",
    "DELETE /projects/{project_id}": "admin!", "GET /projects/{project_id}": "read",
    "PATCH /projects/{project_id}": "op:companies", "GET /projects/{project_id}/git": "read",
    "GET /projects/{project_id}/runs": "read", "POST /projects/{project_id}/runs": "op:companies",
    # conversations
    "GET /conversations": "read", "POST /conversations": "op:tasks", "GET /conversations/search": "read",
    "GET /conversations/{cid}": "read", "PATCH /conversations/{cid}": "op:tasks",
    "GET /conversations/{cid}/messages": "read", "POST /conversations/{cid}/messages": "op:tasks",
    "POST /conversations/{cid}/read": "read",
    # environment, events, files
    "GET /environments": "read", "GET /events": "read",
    "DELETE /files": "admin!", "POST /files/copy": "op:files", "GET /files/download": "op:files",
    "GET /files/history": "op:files", "GET /files/list": "op:files", "POST /files/mkdir": "op:files",
    "POST /files/move": "op:files", "GET /files/preview": "op:files", "POST /files/rename": "op:files",
    "GET /files/roots": "op:files", "GET /files/search": "op:files", "GET /files/stat": "op:files",
    "PUT /files/text": "op:files", "POST /files/transfer": "op:files", "POST /files/upload": "op:files",
    "GET /files/usage": "op:files", "GET /files/versions": "op:files", "GET /health": "read",
    # host access (this Mac's own files)
    "GET /host/browse": "admin!", "GET /host/commands": "admin", "GET /host/roots": "read",
    "POST /host/roots": "admin!", "DELETE /host/roots/{root_id}": "admin!", "PATCH /host/roots/{root_id}": "admin!",
    "POST /host/roots/{root_id}/selftest": "admin", "GET /host/tools": "admin",
    # live desktop
    "GET /live/sessions": "op:desktop", "DELETE /live/sessions/{session_id}": "op:desktop",
    "POST /live/sessions/{session_id}/control": "op:desktop",
    # memory, mini app
    "GET /memory/semantic": "read", "POST /memory/semantic": "admin",
    "GET /miniapp/agent-options": "admin", "GET /miniapp/agent-options/models": "admin", "POST /miniapp/agents": "admin",
    "GET /miniapp/agents/{agent_id}/settings": "admin", "PATCH /miniapp/agents/{agent_id}/settings": "admin",
    "GET /miniapp/me": "read", "DELETE /miniapp/sessions": "admin!", "GET /miniapp/sessions": "admin",
    "DELETE /miniapp/sessions/{session_id}": "admin",
    "GET /monitor": "admin", "GET /notifications": "read", "GET /overview": "read", "GET /permissions/matrix": "read",
    # providers
    "GET /providers": "admin", "POST /providers/{pid}/connect": "admin!", "POST /providers/{pid}/disconnect": "admin!",
    "POST /providers/{pid}/limits": "admin", "GET /providers/{pid}/models": "admin", "POST /providers/{pid}/test": "admin",
    # remote access
    "GET /remote": "admin", "PATCH /remote": "admin!", "POST /remote/menu-buttons": "admin",
    "POST /remote/tunnel/start": "admin!", "POST /remote/tunnel/stop": "admin!",
    # resources, schedules, settings, setup
    "GET /resources": "read", "GET /resources/history": "read", "POST /resources/profile": "admin",
    "POST /resources/simulate": "admin",
    "GET /schedule-runs": "read", "GET /schedules": "read", "POST /schedules": "admin", "POST /schedules/preview": "read",
    "DELETE /schedules/{schedule_id}": "admin", "GET /schedules/{schedule_id}": "read",
    "PATCH /schedules/{schedule_id}": "admin", "POST /schedules/{schedule_id}/run": "op:tasks",
    "GET /settings": "admin", "PATCH /settings": "admin!",
    "POST /setup/install": "local", "GET /setup/jobs/{job_id}": "admin", "POST /setup/preflight": "local",
    # skills
    "GET /skills": "read", "GET /skills/compatibility": "read", "DELETE /skills/github/token": "admin!",
    "GET /skills/github/token": "admin", "POST /skills/github/token": "admin!", "POST /skills/plugins": "admin!",
    "DELETE /skills/plugins/{plugin_id}": "admin!", "GET /skills/usage": "read", "GET /skills/{skill_id}": "read",
    "POST /skills/{skill_id}/enabled": "admin",
    # smart sign-in
    "DELETE /smart-auth/pin": "admin!", "PUT /smart-auth/pin": "admin!", "GET /smart-auth/sessions": "read",
    "GET /smart-auth/sessions/{sid}": "read", "POST /smart-auth/sessions/{sid}/cancel": "admin",
    "POST /smart-auth/sessions/{sid}/submit": "admin", "POST /smart-auth/sessions/{sid}/token": "admin",
    "GET /smart-auth/settings": "admin", "PUT /smart-auth/settings": "admin!",
    "GET /smart-auth/trust": "read", "POST /smart-auth/trust/relationships": "admin!",
    "DELETE /smart-auth/trust/relationships": "admin!", "POST /smart-auth/trust/sites": "admin!",
    "DELETE /smart-auth/trust/sites": "admin!",
    # system / VM
    "GET /system": "admin", "POST /system/backup": "admin!", "GET /system/diagnostics": "admin",
    "GET /system/lan": "admin", "POST /system/lan": "admin!", "GET /system/lan/ca.crt": "local",
    "GET /system/logs": "admin", "POST /system/repair": "admin!", "POST /system/services/restart": "admin!",
    "POST /system/vm/start": "admin", "POST /system/vm/stop": "admin!",
    # tasks, teams
    "GET /tasks": "read", "GET /tasks/{task_id}": "read", "POST /tasks/{task_id}/pause": "op:commands",
    "POST /tasks/{task_id}/resume": "op:commands", "POST /tasks/{task_id}/retry": "op:commands",
    "POST /tasks/{task_id}/stop": "op:commands",
    "GET /team-runs": "read", "GET /team-runs/{run_id}": "read", "POST /team-runs/{run_id}/cancel": "op:tasks",
    "GET /teams": "read", "POST /teams": "admin", "DELETE /teams/{team_id}": "admin!", "GET /teams/{team_id}": "read",
    "PATCH /teams/{team_id}": "admin", "POST /teams/{team_id}/runs": "op:tasks",
    # telegram
    "DELETE /telegram": "admin!", "GET /telegram": "admin", "POST /telegram/pairing": "admin!",
    "POST /telegram/pairing/{pid}/approve": "admin!", "POST /telegram/test": "admin", "POST /telegram/token": "admin!",
    "POST /telegram/users/{uid}/revoke": "admin!", "PATCH /telegram/users/{user_row_id}/notify": "admin",
    "GET /v3/capabilities": "read",
    # V4.0 native apps: paired devices (the pairing offer and approvals need a fresh owner), unified confirmation
    "GET /devices": "admin", "POST /devices/pairing": "admin!", "GET /devices/pairing/{pairing_id}": "admin",
    "DELETE /devices/pairing/{pairing_id}": "admin", "POST /devices/{app_device_id}/approve": "admin!",
    "POST /devices/{app_device_id}/reject": "admin", "PATCH /devices/{app_device_id}": "admin",
    "DELETE /devices/{app_device_id}": "admin", "POST /auth/confirm/challenge": "read", "POST /auth/confirm": "read",
    "GET /app/me": "read", "PUT /app/push": "read",
    # password vault (plaintext operations also need the vault's own passphrase re-confirmation on this session)
    "POST /vault": "admin!", "GET /vault/audit": "read", "GET /vault/entries": "read", "POST /vault/entries": "admin!",
    "DELETE /vault/entries/{entry_id}": "admin!", "GET /vault/entries/{entry_id}": "admin!",
    "PATCH /vault/entries/{entry_id}": "admin!", "POST /vault/entries/{entry_id}/reveal": "admin!",
    "POST /vault/export": "admin!", "GET /vault/grants": "read", "DELETE /vault/grants/{grant_id}": "admin!",
    "PATCH /vault/grants/{grant_id}": "admin!", "POST /vault/grants/{grant_id}/revoke": "op:commands",
    "POST /vault/import": "admin!", "POST /vault/lock": "op:commands", "POST /vault/passphrase": "admin!",
    "POST /vault/reauth": "admin!", "PUT /vault/settings": "admin!", "GET /vault/status": "read",
    "POST /vault/unlock": "admin!",
    # voice
    "GET /voice/models": "read", "POST /voice/models/{name}/download": "admin", "GET /voice/status": "read",
    "GET /voice/stt": "read", "PATCH /voice/stt": "admin", "GET /voice/tts": "read", "PATCH /voice/tts": "admin",
    "POST /voice/tts/preview": "admin",
    # workflows
    "GET /workflow-runs": "read", "GET /workflow-runs/{run_id}": "read", "POST /workflow-runs/{run_id}/stop": "op:workflows",
    "GET /workflows": "read", "POST /workflows": "admin", "GET /workflows/catalog": "read", "POST /workflows/import": "admin",
    "POST /workflows/validate": "op:workflows", "DELETE /workflows/{workflow_id}": "admin!",
    "GET /workflows/{workflow_id}": "read", "PATCH /workflows/{workflow_id}": "op:workflows",
    "POST /workflows/{workflow_id}/duplicate": "admin", "GET /workflows/{workflow_id}/export": "admin",
    "POST /workflows/{workflow_id}/run": "op:workflows",
}


# stricter shapes for some path parameters (anything else: word characters, dots, dashes)
_PARAM = {"sid": r"as_[0-9a-f]{24}", "device_id": r"dev_[0-9a-f]{16}", "app_device_id": r"adv_[0-9a-f]{16}",
          "pairing_id": r"pr_[0-9a-f]{16}"}


def _compile(template: str) -> re.Pattern[str]:
    parts = []
    for seg in template.split("/")[1:]:
        if seg == "{path}":
            parts.append(r".+")
        elif seg.startswith("{") and seg.endswith("}"):
            parts.append(_PARAM.get(seg[1:-1], r"[\w.\-]+"))
        else:
            parts.append(re.escape(seg))
    return re.compile("^/" + "/".join(parts) + "$")


# most specific first: literal segments beat parameters (e.g. /files/roots before /files/{x})
_RULES: list[tuple[str, re.Pattern[str], str, str]] = sorted(
    [(k.split(" ", 1)[0], _compile(k.split(" ", 1)[1]), v, k) for k, v in POLICY.items()],
    key=lambda r: (r[3].count("{"), -len(r[3])))


def match(method: str, path: str) -> tuple[str, str] | None:
    """(policy, template) for an /api/v1-relative path, or None."""
    for m, rx, pol, tpl in _RULES:
        if m == method and rx.match(path):
            return pol, tpl
    return None


def gateway_forwardable(method: str, path: str) -> bool:
    hit = match(method, path)
    return hit is not None and hit[0] not in ("public", "local")


# ---------------------------------------------------------------------------------------------- caller context
@dataclass
class Ctx:
    interface: str  # local | miniapp
    role: str  # owner | operator | agent_bot
    permissions: frozenset[str]
    fresh_until: float | None
    session_id: str | None = None
    telegram_user_id: int | None = None
    bot: str | None = None  # Mini App opened from: "main" or an agent bot's row id
    device_id: str | None = None  # V4.0: the paired NEBULA app (interface "app")

    @property
    def fresh(self) -> bool:
        return self.interface == "local" or bool(self.fresh_until and self.fresh_until > time.time())

    @property
    def owner(self) -> bool:
        return self.role == "owner"


_ctx: contextvars.ContextVar[Ctx | None] = contextvars.ContextVar("nebula_authz", default=None)


def current() -> Ctx | None:
    return _ctx.get()


def set_current(ctx: Ctx | None) -> contextvars.Token:
    return _ctx.set(ctx)


def reset_current(token: contextvars.Token) -> None:
    _ctx.reset(token)


_owner_cache: dict[str, Any] = {"at": 0.0, "id": None, "engine": None}
OWNER_SETTING = "telegram.owner"  # {"telegram_user_id": int, "set_at": float, "set_by": str}


def forget_owner_cache() -> None:
    _owner_cache.update(at=0.0, id=None, engine=None)


def _approved_main_user(c, tg_id: int) -> bool:
    return c.execute(select(models.telegram_users.c.id).where(and_(
        models.telegram_users.c.telegram_user_id == tg_id,
        models.telegram_users.c.status == "approved"))).first() is not None


def designated_owner_telegram_id() -> int | None:
    """The Telegram account designated as the owner (whether or not it is currently approved)."""
    s = db.get_setting(OWNER_SETTING, None) or {}
    try:
        return int(s["telegram_user_id"]) if s.get("telegram_user_id") else None
    except (TypeError, ValueError):
        return None


def primary_owner_telegram_id() -> int | None:
    """The main bot's owner: the explicitly designated Telegram account, while it is still approved (cached 5 s per
    database, so a revoked pairing loses the owner role within seconds). Revoking it leaves NO Telegram owner: an
    operator is never promoted. Installs without a designation (first pairing, or an upgrade from a version that
    derived the owner from approval order) pin the earliest approved account once, which is the account that was
    already the owner, and audit it."""
    now = time.time()
    eng = id(db.engine())
    if now - _owner_cache["at"] < 5 and _owner_cache["engine"] == eng:
        return _owner_cache["id"]
    owner = designated_owner_telegram_id()
    pin = False
    with db.engine().connect() as c:
        if owner is None:
            r = c.execute(select(models.telegram_users.c.telegram_user_id)
                          .where(models.telegram_users.c.status == "approved")
                          .order_by(models.telegram_users.c.approved_at, models.telegram_users.c.created_at)).first()
            if r is not None:
                owner, pin = int(r.telegram_user_id), True
        elif not _approved_main_user(c, owner):
            owner = None  # the owner's pairing is revoked: nobody is the Telegram owner until the owner says so
    if pin:
        from nebula_host.events import audit

        db.set_setting(OWNER_SETTING, {"telegram_user_id": owner, "set_at": now, "set_by": "system:bootstrap"})
        audit("system", "telegram.owner.pinned", str(owner), {"reason": "no owner designated yet"})
    _owner_cache.update(at=now, id=owner, engine=eng)
    return owner


def set_owner_telegram_id(tg_id: int, *, actor: str) -> int:
    """Designate the owner's Telegram account (an approved user of the main bot). An owner-only, fresh action."""
    tg_id = int(tg_id)
    with db.engine().connect() as c:
        if tg_id <= 0 or not _approved_main_user(c, tg_id):
            raise Denied(404, "not_found", "no approved Telegram user of the main bot with this id")
    prev = designated_owner_telegram_id()
    db.set_setting(OWNER_SETTING, {"telegram_user_id": tg_id, "set_at": time.time(), "set_by": actor[:128]})
    forget_owner_cache()
    from nebula_host import miniapp
    from nebula_host.events import audit

    miniapp.forget_identity_cache()
    audit(actor, "telegram.owner.set", str(tg_id), {"previous": prev})
    return tg_id


def role_for(info: dict[str, Any]) -> str:
    if info.get("kind") == "app":
        return "owner"  # V4.0: a paired app is approved by the owner and only ever acts for the owner
    if info.get("bot") != "main":
        return "agent_bot"
    tg = int(info.get("telegram_user_id") or 0)
    return "owner" if tg and tg == primary_owner_telegram_id() else "operator"


def _stepup_row(session_id: str) -> dict[str, Any] | None:
    with db.engine().connect() as c:
        return db.row(c.execute(select(models.sessions.c.stepup_at, models.sessions.c.stepup_method)
                                .where(models.sessions.c.id == session_id)).first())


def context_for(principal, info: dict[str, Any] | None) -> Ctx:
    """Context for an authenticated principal (`info` = Mini App / app session info, None for the local dashboard).
    Only a dashboard session (no `via`) is the local owner: a remote session without valid session info (its
    identity was revoked, its bot disabled or removed, its device revoked) fails closed (NEW-1)."""
    if not getattr(principal, "via", None):
        return Ctx("local", "owner", frozenset(), None, getattr(principal, "session_id", None))
    if info is None:
        raise Denied(401, "unauthenticated", "this remote session is no longer valid; open the app again")
    row = _stepup_row(principal.session_id) or {}
    at = row.get("stepup_at")
    if info.get("kind") == "app":
        return Ctx("app", "owner", frozenset(info.get("permissions") or []), (at + FRESH_WINDOW_S) if at else None,
                   principal.session_id, None, "main", info.get("device_id"))
    return Ctx("miniapp", role_for(info), frozenset(info.get("permissions") or []),
               (at + FRESH_WINDOW_S) if at else None, principal.session_id, int(info.get("telegram_user_id") or 0),
               info.get("bot"))


# resource ownership: an agent's own bot may only reach that agent's resources
_SCOPED = (("agent", re.compile(r"^/agents/([\w-]+)(?:/|$)")), ("task", re.compile(r"^/tasks/([\w-]+)(?:/|$)")),
           ("conversation", re.compile(r"^/conversations/([\w-]+)(?:/|$)")),
           ("agent", re.compile(r"^/miniapp/agents/([\w-]+)(?:/|$)")),
           ("attachment", re.compile(r"^/attachments/([\w-]+)(?:/|$)")),
           ("agent", re.compile(r"^/artifacts/([\w-]+)/")))  # screenshots: <agent_id>/<task_id>/<n>.png

# Deny by default: the ONLY route templates an agent bot's Mini App session may reach (every method of a listed
# template is still subject to its own policy, so e.g. PATCH /agents/{agent_id} stays owner-only). Path-scoped
# templates are checked against the bot's agent below; the unscoped ones (marked *) filter by the bot's agent in the
# route itself (agent_scope()) or carry no agent data.
AGENT_BOT_ROUTES = frozenset({
    "/health", "/v3/capabilities", "/auth/assurance", "/miniapp/me", "/attachments-settings",  # * no agent data
    "/voice/status", "/voice/stt",  # *
    "/agents", "/tasks", "/conversations", "/events",  # * filtered to the bot's agent by the route
    "/agents/{agent_id}", "/agents/{agent_id}/attachments", "/agents/{agent_id}/conversation",
    "/agents/{agent_id}/environment", "/agents/{agent_id}/live/connect", "/agents/{agent_id}/messages",
    "/agents/{agent_id}/pause", "/agents/{agent_id}/resume", "/agents/{agent_id}/screenshot",
    "/agents/{agent_id}/skills", "/agents/{agent_id}/sleep", "/agents/{agent_id}/tasks", "/agents/{agent_id}/voice",
    "/agents/{agent_id}/wake",
    "/tasks/{task_id}", "/tasks/{task_id}/pause", "/tasks/{task_id}/resume", "/tasks/{task_id}/retry",
    "/tasks/{task_id}/stop",
    "/conversations/{cid}", "/conversations/{cid}/messages", "/conversations/{cid}/read",
    "/attachments/{att_id}", "/attachments/{att_id}/content", "/artifacts/{path}",
    "/live/sessions/{session_id}", "/live/sessions/{session_id}/control",  # * the route checks the viewer session
})
_AGENT_QUERY_KEYS = ("agent_id",)


def resource_agent(path: str) -> tuple[bool, str | None]:
    """(is agent-scoped, owning agent id) for an /api/v1-relative path."""
    for kind, rx in _SCOPED:
        m = rx.match(path)
        if not m or m.group(1) in ("search",):
            continue
        rid = m.group(1)
        if kind == "agent":
            return True, rid
        table = {"task": models.tasks, "conversation": models.conversations, "attachment": models.attachments}[kind]
        with db.engine().connect() as c:
            aid = c.execute(select(table.c.agent_id).where(table.c.id == rid)).scalar()
        return True, aid
    return False, None


def bot_agent_id(ctx: Ctx | None) -> str | None:
    """The agent an agent bot's session belongs to (None when the bot has no agent / is unknown)."""
    if ctx is None or not ctx.bot or ctx.bot == "main":
        return None
    with db.engine().connect() as c:
        return c.execute(select(models.telegram_bots.c.agent_id).where(models.telegram_bots.c.id == ctx.bot)).scalar()


def agent_scope(ctx: Ctx | None = None) -> str | None:
    """None: the caller is not limited to one agent. Otherwise the only agent id it may see ("" = none at all).
    Routes that list or stream data of several agents use this to filter for agent-bot sessions."""
    ctx = ctx if ctx is not None else current()
    if ctx is None or ctx.role != "agent_bot":
        return None
    return bot_agent_id(ctx) or ""


def _templates(path: str, method: str | None) -> list[str]:
    """Route templates (without method) matching an /api/v1-relative path; with a method, only that route."""
    if method:
        hit = match(method, path)
        return [hit[1].split(" ", 1)[1]] if hit else []
    return sorted({tpl.split(" ", 1)[1] for _m, rx, _pol, tpl in _RULES if rx.match(path)})


def check_ownership(ctx: Ctx, path: str, method: str | None = None,
                    query: dict[str, Any] | None = None) -> None:
    """Agent-bot sessions: deny by default (AGENT_BOT_ROUTES), then the resource named by the path (and by agent
    query parameters, when the caller passes them) must belong to the bot's agent. Without a method every template
    that matches the path must be allowlisted (e.g. /conversations/search also matches /conversations/{cid})."""
    if ctx.role != "agent_bot":
        return
    tpls = _templates(path, method)
    if not tpls or any(t not in AGENT_BOT_ROUTES for t in tpls):
        raise Denied(403, "not_available_to_agent_bot", "an agent's bot can only reach that agent's chat and tasks")
    mine = bot_agent_id(ctx)
    scoped, aid = resource_agent(path)
    if scoped and (not mine or aid != mine):
        raise Denied(403, "not_your_agent", "this bot can only reach its own agent")
    for k in _AGENT_QUERY_KEYS:
        v = (query or {}).get(k)
        if v and v != mine:
            raise Denied(403, "not_your_agent", "this bot can only reach its own agent")


def require_owner(message: str = "only the NEBULA owner can do this") -> None:
    """In-route check for remote callers (the local dashboard is the owner). No context means a local dashboard
    request: the middleware never lets a remote session reach a route without one (app._authz_gate)."""
    ctx = current()
    if ctx is not None and not ctx.owner:
        raise Denied(403, "owner_only", message)


class Denied(Exception):
    def __init__(self, status: int, code: str, message: str, **details: Any) -> None:
        super().__init__(message)
        self.status, self.code, self.message, self.details = status, code, message, details


def stepup_methods(ctx: Ctx) -> list[str]:
    m = ["password"]
    try:
        if ctx.telegram_user_id and devices(ctx.telegram_user_id):
            m.append("biometric")
        if ctx.interface == "app" and ctx.device_id:
            m.append("device")
        if ctx.owner and _vault_exists():
            m.append("vault_passphrase")
    except RuntimeError:  # database not initialised (CLI/unit context)
        pass
    return m


def _vault_exists() -> bool:
    from nebula_host import vault as vaultmod

    return vaultmod.VAULT.vault_id() is not None


def evaluate(ctx: Ctx, policy: str) -> None:
    """Raise Denied unless ctx may use a route with this policy."""
    if policy == "public":
        return
    if policy == "local":
        if ctx.interface != "local":
            raise Denied(403, "local_only", "this action is only available on the Mac itself")
        return
    if policy == "read":
        return
    if policy.startswith("op:"):
        perm = policy[3:]
        if ctx.owner or perm in ctx.permissions:
            return
        raise Denied(403, "forbidden", f"permission {perm} required")
    if policy in ("admin", "admin!"):
        if not ctx.owner:
            raise Denied(403, "owner_only", "only the NEBULA owner can do this")
        if policy == "admin!" and not ctx.fresh:
            raise Denied(403, "stepup_required", "confirm it's you to continue", level="fresh",
                         methods=stepup_methods(ctx))
        return
    raise Denied(403, "forbidden", "not allowed")


def require_fresh() -> None:
    """For checks inside a route (e.g. an option that changes vault permissions)."""
    ctx = current()
    if ctx is not None and not ctx.fresh:
        raise Denied(403, "stepup_required", "confirm it's you to continue", level="fresh",
                     methods=stepup_methods(ctx))


# ---------------------------------------------------------------------------------------------- step-up
_attempts: dict[str, list[float]] = {}
_challenges: dict[str, dict[str, Any]] = {}


MAX_LIMIT_KEYS = 4096


def _prune(table: dict[str, list[float]], max_age_s: float = 3600, cap: int = MAX_LIMIT_KEYS) -> None:
    """Keep in-memory rate-limit tables bounded (stale keys first, then the oldest)."""
    if len(table) < cap:
        return
    now = time.time()
    for k in [k for k, v in table.items() if not v or now - v[-1] > max_age_s]:
        table.pop(k, None)
    while len(table) >= cap:
        table.pop(next(iter(table)))


def _limit(key: str, n: int = 5, per_s: float = 600) -> None:
    now = time.time()
    _prune(_attempts)
    hits = [t for t in _attempts.get(key, []) if now - t < per_s]
    if len(hits) >= n:
        raise Denied(429, "rate_limited", "too many attempts — try again later",
                     retry_after=int(per_s - (now - hits[0])) + 1)
    hits.append(now)
    _attempts[key] = hits


def mark_fresh(session_id: str, method: str) -> float:
    now = time.time()
    with db.engine().begin() as c:
        c.execute(update(models.sessions).where(models.sessions.c.id == session_id)
                  .values(stepup_at=now, stepup_method=method[:16]))
    return now + FRESH_WINDOW_S


def stepup_password(ctx: Ctx, principal, password: str, *, actor: str) -> dict[str, Any]:
    from nebula_host import auth
    from nebula_host.events import audit

    _limit(f"stepup:{ctx.session_id}")
    _limit(f"stepup-user:{principal.user_id}", 10, 900)
    with db.engine().connect() as c:
        h = c.execute(select(models.users.c.password_hash).where(models.users.c.id == principal.user_id)).scalar()
    if not (isinstance(password, str) and 0 < len(password) <= 1024 and h and auth.verify_password(h, password)):
        audit(actor, "auth.stepup", None, {"method": "password", "outcome": "denied"})
        raise Denied(401, "wrong_password", "wrong password")
    until = mark_fresh(ctx.session_id or principal.session_id, "password")
    audit(actor, "auth.stepup", None, {"method": "password", "outcome": "ok"})
    return {"fresh_until": until}


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def devices(telegram_user_id: int) -> list[dict[str, Any]]:
    with db.engine().connect() as c:
        rows = db.rows(c.execute(select(models.miniapp_devices).where(and_(
            models.miniapp_devices.c.telegram_user_id == telegram_user_id,
            models.miniapp_devices.c.revoked_at.is_(None))).order_by(models.miniapp_devices.c.created_at)))
    return [{"id": r["id"], "name": r["name"], "created_at": r["created_at"], "last_used_at": r["last_used_at"]}
            for r in rows]


def enroll_device(ctx: Ctx, name: str, *, actor: str) -> dict[str, Any]:
    from nebula_host.events import audit

    if ctx.interface != "miniapp" or not ctx.telegram_user_id:
        raise Denied(400, "miniapp_only", "biometric confirmation is set up from the Telegram Mini App")
    if len(devices(ctx.telegram_user_id)) >= MAX_DEVICES:
        raise Denied(409, "too_many_devices", f"at most {MAX_DEVICES} devices; remove one first")
    token = secrets.token_urlsafe(32)
    did = "dev_" + secrets.token_hex(8)
    now = time.time()
    with db.engine().begin() as c:
        c.execute(models.miniapp_devices.insert().values(
            id=did, telegram_user_id=ctx.telegram_user_id, name=(name or "Phone").strip()[:60] or "Phone",
            token_hash=_hash(token), created_at=now, last_used_at=None, revoked_at=None))
    audit(actor, "auth.device.enrolled", did, {})
    return {"device_id": did, "token": token}


def remove_device(ctx: Ctx, device_id: str, *, actor: str) -> dict[str, Any]:
    from nebula_host.events import audit

    with db.engine().begin() as c:
        q = update(models.miniapp_devices).where(and_(models.miniapp_devices.c.id == device_id,
                                                      models.miniapp_devices.c.revoked_at.is_(None)))
        if ctx.interface == "miniapp":
            q = q.where(models.miniapp_devices.c.telegram_user_id == ctx.telegram_user_id)
        n = c.execute(q.values(revoked_at=time.time())).rowcount
    if not n:
        raise Denied(404, "not_found", "no such device")
    from nebula_host import vault as vaultmod

    vaultmod.VAULT.remove_device_key("telegram", device_id)
    audit(actor, "auth.device.removed", device_id, {})
    return {"removed": True}


def challenge(ctx: Ctx, device_id: str) -> dict[str, Any]:
    _limit(f"challenge:{ctx.session_id}", 20, 600)
    if not ctx.telegram_user_id or device_id not in {d["id"] for d in devices(ctx.telegram_user_id)}:
        raise Denied(404, "not_found", "no such device")
    now = time.time()
    for k in [k for k, v in _challenges.items() if v["exp"] < now]:
        _challenges.pop(k, None)
    cid = secrets.token_urlsafe(18)
    _challenges[cid] = {"session": ctx.session_id, "device": device_id, "exp": now + CHALLENGE_TTL_S}
    return {"challenge_id": cid, "expires_at": now + CHALLENGE_TTL_S}


def verify_biometric(ctx: Ctx, device_id: str, challenge_id: str, token: str, *, actor: str) -> str:
    """Check the enrolled device's token (released by Telegram only after Face ID / fingerprint) against a single-use
    challenge of THIS session and rotate it. Returns the next token. Only SHA-256 hashes are stored."""
    from nebula_host.events import audit

    _limit(f"stepup:{ctx.session_id}")
    ch = _challenges.pop(str(challenge_id or ""), None)
    if not ch or ch["exp"] < time.time() or ch["session"] != ctx.session_id or ch["device"] != device_id:
        raise Denied(401, "challenge_expired", "the confirmation expired; try again")
    with db.engine().connect() as c:
        r = db.row(c.execute(select(models.miniapp_devices).where(and_(
            models.miniapp_devices.c.id == device_id, models.miniapp_devices.c.revoked_at.is_(None),
            models.miniapp_devices.c.telegram_user_id == (ctx.telegram_user_id or -1)))).first())
    if not r or not isinstance(token, str) or not 20 <= len(token) <= 200 or \
            not hmac.compare_digest(r["token_hash"], _hash(token)):
        audit(actor, "auth.stepup", device_id, {"method": "biometric", "outcome": "denied"})
        raise Denied(401, "bad_token", "this device's confirmation is not valid; set it up again")
    nxt = secrets.token_urlsafe(32)
    with db.engine().begin() as c:
        c.execute(update(models.miniapp_devices).where(models.miniapp_devices.c.id == device_id)
                  .values(token_hash=_hash(nxt), last_used_at=time.time()))
    audit(actor, "auth.stepup", device_id, {"method": "biometric", "outcome": "ok"})
    return nxt


def stepup_biometric(ctx: Ctx, device_id: str, challenge_id: str, token: str, *, actor: str) -> dict[str, Any]:
    """V3.3 step-up with the Telegram biometric token (kept for compatibility; V4.0 clients use /auth/confirm). The
    token rotates, so a vault key wrapped for this device follows the rotation."""
    from nebula_host import vault as vaultmod

    nxt = verify_biometric(ctx, device_id, challenge_id, token, actor=actor)
    vaultmod.VAULT.rotate_device_key("telegram", device_id, token.encode(), nxt.encode(), actor=actor)
    until = mark_fresh(ctx.session_id or "", "biometric")
    return {"fresh_until": until, "next_token": nxt}


def assurance(ctx: Ctx) -> dict[str, Any]:
    from nebula_host import vault as vaultmod

    tg = devices(ctx.telegram_user_id) if ctx.telegram_user_id else []
    V = vaultmod.VAULT
    for d in tg:
        d["vault_key"] = V.has_device_key("telegram", d["id"])
    return {"interface": ctx.interface, "role": ctx.role, "admin": ctx.owner,
            "fresh_until": None if ctx.interface == "local" else ctx.fresh_until, "fresh": ctx.fresh,
            "window_s": FRESH_WINDOW_S,
            "methods": {"password": True,
                        "biometric": {"enrolled": bool(tg), "devices": tg},
                        # V4.0 unified owner confirmation
                        "vault_passphrase": bool(ctx.owner and _vault_exists()),
                        "device": ({"device_id": ctx.device_id,
                                    "vault_key": V.has_device_key("app", ctx.device_id)}
                                   if ctx.interface == "app" and ctx.device_id else None)},
            "vault": {"exists": _vault_exists(), "locked": V.locked,
                      "reauth_until": V.reauth_until(ctx.session_id) if ctx.session_id else None}}
