# ruff: noqa: F811 - fixtures are imported from other test modules and injected by pytest
"""V3.3 owner administration from the Telegram Mini App through the real gateway: same backend and data as the
dashboard, one central authorization model, fresh re-verification (password / biometric device) for sensitive
operations, vault management from the phone (create/unlock/add/edit/delete/reveal/export/import/grants), agent-bot
isolation, session expiry/revocation and replay protection."""

from __future__ import annotations

import time
import uuid

import pytest

from tests.integration.test_api import _agent, _setup_admin, client  # noqa: F401
from tests.integration.test_v3_api import _pair_owner, gateway  # noqa: F401
from tests.unit.test_v3_units import BOT_TOKEN, make_init_data

PASS = "phone vault passphrase 42"
LOGIN = "correct horse battery"
CANARY = "CANARY-MOBILE-PW-91ab"


@pytest.fixture(autouse=True)
def _fast_kdf(monkeypatch):
    import os

    from nebula_host import vault as v

    monkeypatch.setattr(v, "calibrate_kdf", lambda *a, **k: {"alg": "argon2id", "salt": v.b64e(os.urandom(16)),
                                                              "time_cost": 2, "memory_kib": 8192, "parallelism": 1})
    v.VAULT._keys = None
    v.VAULT._reauth_sessions.clear()
    yield
    v.VAULT._keys = None


def _mini(gateway, user_id=7):
    r = gateway.post("/api/mini/auth", json={"init_data": make_init_data(
        BOT_TOKEN, user_id=user_id, extra={"query_id": uuid.uuid4().hex})})  # each opening is a new initData
    assert r.status_code == 200, r.text
    return {"authorization": f"Bearer {r.json()['data']['token']}"}


def _stepup(gateway, auth):
    r = gateway.post("/api/v1/auth/stepup", json={"method": "password", "password": LOGIN}, headers=auth)
    assert r.status_code == 200, r.text
    return r.json()["data"]


def test_owner_role_and_assurance_are_reported(client, gateway):
    _setup_admin(client)
    _pair_owner(7)
    auth = _mini(gateway)
    me = gateway.get("/api/v1/miniapp/me", headers=auth).json()["data"]
    assert me["role"] == "owner" and me["admin"] is True and me["assurance"]["fresh"] is False
    a = gateway.get("/api/v1/auth/assurance", headers=auth).json()["data"]
    assert a["interface"] == "miniapp" and a["methods"]["password"] and not a["methods"]["biometric"]["enrolled"]
    _stepup(gateway, auth)
    assert gateway.get("/api/v1/miniapp/me", headers=auth).json()["data"]["assurance"]["fresh"] is True


def test_full_vault_management_from_the_phone(client, gateway):
    """Create -> lock -> unlock -> add (with a generated password) -> search -> detail -> edit -> reveal (passphrase
    re-confirmed on THIS session) -> grant to an agent -> revoke -> export -> import -> delete -> history."""
    h = _setup_admin(client)
    a = _agent(client, h)
    _pair_owner(7)
    auth = _mini(gateway)
    assert gateway.post("/api/v1/vault", json={"passphrase": PASS}, headers=auth).json()["error"]["code"] == \
        "stepup_required"
    _stepup(gateway, auth)
    assert gateway.post("/api/v1/vault", json={"passphrase": PASS}, headers=auth).status_code == 201
    assert gateway.post("/api/v1/vault/lock", headers=auth).json()["data"]["locked"] is True
    r = gateway.post("/api/v1/vault/unlock", json={"passphrase": "wrong passphrase 000"}, headers=auth)
    assert r.status_code == 401 and "attempts_left" in r.json()["error"]["details"]
    assert gateway.post("/api/v1/vault/unlock", json={"passphrase": PASS}, headers=auth).status_code == 200
    e = gateway.post("/api/v1/vault/entries", json={"display_name": "Work mail", "origin": "https://mail.example.com",
                                                     "username": "me@example.com", "password": CANARY,
                                                     "notes": "n", "tags": ["work"]}, headers=auth)
    assert e.status_code == 201 and CANARY not in e.text
    eid = e.json()["data"]["id"]
    found = gateway.get("/api/v1/vault/entries?q=work", headers=auth).json()["data"]
    assert [x["id"] for x in found] == [eid] and CANARY not in str(found)
    d = gateway.get(f"/api/v1/vault/entries/{eid}", headers=auth).json()["data"]
    assert d["username"] == "me@example.com" and d["has_password"] and "password" not in d
    assert gateway.patch(f"/api/v1/vault/entries/{eid}", json={"display_name": "Work mail 2"},
                         headers=auth).status_code == 200
    rv = gateway.post(f"/api/v1/vault/entries/{eid}/reveal", json={"field": "password"}, headers=auth)
    assert rv.status_code == 200 and rv.json()["data"]["value"] == CANARY  # unlocked on THIS session just now
    assert rv.headers["cache-control"].startswith("no-store")
    assert gateway.put(f"/api/v1/agents/{a['id']}/vault", json={"mode": "SELECTED"}, headers=auth).status_code == 200
    g = gateway.post(f"/api/v1/agents/{a['id']}/vault/grants", json={"entry_id": eid}, headers=auth)
    assert g.status_code == 201
    assert gateway.post(f"/api/v1/vault/grants/{g.json()['data']['id']}/revoke", headers=auth).status_code == 200
    ex = gateway.post("/api/v1/vault/export", json={"export_passphrase": "export passphrase 77"}, headers=auth)
    assert ex.status_code == 200 and CANARY not in ex.text
    imp = gateway.post("/api/v1/vault/import", json={"export_passphrase": "export passphrase 77",
                                                      "export": ex.json()["data"], "confirm": True}, headers=auth)
    assert imp.status_code == 200, imp.text
    assert gateway.delete(f"/api/v1/vault/entries/{eid}?confirm=true", headers=auth).status_code == 200
    hist = gateway.get("/api/v1/vault/audit?limit=50", headers=auth).json()["data"]
    ops = {x.get("operation") for x in hist}
    assert {"create", "unlock", "reveal.password", "export"} <= ops
    assert all((x.get("actor_id") or "").startswith("miniapp:") for x in hist if x["operation"] == "reveal.password")
    # the same data the dashboard sees (one vault, no Telegram copy)
    assert {x["id"] for x in client.get("/api/v1/vault/entries").json()["data"]} == \
        {x["id"] for x in gateway.get("/api/v1/vault/entries", headers=auth).json()["data"]}


def test_mac_confirmation_never_unlocks_reveal_on_the_phone(client, gateway):
    h = _setup_admin(client)
    _pair_owner(7)
    assert client.post("/api/v1/vault", json={"passphrase": PASS}, headers=h).status_code == 201
    e = client.post("/api/v1/vault/entries", json={"display_name": "x", "origin": "https://x.example.com",
                                                    "password": CANARY}, headers=h).json()["data"]
    assert client.post(f"/api/v1/vault/entries/{e['id']}/reveal", json={"field": "password"},
                       headers=h).status_code == 200  # the Mac's own session
    auth = _mini(gateway)
    _stepup(gateway, auth)
    r = gateway.post(f"/api/v1/vault/entries/{e['id']}/reveal", json={"field": "password"}, headers=auth)
    assert r.status_code == 403 and r.json()["error"]["code"] == "reauth_required" and CANARY not in r.text


def test_biometric_device_step_up_is_single_use_and_rotates(client, gateway):
    _setup_admin(client)
    _pair_owner(7)
    auth = _mini(gateway)
    r = gateway.post("/api/v1/auth/devices", json={"name": "iPhone"}, headers=auth)
    assert r.status_code == 403 and r.json()["error"]["code"] == "stepup_required"
    _stepup(gateway, auth)
    dev = gateway.post("/api/v1/auth/devices", json={"name": "iPhone"}, headers=auth).json()["data"]
    from nebula_host import db, models
    from sqlalchemy import select

    with db.engine().connect() as c:
        stored = c.execute(select(models.miniapp_devices.c.token_hash)).scalar()
    assert dev["token"] not in stored and len(stored) == 64  # only the hash is kept
    auth2 = _mini(gateway)  # a new, not yet verified session (e.g. the app reopened)
    assert gateway.get("/api/v1/miniapp/me", headers=auth2).json()["data"]["assurance"]["fresh"] is False
    stale = gateway.post("/api/v1/vault", json={"passphrase": PASS}, headers=auth2).json()["error"]
    assert stale["code"] == "stepup_required" and stale["details"]["methods"] == ["password", "biometric"]
    ch = gateway.post("/api/v1/auth/stepup/challenge", json={"device_id": dev["device_id"]}, headers=auth2).json()["data"]
    ok = gateway.post("/api/v1/auth/stepup", json={"method": "biometric", "device_id": dev["device_id"],
                                                    "challenge_id": ch["challenge_id"], "token": dev["token"]},
                      headers=auth2)
    assert ok.status_code == 200 and ok.json()["data"]["next_token"] != dev["token"]
    # replay: the same challenge or the old token never works again
    again = gateway.post("/api/v1/auth/stepup", json={"method": "biometric", "device_id": dev["device_id"],
                                                       "challenge_id": ch["challenge_id"], "token": dev["token"]},
                         headers=auth2)
    assert again.status_code == 401 and again.json()["error"]["code"] == "challenge_expired"
    ch2 = gateway.post("/api/v1/auth/stepup/challenge", json={"device_id": dev["device_id"]}, headers=auth2).json()["data"]
    old = gateway.post("/api/v1/auth/stepup", json={"method": "biometric", "device_id": dev["device_id"],
                                                     "challenge_id": ch2["challenge_id"], "token": dev["token"]},
                       headers=auth2)
    assert old.status_code == 401 and old.json()["error"]["code"] == "bad_token"
    # a challenge belongs to the session that asked for it
    ch3 = gateway.post("/api/v1/auth/stepup/challenge", json={"device_id": dev["device_id"]}, headers=auth).json()["data"]
    other = gateway.post("/api/v1/auth/stepup", json={"method": "biometric", "device_id": dev["device_id"],
                                                       "challenge_id": ch3["challenge_id"],
                                                       "token": ok.json()["data"]["next_token"]}, headers=auth2)
    assert other.status_code == 401
    assert gateway.delete(f"/api/v1/auth/devices/{dev['device_id']}", headers=auth).status_code == 200
    assert gateway.get("/api/v1/auth/devices", headers=auth).json()["data"] == []


def test_step_up_is_rate_limited(client, gateway):
    _setup_admin(client)
    _pair_owner(7)
    auth = _mini(gateway)
    codes = [gateway.post("/api/v1/auth/stepup", json={"method": "password", "password": "nope"},
                          headers=auth).status_code for _ in range(6)]
    assert codes[:5] == [401] * 5 and codes[5] == 429
    r = gateway.post("/api/v1/auth/stepup", json={"method": "password", "password": LOGIN}, headers=auth)
    assert r.status_code == 429  # even the right password waits once the limit is reached


def test_full_administration_parity_for_the_owner(client, gateway):
    """Same routes as the dashboard: agents, providers, settings, telegram, remote, system, skills, schedules."""
    h = _setup_admin(client)
    a = _agent(client, h)
    _pair_owner(7)
    auth = _mini(gateway)
    for path in ("/api/v1/providers", "/api/v1/settings", "/api/v1/telegram", "/api/v1/remote", "/api/v1/system",
                 "/api/v1/skills", "/api/v1/schedules", "/api/v1/teams", "/api/v1/workflows", "/api/v1/bots",
                 "/api/v1/miniapp/sessions", "/api/v1/host/roots", "/api/v1/voice/stt", "/api/v1/audit",
                 "/api/v1/smart-auth/settings", "/api/v1/smart-auth/trust", f"/api/v1/agents/{a['id']}/memory"):
        assert gateway.get(path, headers=auth).status_code == 200, path
    assert gateway.patch(f"/api/v1/agents/{a['id']}", json={"description": "phone"}, headers=auth).status_code == 200
    _stepup(gateway, auth)
    assert gateway.patch("/api/v1/settings", json={"max_steps_per_task": 60}, headers=auth).status_code in (200, 422)
    r = gateway.delete(f"/api/v1/agents/{a['id']}?confirm=true", headers=auth)
    assert r.status_code in (200, 202), r.text  # deleting an agent from the phone (after re-verification)


def test_agent_bots_and_other_users_never_administer(client, gateway):
    h = _setup_admin(client)
    a = _agent(client, h)
    _pair_owner(7)

    _pair_owner(8)  # a second approved Telegram user of the main bot: an operator, not the owner
    op = _mini(gateway, 8)
    assert gateway.get("/api/v1/miniapp/me", headers=op).json()["data"]["role"] == "operator"
    assert gateway.post("/api/v1/auth/stepup", json={"method": "password", "password": LOGIN},
                        headers=op).status_code == 200
    for method, path in (("GET", "/api/v1/settings"), ("DELETE", f"/api/v1/agents/{a['id']}"),
                         ("POST", "/api/v1/vault"), ("GET", "/api/v1/providers")):
        r = gateway.request(method, path, headers=op, json={"passphrase": PASS})
        assert r.status_code == 403 and r.json()["error"]["code"] == "owner_only", path
    from nebula_host import authz

    from tests.integration.test_v3_api import _pair_agent_bot_user, _session_as

    other = _agent(client, h, name="Other agent")
    _pair_agent_bot_user(other["id"], 7)  # bot-row-1 is the OTHER agent's bot
    _session_as(7, "bot-row-1", like="nebula-miniapp tg=8%")
    assert gateway.get("/api/v1/miniapp/me", headers=op).json()["data"]["role"] == "agent_bot"
    assert gateway.get("/api/v1/settings", headers=op).json()["error"]["code"] == "owner_only"
    # resource ownership: an agent's bot reaches only ITS agent
    r = gateway.post(f"/api/v1/agents/{a['id']}/tasks", json={"prompt": "x"}, headers=op)
    assert r.status_code == 403 and r.json()["error"]["code"] == "not_your_agent"
    assert gateway.get(f"/api/v1/agents/{other['id']}/messages", headers=op).status_code == 200  # its own agent
    r = gateway.get(f"/api/v1/agents/{a['id']}/messages", headers=op)
    assert r.status_code == 403 and r.json()["error"]["code"] == "not_your_agent"
    assert authz.resource_agent("/conversations/search") == (False, None)


def test_expired_init_data_replay_revocation_and_session_expiry(client, gateway):
    _setup_admin(client)
    _pair_owner(7)
    old = make_init_data(BOT_TOKEN, auth_date=int(time.time()) - 3600)
    assert gateway.post("/api/mini/auth", json={"init_data": old}).json()["error"]["code"] == "expired"
    data = make_init_data(BOT_TOKEN)
    assert gateway.post("/api/mini/auth", json={"init_data": data}).status_code == 200
    assert gateway.post("/api/mini/auth", json={"init_data": data}).json()["error"]["code"] == "replayed"
    auth = _mini(gateway)
    _stepup(gateway, auth)
    from nebula_host import db, models
    from sqlalchemy import update

    with db.engine().begin() as c:  # the session's hard expiry passed
        c.execute(update(models.sessions).where(models.sessions.c.user_agent.like("nebula-miniapp%"))
                  .values(expires_at=time.time() - 1))
    assert gateway.get("/api/v1/agents", headers=auth).status_code == 401
    auth = _mini(gateway)
    assert gateway.post("/api/mini/logout", headers=auth).status_code == 200
    assert gateway.get("/api/v1/agents", headers=auth).status_code == 401
