# ruff: noqa: F811 - fixtures are imported from other test modules and injected by pytest
"""Smart Auth 2.0 (V3.3): state-aware multi-step sign-in, risk-based destinations, loop guard, page-change watcher,
other sign-in methods, multi-step vault saving.

The broker is a scripted fake (exact events per call) so every host decision is checked deterministically; the real
broker with headless Chromium on synthetic Microsoft-style sites is exercised in the VM by
scripts/v33_smart_auth_e2e.py."""

from __future__ import annotations

import copy
import hashlib
import time
from typing import Any

import pytest

from tests.integration.test_api import _agent, _setup_admin, _wait, client  # noqa: F401
from tests.integration.test_smart_auth_flow import (  # noqa: F401
    CANARY_PW,
    CANARY_USER,
    PASS,
    F,
    _flow,
    _fresh,
    _results,
    _session,
    _submit,
    _task,
    _wait_request,
    _wait_state,
    step,
)

MS = "https://login.microsoftonline.com"
MSF = "https://login.microsoft.com"
TEAMS = "https://teams.microsoft.com"
CANARY_OTP = "551204"


def ev(kind, fields=(), origin=MS, *, alts=(), error=None, structure="HIGH", confidence="HIGH", flags=(), otp=None,
       fp=None):
    st = step(kind, fields, origin=origin, confidence=confidence, flags=flags, otp=otp)
    st["alternatives"] = [{"id": f"c{i + 3}", "kind": k} for i, k in enumerate(alts)]
    st["structure"] = structure
    st["fingerprint"] = fp or hashlib.sha256(f"{kind}|{origin}|{[f['role'] for f in fields]}|{list(alts)}".encode()
                                             ).hexdigest()[:16]
    return {"event": "step", "step": st, "page_origin": origin, "error": error, "still_waiting": False}


DONE = {"event": "result", "status": "authenticated", "final_url": MS + "/home", "cookies_imported": 2,
        "evidence": "provider_session_cookie"}
EMAIL = [F(0, "email")]
PW = [F(0, "password")]
OTP = [F(0, "otp", length=6, charset="numeric")]


class Script:
    """The guest broker as an exact script: per RPC method a queue of events (dict or callable(params))."""

    def __init__(self, fake, monkeypatch, plan: dict[str, list[Any]]) -> None:
        from nebula_host import vault_broker as vb

        vb._cap.update(at=0.0, value=None)
        self.plan = {k: list(v) for k, v in plan.items()}
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.values: list[dict[str, str]] = []
        self.navigated: list[str] = []
        self.step_id = 0
        self._orig = fake.call
        monkeypatch.setattr(fake, "call", self.call)

    def methods(self) -> list[str]:
        return [m for m, _ in self.calls]

    async def call(self, method, params=None, timeout=60):
        params = params or {}
        if method == "guest.capabilities":
            base = await self._orig(method, params, timeout)
            return {**base, "vault_broker": {"installed": True, "isolated": True, "smart_auth": True,
                                             "smart_auth_version": 2}}
        if method == "tool.call" and params.get("tool") == "browser.auth_hint":
            return {"ok": True, "result": {"url": "about:blank", "hint": None}}
        if method == "tool.call" and params.get("tool") == "browser.navigate":
            self.navigated.append(params["args"]["url"])
            return {"ok": True, "result": {"url": params["args"]["url"], "title": "x"}}
        if not method.startswith("vault.auth_"):
            return await self._orig(method, params, timeout)
        self.calls.append((method, {k: v for k, v in params.items() if k != "values"}))
        if method == "vault.auth_step":
            self.values.append(dict(params["values"]))
        q = self.plan.get(method)
        if not q:
            return {"vault.auth_observe": {"event": "step", "still_waiting": True, "changed": False},
                    "vault.auth_cancel": {"cancelled": True},
                    "vault.auth_poll": {"event": "step", "still_waiting": True}}.get(
                method, {"event": "error", "detail": "unscripted"})
        out = q.pop(0)
        out = copy.deepcopy(out(params) if callable(out) else out)
        if out.get("event") == "step" and not out.get("still_waiting"):
            self.step_id += 1
            out["step_id"] = self.step_id
        return out


def _owner(client):
    h = _setup_admin(client)
    return h, _agent(client, h)


def _states(client, sid) -> list[str]:
    from nebula_host import db, models
    from sqlalchemy import select

    with db.engine().connect() as c:
        rows = c.execute(select(models.auth_events.c.sanitized_metadata).where(
            models.auth_events.c.auth_session_id == sid).order_by(models.auth_events.c.timestamp)).all()
    return [r.sanitized_metadata.get("state") for r in rows if r.sanitized_metadata.get("state")]


# ============================================================================ 1-2 Microsoft multi-step
def test_microsoft_email_then_password_shows_a_password_form_not_the_email_again(client, fake_guest, monkeypatch):
    """Scenario 1 (the reported bug): e-mail accepted -> the page asks for the password -> the owner sees
    'Password required' with ONE password field — never the e-mail form again; the e-mail goes to the e-mail field
    and the password to the password field."""
    h, a = _owner(client)
    b = Script(fake_guest, monkeypatch, {"vault.auth_start": [ev("identifier", EMAIL)],
                                         "vault.auth_step": [ev("password", PW), DONE]})
    prov = _flow(url=MS + "/common/oauth2/authorize")
    t = _task(client, h, a["id"], prov, monkeypatch)
    s = _session(client, t["id"])
    assert s["state"] == "EMAIL_REQUIRED" and [f["role"] for f in s["request"]["fields"]] == ["email"]
    assert s["trust"]["level"] == "GREEN" and not s["request"]["review_required"]
    assert _submit(client, h, s, action="credentials", values={"f0": CANARY_USER}).status_code == 202
    s2 = _wait_request(client, s["id"], "credentials", seq_gt=s["request"]["seq"])
    assert s2["state"] == "PASSWORD_REQUIRED" and s2["step"] == "password"
    assert [f["role"] for f in s2["request"]["fields"]] == ["password"] and s2["request"]["error"] is None
    assert _submit(client, h, s2, action="credentials", values={"f0": CANARY_PW}).status_code == 202
    _wait(client, t["id"], {"COMPLETED"})
    assert b.values == [{"f0": CANARY_USER}, {"f0": CANARY_PW}]
    assert _results(prov)[0]["status"] == "authenticated"
    assert _states(client, s["id"])[:2] == ["EMAIL_REQUIRED", "PASSWORD_REQUIRED"]


def test_microsoft_email_password_then_otp(client, fake_guest, monkeypatch):
    """Scenario 2: e-mail -> password -> SMS code -> signed in; the code is a code field (6 digits)."""
    h, a = _owner(client)
    sms = ev("otp", OTP, otp={"channel": "sms", "length": 6, "charset": "numeric"})
    b = Script(fake_guest, monkeypatch, {"vault.auth_start": [ev("identifier", EMAIL)],
                                         "vault.auth_step": [ev("password", PW), sms, DONE]})
    t = _task(client, h, a["id"], _flow(url=MS + "/"), monkeypatch)
    s = _session(client, t["id"])
    _submit(client, h, s, action="credentials", values={"f0": CANARY_USER})
    s = _wait_request(client, s["id"], "credentials", seq_gt=s["request"]["seq"])
    _submit(client, h, s, action="credentials", values={"f0": CANARY_PW})
    s = _wait_request(client, s["id"], "otp", seq_gt=s["request"]["seq"])
    assert s["state"] == "OTP_REQUIRED" and s["request"]["otp"]["channel"] == "sms"
    assert s["request"]["fields"][0]["length"] == 6
    _submit(client, h, s, action="code", values={"f0": CANARY_OTP})
    _wait(client, t["id"], {"COMPLETED"})
    assert b.values == [{"f0": CANARY_USER}, {"f0": CANARY_PW}, {"f0": CANARY_OTP}]


@pytest.mark.parametrize("kind,fields,state", [
    ("password", PW, "PASSWORD_REQUIRED"),
    ("identifier_password", [F(0, "username"), F(1, "password")], "IDENTIFIER_AND_PASSWORD_REQUIRED"),
    ("identifier_password", [F(0, "phone"), F(1, "password")], "IDENTIFIER_AND_PASSWORD_REQUIRED"),
])
def test_password_only_username_and_phone_forms(client, fake_guest, monkeypatch, kind, fields, state):
    """Scenarios 4-6: the state and the fields follow the detected form."""
    h, a = _owner(client)
    Script(fake_guest, monkeypatch, {"vault.auth_start": [ev(kind, fields)], "vault.auth_step": [DONE]})
    t = _task(client, h, a["id"], _flow(url=MS + "/"), monkeypatch)
    s = _session(client, t["id"])
    assert s["state"] == state and [f["role"] for f in s["request"]["fields"]] == [f["role"] for f in fields]
    vals = {f["id"]: ("+420 000 000 111" if f["role"] == "phone" else "x" + f["role"]) for f in fields}
    assert _submit(client, h, s, action="credentials", values=vals).status_code == 202
    _wait(client, t["id"], {"COMPLETED"})


# ============================================================================ 3, 8, 17 verified provider + saving
def test_teams_redirect_to_microsoft_sign_in_is_verified_and_saved_as_one_credential(client, fake_guest, monkeypatch):
    """Scenarios 3, 8, 17: Teams -> login.microsoftonline.com is a verified first-party relationship: no destination
    question, no warning (GREEN). E-mail and password come from two pages and are saved together AFTER the verified
    sign-in, bound to the exact origin they were typed on and linked to Teams."""
    h, a = _owner(client)
    assert client.post("/api/v1/vault", json={"passphrase": PASS}, headers=h).status_code == 201
    b = Script(fake_guest, monkeypatch, {
        "vault.auth_start": [{"event": "redirect", "origin": MS, "url": None}],
        "vault.auth_allow": [ev("identifier", EMAIL)],
        "vault.auth_step": [ev("password", PW), DONE]})
    t = _task(client, h, a["id"], _flow(url=TEAMS + "/v2/"), monkeypatch)
    s = _session(client, t["id"])
    assert s["state"] == "EMAIL_REQUIRED" and s["verified_origin"] == MS
    assert s["trust"]["level"] == "GREEN" and s["trust"]["provider"] == "Microsoft"
    assert MS in s["allowed_origins"] and not s["request"]["review_required"]
    start = dict(b.calls)["vault.auth_start"]
    assert MS in start["cookie_origins"] and "ESTSAUTH" in start["session_cookies"][MS]
    assert _submit(client, h, s, action="credentials", values={"f0": CANARY_USER}, save="vault",
                   name="Work Microsoft").status_code == 202
    s2 = _wait_request(client, s["id"], "credentials", seq_gt=s["request"]["seq"])
    assert s2["state"] == "PASSWORD_REQUIRED" and s2["request"]["save_intent"] == "vault"
    assert _submit(client, h, s2, action="credentials", values={"f0": CANARY_PW}).status_code == 202  # same intent
    _wait(client, t["id"], {"COMPLETED"})
    from nebula_host.vault import VAULT

    entries = client.get("/api/v1/vault/entries").json()["data"]
    assert len(entries) == 1 and entries[0]["origin"] == MS and entries[0]["app_name"] == "teams.microsoft.com"
    d = VAULT.entry_detail(entries[0]["id"])
    assert d["username"] == CANARY_USER and d["has_password"]
    assert "REDIRECT_REVIEW_REQUIRED" not in _states(client, s["id"])
    detail = client.get(f"/api/v1/smart-auth/sessions/{s['id']}").json()["data"]
    assert any(e["type"] == "destination.verified" for e in detail["events"])


def test_save_is_never_done_when_the_sign_in_fails(client, fake_guest, monkeypatch):
    h, a = _owner(client)
    assert client.post("/api/v1/vault", json={"passphrase": PASS}, headers=h).status_code == 201
    Script(fake_guest, monkeypatch, {"vault.auth_start": [ev("identifier_password", [F(0, "email"), F(1, "password")])],
                                     "vault.auth_step": [{"event": "result", "status": "no_session"}]})
    t = _task(client, h, a["id"], _flow(url=MS + "/"), monkeypatch)
    s = _session(client, t["id"])
    _submit(client, h, s, action="credentials", values={"f0": CANARY_USER, "f1": CANARY_PW}, save="vault")
    _wait(client, t["id"], {"COMPLETED", "FAILED"})
    assert client.get("/api/v1/vault/entries").json()["data"] == []


# ============================================================================ 7, 9, 10 destinations
def test_unverified_redirect_needs_review_with_the_exact_hostname(client, fake_guest, monkeypatch):
    h, a = _owner(client)
    other = "https://sso.example-company.net"
    Script(fake_guest, monkeypatch, {"vault.auth_start": [{"event": "redirect", "origin": other, "url": None}],
                                     "vault.auth_allow": [ev("password", PW, origin=other)],
                                     "vault.auth_step": [DONE]})
    t = _task(client, h, a["id"], _flow(url=MS + "/"), monkeypatch)
    s = _session(client, t["id"])
    assert s["state"] == "REDIRECT_REVIEW_REQUIRED" and s["request"]["destination"]["origin"] == other
    assert s["request"]["trust"]["level"] == "YELLOW" and s["request"]["review_required"]
    assert _submit(client, h, s, action="allow_destination", review_confirmed=True).status_code == 202
    s2 = _wait_request(client, s["id"], "credentials", seq_gt=s["request"]["seq"])
    assert s2["state"] == "PASSWORD_REQUIRED" and s2["request"]["trust"]["level"] == "YELLOW"
    codes = [r["code"] for r in s2["request"]["trust"]["reasons"]]
    assert "owner_confirmed_destination" in codes


def test_lookalike_destination_is_blocked_and_cannot_be_confirmed(client, fake_guest, monkeypatch):
    """Scenario 9: a redirect to login-microsoftonline.com is RED: the session fails, nothing is sent there."""
    h, a = _owner(client)
    b = Script(fake_guest, monkeypatch, {"vault.auth_start": [ev("identifier", EMAIL)],
                                         "vault.auth_step": [{"event": "blocked", "origin": "https://login-microsoftonline.com",
                                                              "reason": "form_target"}]})
    prov = _flow(url=MS + "/")
    t = _task(client, h, a["id"], prov, monkeypatch)
    s = _session(client, t["id"])
    _submit(client, h, s, action="credentials", values={"f0": CANARY_USER})
    s = _wait_state(client, s["id"], {"FAILED"})
    assert s["error_code"] == "suspicious_destination" and s["trust"]["level"] == "RED"
    assert any(r["code"].startswith("lookalike:") for r in s["trust"]["reasons"])
    assert "vault.auth_allow" not in b.methods() and len(b.values) == 1  # never re-sent
    _wait(client, t["id"], {"COMPLETED", "FAILED"})
    assert _results(prov)[0]["reason_code"] == "suspicious_destination"


def test_agent_asking_for_a_lookalike_site_is_refused(client, fake_guest, monkeypatch):
    h, a = _owner(client)
    b = Script(fake_guest, monkeypatch, {})
    prov = _flow(url="https://login.microsoftonline.com.secure-check.io/")
    t = _task(client, h, a["id"], prov, monkeypatch)
    _wait(client, t["id"], {"COMPLETED", "FAILED"})
    res = _results(prov)[0]
    assert res["status"] == "denied" and res["reason_code"] == "suspicious_site"
    assert "vault.auth_start" not in b.methods()


def test_credential_exfiltration_is_a_hard_block(client, fake_guest, monkeypatch):
    """Scenario 10: a request carrying the typed value to another site = RED (hard): fails, never confirmable."""
    h, a = _owner(client)
    Script(fake_guest, monkeypatch, {"vault.auth_start": [ev("identifier_password", [F(0, "email"), F(1, "password")])],
                                     "vault.auth_step": [{"event": "blocked", "origin": "https://collector.example-cdn.com",
                                                          "reason": "exfiltration"}]})
    t = _task(client, h, a["id"], _flow(url=MS + "/"), monkeypatch)
    s = _session(client, t["id"])
    _submit(client, h, s, action="credentials", values={"f0": CANARY_USER, "f1": CANARY_PW})
    s = _wait_state(client, s["id"], {"FAILED"})
    assert s["error_code"] == "suspicious_destination" and s["trust"]["hard"] is True
    assert "credential_exfiltration" in [r["code"] for r in s["trust"]["reasons"]]


def test_phishing_page_on_the_requested_site_blocks_submission(client, fake_guest, monkeypatch):
    h, a = _owner(client)
    Script(fake_guest, monkeypatch, {"vault.auth_start": [
        ev("identifier_password", [F(0, "email"), F(1, "password")], origin="https://acct-portal.net",
           flags=["brand_mismatch:microsoft"], confidence="LOW")]})
    t = _task(client, h, a["id"], _flow(url="https://acct-portal.net/login"), monkeypatch)
    s = _session(client, t["id"], want_request=False, state="FAILED")
    assert s["error_code"] == "suspicious_page" and s["trust"]["level"] == "RED" and s["request"] is None


# ============================================================================ 11 stale forms / page changes
def test_page_change_while_the_form_is_open_replaces_the_request_and_refuses_the_stale_answer(client, fake_guest,
                                                                                            monkeypatch):
    from nebula_host import db

    db.set_setting("smart_auth", {"observe_interval_s": 3})
    h, a = _owner(client)
    b = Script(fake_guest, monkeypatch, {"vault.auth_start": [ev("identifier", EMAIL)],
                                         "vault.auth_observe": [{**ev("password", PW, error="page_changed"),
                                                                 "changed": True}],
                                         "vault.auth_step": [DONE]})
    t = _task(client, h, a["id"], _flow(url=MS + "/"), monkeypatch)
    s = _session(client, t["id"])
    tok = client.post(f"/api/v1/smart-auth/sessions/{s['id']}/token", headers=h).json()["data"]
    s2 = _wait_request(client, s["id"], "credentials", seq_gt=s["request"]["seq"], timeout=12)
    assert s2["state"] == "PASSWORD_REQUIRED" and s2["request"]["error"] == "page_changed"
    r = client.post(f"/api/v1/smart-auth/sessions/{s['id']}/submit",
                    json={"request_id": tok["request_id"], "token": tok["token"], "action": "credentials",
                          "values": {"f0": CANARY_USER}}, headers=h)
    assert r.status_code == 409 and r.json()["error"]["code"] == "request_closed"  # the stale e-mail answer
    assert b.values == []  # nothing reached the page
    assert _submit(client, h, s2, action="credentials", values={"f0": CANARY_PW}).status_code == 202
    _wait(client, t["id"], {"COMPLETED"})
    assert b.values == [{"f0": CANARY_PW}]


# ============================================================================ 12 loops
def test_same_step_without_progress_stops_and_offers_retry_live_desktop_or_cancel(client, fake_guest, monkeypatch):
    h, a = _owner(client)
    same = ev("identifier", EMAIL, fp="aaaaaaaaaaaaaaaa")
    b = Script(fake_guest, monkeypatch, {
        "vault.auth_start": [same],
        "vault.auth_step": [{**same, "error": "no_progress"}, {**same, "error": "no_progress"}],
        "vault.auth_reload": [ev("identifier", EMAIL, fp="bbbbbbbbbbbbbbbb")]})
    t = _task(client, h, a["id"], _flow(url=MS + "/"), monkeypatch)
    s = _session(client, t["id"])
    _submit(client, h, s, action="credentials", values={"f0": CANARY_USER})
    s = _wait_request(client, s["id"], "credentials", seq_gt=s["request"]["seq"])
    assert s["request"]["error"] == "no_progress" and s["attempts"]["credentials"] == 0  # not 'wrong credentials'
    _submit(client, h, s, action="credentials", values={"f0": CANARY_USER})
    s = _wait_request(client, s["id"], "loop", seq_gt=s["request"]["seq"])
    assert s["state"] == "WAITING_FOR_USER" and s["error_code"] == "loop_no_progress"
    assert s["request"]["loop"]["reason"] == "no_progress" and len(b.values) == 2  # automatic submission stopped
    assert _submit(client, h, s, action="credentials", values={"f0": "x"}).status_code == 400  # only retry/inspect
    assert _submit(client, h, s, action="retry").status_code == 202
    s = _wait_request(client, s["id"], "credentials", seq_gt=s["request"]["seq"])
    assert s["state"] == "EMAIL_REQUIRED" and "vault.auth_reload" in b.methods()
    client.post(f"/api/v1/smart-auth/sessions/{s['id']}/cancel", headers=h)  # scenario 20: cancel any time
    assert _wait_state(client, s["id"], {"CANCELLED"})["error_code"] == "owner_cancelled"


def test_rejected_credentials_count_attempts_and_stop(client, fake_guest, monkeypatch):
    """Scenario 13: an error shown by the site = rejected; three times = stopped (account protection)."""
    h, a = _owner(client)
    rej = {**ev("identifier_password", [F(0, "email"), F(1, "password")]), "error": "rejected"}
    Script(fake_guest, monkeypatch, {"vault.auth_start": [ev("identifier_password", [F(0, "email"), F(1, "password")])],
                                     "vault.auth_step": [rej, rej, rej]})
    t = _task(client, h, a["id"], _flow(url=MS + "/"), monkeypatch)
    s = _session(client, t["id"])
    for n in range(3):
        _submit(client, h, s, action="credentials", values={"f0": CANARY_USER, "f1": "wrong"})
        s = _wait_request(client, s["id"], "credentials", seq_gt=s["request"]["seq"]) if n < 2 else \
            _wait_state(client, s["id"], {"FAILED"})
    assert s["state"] == "FAILED" and s["error_code"] == "too_many_attempts"


# ============================================================================ other ways to sign in
def test_passkey_page_offers_the_password_method_instead(client, fake_guest, monkeypatch):
    """Microsoft passkey-first accounts: the owner can choose 'use my password' (the broker clicks that option on
    the page) or finish in Live Desktop."""
    h, a = _owner(client)
    b = Script(fake_guest, monkeypatch, {"vault.auth_start": [ev("identifier", EMAIL)],
                                         "vault.auth_step": [ev("passkey", (), origin=MS, alts=("password", "more")),
                                                             DONE],
                                         "vault.auth_choose": [ev("password", PW)]})
    t = _task(client, h, a["id"], _flow(url=MS + "/"), monkeypatch)
    s = _session(client, t["id"])
    _submit(client, h, s, action="credentials", values={"f0": CANARY_USER})
    s = _wait_request(client, s["id"], "manual", seq_gt=s["request"]["seq"])
    assert s["state"] == "PASSKEY_REQUIRED" and s["request"]["alternatives"] == ["password", "more"]
    assert _submit(client, h, s, action="choose", alternative="code").status_code == 409  # not offered
    s = _wait_request(client, s["id"], "manual", seq_gt=0)
    assert _submit(client, h, s, action="choose", alternative="password").status_code == 202
    s = _wait_request(client, s["id"], "credentials", seq_gt=s["request"]["seq"])
    assert s["state"] == "PASSWORD_REQUIRED"
    assert ("vault.auth_choose", {"session_id": s["id"], "agent_id": a["id"], "alt_id": "c3"}) in b.calls
    _submit(client, h, s, action="credentials", values={"f0": CANARY_PW})
    _wait(client, t["id"], {"COMPLETED"})


def test_device_approval_waits_and_success_resumes_the_agent(client, fake_guest, monkeypatch):
    """Authenticator approval: a waiting screen, polled by the host; success resumes the agent (scenario 14)."""
    h, a = _owner(client)
    Script(fake_guest, monkeypatch, {"vault.auth_start": [ev("identifier_password", [F(0, "email"), F(1, "password")])],
                                     "vault.auth_step": [ev("device_approval", ())],
                                     "vault.auth_poll": [{"event": "step", "still_waiting": True}, DONE]})
    prov = _flow(url=MS + "/")
    t = _task(client, h, a["id"], prov, monkeypatch)
    s = _session(client, t["id"])
    _submit(client, h, s, action="credentials", values={"f0": CANARY_USER, "f1": CANARY_PW})
    _wait(client, t["id"], {"COMPLETED"})
    assert "AUTHENTICATOR_APPROVAL" in _states(client, s["id"])  # the waiting screen was shown, then polled
    assert _results(prov)[0]["status"] == "authenticated"


def test_vault_locked_save_needs_unlock_and_shows_why(client, fake_guest, monkeypatch):
    """Scenarios 15-16: locked -> the save option says why and can be unlocked; unlocked -> can save."""
    h, a = _owner(client)
    assert client.post("/api/v1/vault", json={"passphrase": PASS}, headers=h).status_code == 201
    client.post("/api/v1/vault/lock", headers=h)
    Script(fake_guest, monkeypatch, {"vault.auth_start": [ev("identifier_password", [F(0, "email"), F(1, "password")])],
                                     "vault.auth_step": [DONE]})
    t = _task(client, h, a["id"], _flow(url=MS + "/"), monkeypatch)
    s = _session(client, t["id"])
    v = s["request"]["vault"]
    assert v["state"] == "locked" and not v["can_save"] and v["can_unlock"] and "Unlock it" in v["reason"]
    r = _submit(client, h, s, action="credentials", values={"f0": CANARY_USER, "f1": CANARY_PW}, save="vault")
    assert r.status_code == 409 and r.json()["error"]["code"] == "vault_locked"
    assert client.post("/api/v1/vault/unlock", json={"passphrase": PASS}, headers=h).status_code == 200
    s = client.get(f"/api/v1/smart-auth/sessions/{s['id']}").json()["data"]
    assert s["request"]["vault"]["can_save"] is True
    assert _submit(client, h, s, action="credentials", values={"f0": CANARY_USER, "f1": CANARY_PW},
                   save="vault").status_code == 202
    _wait(client, t["id"], {"COMPLETED"})
    assert len(client.get("/api/v1/vault/entries").json()["data"]) == 1


def test_trust_relationships_and_verified_sites_are_owner_configured(client):
    h = _setup_admin(client)
    r = client.post("/api/v1/smart-auth/trust/relationships", json={"service": "https://app.example-corp.com",
                                                                     "idp": "https://sso.example-corp.com"}, headers=h)
    assert r.status_code == 201 and r.json()["data"]["relationships"][0]["idp"] == "https://sso.example-corp.com"
    from nebula_host import auth_trust

    assert auth_trust.relationship("https://app.example-corp.com", "https://sso.example-corp.com")["source"] == "owner"
    bad = client.post("/api/v1/smart-auth/trust/relationships", json={"service": "https://app.example-corp.com",
                                                                       "idp": "https://login-microsoftonline.com"},
                      headers=h)
    assert bad.status_code == 400 and "imitates" in bad.json()["error"]["message"]
    plain = client.post("/api/v1/smart-auth/trust/sites", json={"origin": "http://insecure.example-corp.com"},
                        headers=h)
    assert plain.status_code == 400
    assert any(p["id"] == "microsoft" for p in client.get("/api/v1/smart-auth/trust").json()["data"]["builtin"])
    assert time.time() > 0
