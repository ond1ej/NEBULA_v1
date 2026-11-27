"""Trusted credential-use broker (Password Vault V1, V3.2).

The model never sees a password. An agent may only call ``vault_sign_in(credential=<opaque ref>, origin=<origin>)``;
the model gets back a status, the origin and how many session cookies arrived in its browser.

Why not type the password into the agent's own browser? In the VM every agent's browser, shell, Python/Node tools and
tool server run as the SAME unprivileged Linux user. Anything injected there is readable by that user (DOM, page
memory, its own tool socket, the browser profile) — i.e. by a prompt-injected or misbehaving agent. So the trusted
boundary is a separate Linux account:

  host (this module)                         guest service (root)              nebula-vault user (no login)
  authorise (identity from the execution  ->  vault.sign_in RPC over the  ->  short-lived headless Chromium with an
  context, grant HMAC, origin, expiry,        authenticated vsock channel      empty throw-away profile: exact-origin
  agent/task state) + owner approval          (password via stdin only)        check, fill, submit, redirect check,
  (single-use, bound to agent/task/                                            no screenshots, no password saving
  credential/origin/operation)                                                 -> session cookies of allowed origins
                                              cookies -> agent's browser   <-
                                              (browser.import_cookies)

What the agent ends up with is an authenticated *session* (cookies) for the approved origin — the same thing a human
would leave behind after signing in — never the password. Sites that need MFA/CAPTCHA or keep the session outside
cookies report ``needs_owner`` / ``no_session``; the owner can then sign in through Live Desktop / Take Control.
"""

from __future__ import annotations

import json
import logging
import time
from typing import Any
from urllib.parse import urlsplit

from sqlalchemy import and_, select, update

from nebula_host import db, models
from nebula_host import vault as vaultmod

log = logging.getLogger("nebula.vault.broker")

RESULT_STATES = ("signed_in", "login_failed", "needs_owner", "no_session", "redirect_blocked", "origin_mismatch",
                 "no_login_form", "timeout", "error")
_CAP_TTL = 300.0
_cap: dict[str, Any] = {"at": 0.0, "value": None}


def settings() -> dict[str, Any]:
    return {"broker_enabled": True, **(db.get_setting("vault", {}) or {})}


def _guest_capability() -> dict[str, Any] | None:
    return _cap["value"] if time.time() - _cap["at"] < _CAP_TTL else None


async def refresh_capability(guest) -> dict[str, Any]:
    try:
        caps = await guest.call("guest.capabilities", {}, timeout=15)
        vb = (caps or {}).get("vault_broker") or {"installed": False, "reason": "guest does not provide the broker"}
    except Exception as e:  # noqa: BLE001 - VM down etc.
        vb = {"installed": False, "reason": f"VM not reachable ({type(e).__name__})"}
    _cap.update(at=time.time(), value=vb)
    return vb


def status() -> dict[str, Any]:
    enabled = bool(settings().get("broker_enabled", True))
    cap = _guest_capability()
    if cap is None:
        available, reason = False, "not checked yet (VM broker self-test runs on first use)"
    else:
        available = bool(cap.get("installed") and cap.get("isolated"))
        reason = None if available else (cap.get("reason") or "isolation self-test failed")
    return {"enabled": enabled, "available": available, "reason": None if enabled and available else
            ("disabled by the owner" if not enabled else reason), "mechanism": "isolated_login_session_handoff",
            "environments": ["vm"]}


# ---------------------------------------------------------------- tool exposed to the model
def tool_for(agent_id: str, env: str):
    """The vault tool for this agent, or None (no access / Mac environment / broker disabled)."""
    if env != "vm" or not settings().get("broker_enabled", True):
        return None
    usable = vaultmod.VAULT.usable_for_agent(agent_id)
    if not usable:
        return None
    from nebula_runtime.tools import Tool, obj

    lines = "\n".join(f"- credential=\"{u['ref']}\" ({u['name']}) for {', '.join(u['origins'])}" for u in usable[:20])
    desc = ("Sign in to a website with a credential the owner stored in the NEBULA Password Vault. You never see or "
            "type the password: a trusted NEBULA broker signs in separately (after the owner approves, if required) "
            "and hands only the resulting session to your browser. Afterwards use browser_navigate to the site. "
            "Only these credentials/origins are allowed:\n" + lines +
            "\nIf the result is needs_owner or login_failed, tell the owner; never ask for the password, never try "
            "to read it, and never type passwords yourself.")
    return Tool("vault_sign_in", None, desc,
                obj({"credential": {"type": "string", "description": "opaque credential reference from the list"},
                     "origin": {"type": "string", "description": "exact origin, e.g. https://github.com"}},
                    ["credential", "origin"]), "STANDARD", side_effect=True)


def _deny(binding_or_ctx: dict[str, Any], code: str, message: str, *, approval_id: str | None = None) -> dict:
    vaultmod.record(f"agent:{binding_or_ctx.get('agent_id')}", "use.sign_in", outcome="denied",
                    agent_id=binding_or_ctx.get("agent_id"), entry_id=binding_or_ctx.get("entry_id"),
                    task_id=binding_or_ctx.get("task_id"), origin=binding_or_ctx.get("origin"),
                    approval_id=approval_id, reason=code)
    return {"status": "denied", "reason_code": code, "reason": message,
            "instruction": "Do not try to obtain or type this password another way. Tell the owner if you need it."}


def approval_preview(b: dict[str, Any], expires_at: float) -> dict[str, Any]:
    return {"kind": "vault_sign_in", "agent_name": b["agent_name"], "credential_name": b["entry_name"],
            "origin": b["origin"], "operation": b["operation"], "task_id": b["task_id"], "expires_at": expires_at,
            "binding": {"grant_id": b.get("grant_id"), "entry_id": b["entry_id"], "origin": b["origin"],
                        "operation": b["operation"], "agent_id": b["agent_id"], "task_id": b["task_id"],
                        "policy": b["policy"]}}


def approval_summary(b: dict[str, Any], expires_at: float) -> str:
    return (f"🔐 Password Vault: {b['agent_name']} wants to sign in to {b['origin']} using “{b['entry_name']}” "
            f"(task #{b['task_id'][:8]}). Approve once — expires {time.strftime('%H:%M', time.localtime(expires_at))}.")


def _binding_matches(row_preview: dict[str, Any] | None, b: dict[str, Any]) -> bool:
    got = (row_preview or {}).get("binding") or {}
    return all(got.get(k) == b.get(k) for k in ("grant_id", "entry_id", "origin", "operation", "agent_id", "task_id"))


def consume_approval(approval_id: str, b: dict[str, Any]) -> bool:
    """Single use: the approval must be approved, unexpired, unconsumed and bound to exactly this use."""
    now = time.time()
    with db.engine().begin() as c:
        row = db.row(c.execute(select(models.approvals).where(models.approvals.c.id == approval_id)).first())
        if not row or row["tool"] != "vault_sign_in" or row["decision"] != "approved" or row.get("consumed_at"):
            return False
        if row["task_id"] != b["task_id"] or row["agent_id"] != b["agent_id"] or row["expires_at"] < now:
            return False
        if not _binding_matches(row.get("action_preview"), b):
            return False
        n = c.execute(update(models.approvals).where(and_(models.approvals.c.id == approval_id,
                                                          models.approvals.c.consumed_at.is_(None)))
                      .values(consumed_at=now)).rowcount
    return n == 1


def once_per_task_approval(b: dict[str, Any]) -> str | None:
    """An earlier approval in THIS task for the same grant/origin, given while the vault stayed unlocked."""
    unlocked_at = vaultmod.VAULT.unlocked_at or time.time()
    with db.engine().connect() as c:
        rows = db.rows(c.execute(select(models.approvals).where(and_(
            models.approvals.c.task_id == b["task_id"], models.approvals.c.agent_id == b["agent_id"],
            models.approvals.c.tool == "vault_sign_in", models.approvals.c.decision == "approved",
            models.approvals.c.consumed_at.isnot(None)))))
    for r in rows:
        if (r.get("resolved_at") or 0) >= unlocked_at and _binding_matches(r.get("action_preview"), b) and \
                ((r.get("action_preview") or {}).get("binding") or {}).get("policy") == "once_per_task":
            return r["id"]
    return None


def denied_earlier(b: dict[str, Any]) -> bool:
    """The owner said no to this credential/origin in this task: do not ask again."""
    with db.engine().connect() as c:
        rows = db.rows(c.execute(select(models.approvals.c.action_preview).where(and_(
            models.approvals.c.task_id == b["task_id"], models.approvals.c.agent_id == b["agent_id"],
            models.approvals.c.tool == "vault_sign_in", models.approvals.c.decision == "denied"))))
    return any(_binding_matches(r.get("action_preview"), b) for r in rows)


def _clean_url(url: str | None) -> str | None:
    if not url:
        return None
    try:
        p = urlsplit(url)
        return f"{p.scheme}://{p.netloc}{p.path}"[:300]  # no query/fragment: they may carry tokens
    except ValueError:
        return None


async def sign_in(runner, tc, agent: dict[str, Any]) -> dict[str, Any]:
    """Executed by the task runner for a ``vault_sign_in`` tool call. Returns the model-visible payload."""
    args = tc.arguments or {}
    ref, origin = str(args.get("credential", ""))[:80], str(args.get("origin", ""))[:2000]
    ctx = {"agent_id": runner.agent_id, "task_id": runner.task_id, "origin": origin[:300]}
    if runner.env != "vm":
        return _deny(ctx, "unsupported_environment", "credential use is only available for agents working in the VM")
    if not settings().get("broker_enabled", True):
        return _deny(ctx, "broker_disabled", "the owner disabled agent credential use")
    try:
        b = vaultmod.VAULT.authorize(agent_id=runner.agent_id, ref=ref, origin=origin, operation="sign_in",
                                     task_id=runner.task_id)
    except vaultmod.VaultDenied as e:
        return _deny(ctx, e.code, str(e))
    cap = _guest_capability()
    if not cap or not (cap.get("installed") and cap.get("isolated")):  # never deny on a stale negative answer
        cap = await refresh_capability(runner.o.guest)
    if not (cap.get("installed") and cap.get("isolated")):
        return _deny(b, "broker_unavailable", f"the isolated login broker is not available ({cap.get('reason')})")

    if denied_earlier(b):
        return _deny(b, "owner_denied_earlier", "the owner already denied this sign-in in this task")
    approval_id: str | None = None
    if b["policy"] == "auto":
        pass
    elif b["policy"] == "once_per_task" and (prev := once_per_task_approval(b)):
        approval_id = prev
    else:
        expires = time.time() + vaultmod.APPROVAL_TTL_S
        verdict, approval_id = await runner.request_owner_approval(
            tc, summary=approval_summary(b, expires), preview=approval_preview(b, expires),
            reason="Password Vault credential use", categories=["credential_use"], ttl=vaultmod.APPROVAL_TTL_S)
        if verdict != "approved":
            return _deny(b, "owner_denied" if verdict == "denied" else f"approval_{verdict}",
                         f"the owner did not approve this sign-in ({verdict})", approval_id=approval_id)
        if not consume_approval(approval_id, b):
            return _deny(b, "approval_invalid", "the approval was already used, expired or does not match",
                         approval_id=approval_id)
    # re-check after the (possibly long) approval wait: lock, revocation, expiry, agent/task state
    try:
        b2 = vaultmod.VAULT.authorize(agent_id=runner.agent_id, ref=ref, origin=origin, operation="sign_in",
                                      task_id=runner.task_id)
    except vaultmod.VaultDenied as e:
        return _deny(b, e.code, str(e), approval_id=approval_id)
    if (b2["entry_id"], b2["origin"]) != (b["entry_id"], b["origin"]):
        return _deny(b, "binding_changed", "the credential or origin changed after approval", approval_id=approval_id)
    try:
        cred = vaultmod.VAULT.credential_for_broker(b2)
    except vaultmod.VaultError as e:
        return _deny(b, e.code, str(e), approval_id=approval_id)
    params = {"agent_id": runner.agent_id, "origin": b2["origin"], "allowed_origins": b2["allowed_origins"],
              "login_url": cred["login_url"], "username": cred["username"], "password": cred["password"],
              "timeout_s": 60}
    t0 = time.time()
    try:
        res = await runner.o.guest.call("vault.sign_in", params, timeout=120)
    except Exception as e:  # noqa: BLE001 - never echo params; the error type is enough
        res = {"status": "error", "detail": type(e).__name__}
    finally:
        params["password"] = ""
        params["username"] = ""
        cred.clear()
        del cred
    state = res.get("status") if res.get("status") in RESULT_STATES else "error"
    out = {"status": state, "origin": b2["origin"], "page": _clean_url(res.get("final_url")),
           "cookies_imported": int(res.get("cookies_imported") or 0), "elapsed_ms": round((time.time() - t0) * 1000)}
    if state == "signed_in":
        vaultmod.VAULT.mark_used(b2)
        runner.vault_origins.add(b2["origin"])
        out["note"] = ("Signed in. The session is now in your browser: use browser_navigate to "
                       f"{b2['origin']}. Actions like changing passwords, security/MFA settings, payments, "
                       "deleting the account or exporting data still need the owner's approval.")
    else:
        detail = str(res.get("detail") or "")[:200]
        out["note"] = {"needs_owner": "The site asks for something only the owner can provide (MFA/CAPTCHA). "
                                      "Tell the owner; they can finish the sign-in with Live Desktop.",
                       "login_failed": "The site rejected the stored credential. Tell the owner.",
                       "no_session": "Signed in, but the site keeps its session outside cookies; it could not be "
                                     "transferred. Tell the owner.",
                       "redirect_blocked": "The sign-in redirected to an origin the owner did not allow.",
                       }.get(state, f"Sign-in did not complete ({state}). {detail}".strip())
    vaultmod.record(f"agent:{runner.agent_id}", "use.sign_in", outcome="ok" if state == "signed_in" else "error",
                    agent_id=runner.agent_id, entry_id=b2["entry_id"], task_id=runner.task_id, origin=b2["origin"],
                    approval_id=approval_id, reason=state)
    log.info("vault sign-in agent=%s origin=%s status=%s", runner.agent_id, b2["origin"], state)
    return out


def scan_for_leaks(text: str, secrets_: list[str]) -> bool:
    """Test helper: True when any secret appears in text (also JSON-escaped)."""
    return any(s and (s in text or json.dumps(s)[1:-1] in text) for s in secrets_)
