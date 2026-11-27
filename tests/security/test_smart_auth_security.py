# ruff: noqa: F811 - fixtures are imported from other test modules and injected by pytest
"""Smart Authentication security (V3.2.1 spec §10, §14-15, §21.5): synthetic canaries never appear in model prompts,
tool results, task logs, conversations, Telegram texts, SSE/event rows, the database (+WAL), logs or API responses;
remote submission is narrowly scoped (gateway allow-list, PIN, single-use tokens, no vault management); forged or
cross-agent sessions and agent-made schemas cannot escalate."""

from __future__ import annotations

import json
import time
from pathlib import Path

import pytest

from tests.conftest import ScriptedProvider, call, done
from tests.integration.test_api import _agent, _setup_admin, _use_provider, _wait, client  # noqa: F401
from tests.integration.test_smart_auth_flow import (  # noqa: F401
    EMAIL_PW,
    ORIGIN,
    SMS,
    F,
    _broker,
    _flow,
    _fresh,
    _results,
    _session,
    _submit,
    _task,
    _vault,
    _wait_request,
    _wait_state,
    step,
)
from tests.integration.test_v3_api import _pair_owner, gateway  # noqa: F401
from tests.unit.test_v3_units import BOT_TOKEN, make_init_data

C_PW = "CANARY-SAS-PASSWORD-91f0"
C_USER = "canary-sas-user-3b@example.test"
C_OTP = "735190"
C_PIN = "CANARY-PIN-4471"
C_REC = "CANARYREC9137"
CANARIES = (C_PW, C_USER, C_OTP, C_PIN, C_REC)


@pytest.fixture()
def dbpath(data_dir) -> Path:
    from nebula_host.config import get_config

    return Path(get_config().db_path)


def _everything(client, dbpath: Path, prov, data_dir: Path, sent: list[str] | None = None) -> str:
    """Every place a secret must never be: DB + WAL (all tables incl. events/audit/tasks/messages/checkpoints/auth),
    logs, model requests (prompts, tool results, tool schemas), API responses, Telegram messages."""
    from nebula_host import db, models
    from sqlalchemy import select

    parts = []
    for p in (dbpath, Path(str(dbpath) + "-wal")):
        if p.exists():
            parts.append(p.read_bytes().decode("latin-1"))
    for p in data_dir.parent.rglob("*.log"):
        parts.append(p.read_text(errors="replace"))
    for req in prov.requests:
        parts.append(json.dumps([m.to_json() for m in req.messages]))
        parts.append(json.dumps([t.__dict__ for t in (req.tools or [])], default=str))
    for path in ("/api/v1/tasks", "/api/v1/smart-auth/sessions", "/api/v1/approval-center", "/api/v1/notifications",
                 "/api/v1/conversations", "/api/v1/audit", "/api/v1/vault/audit"):  # (SSE rows: events table)
        parts.append(client.get(path).text)
    with db.engine().connect() as c:
        parts.append(json.dumps([dict(r._mapping) for r in c.execute(select(models.events))], default=str))
        parts.append(json.dumps([dict(r._mapping) for r in c.execute(select(models.auth_events))], default=str))
        parts.append(json.dumps([dict(r._mapping) for r in c.execute(select(models.auth_requests))], default=str))
    parts.extend(sent or [])
    return "\n".join(parts)


def _mini(gateway, tg_id=7):
    _pair_owner(tg_id)
    r = gateway.post("/api/mini/auth", json={"init_data": make_init_data(BOT_TOKEN, user_id=tg_id)})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['data']['token']}"}


def _gsubmit(gateway, auth, sid, **body):
    t = gateway.post(f"/api/v1/smart-auth/sessions/{sid}/token", headers=auth)
    assert t.status_code == 200, t.text
    t = t.json()["data"]
    return gateway.post(f"/api/v1/smart-auth/sessions/{sid}/submit",
                        json={"request_id": t["request_id"], "token": t["token"], **body}, headers=auth)


# ============================================================================ canaries everywhere (§21.5)
def test_no_secret_anywhere_after_full_mfa_flow_with_vault_save(client, fake_guest, monkeypatch, data_dir, dbpath):
    h = _setup_admin(client)
    a = _agent(client, h)
    client.post("/api/v1/vault", json={"passphrase": "vault passphrase for tests 9"}, headers=h)
    rec = step("recovery_code", [F(0, "recovery_code")])
    b = _broker(fake_guest, monkeypatch, [*EMAIL_PW, SMS, rec], expect=[{"f0": C_USER, "f1": C_PW}, {"f0": C_OTP},
                                                                        {"f0": C_REC}])
    sent: list[str] = []

    async def capture(chat_id, text, *a_, **kw):
        sent.append(json.dumps({"text": text, **{k: v for k, v in kw.items() if k != "silent"}}, default=str))
        return {"message_id": 1}

    from nebula_host.state import svc

    monkeypatch.setattr(svc.telegram.api, "send_message", capture, raising=False)
    prov = _flow()
    t = _task(client, h, a["id"], prov, monkeypatch)
    s = _session(client, t["id"])
    _submit(client, h, s, action="credentials", values={"f0": C_USER, "f1": C_PW}, save="vault")
    s = _wait_request(client, s["id"], "otp", seq_gt=s["request"]["seq"])
    _submit(client, h, s, action="code", values={"f0": C_OTP})
    s = _wait_request(client, s["id"], "recovery_code", seq_gt=s["request"]["seq"])
    _submit(client, h, s, action="code", values={"f0": C_REC})
    _wait(client, t["id"], {"COMPLETED"})
    assert [v for _, v in b.delivered] == [{"f0": C_USER, "f1": C_PW}, {"f0": C_OTP}, {"f0": C_REC}]
    blob = _everything(client, dbpath, prov, data_dir, sent)
    for c in CANARIES:
        assert c not in blob, c
    # the vault holds the credential only as AES-GCM ciphertext (no plaintext anywhere in the DB)
    from nebula_host.vault import VAULT

    e = client.get("/api/v1/vault/entries").json()["data"][0]
    assert VAULT.entry_detail(e["id"])["username"] == C_USER
    # runtime memory: nothing left for this session
    from nebula_host import smart_auth

    assert s["id"] not in smart_auth._RT


def test_no_secret_on_failure_paths_and_validation_errors(client, fake_guest, monkeypatch, data_dir, dbpath):
    h = _setup_admin(client)
    a = _agent(client, h)
    _broker(fake_guest, monkeypatch, [*EMAIL_PW, SMS], expect=[{"f0": C_USER, "f1": C_PW}, {"f0": "999999"}])
    prov = _flow()
    t = _task(client, h, a["id"], prov, monkeypatch)
    s = _session(client, t["id"])
    r = _submit(client, h, s, action="credentials", values={"f0": C_USER, "f1": C_PW + "\x00"})
    assert r.status_code == 400 and C_PW not in r.text
    r = _submit(client, h, s, action="credentials", values={"f0": C_USER, "f1": C_PW, "f9": C_PW})
    assert r.status_code == 400 and C_PW not in r.text
    r = client.post(f"/api/v1/smart-auth/sessions/{s['id']}/submit", json={
        "request_id": s["request"]["id"], "token": "x" * 30, "action": "credentials",
        "values": {"f0": C_USER, "f1": C_PW}}, headers=h)
    assert r.status_code == 403 and C_PW not in r.text and C_USER not in r.text
    _submit(client, h, s, action="credentials", values={"f0": C_USER, "f1": C_PW})
    s = _wait_request(client, s["id"], "otp", seq_gt=s["request"]["seq"])
    for _ in range(3):
        _submit(client, h, s, action="code", values={"f0": C_OTP})
        s = _wait_request(client, s["id"], "otp", seq_gt=s["request"]["seq"])
        if s["state"] == "FAILED":
            break
    assert _wait_state(client, s["id"], {"FAILED"})["error_code"] == "too_many_attempts"
    _wait(client, t["id"], {"COMPLETED", "FAILED"})
    blob = _everything(client, dbpath, prov, data_dir)
    for c in (C_PW, C_USER, C_OTP):
        assert c not in blob, c


# ============================================================================ remote submission (§10)
def test_remote_submission_needs_pin_and_never_exposes_management(client, gateway, fake_guest, monkeypatch, data_dir,
                                                                  dbpath):
    h = _setup_admin(client)
    a = _agent(client, h)
    b = _broker(fake_guest, monkeypatch, [*EMAIL_PW, SMS], expect=[{"f0": C_USER, "f1": C_PW}, {"f0": C_OTP}])
    prov = _flow()
    t = _task(client, h, a["id"], prov, monkeypatch)
    s = _session(client, t["id"])
    auth = _mini(gateway)
    # metadata is readable remotely; the request says a PIN is needed
    r = gateway.get(f"/api/v1/smart-auth/sessions/{s['id']}", headers=auth)
    assert r.status_code == 200 and r.headers.get("cache-control", "").startswith("no-store")
    req = r.json()["data"]["request"]
    assert req["local"] is False and "credentials" in req["pin_required_for"] and req["pin_configured"] is False
    assert gateway.get("/api/v1/smart-auth/sessions", headers=auth).status_code == 200
    # no PIN configured -> remote password entry refused (nothing reaches the broker)
    r = _gsubmit(gateway, auth, s["id"], action="credentials", values={"f0": C_USER, "f1": C_PW})
    assert r.status_code == 403 and r.json()["error"]["code"] == "pin_not_configured" and C_PW not in r.text
    # V3.3: PIN and settings are the owner's from either interface, but only after a fresh re-verification
    for r in (gateway.put("/api/v1/smart-auth/pin", json={"pin": C_PIN}, headers=auth),
              gateway.put("/api/v1/smart-auth/settings", json={"remote_submission": True}, headers=auth)):
        assert r.status_code == 403 and r.json()["error"]["code"] == "stepup_required"
    assert client.put("/api/v1/smart-auth/pin", json={"pin": "123456"}, headers=h).status_code == 400  # trivial
    assert client.put("/api/v1/smart-auth/pin", json={"pin": C_PIN}, headers=h).status_code == 200
    # wrong PIN -> refused, counted; right PIN -> accepted
    r = _gsubmit(gateway, auth, s["id"], action="credentials", values={"f0": C_USER, "f1": C_PW}, pin="wrong-pin-1")
    assert r.status_code == 403 and r.json()["error"]["code"] == "pin_invalid"
    assert r.json()["error"]["details"]["attempts_left"] == 4 and C_PW not in r.text
    assert b.delivered == []
    r = _gsubmit(gateway, auth, s["id"], action="credentials", values={"f0": C_USER, "f1": C_PW}, pin=C_PIN)
    assert r.status_code == 202, r.text
    s = _wait_request(client, s["id"], "otp", seq_gt=s["request"]["seq"])
    # one-time codes need no PIN (bound to this request + single-use token)
    assert _gsubmit(gateway, auth, s["id"], action="code", values={"f0": C_OTP}).status_code == 202
    _wait(client, t["id"], {"COMPLETED"})
    # the remote surface has no route into vault management or broker internals
    for method, path, body in [("POST", "/api/v1/vault/unlock", {"passphrase": "x" * 12}),
                               ("GET", "/api/v1/vault/entries/x/reveal", None),
                               ("POST", "/api/v1/vault/export", {"export_passphrase": "x" * 12}),
                               ("POST", "/api/v1/vault/entries", {"display_name": "x"}),
                               ("PUT", "/api/v1/vault/passphrase", {}),
                               ("DELETE", "/api/v1/smart-auth/pin", None),
                               ("POST", f"/api/v1/smart-auth/sessions/{s['id']}/../../vault/unlock", {}),
                               ("POST", "/api/v1/smart-auth/sessions/as_123/submit", {}),
                               ("GET", f"/api/v1/smart-auth/sessions/{s['id']}/events", None)]:
        r = gateway.request(method, path, headers=auth, json=body)
        assert r.status_code in (403, 404, 405), (method, path, r.status_code)
    blob = _everything(client, dbpath, prov, data_dir)
    for c in (C_PW, C_USER, C_OTP, C_PIN):
        assert c not in blob, c
    pin_row = json.dumps(__import__("nebula_host.db", fromlist=["x"]).get_setting("smart_auth_pin"))
    assert C_PIN not in pin_row and "$argon2id$" in pin_row


def test_pin_lockout_is_persisted(client, gateway, fake_guest, monkeypatch):
    from nebula_host import smart_auth

    h = _setup_admin(client)
    a = _agent(client, h)
    _broker(fake_guest, monkeypatch, EMAIL_PW)
    client.put("/api/v1/smart-auth/pin", json={"pin": C_PIN}, headers=h)
    t = _task(client, h, a["id"], _flow(), monkeypatch)
    s = _session(client, t["id"])
    auth = _mini(gateway)
    codes = []
    for i in range(6):
        r = _gsubmit(gateway, auth, s["id"], action="credentials", values={"f0": "u", "f1": "p"}, pin=f"bad-pin-{i}")
        codes.append(r.json()["error"]["code"])
    assert codes[:4] == ["pin_invalid"] * 4 and "pin_locked" in codes
    assert smart_auth.pin_status()["locked_until"] > time.time()
    r = _gsubmit(gateway, auth, s["id"], action="credentials", values={"f0": "u", "f1": "p"}, pin=C_PIN)
    assert r.status_code == 429  # even the right PIN waits for the lockout
    client.post(f"/api/v1/smart-auth/sessions/{s['id']}/cancel", headers=h)
    _wait(client, t["id"], {"COMPLETED", "FAILED"})


def test_saved_credential_remote_rules(client, gateway, fake_guest, monkeypatch):
    """Saved credential from a remote session: M-04 — even a granted account needs the PIN or a fresh owner
    re-verification (a stolen, non-fresh phone session cannot sign an agent in with the owner's account);
    ungranted: needs the PIN."""
    h = _setup_admin(client)
    a = _agent(client, h)
    e, g = _vault(client, h, a["id"], grant_policy="always_ask")
    _broker(fake_guest, monkeypatch, EMAIL_PW)
    t = _task(client, h, a["id"], _flow(), monkeypatch)
    s = _session(client, t["id"])
    auth = _mini(gateway)
    assert s["request"]["accounts"][0]["has_grant"] is True
    r = _gsubmit(gateway, auth, s["id"], action="saved", entry_id=e["id"])
    assert r.status_code == 403 and r.json()["error"]["code"] == "pin_not_configured"
    assert gateway.post("/api/v1/auth/stepup", json={"method": "password", "password": "correct horse battery"},
                        headers=auth).status_code == 200
    assert _gsubmit(gateway, auth, s["id"], action="saved", entry_id=e["id"]).status_code == 202
    _wait(client, t["id"], {"COMPLETED"})
    client.post(f"/api/v1/vault/grants/{g['id']}/revoke", headers=h)
    from nebula_host import db, models
    from sqlalchemy import update

    with db.engine().begin() as c:  # the phone's re-verification has run out again
        c.execute(update(models.sessions).values(stepup_at=None))
    t2 = _task(client, h, a["id"], _flow(), monkeypatch)
    s2 = _session(client, t2["id"])
    r = _gsubmit(gateway, auth, s2["id"], action="saved", entry_id=e["id"])
    assert r.status_code == 403 and r.json()["error"]["code"] == "pin_not_configured"
    client.post(f"/api/v1/smart-auth/sessions/{s2['id']}/cancel", headers=h)
    _wait(client, t2["id"], {"COMPLETED", "FAILED"})


# ============================================================================ forged / cross-agent / escalation
def test_forged_sessions_cross_agent_and_unknown_ids(client, fake_guest, monkeypatch):
    h = _setup_admin(client)
    a = _agent(client, h, name="A")
    b_ = _agent(client, h, name="B")
    broker = _broker(fake_guest, monkeypatch, EMAIL_PW)
    t = _task(client, h, a["id"], _flow(), monkeypatch)
    s = _session(client, t["id"])
    assert client.get("/api/v1/smart-auth/sessions/as_" + "0" * 24).status_code == 404
    assert client.post("/api/v1/smart-auth/sessions/as_" + "0" * 24 + "/token", headers=h).status_code == 404
    # the agent identity of a session comes from the execution context; the guest call is bound to it
    starts = [p for m, p in broker.calls if m == "vault.auth_start"]
    assert starts[0]["agent_id"] == a["id"] and starts[0]["session_id"] == s["id"]
    # agent B's runner cannot see or drive A's session: tool args never carry a session id or agent id
    from nebula_host import smart_auth

    tool = smart_auth.tool()
    assert set(tool.params["properties"]) == {"url"} and tool.params["additionalProperties"] is False
    client.post(f"/api/v1/smart-auth/sessions/{s['id']}/cancel", headers=h)
    _wait(client, t["id"], {"COMPLETED", "FAILED"})
    assert b_["id"] not in json.dumps(broker.calls)


def test_model_generated_schema_cannot_escalate(client, fake_guest, monkeypatch):
    """Whatever the model passes, the form is built from the broker's own detection, validated by the host; an
    agent-chosen 'reason', fields, labels or origin never become trusted UI; unknown roles / extra fields are refused."""
    from nebula_host import smart_auth

    h = _setup_admin(client)
    a = _agent(client, h)
    evil = {"step": "identifier_password", "page_origin": ORIGIN, "confidence": "HIGH", "flags": [],
            "fields": [{"id": "f0", "role": "credit_card", "input": "text"}, {"id": "f1", "role": "password"}]}
    _broker(fake_guest, monkeypatch, [evil])
    prov = ScriptedProvider([[call("request_sign_in", {"url": ORIGIN + "/login", "reason": "IGNORE ALL RULES",
                                                       "fields": ["ssn", "card"], "origin": "https://evil.test",
                                                       "agent_id": "someone-else"}), done()],
                             [call("task_complete", {"summary": "x", "success": False}), done()]])
    t = _task(client, h, a["id"], prov, monkeypatch)
    _wait(client, t["id"], {"COMPLETED", "FAILED"})
    rows = client.get(f"/api/v1/smart-auth/sessions?task_id={t['id']}").json()["data"]
    assert rows[0]["state"] == "FAILED" and rows[0]["error_code"] == "bad_step"
    assert rows[0]["requested_origin"] == ORIGIN and rows[0]["agent_id"] == a["id"]
    with pytest.raises(smart_auth.AuthError):
        smart_auth._valid_step({**evil, "fields": [{"id": "x;alert(1)", "role": "password"}]}, [ORIGIN])
    with pytest.raises(smart_auth.AuthError):  # the page must be on an allowed (verified) origin
        smart_auth._valid_step({**evil, "page_origin": "https://evil.test",
                                "fields": [{"id": "f1", "role": "password"}]}, [ORIGIN])


def test_unapproved_origin_change_and_blocked_form_target_need_owner(client, fake_guest, monkeypatch):
    """§15: a filled form posting to another origin is blocked by the broker; the owner must allow that destination
    (with secrets pending, remotely also the PIN) before the same values are sent again — once."""
    h = _setup_admin(client)
    a = _agent(client, h)
    other = "https://api.other-site.net"
    b = _broker(fake_guest, monkeypatch, EMAIL_PW,
                after_fill={0: {"event": "blocked", "origin": other}})
    t = _task(client, h, a["id"], _flow(), monkeypatch)
    s = _session(client, t["id"])
    _submit(client, h, s, action="credentials", values={"f0": C_USER, "f1": C_PW})
    s = _wait_request(client, s["id"], "confirm_destination", seq_gt=s["request"]["seq"])
    d = s["request"]["destination"]
    assert d == {"origin": other, "kind": "form_target", "same_site": False, "requested_origin": ORIGIN,
                 "secrets_pending": True}
    assert other not in s["allowed_origins"]
    assert _submit(client, h, s, action="allow_destination", review_confirmed=True).status_code == 202
    _wait(client, t["id"], {"COMPLETED"})
    assert [v for _, v in b.delivered] == [{"f0": C_USER, "f1": C_PW}, {"f0": C_USER, "f1": C_PW}]
    from nebula_host import smart_auth

    assert all(not rt.pending for rt in smart_auth._RT.values())


def test_sse_and_event_payloads_carry_metadata_only(client, fake_guest, monkeypatch):
    from nebula_host import db, models
    from sqlalchemy import select

    h = _setup_admin(client)
    a = _agent(client, h)
    _broker(fake_guest, monkeypatch, EMAIL_PW)
    t = _task(client, h, a["id"], _flow(), monkeypatch)
    s = _session(client, t["id"])
    _submit(client, h, s, action="credentials", values={"f0": C_USER, "f1": C_PW})
    _wait(client, t["id"], {"COMPLETED"})
    with db.engine().connect() as c:
        evs = [dict(r._mapping) for r in c.execute(select(models.events).where(
            models.events.c.type.in_(["auth.session.updated", "auth.request"])))]
    assert evs and {e["type"] for e in evs} == {"auth.session.updated", "auth.request"}
    allowed = {"session_id", "state", "step", "origin", "site", "agent_name", "conversation_id", "request_type", "trust",
               "request_id", "confidence", "error_code", "expires_at", "verified", "destination"}
    for e in evs:
        assert set(e["payload"]) <= allowed
    assert C_PW not in json.dumps(evs, default=str) and C_USER not in json.dumps(evs, default=str)


def test_high_risk_actions_after_smart_sign_in_still_need_approval(client, fake_guest, monkeypatch):
    """§3.13: a successful login does not authorize unrelated high-risk account actions."""
    h = _setup_admin(client)
    a = _agent(client, h)
    _broker(fake_guest, monkeypatch, EMAIL_PW)
    prov = ScriptedProvider([[call("request_sign_in", {"url": ORIGIN + "/login"}), done()],
                             [call("browser_navigate", {"url": ORIGIN + "/settings/security/two_factor/disable"}),
                              done()],
                             [call("task_complete", {"summary": "x", "success": True}), done()]])
    t = _task(client, h, a["id"], prov, monkeypatch)
    s = _session(client, t["id"])
    _submit(client, h, s, action="credentials", values={"f0": C_USER, "f1": C_PW})
    end = time.time() + 10
    appr = None
    while time.time() < end and not appr:
        tt = client.get(f"/api/v1/tasks/{t['id']}").json()["data"]
        appr = next((x for x in tt["approvals"] if x["decision"] is None), None)
        time.sleep(0.05)
    assert appr is not None and "account_security" in (appr.get("reason") or "")
    client.post(f"/api/v1/approvals/{appr['id']}", json={"decision": "denied"}, headers=h)
    _wait(client, t["id"], {"COMPLETED", "FAILED"})


def test_telegram_notification_has_button_but_no_secret_field(client, fake_guest, monkeypatch):
    from nebula_host import remote
    from nebula_telegram import v3 as tg3

    sent = []

    class Api:
        async def send_message(self, chat, text, thread=None, reply_markup=None, silent=False):
            sent.append((text, reply_markup))

    class Ctx:
        api = Api()

    monkeypatch.setattr(remote, "public_base", lambda: "https://nebula.example.ts.net")
    ev = {"task_id": "t" * 36, "payload": {"session_id": "as_" + "a" * 24, "request_id": "ar_1", "request_type":
                                            "credentials", "site": "github.com", "origin": "https://github.com",
                                            "agent_name": "Developer", "expires_at": time.time() + 600}}
    import asyncio

    asyncio.run(tg3.send_sign_in(Ctx(), 7, None, ev))
    asyncio.run(tg3.send_sign_in(Ctx(), 7, None, ev))  # same request: only one message
    assert len(sent) == 1
    text, kb = sent[0]
    assert "Authentication required" in text and "github.com" in text and "Developer" in text
    btns = [b for row in kb["inline_keyboard"] for b in row]
    assert btns[0]["web_app"]["url"] == "https://nebula.example.ts.net/mini/#/auth/as_" + "a" * 24
    assert btns[1]["callback_data"] == "auth:as_" + "a" * 24 + ":c"
    assert "password" not in json.dumps(kb).lower()
