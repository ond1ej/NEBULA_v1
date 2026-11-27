"""Local admin authentication: Argon2id, cookie sessions (hashed), CSRF, Origin/Host checks, login rate limit."""

from __future__ import annotations

import hashlib
import hmac
import os
import secrets
import time
from dataclasses import dataclass
from pathlib import Path

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerifyMismatchError
from fastapi import Depends, Request, WebSocket
from sqlalchemy import delete, func, select, update

from nebula_host import db, models
from nebula_host.config import get_config
from nebula_host.errors import ApiError

COOKIE = "nebula_session"
CSRF_HEADER = "x-csrf-token"
_ph = PasswordHasher()  # Argon2id defaults (time_cost=3, memory_cost=64MiB, parallelism=4)
_ip_attempts: dict[str, list[float]] = {}


def sha256(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


def hash_password(pw: str) -> str:
    return _ph.hash(pw)


def verify_password(hash_: str, pw: str) -> bool:
    try:
        return _ph.verify(hash_, pw)
    except (VerifyMismatchError, InvalidHashError):
        return False


def validate_password_strength(pw: str) -> None:
    if len(pw) < 10:
        raise ApiError(422, "weak_password", "password must be at least 10 characters")
    if pw.lower() in {"admin", "password", "adminadmin", "nebulanebula", "1234567890"}:
        raise ApiError(422, "weak_password", "password is too common")


def user_count() -> int:
    with db.engine().connect() as c:
        return c.execute(select(func.count()).select_from(models.users)).scalar_one()


# ---------------------------------------------------------------- first-run setup token
def setup_token_path() -> Path:
    return get_config().run_dir / "setup-token"


def ensure_setup_token() -> str | None:
    """Created only while no admin exists; 0600 file read by `nebula install` to open the wizard."""
    if user_count() > 0:
        try:
            setup_token_path().unlink()
        except FileNotFoundError:
            pass
        return None
    p = setup_token_path()
    if p.exists():
        return p.read_text().strip()
    p.parent.mkdir(parents=True, exist_ok=True)
    tok = secrets.token_urlsafe(24)
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        fh.write(tok)
    return tok


def create_admin(username: str, password: str, setup_token: str) -> dict:
    if user_count() > 0:
        raise ApiError(409, "already_initialized", "an administrator already exists")
    expected = ensure_setup_token()
    if not expected or not hmac.compare_digest(expected, setup_token or ""):
        raise ApiError(403, "invalid_setup_token", "setup token is missing or wrong (see `nebula install` output)")
    if not username or len(username) > 64 or not username.replace("_", "").replace("-", "").isalnum():
        raise ApiError(422, "invalid_username", "username must be alphanumeric (- and _ allowed)")
    validate_password_strength(password)
    uid = db.new_id()
    with db.engine().begin() as c:
        c.execute(models.users.insert().values(id=uid, username=username, password_hash=hash_password(password),
                                               role="admin", created_at=db.now(), failed_attempts=0))
    ensure_setup_token()  # removes the token file now that an admin exists
    return {"id": uid, "username": username}


# ---------------------------------------------------------------- login / sessions
def _ip_limited(ip: str) -> bool:
    now = time.time()
    window = [t for t in _ip_attempts.get(ip, []) if now - t < 60]
    _ip_attempts[ip] = window
    return len(window) >= 20


_dummy: dict[str, str] = {}
_unknown_fails: dict[str, dict[str, float]] = {}  # unknown usernames get the same lockout as real accounts (L-05)


def _dummy_hash() -> str:
    """One Argon2 hash computed once: an unknown username costs exactly one verify, like a real account."""
    if "h" not in _dummy:
        _dummy["h"] = _ph.hash(secrets.token_urlsafe(18))
    return _dummy["h"]


def _locked(retry_after: float) -> ApiError:
    return ApiError(429, "account_locked", "too many failed attempts; try again later",
                    details={"retry_after_s": max(1, int(retry_after))})


def login(username: str, password: str, ip: str, user_agent: str | None) -> tuple[str, dict]:
    """Unknown and known usernames are indistinguishable (one Argon2 verify each, the same errors and the same
    lockout). The persisted per-account lockout is not applied to clients on this Mac itself, so a LAN client can
    never lock the owner out of the local dashboard (L-05)."""
    cfg = get_config()
    if _ip_limited(ip):
        raise ApiError(429, "rate_limited", "too many failed login attempts; wait a minute")
    with db.engine().connect() as c:
        u = c.execute(select(models.users).where(models.users.c.username == username)).first()
    now = time.time()
    local = ip in ("127.0.0.1", "::1")
    if u is None:
        key = (username or "")[:64].lower()
        st = _unknown_fails.get(key) or {}
        if st.get("locked_until", 0) > now and not local:
            verify_password(_dummy_hash(), password)
            raise _locked(st["locked_until"] - now)
        verify_password(_dummy_hash(), password)  # equalize timing
        _ip_attempts.setdefault(ip, []).append(now)
        if len(_unknown_fails) > 4096:
            _unknown_fails.clear()
        fails = int(st.get("fails", 0)) + 1
        locked = now + cfg.security.login_lockout_seconds if fails >= cfg.security.login_max_attempts else None
        _unknown_fails[key] = {"fails": 0 if locked else fails, "locked_until": locked or 0}
        raise ApiError(401, "invalid_credentials", "invalid username or password")
    if u.locked_until and u.locked_until > now and not local:
        verify_password(_dummy_hash(), password)  # same work as an unlocked attempt
        raise _locked(u.locked_until - now)
    if not verify_password(u.password_hash, password):
        _ip_attempts.setdefault(ip, []).append(time.time())
        attempts = (u.failed_attempts or 0) + 1
        locked = time.time() + cfg.security.login_lockout_seconds if attempts >= cfg.security.login_max_attempts else None
        with db.engine().begin() as c:  # commit BEFORE raising so the counter/lock persists
            c.execute(update(models.users).where(models.users.c.id == u.id)
                      .values(failed_attempts=0 if locked else attempts, locked_until=locked))
        raise ApiError(401, "invalid_credentials", "invalid username or password")
    with db.engine().begin() as c:
        token = secrets.token_urlsafe(32)
        csrf = secrets.token_urlsafe(24)
        sid = db.new_id()
        now = time.time()
        c.execute(models.sessions.insert().values(
            id=sid, user_id=u.id, token_hash=sha256(token), csrf_token=csrf, created_at=now,
            expires_at=now + cfg.security.session_ttl_hours * 3600, last_seen_at=now, user_agent=(user_agent or "")[:256]))
        c.execute(update(models.users).where(models.users.c.id == u.id)
                  .values(failed_attempts=0, locked_until=None, last_login_at=now))
        if u.password_hash and _ph.check_needs_rehash(u.password_hash):
            pass
    return token, {"session_id": sid, "csrf_token": csrf, "user": {"id": u.id, "username": u.username}}


def logout(session_id: str) -> None:
    with db.engine().begin() as c:
        c.execute(delete(models.sessions).where(models.sessions.c.id == session_id))


def change_password(user_id: str, current: str, new: str) -> None:
    validate_password_strength(new)
    with db.engine().begin() as c:
        u = c.execute(select(models.users).where(models.users.c.id == user_id)).first()
        if not u or not verify_password(u.password_hash, current):
            raise ApiError(403, "invalid_credentials", "current password is wrong")
        c.execute(update(models.users).where(models.users.c.id == user_id).values(password_hash=hash_password(new)))
        c.execute(delete(models.sessions).where(models.sessions.c.user_id == user_id))


def reset_password_local(username: str, new: str) -> None:
    """Recovery path: only callable from the local CLI by the macOS user who owns the data dir."""
    validate_password_strength(new)
    with db.engine().begin() as c:
        r = c.execute(update(models.users).where(models.users.c.username == username)
                      .values(password_hash=hash_password(new), failed_attempts=0, locked_until=None))
        if r.rowcount == 0:
            raise ApiError(404, "not_found", "no such user")
        c.execute(delete(models.sessions))


@dataclass
class Principal:
    session_id: str
    user_id: str
    username: str
    csrf_token: str
    via: str | None = None  # "miniapp:<telegram user id>" (Mini App, V3) or "app:<device id>" (native app, V4.0)

    @property
    def actor(self) -> str:
        return self.via if self.via else f"user:{self.username}"


def _session_from_token(token: str | None) -> Principal | None:
    if not token:
        return None
    now = time.time()
    with db.engine().begin() as c:
        r = c.execute(select(models.sessions, models.users.c.username)
                      .join(models.users, models.users.c.id == models.sessions.c.user_id)
                      .where(models.sessions.c.token_hash == sha256(token))).first()
        if r is None or r.expires_at < now:
            return None
        if now - r.last_seen_at > 60:
            c.execute(update(models.sessions).where(models.sessions.c.id == r.id).values(last_seen_at=now))
    via = None
    if (r.user_agent or "").startswith("nebula-miniapp "):
        tg = next((x[3:] for x in r.user_agent.split() if x.startswith("tg=")), "?")
        via = f"miniapp:{tg}"
    elif (r.user_agent or "").startswith("nebula-app "):  # V4.0: a paired native NEBULA app (gateway only)
        dev = next((x[4:] for x in r.user_agent.split() if x.startswith("dev=")), "?")
        via = f"app:{dev}"
    return Principal(session_id=r.id, user_id=r.user_id, username=r.username, csrf_token=r.csrf_token, via=via)


# ---------------------------------------------------------------- request guards
def allowed_hosts() -> set[str]:
    cfg = get_config()
    p = cfg.instance.port
    hosts = {f"127.0.0.1:{p}", f"localhost:{p}", f"[::1]:{p}"}
    if cfg.lan.enabled:
        from nebula_host.lan import lan_hosts

        hosts |= lan_hosts(p, cfg.lan.https_port if cfg.lan.https else None)
    return hosts


def allowed_origins() -> set[str]:
    cfg = get_config()
    p = cfg.instance.port
    origins = {f"http://127.0.0.1:{p}", f"http://localhost:{p}", f"http://[::1]:{p}"}
    if cfg.lan.enabled:
        from nebula_host.lan import lan_origins

        origins |= lan_origins(p, cfg.lan.https_port if cfg.lan.https else None)
    dev = os.environ.get("NEBULA_DEV_ORIGIN")
    if dev:
        origins.add(dev)
    return origins


def check_client(addr: str | None) -> None:
    """Source-address filter: loopback, or a LAN-interface subnet while LAN access is enabled."""
    if os.environ.get("NEBULA_TESTING") == "1" and addr in ("testclient", None):
        return
    from nebula_host.lan import client_allowed

    if not client_allowed(addr, get_config().lan.enabled):
        raise ApiError(403, "client_not_allowed", "this NEBULA dashboard only accepts this Mac and its local network")


def is_loopback_request(host: str | None) -> bool:
    return (host or "").rsplit(":", 1)[0].strip("[]") in ("127.0.0.1", "localhost", "::1")


def check_host_and_origin(host: str | None, origin: str | None, *, state_changing: bool) -> None:
    # Host check defeats DNS-rebinding; Origin check defeats cross-site requests.
    if os.environ.get("NEBULA_TESTING") == "1" and host in ("testserver", "testserver:80"):
        pass
    elif host not in allowed_hosts():
        raise ApiError(403, "bad_host", "requests must target the local NEBULA address")
    if origin is not None and origin not in allowed_origins():
        raise ApiError(403, "bad_origin", "cross-origin request rejected")
    if state_changing and origin is None and os.environ.get("NEBULA_TESTING") != "1":
        # browsers always send Origin on POST/PUT/PATCH/DELETE; CLI clients must send it explicitly
        raise ApiError(403, "origin_required", "Origin header required for state-changing requests")


async def require_session(request: Request) -> Principal:
    p = _session_from_token(request.cookies.get(COOKIE))
    if p is None:
        raise ApiError(401, "unauthenticated", "login required")
    if p.via:  # Telegram Mini App sessions are only valid through the narrowly scoped Mini App gateway
        from nebula_host.remote import GATEWAY_SECRET

        if not hmac.compare_digest(request.headers.get("x-nebula-gateway", ""), GATEWAY_SECRET):
            raise ApiError(401, "unauthenticated", "Mini App sessions are only accepted through the Mini App gateway")
    elif request.headers.get("x-nebula-gateway"):
        # N11 (defence in depth): the gateway forwards remote (Mini App / paired app) sessions only. A dashboard
        # session that arrives with the gateway header is refused, so it can never become an unchecked "local owner"
        raise ApiError(401, "unauthenticated", "the remote gateway only forwards remote sessions")
    if request.method in ("POST", "PUT", "PATCH", "DELETE"):
        sent = request.headers.get(CSRF_HEADER, "")
        if not hmac.compare_digest(sent, p.csrf_token):
            raise ApiError(403, "csrf_failed", "missing or invalid CSRF token")
    return p


def principal_for_ws(ws: WebSocket) -> Principal | None:
    try:
        check_client(ws.client.host if ws.client else None)
        check_host_and_origin(ws.headers.get("host"), ws.headers.get("origin"), state_changing=False)
    except ApiError:
        return None
    p = _session_from_token(ws.cookies.get(COOKIE))
    return None if p is not None and p.via else p  # Mini App sessions stream only through the gateway


CurrentUser = Depends(require_session)


def purge_expired_sessions() -> int:
    with db.engine().begin() as c:
        return c.execute(delete(models.sessions).where(models.sessions.c.expires_at < time.time())).rowcount
