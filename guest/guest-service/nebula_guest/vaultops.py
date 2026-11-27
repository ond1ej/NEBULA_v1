"""Guest side of the Password Vault broker (root, guest service).

`vault.sign_in` receives one credential from the NEBULA host over the authenticated vsock RPC, hands it to the
isolated login process (`vault_login.py` as the dedicated `nebula-vault` user, via stdin), and passes ONLY the
resulting session cookies to the requesting agent's browser. The credential is never written to disk, never logged,
never placed in argv or the environment, and never reaches a process running as an agent user.
"""

from __future__ import annotations

import asyncio
import grp
import json
import os
import pwd
import re
import shutil
import time
from pathlib import Path
from typing import Any

from nebula_guest import workspace as ws
from nebula_guest.toolclient import call_tool

VAULT_USER = "nebula-vault"
VAULT_HOME = Path("/var/lib/nebula-vault")
SCRIPT = Path("/opt/nebula/guest/nebula_guest/vault_login.py")
PYTHON = "/opt/nebula/venv/bin/python"
BROWSERS = Path(os.environ.get("PLAYWRIGHT_BROWSERS_PATH", "/opt/nebula/ms-playwright"))
ORIGIN_RE = re.compile(r"^https?://[a-z0-9.\-\[\]:]{1,253}$")
_lock = asyncio.Lock()  # one isolated login at a time (memory on the 4 GB guest)


def self_test() -> dict[str, Any]:
    """Isolation self-test reported through guest.capabilities; the host enables the broker only when it passes."""
    checks: dict[str, bool] = {}
    try:
        pw = pwd.getpwnam(VAULT_USER)
    except KeyError:
        return {"installed": False, "isolated": False, "reason": "nebula-vault user missing (run `nebula repair`)"}
    checks["no_login_shell"] = pw.pw_shell in ("/usr/sbin/nologin", "/bin/false", "/usr/bin/false")
    checks["not_root"] = pw.pw_uid != 0 and pw.pw_gid != 0
    try:
        st = VAULT_HOME.stat()
        checks["home_private"] = st.st_uid == pw.pw_uid and (st.st_mode & 0o077) == 0
    except FileNotFoundError:
        checks["home_private"] = False
    agent_users = {a["linux_user"] for a in (ws.load_registry().get("agents") or {}).values()}
    agent_uids = set()
    for u in agent_users:
        try:
            agent_uids.add(pwd.getpwnam(u).pw_uid)
        except KeyError:
            pass
    checks["distinct_from_agents"] = pw.pw_uid not in agent_uids
    # no agent is a member of the vault user's group and the vault user is in no other group
    vault_group = grp.getgrgid(pw.pw_gid)
    checks["no_shared_groups"] = not (set(vault_group.gr_mem) & agent_users) and not any(
        VAULT_USER in g.gr_mem for g in grp.getgrall())
    checks["script"] = SCRIPT.is_file() and SCRIPT.stat().st_uid == 0 and not (SCRIPT.stat().st_mode & 0o022)
    checks["chromium"] = any(BROWSERS.glob("chromium-*/chrome-linux*/chrome"))
    checks["systemd_run"] = shutil.which("systemd-run") is not None
    failing = [k for k, v in checks.items() if not v]
    installed = checks["script"] and checks["chromium"] and checks["systemd_run"]
    return {"installed": installed, "isolated": not failing, "user": VAULT_USER, "checks": checks,
            "reason": None if not failing else f"failed checks: {', '.join(failing)}",
            "smart_auth": installed and not failing and smart_auth_ready(),
            "smart_auth_version": 3}


def _valid_params(p: dict[str, Any]) -> tuple[str, list[str], str, str, str, float]:
    origin = p.get("origin")
    allowed = p.get("allowed_origins")
    login_url = p.get("login_url")
    username, password = p.get("username"), p.get("password")
    if not isinstance(origin, str) or not ORIGIN_RE.match(origin):
        raise ws.WorkspaceError("invalid_argument", "origin")
    if not isinstance(allowed, list) or not 1 <= len(allowed) <= 10 or origin not in allowed or \
            not all(isinstance(o, str) and ORIGIN_RE.match(o) for o in allowed):
        raise ws.WorkspaceError("invalid_argument", "allowed_origins")
    if not isinstance(login_url, str) or len(login_url) > 2000 or not login_url.startswith(("https://", "http://")):
        raise ws.WorkspaceError("invalid_argument", "login_url")
    if not isinstance(username, str) or not isinstance(password, str) or len(username) > 512 or len(password) > 4096:
        raise ws.WorkspaceError("invalid_argument", "credential")
    timeout = min(max(float(p.get("timeout_s") or 60), 10.0), 120.0)
    return origin, allowed, login_url, username, password, timeout


def _clean_cookies(cookies: Any) -> list[dict[str, Any]]:
    out = []
    for c in cookies if isinstance(cookies, list) else []:
        if not isinstance(c, dict) or not isinstance(c.get("name"), str) or not isinstance(c.get("value"), str):
            continue
        k = {x: c[x] for x in ("name", "value", "domain", "path", "expires", "httpOnly", "secure", "sameSite")
             if x in c}
        if not k.get("domain"):
            continue
        out.append(k)
    return out[:200]


async def sign_in(p: dict[str, Any]) -> dict[str, Any]:
    a = ws.get_agent(p.get("agent_id", ""))
    origin, allowed, login_url, username, password, timeout = _valid_params(p)
    p["password"] = p["username"] = ""
    st = self_test()
    if not st["isolated"]:
        return {"status": "error", "detail": "broker_not_isolated"}
    payload = json.dumps({"origin": origin, "allowed_origins": allowed, "login_url": login_url,
                          "username": username, "password": password, "timeout_s": timeout}).encode() + b"\n"
    username = password = ""  # noqa: F841 - drop references (best effort)
    cmd = ["systemd-run", "--quiet", "--collect", "--pipe", "--wait", f"--uid={VAULT_USER}", f"--gid={VAULT_USER}",
           "-p", "PrivateTmp=yes", "-p", "ProtectHome=yes", "-p", "ProtectSystem=strict",
           "-p", f"ReadWritePaths={VAULT_HOME}", "-p", "NoNewPrivileges=yes", "-p", "MemoryMax=1200M",
           "-p", "MemorySwapMax=256M", "-p", f"RuntimeMaxSec={int(timeout) + 30}", "-p", "UMask=0077",
           "-p", "LimitCORE=0", "-p", "ProtectProc=invisible", "-p", "PrivateIPC=yes",
           f"--working-directory={VAULT_HOME}", f"--setenv=HOME={VAULT_HOME}",
           f"--setenv=PLAYWRIGHT_BROWSERS_PATH={BROWSERS}", "--setenv=LANG=C.UTF-8",
           PYTHON, "-I", str(SCRIPT)]
    async with _lock:
        proc = await asyncio.create_subprocess_exec(*cmd, stdin=asyncio.subprocess.PIPE,
                                                    stdout=asyncio.subprocess.PIPE,
                                                    stderr=asyncio.subprocess.DEVNULL)
        try:
            out, _ = await asyncio.wait_for(proc.communicate(payload), timeout + 40)
        except TimeoutError:
            proc.kill()
            return {"status": "timeout"}
        finally:
            payload = b""
    try:
        res = json.loads((out.decode(errors="replace").strip().splitlines() or ["{}"])[-1])
    except ValueError:
        return {"status": "error", "detail": "broker_output"}
    cookies = _clean_cookies(res.pop("cookies", None))
    status = res.get("status") or "error"
    imported = 0
    if status == "signed_in":
        r = await asyncio.to_thread(call_tool, a["linux_user"], "browser.import_cookies", {"cookies": cookies}, 60)
        if r.get("ok"):
            imported = int((r.get("result") or {}).get("imported") or 0)
        else:
            status, res["detail"] = "error", "cookie_import_failed"
    cookies = []
    return {"status": status, "final_url": res.get("final_url"), "cookies_imported": imported,
            "blocked": res.get("blocked"), "detail": res.get("detail")}


# ============================================================================ V3.2.1 Smart Authentication sessions
AUTH_SCRIPT = SCRIPT.with_name("vault_auth.py")
DETECTOR = SCRIPT.with_name("auth_detect.py")
MAX_AUTH_SESSIONS = 5
SID_RE = re.compile(r"^as_[0-9a-f]{24}$")
FIELD_ID_RE = re.compile(r"^f\d{1,3}$")
_STEP_KEYS = ("step", "confidence", "flags", "fields", "otp", "page_origin", "action_origin", "error", "login_context",
              "fingerprint", "structure")
STEP_KINDS = ("identifier", "identifier_password", "password", "otp", "recovery_code", "device_approval", "passkey",
              "security_key", "captcha", "embedded_login", "new_password", "method_choice", "interstitial", "unknown",
              "authenticated", "none")
AUTO_RE = re.compile(r"^[a-z_]{3,40}$")
EVIDENCE = ("provider_session_cookie", "signout_control", "site_cookie_and_navigation")
_DIAG_WORDS = {"step": frozenset(STEP_KINDS), "confidence": frozenset({"HIGH", "MEDIUM", "LOW"}),
               "structure": frozenset({"HIGH", "MEDIUM", "LOW"}), "ready": frozenset({"loading", "interactive",
                                                                                     "complete"}),
               "webauthn": frozenset({"passkey", "security_key"}),
               "roles": frozenset({"email", "phone", "username", "username_or_email", "password", "otp",
                                   "recovery_code", "new_password"}),
               "alternatives": frozenset({"password", "code", "app", "more"})}
_DIAG_INTS = ("inputs_visible", "inputs", "forms", "frames", "shadow_roots", "quiet_ms", "mutations", "animating")
_DIAG_BOOLS = ("observed", "busy", "webauthn_pending", "error", "login_context", "logout_link")
FLAG_CODES = frozenset({"origin_changed", "other_site", "plain_http", "multiple_password_forms", "ambiguous_identifier",
                        "hidden_password_field", "unexpected_recovery_code", "third_party_frame",
                        "cross_site_form_action", "cross_origin_form_action", "same_origin_frame", "local_network"})
BRAND_FLAG_RE = re.compile(r"^brand_mismatch:[a-z]{2,20}$")
_FIELD_KEYS = ("id", "role", "input", "length", "charset", "ids")
_EVENT_KEYS = ("event", "step_id", "page_origin", "url", "error", "still_waiting", "status", "final_url", "origin",
               "detail", "cookies_imported", "changed", "reason")
ALT_ID_RE = re.compile(r"^c\d{1,3}$")
HOST_ID_RE = re.compile(r"^[0-9a-f]{16}$")
COOKIE_NAME_RE = re.compile(r"^[A-Za-z0-9_.\-]{1,64}$")


class _AuthProc:
    def __init__(self, sid: str, agent_id: str, linux_user: str, proc, deadline: float) -> None:
        self.sid, self.agent_id, self.linux_user, self.proc, self.deadline = sid, agent_id, linux_user, proc, deadline
        self.lock = asyncio.Lock()
        self.cancelled = False  # set by cancel/expiry: a late result never hands cookies to the agent
        self.host_id: str | None = None  # NEBULA host instance that started it (start-up sweep scope)

    async def send(self, obj: dict[str, Any], timeout: float) -> dict[str, Any]:
        if self.proc.returncode is not None:
            return {"event": "error", "detail": "broker_exited"}
        line = json.dumps(obj).encode() + b"\n"
        obj.clear()
        try:
            self.proc.stdin.write(line)
            await self.proc.stdin.drain()
        except (BrokenPipeError, ConnectionResetError):
            return {"event": "error", "detail": "broker_exited"}
        finally:
            line = b""
        try:
            raw = await asyncio.wait_for(self.proc.stdout.readline(), timeout)
        except TimeoutError:
            return {"event": "error", "detail": "broker_timeout"}
        if not raw:
            return {"event": "error", "detail": "broker_exited"}
        try:
            return json.loads(raw)
        except ValueError:
            return {"event": "error", "detail": "broker_output"}


_AUTH: dict[str, _AuthProc] = {}
_reaper: asyncio.Task | None = None


def smart_auth_ready() -> bool:
    for f in (AUTH_SCRIPT, DETECTOR):
        try:
            st = f.stat()
        except FileNotFoundError:
            return False
        if st.st_uid != 0 or st.st_mode & 0o022:
            return False
    return True


def _clean_step(step: Any) -> dict[str, Any] | None:
    if not isinstance(step, dict):
        return None
    out = {k: step.get(k) for k in _STEP_KEYS if k in step}
    out["fields"] = [{k: f.get(k) for k in _FIELD_KEYS if k in f} for f in (step.get("fields") or [])[:4]
                     if isinstance(f, dict)]
    out["alternatives"] = [{"id": a.get("id"), "kind": a.get("kind")} for a in (step.get("alternatives") or [])[:4]
                           if isinstance(a, dict) and isinstance(a.get("id"), str) and ALT_ID_RE.match(a["id"])]
    if out.get("step") not in STEP_KINDS:
        out["step"] = "unknown"
    wa = step.get("webauthn")
    if isinstance(wa, dict) and wa.get("kind") in ("passkey", "security_key"):
        out["webauthn"] = {"kind": wa["kind"], "pending": bool(wa.get("pending")),
                           "op": wa.get("op") if wa.get("op") in ("get", "create") else None}
    if step.get("signout") in ("visible", "hidden"):
        out["signout"] = step["signout"]
    n = step.get("approval_number")
    if isinstance(n, str) and re.fullmatch(r"\d{2,3}", n):
        out["approval_number"] = n
    tr = step.get("transport")
    if isinstance(tr, dict):
        out["transport"] = {"ip": tr.get("ip") if tr.get("ip") in ("public", "private", "loopback", "unknown")
                            else "unknown", "tls": bool(tr.get("tls")),
                            "protocol": str(tr.get("protocol") or "")[:16] or None}
    return out


def _clean_diag(d: Any) -> dict[str, Any] | None:
    """Diagnostics from the broker: numbers, booleans and fixed words only; anything else is dropped here too."""
    if not isinstance(d, dict):
        return None
    out: dict[str, Any] = {}
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
        out["flags"] = [f for f in d["flags"][:8] if isinstance(f, str) and (f in FLAG_CODES or BRAND_FLAG_RE.match(f))]
    return out


def _clean_event(ev: dict[str, Any]) -> dict[str, Any]:
    out = {k: ev.get(k) for k in _EVENT_KEYS if k in ev}
    if "step" in ev:
        out["step"] = _clean_step(ev["step"])
    if "diag" in ev:
        out["diag"] = _clean_diag(ev.get("diag"))
    if isinstance(ev.get("auto"), list):
        out["auto"] = [a for a in ev["auto"][:8] if isinstance(a, str) and AUTO_RE.match(a)]
    if ev.get("evidence") in EVIDENCE:
        out["evidence"] = ev["evidence"]
    tm = ev.get("timing")
    if isinstance(tm, dict):
        out["timing"] = {k: max(0, min(int(v), 600000)) for k, v in tm.items()
                         if k in ("change_ms", "settle_ms", "read_ms") and isinstance(v, (int, float))
                         and not isinstance(v, bool)}
    return out


def _unit(sid: str) -> str:
    return f"nebula-auth-{sid}"


async def _stop_unit(sid: str) -> None:
    """Stop the transient unit itself (killing only the systemd-run client may leave the browser running)."""
    try:
        p = await asyncio.create_subprocess_exec("systemctl", "stop", f"{_unit(sid)}.service",
                                                 stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
        await asyncio.wait_for(p.wait(), 15)
    except (OSError, TimeoutError):
        pass


async def _close(s: _AuthProc) -> None:
    s.cancelled = True
    _AUTH.pop(s.sid, None)
    if s.proc.returncode is None:
        try:
            s.proc.stdin.write(b'{"op":"cancel"}\n')
            await s.proc.stdin.drain()
        except Exception:  # noqa: BLE001
            pass
        try:
            await asyncio.wait_for(s.proc.wait(), 5)
        except TimeoutError:
            s.proc.kill()
    await _stop_unit(s.sid)


async def _reap() -> None:
    while _AUTH:
        await asyncio.sleep(10)
        now = time.time()
        for s in list(_AUTH.values()):
            if s.proc.returncode is not None or now > s.deadline:
                await _close(s)


def _session(p: dict[str, Any]) -> _AuthProc:
    sid = p.get("session_id")
    if not isinstance(sid, str) or not SID_RE.match(sid):
        raise ws.WorkspaceError("invalid_argument", "session_id")
    s = _AUTH.get(sid)
    if s is None:
        raise ws.WorkspaceError("not_found", "no such authentication session")
    if p.get("agent_id") != s.agent_id:  # host binding: one agent can never drive another agent's session
        raise ws.WorkspaceError("forbidden", "session belongs to another agent")
    return s


async def _finish(s: _AuthProc, ev: dict[str, Any]) -> dict[str, Any]:
    """Result events end the session; cookies go to THIS session's agent browser only, never to the host."""
    if ev.get("event") != "result":
        if ev.get("event") == "error" and ev.get("detail") in ("broker_exited", "broker_timeout"):
            await _close(s)
        return _clean_event(ev)
    cookies = _clean_cookies(ev.pop("cookies", None))
    imported = 0
    if s.cancelled:  # the owner cancelled (or it expired) while the broker was still working
        cookies = []
        ev = {"event": "result", "status": "cancelled"}
    if ev.get("status") in ("authenticated", "handoff", "unconfirmed") and cookies:
        r = await asyncio.to_thread(call_tool, s.linux_user, "browser.import_cookies", {"cookies": cookies}, 60)
        if r.get("ok"):
            imported = int((r.get("result") or {}).get("imported") or 0)
        elif ev.get("status") == "authenticated":
            ev["status"], ev["detail"] = "error", "cookie_import_failed"
    cookies = []
    ev["cookies_imported"] = imported
    await _close(s)
    return _clean_event(ev)


async def auth_start(p: dict[str, Any]) -> dict[str, Any]:
    global _reaper
    sid, agent_id = p.get("session_id"), p.get("agent_id", "")
    if not isinstance(sid, str) or not SID_RE.match(sid):
        raise ws.WorkspaceError("invalid_argument", "session_id")
    a = ws.get_agent(agent_id)
    origin, allowed, url = p.get("origin"), p.get("allowed_origins"), p.get("url")
    if not isinstance(origin, str) or not ORIGIN_RE.match(origin):
        raise ws.WorkspaceError("invalid_argument", "origin")
    if not isinstance(allowed, list) or not 1 <= len(allowed) <= 6 or origin not in allowed or \
            not all(isinstance(o, str) and ORIGIN_RE.match(o) for o in allowed):
        raise ws.WorkspaceError("invalid_argument", "allowed_origins")
    if not isinstance(url, str) or len(url) > 2000 or not url.startswith(("https://", "http://")):
        raise ws.WorkspaceError("invalid_argument", "url")
    timeout = min(max(float(p.get("timeout_s") or 900), 60.0), 1800.0)
    cookie_origins = p.get("cookie_origins") or []
    if not isinstance(cookie_origins, list) or len(cookie_origins) > 4 or \
            not all(isinstance(o, str) and ORIGIN_RE.match(o) for o in cookie_origins):
        raise ws.WorkspaceError("invalid_argument", "cookie_origins")
    session_cookies = p.get("session_cookies") or {}
    if not isinstance(session_cookies, dict) or len(session_cookies) > 4 or not all(
            isinstance(o, str) and ORIGIN_RE.match(o) and isinstance(v, list) and len(v) <= 8 and
            all(isinstance(n, str) and COOKIE_NAME_RE.match(n) for n in v) for o, v in session_cookies.items()):
        raise ws.WorkspaceError("invalid_argument", "session_cookies")
    fallback = p.get("passkey_fallback") if p.get("passkey_fallback") in ("password", "ask") else "password"
    auth_origins = p.get("auth_origins") or []
    if not isinstance(auth_origins, list) or len(auth_origins) > 8 or \
            not all(isinstance(o, str) and ORIGIN_RE.match(o) for o in auth_origins):
        raise ws.WorkspaceError("invalid_argument", "auth_origins")
    if sid in _AUTH:
        raise ws.WorkspaceError("conflict", "session already running")
    if any(s.agent_id == agent_id for s in _AUTH.values()):
        return {"event": "error", "detail": "agent_busy"}
    if len(_AUTH) >= MAX_AUTH_SESSIONS:
        return {"event": "error", "detail": "broker_busy"}
    st = self_test()
    if not st["isolated"] or not smart_auth_ready():
        return {"event": "error", "detail": "broker_not_isolated"}
    cmd = ["systemd-run", "--quiet", "--collect", "--pipe", "--wait", f"--unit={_unit(sid)}", f"--uid={VAULT_USER}",
           f"--gid={VAULT_USER}", "-p", "PrivateTmp=yes", "-p", "ProtectHome=yes", "-p", "ProtectSystem=strict",
           "-p", f"ReadWritePaths={VAULT_HOME}", "-p", "NoNewPrivileges=yes", "-p", "MemoryMax=900M",
           "-p", "MemorySwapMax=256M", "-p", "OOMPolicy=continue", "-p", f"RuntimeMaxSec={int(timeout) + 60}", "-p", "UMask=0077",
           "-p", "LimitCORE=0", "-p", "ProtectProc=invisible", "-p", "PrivateIPC=yes",
           f"--working-directory={VAULT_HOME}", f"--setenv=HOME={VAULT_HOME}",
           f"--setenv=PLAYWRIGHT_BROWSERS_PATH={BROWSERS}", "--setenv=LANG=C.UTF-8",
           PYTHON, "-I", str(AUTH_SCRIPT)]
    proc = await asyncio.create_subprocess_exec(*cmd, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                                                stderr=asyncio.subprocess.DEVNULL, limit=1 << 20)
    s = _AuthProc(sid, agent_id, a["linux_user"], proc, time.time() + timeout + 30)
    hid = p.get("host_id")
    s.host_id = hid if isinstance(hid, str) and HOST_ID_RE.match(hid) else None
    _AUTH[sid] = s
    if _reaper is None or _reaper.done():
        _reaper = asyncio.create_task(_reap())
    async with s.lock:
        ev = await s.send({"op": "start", "origin": origin, "allowed_origins": allowed, "url": url,
                           "timeout_s": timeout, "cookie_origins": cookie_origins,
                           "session_cookies": session_cookies, "passkey_fallback": fallback,
                           "auth_origins": auth_origins}, 150)
        return await _finish(s, ev)


async def auth_step(p: dict[str, Any]) -> dict[str, Any]:
    s = _session(p)
    vals = p.get("values")
    p["values"] = {}
    if not isinstance(vals, dict) or not 1 <= len(vals) <= 4 or not all(
            isinstance(k, str) and FIELD_ID_RE.match(k) and isinstance(v, str) and 0 < len(v) <= 4096
            for k, v in vals.items()):
        raise ws.WorkspaceError("invalid_argument", "values")
    step_id = p.get("step_id")
    if not isinstance(step_id, int):
        raise ws.WorkspaceError("invalid_argument", "step_id")
    async with s.lock:
        msg = {"op": "fill", "step_id": step_id, "values": vals}
        vals = {}
        ev = await s.send(msg, 120)
        return await _finish(s, ev)


async def auth_poll(p: dict[str, Any]) -> dict[str, Any]:
    s = _session(p)
    wait = min(max(float(p.get("wait_s") or 20), 2.0), 45.0)
    async with s.lock:
        return await _finish(s, await s.send({"op": "poll", "wait_s": wait}, wait + 40))


async def auth_allow(p: dict[str, Any]) -> dict[str, Any]:
    s = _session(p)
    origins = p.get("origins")
    if not isinstance(origins, list) or not 1 <= len(origins) <= 4 or \
            not all(isinstance(o, str) and ORIGIN_RE.match(o) for o in origins):
        raise ws.WorkspaceError("invalid_argument", "origins")
    async with s.lock:
        return await _finish(s, await s.send({"op": "allow", "origins": origins, "resume": bool(p.get("resume"))},
                                             120))


async def auth_choose(p: dict[str, Any]) -> dict[str, Any]:
    s = _session(p)
    alt = p.get("alt_id")
    if not isinstance(alt, str) or not ALT_ID_RE.match(alt):
        raise ws.WorkspaceError("invalid_argument", "alt_id")
    async with s.lock:
        return await _finish(s, await s.send({"op": "choose", "alt_id": alt}, 90))


async def auth_observe(p: dict[str, Any]) -> dict[str, Any]:
    s = _session(p)
    if s.lock.locked():  # a fill/choose is running: the page is being changed on purpose
        return {"event": "step", "still_waiting": True, "changed": False, "busy": True}
    async with s.lock:
        return await _finish(s, await s.send({"op": "observe"}, 58))


async def auth_reload(p: dict[str, Any]) -> dict[str, Any]:
    s = _session(p)
    async with s.lock:
        return await _finish(s, await s.send({"op": "reload"}, 120))


async def auth_handoff(p: dict[str, Any]) -> dict[str, Any]:
    s = _session(p)
    async with s.lock:
        return await _finish(s, await s.send({"op": "handoff"}, 30))


async def auth_cancel(p: dict[str, Any]) -> dict[str, Any]:
    sid = p.get("session_id")
    s = _AUTH.get(sid) if isinstance(sid, str) else None
    if s is None:
        return {"cancelled": False}
    if p.get("agent_id") != s.agent_id:
        raise ws.WorkspaceError("forbidden", "session belongs to another agent")
    await _close(s)
    return {"cancelled": True}


async def auth_cancel_all(p: dict[str, Any]) -> dict[str, Any]:
    """Host start-up sweep: close every broker session the (new) host does not know (`keep` = its live ids)."""
    keep = {x for x in (p.get("keep") or []) if isinstance(x, str)}
    hid = p.get("host_id") if isinstance(p.get("host_id"), str) and HOST_ID_RE.match(p["host_id"]) else None
    n = 0
    for s in list(_AUTH.values()):
        if s.sid in keep:
            continue
        if hid and s.host_id and s.host_id != hid:
            continue  # V3.4: another NEBULA host instance's sign-in (e.g. a test instance must never end live ones)
        await _close(s)
        n += 1
    return {"cancelled": n}


def auth_status() -> dict[str, Any]:
    return {"ready": smart_auth_ready(), "active": len(_AUTH), "max": MAX_AUTH_SESSIONS}
