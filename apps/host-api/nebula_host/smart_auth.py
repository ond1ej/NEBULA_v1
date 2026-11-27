"""Smart Authentication (V3.2.1; state-aware multi-step flows and risk-based destinations since V3.3): sign-in
assistance exactly when an agent's task hits a login.

Flow
----
agent calls ``request_sign_in(url)``  ->  host creates an auth session (agent/task/conversation from the execution
context, never from model output)  ->  the isolated VM broker (``nebula-vault`` user, own headless browser) opens the
page itself and classifies the step  ->  the owner gets ONE request object (conversation card, Activity, approvals,
Telegram notification with a Mini App button) showing the verified origin and fixed, role-based fields  ->  the
owner submits (single-use token; remote secret entry also needs the owner's remote sign-in PIN)  ->  values go from
host memory straight to the broker, which types them on the verified origin  ->  next step (code / device approval /
manual) or AUTHENTICATED  ->  only the session cookies reach the agent's browser and the task resumes with
"Authentication completed successfully."

Never stored: passwords, codes, submission tokens, cookies (memory only; the DB keeps state, origins, roles, counters).
Never visible to the agent or the model: anything the owner types. Website text never becomes trusted UI text.

V3.3 state machine (persisted in ``auth_sessions.state`` for the whole session, across navigations and reloads):
INITIALIZING -> {IDENTIFIER|PASSWORD|IDENTIFIER_AND_PASSWORD|OTP|DEVICE_APPROVAL|PASSKEY|CAPTCHA}_REQUIRED |
REDIRECT_REVIEW_REQUIRED | WAITING_FOR_USER  -> SUBMITTING -> VERIFYING -> (next *_REQUIRED) | AUTHENTICATED |
FAILED | CANCELLED | EXPIRED. Every page the broker settles on is re-detected (never assumed from the domain or the
previous step); a page change while the owner's form is open replaces the request (stale answers are refused); the
same step coming back without progress stops automatic submission (loop guard: Retry / Live Desktop / Cancel).
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import hmac
import logging
import re
import secrets
import time
import uuid
from typing import Any
from urllib.parse import urlsplit

from sqlalchemy import and_, func, select, update

from nebula_host import db, models
from nebula_host import vault as vaultmod
from nebula_host.events import bus

log = logging.getLogger("nebula.smart_auth")

WAIT_STATES = ("IDENTIFIER_REQUIRED", "EMAIL_REQUIRED", "USERNAME_REQUIRED", "PHONE_REQUIRED", "PASSWORD_REQUIRED",
               "IDENTIFIER_AND_PASSWORD_REQUIRED", "OTP_REQUIRED", "AUTHENTICATOR_APPROVAL", "PASSKEY_REQUIRED",
               "SECURITY_KEY_REQUIRED", "CAPTCHA_REQUIRED", "REDIRECT_REVIEW_REQUIRED", "LOGIN_ERROR", "UNKNOWN_STEP",
               "WAITING_FOR_USER")
STATES = ("INITIALIZING", *WAIT_STATES, "SUBMITTING", "VERIFYING", "AUTHENTICATED", "FAILED", "CANCELLED", "EXPIRED")
TERMINAL = frozenset({"AUTHENTICATED", "FAILED", "CANCELLED", "EXPIRED"})
OWNER_WAIT = frozenset(WAIT_STATES)
_END = {"FAILED", "CANCELLED", "EXPIRED"}
TRANSITIONS: dict[str, set[str]] = {
    "INITIALIZING": {*WAIT_STATES, "SUBMITTING", "VERIFYING", "AUTHENTICATED", *_END},
    # a page may change while the owner's form is open (watcher): one waiting state may replace another
    **{w: {*WAIT_STATES, "SUBMITTING", "VERIFYING", "AUTHENTICATED", *_END} for w in WAIT_STATES},
    "SUBMITTING": {"VERIFYING", "AUTHENTICATED", *WAIT_STATES, *_END},
    "VERIFYING": {*WAIT_STATES, "SUBMITTING", "AUTHENTICATED", *_END},
}
# earlier names (rows written before an upgrade are all terminal; kept for reading old exports/tests)
LEGACY_STATES = {"DETECTED": "INITIALIZING", "WAITING_FOR_OWNER": "WAITING_FOR_USER", "WAITING_FOR_MFA": "OTP_REQUIRED",
                 "WAITING_FOR_DEVICE_APPROVAL": "AUTHENTICATOR_APPROVAL", "WAITING_FOR_MANUAL": "WAITING_FOR_USER",
                 "OWNER_SUBMITTED": "SUBMITTING", "VALIDATING": "SUBMITTING", "WAITING_FOR_NEXT_STEP": "VERIFYING",
                 "DEVICE_APPROVAL_REQUIRED": "AUTHENTICATOR_APPROVAL"}
CREDENTIAL_STEPS = ("identifier", "identifier_password", "password")
CODE_STEPS = ("otp", "recovery_code")
KEY_STEPS = ("passkey", "security_key")
MANUAL_STEPS = ("captcha", *KEY_STEPS, "embedded_login", "new_password")
LOGIN_STEPS = (*CREDENTIAL_STEPS, *CODE_STEPS, "device_approval", *MANUAL_STEPS, "method_choice", "interstitial",
               "unknown")
ROLES = ("email", "phone", "username", "username_or_email", "password", "otp", "recovery_code")
IDENTIFIER_ROLES = ("email", "phone", "username", "username_or_email")
ALT_KINDS = ("password", "code", "app", "more")
REQUEST_TYPES = ("credentials", "otp", "recovery_code", "confirm_destination", "device_approval", "manual",
                 "method_choice", "loop")
STEP_STATE = {"identifier": "IDENTIFIER_REQUIRED", "password": "PASSWORD_REQUIRED",
              "identifier_password": "IDENTIFIER_AND_PASSWORD_REQUIRED", "otp": "OTP_REQUIRED",
              "recovery_code": "OTP_REQUIRED", "device_approval": "AUTHENTICATOR_APPROVAL",
              "passkey": "PASSKEY_REQUIRED", "security_key": "SECURITY_KEY_REQUIRED", "captcha": "CAPTCHA_REQUIRED",
              "unknown": "UNKNOWN_STEP"}
IDENTIFIER_STATE = {"email": "EMAIL_REQUIRED", "username": "USERNAME_REQUIRED", "phone": "PHONE_REQUIRED",
                    "username_or_email": "IDENTIFIER_REQUIRED"}
# automatic actions the broker may report (fixed codes, shown to the owner as fixed texts)
AUTO_NOTES = ("passkey_cancelled", "security_key_cancelled", "chose_password", "opened_other_ways", "declined_kmsi",
              "declined_nag", "declined_prompt")
EVIDENCE = ("provider_session_cookie", "signout_control", "site_cookie_and_navigation")
START_NOTES = ("restarted_from_service", "restarted_at_provider", "approval_number_hidden")


def state_for(step: dict[str, Any]) -> str:
    """The waiting state for what the page asks right now (from the broker's own reading of the page)."""
    k = step.get("step")
    if k == "identifier":
        roles = [f.get("role") for f in step.get("fields") or []]
        return IDENTIFIER_STATE.get(roles[0] if roles else "", "IDENTIFIER_REQUIRED")
    return STEP_STATE.get(k, "WAITING_FOR_USER")


DEFAULTS: dict[str, Any] = {"enabled": True, "request_ttl_s": 600, "otp_ttl_s": 120, "token_ttl_s": 120,
                            "max_retries": 2, "max_per_agent": 1, "max_global": 5, "max_credential_attempts": 3,
                            "max_otp_attempts": 3, "session_max_s": 1800, "remote_submission": True,
                            "allow_local_network": False, "observe_interval_s": 8, "max_steps": 16,
                            "loop_threshold": 2, "passkey_fallback": "password"}
_BOUNDS = {"request_ttl_s": (120, 1800), "otp_ttl_s": (30, 600), "token_ttl_s": (30, 600), "max_retries": (0, 3),
           "max_per_agent": (1, 3), "max_global": (1, 10), "max_credential_attempts": (1, 5),
           "max_otp_attempts": (1, 5), "session_max_s": (300, 3600), "observe_interval_s": (3, 60),
           "max_steps": (6, 30), "loop_threshold": (2, 4)}
PIN_FREE_ATTEMPTS = 5
PIN_LOCKOUT_BASE_S = 300
_CTRL = re.compile(r"[\x00-\x1f\x7f]")


class AuthError(Exception):
    def __init__(self, code: str, message: str, status: int = 400, **extra: Any) -> None:
        super().__init__(message)
        self.code, self.status, self.extra = code, status, extra


# ============================================================================ settings + remote PIN
def settings() -> dict[str, Any]:
    s = {**DEFAULTS, **(db.get_setting("smart_auth", {}) or {})}
    for k, (lo, hi) in _BOUNDS.items():
        try:
            s[k] = min(max(int(s[k]), lo), hi)
        except (TypeError, ValueError):
            s[k] = DEFAULTS[k]
    for k in ("enabled", "remote_submission", "allow_local_network"):
        s[k] = bool(s[k])
    if s.get("passkey_fallback") not in ("password", "ask"):
        s["passkey_fallback"] = "password"
    return s


def update_settings(changes: dict[str, Any], *, actor: str) -> dict[str, Any]:
    cur = {**DEFAULTS, **(db.get_setting("smart_auth", {}) or {})}
    for k, v in changes.items():
        if k in ("enabled", "remote_submission", "allow_local_network"):
            cur[k] = bool(v)
        elif k == "passkey_fallback" and v is not None:
            if v not in ("password", "ask"):
                raise AuthError("invalid_setting", "passkey_fallback must be 'password' or 'ask'")
            cur[k] = v
        elif k in _BOUNDS and v is not None:
            lo, hi = _BOUNDS[k]
            try:
                iv = int(v)
            except (TypeError, ValueError):
                raise AuthError("invalid_setting", f"{k} must be a number") from None
            if not lo <= iv <= hi:
                raise AuthError("invalid_setting", f"{k} must be between {lo} and {hi}")
            cur[k] = iv
    db.set_setting("smart_auth", cur)
    _audit(actor, "smart_auth.settings", {k: cur[k] for k in changes if k in cur})
    return settings()


def _pin_row() -> dict[str, Any]:
    return db.get_setting("smart_auth_pin", {}) or {}


def pin_status() -> dict[str, Any]:
    r = _pin_row()
    lock = r.get("locked_until")
    return {"configured": bool(r.get("hash")), "set_at": r.get("set_at"),
            "locked_until": lock if lock and lock > time.time() else None}


def _hasher():
    from argon2 import PasswordHasher

    return PasswordHasher(time_cost=3, memory_cost=64 * 1024, parallelism=2)


def _check_pin_strength(pin: str) -> None:
    if not isinstance(pin, str) or not 6 <= len(pin) <= 64 or _CTRL.search(pin):
        raise AuthError("weak_pin", "the PIN needs 6-64 characters")
    if len(set(pin)) < 3:
        raise AuthError("weak_pin", "the PIN is too repetitive")
    if pin.isdigit() and (pin in "01234567890123456789" or pin in "98765432109876543210"):
        raise AuthError("weak_pin", "the PIN is too predictable")


def set_pin(pin: str, *, actor: str, current: str | None = None) -> dict[str, Any]:
    """Local only (enforced by the API). Changing an existing PIN needs the current one."""
    r = _pin_row()
    if r.get("hash"):
        verify_pin(current or "", consume_attempt=True)
    _check_pin_strength(pin)
    db.set_setting("smart_auth_pin", {"hash": _hasher().hash(pin), "set_at": time.time(), "failures": 0,
                                      "locked_until": None})
    _audit(actor, "smart_auth.pin_set", {})
    return pin_status()


def clear_pin(*, actor: str) -> dict[str, Any]:
    db.set_setting("smart_auth_pin", {})
    _audit(actor, "smart_auth.pin_cleared", {})
    return pin_status()


def verify_pin(pin: str, *, consume_attempt: bool = True) -> None:
    r = _pin_row()
    if not r.get("hash"):
        raise AuthError("pin_not_configured", "Set a remote sign-in PIN on your Mac (Password Vault → Smart sign-in) "
                                              "to enter passwords from your phone.", 403)
    if not isinstance(pin, str) or not pin:
        raise AuthError("pin_required", "Enter your remote sign-in PIN.", 403)
    now = time.time()
    if r.get("locked_until") and r["locked_until"] > now:
        raise AuthError("pin_locked", "Too many wrong PINs. Try again later.", 429,
                        retry_after=int(r["locked_until"] - now))
    from argon2.exceptions import VerificationError

    try:
        ok = isinstance(pin, str) and 0 < len(pin) <= 64 and _hasher().verify(r["hash"], pin)
    except VerificationError:
        ok = False
    if ok:
        if r.get("failures"):
            db.set_setting("smart_auth_pin", {**r, "failures": 0, "locked_until": None})
        return
    if consume_attempt:
        fails = int(r.get("failures") or 0) + 1
        lock = None
        if fails >= PIN_FREE_ATTEMPTS:
            lock = now + min(PIN_LOCKOUT_BASE_S * (2 ** (fails - PIN_FREE_ATTEMPTS)), 3600)
        db.set_setting("smart_auth_pin", {**r, "failures": fails, "locked_until": lock})
        _audit("system", "smart_auth.pin_failed", {"failures": fails})
    raise AuthError("pin_invalid", "Wrong PIN.", 403, attempts_left=max(0, PIN_FREE_ATTEMPTS -
                                                                        int(_pin_row().get("failures") or 0)))


# ============================================================================ runtime state (memory only)
class _Rt:
    def __init__(self, sid: str, guest: Any, agent_id: str) -> None:
        self.sid, self.guest, self.agent_id = sid, guest, agent_id
        self.lock = asyncio.Lock()  # one broker interaction at a time
        self.done = asyncio.Event()
        self.url: str = ""  # sign-in URL (may carry a query; memory only)
        self.step: dict[str, Any] | None = None  # last trusted step from the broker
        self.step_id: int | None = None
        self.final_url: str | None = None
        self.saved_entry: str | None = None  # owner-selected saved account (multi-step re-use)
        self.save: dict[str, Any] | None = None  # {"name", "allow_future"} when "save to vault" was chosen
        self.collected: dict[str, str] = {}  # identifier/password kept ONLY for an explicit save-to-vault
        self.pending: dict[str, str] | None = None  # role -> value awaiting a destination decision (form target)
        self.pending_step: str | None = None
        self.pending_until = 0.0
        self.blocked_origin: str | None = None
        self.bg: set[asyncio.Task] = set()
        self.poller: asyncio.Task | None = None
        self.watcher: asyncio.Task | None = None
        self.submitted_fp: str | None = None  # fingerprint of the step the owner last answered (loop guard)
        self.no_progress = 0  # answers in a row that left the page on the same step without an error
        self.steps = 0  # steps shown in this session (hard cap against endless flows)
        self.collected_origins: dict[str, str] = {}  # role group -> origin it was typed on (metadata, not secret)
        self.notes: list[str] = []  # fixed codes shown to the owner (automatic broker actions, restart from service)
        self.collected_kind: str | None = None  # role of the collected identifier (email / username / phone)

    def wipe(self) -> None:
        for d in (self.collected, self.pending or {}):
            for k in list(d):
                d[k] = ""
            d.clear()
        self.pending = None
        self.save = None
        self.collected_origins.clear()


_RT: dict[str, _Rt] = {}


def _rt(sid: str) -> _Rt | None:
    return _RT.get(sid)


# ============================================================================ persistence helpers
def _now() -> float:
    return time.time()


def _get(sid: str, c=None) -> dict[str, Any]:
    q = select(models.auth_sessions).where(models.auth_sessions.c.id == sid)
    if c is not None:
        r = db.row(c.execute(q).first())
    else:
        with db.engine().connect() as cc:
            r = db.row(cc.execute(q).first())
    if not r:
        raise AuthError("not_found", "no such sign-in request", 404)
    return r


def _open_request(sid: str, c=None) -> dict[str, Any] | None:
    q = select(models.auth_requests).where(and_(models.auth_requests.c.auth_session_id == sid,
                                                models.auth_requests.c.status == "open")) \
        .order_by(models.auth_requests.c.seq.desc()).limit(1)
    if c is not None:
        return db.row(c.execute(q).first())
    with db.engine().connect() as cc:
        return db.row(cc.execute(q).first())


def _log(sid: str, event_type: str, outcome: str | None = None, **meta: Any) -> None:
    keep = {k: v for k, v in meta.items() if k in ("state", "step", "request_type", "origin", "confidence", "flags",
                                                    "error_code", "attempt", "method", "actor_type", "to", "from_step",
                                                    "from_origin", "evidence", "reason", "kind", "step_id")}
    if isinstance(meta.get("diag"), dict):
        keep["diag"] = clean_diag(meta["diag"])
    if isinstance(meta.get("auto"), list):
        keep["auto"] = [a for a in meta["auto"] if a in AUTO_NOTES][:8]
    if isinstance(meta.get("timing"), dict):
        keep["timing"] = {k: max(0, min(int(v), 600000)) for k, v in meta["timing"].items()
                          if k in ("change_ms", "settle_ms", "read_ms") and isinstance(v, (int, float))
                          and not isinstance(v, bool)}
    with db.engine().begin() as c:
        c.execute(models.auth_events.insert().values(id=str(uuid.uuid4()), auth_session_id=sid,
                                                     event_type=event_type[:40], timestamp=_now(),
                                                     outcome=(outcome or None) and outcome[:24],
                                                     sanitized_metadata=keep))


FLAG_CODES = frozenset({"origin_changed", "other_site", "plain_http", "multiple_password_forms", "ambiguous_identifier",
                        "hidden_password_field", "unexpected_recovery_code", "third_party_frame",
                        "cross_site_form_action", "cross_origin_form_action", "same_origin_frame", "local_network"})
_BRAND_FLAG = re.compile(r"^brand_mismatch:[a-z]{2,20}$")


def flag_ok(f: Any) -> bool:
    """Detector flags are fixed codes; nothing else (a page's or a value's text) can pass as one."""
    return isinstance(f, str) and (f in FLAG_CODES or bool(_BRAND_FLAG.match(f)))


# every diagnostics value is a number, a boolean or one of these fixed words: no free text can be stored
_DIAG_WORDS: dict[str, frozenset[str]] = {
    "step": frozenset((*LOGIN_STEPS, "authenticated", "none")), "confidence": frozenset({"HIGH", "MEDIUM", "LOW"}),
    "structure": frozenset({"HIGH", "MEDIUM", "LOW"}), "ready": frozenset({"loading", "interactive", "complete"}),
    "webauthn": frozenset(KEY_STEPS), "roles": frozenset((*ROLES, "new_password")), "alternatives": frozenset(ALT_KINDS)}
_DIAG_INTS = ("inputs_visible", "inputs", "forms", "frames", "shadow_roots", "quiet_ms", "mutations", "animating")
_DIAG_BOOLS = ("observed", "busy", "webauthn_pending", "error", "login_context", "logout_link")


def clean_diag(d: Any) -> dict[str, Any]:
    """Structural detection facts only (V3.4 diagnostics): counts, booleans and fixed words. Anything else — text,
    names, values, URLs, cookies — is dropped, whatever the broker sent."""
    out: dict[str, Any] = {}
    if not isinstance(d, dict):
        return out
    for k in _DIAG_INTS:
        v = d.get(k)
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            out[k] = max(0, min(int(v), 10**9))
    for k in _DIAG_BOOLS:
        if k in d:
            out[k] = bool(d.get(k))
    for k, words in _DIAG_WORDS.items():
        v = d.get(k)
        if isinstance(v, str) and v in words:
            out[k] = v
        elif isinstance(v, list) and k in ("roles", "alternatives"):
            out[k] = [x for x in v[:8] if isinstance(x, str) and x in words]
    if isinstance(d.get("flags"), list):
        out["flags"] = [f for f in d["flags"][:8] if flag_ok(f)]
    return out


def _audit(actor: str, action: str, meta: dict[str, Any]) -> None:
    from nebula_host.events import audit

    audit(actor, action, None, meta)


def _actor_type(actor: str) -> str:
    return "agent" if actor.startswith("agent:") else "system" if actor.startswith("system") else "owner"


def _transition(sid: str, to: str, *, c=None, **values: Any) -> dict[str, Any]:
    def go(conn) -> dict[str, Any]:
        row = _get(sid, conn)
        frm = row["state"]
        if frm in TERMINAL:
            raise AuthError("finished", "this sign-in request is already finished", 409)
        if to != frm and to not in TRANSITIONS.get(frm, set()):
            raise AuthError("bad_transition", f"cannot go from {frm} to {to}", 409)
        vals = {"state": to, "updated_at": _now(), **values}
        if to in TERMINAL:
            vals["completed_at"] = _now()
        n = conn.execute(update(models.auth_sessions).where(and_(models.auth_sessions.c.id == sid,
                                                                 models.auth_sessions.c.state == frm))
                         .values(**vals)).rowcount
        if n != 1:
            raise AuthError("conflict", "the sign-in request changed meanwhile, try again", 409)
        return {**row, **vals, "_from": frm}

    if c is not None:
        return go(c)
    with db.engine().begin() as cc:
        return go(cc)


_SPECIAL_SUFFIXES = (".local", ".test", ".internal", ".lan", ".home.arpa", ".localhost", ".arpa", ".invalid",
                     ".example", ".intranet", ".corp", ".home")


def is_local_network_origin(origin: str) -> bool:
    """IP literals, single-label hosts and private/special-use names: agents inside the VM can serve pages there
    (fake sign-in forms), so smart sign-in refuses them unless the owner allowed local-network sign-ins on the Mac."""
    import ipaddress

    host = (urlsplit(origin or "").hostname or "").lower().strip("[]").rstrip(".")
    if not host or "." not in host or host.endswith(_SPECIAL_SUFFIXES):
        return True
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        return False


def _site(origin: str | None) -> str:
    return (urlsplit(origin or "").hostname or "").lower()


def _agent_name(agent_id: str) -> str:
    with db.engine().connect() as c:
        return c.execute(select(models.agents.c.name).where(models.agents.c.id == agent_id)).scalar() or "Agent"


def _event_payload(row: dict[str, Any], req: dict[str, Any] | None) -> dict[str, Any]:
    origin = row.get("verified_origin") or row["requested_origin"]
    sch = (req or {}).get("field_schema") or {}
    return {"session_id": row["id"], "state": row["state"], "step": row.get("current_step"), "origin": origin,
            "verified": bool(row.get("verified_origin")), "destination": sch.get("destination"),
            "site": _site(origin), "agent_name": _agent_name(row["agent_id"]),
            "conversation_id": row.get("conversation_id"), "request_type": (req or {}).get("request_type"),
            "request_id": (req or {}).get("id"), "confidence": row.get("confidence"),
            "trust": row.get("trust_level"), "error_code": row.get("error_code"), "expires_at": row.get("expires_at")}


def _publish(sid: str, *, needs_owner: bool = False) -> None:
    row = _get(sid)
    req = _open_request(sid)
    p = _event_payload(row, req)
    bus.publish("auth.session.updated", p, agent_id=row["agent_id"], task_id=row["task_id"])
    if needs_owner and req is not None:
        bus.publish("auth.request", p, agent_id=row["agent_id"], task_id=row["task_id"])


def _new_request(sid: str, rtype: str, schema: dict[str, Any], state: str, *, notify: bool = True,
                 **session_values: Any) -> dict[str, Any]:
    st = settings()
    now = _now()
    with db.engine().begin() as c:
        row = _get(sid, c)
        deadline = row["created_at"] + st["session_max_s"]
        expires = min(now + st["request_ttl_s"], deadline)
        c.execute(update(models.auth_requests).where(and_(models.auth_requests.c.auth_session_id == sid,
                                                          models.auth_requests.c.status == "open"))
                  .values(status="superseded", resolved_at=now, token_hash=None))
        seq = int(c.execute(select(func.coalesce(func.max(models.auth_requests.c.seq), 0))
                            .where(models.auth_requests.c.auth_session_id == sid)).scalar() or 0) + 1
        rid = "ar_" + secrets.token_hex(12)
        c.execute(models.auth_requests.insert().values(id=rid, auth_session_id=sid, seq=seq, request_type=rtype,
                                                       field_schema=schema, status="open", created_at=now,
                                                       expires_at=expires))
        _transition(sid, state, c=c, expires_at=expires, step_seq=seq, **session_values)
    _log(sid, "request.created", "open", request_type=rtype, state=state, step=schema.get("step"))
    _publish(sid, needs_owner=notify)
    return {"id": rid, "request_type": rtype}


def _close_requests(sid: str, status: str, c=None) -> None:
    def go(conn) -> None:
        conn.execute(update(models.auth_requests).where(and_(models.auth_requests.c.auth_session_id == sid,
                                                             models.auth_requests.c.status == "open"))
                     .values(status=status, resolved_at=_now(), token_hash=None))

    if c is not None:
        go(c)
    else:
        with db.engine().begin() as cc:
            go(cc)


# ============================================================================ vault metadata for the owner form
def _vault_state() -> str:
    st = vaultmod.VAULT.status()
    return "not_created" if not st["exists"] else "locked" if st["locked"] else "unlocked"


def _usable_grants(agent_id: str) -> list[dict[str, Any]]:
    try:
        return vaultmod.VAULT.usable_for_agent(agent_id)
    except Exception:  # noqa: BLE001 - metadata only, never fatal
        return []


def _grant_for(agent_id: str, entry_id: str, origins: list[str], task_id: str) -> dict[str, Any] | None:
    """An enabled, unexpired, owner-created grant (HMAC verified by VAULT.authorize) of this agent for the entry,
    valid for ALL origins of the session."""
    if vaultmod.VAULT.locked or not origins:
        return None
    for g in vaultmod.VAULT.grants(agent_id):
        if g.get("entry_id") != entry_id:
            continue
        try:
            for o in origins:
                b = vaultmod.VAULT.authorize(agent_id=agent_id, ref=g["id"], origin=o, operation="sign_in",
                                             task_id=task_id)
                if b["entry_id"] != entry_id:
                    raise vaultmod.VaultDenied("binding", "entry mismatch")
        except vaultmod.VaultDenied:
            continue
        return g
    return None


def _site_of(host: str) -> str:
    h = (host or "").lower().strip("[]").rstrip(".")
    if not h or re.match(r"^[\d.]+$", h) or ":" in h:
        return h
    parts = h.split(".")
    two = {"co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au", "co.jp", "co.nz", "com.br", "com.mx",
           "co.in", "co.za", "com.tr", "com.cn", "com.hk", "com.sg", "co.kr", "com.ar", "com.pl"}
    return ".".join(parts[-3:]) if len(parts) >= 3 and ".".join(parts[-2:]) in two else ".".join(parts[-2:])


def _accounts(agent_id: str, origin: str, task_id: str, origins: list[str] | None = None, *,
              local: bool = True, show_usernames: bool = False) -> list[dict[str, Any]]:
    """Saved website credentials bound to exactly this origin (the page that asks for them): names (+ the decrypted
    user name for the owner while unlocked). Never a password. `has_grant` = a grant covering every origin of the
    session."""
    unlocked = not vaultmod.VAULT.locked
    out = []
    for e in vaultmod.VAULT.list_entries():
        if e.get("credential_type") != "website" or e.get("origin") != origin:
            continue
        acc = {"entry_id": e["id"], "name": e["display_name"], "username": None, "has_grant": False}
        if unlocked:
            if local or show_usernames:
                try:
                    acc["username"] = vaultmod.VAULT.entry_detail(e["id"]).get("username") or None
                except vaultmod.VaultError:
                    pass
            g = _grant_for(agent_id, e["id"], list(origins or [origin]), task_id)
            acc["has_grant"] = g is not None
            acc["policy"] = g.get("approval_policy") if g else None
        out.append(acc)
    return out[:10]


# ============================================================================ schema validation (broker output)
_FIELD_ID = re.compile(r"^f\d{1,3}$")


def _valid_step(step: Any, allowed: list[str]) -> dict[str, Any]:
    """The broker is trusted, but its output is still validated strictly before it shapes an owner form."""
    if not isinstance(step, dict) or step.get("step") not in (*LOGIN_STEPS, "authenticated", "none"):
        raise AuthError("bad_step", "the sign-in step could not be recognised", 502)
    fields = []
    for f in (step.get("fields") or [])[:3]:
        if not isinstance(f, dict) or f.get("role") not in ROLES or not _FIELD_ID.match(str(f.get("id"))):
            raise AuthError("bad_step", "unexpected sign-in field", 502)
        ids = f.get("ids")
        if ids is not None and (not isinstance(ids, list) or not 4 <= len(ids) <= 8 or
                                not all(_FIELD_ID.match(str(i)) for i in ids)):
            raise AuthError("bad_step", "unexpected code field", 502)
        length = f.get("length")
        fields.append({"id": f["id"], "role": f["role"],
                       "input": f.get("input") if f.get("input") in ("email", "tel", "text", "password", "code")
                       else "text",
                       "length": int(length) if isinstance(length, int) and 3 <= length <= 12 else None,
                       "charset": f.get("charset") if f.get("charset") in ("numeric", "alphanumeric") else None,
                       **({"ids": [str(i) for i in ids]} if ids else {})})
    kind = step["step"]
    if kind in CREDENTIAL_STEPS and not fields:
        raise AuthError("bad_step", "sign-in step without fields", 502)
    if kind in CODE_STEPS and len(fields) != 1:
        raise AuthError("bad_step", "code step without a code field", 502)
    page_origin = step.get("page_origin")
    if kind not in ("none",) and page_origin not in allowed:
        raise AuthError("origin_unverified", "the sign-in page is not on an allowed origin", 502)
    otp = step.get("otp") if isinstance(step.get("otp"), dict) else None
    flags = [x for x in (step.get("flags") or [])[:8] if flag_ok(x)]
    alts, seen = [], set()
    for a in (step.get("alternatives") or [])[:4]:
        if isinstance(a, dict) and a.get("kind") in ALT_KINDS and re.fullmatch(r"c\d{1,3}", str(a.get("id"))) and \
                a["kind"] not in seen:
            seen.add(a["kind"])
            alts.append({"id": str(a["id"]), "kind": a["kind"]})
    tr = step.get("transport") if isinstance(step.get("transport"), dict) else None
    fp = step.get("fingerprint")
    wa = step.get("webauthn") if isinstance(step.get("webauthn"), dict) else None
    num = step.get("approval_number")
    return {"step": kind, "fields": fields, "page_origin": page_origin, "alternatives": alts,
            "webauthn": {"kind": wa.get("kind"), "pending": bool(wa.get("pending"))}
            if wa and wa.get("kind") in KEY_STEPS else None,
            "approval_number": num if isinstance(num, str) and re.fullmatch(r"\d{2,3}", num) else None,
            "fingerprint": fp if isinstance(fp, str) and re.fullmatch(r"[0-9a-f]{16}", fp) else None,
            "structure": step.get("structure") if step.get("structure") in ("HIGH", "MEDIUM", "LOW") else None,
            "transport": {"ip": tr.get("ip") if tr.get("ip") in ("public", "private", "loopback") else "unknown",
                          "tls": bool(tr.get("tls"))} if tr else None,
            "confidence": step.get("confidence") if step.get("confidence") in ("HIGH", "MEDIUM", "LOW") else "LOW",
            "flags": flags, "otp": {"channel": otp.get("channel") if otp.get("channel") in
                                    ("sms", "email", "totp", "unknown") else "unknown",
                                    "length": otp.get("length") if isinstance(otp.get("length"), int) and
                                    3 <= otp["length"] <= 12 else None,
                                    "charset": otp.get("charset") if otp.get("charset") in
                                    ("numeric", "alphanumeric") else "alphanumeric"} if otp else None,
            "action_origin": step.get("action_origin") if isinstance(step.get("action_origin"), str) else None}


def _value_ok(role: str, field: dict[str, Any], v: Any) -> str:
    if not isinstance(v, str):
        raise AuthError("invalid_value", "every field needs a value")
    if role in ("otp", "recovery_code"):
        v = re.sub(r"[\s-]", "", v)
        if role == "otp":
            cs = field.get("charset") or "alphanumeric"
            if not v or (cs == "numeric" and not v.isdigit()) or not v.isalnum() or not v.isascii():
                raise AuthError("invalid_code", "the code may contain only digits" if cs == "numeric" else
                                "the code may contain only letters and digits")
            want = field.get("length")
            if (want and len(v) != want) or not 3 <= len(v) <= 12:
                raise AuthError("invalid_code", f"the code must have {want} characters" if want else
                                "the code must have 3-12 characters")
            if field.get("ids") and len(v) != len(field["ids"]):
                raise AuthError("invalid_code", f"the code must have {len(field['ids'])} characters")
        elif not re.fullmatch(r"[A-Za-z0-9]{4,64}", v):
            raise AuthError("invalid_code", "the recovery code may contain only letters and digits")
        return v
    if not v or _CTRL.search(v):
        raise AuthError("invalid_value", "empty or invalid value")
    limit = {"password": 4096, "phone": 32, "email": 320}.get(role, 512)
    if len(v) > limit:
        raise AuthError("invalid_value", "value too long")
    if role == "phone" and not re.fullmatch(r"[+0-9 ()./-]{3,32}", v):
        raise AuthError("invalid_value", "a phone number may contain only digits, spaces and + ( ) - .")
    if role != "password":
        v = v.strip()
    return v


# ============================================================================ tool exposed to the model
def tool_available(env: str, agent: dict[str, Any] | None = None) -> bool:
    from nebula_host import vault_broker

    if agent is not None and (agent.get("config") or {}).get("sign_in_assistance", True) is False:
        return False  # V3.2.2: the owner chose "No access" for this agent (existing agents keep the default: on)
    return env == "vm" and settings()["enabled"] and bool(vault_broker.settings().get("broker_enabled", True))


def tool():
    from nebula_runtime.tools import Tool, obj

    desc = ("Ask the owner to sign you in when a website needs a login or a verification code (SMS, e-mail, "
            "authenticator app, device approval, passkey or security-key prompts). NEBULA verifies the site's real "
            "origin, shows the owner a secure form, signs in with a separate isolated browser and hands only the "
            "resulting session to YOUR browser. You never see passwords or codes: never ask the owner for them in "
            "chat and never type them yourself. Pass the address of the site or page you were trying to use (for "
            "example https://teams.microsoft.com), not an address of a sign-in step your browser reached: the "
            "isolated browser always starts the sign-in from the beginning. Do not click, cancel or answer passkey, "
            "security-key or 'Stay signed in?' windows yourself — NEBULA handles them. The call waits until the "
            "owner finishes (up to about 10 minutes). After 'authenticated', continue the ORIGINAL task in your "
            "browser (it is already on the signed-in page). If the result is 'cancelled' or 'denied', do not ask "
            "again for this site in this task.")
    return Tool("request_sign_in", None, desc,
                obj({"url": {"type": "string", "description": "https URL of the sign-in page or protected page"}},
                    ["url"]), "STANDARD", side_effect=True)


def _deny(code: str, message: str, **extra: Any) -> dict[str, Any]:
    return {"status": "denied", "reason_code": code, "reason": message, **extra,
            "instruction": "Do not try to obtain or type credentials another way. Tell the owner if you need them."}


def _cancelled_earlier(task_id: str, origin: str) -> bool:
    with db.engine().connect() as c:
        return c.execute(select(func.count()).select_from(models.auth_sessions).where(and_(
            models.auth_sessions.c.task_id == task_id, models.auth_sessions.c.requested_origin == origin,
            models.auth_sessions.c.state == "CANCELLED",
            models.auth_sessions.c.error_code.in_(["owner_cancelled", "owner_denied_destination"])))).scalar() > 0


def _sign_in_group(origin: str) -> str:
    """Sites that count as one for the agent loop guard: a built-in provider's hosts together, else the site."""
    from nebula_host import auth_trust

    p = auth_trust.provider_for(origin)
    return f"provider:{p.id}" if p else f"site:{_site_of(_site(origin))}"


def _failed_earlier(task_id: str, origin: str) -> int:
    """Failed sign-ins of this task for this site or provider (agent loop guard; rotating Teams / Outlook /
    teams.cloud.microsoft addresses counts as the same provider)."""
    with db.engine().connect() as c:
        rows = c.execute(select(models.auth_sessions.c.requested_origin).where(and_(
            models.auth_sessions.c.task_id == task_id, models.auth_sessions.c.state == "FAILED"))).all()
    g = _sign_in_group(origin)
    return sum(1 for r in rows if _sign_in_group(r.requested_origin) == g)


def _service_for(runner, idp_origin: str, hinted: Any) -> tuple[str, str] | None:
    """The service page the agent was on before its browser reached the identity provider: from the agent's
    browser (advisory: the agent controls it) or else the task's own last navigation. Used only when the service
    has a verified relationship with this provider (built-in or owner-made), so an agent cannot steer the owner to
    an arbitrary site this way. Returns (origin, url without query) or None."""
    from nebula_host import auth_trust

    cands: list[str] = []
    if isinstance(hinted, str):
        cands.append(hinted)
    try:
        with db.engine().connect() as c:
            rows = c.execute(select(models.task_steps.c.args_sanitized).where(and_(
                models.task_steps.c.task_id == runner.task_id, models.task_steps.c.tool_type == "browser_navigate"))
                .order_by(models.task_steps.c.seq.desc()).limit(10)).all()
        for r in rows:
            a = r.args_sanitized if isinstance(r.args_sanitized, dict) else {}
            if isinstance(a.get("url"), str):
                cands.append(a["url"])
    except Exception:  # noqa: BLE001 - no history: nothing to offer
        pass
    for u in cands:
        try:
            o = vaultmod.canonical_origin(u.strip()[:2000])
        except vaultmod.VaultError:
            continue
        if o == idp_origin or auth_trust.is_auth_host(o) or is_local_network_origin(o):
            continue
        if auth_trust.relationship(o, idp_origin) is None:
            continue
        path = urlsplit(u).path or "/"
        return o, f"{o}{path}"
    return None


def host_instance_id() -> str:
    """Stable id of this NEBULA host instance (its own database): the VM's start-up sweep closes only broker
    sessions of the same instance, never those of another one (a temporary test host on the same VM)."""
    hid = db.get_setting("smart_auth_host_id", None)
    if not (isinstance(hid, str) and re.fullmatch(r"[0-9a-f]{16}", hid)):
        hid = secrets.token_hex(8)
        db.set_setting("smart_auth_host_id", hid)
    return hid


def _active_counts(agent_id: str) -> tuple[int, int]:
    with db.engine().connect() as c:
        rows = c.execute(select(models.auth_sessions.c.agent_id).where(
            models.auth_sessions.c.state.notin_(list(TERMINAL)))).all()
    return sum(1 for r in rows if r.agent_id == agent_id), len(rows)


async def run_for_tool(runner, tc, agent: dict[str, Any]) -> dict[str, Any]:
    """Executed by the task runner for a ``request_sign_in`` call; returns the model-visible payload."""
    from nebula_runtime.orchestrator import get_task, set_task

    from nebula_host import vault_broker

    raw = str((tc.arguments or {}).get("url") or "").strip()[:2000]
    if runner.env != "vm":
        return _deny("unsupported_environment", "sign-in assistance is only available for agents working in the VM")
    st = settings()
    if not st["enabled"]:
        return _deny("smart_auth_disabled", "the owner turned sign-in assistance off")
    if not vault_broker.settings().get("broker_enabled", True):
        return _deny("broker_disabled", "the owner disabled agent sign-ins")
    try:
        origin = vaultmod.canonical_origin(raw)
    except vaultmod.VaultError as e:
        return _deny("invalid_url", str(e))
    try:
        vaultmod._check_grant_origins([origin])
    except vaultmod.VaultError:
        return _deny("loopback_origin", "sign-in assistance is never offered for localhost/127.0.0.1 inside the VM")
    if is_local_network_origin(origin) and not st["allow_local_network"]:
        return _deny("local_network_origin", "sign-in assistance is not offered for IP addresses or local-network "
                                             "names unless the owner allowed it on the Mac")
    from nebula_host import auth_trust

    if not is_local_network_origin(origin):
        lk = auth_trust.lookalike(auth_trust.host_of(origin))
        if lk and not auth_trust._owner_verified(origin):
            _audit(f"agent:{runner.agent_id}", "smart_auth.suspicious_site", {"origin": origin, "imitates": lk})
            return _deny("suspicious_site", f"{_site(origin)} imitates {lk}; NEBULA does not sign in on lookalike "
                                            "sites. Tell the owner (they can mark the exact site as genuine).")
    p = urlsplit(raw)
    # rebuilt on the canonical (IDNA, lower-case) origin so the broker's exact-origin check matches
    url = f"{origin}{p.path or '/'}" + (f"?{p.query}" if p.query else "")
    hint: dict[str, Any] = {}
    try:
        h = await runner.o.guest.tool(runner.agent_id, "browser.auth_hint", {}, timeout=10)
        hint = (h.get("result") or {}) if h.get("ok") else {}
    except Exception:  # noqa: BLE001 - VM hiccup: no hint
        hint = {}
    notes: list[str] = []
    if auth_trust.is_auth_host(origin):
        # V3.4: the agent reached an identity provider's sign-in page in ITS browser (often mid-flow: a resume /
        # passkey / password page). NEBULA's isolated browser always starts from the beginning, so start it from the
        # service that sent the agent there — only one with a verified relationship to this provider.
        svc = _service_for(runner, origin, hint.get("service_url"))
        if svc:
            origin, url = svc
            notes.append("restarted_from_service")
        elif (p.path or "/") != "/" or p.query:
            url = f"{origin}/"  # a mid-flow address (resume / reprocess / fido) cannot be continued: the start page
            notes.append("restarted_at_provider")
    if _cancelled_earlier(runner.task_id, origin):
        return _deny("owner_cancelled_earlier", "the owner already declined signing in to this site in this task")
    if _failed_earlier(runner.task_id, origin) >= 2:
        return _deny("repeated_failure", "signing in to this site already failed twice in this task. Stop trying; "
                                         "tell the owner what happened (the reasons were in the earlier results) "
                                         "and suggest they sign in through Live Desktop or check the account.")
    mine, total = _active_counts(runner.agent_id)
    if mine >= st["max_per_agent"]:
        return _deny("busy", "another sign-in of this agent is still waiting for the owner")
    if total >= st["max_global"]:
        return _deny("busy_global", "too many sign-ins are waiting for the owner; try again later")
    cap = vault_broker._guest_capability()
    if not cap or not cap.get("smart_auth"):
        cap = await vault_broker.refresh_capability(runner.o.guest)
    if not (cap.get("installed") and cap.get("isolated") and cap.get("smart_auth")):
        if str(cap.get("reason") or "").startswith("VM not reachable"):
            return _deny("vm_not_running", "the NEBULA virtual machine is not running or not reachable, and sign-in "
                                           "needs it. Tell the owner to start the VM (NEBULA → System), then try "
                                           "again.")
        return _deny("broker_unavailable", f"the isolated sign-in broker is not available ({cap.get('reason') or 'update the VM with nebula repair'})")
    # already signed in in the agent's own browser? (advisory, never a reason to show a form)
    hh = hint.get("hint") if isinstance(hint.get("hint"), dict) else {}
    if hh.get("origin") == origin and hh.get("step") == "authenticated":
        return {"status": "already_signed_in", "origin": origin,
                "note": "Your browser already shows a signed-in page for this site. Continue the task."}

    task = get_task(runner.task_id)
    pre = auth_trust.preallowed(origin)  # the provider's own sign-in hosts (built-in, exact, GREEN)
    sid = "as_" + secrets.token_hex(12)
    now = _now()
    with db.engine().begin() as c:
        c.execute(models.auth_sessions.insert().values(
            id=sid, agent_id=runner.agent_id, task_id=runner.task_id, conversation_id=task.get("conversation_id"),
            requested_origin=origin, verified_origin=None, allowed_origins=[origin, *pre], auth_method=None,
            current_step=None, step_seq=0, state="INITIALIZING", confidence=None, flags=[], retry_count=0,
            trust_level=None, trust={"verified": pre} if pre else {}, step_history=[],
            otp_attempts=0, created_at=now, updated_at=now, expires_at=now + st["request_ttl_s"]))
    rt = _Rt(sid, runner.o.guest, runner.agent_id)
    rt.url = url
    rt.notes = notes
    _RT[sid] = rt
    _log(sid, "session.created", "ok", origin=origin, reason=notes[0] if notes else None)
    _publish(sid)
    runner._stage("waiting_owner", f"sign-in to {_site(origin)}")
    set_task(runner.task_id, state="WAITING_APPROVAL", requires_approval=True)
    try:
        try:
            await _start(sid, rt)
        except AuthError as e:
            if e.code != "finished":
                await _fail(sid, rt, e.code)
        except Exception:  # noqa: BLE001 - never leave a live broker behind
            log.exception("smart auth start failed")
            with contextlib.suppress(AuthError):
                await _fail(sid, rt, "internal_error")
        await runner._cancellable(_wait_done(sid, rt))
    except asyncio.CancelledError:
        with contextlib.suppress(Exception):
            await cancel(sid, actor="system:task", reason="task_cancelled")
        _RT.pop(sid, None)
        rt.wipe()
        raise
    finally:
        with contextlib.suppress(Exception):
            set_task(runner.task_id, state="EXECUTING", requires_approval=False)
        with contextlib.suppress(Exception):
            # nothing the owner may have typed in Live Desktop stays in a password / code field of the agent's browser
            await runner.o.guest.tool(runner.agent_id, "browser.clear_secrets", {}, timeout=15)
    try:
        return await _tool_result(runner, sid, rt, origin)
    finally:
        _RT.pop(sid, None)
        rt.wipe()


async def _tool_result(runner, sid: str, rt: _Rt, origin: str) -> dict[str, Any]:
    row = _get(sid)
    out = {"status": row["state"].lower(), "origin": row.get("verified_origin") or origin}
    if row["state"] == "AUTHENTICATED":
        page = rt.final_url
        if page:
            try:
                r = await runner.o.guest.tool(runner.agent_id, "browser.navigate", {"url": page}, timeout=60)
                page = ((r.get("result") or {}).get("url") or page) if r.get("ok") else page
            except Exception:  # noqa: BLE001
                pass
        runner.vault_origins.add(row.get("verified_origin") or origin)
        out.update(page=_clean(page), note=(
            "Authentication completed successfully. Your browser now has the signed-in session; continue the "
            "original task. Large web apps (e.g. Microsoft Teams, Outlook) need 10-20 s to render after sign-in: "
            "wait once (browser_wait about 15000 ms) before reading the page instead of many short waits. Changing "
            "passwords or security/MFA settings, payments, deleting the account or exporting data still need the "
            "owner's approval."))
    elif row["state"] == "CANCELLED":
        out["note"] = ("The owner cancelled the sign-in. Do not ask again for this site in this task; continue "
                       "without signing in if possible, otherwise finish and explain.")
    elif row["state"] == "EXPIRED":
        out["note"] = "The owner did not answer in time. Tell the owner the task needs a sign-in."
    else:
        out["status"] = "failed"
        out["reason_code"] = row.get("error_code") or "failed"
        out["note"] = _FAIL_NOTES.get(row.get("error_code") or "", "The sign-in did not complete. Tell the owner.")
    return out


_FAIL_NOTES = {
    "no_login_form": "No sign-in form was found at that URL. Open the site's sign-in page and call request_sign_in "
                     "with that page's URL.",
    "too_many_attempts": "The site rejected the details several times; NEBULA stopped to avoid locking the account. "
                         "Tell the owner.",
    "broker_unavailable": "The isolated sign-in browser is not available right now. Tell the owner.",
    "no_session": "Signed in, but the site keeps its session outside cookies, so it could not be handed to your "
                  "browser. Tell the owner.",
    "site_unreachable": "The site could not be reached from the VM (network or address problem). Tell the owner.",
    "unsupported_embedded_login": "The site's sign-in is embedded from another site; NEBULA does not automate it. "
                                  "Tell the owner.",
    "unsupported_new_password": "The page asks to create or change a password; NEBULA does not automate that. "
                                "Tell the owner.",
    "local_network_destination": "The sign-in continued to a local-network address, which is not allowed. Tell the "
                                 "owner.",
    "form_not_restored": "After the owner allowed where the sign-in form sends its data, the sign-in page could not "
                         "be opened again. Call request_sign_in once more with the same URL.",
    "suspicious_page": "NEBULA blocked the sign-in because the page looks suspicious (possible phishing). Do not "
                       "sign in there; tell the owner.",
    "suspicious_destination": "NEBULA blocked the sign-in because it tried to continue to a suspicious address. Do "
                              "not sign in there; tell the owner.",
    "unsupported_interstitial": "The site showed a prompt NEBULA does not answer. Tell the owner.",
    "broker_memory": "The site's page used more memory than the isolated sign-in browser allows and was closed "
                     "before a sign-in could be confirmed. Tell the owner; they can retry or use Live Desktop.",
    "vm_unreachable": "The NEBULA virtual machine stopped answering during the sign-in. Tell the owner to check that "
                      "the VM is running, then try again.",
    "broker_lost": "The isolated sign-in browser stopped unexpectedly. Tell the owner; trying once more is fine.",
}


def _clean(url: str | None) -> str | None:
    if not url:
        return None
    try:
        p = urlsplit(url)
        return f"{p.scheme}://{p.netloc}{p.path}"[:300]
    except ValueError:
        return None


async def _wait_done(sid: str, rt: _Rt) -> None:
    while not rt.done.is_set():
        row = _get(sid)
        if row["state"] in TERMINAL:
            return
        remaining = row["expires_at"] - _now()
        if remaining <= 0:
            await expire(sid, "request_expired")
            return
        try:
            await asyncio.wait_for(rt.done.wait(), min(remaining, 30))
        except TimeoutError:
            continue


# ============================================================================ broker interaction
async def _guest(rt: _Rt, method: str, params: dict[str, Any], timeout: float) -> dict[str, Any]:
    params = {"session_id": rt.sid, "agent_id": rt.agent_id, **params}
    try:
        res = await rt.guest.call(method, params, timeout=timeout)
    except Exception as e:  # noqa: BLE001 - never echo params; the type is enough
        return {"event": "error", "detail": f"rpc_{type(e).__name__}"[:40]}
    finally:
        if "values" in params:
            vals = params["values"]
            for k in list(vals):
                vals[k] = ""
            vals.clear()
    return res if isinstance(res, dict) else {"event": "error", "detail": "rpc_bad_response"}


async def _start(sid: str, rt: _Rt) -> None:
    from nebula_host import auth_trust

    row = _get(sid)
    st = settings()
    ev: dict[str, Any] = {}
    req = row["requested_origin"]
    for attempt in range(st["max_retries"] + 1):
        ev = await _guest(rt, "vault.auth_start", {"origin": req, "allowed_origins": row["allowed_origins"],
                                                   "url": rt.url, "timeout_s": st["session_max_s"],
                                                   "cookie_origins": auth_trust.cookie_origins(req),
                                                   "session_cookies": auth_trust.session_cookie_names(req),
                                                   "passkey_fallback": st["passkey_fallback"],
                                                   "auth_origins": auth_trust.auth_origins(req),
                                                   "host_id": host_instance_id()}, 200)
        if ev.get("event") != "error" or ev.get("detail") not in ("broker_exited", "broker_timeout") and \
                not str(ev.get("detail", "")).startswith("rpc_"):
            break
        _log(sid, "broker.retry", "error", attempt=attempt + 1, error_code=str(ev.get("detail"))[:40])
        with db.engine().begin() as c:
            c.execute(update(models.auth_sessions).where(models.auth_sessions.c.id == sid)
                      .values(retry_count=models.auth_sessions.c.retry_count + 1))
    await _apply(sid, rt, ev, initial=True)


def _trust_public(t: dict[str, Any] | None) -> dict[str, Any] | None:
    from nebula_host import auth_trust

    if not t:
        return None
    rel = t.get("relationship") or None
    return {"level": t.get("level"), "reasons": [{"code": r, "text": auth_trust.public_reason(r)}
                                                 for r in (t.get("reasons") or [])][:6],
            "provider": rel.get("name") if rel else None, "hard": bool(t.get("hard"))}


def _alt_kinds(step: dict[str, Any]) -> list[str]:
    return [a["kind"] for a in step.get("alternatives") or []]


async def _apply(sid: str, rt: _Rt, ev: dict[str, Any], *, initial: bool = False,
                 submitted_kind: str | None = None, from_watcher: bool = False) -> None:
    """Turn one broker event into the next state / owner request. The step always comes from the page the broker
    is on right now (never assumed from the previous step or the domain)."""
    from nebula_host import auth_trust

    row = _get(sid)
    if row["state"] in TERMINAL:
        return
    kind = ev.get("event")
    st = settings()
    tinfo = dict(row.get("trust") or {})
    if kind == "step":
        seq = int(ev.get("step_id") or 0) if isinstance(ev.get("step_id"), int) else 0
        if rt.step_id and seq and seq < rt.step_id:
            # an older reading of the page (e.g. the watcher's) arrived after a newer one: it never wins
            _log(sid, "step.stale_ignored", "ok", step_id=seq)
            return None
        try:
            step = _valid_step(ev.get("step"), row["allowed_origins"])
        except AuthError as e:
            _log(sid, "detection.failed", "error", error_code=e.code, diag=ev.get("diag"))
            return await _fail(sid, rt, e.code)
        if step["page_origin"] and is_local_network_origin(step["page_origin"]):
            # only reachable when the owner allowed local-network sign-ins: always reviewed, never HIGH
            step["flags"] = sorted(set(step["flags"]) | {"local_network"})
            if step["confidence"] == "HIGH":
                step["confidence"] = "MEDIUM"
        trust = auth_trust.classify_step(row["requested_origin"], step, allow_local=st["allow_local_network"],
                                         owner_allowed=list(tinfo.get("confirmed") or []))
        err = ev.get("error") if ev.get("error") in ("rejected", "no_progress", "page_changed") else None
        before = rt.step or {}
        auto = [a for a in (ev.get("auto") or []) if a in AUTO_NOTES] if isinstance(ev.get("auto"), list) else []
        _log(sid, "step.detected", "ok", step=step["step"], origin=step["page_origin"], step_id=seq,
             confidence=step["confidence"], diag=ev.get("diag"), auto=auto, reason=err, timing=ev.get("timing"))
        if before and before.get("fingerprint") != step["fingerprint"]:
            _log(sid, "step.changed", "ok", from_step=before.get("step"), step=step["step"])
        if before and before.get("page_origin") != step["page_origin"]:
            _log(sid, "origin.changed", "ok", from_origin=before.get("page_origin"), origin=step["page_origin"])
        rt.step, rt.step_id = step, seq
        rt.steps += 1
        if auto:
            rt.notes = sorted(set(rt.notes) | set(auto))
        hist = list(row.get("step_history") or [])[-19:] + [
            {"fp": step["fingerprint"], "step": step["step"], "origin": step["page_origin"], "error": err,
             "trust": trust["level"], "at": round(_now(), 1)}]
        vals: dict[str, Any] = {"verified_origin": step["page_origin"], "current_step": step["step"],
                                "confidence": step["confidence"], "flags": step["flags"],
                                "trust_level": trust["level"], "step_history": hist,
                                "trust": {**tinfo, "reasons": trust["reasons"], "relationship": trust["relationship"],
                                          "hard": trust["hard"]}}
        if trust["level"] == auth_trust.RED:
            _log(sid, "trust.blocked", "error", origin=step["page_origin"], flags=trust["reasons"])
            return await _fail(sid, rt, "suspicious_page", **vals)
        # loop guard: the page answered with the very step the owner just answered, without an error
        if submitted_kind or row["state"] in ("SUBMITTING", "VERIFYING"):
            same = bool(step["fingerprint"]) and step["fingerprint"] == rt.submitted_fp
            if err == "no_progress" or (same and err is None):
                rt.no_progress += 1
            elif err != "rejected":
                rt.no_progress = 0
        if rt.no_progress >= st["loop_threshold"] or rt.steps > st["max_steps"]:
            return await _loop(sid, rt, vals, reason="no_progress" if rt.no_progress >= st["loop_threshold"]
                               else "too_many_steps")
        rejected = err == "rejected"
        if rejected:
            if step["step"] in CODE_STEPS:
                n = row["otp_attempts"] + 1
                vals["otp_attempts"] = n
                if n >= st["max_otp_attempts"]:
                    return await _fail(sid, rt, "too_many_attempts", **vals)
            else:
                n = row["retry_count"] + 1
                vals["retry_count"] = n
                if n >= st["max_credential_attempts"]:
                    return await _fail(sid, rt, "too_many_attempts", **vals)
            rt.saved_entry = None if step["step"] in CREDENTIAL_STEPS else rt.saved_entry
            vals["error_code"] = "code_rejected" if step["step"] in CODE_STEPS else "credentials_rejected"
        else:
            vals["error_code"] = err  # page_changed | no_progress | None
        if row["state"] == "SUBMITTING":
            _transition(sid, "VERIFYING")
        k = step["step"]
        tpub = _trust_public(trust)
        base = {"step": k, "confidence": step["confidence"], "flags": step["flags"], "trust": tpub,
                "review_required": trust["level"] != auth_trust.GREEN, "error": vals.get("error_code"),
                "alternatives": _alt_kinds(step), "page_origin": step["page_origin"],
                "requirement": state_for(step), "notes": list(rt.notes)}
        notify = not from_watcher
        # the site said the details were wrong: the same form again, in the LOGIN_ERROR state (fields unchanged)
        wait_state = "LOGIN_ERROR" if rejected else state_for(step)
        if k in CREDENTIAL_STEPS:
            if not rejected and err is None and await _auto_fill(sid, rt, step, vals):
                return
            _new_request(sid, "credentials", {**base, "fields": step["fields"]}, wait_state, notify=notify, **vals)
            _start_watcher(sid, rt)
        elif k in CODE_STEPS:
            schema = {**base, "fields": step["fields"], "otp": step["otp"], "code_ttl_s": st["otp_ttl_s"],
                      "review_required": trust["level"] != auth_trust.GREEN or step["confidence"] == "LOW"}
            _new_request(sid, k if k == "recovery_code" else "otp", schema, wait_state, notify=notify, **vals)
            _start_watcher(sid, rt)
        elif k == "device_approval":
            # a number to type into the owner's authenticator app is shown only for a provider's own sign-in host or
            # a site the owner verified: an arbitrary page could relay a real provider's number to the owner
            num = step.get("approval_number") if (auth_trust.is_auth_host(step["page_origin"] or "") or
                                                  auth_trust._owner_verified(step["page_origin"] or "")) else None
            if step.get("approval_number") and num is None:
                base = {**base, "notes": [*base["notes"], "approval_number_hidden"]}
            _new_request(sid, "device_approval", {**base, "approval_number": num}, "AUTHENTICATOR_APPROVAL",
                         notify=notify, **vals)
            _start_poller(sid, rt)
        elif k in KEY_STEPS:
            # a passkey / physical security key: this isolated browser has none (checked: no platform authenticator,
            # no USB/NFC, no Bluetooth), so it can never finish here. The broker already cancelled a pending request
            # and chose "use your password" where the page offered it (owner setting). With other ways left on the
            # page the owner picks one; with none, the page is handed to Live Desktop
            if step["alternatives"]:
                _new_request(sid, "manual", {**base, "kind": k, "live_desktop": True, "can_complete_here": False,
                                             "webauthn": step.get("webauthn")}, wait_state, notify=notify, **vals)
                _start_watcher(sid, rt)
            else:
                await _handoff(sid, rt, k, {**vals, "_notes": list(rt.notes)})
        elif k == "captcha":
            if step["alternatives"]:  # the owner may finish another way or in Live Desktop
                _new_request(sid, "manual", {**base, "kind": k, "live_desktop": True}, wait_state, notify=notify,
                             **vals)
                _start_watcher(sid, rt)
            else:
                await _handoff(sid, rt, k, vals)  # no secret is typed for these: the owner finishes them
        elif k == "unknown":
            # still a sign-in page, but nothing NEBULA recognises: never assumed, never treated as success
            _log(sid, "detection.unknown", "error", diag=ev.get("diag"), origin=step["page_origin"])
            _new_request(sid, "manual", {**base, "kind": "unknown", "live_desktop": True}, "UNKNOWN_STEP",
                         notify=notify, **vals)
            _start_watcher(sid, rt)
        elif k == "method_choice":
            _new_request(sid, "method_choice", base, "WAITING_FOR_USER", notify=notify, **vals)
            _start_watcher(sid, rt)
        elif k == "interstitial":
            await _handoff(sid, rt, "interstitial", vals)  # a prompt NEBULA does not answer on its own
        elif k in MANUAL_STEPS:
            # embedded third-party sign-ins / password creation would make the owner type a secret into the
            # agent's own browser: not offered
            await _fail(sid, rt, f"unsupported_{k}", **vals)
        elif k == "none" and initial:
            await _fail(sid, rt, "no_login_form", **vals)
        else:  # "none"/"authenticated" after a step: treat as done only via the broker's result event
            await _fail(sid, rt, "unexpected_page", **vals)
        return
    if kind in ("redirect", "blocked"):
        to = ev.get("origin")
        if not isinstance(to, str) or not re.match(r"^https?://[a-z0-9.\-\[\]:]{1,253}$", to):
            return await _fail(sid, rt, "redirect_blocked")
        if len(row["allowed_origins"]) >= 6:
            return await _fail(sid, rt, "too_many_destinations")
        try:
            vaultmod.canonical_origin(to)
            vaultmod._check_grant_origins([to])
        except vaultmod.VaultError:
            return await _fail(sid, rt, "insecure_destination")
        exfil = kind == "blocked" and ev.get("reason") == "exfiltration"
        dt = auth_trust.classify_origin(row["requested_origin"], to, allow_local=st["allow_local_network"])
        if exfil:
            dt = {**dt, "level": auth_trust.RED, "reasons": sorted({*dt["reasons"], "credential_exfiltration"}),
                  "hard": True}
        if row["state"] == "SUBMITTING":
            _transition(sid, "VERIFYING")
        same_site = _site_of(_site(to)) == _site_of(_site(row["requested_origin"]))
        rt.blocked_origin = to
        if kind == "blocked" and rt.pending:
            rt.pending_until = _now() + st["otp_ttl_s"]
        else:
            if rt.pending:
                rt.pending.clear()
            rt.pending = None
        tvals = {"trust_level": dt["level"], "trust": {**tinfo, "reasons": dt["reasons"],
                                                      "relationship": dt["relationship"], "hard": dt["hard"]}}
        if dt["level"] == auth_trust.RED:
            if not dt["hard"] and rt.pending:
                pass  # lookalike destinations never receive the pending values either
            _log(sid, "trust.blocked", "error", to=to, flags=dt["reasons"])
            return await _fail(sid, rt, "suspicious_destination", **tvals)
        if dt["level"] == auth_trust.GREEN:
            # verified provider relationship (e.g. Teams -> login.microsoftonline.com): no question, no warning
            _log(sid, "destination.verified", "ok", to=to, method=(dt["relationship"] or {}).get("provider"))
            with db.engine().begin() as c:
                c.execute(update(models.auth_sessions).where(models.auth_sessions.c.id == sid).values(**tvals))
            _spawn(rt, _auto_allow(sid, rt, to))
            return
        schema = {"step": "destination", "destination": to, "kind": "form_target" if kind == "blocked" else "redirect",
                  "same_site": same_site, "requested_origin": row["requested_origin"],
                  "secrets_pending": bool(kind == "blocked" and rt.pending), "review_required": True,
                  "confidence": "MEDIUM" if same_site else "LOW", "trust": _trust_public(dt)}
        _new_request(sid, "confirm_destination", schema, "REDIRECT_REVIEW_REQUIRED", current_step="destination",
                     flags=sorted(set(row["flags"] or []) | {"other_site" if not same_site else "origin_changed"}),
                     notify=not from_watcher, **tvals)
        return
    if kind == "result":
        status = ev.get("status")
        if status == "authenticated":
            if not ev.get("cookies_imported"):
                return await _fail(sid, rt, "no_session")
            rt.final_url = ev.get("final_url") if isinstance(ev.get("final_url"), str) else None
            evidence = ev.get("evidence") if ev.get("evidence") in EVIDENCE else None
            if evidence is None:
                # V3.4: success needs the broker's positive evidence; without it the owner checks it instead
                _log(sid, "success.unproven", "error")
                status = "unconfirmed"
            else:
                _log(sid, "success.confirmed", "ok", evidence=evidence,
                     auto=[a for a in (ev.get("auto") or []) if a in AUTO_NOTES])
                return await _authenticated(sid, rt, method=None)
        if status == "unconfirmed":
            # the page changed but NEBULA has no positive evidence of a sign-in (could be an error / locked page):
            # the owner checks it in Live Desktop; nothing is saved to the vault on this path
            rt.final_url = ev.get("final_url") if isinstance(ev.get("final_url"), str) else None
            if row["state"] == "SUBMITTING":
                _transition(sid, "VERIFYING")
            if rt.final_url:
                with contextlib.suppress(Exception):
                    await rt.guest.tool(rt.agent_id, "browser.navigate", {"url": rt.final_url}, timeout=60)
            rt.collected.clear()
            rt.save = None
            _new_request(sid, "manual", {"step": "unconfirmed", "kind": "unconfirmed", "live_desktop": True,
                                         "confidence": row.get("confidence"), "flags": row.get("flags") or []},
                         "WAITING_FOR_USER", auth_method="manual")
            return None
        if status == "cancelled":
            return None  # the owner cancelled while the broker was working: nothing reached the agent
        _log(sid, "stopped", "error", reason=str(status)[:24], diag=ev.get("diag"))
        return await _fail(sid, rt, {"no_login_form": "no_login_form", "origin_mismatch": "origin_mismatch",
                                     "no_session": "no_session", "timeout": "broker_timeout",
                                     "unreachable": "site_unreachable", "form_lost": "form_not_restored",
                                     "page_crashed": "broker_memory"}.get(str(status), "broker_error"))
    detail = str(ev.get("detail") or "")
    if detail in ("agent_busy", "broker_busy"):
        return await _fail(sid, rt, "busy")
    if detail == "broker_not_isolated":
        return await _fail(sid, rt, "broker_unavailable")
    if detail in ("stale_step", "page_changed") and rt.step is not None and row["state"] in ("SUBMITTING",):
        _transition(sid, "VERIFYING")
        return await _apply(sid, rt, {"event": "step", "step_id": rt.step_id, "step": rt.step, "error": "page_changed"})
    if detail.startswith("rpc_") and row["state"] == "INITIALIZING":
        return await _fail(sid, rt, "vm_unreachable")
    return await _fail(sid, rt, "broker_lost" if detail.startswith(("broker_", "rpc_")) else "broker_error")


async def _loop(sid: str, rt: _Rt, vals: dict[str, Any], *, reason: str) -> None:
    """Automatic submission stops; the session is kept; the owner decides: Retry, Live Desktop or Cancel."""
    rt.no_progress = 0
    rt.steps = 0
    _log(sid, "loop.detected", "error", error_code=reason, step=vals.get("current_step"))
    row = _get(sid)
    if row["state"] == "SUBMITTING":
        _transition(sid, "VERIFYING")
    _new_request(sid, "loop", {"step": "loop", "reason": reason, "page_step": vals.get("current_step"),
                               "live_desktop": True, "trust": _trust_public({**(vals.get("trust") or {}),
                                                                             "level": vals.get("trust_level")})},
                 "WAITING_FOR_USER", **{**vals, "error_code": f"loop_{reason}"[:48]})


async def _resume_destination(sid: str, rt: _Rt, dest: str, origins: list[str], pending: dict[str, str] | None) -> None:
    """Continue after a destination was allowed (by the owner, or verified): the broker returns to the blocked
    navigation / form, and the SAME values are sent once more (memory only, mapped by role onto the same kind of
    step — never by position)."""
    try:
        async with rt.lock:
            row = _get(sid)
            if row["state"] != "SUBMITTING":
                _transition(sid, "SUBMITTING")
            _publish(sid)
            ev = await _guest(rt, "vault.auth_allow", {"origins": [dest], "resume": True}, 150)
            if pending and ev.get("event") == "step" and rt.blocked_origin:
                step = _valid_step(ev.get("step"), origins)
                rt.step, rt.step_id = step, int(ev.get("step_id") or 0)
                roles = [f["role"] for f in step["fields"]]
                if step["step"] == rt.pending_step and roles and set(roles) == set(pending):
                    vals = {f["id"]: pending[f["role"]] for f in step["fields"]}
                    rt.submitted_fp = step.get("fingerprint")
                    ev = await _guest(rt, "vault.auth_step", {"step_id": rt.step_id, "values": vals}, 150)
            rt.blocked_origin = None
            if rt.pending:
                for k in list(rt.pending):
                    rt.pending[k] = ""
            rt.pending = None
        await _apply(sid, rt, ev, submitted_kind="destination")
    except AuthError as e:
        if e.code != "finished":
            with contextlib.suppress(AuthError):
                await _fail(sid, rt, e.code)


async def _auto_allow(sid: str, rt: _Rt, dest: str) -> None:
    row = _get(sid)
    origins = sorted(set(row["allowed_origins"]) | {dest})
    tinfo = dict(row.get("trust") or {})
    tinfo["verified"] = sorted(set(tinfo.get("verified") or []) | {dest})
    with db.engine().begin() as c:
        c.execute(update(models.auth_sessions).where(models.auth_sessions.c.id == sid)
                  .values(allowed_origins=origins, trust=tinfo))
    pending = rt.pending if (rt.pending and _now() <= rt.pending_until) else None
    await _resume_destination(sid, rt, dest, origins, pending)


async def _choose(sid: str, rt: _Rt, alt_id: str) -> None:
    try:
        async with rt.lock:
            _transition(sid, "SUBMITTING")
            _publish(sid)
            rt.submitted_fp = (rt.step or {}).get("fingerprint")
            ev = await _guest(rt, "vault.auth_choose", {"alt_id": alt_id}, 120)
        await _apply(sid, rt, ev, submitted_kind="choose")
    except AuthError as e:
        if e.code != "finished":
            with contextlib.suppress(AuthError):
                await _fail(sid, rt, e.code)


async def _reload(sid: str, rt: _Rt) -> None:
    try:
        async with rt.lock:
            _transition(sid, "SUBMITTING")
            _publish(sid)
            ev = await _guest(rt, "vault.auth_reload", {}, 150)
        rt.submitted_fp, rt.no_progress, rt.steps = None, 0, 0
        await _apply(sid, rt, ev, initial=True)
    except AuthError as e:
        if e.code != "finished":
            with contextlib.suppress(AuthError):
                await _fail(sid, rt, e.code)


def _start_watcher(sid: str, rt: _Rt) -> None:
    """While the owner's form is open: re-detect the broker's page now and then; if it changed (single-page flows,
    time-outs, a site moving on by itself), replace the request so the dialog updates and a stale answer is refused.
    Internal host<->VM call only (no client polling); skipped while a submission runs."""
    async def loop() -> None:
        while True:
            await asyncio.sleep(settings()["observe_interval_s"])
            try:
                row = _get(sid)
            except AuthError:
                return
            if row["state"] not in OWNER_WAIT or row["state"] == "AUTHENTICATOR_APPROVAL" or \
                    row["expires_at"] <= _now():
                return
            if rt.lock.locked():
                continue
            async with rt.lock:
                row = _get(sid)
                if row["state"] not in OWNER_WAIT:
                    return
                ev = await _guest(rt, "vault.auth_observe", {}, 70)
            if ev.get("event") == "step" and not ev.get("changed"):
                continue
            if ev.get("event") == "error":
                if str(ev.get("detail") or "").startswith(("broker_", "rpc_")):
                    with contextlib.suppress(AuthError):
                        await _fail(sid, rt, "broker_lost")
                    return
                continue
            row = _get(sid)
            if row["state"] not in OWNER_WAIT:
                return
            _log(sid, "page.changed", "ok", step=(ev.get("step") or {}).get("step"))
            try:
                await _apply(sid, rt, ev, from_watcher=True)
            except AuthError:
                return

    if rt.watcher is None or rt.watcher.done():
        rt.watcher = asyncio.ensure_future(loop())
        rt.bg.add(rt.watcher)
        rt.watcher.add_done_callback(rt.bg.discard)


async def _auto_fill(sid: str, rt: _Rt, step: dict[str, Any], vals: dict[str, Any]) -> bool:
    """Continue without asking when the owner already chose a saved account in this session, or the agent holds an
    owner-made grant with the 'auto' policy for exactly this origin."""
    row = _get(sid)
    if vaultmod.VAULT.locked:
        return False
    entry_id, method = rt.saved_entry, "saved"
    if entry_id is None:
        if row["step_seq"] != 0 or len(row["allowed_origins"]) != 1:
            return False
        for g in _usable_grants(rt.agent_id):
            if row["requested_origin"] in g["origins"] and g["ref"].startswith("vg_"):
                gr = next((x for x in vaultmod.VAULT.grants(rt.agent_id) if x["id"] == g["ref"]), None)
                if gr and gr.get("approval_policy") == "auto" and gr["allowed_origins"] == [row["requested_origin"]]:
                    entry_id, method = gr["entry_id"], "grant_auto"
                    break
        if entry_id is None:
            return False
        try:
            b = vaultmod.VAULT.authorize(agent_id=rt.agent_id, ref=g["ref"], origin=row["requested_origin"],
                                         operation="sign_in", task_id=row["task_id"])
        except vaultmod.VaultDenied:
            return False
        if b["policy"] != "auto":
            return False
    try:
        values = _saved_values(entry_id, row, step)
    except AuthError:
        return False
    _transition(sid, "SUBMITTING", auth_method=method, entry_id=entry_id,
                expires_at=row["created_at"] + settings()["session_max_s"], **vals)
    _publish(sid)
    vaultmod.record("agent:" + rt.agent_id if method == "grant_auto" else "owner:smart_auth", "use.smart_sign_in",
                    outcome="ok", agent_id=rt.agent_id, entry_id=entry_id, task_id=row["task_id"],
                    origin=step["page_origin"], reason=method)
    rt.saved_entry = entry_id
    _spawn(rt, _fill(sid, rt, values))
    return True


def _saved_values(entry_id: str, row: dict[str, Any], step: dict[str, Any]) -> dict[str, str]:
    """Decrypt a saved credential for the broker only (exact origin binding)."""
    if vaultmod.VAULT.locked:
        raise AuthError("vault_locked", "Your Vault is locked. Unlock it to use saved credentials.", 409)
    try:
        entry = vaultmod.VAULT._entry_row(entry_id)
    except vaultmod.VaultError:
        raise AuthError("entry_not_found", "that saved account no longer exists", 404) from None
    if entry.get("credential_type") != "website" or entry.get("origin") not in (row.get("allowed_origins") or []):
        raise AuthError("origin_mismatch", "that saved account is for another site", 409)
    if step.get("page_origin") != entry["origin"]:  # never type a saved credential on another origin
        raise AuthError("origin_mismatch", "this step is on another site than the saved account; enter it yourself",
                        409)
    try:
        cred = vaultmod.VAULT.credential_for_broker({"entry_id": entry_id, "allowed_origins": [entry["origin"]],
                                                     "origin": entry["origin"]})
    except vaultmod.VaultError as e:
        raise AuthError(e.code, str(e), 409) from None
    try:
        out: dict[str, str] = {}
        for f in step["fields"]:
            if f["role"] in IDENTIFIER_ROLES:
                if not cred["username"]:
                    raise AuthError("incomplete_entry", "the saved account has no user name", 409)
                out[f["id"]] = cred["username"]
            elif f["role"] == "password":
                if not cred["password"]:
                    raise AuthError("incomplete_entry", "the saved account has no password", 409)
                out[f["id"]] = cred["password"]
            else:
                raise AuthError("not_fillable", "a saved account cannot answer this step", 409)
        return out
    finally:
        cred.clear()


def _spawn(rt: _Rt, coro) -> None:
    t = asyncio.ensure_future(coro)
    rt.bg.add(t)
    t.add_done_callback(rt.bg.discard)


async def _fill(sid: str, rt: _Rt, values: dict[str, str]) -> None:
    async with rt.lock:
        try:
            ev = await _guest(rt, "vault.auth_step", {"step_id": rt.step_id, "values": values}, 150)
        finally:
            for k in list(values):
                values[k] = ""
            values.clear()
        try:
            await _apply(sid, rt, ev)
        except AuthError as e:
            if e.code != "finished":
                log.warning("smart auth apply failed: %s", e.code)
        except Exception:  # noqa: BLE001
            log.exception("smart auth step failed")
            with contextlib.suppress(AuthError):
                await _fail(sid, rt, "internal_error")


def _start_poller(sid: str, rt: _Rt) -> None:
    async def loop() -> None:
        while True:
            row = _get(sid)
            if row["state"] != "AUTHENTICATOR_APPROVAL" or row["expires_at"] <= _now():
                return
            async with rt.lock:
                ev = await _guest(rt, "vault.auth_poll", {"wait_s": 25}, 80)
                if ev.get("event") == "step" and ev.get("still_waiting"):
                    continue
                row = _get(sid)
                if row["state"] != "AUTHENTICATOR_APPROVAL":
                    return
                _transition(sid, "VERIFYING")
                try:
                    await _apply(sid, rt, ev)
                except AuthError:
                    pass
                return

    if rt.poller is None or rt.poller.done():
        rt.poller = asyncio.ensure_future(loop())
        rt.bg.add(rt.poller)
        rt.poller.add_done_callback(rt.bg.discard)


async def _handoff(sid: str, rt: _Rt, kind: str, vals: dict[str, Any]) -> None:
    """A step only a human can do (CAPTCHA, passkey, embedded/other sign-in): the broker hands its session state to
    the agent's browser, the page opens there and the owner finishes it in Live Desktop."""
    ev = await _guest(rt, "vault.auth_handoff", {}, 60)
    page = ev.get("final_url") if ev.get("event") == "result" and ev.get("status") == "handoff" else None
    if page:
        with contextlib.suppress(Exception):
            await rt.guest.tool(rt.agent_id, "browser.navigate", {"url": page}, timeout=60)
    elif rt.url:
        with contextlib.suppress(Exception):
            await rt.guest.tool(rt.agent_id, "browser.navigate", {"url": rt.url}, timeout=60)
    notes = vals.pop("_notes", None) or []
    _new_request(sid, "manual", {"step": kind, "kind": kind, "live_desktop": True, "notes": notes,
                                 "can_complete_here": kind not in KEY_STEPS,
                                 "confidence": vals.get("confidence"), "flags": vals.get("flags") or [],
                                 "trust": _trust_public({**(vals.get("trust") or {}),
                                                         "level": vals.get("trust_level")}) if vals.get("trust_level")
                                 else None},
                 STEP_STATE.get(kind, "WAITING_FOR_USER") if kind in (*KEY_STEPS, "captcha") else "WAITING_FOR_USER",
                 auth_method="manual", **vals)


async def _authenticated(sid: str, rt: _Rt, *, method: str | None) -> None:
    row = _get(sid)
    note = None
    if rt.save and row.get("save_mode") == "vault":
        note = "not_saved_unconfirmed" if method == "manual" else _save_to_vault(row, rt)
    vals: dict[str, Any] = {"error_code": note}
    if method:
        vals["auth_method"] = method
    if row["state"] == "SUBMITTING":
        _transition(sid, "VERIFYING")
    with db.engine().begin() as c:
        _close_requests(sid, "done", c)
        _transition(sid, "AUTHENTICATED", c=c, **vals)
    _log(sid, "session.authenticated", "ok", method=method or row.get("auth_method"), origin=row.get("verified_origin"))
    if row.get("entry_id"):
        vaultmod.record("owner:smart_auth", "use.smart_sign_in", outcome="ok", agent_id=row["agent_id"],
                        entry_id=row["entry_id"], task_id=row["task_id"], origin=row.get("verified_origin"),
                        reason="authenticated")
    rt.wipe()
    rt.done.set()
    _publish(sid)


def _save_to_vault(row: dict[str, Any], rt: _Rt) -> str | None:
    """Explicit owner choice only, after a VERIFIED successful sign-in; returns a note code when saving was not
    possible. The identifier and password may come from different pages (e-mail, then password): they are saved
    together as ONE credential bound to the exact origin the password was typed on. It is linked to the service the
    agent asked for only when that origin is the service itself or one of its verified sign-in providers — never to
    an unrelated identity provider or site. Codes are never collected, so never saved."""
    from nebula_host import auth_trust

    save, got, where = rt.save or {}, dict(rt.collected), dict(rt.collected_origins)
    rt.collected.clear()
    rt.collected_origins.clear()
    try:
        if not got.get("password"):
            return "not_saved_incomplete"
        if vaultmod.VAULT.locked:
            return "not_saved_vault_locked"
        req_o = row["requested_origin"]
        origin = where.get("password") or req_o
        if origin not in (row.get("allowed_origins") or []):
            return "not_saved_origin"
        rel = auth_trust.relationship(req_o, origin) if origin != req_o else None
        service = req_o if (origin == req_o or rel) else None
        uo = where.get("username")
        if uo and uo != origin and not (uo == req_o or auth_trust.relationship(origin, uo) or
                                        auth_trust.relationship(req_o, uo)):
            got.pop("username", None)  # an identifier typed on an unrelated site is not combined with it
        name = save.get("name") or (_site(service or origin) + (f" ({rel['name']})" if rel else ""))
        kind = rt.collected_kind if rt.collected_kind in ("email", "username", "phone") else None
        tags = ["smart-sign-in"] + ([rel["provider"]] if rel and rel.get("provider") != "owner" else []) + \
            ([f"login-{kind}"] if kind and got.get("username") else [])
        actor = save.get("actor") or "owner:smart_auth"
        same = vaultmod.VAULT.match_entry(origin, got.get("username", ""))
        if same:
            # the same account again (same origin + username): its password is updated after this verified sign-in;
            # a different username on the same service stays a separate credential
            e = vaultmod.VAULT.update_entry(same, {"password": got["password"]}, actor=actor)
            _log(row["id"], "vault.updated", "ok", method="vault", origin=origin)
        else:
            e = vaultmod.VAULT.add_entry({"credential_type": "website", "display_name": name[:200], "origin": origin,
                                          "app_name": _site(service) if service and service != origin else "",
                                          "tags": tags, "username": got.get("username", ""),
                                          "password": got["password"],
                                          "login_url": _clean(rt.url) if rt.url and vaultmod.same_origin(rt.url, origin)
                                          else None}, actor=actor)
        with db.engine().begin() as c:
            c.execute(update(models.auth_sessions).where(models.auth_sessions.c.id == row["id"])
                      .values(entry_id=e["id"]))
        row["entry_id"] = e["id"]
        if save.get("allow_future"):
            grant_origins = sorted({origin, *([service] if service else [])})
            if vaultmod.VAULT.agent_policy(row["agent_id"])["mode"] == "NONE":
                vaultmod.VAULT.set_agent_mode(row["agent_id"], "SELECTED", None, actor=save.get("actor") or "owner")
            try:
                vaultmod.VAULT.create_grant(row["agent_id"], e["id"], origins=grant_origins, actions=["sign_in"],
                                            policy="always_ask", actor=save.get("actor") or "owner")
            except vaultmod.VaultError as gx:
                if not same:  # an updated account may already have this agent's grant
                    raise
                _log(row["id"], "vault.grant_kept", "ok", error_code=gx.code)
        _log(row["id"], "vault.saved", "ok", method="vault", origin=origin)
        return None
    except vaultmod.VaultError as ex:
        _log(row["id"], "vault.saved", "error", error_code=ex.code)
        return f"not_saved_{ex.code}"[:48]
    finally:
        for k in list(got):
            got[k] = ""


async def _fail(sid: str, rt: _Rt | None, code: str, **vals: Any) -> None:
    vals.pop("error_code", None)
    try:
        with db.engine().begin() as c:
            _close_requests(sid, "cancelled", c)
            _transition(sid, "FAILED", c=c, error_code=code[:48], **vals)
    except AuthError as e:
        if e.code == "finished":
            return
        raise
    _log(sid, "session.failed", "error", error_code=code)
    if rt is not None:
        await _guest(rt, "vault.auth_cancel", {}, 20)
        rt.wipe()
        rt.done.set()
    _publish(sid)


async def cancel(sid: str, *, actor: str, reason: str = "owner_cancelled") -> dict[str, Any]:
    row = _get(sid)
    if row["state"] in TERMINAL:
        return public(row)
    rt = _rt(sid)
    try:
        with db.engine().begin() as c:
            _close_requests(sid, "cancelled", c)
            _transition(sid, "CANCELLED", c=c, error_code=reason[:48])
    except AuthError as e:
        if e.code != "finished":
            raise
    _log(sid, "session.cancelled", "ok", error_code=reason, actor_type=_actor_type(actor))
    if rt is not None:
        await _guest(rt, "vault.auth_cancel", {}, 20)
        rt.wipe()
        rt.done.set()
    _publish(sid)
    return public(_get(sid))


async def expire(sid: str, reason: str = "request_expired") -> None:
    rt = _rt(sid)
    try:
        with db.engine().begin() as c:
            _close_requests(sid, "expired", c)
            _transition(sid, "EXPIRED", c=c, error_code=reason[:48])
    except AuthError:
        return
    _log(sid, "session.expired", "expired", error_code=reason)
    if rt is not None:
        await _guest(rt, "vault.auth_cancel", {}, 20)
        rt.wipe()
        rt.done.set()
    _publish(sid)


async def expire_due() -> int:
    """Called periodically: close sessions whose owner request ran out (releases broker + paused task)."""
    with db.engine().connect() as c:
        ids = [r.id for r in c.execute(select(models.auth_sessions.c.id).where(and_(
            models.auth_sessions.c.state.notin_(list(TERMINAL)), models.auth_sessions.c.expires_at < _now())))]
    for sid in ids:
        await expire(sid)
    return len(ids)


def recover() -> int:
    """Host start: nothing secret survived the restart, so every open session needs fresh owner input."""
    now = _now()
    with db.engine().begin() as c:
        ids = [r.id for r in c.execute(select(models.auth_sessions.c.id).where(
            models.auth_sessions.c.state.notin_(list(TERMINAL))))]
        if ids:
            c.execute(update(models.auth_requests).where(and_(models.auth_requests.c.auth_session_id.in_(ids),
                                                              models.auth_requests.c.status == "open"))
                      .values(status="expired", resolved_at=now, token_hash=None))
            c.execute(update(models.auth_sessions).where(models.auth_sessions.c.id.in_(ids))
                      .values(state="EXPIRED", error_code="service_restarted", updated_at=now, completed_at=now))
    for sid in ids:
        _log(sid, "session.expired", "expired", error_code="service_restarted")
    _RT.clear()
    return len(ids)


# ============================================================================ owner side (API)
def _attempts(row: dict[str, Any]) -> dict[str, Any]:
    st = settings()
    return {"credentials": row["retry_count"], "codes": row["otp_attempts"],
            "max_credentials": st["max_credential_attempts"], "max_codes": st["max_otp_attempts"]}


def public(row: dict[str, Any], *, detail: bool = False, local: bool = True, fresh: bool | None = None,
           owner: bool = True) -> dict[str, Any]:
    origin = row.get("verified_origin") or row["requested_origin"]
    state = LEGACY_STATES.get(row["state"], row["state"])
    tinfo = row.get("trust") or {}
    out = {"id": row["id"], "state": state, "agent_id": row["agent_id"], "agent_name": _agent_name(row["agent_id"]),
           "task_id": row["task_id"], "conversation_id": row.get("conversation_id"),
           "requested_origin": row["requested_origin"], "verified_origin": row.get("verified_origin"),
           "site": _site(origin), "allowed_origins": list(row.get("allowed_origins") or []),
           "step": row.get("current_step"), "step_seq": row.get("step_seq"), "confidence": row.get("confidence"),
           "flags": list(row.get("flags") or []), "auth_method": row.get("auth_method"),
           "error_code": row.get("error_code"), "created_at": row["created_at"], "updated_at": row["updated_at"],
           "expires_at": row["expires_at"], "completed_at": row.get("completed_at"),
           "attempts": _attempts(row), "saved_to_vault": bool(row.get("entry_id") and row.get("save_mode") == "vault"),
           "trust": _trust_public({**tinfo, "level": row.get("trust_level")}) if row.get("trust_level") else None,
           "steps_seen": len(row.get("step_history") or [])}
    req = _open_request(row["id"]) if row["state"] not in TERMINAL else None
    out["request"] = _public_request(row, req, local=local, fresh=fresh, owner=owner) if req else None
    if detail:
        with db.engine().connect() as c:
            evs = db.rows(c.execute(select(models.auth_events).where(models.auth_events.c.auth_session_id == row["id"])
                                    .order_by(models.auth_events.c.timestamp.desc()).limit(40)))
        out["events"] = [{"type": e["event_type"], "ts": e["timestamp"], "outcome": e["outcome"],
                          **({"meta": e["sanitized_metadata"]} if e["event_type"].startswith(
                              ("step.", "detection.", "origin.", "success.", "stopped")) and
                             isinstance(e.get("sanitized_metadata"), dict) else {})} for e in evs]
        out["history"] = [{"step": h.get("step"), "origin": h.get("origin"), "error": h.get("error"),
                           "trust": h.get("trust"), "at": h.get("at")} for h in (row.get("step_history") or [])][-12:]
    return out


_VAULT_REASON = {"not_created": "Set up the Password Vault first (Password Vault → Create).",
                 "locked": "The Password Vault is locked. Unlock it to save credentials or use a saved account."}


def _public_request(row: dict[str, Any], req: dict[str, Any], *, local: bool, fresh: bool | None = None,
                    owner: bool = True) -> dict[str, Any]:
    sch = dict(req.get("field_schema") or {})
    rtype = req["request_type"]
    vstate = _vault_state()
    pin = pin_status()
    rt = _rt(row["id"])
    strong = local or bool(fresh)
    out = {"id": req["id"], "type": rtype, "seq": req["seq"], "expires_at": req["expires_at"],
           "step": sch.get("step"), "fields": sch.get("fields") or [], "otp": sch.get("otp"),
           "confidence": sch.get("confidence"), "flags": sch.get("flags") or [],
           "review_required": bool(sch.get("review_required")), "error": sch.get("error"),
           "trust": sch.get("trust"), "alternatives": [a for a in (sch.get("alternatives") or []) if a in ALT_KINDS],
           "page_origin": sch.get("page_origin") or row.get("verified_origin"),
           "vault": {"state": vstate, "can_save": vstate == "unlocked", "can_unlock": vstate == "locked" and owner,
                     "reason": _VAULT_REASON.get(vstate)},
           "save_intent": "vault" if (rt is not None and rt.save) else "once",
           "local": local, "fresh": strong, "remote_submission": settings()["remote_submission"],
           "pin_configured": pin["configured"], "pin_locked_until": pin["locked_until"],
           # V3.4: what the page asks for right now (EMAIL_REQUIRED, PASSWORD_REQUIRED, ...) and fixed-code notes
           # about what NEBULA did by itself (passkey cancelled, "use your password" chosen, restarted from the service)
           "requirement": sch.get("requirement") if sch.get("requirement") in STATES else None,
           "notes": [n for n in (sch.get("notes") or []) if n in (*AUTO_NOTES, *START_NOTES)][:8]}
    if rtype == "device_approval":
        n = sch.get("approval_number")
        out["approval_number"] = n if isinstance(n, str) and re.fullmatch(r"\d{2,3}", n) else None
    if rtype == "credentials":
        out["accounts"] = _accounts(row["agent_id"], out["page_origin"] or row["requested_origin"], row["task_id"],
                                    list(row.get("allowed_origins") or []), local=local, show_usernames=strong)
    if rtype == "confirm_destination":
        out["destination"] = {"origin": sch.get("destination"), "kind": sch.get("kind"),
                              "same_site": sch.get("same_site"), "requested_origin": sch.get("requested_origin"),
                              "secrets_pending": sch.get("secrets_pending")}
    if rtype == "manual":
        wa = sch.get("webauthn") if isinstance(sch.get("webauthn"), dict) else None
        out["manual"] = {"kind": sch.get("kind"), "live_desktop": True,
                         "can_complete_here": sch.get("can_complete_here", True) is not False,
                         "webauthn_pending": bool(wa and wa.get("pending"))}
    if rtype == "loop":
        out["loop"] = {"reason": sch.get("reason"), "page_step": sch.get("page_step")}
    if rtype in ("otp", "recovery_code"):
        out["code_ttl_s"] = sch.get("code_ttl_s")
    out["pin_required_for"] = [] if strong else _pin_actions(rtype)
    out["allow_future_available"] = owner  # creating a grant is a vault permission change: owner + fresh check
    out["allow_future_needs_stepup"] = owner and not strong
    return out


def _pin_actions(rtype: str) -> list[str]:
    return {"credentials": ["credentials", "saved_without_grant", "save_to_vault"],
            "recovery_code": ["code"], "confirm_destination": ["allow_destination_with_secrets"]}.get(rtype, [])


def list_sessions(*, conversation_id: str | None = None, agent_id: str | None = None, active: bool | None = None,
                  task_id: str | None = None, limit: int = 30, local: bool = True, fresh: bool | None = None,
                  owner: bool = True) -> list[dict[str, Any]]:
    q = select(models.auth_sessions)
    if conversation_id:
        q = q.where(models.auth_sessions.c.conversation_id == conversation_id)
    if agent_id:
        q = q.where(models.auth_sessions.c.agent_id == agent_id)
    if task_id:
        q = q.where(models.auth_sessions.c.task_id == task_id)
    if active is True:
        q = q.where(models.auth_sessions.c.state.notin_(list(TERMINAL)))
    elif active is False:
        q = q.where(models.auth_sessions.c.state.in_(list(TERMINAL)))
    with db.engine().connect() as c:
        rows = db.rows(c.execute(q.order_by(models.auth_sessions.c.created_at.desc()).limit(max(1, min(limit, 100)))))
    return [public(r, local=local, fresh=fresh, owner=owner) for r in rows]


def detail(sid: str, *, local: bool, fresh: bool | None = None, owner: bool = True) -> dict[str, Any]:
    return public(_get(sid), detail=True, local=local, fresh=fresh, owner=owner)


def issue_token(sid: str, *, actor: str) -> dict[str, Any]:
    """Single-use submission token for the CURRENT owner request (sha256 stored; the token exists only in the
    response). A new token replaces the previous one."""
    row = _get(sid)
    if row["state"] not in OWNER_WAIT:
        raise AuthError("not_waiting", "this sign-in request is not waiting for you", 409)
    req = _open_request(sid)
    if not req or req["expires_at"] <= _now():
        raise AuthError("expired", "this request expired", 410)
    tok = secrets.token_urlsafe(24)
    exp = min(_now() + settings()["token_ttl_s"], req["expires_at"])
    with db.engine().begin() as c:
        n = c.execute(update(models.auth_requests).where(and_(models.auth_requests.c.id == req["id"],
                                                              models.auth_requests.c.status == "open"))
                      .values(token_hash=hashlib.sha256(tok.encode()).hexdigest(), token_expires_at=exp)).rowcount
    if n != 1:
        raise AuthError("conflict", "the request changed, reload", 409)
    _log(sid, "token.issued", "ok", actor_type=_actor_type(actor))
    return {"request_id": req["id"], "token": tok, "expires_at": exp}


def _consume_token(sid: str, request_id: str, token: str) -> dict[str, Any]:
    """Atomically burns the token (every submission attempt needs a fresh one: replay-proof)."""
    if not isinstance(token, str) or not 20 <= len(token) <= 64 or not isinstance(request_id, str):
        raise AuthError("invalid_token", "missing or invalid submission token", 403)
    h = hashlib.sha256(token.encode()).hexdigest()
    with db.engine().begin() as c:
        req = db.row(c.execute(select(models.auth_requests).where(and_(
            models.auth_requests.c.id == request_id, models.auth_requests.c.auth_session_id == sid))).first())
        if not req or req["status"] != "open":
            raise AuthError("request_closed", "this request was already answered or replaced", 409)
        if not req.get("token_hash") or not hmac.compare_digest(req["token_hash"], h):
            raise AuthError("invalid_token", "invalid or already used submission token", 403)
        if (req.get("token_expires_at") or 0) <= _now() or req["expires_at"] <= _now():
            c.execute(update(models.auth_requests).where(models.auth_requests.c.id == request_id)
                      .values(token_hash=None))
            raise AuthError("token_expired", "the form was open too long; try again", 410)
        n = c.execute(update(models.auth_requests).where(and_(models.auth_requests.c.id == request_id,
                                                              models.auth_requests.c.token_hash == h))
                      .values(token_hash=None, token_expires_at=None)).rowcount
    if n != 1:
        raise AuthError("invalid_token", "invalid or already used submission token", 403)
    return req


_rate: dict[str, list[float]] = {}


def _rate_limit(key: str, n: int, per_s: float) -> None:
    now = _now()
    hits = [t for t in _rate.get(key, []) if now - t < per_s]
    if len(hits) >= n:
        raise AuthError("rate_limited", "too many attempts, slow down", 429, retry_after=int(per_s))
    hits.append(now)
    _rate[key] = hits


async def submit(sid: str, body: dict[str, Any], *, actor: str, local: bool, fresh: bool = False,
                 owner: bool = True) -> dict[str, Any]:
    """One owner answer to the CURRENT request (single-use token). `fresh` = the owner verified themselves again
    within the last minutes (step-up) — on the Mac, or on the phone with Face ID / password: it stands in for the
    remote PIN and allows vault-permission changes from the phone."""
    if not owner:  # M-04: operators and agent bots' users never answer the owner's sign-in requests
        raise AuthError("owner_only", "only the NEBULA owner can answer sign-in requests", 403)
    _rate_limit(f"submit:{sid}", 12, 600)
    _rate_limit(f"submit-actor:{actor}", 30, 60)
    row = _get(sid)
    if row["state"] not in OWNER_WAIT:
        raise AuthError("not_waiting", "this sign-in request is not waiting for you", 409)
    rt = _rt(sid)
    if rt is None:  # host restarted (secrets gone) or the task runner is gone
        raise AuthError("stale", "this sign-in request is no longer active", 410)
    action = str(body.get("action") or "")
    strong = local or fresh
    if body.get("allow_future") and not strong and action in ("credentials", "saved"):
        # checked BEFORE the single-use token is spent: after the step-up the same request is simply sent again
        raise AuthError("stepup_required", "Letting an agent use a credential in future changes vault permissions: "
                                           "confirm it's you first.", 403, level="fresh")
    req = _consume_token(sid, str(body.get("request_id") or ""), str(body.get("token") or ""))
    rtype = req["request_type"]
    sch = req.get("field_schema") or {}
    st = settings()
    if row.get("trust_level") == "RED":
        raise AuthError("blocked_suspicious", "This sign-in was blocked as suspicious; nothing can be submitted.", 403)
    if not local and not st["remote_submission"] and action not in ("check", "manual_done", "retry", "inspect"):
        raise AuthError("remote_disabled", "remote sign-in submission is turned off (Password Vault → Smart sign-in)",
                        403)
    if sch.get("review_required") and action in ("credentials", "saved", "allow_destination", "code") and \
            body.get("review_confirmed") is not True:
        raise AuthError("review_required", "confirm that you checked the destination first", 400)
    allowed_actions = {"credentials": ("credentials", "saved", "choose"), "otp": ("code", "choose"),
                       "recovery_code": ("code",), "confirm_destination": ("allow_destination",),
                       "device_approval": ("check", "choose"), "manual": ("manual_done", "choose", "handoff", "retry"),
                       "method_choice": ("choose", "handoff"), "loop": ("retry", "inspect")}[rtype]
    if action not in allowed_actions:
        raise AuthError("invalid_action", f"this request accepts: {', '.join(allowed_actions)}", 400)
    who = {"actor_type": _actor_type(actor)}

    if action == "check":
        _start_poller(sid, rt)
        return public(_get(sid), local=local, fresh=fresh, owner=owner)
    if action == "manual_done":
        return await _manual_done(sid, rt, req, actor, local)
    if action == "allow_destination":
        dest = sch.get("destination")
        if sch.get("secrets_pending") and not strong:
            verify_pin(str(body.get("pin") or ""))
        return await _allow_destination(sid, rt, req, dest, actor, local)
    if action == "choose":
        kind = str(body.get("alternative") or "")
        alt = next((a for a in ((rt.step or {}).get("alternatives") or []) if a["kind"] == kind), None)
        if kind not in ALT_KINDS or kind not in (sch.get("alternatives") or []) or alt is None:
            raise AuthError("stale", "that option is no longer offered by the page; reload the request", 409)
        _mark_submitted(sid, req["id"], f"choose_{kind}")
        _log(sid, "owner.submitted", "ok", request_type=rtype, method=f"choose_{kind}", **who)
        _spawn(rt, _choose(sid, rt, alt["id"]))
        return public(_get(sid), local=local, fresh=fresh, owner=owner)
    if action == "retry":
        _mark_submitted(sid, req["id"], "retry")
        _log(sid, "owner.submitted", "ok", request_type=rtype, method="retry", **who)
        _spawn(rt, _reload(sid, rt))
        return public(_get(sid), local=local, fresh=fresh, owner=owner)
    if action in ("inspect", "handoff"):
        _mark_submitted(sid, req["id"], action)
        _log(sid, "owner.submitted", "ok", request_type=rtype, method=action, **who)
        row2 = _get(sid)
        kind = (rt.step or {}).get("step") if action == "handoff" else "loop"

        async def go() -> None:
            async with rt.lock:
                await _handoff(sid, rt, kind if kind in ("passkey", "captcha") else "manual",
                               {"confidence": row2.get("confidence"), "flags": row2.get("flags") or [],
                                "trust_level": row2.get("trust_level"), "trust": row2.get("trust") or {}})

        _spawn(rt, go())
        return public(_get(sid), local=local, fresh=fresh, owner=owner)

    step = rt.step
    if step is None or step["step"] != sch.get("step"):
        raise AuthError("stale", "the page changed; reload the request", 409)
    fields = step["fields"]
    if action == "code":
        if rtype == "recovery_code" and not strong:
            verify_pin(str(body.get("pin") or ""))
        raw = body.get("values") if isinstance(body.get("values"), dict) else {}
        body["values"] = {}
        f = fields[0]
        values = {f["id"]: _value_ok(f["role"], f, raw.get(f["id"]))}
        raw.clear()
        received = _now()
        _mark_submitted(sid, req["id"], "code")
        _log(sid, "owner.submitted", "ok", request_type=rtype, **who)
        _spawn(rt, _submit_values(sid, rt, values, kind="code", received=received))
        return public(_get(sid), local=local, fresh=fresh, owner=owner)

    page_origin = step.get("page_origin") or row["requested_origin"]
    if action == "saved":
        entry_id = str(body.get("entry_id") or "")
        offered = {a["entry_id"] for a in _accounts(row["agent_id"], page_origin, row["task_id"],
                                                    list(row.get("allowed_origins") or []), local=local)}
        if entry_id not in offered:
            raise AuthError("entry_not_offered", "choose one of the offered saved accounts", 400)
        if vaultmod.VAULT.locked:
            raise AuthError("vault_locked", "Your Vault is locked. Unlock it to use saved credentials.", 409)
        allow_future = bool(body.get("allow_future"))
        if allow_future and not strong:
            raise AuthError("stepup_required", "Letting an agent use a credential in future changes vault permissions: "
                                               "confirm it's you first.", 403, level="fresh")
        grant = _grant_for(row["agent_id"], entry_id, list(row.get("allowed_origins") or []), row["task_id"])
        if not strong:  # M-04: a remote, non-fresh session needs the PIN for a saved account even with a grant
            verify_pin(str(body.get("pin") or ""))
        values = _saved_values(entry_id, row, step)
        if allow_future and grant is None:
            try:
                if vaultmod.VAULT.agent_policy(row["agent_id"])["mode"] == "NONE":
                    vaultmod.VAULT.set_agent_mode(row["agent_id"], "SELECTED", None, actor=actor)
                vaultmod.VAULT.create_grant(row["agent_id"], entry_id, origins=[page_origin],
                                            actions=["sign_in"], policy="always_ask", actor=actor)
            except vaultmod.VaultError as e:
                _log(sid, "grant.create", "error", error_code=e.code)
        rt.saved_entry = entry_id
        with db.engine().begin() as c:
            c.execute(update(models.auth_sessions).where(models.auth_sessions.c.id == sid)
                      .values(auth_method="saved", entry_id=entry_id, save_mode="once"))
        vaultmod.record(actor, "use.smart_sign_in", outcome="ok", agent_id=row["agent_id"], entry_id=entry_id,
                        task_id=row["task_id"], origin=page_origin,
                        reason="owner_selected_grant" if grant else "owner_selected_once")
        _mark_submitted(sid, req["id"], "saved")
        _log(sid, "owner.submitted", "ok", request_type=rtype, method="saved", **who)
        _spawn(rt, _submit_values(sid, rt, values, kind="credentials", received=_now()))
        return public(_get(sid), local=local, fresh=fresh, owner=owner)

    # new credentials typed by the owner; the save choice holds for the whole sign-in (e-mail, then password...)
    if body.get("save") not in (None, "once", "vault"):
        raise AuthError("invalid_value", "save must be 'once' or 'vault'")
    save = body.get("save") or ("vault" if rt.save else "once")
    allow_future = bool(body.get("allow_future")) and save == "vault"
    if allow_future and not strong:
        raise AuthError("stepup_required", "Letting an agent use a credential in future changes vault permissions: "
                                           "confirm it's you first.", 403, level="fresh")
    if not strong:
        verify_pin(str(body.get("pin") or ""))
    if save == "vault" and vaultmod.VAULT.locked:
        raise AuthError("vault_locked", "Your Password Vault is locked or not set up. Unlock it to save, or choose "
                                        "'Use once'.", 409, vault_state=_vault_state())
    raw = body.get("values") if isinstance(body.get("values"), dict) else {}
    body["values"] = {}
    try:
        if set(raw) != {f["id"] for f in fields}:
            raise AuthError("fields_mismatch", "fill in exactly the requested fields", 400)
        values = {f["id"]: _value_ok(f["role"], f, raw.get(f["id"])) for f in fields}
    finally:
        for k in list(raw):
            raw[k] = ""
        raw.clear()
    if save == "vault":
        prev = rt.save or {}
        rt.save = {"name": str(body.get("name") or "")[:200].strip() or prev.get("name"),
                   "allow_future": allow_future or bool(prev.get("allow_future")), "actor": actor}
        for f in fields:
            group = "username" if f["role"] in IDENTIFIER_ROLES else "password" if f["role"] == "password" else None
            if group:
                rt.collected[group] = values[f["id"]]
                rt.collected_origins[group] = page_origin
                if group == "username":
                    rt.collected_kind = f["role"]
    elif rt.save and save == "once":
        rt.save = None
        rt.collected.clear()
        rt.collected_origins.clear()
    with db.engine().begin() as c:
        c.execute(update(models.auth_sessions).where(models.auth_sessions.c.id == sid)
                  .values(auth_method=row.get("auth_method") if row.get("auth_method") == "saved" else "new",
                          save_mode=save))
    _mark_submitted(sid, req["id"], "credentials")
    _log(sid, "owner.submitted", "ok", request_type=rtype, method=save, **who)
    _spawn(rt, _submit_values(sid, rt, values, kind="credentials", received=_now()))
    return public(_get(sid), local=local, fresh=fresh, owner=owner)


def _mark_submitted(sid: str, request_id: str, outcome: str) -> None:
    with db.engine().begin() as c:
        n = c.execute(update(models.auth_requests).where(and_(models.auth_requests.c.id == request_id,
                                                              models.auth_requests.c.status == "open"))
                      .values(status="submitted", resolved_at=_now(), outcome=outcome)).rowcount
        if n != 1:
            raise AuthError("request_closed", "this request was already answered", 409)
        row = _get(sid, c)
        # the answer is being processed: only the session's hard limit applies (no expiry mid-fill)
        _transition(sid, "SUBMITTING", c=c, expires_at=row["created_at"] + settings()["session_max_s"])
    _publish(sid)


async def _submit_values(sid: str, rt: _Rt, values: dict[str, str], *, kind: str, received: float) -> None:
    try:
        async with rt.lock:
            if kind == "code" and _now() - received > settings()["otp_ttl_s"]:
                for k in list(values):
                    values[k] = ""
                values.clear()
                await _fail(sid, rt, "code_expired_before_use")
                return
            _transition(sid, "SUBMITTING")
            _publish(sid)
            rt.submitted_fp = (rt.step or {}).get("fingerprint")
            if kind == "credentials" and rt.blocked_origin is None and rt.step is not None:
                # kept only until this step resolves (blocked form target re-send), keyed by field ROLE
                rt.pending = {f["role"]: values[f["id"]] for f in rt.step["fields"] if f["id"] in values}
                rt.pending_step = rt.step["step"]
            ev = await _guest(rt, "vault.auth_step", {"step_id": rt.step_id, "values": values}, 150)
        await _apply(sid, rt, ev, submitted_kind=kind)
    except AuthError as e:
        if e.code != "finished":
            log.warning("smart auth submit failed: %s", e.code)
            with contextlib.suppress(AuthError):
                await _fail(sid, rt, e.code)
    except Exception:  # noqa: BLE001
        log.exception("smart auth submission failed")
        with contextlib.suppress(AuthError):
            await _fail(sid, rt, "internal_error")
    finally:
        row = None
        with contextlib.suppress(AuthError):
            row = _get(sid)
        if rt.pending is not None and (row is None or row["current_step"] != "destination" or
                                       _now() > rt.pending_until):
            for k in list(rt.pending):
                rt.pending[k] = ""
            rt.pending = None


async def _allow_destination(sid: str, rt: _Rt, req: dict[str, Any], dest: str, actor: str,
                             local: bool) -> dict[str, Any]:
    row = _get(sid)
    if not dest:
        raise AuthError("invalid_destination", "no destination to allow", 400)
    origins = sorted(set(row["allowed_origins"]) | {dest})
    pending = rt.pending if (rt.pending and _now() <= rt.pending_until) else None
    tinfo = dict(row.get("trust") or {})
    tinfo["confirmed"] = sorted(set(tinfo.get("confirmed") or []) | {dest})
    _mark_submitted(sid, req["id"], "allow_destination")
    with db.engine().begin() as c:
        c.execute(update(models.auth_sessions).where(models.auth_sessions.c.id == sid)
                  .values(allowed_origins=origins, trust=tinfo))
    _log(sid, "destination.allowed", "ok", to=dest, actor_type=_actor_type(actor))
    _spawn(rt, _resume_destination(sid, rt, dest, origins, pending))
    return public(_get(sid), local=local)


async def _manual_done(sid: str, rt: _Rt, req: dict[str, Any], actor: str, local: bool) -> dict[str, Any]:
    """The owner says they finished the manual step in Live Desktop: verify in the agent's browser before
    resuming (never pretend it happened)."""
    row = _get(sid)
    try:
        h = await rt.guest.tool(rt.agent_id, "browser.auth_hint", {}, timeout=15)
        hint = ((h.get("result") or {}).get("hint") or {}) if h.get("ok") else None
    except Exception:  # noqa: BLE001
        hint = None
    origin = (hint or {}).get("origin")
    if hint is None or origin not in (row.get("allowed_origins") or []) or (hint.get("step") in LOGIN_STEPS):
        _log(sid, "manual.check", "still_login", actor_type=_actor_type(actor))
        with db.engine().begin() as c:
            c.execute(update(models.auth_sessions).where(models.auth_sessions.c.id == sid)
                      .values(error_code="still_sign_in_page", updated_at=_now()))
        _publish(sid)
        raise AuthError("still_sign_in_page", "The agent's browser still shows a sign-in step on the site. Finish it in "
                                              "Live Desktop, then tap Done again.", 409)
    _mark_submitted(sid, req["id"], "manual_done")
    _transition(sid, "VERIFYING")
    await _authenticated(sid, rt, method="manual")
    return public(_get(sid), local=local)


def pending_for_approval_center(*, local: bool, fresh: bool | None = None, owner: bool = True) -> list[dict[str, Any]]:
    return list_sessions(active=True, limit=20, local=local, fresh=fresh, owner=owner)
