# ruff: noqa: F811 - fixtures are imported from other test modules and injected by pytest
"""Smart Authentication workflow (V3.2.1 spec §21.2-21.4): pause/resume, owner requests, multi-step sign-in, MFA,
saved credentials, just-in-time saving, expiry, cancellation, duplicates and isolation.

The guest side is a recording fake that behaves like the isolated broker on synthetic sites (step scripts). It proves
what the HOST does; the real broker + headless Chromium is verified in the VM by scripts/v321_smart_auth_e2e.py."""

from __future__ import annotations

import asyncio
import copy
import json
import os
import time
from typing import Any

import pytest

from tests.conftest import ScriptedProvider, call, done
from tests.integration.test_api import _agent, _setup_admin, _use_provider, _wait, client  # noqa: F401

ORIGIN = "https://login.fixture-site.com"
PASS = "vault passphrase for tests 9"
CANARY_PW = "CANARY-SA-PW-7c1e0b55"
CANARY_USER = "canary-sa-user@example.test"
CANARY_OTP = "482913"


def F(i, role, inp=None, **kw):
    return {"id": f"f{i}", "role": role, "input": inp or {"email": "email", "phone": "tel", "password": "password",
                                                           "otp": "code", "recovery_code": "code"}.get(role, "text"),
            **kw}


def step(kind, fields=(), *, origin=ORIGIN, confidence="HIGH", flags=(), otp=None):
    return {"step": kind, "fields": list(fields), "page_origin": origin, "confidence": confidence,
            "flags": list(flags), "otp": otp, "action_origin": None, "error": False, "login_context": True}


EMAIL_PW = [step("identifier_password", [F(0, "email"), F(1, "password")])]
SMS = step("otp", [F(0, "otp", length=6, charset="numeric")], otp={"channel": "sms", "length": 6,
                                                                    "charset": "numeric"})


class FakeAuthBroker:
    """The guest service + isolated broker for synthetic sites. `site` = list of steps; each step has `expect`
    (field id -> value) for credential/code steps. Records exactly what reached the trusted channel."""

    def __init__(self, fake, site: list[dict[str, Any]], *, expect: list[dict[str, str]] | None = None,
                 start_event: dict[str, Any] | None = None, after_fill: dict[int, dict[str, Any]] | None = None,
                 device_polls: int = 1, hint: dict[str, Any] | None = None) -> None:
        self.fake, self._orig = fake, fake.call
        self.site, self.expect = site, expect or []
        self.start_event, self.after_fill = start_event, after_fill or {}
        self.device_polls = device_polls
        self.hint = hint
        self.sessions: dict[str, dict[str, Any]] = {}
        self.delivered: list[tuple[str, dict[str, str]]] = []  # (session id, values) — trusted channel only
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.cookies_to: list[str] = []  # agent ids whose browser received cookies
        self.navigated: list[tuple[str, str]] = []

    def _ev(self, s):
        s["step_id"] += 1
        st = copy.deepcopy(self.site[s["i"]])
        return {"event": "step", "step_id": s["step_id"], "step": st, "page_origin": st["page_origin"],
                "url": st["page_origin"] + "/login", "error": None, "still_waiting": False}

    def _done(self, s, status="authenticated"):
        s["closed"] = True
        self.cookies_to.append(s["agent_id"])
        out = {"event": "result", "status": status, "final_url": ORIGIN + "/home", "cookies_imported": 2}
        if status == "authenticated":  # V3.4: the broker always says what proved the sign-in
            out["evidence"] = "signout_control"
        return out

    async def call(self, method, params=None, timeout=60):
        params = params or {}
        if method == "guest.capabilities":
            base = await self._orig(method, params, timeout)
            return {**base, "vault_broker": {"installed": True, "isolated": True, "smart_auth": True}}
        if method == "tool.call" and params.get("tool") == "browser.auth_hint":
            return {"ok": True, "result": {"url": ORIGIN + "/", "hint": self.hint}}
        if method == "tool.call" and params.get("tool") == "browser.navigate":
            self.navigated.append((params["agent_id"], params["args"]["url"]))
            return {"ok": True, "result": {"url": params["args"]["url"], "title": "x"}}
        if not method.startswith("vault.auth_"):
            return await self._orig(method, params, timeout)
        safe = {k: v for k, v in params.items() if k != "values"}
        self.calls.append((method, safe))
        sid = params.get("session_id")
        if method == "vault.auth_start":
            s = {"agent_id": params["agent_id"], "i": 0, "step_id": 0, "polls": 0, "closed": False,
                 "allowed": list(params["allowed_origins"]), "url": params["url"]}
            self.sessions[sid] = s
            if self.start_event and not params.get("_restart"):
                return copy.deepcopy(self.start_event)
            return self._ev(s)
        s = self.sessions.get(sid)
        if s is None or s["closed"]:
            return {"event": "error", "detail": "broker_exited"}
        if params.get("agent_id") != s["agent_id"]:
            raise RuntimeError("forbidden: session belongs to another agent")
        if method == "vault.auth_step":
            vals = dict(params["values"])  # copy what the broker received before the host wipes it
            self.delivered.append((sid, vals))
            if params["step_id"] != s["step_id"]:
                return {"event": "error", "detail": "stale_step"}
            if s["i"] in self.after_fill:
                ev = self.after_fill.pop(s["i"])
                return copy.deepcopy(ev)
            want = self.expect[s["i"]] if s["i"] < len(self.expect) else None
            if want is not None and vals != want:
                ev = self._ev(s)
                ev["error"] = "rejected"
                return ev
            s["i"] += 1
            if s["i"] >= len(self.site):
                return self._done(s)
            return self._ev(s)
        if method == "vault.auth_poll":
            await asyncio.sleep(0.4)  # the real broker waits for the page to change
            s["polls"] += 1
            if s["polls"] >= self.device_polls:
                s["i"] += 1
                if s["i"] >= len(self.site):
                    return self._done(s)
                return self._ev(s)
            cur = copy.deepcopy(self.site[s["i"]])
            return {"event": "step", "step_id": s["step_id"], "step": cur, "still_waiting": True}
        if method == "vault.auth_allow":
            s["allowed"] += params["origins"]
            return self._ev(s)
        if method == "vault.auth_handoff":
            s["closed"] = True
            self.cookies_to.append(s["agent_id"])
            return {"event": "result", "status": "handoff", "final_url": ORIGIN + "/challenge", "cookies_imported": 1}
        if method == "vault.auth_cancel":
            s["closed"] = True
            return {"cancelled": True}
        return {"event": "error", "detail": "unknown"}


def _broker(fake_guest, monkeypatch, site, **kw) -> FakeAuthBroker:
    from nebula_host import vault_broker as vb

    vb._cap.update(at=0.0, value=None)
    b = FakeAuthBroker(fake_guest, site, **kw)
    monkeypatch.setattr(fake_guest, "call", b.call)
    return b


@pytest.fixture(autouse=True)
def _fresh(monkeypatch):
    from nebula_host import smart_auth as sa
    from nebula_host import vault as v
    from nebula_host import vault_broker as vb

    monkeypatch.setattr(v, "calibrate_kdf", lambda *a, **k: {"alg": "argon2id", "salt": v.b64e(os.urandom(16)),
                                                              "time_cost": 2, "memory_kib": 8192, "parallelism": 1})

    def reset():
        v.VAULT._keys = None
        v.VAULT.unlocked_at = v.VAULT.last_activity = v.VAULT.reauth_at = None
        vb._cap.update(at=0.0, value=None)
        sa._RT.clear()
        sa._rate.clear()

    reset()
    yield
    reset()


def _task(client, h, agent_id, prov, monkeypatch, prompt="Open the site, sign in and read the dashboard"):
    _use_provider(monkeypatch, prov)
    return client.post(f"/api/v1/agents/{agent_id}/tasks", json={"prompt": prompt}, headers=h).json()["data"]


def _flow(url=ORIGIN + "/login", after=None):
    return ScriptedProvider([[call("request_sign_in", {"url": url}), done()],
                             *(after or [[call("browser_observe", {}), done()]]),
                             [call("task_complete", {"summary": "read the dashboard", "success": True}), done()]])


def _session(client, task_id, *, want_request=True, timeout=10.0, state=None) -> dict:
    end = time.time() + timeout
    last = None
    while time.time() < end:
        rows = client.get(f"/api/v1/smart-auth/sessions?task_id={task_id}").json()["data"]
        if rows:
            last = rows[0]
            if state and last["state"] == state:
                return last
            if not state and (not want_request or last["request"]):
                return last
        time.sleep(0.03)
    raise AssertionError(f"no sign-in request (last={last and last['state']})")


def _wait_request(client, sid, rtype=None, seq_gt=0, timeout=10.0) -> dict:
    end = time.time() + timeout
    s = None
    while time.time() < end:
        s = client.get(f"/api/v1/smart-auth/sessions/{sid}").json()["data"]
        r = s.get("request")
        if r and r["seq"] > seq_gt and (rtype is None or r["type"] == rtype):
            return s
        if s["state"] in ("AUTHENTICATED", "FAILED", "CANCELLED", "EXPIRED"):
            return s
        time.sleep(0.03)
    raise AssertionError(f"request not reached: {s and s['state']}")


def _wait_state(client, sid, states, timeout=10.0) -> dict:
    end = time.time() + timeout
    s = None
    while time.time() < end:
        s = client.get(f"/api/v1/smart-auth/sessions/{sid}").json()["data"]
        if s["state"] in states:
            return s
        time.sleep(0.03)
    raise AssertionError(f"state {s and s['state']} not in {states}")


def _submit(client, h, s, **body):
    tok = client.post(f"/api/v1/smart-auth/sessions/{s['id']}/token", headers=h)
    assert tok.status_code == 200, tok.text
    t = tok.json()["data"]
    return client.post(f"/api/v1/smart-auth/sessions/{s['id']}/submit",
                       json={"request_id": t["request_id"], "token": t["token"], **body}, headers=h)


def _results(prov, name="request_sign_in") -> list[dict]:
    seen, out = set(), []
    for req in prov.requests:
        for m in req.messages:
            if m.role == "tool" and m.tool_name == name and m.tool_call_id not in seen:
                seen.add(m.tool_call_id)
                out.append(json.loads(m.content))
    return out


def _vault(client, h, agent_id=None, *, grant_policy=None, origin=ORIGIN):
    assert client.post("/api/v1/vault", json={"passphrase": PASS}, headers=h).status_code == 201
    e = client.post("/api/v1/vault/entries", json={"display_name": "Example work", "origin": origin,
                                                    "username": CANARY_USER, "password": CANARY_PW},
                    headers=h).json()["data"]
    g = None
    if agent_id and grant_policy:
        assert client.put(f"/api/v1/agents/{agent_id}/vault", json={"mode": "SELECTED"}, headers=h).status_code == 200
        g = client.post(f"/api/v1/agents/{agent_id}/vault/grants", json={"entry_id": e["id"],
                                                                          "approval_policy": grant_policy},
                        headers=h).json()["data"]
    return e, g


# ============================================================================ §21.2 workflow
def test_detect_pause_owner_submit_broker_login_resume_with_context(client, fake_guest, monkeypatch):
    """21.2 #1-7: agent detects login -> task pauses -> owner gets ONE request -> submits -> broker signs in -> the
    agent resumes in the same task with its context and only a sanitized result."""
    h = _setup_admin(client)
    a = _agent(client, h)
    b = _broker(fake_guest, monkeypatch, EMAIL_PW, expect=[{"f0": CANARY_USER, "f1": CANARY_PW}])
    prov = _flow()
    t = _task(client, h, a["id"], prov, monkeypatch)
    s = _session(client, t["id"])
    assert s["state"] == "IDENTIFIER_AND_PASSWORD_REQUIRED" and s["agent_id"] == a["id"] and s["task_id"] == t["id"]
    assert s["verified_origin"] == ORIGIN and s["site"] == "login.fixture-site.com" and s["confidence"] == "HIGH"
    r = s["request"]
    assert r["type"] == "credentials" and [f["role"] for f in r["fields"]] == ["email", "password"]
    assert r["local"] is True and r["pin_required_for"] == [] and r["review_required"] is False
    task = client.get(f"/api/v1/tasks/{t['id']}").json()["data"]
    assert task["state"] == "WAITING_APPROVAL"  # paused while the owner answers
    # the same object is what Activity/approvals list
    center = client.get("/api/v1/approval-center").json()["data"]
    assert [x["id"] for x in center["sign_ins"]] == [s["id"]] and center["sign_ins"][0]["kind"] == "sign_in"
    r2 = _submit(client, h, s, action="credentials", values={"f0": CANARY_USER, "f1": CANARY_PW})
    assert r2.status_code == 202, r2.text
    done_ = _wait(client, t["id"], {"COMPLETED", "FAILED"})
    assert done_["state"] == "COMPLETED"
    assert b.delivered == [(s["id"], {"f0": CANARY_USER, "f1": CANARY_PW})]
    assert b.cookies_to == [a["id"]] and (a["id"], ORIGIN + "/home") in b.navigated
    res = _results(prov)[0]
    assert res["status"] == "authenticated" and res["origin"] == ORIGIN and res["page"] == ORIGIN + "/home"
    assert res["note"].startswith("Authentication completed successfully.")
    blob = json.dumps(res) + json.dumps([m.to_json() for m in prov.requests[-1].messages])
    assert CANARY_PW not in blob and CANARY_USER not in blob
    # context preserved: the model continued the same conversation after the tool result
    assert len(prov.requests) == 3 and prov.requests[1].messages[0].content == prov.requests[0].messages[0].content
    fin = client.get(f"/api/v1/smart-auth/sessions/{s['id']}").json()["data"]
    assert fin["state"] == "AUTHENTICATED" and fin["request"] is None and fin["auth_method"] == "new"
    assert {e["type"] for e in fin["events"]} >= {"session.created", "request.created", "owner.submitted",
                                                  "session.authenticated"}


def test_failed_login_allows_safe_retry_then_stops_before_lockout(client, fake_guest, monkeypatch):
    """21.2 #8 + rate limits: a rejected password asks again (same session, new request); after the maximum the
    session fails instead of hammering the site."""
    h = _setup_admin(client)
    a = _agent(client, h)
    _broker(fake_guest, monkeypatch, EMAIL_PW, expect=[{"f0": CANARY_USER, "f1": CANARY_PW}])
    prov = _flow()
    t = _task(client, h, a["id"], prov, monkeypatch)
    s = _session(client, t["id"])
    assert _submit(client, h, s, action="credentials", values={"f0": CANARY_USER, "f1": "wrong-1"}).status_code == 202
    s2 = _wait_request(client, s["id"], "credentials", seq_gt=s["request"]["seq"])
    assert s2["request"]["error"] == "credentials_rejected" and s2["attempts"]["credentials"] == 1
    # V3.4: the site said the details were wrong -> LOGIN_ERROR, the same two fields asked again
    assert s2["state"] == "LOGIN_ERROR" and s2["request"]["requirement"] == "IDENTIFIER_AND_PASSWORD_REQUIRED"
    assert [f["role"] for f in s2["request"]["fields"]] == ["email", "password"]
    assert _submit(client, h, s2, action="credentials", values={"f0": CANARY_USER, "f1": CANARY_PW}).status_code == 202
    _wait(client, t["id"], {"COMPLETED"})
    # lockout protection: three wrong answers end the session
    t2 = _task(client, h, a["id"], _flow(), monkeypatch)
    s = _session(client, t2["id"])
    for i in range(3):
        assert _submit(client, h, s, action="credentials", values={"f0": CANARY_USER, "f1": f"wrong-{i}"}
                       ).status_code == 202
        s = _wait_request(client, s["id"], "credentials", seq_gt=s["request"]["seq"])
        if s["state"] == "FAILED":
            break
    assert i == 2
    fin = _wait_state(client, s["id"], {"FAILED"})
    assert fin["error_code"] == "too_many_attempts"
    _wait(client, t2["id"], {"COMPLETED", "FAILED"})


def test_cancellation_ends_session_and_agent_does_not_ask_again(client, fake_guest, monkeypatch):
    """21.2 #9: owner cancels -> the task continues with 'cancelled' and a repeated request for the same site in the
    same task is refused without bothering the owner."""
    h = _setup_admin(client)
    a = _agent(client, h)
    b = _broker(fake_guest, monkeypatch, EMAIL_PW)
    prov = ScriptedProvider([[call("request_sign_in", {"url": ORIGIN + "/login"}, "c1"), done()],
                             [call("request_sign_in", {"url": ORIGIN + "/login?again=1"}, "c2"), done()],
                             [call("task_complete", {"summary": "could not sign in", "success": False}), done()]])
    t = _task(client, h, a["id"], prov, monkeypatch)
    s = _session(client, t["id"])
    r = client.post(f"/api/v1/smart-auth/sessions/{s['id']}/cancel", headers=h)
    assert r.status_code == 200 and r.json()["data"]["state"] == "CANCELLED"
    _wait(client, t["id"], {"COMPLETED", "FAILED"})
    res = _results(prov)
    assert res[0]["status"] == "cancelled" and "Do not ask again" in res[0]["note"]
    assert res[1]["status"] == "denied" and res[1]["reason_code"] == "owner_cancelled_earlier"
    assert [m for m, _ in b.calls].count("vault.auth_start") == 1 and ("vault.auth_cancel" in [m for m, _ in b.calls])
    rows = client.get(f"/api/v1/smart-auth/sessions?task_id={t['id']}").json()["data"]
    assert len(rows) == 1


def test_expiration_releases_task_and_broker(client, fake_guest, monkeypatch):
    """21.2 #10: an unanswered request expires (configurable), the paused task is released, the broker closed."""
    from nebula_host import db

    h = _setup_admin(client)
    a = _agent(client, h)
    b = _broker(fake_guest, monkeypatch, EMAIL_PW)
    db.set_setting("smart_auth", {"request_ttl_s": 120})
    prov = _flow()
    t = _task(client, h, a["id"], prov, monkeypatch)
    s = _session(client, t["id"])
    assert 110 < s["expires_at"] - time.time() <= 121
    from nebula_host import models
    from sqlalchemy import update

    with db.engine().begin() as c:  # fast-forward the clock for this session
        c.execute(update(models.auth_sessions).where(models.auth_sessions.c.id == s["id"])
                  .values(expires_at=time.time() - 1))
        c.execute(update(models.auth_requests).where(models.auth_requests.c.auth_session_id == s["id"])
                  .values(expires_at=time.time() - 1))
    fin = _wait_state(client, s["id"], {"EXPIRED"}, timeout=40)
    assert fin["error_code"] == "request_expired"
    _wait(client, t["id"], {"COMPLETED", "FAILED"}, timeout=15)
    assert _results(prov)[0]["status"] == "expired"
    assert "vault.auth_cancel" in [m for m, _ in b.calls]
    # an expired request cannot be answered
    r = client.post(f"/api/v1/smart-auth/sessions/{s['id']}/token", headers=h)
    assert r.status_code == 409


def test_duplicate_and_replayed_submissions_are_rejected(client, fake_guest, monkeypatch):
    """21.2 #11: every token is single-use; a second submit with the same token, or to an answered request, fails."""
    h = _setup_admin(client)
    a = _agent(client, h)
    b = _broker(fake_guest, monkeypatch, [*EMAIL_PW, SMS], device_polls=99)
    t = _task(client, h, a["id"], _flow(), monkeypatch)
    s = _session(client, t["id"])
    tok = client.post(f"/api/v1/smart-auth/sessions/{s['id']}/token", headers=h).json()["data"]
    body = {"request_id": tok["request_id"], "token": tok["token"], "action": "credentials",
            "values": {"f0": CANARY_USER, "f1": CANARY_PW}}
    assert client.post(f"/api/v1/smart-auth/sessions/{s['id']}/submit", json=body, headers=h).status_code == 202
    r = client.post(f"/api/v1/smart-auth/sessions/{s['id']}/submit", json=body, headers=h)
    assert r.status_code in (403, 409) and CANARY_PW not in r.text
    s2 = _wait_request(client, s["id"], "otp", seq_gt=s["request"]["seq"])
    # the old request id with a fresh token is refused too (it was answered)
    tok2 = client.post(f"/api/v1/smart-auth/sessions/{s['id']}/token", headers=h).json()["data"]
    assert tok2["request_id"] == s2["request"]["id"]
    r = client.post(f"/api/v1/smart-auth/sessions/{s['id']}/submit", json={**body, "token": tok2["token"]}, headers=h)
    assert r.status_code == 409
    assert len(b.delivered) == 1
    # a superseded token (a newer one was issued) no longer works
    tok3 = client.post(f"/api/v1/smart-auth/sessions/{s['id']}/token", headers=h).json()["data"]
    client.post(f"/api/v1/smart-auth/sessions/{s['id']}/token", headers=h)
    r = client.post(f"/api/v1/smart-auth/sessions/{s['id']}/submit", json={
        "request_id": tok3["request_id"], "token": tok3["token"], "action": "code", "values": {"f0": CANARY_OTP}},
        headers=h)
    assert r.status_code == 403
    client.post(f"/api/v1/smart-auth/sessions/{s['id']}/cancel", headers=h)
    _wait(client, t["id"], {"COMPLETED", "FAILED"})


def test_concurrent_sessions_are_isolated_per_agent(client, fake_guest, monkeypatch):
    """21.2 #12: two agents, two sessions; values and cookies go to the right session/agent; one agent cannot run
    two sign-ins at once."""
    h = _setup_admin(client)
    a = _agent(client, h, name="A")
    c2 = _agent(client, h, name="B")
    b = _broker(fake_guest, monkeypatch, EMAIL_PW)
    ta = _task(client, h, a["id"], _flow(), monkeypatch)
    sa_ = _session(client, ta["id"])
    tb = _task(client, h, c2["id"], _flow(), monkeypatch)
    sb = _session(client, tb["id"])
    assert sa_["id"] != sb["id"]
    # a token for session A cannot answer session B
    tok_a = client.post(f"/api/v1/smart-auth/sessions/{sa_['id']}/token", headers=h).json()["data"]
    r = client.post(f"/api/v1/smart-auth/sessions/{sb['id']}/submit", json={
        "request_id": tok_a["request_id"], "token": tok_a["token"], "action": "credentials",
        "values": {"f0": "b-user", "f1": "b-pass"}}, headers=h)
    assert r.status_code in (403, 409)
    assert _submit(client, h, sb, action="credentials", values={"f0": "b-user", "f1": "b-pass"}).status_code == 202
    assert _submit(client, h, sa_, action="credentials", values={"f0": "a-user", "f1": "a-pass"}).status_code == 202
    _wait(client, ta["id"], {"COMPLETED"})
    _wait(client, tb["id"], {"COMPLETED"})
    got = dict(b.delivered)
    assert got[sa_["id"]] == {"f0": "a-user", "f1": "a-pass"} and got[sb["id"]] == {"f0": "b-user", "f1": "b-pass"}
    assert sorted(b.cookies_to) == sorted([a["id"], c2["id"]])
    for m, p in b.calls:
        if m != "vault.auth_cancel":
            owner = {sa_["id"]: a["id"], sb["id"]: c2["id"]}[p["session_id"]]
            assert p["agent_id"] == owner  # the host never routes one agent's session to another agent


def test_restart_invalidates_open_sessions_without_secrets(client, fake_guest, monkeypatch, data_dir):
    """21.2 #13-14: host/agent/VM restart: open sessions become EXPIRED (fresh owner input needed); nothing secret
    is persisted to survive it; a broker that died mid-session fails the session cleanly."""
    from nebula_host import db, models, smart_auth
    from sqlalchemy import select

    h = _setup_admin(client)
    a = _agent(client, h)
    b = _broker(fake_guest, monkeypatch, [*EMAIL_PW, SMS])
    t = _task(client, h, a["id"], _flow(), monkeypatch)
    s = _session(client, t["id"])
    assert _submit(client, h, s, action="credentials", values={"f0": CANARY_USER, "f1": CANARY_PW}).status_code == 202
    s2 = _wait_request(client, s["id"], "otp", seq_gt=s["request"]["seq"])
    # VM restart: the broker process is gone -> next answer fails the session (no retry with the secret)
    for st in b.sessions.values():
        st["closed"] = True
    assert _submit(client, h, s2, action="code", values={"f0": CANARY_OTP}).status_code == 202
    fin = _wait_state(client, s["id"], {"FAILED"})
    assert fin["error_code"] == "broker_lost"
    _wait(client, t["id"], {"COMPLETED", "FAILED"})
    # host restart: recover() expires anything still open and keeps no runtime secrets
    t2 = _task(client, h, a["id"], _flow(), monkeypatch)
    s3 = _session(client, t2["id"])
    assert smart_auth.recover() >= 1 and smart_auth._RT == {}
    with db.engine().connect() as c:
        row = c.execute(select(models.auth_sessions).where(models.auth_sessions.c.id == s3["id"])).first()
    assert row.state == "EXPIRED" and row.error_code == "service_restarted"
    raw = (data_dir / "nebula.db").read_bytes() + ((data_dir / "nebula.db-wal").read_bytes()
                                                   if (data_dir / "nebula.db-wal").exists() else b"")
    for secret in (CANARY_PW, CANARY_USER, CANARY_OTP):
        assert secret.encode() not in raw


def test_no_login_form_and_unsupported_environment(client, fake_guest, monkeypatch):
    h = _setup_admin(client)
    a = _agent(client, h)
    _broker(fake_guest, monkeypatch, EMAIL_PW, start_event={"event": "result", "status": "no_login_form"})
    prov = _flow()
    t = _task(client, h, a["id"], prov, monkeypatch)
    _wait(client, t["id"], {"COMPLETED", "FAILED"})
    res = _results(prov)[0]
    assert res["status"] == "failed" and res["reason_code"] == "no_login_form"
    # loopback and invalid URLs are refused before anything starts
    prov = ScriptedProvider([[call("request_sign_in", {"url": "http://127.0.0.1:8080/login"}, "c1"), done()],
                             [call("request_sign_in", {"url": "javascript:alert(1)"}, "c2"), done()],
                             [call("task_complete", {"summary": "x", "success": False}), done()]])
    t = _task(client, h, a["id"], prov, monkeypatch)
    _wait(client, t["id"], {"COMPLETED", "FAILED"})
    res = _results(prov)
    assert res[0]["reason_code"] == "loopback_origin" and res[1]["reason_code"] == "invalid_url"


def test_already_signed_in_browser_skips_the_owner(client, fake_guest, monkeypatch):
    h = _setup_admin(client)
    a = _agent(client, h)
    b = _broker(fake_guest, monkeypatch, EMAIL_PW, hint={"step": "authenticated", "origin": ORIGIN})
    prov = _flow()
    t = _task(client, h, a["id"], prov, monkeypatch)
    _wait(client, t["id"], {"COMPLETED", "FAILED"})
    assert _results(prov)[0]["status"] == "already_signed_in" and b.calls == []


# ============================================================================ §21.3 vault integration
def test_existing_saved_credential_selection_and_grant_creation(client, fake_guest, monkeypatch):
    """21.3 #1, #5, #10: saved account offered (metadata only), owner picks it, the broker receives it, the owner
    may let this agent request it in future (grant, always ask) — nothing is granted silently."""
    h = _setup_admin(client)
    a = _agent(client, h)
    e, _ = _vault(client, h)
    b = _broker(fake_guest, monkeypatch, EMAIL_PW, expect=[{"f0": CANARY_USER, "f1": CANARY_PW}])
    t = _task(client, h, a["id"], _flow(), monkeypatch)
    s = _session(client, t["id"])
    acc = s["request"]["accounts"]
    assert acc == [{"entry_id": e["id"], "name": "Example work", "username": CANARY_USER, "has_grant": False,
                    "policy": None}]
    assert CANARY_PW not in json.dumps(s)
    assert client.get(f"/api/v1/agents/{a['id']}/vault").json()["data"]["grants"] == []
    r = _submit(client, h, s, action="saved", entry_id=e["id"], allow_future=True)
    assert r.status_code == 202, r.text
    _wait(client, t["id"], {"COMPLETED"})
    assert b.delivered[0][1] == {"f0": CANARY_USER, "f1": CANARY_PW}
    view = client.get(f"/api/v1/agents/{a['id']}/vault").json()["data"]
    assert view["mode"] == "SELECTED" and len(view["grants"]) == 1
    assert view["grants"][0]["approval_policy"] == "always_ask" and view["grants"][0]["allowed_origins"] == [ORIGIN]
    ops = [x["operation"] for x in client.get("/api/v1/vault/audit").json()["data"]]
    assert "use.smart_sign_in" in ops and "grant.create" in ops


def test_new_credential_use_once_is_not_saved(client, fake_guest, monkeypatch):
    """21.3 #3: default 'use once' — nothing goes to the vault."""
    h = _setup_admin(client)
    a = _agent(client, h)
    client.post("/api/v1/vault", json={"passphrase": PASS}, headers=h)
    _broker(fake_guest, monkeypatch, EMAIL_PW)
    t = _task(client, h, a["id"], _flow(), monkeypatch)
    s = _session(client, t["id"])
    assert s["request"]["vault"] == {"state": "unlocked", "can_save": True, "can_unlock": False, "reason": None}
    assert s["request"]["save_intent"] == "once"  # default: use once
    _submit(client, h, s, action="credentials", values={"f0": CANARY_USER, "f1": CANARY_PW})
    _wait(client, t["id"], {"COMPLETED"})
    assert client.get("/api/v1/vault/entries").json()["data"] == []
    assert client.get(f"/api/v1/smart-auth/sessions/{s['id']}").json()["data"]["saved_to_vault"] is False


def test_save_new_credential_to_vault_after_successful_multi_step_login(client, fake_guest, monkeypatch):
    """21.3 #2, #4 + 21.4 #8: identifier -> password -> OTP; saved (encrypted) only after success, OTP never saved,
    no grant unless asked."""
    h = _setup_admin(client)
    a = _agent(client, h)
    client.post("/api/v1/vault", json={"passphrase": PASS}, headers=h)
    site = [step("identifier", [F(0, "email")]), step("password", [F(0, "password")]), SMS]
    b = _broker(fake_guest, monkeypatch, site, expect=[{"f0": CANARY_USER}, {"f0": CANARY_PW}, {"f0": CANARY_OTP}])
    t = _task(client, h, a["id"], _flow(), monkeypatch)
    s = _session(client, t["id"])
    assert [f["role"] for f in s["request"]["fields"]] == ["email"]
    assert _submit(client, h, s, action="credentials", values={"f0": CANARY_USER}, save="vault",
                   name="Work account").status_code == 202
    s = _wait_request(client, s["id"], "credentials", seq_gt=s["request"]["seq"])
    assert [f["role"] for f in s["request"]["fields"]] == ["password"]
    assert _submit(client, h, s, action="credentials", values={"f0": CANARY_PW}, save="vault",
                   name="Work account").status_code == 202
    s = _wait_request(client, s["id"], "otp", seq_gt=s["request"]["seq"])
    assert s["state"] == "OTP_REQUIRED" and s["request"]["otp"]["channel"] == "sms"
    assert _submit(client, h, s, action="code", values={"f0": "482 913"}).status_code == 202  # spaces stripped
    _wait(client, t["id"], {"COMPLETED"})
    assert [v for _, v in b.delivered] == [{"f0": CANARY_USER}, {"f0": CANARY_PW}, {"f0": CANARY_OTP}]
    entries = client.get("/api/v1/vault/entries").json()["data"]
    assert len(entries) == 1 and entries[0]["display_name"] == "Work account" and entries[0]["origin"] == ORIGIN
    from nebula_host.vault import VAULT

    det = VAULT.entry_detail(entries[0]["id"])
    assert det["username"] == CANARY_USER and det["has_password"]
    assert client.get(f"/api/v1/agents/{a['id']}/vault").json()["data"]["grants"] == []  # no silent grant
    fin = client.get(f"/api/v1/smart-auth/sessions/{s['id']}").json()["data"]
    assert fin["saved_to_vault"] is True


def test_locked_vault_offers_names_but_no_use_and_refuses_save(client, fake_guest, monkeypatch):
    """21.3 #8-9: locked vault -> saved account names shown, use refused with the unlock message, 'save' refused;
    wrong passphrase handling is the vault's (no remote unlock exists)."""
    h = _setup_admin(client)
    a = _agent(client, h)
    e, _ = _vault(client, h)
    client.post("/api/v1/vault/lock", headers=h)
    _broker(fake_guest, monkeypatch, EMAIL_PW)
    t = _task(client, h, a["id"], _flow(), monkeypatch)
    s = _session(client, t["id"])
    req = s["request"]
    # V3.3: the reason is shown and the owner can unlock right there (never silently disabled)
    assert req["vault"]["state"] == "locked" and req["vault"]["can_save"] is False and req["vault"]["can_unlock"]
    assert "Unlock it" in req["vault"]["reason"]
    assert req["accounts"][0]["name"] == "Example work" and req["accounts"][0]["username"] is None
    r = _submit(client, h, s, action="saved", entry_id=e["id"])
    assert r.status_code == 409 and r.json()["error"]["code"] == "vault_locked"
    assert "Unlock it" in r.json()["error"]["message"]
    r = _submit(client, h, s, action="credentials", values={"f0": CANARY_USER, "f1": CANARY_PW}, save="vault")
    assert r.status_code == 409 and r.json()["error"]["code"] == "vault_locked"
    r = client.post("/api/v1/vault/unlock", json={"passphrase": "wrong passphrase 123"}, headers=h)
    assert r.status_code in (401, 403) and "wrong passphrase" not in r.text
    # the request is still answerable with "use once"
    assert _submit(client, h, s, action="credentials", values={"f0": CANARY_USER, "f1": CANARY_PW}).status_code == 202
    _wait(client, t["id"], {"COMPLETED"})


def test_grant_auto_signs_in_without_asking_and_revoked_grant_falls_back(client, fake_guest, monkeypatch):
    """21.3 #6-7, #10: an owner-made grant with the 'auto' policy is used without a form (3.2 semantics); after
    revocation the owner is asked again; the grant check is the vault's HMAC-verified one."""
    h = _setup_admin(client)
    a = _agent(client, h)
    e, g = _vault(client, h, a["id"], grant_policy="auto")
    b = _broker(fake_guest, monkeypatch, EMAIL_PW, expect=[{"f0": CANARY_USER, "f1": CANARY_PW}])
    t = _task(client, h, a["id"], _flow(), monkeypatch)
    _wait(client, t["id"], {"COMPLETED"})
    s = client.get(f"/api/v1/smart-auth/sessions?task_id={t['id']}").json()["data"][0]
    assert s["state"] == "AUTHENTICATED" and s["auth_method"] == "grant_auto" and len(b.delivered) == 1
    client.post(f"/api/v1/vault/grants/{g['id']}/revoke", headers=h)
    t2 = _task(client, h, a["id"], _flow(), monkeypatch)
    s2 = _session(client, t2["id"])
    assert s2["state"] == "IDENTIFIER_AND_PASSWORD_REQUIRED" and s2["request"]["accounts"][0]["has_grant"] is False
    client.post(f"/api/v1/smart-auth/sessions/{s2['id']}/cancel", headers=h)
    _wait(client, t2["id"], {"COMPLETED", "FAILED"})


# ============================================================================ §21.4 MFA
@pytest.mark.parametrize("otp,code", [({"channel": "sms", "length": 6, "charset": "numeric"}, "123456"),
                                      ({"channel": "email", "length": 8, "charset": "alphanumeric"}, "AB12CD34"),
                                      ({"channel": "totp", "length": 6, "charset": "numeric"}, "654321"),
                                      ({"channel": "unknown", "length": None, "charset": "alphanumeric"}, "x9Z4")])
def test_otp_channels_lengths_and_charsets(client, fake_guest, monkeypatch, otp, code):
    """21.4 #1, #4-7: correct codes for SMS / e-mail / authenticator, alphanumeric and variable length."""
    h = _setup_admin(client)
    a = _agent(client, h)
    f = F(0, "otp", length=otp["length"], charset=otp["charset"])
    site = [*EMAIL_PW, step("otp", [f], otp=otp)]
    b = _broker(fake_guest, monkeypatch, site, expect=[{"f0": "u@x.test", "f1": "pw"}, {"f0": code}])
    t = _task(client, h, a["id"], _flow(), monkeypatch)
    s = _session(client, t["id"])
    _submit(client, h, s, action="credentials", values={"f0": "u@x.test", "f1": "pw"})
    s = _wait_request(client, s["id"], "otp", seq_gt=s["request"]["seq"])
    assert s["request"]["otp"] == otp and s["request"]["code_ttl_s"] == 120
    if otp["length"]:  # wrong length / charset is refused before anything reaches the broker
        bad = "1" * (otp["length"] + 1)
        r = _submit(client, h, s, action="code", values={"f0": bad})
        assert r.status_code == 400 and r.json()["error"]["code"] == "invalid_code" and bad not in r.text
    if otp["charset"] == "numeric":
        r = _submit(client, h, s, action="code", values={"f0": "12ab56"})
        assert r.status_code == 400
    assert _submit(client, h, s, action="code", values={"f0": code}).status_code == 202
    _wait(client, t["id"], {"COMPLETED"})
    assert b.delivered[-1][1] == {"f0": code}


def test_incorrect_otp_retry_and_never_resubmitted(client, fake_guest, monkeypatch):
    """21.4 #2: wrong code -> sanitized error + new request; NEBULA never re-sends a code by itself."""
    h = _setup_admin(client)
    a = _agent(client, h)
    b = _broker(fake_guest, monkeypatch, [*EMAIL_PW, SMS], expect=[{"f0": "u@x.test", "f1": "pw"},
                                                                    {"f0": CANARY_OTP}])
    t = _task(client, h, a["id"], _flow(), monkeypatch)
    s = _session(client, t["id"])
    _submit(client, h, s, action="credentials", values={"f0": "u@x.test", "f1": "pw"})
    s = _wait_request(client, s["id"], "otp", seq_gt=s["request"]["seq"])
    _submit(client, h, s, action="code", values={"f0": "000000"})
    s = _wait_request(client, s["id"], "otp", seq_gt=s["request"]["seq"])
    assert s["request"]["error"] == "code_rejected" and s["attempts"]["codes"] == 1
    time.sleep(0.3)
    assert [v for _, v in b.delivered].count({"f0": "000000"}) == 1  # not resubmitted automatically
    _submit(client, h, s, action="code", values={"f0": CANARY_OTP})
    _wait(client, t["id"], {"COMPLETED"})


def test_expired_otp_submission_is_discarded(client, fake_guest, monkeypatch):
    """21.4 #3: a code that could not be delivered within the OTP validity is dropped, never sent late."""
    from nebula_host import smart_auth

    h = _setup_admin(client)
    a = _agent(client, h)
    b = _broker(fake_guest, monkeypatch, [*EMAIL_PW, SMS])
    t = _task(client, h, a["id"], _flow(), monkeypatch)
    s = _session(client, t["id"])
    _submit(client, h, s, action="credentials", values={"f0": "u@x.test", "f1": "pw"})
    s = _wait_request(client, s["id"], "otp", seq_gt=s["request"]["seq"])
    real_now = smart_auth._now
    monkeypatch.setattr(smart_auth, "_now", lambda: real_now() + (1000 if smart_auth._RT else 0))
    orig_submit = smart_auth._submit_values

    async def late(sid, rt, values, *, kind, received):  # the code waited longer than otp_ttl_s
        return await orig_submit(sid, rt, values, kind=kind, received=received - 10_000)

    monkeypatch.setattr(smart_auth, "_now", real_now)
    monkeypatch.setattr(smart_auth, "_submit_values", late)
    _submit(client, h, s, action="code", values={"f0": CANARY_OTP})
    fin = _wait_state(client, s["id"], {"FAILED"})
    assert fin["error_code"] == "code_expired_before_use"
    assert {"f0": CANARY_OTP} not in [v for _, v in b.delivered]
    _wait(client, t["id"], {"COMPLETED", "FAILED"})


def test_device_approval_waits_and_completes_only_when_verified(client, fake_guest, monkeypatch):
    """21.4 #9: device approval — waiting state, polling by the broker, success only once the site moved on."""
    h = _setup_admin(client)
    a = _agent(client, h)
    site = [*EMAIL_PW, step("device_approval")]
    b = _broker(fake_guest, monkeypatch, site, device_polls=2)
    t = _task(client, h, a["id"], _flow(), monkeypatch)
    s = _session(client, t["id"])
    _submit(client, h, s, action="credentials", values={"f0": "u@x.test", "f1": "pw"})
    s = _wait_request(client, s["id"], "device_approval", seq_gt=s["request"]["seq"])
    assert s["state"] == "AUTHENTICATOR_APPROVAL"
    _wait(client, t["id"], {"COMPLETED"})
    assert [m for m, _ in b.calls].count("vault.auth_poll") == 2


@pytest.mark.parametrize("kind", ["passkey", "captcha"])
def test_manual_handoff_passkey_and_captcha(client, fake_guest, monkeypatch, kind):
    """21.4 #10-11: a step only a human can do -> handoff to the agent's browser + Live Desktop; 'done' is verified
    in the agent's browser before the task resumes."""
    h = _setup_admin(client)
    a = _agent(client, h)
    site = [*EMAIL_PW, step(kind)]
    b = _broker(fake_guest, monkeypatch, site, hint={"step": kind, "origin": ORIGIN})
    t = _task(client, h, a["id"], _flow(), monkeypatch)
    s = _session(client, t["id"])
    _submit(client, h, s, action="credentials", values={"f0": "u@x.test", "f1": "pw"})
    s = _wait_request(client, s["id"], "manual", seq_gt=s["request"]["seq"])
    assert s["state"] == f"{kind.upper()}_REQUIRED" and {k: s["request"]["manual"][k] for k in ("kind", "live_desktop")} == {"kind": kind, "live_desktop": True}
    assert (a["id"], ORIGIN + "/challenge") in b.navigated and b.cookies_to == [a["id"]]
    r = _submit(client, h, s, action="manual_done")
    assert r.status_code == 409 and r.json()["error"]["code"] == "still_sign_in_page"  # never pretend
    b.hint = {"step": "authenticated", "origin": ORIGIN}
    assert _submit(client, h, s, action="manual_done").status_code == 202
    _wait(client, t["id"], {"COMPLETED"})
    fin = client.get(f"/api/v1/smart-auth/sessions/{s['id']}").json()["data"]
    assert fin["state"] == "AUTHENTICATED" and fin["auth_method"] == "manual"


def test_destination_review_redirect_to_other_site(client, fake_guest, monkeypatch):
    """§15: the sign-in page lives on another site -> owner review (LOW) before any secret is entered."""
    h = _setup_admin(client)
    a = _agent(client, h)
    idp = "https://sso.idp-provider.net"
    site = [step("identifier_password", [F(0, "email"), F(1, "password")], origin=idp)]
    b = _broker(fake_guest, monkeypatch, site, start_event={"event": "redirect", "origin": idp, "url": None})
    t = _task(client, h, a["id"], _flow(), monkeypatch)
    s = _session(client, t["id"])
    req = s["request"]
    assert req["type"] == "confirm_destination" and req["destination"]["origin"] == idp
    assert req["destination"]["same_site"] is False and req["confidence"] == "LOW" and req["review_required"]
    r = _submit(client, h, s, action="allow_destination")
    assert r.status_code == 400 and r.json()["error"]["code"] == "review_required"
    assert _submit(client, h, s, action="allow_destination", review_confirmed=True).status_code == 202
    s = _wait_request(client, s["id"], "credentials", seq_gt=req["seq"])
    assert s["verified_origin"] == idp and idp in s["allowed_origins"]
    assert ("vault.auth_allow", {"session_id": s["id"], "agent_id": a["id"], "origins": [idp], "resume": True}) \
        in b.calls
    client.post(f"/api/v1/smart-auth/sessions/{s['id']}/cancel", headers=h)
    _wait(client, t["id"], {"COMPLETED", "FAILED"})
