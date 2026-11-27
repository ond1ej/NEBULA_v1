# ruff: noqa: F811 - fixtures are imported from other test modules and injected by pytest
"""Smart sign-in: universal step detection states, provider sign-ins started from the service, success only with
evidence, passkey / security key handling, stale readings, diagnostics without secrets, vault saving of the same
account, agent loop guard.

Most cases reproduce multi-step identity-provider sign-in flows (Microsoft 365 / Teams) with scripted page readings
from a fake guest.
The behaviour is described in docs/features/smart-sign-in.md and docs/security/SMART_AUTH_ARCHITECTURE.md."""

from __future__ import annotations

import asyncio
import json

import pytest
from sqlalchemy import and_

from tests.integration.test_api import _agent, _setup_admin, _wait, client  # noqa: F401
from tests.integration.test_smart_auth_flow import (  # noqa: F401
    CANARY_PW,
    CANARY_USER,
    PASS,
    F,
    ScriptedProvider,
    _flow,
    _results,
    _session,
    _submit,
    _task,
    _wait_request,
    _wait_state,
    call,
    done,
)
from tests.integration.test_v33_smart_auth2 import DONE, EMAIL, MS, PW, TEAMS, Script, _owner, ev

USERNAME = [F(0, "username")]
PHONE = [F(0, "phone")]


def _with_hint(fake, monkeypatch, hint: dict):
    """The agent's browser hint (advisory: the agent controls that browser)."""
    inner = fake.call

    async def call(method, params=None, timeout=60):
        if method == "tool.call" and (params or {}).get("tool") == "browser.auth_hint":
            return {"ok": True, "result": hint}
        return await inner(method, params, timeout)

    monkeypatch.setattr(fake, "call", call)


def _start_params(b: Script) -> dict:
    return next(p for m, p in b.calls if m == "vault.auth_start")


# ============================================================================ states from the real page
@pytest.mark.parametrize("fields,state", [(EMAIL, "EMAIL_REQUIRED"), (USERNAME, "USERNAME_REQUIRED"),
                                          (PHONE, "PHONE_REQUIRED"), ([F(0, "username_or_email")],
                                                                      "IDENTIFIER_REQUIRED")])
def test_identifier_state_names_what_the_page_asks(client, fake_guest, monkeypatch, fields, state):
    h, a = _owner(client)
    Script(fake_guest, monkeypatch, {"vault.auth_start": [ev("identifier", fields)]})
    t = _task(client, h, a["id"], _flow(url=MS + "/"), monkeypatch)
    s = _session(client, t["id"])
    assert s["state"] == state and s["request"]["requirement"] == state
    assert [f["role"] for f in s["request"]["fields"]] == [fields[0]["role"]]


def test_wrong_password_is_login_error_with_the_same_field(client, fake_guest, monkeypatch):
    h, a = _owner(client)
    Script(fake_guest, monkeypatch, {"vault.auth_start": [ev("password", PW)],
                                     "vault.auth_step": [ev("password", PW, error="rejected"), DONE]})
    t = _task(client, h, a["id"], _flow(url=MS + "/"), monkeypatch)
    s = _session(client, t["id"])
    assert s["state"] == "PASSWORD_REQUIRED"
    assert _submit(client, h, s, action="credentials", values={"f0": "wrong-pw-1"}).status_code == 202
    s2 = _wait_request(client, s["id"], "credentials", seq_gt=s["request"]["seq"])
    assert s2["state"] == "LOGIN_ERROR" and s2["request"]["error"] == "credentials_rejected"
    assert s2["request"]["requirement"] == "PASSWORD_REQUIRED" and [f["role"] for f in s2["request"]["fields"]] == \
        ["password"]
    assert _submit(client, h, s2, action="credentials", values={"f0": CANARY_PW}).status_code == 202
    _wait(client, t["id"], {"COMPLETED"})


def test_unknown_sign_in_page_is_never_success_and_offers_live_desktop(client, fake_guest, monkeypatch):
    h, a = _owner(client)
    Script(fake_guest, monkeypatch, {"vault.auth_start": [ev("password", PW)],
                                     "vault.auth_step": [ev("unknown")]})
    t = _task(client, h, a["id"], _flow(url=MS + "/"), monkeypatch)
    s = _session(client, t["id"])
    _submit(client, h, s, action="credentials", values={"f0": CANARY_PW})
    s2 = _wait_request(client, s["id"], "manual", seq_gt=s["request"]["seq"])
    assert s2["state"] == "UNKNOWN_STEP" and s2["request"]["manual"]["kind"] == "unknown"
    assert s2["request"]["manual"]["live_desktop"] is True
    detail = client.get(f"/api/v1/smart-auth/sessions/{s['id']}").json()["data"]
    assert any(e["type"] == "detection.unknown" for e in detail["events"])


def test_success_without_evidence_is_checked_by_the_owner_not_reported(client, fake_guest, monkeypatch):
    """Regression (false success): a 'signed in' result without positive evidence never resumes the agent as signed in."""
    h, a = _owner(client)
    weak = {k: v for k, v in DONE.items() if k != "evidence"}
    Script(fake_guest, monkeypatch, {"vault.auth_start": [ev("identifier", EMAIL)], "vault.auth_step": [weak]})
    t = _task(client, h, a["id"], _flow(url=MS + "/"), monkeypatch)
    s = _session(client, t["id"])
    _submit(client, h, s, action="credentials", values={"f0": CANARY_USER})
    s2 = _wait_request(client, s["id"], "manual", seq_gt=s["request"]["seq"])
    assert s2["state"] == "WAITING_FOR_USER" and s2["request"]["manual"]["kind"] == "unconfirmed"
    detail = client.get(f"/api/v1/smart-auth/sessions/{s['id']}").json()["data"]
    assert any(e["type"] == "success.unproven" for e in detail["events"])
    assert not any(e["type"] == "session.authenticated" for e in detail["events"])


# ============================================================================ Microsoft / Teams
def test_mid_flow_provider_url_starts_again_from_the_service(client, fake_guest, monkeypatch):
    """Regression (Microsoft 365 sign-in, V3.4): the agent's browser was on login.microsoftonline.com/common/resume?ctx=…
    asking for the password and the agent passed that URL; the isolated browser opened it fresh and asked for the
    e-mail. Now the sign-in starts from the service the agent was using (verified relationship only)."""
    h, a = _owner(client)
    b = Script(fake_guest, monkeypatch, {"vault.auth_start": [{"event": "redirect", "origin": MS, "url": None}],
                                         "vault.auth_allow": [ev("identifier", EMAIL)]})
    _with_hint(fake_guest, monkeypatch, {"url": MS + "/common/resume", "service_url": TEAMS + "/v2/",
                                         "hint": {"step": "password", "origin": MS}})
    t = _task(client, h, a["id"], _flow(url=MS + "/common/resume?ctx=rQQIAB"), monkeypatch)
    s = _session(client, t["id"])
    p = _start_params(b)
    assert p["origin"] == TEAMS and p["url"] == TEAMS + "/v2/"
    # Microsoft's own sign-in hosts are allowed from the start (no block + GET replay of its passkey bridge)
    assert p["allowed_origins"] == [TEAMS, MS, "https://login.microsoft.com", "https://login.live.com"]
    assert "ctx=" not in p["url"]
    assert s["requested_origin"] == TEAMS and "restarted_from_service" in s["request"]["notes"]


def test_mid_flow_provider_url_never_switches_to_an_unrelated_site(client, fake_guest, monkeypatch):
    h, a = _owner(client)
    b = Script(fake_guest, monkeypatch, {"vault.auth_start": [ev("identifier", EMAIL)]})
    _with_hint(fake_guest, monkeypatch, {"url": MS + "/common/resume", "service_url": "https://evil.example/x",
                                         "hint": None})
    t = _task(client, h, a["id"], _flow(url=MS + "/common/resume?ctx=rQQIAB"), monkeypatch)
    s = _session(client, t["id"])
    p = _start_params(b)
    assert p["origin"] == MS and p["url"] == MS + "/"  # the provider's own start page, not the stale step
    assert "restarted_at_provider" in s["request"]["notes"]


def test_teams_new_address_is_verified_not_a_yellow_destination(client, fake_guest, monkeypatch):
    """Regression (Microsoft 365 sign-in, V3.4): teams.microsoft.com -> teams.cloud.microsoft was 'unverified_destination'."""
    from nebula_host import auth_trust

    t = auth_trust.classify_origin(TEAMS, "https://teams.cloud.microsoft", allow_local=False)
    assert t["level"] == "GREEN" and t["relationship"]["name"] == "Microsoft"
    assert auth_trust.classify_origin(TEAMS, "https://teams.cloud.microsoft.evil.io",
                                      allow_local=False)["level"] != "GREEN"


def test_passkey_with_other_ways_offers_them_and_says_what_nebula_did(client, fake_guest, monkeypatch):
    h, a = _owner(client)
    key = ev("security_key", alts=("more",))
    key["step"]["webauthn"] = {"kind": "security_key", "pending": False}
    key["auto"] = ["security_key_cancelled"]
    Script(fake_guest, monkeypatch, {"vault.auth_start": [ev("identifier", EMAIL)], "vault.auth_step": [key]})
    t = _task(client, h, a["id"], _flow(url=MS + "/"), monkeypatch)
    s = _session(client, t["id"])
    _submit(client, h, s, action="credentials", values={"f0": CANARY_USER})
    s2 = _wait_request(client, s["id"], "manual", seq_gt=s["request"]["seq"])
    assert s2["state"] == "SECURITY_KEY_REQUIRED" and s2["request"]["manual"]["can_complete_here"] is False
    assert s2["request"]["alternatives"] == ["more"] and "security_key_cancelled" in s2["request"]["notes"]


def test_authenticator_number_is_shown_to_the_owner(client, fake_guest, monkeypatch):
    h, a = _owner(client)
    appr = ev("device_approval")
    appr["step"]["approval_number"] = "42"
    Script(fake_guest, monkeypatch, {"vault.auth_start": [ev("password", PW)], "vault.auth_step": [appr],
                                     "vault.auth_poll": [DONE]})
    t = _task(client, h, a["id"], _flow(url=MS + "/"), monkeypatch)
    s = _session(client, t["id"])
    _submit(client, h, s, action="credentials", values={"f0": CANARY_PW})
    s2 = _wait_request(client, s["id"], "device_approval", seq_gt=s["request"]["seq"])
    assert s2["state"] in ("AUTHENTICATOR_APPROVAL", "AUTHENTICATED")
    if s2["state"] == "AUTHENTICATOR_APPROVAL":
        assert s2["request"]["approval_number"] == "42"
    _wait(client, t["id"], {"COMPLETED"})


def test_crashed_broker_page_is_reported_clearly(client, fake_guest, monkeypatch):
    h, a = _owner(client)
    Script(fake_guest, monkeypatch, {"vault.auth_start": [ev("password", PW)],
                                     "vault.auth_step": [{"event": "result", "status": "page_crashed"}]})
    prov = _flow(url=MS + "/")
    t = _task(client, h, a["id"], prov, monkeypatch)
    s = _session(client, t["id"])
    _submit(client, h, s, action="credentials", values={"f0": CANARY_PW})
    fin = _wait_state(client, s["id"], {"FAILED"})
    assert fin["error_code"] == "broker_memory"
    _wait(client, t["id"], {"COMPLETED", "FAILED"})
    res = _results(prov)[0]
    assert res["reason_code"] == "broker_memory" and "memory" in res["note"]


# ============================================================================ stale readings, loops
def test_an_older_page_reading_never_overrides_a_newer_one(client, fake_guest, monkeypatch):
    from nebula_host import smart_auth as sa

    h, a = _owner(client)
    Script(fake_guest, monkeypatch, {"vault.auth_start": [ev("identifier", EMAIL)],
                                     "vault.auth_step": [ev("password", PW)]})
    t = _task(client, h, a["id"], _flow(url=MS + "/"), monkeypatch)
    s = _session(client, t["id"])
    _submit(client, h, s, action="credentials", values={"f0": CANARY_USER})
    s2 = _wait_request(client, s["id"], "credentials", seq_gt=s["request"]["seq"])
    assert s2["state"] == "PASSWORD_REQUIRED"
    rt = sa._RT[s["id"]]
    assert rt.step_id == 2
    old = ev("identifier", EMAIL)
    old["step_id"] = 1  # e.g. the watcher's reading taken before the password step appeared
    asyncio.run(sa._apply(s["id"], rt, old, from_watcher=True))
    s3 = client.get(f"/api/v1/smart-auth/sessions/{s['id']}").json()["data"]
    assert s3["state"] == "PASSWORD_REQUIRED" and s3["request"]["seq"] == s2["request"]["seq"]
    assert any(e["type"] == "step.stale_ignored" for e in s3["events"])
    client.post(f"/api/v1/smart-auth/sessions/{s['id']}/cancel", headers=h)


def test_agent_stops_after_two_failed_sign_ins_for_the_same_site(client, fake_guest, monkeypatch):
    h, a = _owner(client)
    Script(fake_guest, monkeypatch, {"vault.auth_start": [{"event": "result", "status": "no_login_form"},
                                                          {"event": "result", "status": "no_login_form"}]})
    prov = ScriptedProvider([[call("request_sign_in", {"url": MS + "/"}, "c1"), done()],
                             [call("request_sign_in", {"url": MS + "/"}, "c2"), done()],
                             [call("request_sign_in", {"url": MS + "/"}, "c3"), done()],
                             [call("task_complete", {"summary": "could not sign in", "success": False}), done()]])
    t = _task(client, h, a["id"], prov, monkeypatch)
    _wait(client, t["id"], {"COMPLETED", "FAILED"})
    res = _results(prov)
    assert [r["status"] for r in res] == ["failed", "failed", "denied"]
    assert res[2]["reason_code"] == "repeated_failure"


def test_vm_not_running_is_explained(client, fake_guest, monkeypatch):
    from nebula_host import vault_broker as vb

    h, a = _owner(client)
    vb._cap.update(at=0.0, value=None)

    async def down(method, params=None, timeout=60):
        if method == "guest.capabilities":
            raise ConnectionError("vm down")
        if method == "tool.call" and (params or {}).get("tool") == "browser.auth_hint":
            return {"ok": True, "result": {"url": "about:blank", "hint": None}}
        return await orig(method, params, timeout)

    orig = fake_guest.call
    monkeypatch.setattr(fake_guest, "call", down)
    prov = _flow(url=MS + "/")
    t = _task(client, h, a["id"], prov, monkeypatch)
    _wait(client, t["id"], {"COMPLETED", "FAILED"})
    res = _results(prov)[0]
    assert res["status"] == "denied" and res["reason_code"] == "vm_not_running" and "start the VM" in res["reason"]


# ============================================================================ diagnostics, vault
def test_diagnostics_are_structural_and_never_contain_secrets(client, fake_guest, monkeypatch):
    from nebula_host import db, models
    from sqlalchemy import select

    h, a = _owner(client)
    pw = ev("password", PW)
    pw["diag"] = {"step": "password", "roles": ["password"], "inputs_visible": 1, "quiet_ms": 512, "observed": True,
                  "evil_text": CANARY_PW, "url": f"https://x.example/?p={CANARY_PW}",
                  "flags": [CANARY_PW, "plain_ok", "password_like_code"], "ready": "complete"}
    Script(fake_guest, monkeypatch, {"vault.auth_start": [pw], "vault.auth_step": [DONE]})
    t = _task(client, h, a["id"], _flow(url=MS + "/"), monkeypatch)
    s = _session(client, t["id"])
    _submit(client, h, s, action="credentials", values={"f0": CANARY_PW})
    _wait(client, t["id"], {"COMPLETED"})
    with db.engine().connect() as c:
        rows = c.execute(select(models.auth_events.c.event_type, models.auth_events.c.sanitized_metadata).where(
            models.auth_events.c.auth_session_id == s["id"])).all()
    blob = json.dumps([[r.event_type, r.sanitized_metadata] for r in rows])
    assert CANARY_PW not in blob and "x.example" not in blob
    diag = next(r.sanitized_metadata["diag"] for r in rows if r.event_type == "step.detected")
    assert diag["quiet_ms"] == 512 and diag["roles"] == ["password"] and diag["flags"] == []
    assert "evil_text" not in diag and "url" not in diag
    assert any(r.event_type == "success.confirmed" and r.sanitized_metadata.get("evidence") ==
               "provider_session_cookie" for r in rows)


def test_saving_the_same_account_again_updates_it_and_other_accounts_stay_separate(client, fake_guest, monkeypatch):
    from nebula_host import vault as vaultmod

    h, a = _owner(client)
    assert client.post("/api/v1/vault", json={"passphrase": PASS}, headers=h).status_code == 201

    def sign_in(user: str, pw: str) -> None:
        Script(fake_guest, monkeypatch, {"vault.auth_start": [ev("identifier_password", [F(0, "email"),
                                                                                          F(1, "password")])],
                                         "vault.auth_step": [DONE]})
        t = _task(client, h, a["id"], _flow(url=MS + "/"), monkeypatch)
        s = _session(client, t["id"])
        r = _submit(client, h, s, action="credentials", values={"f0": user, "f1": pw}, save="vault")
        assert r.status_code == 202, r.text
        _wait(client, t["id"], {"COMPLETED"})

    sign_in("first@example.test", "pw-first-1")
    sign_in("first@example.test", "pw-first-2")  # same account, new password: updated
    sign_in("second@example.test", "pw-second-1")  # another account on the same service: separate
    entries = [e for e in vaultmod.VAULT.list_entries() if e["origin"] == MS]
    assert len(entries) == 2
    assert all("login-email" in e["tags"] for e in entries)
    first = vaultmod.VAULT.match_entry(MS, "first@example.test")
    assert first and vaultmod.VAULT.match_entry(MS, "nobody@example.test") is None
    assert vaultmod.VAULT._decrypt(vaultmod.VAULT._require_unlocked(),
                                   vaultmod.VAULT._entry_row(first))["password"] == "pw-first-2"


def test_unknown_step_retry_restarts_from_the_sign_in_page(client, fake_guest, monkeypatch):
    h, a = _owner(client)
    b = Script(fake_guest, monkeypatch, {"vault.auth_start": [ev("password", PW)], "vault.auth_step": [ev("unknown")],
                                         "vault.auth_reload": [ev("password", PW)]})
    t = _task(client, h, a["id"], _flow(url=MS + "/"), monkeypatch)
    s = _session(client, t["id"])
    _submit(client, h, s, action="credentials", values={"f0": CANARY_PW})
    s2 = _wait_request(client, s["id"], "manual", seq_gt=s["request"]["seq"])
    assert s2["state"] == "UNKNOWN_STEP"
    assert _submit(client, h, s2, action="retry").status_code == 202
    s3 = _wait_request(client, s["id"], "credentials", seq_gt=s2["request"]["seq"])
    assert s3["state"] == "PASSWORD_REQUIRED" and "vault.auth_reload" in b.methods()
    client.post(f"/api/v1/smart-auth/sessions/{s['id']}/cancel", headers=h)



def test_telegram_mini_app_answer_uses_the_same_backend_with_a_fresh_step_up(client, fake_guest, monkeypatch):
    """Scenario 'Telegram response': the owner answers from the Mini App through the real gateway code. Without a
    PIN or a fresh step-up the answer is refused; after the step-up it is accepted and the sign-in completes."""
    import uuid
    from pathlib import Path

    import httpx
    from fastapi.testclient import TestClient
    from nebula_host import remote

    from tests.integration.test_v3_api import _Bridge, _pair_owner
    from tests.unit.test_v3_units import BOT_TOKEN, make_init_data

    h, a = _owner(client)
    _pair_owner(7)
    gw = remote.build_gateway(3199, Path("/nonexistent"), forward_client=httpx.AsyncClient(
        transport=_Bridge(client), base_url="http://127.0.0.1:3199"), listen_port=3102)
    with TestClient(gw, base_url="http://127.0.0.1:3102") as g:
        r = g.post("/api/mini/auth", json={"init_data": make_init_data(BOT_TOKEN, user_id=7,
                                                                       extra={"query_id": uuid.uuid4().hex})})
        assert r.status_code == 200, r.text
        auth = {"authorization": f"Bearer {r.json()['data']['token']}"}
        Script(fake_guest, monkeypatch, {"vault.auth_start": [ev("identifier_password", [F(0, "username"),
                                                                                          F(1, "password")])],
                                         "vault.auth_step": [DONE]})
        t = _task(client, h, a["id"], _flow(url=MS + "/"), monkeypatch)
        s = _session(client, t["id"])
        seen = g.get(f"/api/v1/smart-auth/sessions/{s['id']}", headers=auth)
        assert seen.status_code == 200, seen.text
        seen = seen.json()["data"]
        assert seen["state"] == "IDENTIFIER_AND_PASSWORD_REQUIRED" and seen["request"] is not None
        no_fresh = _submit(g, auth, seen, action="credentials", values={"f0": CANARY_USER, "f1": CANARY_PW})
        assert no_fresh.status_code in (401, 403), no_fresh.text
        su = g.post("/api/v1/auth/stepup", json={"method": "password", "password": "correct horse battery"},
                    headers=auth)
        assert su.status_code == 200, su.text
        seen = g.get(f"/api/v1/smart-auth/sessions/{s['id']}", headers=auth).json()["data"]
        ok = _submit(g, auth, seen, action="credentials", values={"f0": CANARY_USER, "f1": CANARY_PW})
        assert ok.status_code == 202, ok.text
        _wait(client, t["id"], {"COMPLETED"})


# ============================================================================ security review regressions
def test_review_empty_username_never_overwrites_another_credential(client):
    from nebula_host import vault as vaultmod

    h, _ = _owner(client)
    assert client.post("/api/v1/vault", json={"passphrase": PASS}, headers=h).status_code == 201
    vaultmod.VAULT.add_entry({"credential_type": "website", "display_name": "x", "origin": MS, "username": "",
                              "password": "first-pw"}, actor="owner")
    assert vaultmod.VAULT.match_entry(MS, "") is None  # nothing identifies the account: a new entry is added


def test_review_approval_number_only_on_a_provider_or_verified_page(client, fake_guest, monkeypatch):
    from nebula_host import db, models
    from sqlalchemy import select

    h, a = _owner(client)
    site = "https://relay.example.org"
    appr = ev("device_approval", origin=site)
    appr["step"]["approval_number"] = "42"
    done_ = {**DONE, "final_url": site + "/home", "evidence": "signout_control"}
    Script(fake_guest, monkeypatch, {"vault.auth_start": [ev("password", PW, origin=site)],
                                     "vault.auth_step": [appr], "vault.auth_poll": [done_]})
    t = _task(client, h, a["id"], _flow(url=site + "/"), monkeypatch)
    s = _session(client, t["id"])
    _submit(client, h, s, action="credentials", values={"f0": CANARY_PW})
    _wait(client, t["id"], {"COMPLETED"})
    with db.engine().connect() as c:
        sch = [r.field_schema for r in c.execute(select(models.auth_requests.c.field_schema).where(and_(
            models.auth_requests.c.auth_session_id == s["id"],
            models.auth_requests.c.request_type == "device_approval")))]
    assert sch and sch[0].get("approval_number") is None and "approval_number_hidden" in sch[0].get("notes")


def test_review_loop_guard_counts_one_provider_across_its_addresses(client, fake_guest, monkeypatch):
    h, a = _owner(client)
    Script(fake_guest, monkeypatch, {"vault.auth_start": [{"event": "result", "status": "no_login_form"},
                                                          {"event": "result", "status": "no_login_form"}]})
    prov = ScriptedProvider([[call("request_sign_in", {"url": TEAMS + "/"}, "c1"), done()],
                             [call("request_sign_in", {"url": "https://outlook.office.com/"}, "c2"), done()],
                             [call("request_sign_in", {"url": "https://teams.cloud.microsoft/"}, "c3"), done()],
                             [call("task_complete", {"summary": "x", "success": False}), done()]])
    t = _task(client, h, a["id"], prov, monkeypatch)
    _wait(client, t["id"], {"COMPLETED", "FAILED"})
    res = _results(prov)
    assert [r["status"] for r in res] == ["failed", "failed", "denied"] and res[2]["reason_code"] == "repeated_failure"


def test_review_secret_fields_are_cleared_in_the_agents_browser_after_a_sign_in(client, fake_guest, monkeypatch):
    h, a = _owner(client)
    b = Script(fake_guest, monkeypatch, {"vault.auth_start": [ev("password", PW)], "vault.auth_step": [DONE]})
    tools = []
    inner = fake_guest.call

    async def spy(method, params=None, timeout=60):
        if method == "tool.call":
            tools.append((params or {}).get("tool"))
            if (params or {}).get("tool") == "browser.clear_secrets":
                return {"ok": True, "result": {"cleared": 1}}
        return await inner(method, params, timeout)

    monkeypatch.setattr(fake_guest, "call", spy)
    t = _task(client, h, a["id"], _flow(url=MS + "/"), monkeypatch)
    s = _session(client, t["id"])
    _submit(client, h, s, action="credentials", values={"f0": CANARY_PW})
    _wait(client, t["id"], {"COMPLETED"})
    assert "browser.clear_secrets" in tools and b



def test_teams_passkey_bridge_on_login_microsoft_com_needs_no_stop(client, fake_guest, monkeypatch):
    """Owner's real Teams test 2026-11-22: after the e-mail Microsoft moved to login.microsoft.com (passkey
    bridge); that origin was not allowed yet, the broker blocked it and replayed the address, and Microsoft started
    again at the e-mail. The provider's sign-in hosts are now allowed from the start: the next step there is used
    directly (no destination stop, the e-mail is asked once)."""
    h, a = _owner(client)
    pw_on_bridge = ev("password", PW, origin="https://login.microsoft.com")
    pw_on_bridge["auto"] = ["passkey_cancelled", "chose_password"]
    b = Script(fake_guest, monkeypatch, {"vault.auth_start": [{"event": "redirect", "origin": MS, "url": None}],
                                         "vault.auth_allow": [ev("identifier", EMAIL)],
                                         "vault.auth_step": [pw_on_bridge, DONE]})
    t = _task(client, h, a["id"], _flow(url=TEAMS + "/"), monkeypatch)
    s = _session(client, t["id"])
    assert s["state"] == "EMAIL_REQUIRED"
    _submit(client, h, s, action="credentials", values={"f0": CANARY_USER})
    s2 = _wait_request(client, s["id"], "credentials", seq_gt=s["request"]["seq"])
    assert s2["state"] == "PASSWORD_REQUIRED" and s2["verified_origin"] == "https://login.microsoft.com"
    assert {"passkey_cancelled", "chose_password"} <= set(s2["request"]["notes"])
    assert [m for m in b.methods() if m == "vault.auth_allow"] == ["vault.auth_allow"]  # only the first hop
    _submit(client, h, s2, action="credentials", values={"f0": CANARY_PW})
    _wait(client, t["id"], {"COMPLETED"})
