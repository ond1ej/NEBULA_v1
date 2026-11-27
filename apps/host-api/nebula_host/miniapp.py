"""Telegram Mini App authentication (V3 module 1).

The Mini App sends Telegram.WebApp.initData; the server verifies it exactly as documented by Telegram:
  secret_key = HMAC_SHA256(key="WebAppData", msg=<bot token>)
  hash       = hex(HMAC_SHA256(key=secret_key, msg=data_check_string))
  data_check_string = all received fields except `hash`, sorted by key, "key=value" joined with "\n".
The client-supplied Telegram user id is never trusted on its own. initData must be fresh (auth_date) and can be
exchanged only once (replay table). The verified Telegram identity must be a paired + approved owner of the bot that
launched the Mini App (main bot or that agent's bot); it is mapped to the NEBULA admin account and receives a
short-lived, revocable session scoped to the Mini App gateway (user_agent marks it, permissions limit it).
"""

from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import time
from typing import Any
from urllib.parse import parse_qsl

from sqlalchemy import and_, delete, select, update

from nebula_host import auth, db, models
from nebula_host import secrets as sec
from nebula_host.events import audit

MAX_AGE_S = 600  # initData older than 10 minutes is refused
SESSION_TTL_S = 3600
UA_PREFIX = "nebula-miniapp"
# The owner's operational permission set (the owner passes every op: policy anyway; the list drives the UI and the
# Live Desktop WebSocket check). Other identities never receive it implicitly:
DEFAULT_PERMISSIONS = ["tasks", "commands", "screenshot", "desktop", "files", "companies", "workflows", "approvals"]
# operators: exactly what is stored for them (pairing approval stores tasks/commands/screenshot), from this set only
OPERATOR_PERMISSIONS = frozenset({"tasks", "commands", "screenshot", "desktop", "files", "companies", "workflows"})
# users of an agent's own bot: chat with that one agent and control its tasks; nothing else
AGENT_BOT_PERMISSIONS = ["commands", "screenshot", "tasks"]
IDENTITY_CACHE_S = 3.0


class MiniAuthError(Exception):
    def __init__(self, code: str, message: str, status: int = 401) -> None:
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


def check_signature(init_data: str, bot_token: str) -> dict[str, str] | None:
    pairs = parse_qsl(init_data or "", keep_blank_values=True, strict_parsing=False)
    fields = dict(pairs)
    if len(fields) != len(pairs):
        return None  # duplicated keys are never produced by Telegram
    got = fields.pop("hash", None)
    if not got:
        return None
    dcs = "\n".join(f"{k}={v}" for k, v in sorted(fields.items()))
    secret_key = hmac.new(b"WebAppData", bot_token.encode(), hashlib.sha256).digest()
    want = hmac.new(secret_key, dcs.encode(), hashlib.sha256).hexdigest()
    return fields if hmac.compare_digest(want, got) else None


def _bot_tokens() -> list[tuple[str, str]]:
    out = []
    main = sec.store().get("nebula:telegram.bot_token")
    if main:
        out.append(("main", main))
    with db.engine().connect() as c:
        rows = db.rows(c.execute(select(models.telegram_bots.c.id, models.telegram_bots.c.keychain_ref).where(
            models.telegram_bots.c.enabled.is_(True))))
    for r in rows:
        t = sec.store().get(r["keychain_ref"])
        if t:
            out.append((r["id"], t))
    return out


def verify(init_data: str, *, now: float | None = None, max_age: int = MAX_AGE_S) -> dict[str, Any]:
    if not init_data or len(init_data) > 8192:
        raise MiniAuthError("invalid_init_data", "missing or oversized initData", 400)
    fields, bot_key = None, None
    for key, token in _bot_tokens():
        fields = check_signature(init_data, token)
        if fields is not None:
            bot_key = key
            break
    if fields is None:
        raise MiniAuthError("bad_signature", "initData signature is invalid")
    now = now or time.time()
    try:
        auth_date = int(fields.get("auth_date", "0"))
    except ValueError:
        auth_date = 0
    if auth_date <= 0 or now - auth_date > max_age:
        raise MiniAuthError("expired", "initData is too old; reopen the Mini App")
    if auth_date - now > 60:
        raise MiniAuthError("clock_skew", "initData is from the future")
    try:
        user = json.loads(fields.get("user") or "{}")
    except ValueError:
        user = {}
    if not isinstance(user, dict) or not isinstance(user.get("id"), int):
        raise MiniAuthError("no_user", "initData carries no Telegram user")
    return {"user": user, "auth_date": auth_date, "bot_key": bot_key, "query_id": fields.get("query_id"),
            "start_param": fields.get("start_param"), "chat_type": fields.get("chat_type"),
            "hash": hashlib.sha256(init_data.encode()).hexdigest()}


def _identity(tg_user_id: int, bot_key: str) -> dict[str, Any] | None:
    """The NEBULA account and permissions of an approved Telegram identity for this bot (None: not approved). Only
    the designated owner on the main bot gets the owner set; operators get exactly their stored permissions and
    agent-bot users the fixed AGENT_BOT_PERMISSIONS (H-01: nothing is widened implicitly)."""
    from nebula_host import authz

    with db.engine().connect() as c:
        if bot_key == "main":
            r = c.execute(select(models.telegram_users.c.permissions).where(and_(
                models.telegram_users.c.telegram_user_id == tg_user_id,
                models.telegram_users.c.status == "approved"))).first()
        else:
            r = c.execute(select(models.telegram_bot_users.c.id).select_from(models.telegram_bot_users.join(
                models.telegram_bots, models.telegram_bots.c.id == models.telegram_bot_users.c.bot_row_id)).where(and_(
                    models.telegram_bot_users.c.bot_row_id == bot_key,
                    models.telegram_bot_users.c.telegram_user_id == tg_user_id,
                    models.telegram_bot_users.c.status == "approved",
                    models.telegram_bots.c.enabled.is_(True)))).first()
        admin = c.execute(select(models.users.c.id, models.users.c.username).where(models.users.c.role == "admin")
                          .order_by(models.users.c.created_at)).first()
    if r is None or admin is None:
        return None
    owner = tg_user_id == authz.primary_owner_telegram_id()
    if bot_key == "main":
        if owner:
            perms = [*DEFAULT_PERMISSIONS, "agents"]  # V3.2.2: create/configure agents — only the main bot's owner
        else:
            perms = [p for p in (getattr(r, "permissions", None) or []) if p in OPERATOR_PERMISSIONS]
    else:
        perms = [*AGENT_BOT_PERMISSIONS, *(["desktop"] if owner else [])]  # the owner may watch their own agent
    return {"user_id": admin.id, "username": admin.username, "permissions": sorted(set(perms))}


_ident_cache: dict[tuple, tuple[float, dict[str, Any] | None]] = {}


def forget_identity_cache() -> None:
    _ident_cache.clear()


def current_identity(tg_user_id: int, bot_key: str) -> dict[str, Any] | None:
    """_identity, re-checked at most every IDENTITY_CACHE_S per (database, user, bot): a revoked or disabled
    identity loses every open session within seconds (M-01), and permission changes apply to open sessions."""
    key = (id(db.engine()), int(tg_user_id), str(bot_key))
    now = time.time()
    hit = _ident_cache.get(key)
    if hit and now - hit[0] < IDENTITY_CACHE_S:
        return hit[1]
    if len(_ident_cache) > 2048:
        _ident_cache.clear()
    ident = _identity(int(tg_user_id), str(bot_key))
    _ident_cache[key] = (now, ident)
    return ident


def end_sessions_for(tg_user_id: int, bot_key: str | None, actor: str) -> int:
    """Delete every Mini App session of a Telegram user (for one bot, or all bots when bot_key is None)."""
    pat = f"{UA_PREFIX} tg={int(tg_user_id)} " + (f"bot={bot_key} %" if bot_key else "%")
    with db.engine().begin() as c:
        n = c.execute(delete(models.sessions).where(models.sessions.c.user_agent.like(pat))).rowcount
    forget_identity_cache()
    audit(actor, "miniapp.session.revoke", f"tg:{int(tg_user_id)}", {"bot": bot_key or "*", "count": n})
    return n


def end_bot_sessions(bot_key: str, actor: str) -> int:
    """Delete every Mini App session opened from one bot (all of its users), e.g. when the bot is disabled or
    removed, and forget cached identities so no request can still use the old answer (NEW-1). The bot is compared
    exactly (parsed from the session label), never as a LIKE pattern."""
    bot_key = str(bot_key or "")
    if not bot_key:
        return 0
    with db.engine().begin() as c:
        rows = c.execute(select(models.sessions.c.id, models.sessions.c.user_agent)
                         .where(models.sessions.c.user_agent.like(f"{UA_PREFIX} %"))).all()
        ids = [r.id for r in rows
               if dict(x.split("=", 1) for x in (r.user_agent or "").split()[1:] if "=" in x).get("bot") == bot_key]
        n = c.execute(delete(models.sessions).where(models.sessions.c.id.in_(ids))).rowcount if ids else 0
    forget_identity_cache()
    audit(actor, "miniapp.session.revoke", f"bot:{bot_key}", {"bot": bot_key, "count": n})
    return n


def exchange(init_data: str, *, client: str = "") -> dict[str, Any]:
    v = verify(init_data)
    ident = _identity(v["user"]["id"], v["bot_key"])
    if ident is None:
        audit(f"miniapp:{v['user']['id']}", "miniapp.auth.denied", v["bot_key"], {"reason": "not paired"})
        raise MiniAuthError("not_paired", "this Telegram account is not a paired NEBULA owner", 403)
    now = time.time()
    with db.engine().begin() as c:
        c.execute(delete(models.miniapp_auth).where(models.miniapp_auth.c.expires_at < now))
        if c.execute(select(models.miniapp_auth.c.hash).where(models.miniapp_auth.c.hash == v["hash"])).first():
            raise MiniAuthError("replayed", "this initData was already used; reopen the Mini App")
        token = secrets.token_urlsafe(32)
        csrf = secrets.token_urlsafe(24)
        sid = db.new_id()
        ua = f"{UA_PREFIX} tg={v['user']['id']} bot={v['bot_key']} perms={','.join(ident['permissions'])}"
        c.execute(models.sessions.insert().values(id=sid, user_id=ident["user_id"], token_hash=auth.sha256(token),
                                                  csrf_token=csrf, created_at=now, expires_at=now + SESSION_TTL_S,
                                                  last_seen_at=now, user_agent=ua[:256]))
        c.execute(models.miniapp_auth.insert().values(hash=v["hash"], telegram_user_id=v["user"]["id"],
                                                      bot_key=v["bot_key"], session_id=sid, used_at=now,
                                                      expires_at=now + MAX_AGE_S + 120))
    audit(f"miniapp:{v['user']['id']}", "miniapp.auth", v["bot_key"], {"session_id": sid, "client": client[:80]})
    return {"token": token, "csrf_token": csrf, "session_id": sid, "expires_at": now + SESSION_TTL_S,
            "telegram_user": {k: v["user"].get(k) for k in ("id", "first_name", "last_name", "username",
                                                              "language_code", "photo_url")},
            "bot": v["bot_key"], "permissions": ident["permissions"], "start_param": v.get("start_param")}


def session_info(p: auth.Principal) -> dict[str, Any] | None:
    """Remote session info: a Telegram Mini App session, or (V4.0) a paired native NEBULA app session — both are
    accepted only through the gateway and authorised by the same central policy."""
    with db.engine().connect() as c:
        ua = c.execute(select(models.sessions.c.user_agent).where(models.sessions.c.id == p.session_id)).scalar()
    if ua and ua.startswith("nebula-app "):
        from nebula_host import devices

        return devices.session_info_from_ua(ua)
    if not ua or not ua.startswith(UA_PREFIX):
        return None
    parts = dict(x.split("=", 1) for x in ua.split()[1:] if "=" in x)
    try:
        tg = int(parts.get("tg", "0") or 0)
    except ValueError:
        return None
    bot = parts.get("bot") or ""
    # M-01: the Telegram identity must STILL be approved for this bot (and the bot enabled); the permissions are the
    # current ones, never the list frozen into the session at sign-in
    ident = current_identity(tg, bot) if tg > 0 and bot else None
    if ident is None:
        return None
    return {"telegram_user_id": tg, "bot": bot, "permissions": list(ident["permissions"])}


def list_sessions() -> list[dict[str, Any]]:
    with db.engine().connect() as c:
        rows = db.rows(c.execute(select(models.sessions.c.id, models.sessions.c.created_at,
                                        models.sessions.c.expires_at, models.sessions.c.last_seen_at,
                                        models.sessions.c.user_agent).where(
            models.sessions.c.user_agent.like(f"{UA_PREFIX}%")).order_by(models.sessions.c.created_at.desc())))
    now = time.time()
    for r in rows:
        r["active"] = r["expires_at"] > now
        parts = dict(x.split("=", 1) for x in (r.pop("user_agent") or "").split()[1:] if "=" in x)
        r["telegram_user_id"] = parts.get("tg")
        r["bot"] = parts.get("bot")
    return rows


def revoke(session_id: str | None, actor: str) -> int:
    with db.engine().begin() as c:
        q = delete(models.sessions).where(models.sessions.c.user_agent.like(f"{UA_PREFIX}%"))
        if session_id:
            q = q.where(models.sessions.c.id == session_id)
        n = c.execute(q).rowcount
    audit(actor, "miniapp.session.revoke", session_id or "*", {"count": n})
    return n


MAX_LIFETIME_S = 12 * 3600


def touch(session_id: str) -> None:
    """Slide the 1-hour expiry while the Mini App is used, never beyond 12 h after sign-in."""
    now = time.time()
    with db.engine().begin() as c:
        r = c.execute(select(models.sessions.c.created_at, models.sessions.c.expires_at)
                      .where(models.sessions.c.id == session_id)).first()
        if r is None or r.expires_at - now > SESSION_TTL_S - 300:
            return  # extended recently enough
        c.execute(update(models.sessions).where(models.sessions.c.id == session_id)
                  .values(expires_at=min(now + SESSION_TTL_S, r.created_at + MAX_LIFETIME_S)))


def extend(session_id: str) -> None:
    with db.engine().begin() as c:
        c.execute(update(models.sessions).where(models.sessions.c.id == session_id)
                  .values(expires_at=time.time() + SESSION_TTL_S))
