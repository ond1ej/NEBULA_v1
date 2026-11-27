# ruff: noqa: F811 - fixtures are imported from other test modules and injected by pytest
"""Regression tests for the V3.2.1 Smart Authentication security review: origin binding of saved credentials,
saving only what was typed on the site itself, local-network origins, remote limits (no usernames, no grants), PIN
handling, unconfirmed sign-ins, no hand-off of credential-bearing manual steps, expiry while an answer is processed,
review gate for codes, guest cancel/sweep, Telegram labels."""

from __future__ import annotations

import asyncio
import json
import sys
import time
from pathlib import Path

import pytest

from tests.integration.test_api import _agent, _setup_admin, _wait, client  # noqa: F401
from tests.integration.test_smart_auth_flow import (  # noqa: F401
    EMAIL_PW,
    ORIGIN,
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
from tests.integration.test_v3_api import gateway  # noqa: F401
from tests.security.test_smart_auth_security import _gsubmit, _mini

IDP = "https://sso.identity-provider.net"
C_PW = "CANARY-REVIEW-PW-1f2e"
C_USER = "canary-review@example.com"


def test_saved_account_is_never_typed_on_another_origin(client, fake_guest, monkeypatch):
    """Finding 1: saved account chosen on the site, the password step moves to an IdP the owner allowed -> NEBULA
    stops and asks; the saved password is not typed there."""
    h = _setup_admin(client)
    a = _agent(client, h)
    e, g = _vault(client, h, a["id"], grant_policy="always_ask")
    site = [step("identifier", [F(0, "email")]), step("password", [F(0, "password")], origin=IDP)]
    b = _broker(fake_guest, monkeypatch, site, after_fill={0: {"event": "redirect", "origin": IDP, "url": None}})
    t = _task(client, h, a["id"], _flow(), monkeypatch)
    s = _session(client, t["id"])
    assert _submit(client, h, s, action="saved", entry_id=e["id"]).status_code == 202
    s = _wait_request(client, s["id"], "confirm_destination", seq_gt=s["request"]["seq"])
    assert s["request"]["destination"]["origin"] == IDP and s["request"]["destination"]["secrets_pending"] is False
    assert _submit(client, h, s, action="allow_destination", review_confirmed=True).status_code == 202
    s = _wait_request(client, s["id"], "credentials", seq_gt=s["request"]["seq"])
    assert s["state"] == "PASSWORD_REQUIRED" and s["verified_origin"] == IDP
    assert [v for _, v in b.delivered] == [{"f0": "canary-sa-user@example.test"}] or \
        all("CANARY-SA-PW-7c1e0b55" not in json.dumps(v) for _, v in b.delivered)
    # V3.3: the owner may save what they typed there — bound to that exact origin (the IdP) and NOT linked to the
    # site (no verified relationship): it can never be typed on the site or anywhere else
    r = _submit(client, h, s, action="credentials", values={"f0": C_PW}, save="vault", review_confirmed=True)
    assert r.status_code == 202
    _wait(client, t["id"], {"COMPLETED", "FAILED"})
    new = [x for x in client.get("/api/v1/vault/entries").json()["data"] if x["id"] != e["id"]]
    assert len(new) == 1 and new[0]["origin"] == IDP and not new[0].get("app_name")


def test_local_network_origins_refused_by_default_and_reviewed_when_allowed(client, fake_guest, monkeypatch):
    """Finding 8: IP literals / local names could be served by an agent itself."""
    from nebula_host import db, smart_auth

    for o in ("http://192.168.64.6:8080", "https://10.0.0.1", "http://0.0.0.0:9", "https://nas.local", "https://intranet",
              "https://router.home.arpa", "https://[fd00::1]"):
        assert smart_auth.is_local_network_origin(o), o
    for o in ("https://github.com", "https://login.fixture-site.com"):
        assert not smart_auth.is_local_network_origin(o), o
    h = _setup_admin(client)
    a = _agent(client, h)
    lan = "http://192.168.1.50:8080"
    _broker(fake_guest, monkeypatch, [step("identifier_password", [F(0, "email"), F(1, "password")], origin=lan)])
    prov = _flow(url=lan + "/login")
    t = _task(client, h, a["id"], prov, monkeypatch)
    _wait(client, t["id"], {"COMPLETED", "FAILED"})
    assert _results(prov)[0]["reason_code"] == "local_network_origin"
    r = client.put("/api/v1/smart-auth/settings", json={"allow_local_network": True}, headers=h)
    assert r.status_code == 200 and r.json()["data"]["allow_local_network"] is True
    t = _task(client, h, a["id"], _flow(url=lan + "/login"), monkeypatch)
    s = _session(client, t["id"])
    assert "local_network" in s["flags"] and s["confidence"] == "MEDIUM" and s["request"]["review_required"]
    client.post(f"/api/v1/smart-auth/sessions/{s['id']}/cancel", headers=h)
    _wait(client, t["id"], {"COMPLETED", "FAILED"})
    db.set_setting("smart_auth", {})


def test_remote_sees_no_usernames_cannot_grant_and_empty_pin_is_not_an_attempt(client, gateway, fake_guest,
                                                                                monkeypatch):
    """Findings 4 and 10."""
    from nebula_host import smart_auth

    h = _setup_admin(client)
    a = _agent(client, h)
    e, _ = _vault(client, h)
    _broker(fake_guest, monkeypatch, EMAIL_PW)
    client.put("/api/v1/smart-auth/pin", json={"pin": "CANARY-PIN-review-7"}, headers=h)
    t = _task(client, h, a["id"], _flow(), monkeypatch)
    s = _session(client, t["id"])
    auth = _mini(gateway)
    req = gateway.get(f"/api/v1/smart-auth/sessions/{s['id']}", headers=auth).json()["data"]["request"]
    # V3.3: from the phone without a fresh re-verification: no usernames; granting future use needs a step-up
    assert req["accounts"][0]["username"] is None and req["allow_future_needs_stepup"] is True
    center = gateway.get("/api/v1/approval-center", headers=auth).json()["data"]["sign_ins"][0]["request"]
    assert center["local"] is False and center["accounts"][0]["username"] is None
    local = client.get(f"/api/v1/smart-auth/sessions/{s['id']}").json()["data"]["request"]
    assert local["accounts"][0]["username"] == "canary-sa-user@example.test" and local["allow_future_available"]
    r = _gsubmit(gateway, auth, s["id"], action="saved", entry_id=e["id"], allow_future=True,
                 pin="CANARY-PIN-review-7")
    assert r.status_code == 403 and r.json()["error"]["code"] == "stepup_required"
    assert r.json()["error"]["details"]["methods"][0] == "password"
    r = _gsubmit(gateway, auth, s["id"], action="credentials", values={"f0": C_USER, "f1": C_PW}, save="vault",
                 allow_future=True, pin="CANARY-PIN-review-7")
    assert r.status_code == 403 and r.json()["error"]["code"] == "stepup_required"
    for _ in range(6):  # empty PINs never count as failed attempts
        r = _gsubmit(gateway, auth, s["id"], action="credentials", values={"f0": C_USER, "f1": C_PW})
        assert r.json()["error"]["code"] == "pin_required"
    assert smart_auth.pin_status()["locked_until"] is None
    assert client.get(f"/api/v1/agents/{a['id']}/vault").json()["data"]["grants"] == []
    # the single-use token is NOT spent by the refused attempt: after a step-up the same token still works
    tok = gateway.post(f"/api/v1/smart-auth/sessions/{s['id']}/token", headers=auth).json()["data"]
    body = {"request_id": tok["request_id"], "token": tok["token"], "action": "saved", "entry_id": e["id"],
            "allow_future": True}
    assert gateway.post(f"/api/v1/smart-auth/sessions/{s['id']}/submit", json=body,
                        headers=auth).json()["error"]["code"] == "stepup_required"
    assert gateway.post("/api/v1/auth/stepup", json={"method": "password", "password": "correct horse battery"},
                        headers=auth).status_code == 200
    r = gateway.post(f"/api/v1/smart-auth/sessions/{s['id']}/submit", json=body, headers=auth)
    assert r.status_code == 202, r.text  # fresh: no PIN needed, the grant is the owner's verified decision
    _wait(client, t["id"], {"COMPLETED", "FAILED"})
    assert len(client.get(f"/api/v1/agents/{a['id']}/vault").json()["data"]["grants"]) == 1

def test_unconfirmed_result_goes_to_owner_and_is_never_saved(client, fake_guest, monkeypatch):
    """Finding 3: no positive evidence of a sign-in -> owner checks in Live Desktop; nothing saved to the vault."""
    h = _setup_admin(client)
    a = _agent(client, h)
    client.post("/api/v1/vault", json={"passphrase": "vault passphrase for tests 9"}, headers=h)
    b = _broker(fake_guest, monkeypatch, EMAIL_PW, hint={"step": "none", "origin": ORIGIN},
                after_fill={0: {"event": "result", "status": "unconfirmed", "final_url": ORIGIN + "/locked",
                                "cookies_imported": 1}})
    t = _task(client, h, a["id"], _flow(), monkeypatch)
    s = _session(client, t["id"])
    _submit(client, h, s, action="credentials", values={"f0": C_USER, "f1": C_PW}, save="vault")
    s = _wait_request(client, s["id"], "manual", seq_gt=s["request"]["seq"])
    assert s["request"]["manual"]["kind"] == "unconfirmed" and (a["id"], ORIGIN + "/locked") in b.navigated
    assert _submit(client, h, s, action="manual_done").status_code == 202  # the owner says it is fine
    _wait(client, t["id"], {"COMPLETED"})
    fin = client.get(f"/api/v1/smart-auth/sessions/{s['id']}").json()["data"]
    assert fin["state"] == "AUTHENTICATED" and fin["saved_to_vault"] is False
    assert client.get("/api/v1/vault/entries").json()["data"] == []


@pytest.mark.parametrize("kind", ["embedded_login", "new_password"])
def test_credential_bearing_manual_steps_are_not_handed_off(client, fake_guest, monkeypatch, kind):
    """Finding 5: the owner would have to type a secret into the agent's browser -> refused, not handed off."""
    h = _setup_admin(client)
    a = _agent(client, h)
    b = _broker(fake_guest, monkeypatch, [step(kind)])
    prov = _flow()
    t = _task(client, h, a["id"], prov, monkeypatch)
    _wait(client, t["id"], {"COMPLETED", "FAILED"})
    res = _results(prov)[0]
    assert res["status"] == "failed" and res["reason_code"] == f"unsupported_{kind}"
    assert "vault.auth_handoff" not in [m for m, _ in b.calls] and b.cookies_to == []


def test_no_expiry_while_an_answer_is_processed_and_codes_respect_review(client, fake_guest, monkeypatch):
    """Finding 6 (expiry mid-fill) and 15 (review gate for LOW-confidence code steps)."""
    from nebula_host import db, models
    from sqlalchemy import select

    h = _setup_admin(client)
    a = _agent(client, h)
    low_otp = step("otp", [F(0, "otp", length=6, charset="numeric")], confidence="LOW", flags=[],
                   otp={"channel": "sms", "length": 6, "charset": "numeric"})  # unusual form: YELLOW, reviewed
    b = _broker(fake_guest, monkeypatch, [*EMAIL_PW, low_otp])
    orig = b.call

    async def slow(method, params=None, timeout=60):
        if method == "vault.auth_step" and params["values"] == {"f0": "u@x.com", "f1": "pw"}:
            with db.engine().connect() as c:
                row = c.execute(select(models.auth_sessions).where(
                    models.auth_sessions.c.id == params["session_id"])).first()
            slow.during = (row.state, row.expires_at - row.created_at)
        return await orig(method, params, timeout)

    monkeypatch.setattr(fake_guest, "call", slow)
    t = _task(client, h, a["id"], _flow(), monkeypatch)
    s = _session(client, t["id"])
    _submit(client, h, s, action="credentials", values={"f0": "u@x.com", "f1": "pw"})
    s = _wait_request(client, s["id"], "otp", seq_gt=s["request"]["seq"])
    assert slow.during[0] == "SUBMITTING" and slow.during[1] >= 1800 - 1
    r = _submit(client, h, s, action="code", values={"f0": "123456"})
    assert r.status_code == 400 and r.json()["error"]["code"] == "review_required"
    client.post(f"/api/v1/smart-auth/sessions/{s['id']}/cancel", headers=h)
    _wait(client, t["id"], {"COMPLETED", "FAILED"})


def test_guest_cancel_suppresses_late_cookies_and_sweep_keeps_known_sessions(monkeypatch):
    """Finding 6 (guest) and 14."""
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "guest/guest-service"))
    from nebula_guest import vaultops

    from tests.unit.test_smart_auth_guest import FakeProc

    calls = []
    monkeypatch.setattr(vaultops, "call_tool", lambda *a: calls.append(a) or {"ok": True, "result": {"imported": 1}})

    async def stop(sid):
        stop.done.append(sid)

    stop.done = []
    monkeypatch.setattr(vaultops, "_stop_unit", stop)
    p1 = FakeProc([])
    s1 = vaultops._AuthProc("as_" + "1" * 24, "a1", "nebula_a1", p1, time.time() + 60)
    vaultops._AUTH.clear()
    vaultops._AUTH[s1.sid] = s1
    s1.cancelled = True  # cancel happened while the fill was running
    ev = asyncio.run(vaultops._finish(s1, {"event": "result", "status": "authenticated", "cookies": [
        {"name": "sid", "value": "x", "domain": "a.example", "path": "/"}]}))
    assert ev["status"] == "cancelled" and calls == []
    keep = vaultops._AuthProc("as_" + "2" * 24, "a2", "nebula_a2", FakeProc([]), time.time() + 60)
    gone = vaultops._AuthProc("as_" + "3" * 24, "a3", "nebula_a3", FakeProc([]), time.time() + 60)
    vaultops._AUTH.update({keep.sid: keep, gone.sid: gone})
    r = asyncio.run(vaultops.auth_cancel_all({"keep": [keep.sid]}))
    assert r == {"cancelled": 1} and keep.sid in vaultops._AUTH and gone.sid not in vaultops._AUTH
    assert gone.sid in stop.done  # the transient unit itself is stopped
    vaultops._AUTH.clear()


def test_telegram_labels_unverified_origin_and_destination(monkeypatch):
    """Finding 9."""
    from nebula_host import remote
    from nebula_telegram import v3 as tg3

    sent = []

    class Api:
        async def send_message(self, chat, text, thread=None, reply_markup=None, silent=False):
            sent.append(text)

    class Ctx:
        api = Api()

    monkeypatch.setattr(remote, "public_base", lambda: None)
    base = {"session_id": "as_" + "b" * 24, "site": "example.com", "origin": "https://example.com",
            "agent_name": "Dev", "expires_at": time.time() + 600}
    asyncio.run(tg3.send_sign_in(Ctx(), 7, None, {"task_id": "t" * 36, "payload": {
        **base, "request_id": "ar_x1", "request_type": "confirm_destination", "verified": False,
        "destination": IDP}}))
    asyncio.run(tg3.send_sign_in(Ctx(), 7, None, {"task_id": "t" * 36, "payload": {
        **base, "request_id": "ar_x2", "request_type": "credentials", "verified": True}}))
    assert "Requested site (not verified yet): https://example.com" in sent[0] and IDP in sent[0]
    assert "not approved yet" in sent[0] and "Verified site: https://example.com" in sent[1]


def test_egress_filter_covers_form_and_base64_encodings():
    """Finding 12 (defence in depth)."""
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "guest/guest-service"))
    import base64
    from urllib.parse import quote_plus

    src = (Path(__file__).resolve().parents[2] / "guest/guest-service/nebula_guest/vault_auth.py").read_text()
    assert "route_web_socket" in src and "b64encode" in src and 'quote_plus(v, safe="*")' in src
    from nebula_guest import vault_auth

    s = vault_auth.Session({"origin": "https://a.example", "allowed_origins": ["https://a.example"], "url": "x"})
    v = "p*ss~w rd" + C_PW
    raw = v.encode()
    s.egress = [v, quote_plus(v, safe="*"), base64.b64encode(raw).decode().rstrip("=")]
    assert s._leaks("https://evil.example/c?d=" + base64.b64encode(raw).decode().rstrip("="), None)
    assert s._leaks("https://evil.example/c", "x=" + quote_plus(v, safe="*"))


def test_unreachable_site_is_reported_as_such(client, fake_guest, monkeypatch):
    """A DNS / connection failure is 'site_unreachable', not a redirect (found in the live real-AI run)."""
    h = _setup_admin(client)
    a = _agent(client, h)
    _broker(fake_guest, monkeypatch, EMAIL_PW, start_event={"event": "result", "status": "unreachable"})
    prov = _flow()
    t = _task(client, h, a["id"], prov, monkeypatch)
    _wait(client, t["id"], {"COMPLETED", "FAILED"})
    res = _results(prov)[0]
    assert res["reason_code"] == "site_unreachable" and "could not be reached" in res["note"]


def test_form_target_allowed_but_form_lost_fails_clearly_and_drops_the_pending_values(client, fake_guest,
                                                                                         monkeypatch):
    """Owner allowed where a filled form posts, but the broker could not show that form again: the session fails as
    'form_not_restored' (not 'site_unreachable'), nothing is re-sent, and the values kept for the re-send are wiped."""
    from nebula_host import smart_auth

    h = _setup_admin(client)
    a = _agent(client, h)
    b = _broker(fake_guest, monkeypatch, EMAIL_PW, after_fill={0: {"event": "blocked", "origin": IDP}})
    inner = fake_guest.call

    async def call(method, params=None, timeout=60):
        if method == "vault.auth_allow":
            await inner(method, params, timeout)
            return {"event": "result", "status": "form_lost"}
        return await inner(method, params, timeout)

    monkeypatch.setattr(fake_guest, "call", call)
    prov = _flow()
    t = _task(client, h, a["id"], prov, monkeypatch)
    s = _session(client, t["id"])
    _submit(client, h, s, action="credentials", values={"f0": C_USER, "f1": C_PW})
    s = _wait_request(client, s["id"], "confirm_destination", seq_gt=s["request"]["seq"])
    assert _submit(client, h, s, action="allow_destination", review_confirmed=True).status_code == 202
    _wait(client, t["id"], {"COMPLETED", "FAILED"})
    row = client.get(f"/api/v1/smart-auth/sessions/{s['id']}").json()["data"]
    assert row["state"] == "FAILED" and row["error_code"] == "form_not_restored"
    res = _results(prov)[0]
    assert res["reason_code"] == "form_not_restored" and "request_sign_in once more" in res["note"]
    assert len(b.delivered) == 1  # the first fill only: no re-send
    assert all(not rt.pending for rt in smart_auth._RT.values())


def test_v34_telegram_notice_says_what_the_page_asks_and_never_the_approval_number(monkeypatch):
    from nebula_telegram import v3 as tg3

    sent = []

    class Api:
        async def send_message(self, chat_id, text, thread_id=None, reply_markup=None, silent=False):
            sent.append(text)

    class Ctx:
        api = Api()
        config = None

    monkeypatch.setattr(tg3, "public_url", lambda ctx: "https://example.test")
    for state, words in (("PASSWORD_REQUIRED", "enter your password"),
                         ("AUTHENTICATOR_APPROVAL", "approve the sign-in in your authenticator app"),
                         ("LOGIN_ERROR", "did not accept")):
        asyncio.run(tg3.send_sign_in(Ctx(), 7, None, {"task_id": "t" * 36, "payload": {
            "request_id": "r-" + state, "session_id": "as_" + "1" * 24, "state": state, "request_type": "credentials",
            "origin": "https://example.com", "verified": True, "site": "example.com", "approval_number": "917",
            "expires_at": 1795305600.0}}))
        assert words in sent[-1] and "917" not in sent[-1]  # (3 digits: never part of the HH:MM expiry time)


def test_v34_start_up_sweep_never_ends_another_host_instances_sign_in(monkeypatch):
    """Real failure during the V3.4 owner test (2026-11-22 01:06): a temporary test host on the same VM swept the
    broker sessions at its start-up and ended the live host's sign-in. The sweep is scoped to its host instance."""
    from nebula_guest import vaultops

    closed = []

    async def close(s):
        closed.append(s.sid)

    class P:
        returncode = None

    monkeypatch.setattr(vaultops, "_close", close)
    live = vaultops._AuthProc("as_" + "a" * 24, "agent-1", "u1", P(), 9e12)
    live.host_id = "1111111111111111"
    mine_old = vaultops._AuthProc("as_" + "b" * 24, "agent-2", "u2", P(), 9e12)
    mine_old.host_id = "2222222222222222"
    legacy = vaultops._AuthProc("as_" + "c" * 24, "agent-3", "u3", P(), 9e12)
    monkeypatch.setattr(vaultops, "_AUTH", {x.sid: x for x in (live, mine_old, legacy)})
    out = asyncio.run(vaultops.auth_cancel_all({"keep": [], "host_id": "2222222222222222"}))
    assert sorted(closed) == sorted([mine_old.sid, legacy.sid]) and out["cancelled"] == 2  # the live one survives
