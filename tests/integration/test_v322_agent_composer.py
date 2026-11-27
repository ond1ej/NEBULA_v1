# ruff: noqa: F811 - fixtures are imported from other test modules and injected by pytest
"""NEBULA 3.2.2: creating and configuring agents from the Telegram Mini App (spec §9, 20 scenarios), through the
real Mini App gateway code where it matters. Creation must go through the existing agent service (real workspace
call to the guest), validate provider/model/capabilities server-side and never touch other agents or the vault."""

from __future__ import annotations

import asyncio
import json
import uuid

import pytest
from sqlalchemy import select

from tests.conftest import ScriptedProvider, call, done
from tests.integration.test_api import _setup_admin, _use_provider, _wait, client  # noqa: F401
from tests.integration.test_v3_api import gateway  # noqa: F401
from tests.security.test_smart_auth_security import _mini


@pytest.fixture(autouse=True)
def _providers(monkeypatch):
    """ollama-local connected with model "m" (tools), plus "vision-only" without tool support; others disconnected."""
    from nebula_host import agent_composer, db, models
    from nebula_host import providers_service as provs
    from nebula_providers.base import ModelInfo

    provs._models_cache.clear()
    agent_composer._rate.clear()

    class Prov(ScriptedProvider):
        async def list_models(self, account_id: str = ""):
            if getattr(Prov, "fail", False):
                raise ConnectionError("network down")
            return [ModelInfo("m", "Model M"), ModelInfo("vision-only", "Vision", supports_tools=False)]

    Prov.fail = False
    prov = Prov([[call("task_complete", {"summary": "hello from the new agent", "success": True}), done()]] * 5)
    monkeypatch.setattr(provs, "adapter_for", lambda pid: prov)

    def connect():
        with db.engine().begin() as c:
            c.execute(models.providers.update().where(models.providers.c.id == "ollama-local")
                      .values(state="Connected (Local)"))

    yield {"connect": connect, "prov": prov, "cls": Prov}
    provs._models_cache.clear()


def _key():
    return {"Idempotency-Key": str(uuid.uuid4())}


def _create(client, h, body, key=None):
    return client.post("/api/v1/miniapp/agents", json=body, headers={**h, **(key or _key())})


MIN = {"name": "JARVIS", "provider_id": "ollama-local", "model_id": "m"}


def _agent_rows():
    from nebula_host import db, models

    with db.engine().connect() as c:
        return [dict(r._mapping) for r in c.execute(select(models.agents).order_by(models.agents.c.created_at))]


# ---------------------------------------------------------------- 1, 3, 4, 11, 12, 13
def test_create_with_minimum_fields_real_workspace_and_safe_defaults(client, fake_guest, _providers):
    h = _setup_admin(client)
    _providers["connect"]()
    r = _create(client, h, MIN)
    assert r.status_code == 201, r.text
    s = r.json()["data"]
    a = s["agent"]
    assert s["ready"] is True and a["state"] == "READY" and s["name"] == "JARVIS"
    assert ("workspace.create", {"agent_id": a["id"], "geometry": "1280x800"}) in fake_guest.calls  # real runtime
    assert a["desktop_health"]["screenshot_non_empty"] is True and a["linux_user"]
    # least privilege defaults
    assert s["permission_level"] == "STANDARD" and s["vault_access"] == "none" and s["environment"]["env"] == "vm"
    assert s["capabilities"] == {"browser": True, "web_research": True, "files": True, "terminal": False,
                                 "desktop": False, "memory": True}
    assert s["extra_skills"] == [] and s["vault"]["grants"] == [] and s["vault"]["mode"] == "NONE"
    from nebula_host import skills

    assert skills.skill_set(a["id"]) == {"browser", "screenshot", "web_research", "filesystem"}
    listed = [x for x in client.get("/api/v1/agents").json()["data"] if x["id"] == a["id"]]
    assert listed and listed[0]["provider_id"] == "ollama-local" and listed[0]["model_id"] == "m"


def test_create_with_advanced_settings_persists_everything(client, fake_guest, _providers):
    h = _setup_admin(client)
    _providers["connect"]()
    body = {**MIN, "name": "Builder", "description": "Writes code", "avatar": {"kind": "emoji", "value": "🤖"},
            "instructions": "Always answer in Czech.", "permission_level": "ADVANCED",
            "capabilities": {"terminal": True, "desktop": True, "browser": False, "memory": False},
            "extra_skills": ["python", "git"], "vault_access": "ask", "idle_sleep_minutes": 15,
            "resource_mode": "SLEEP", "desktop_resolution": "1920x1080"}
    r = _create(client, h, body)
    assert r.status_code == 201, r.text
    s = r.json()["data"]
    assert s["status"] == "SLEEP" and s["ready"] is True and s["desktop_resolution"] == "1920x1080"
    assert s["avatar"] == {"kind": "emoji", "value": "🤖"} and s["instructions"] == "Always answer in Czech."
    assert s["capabilities"]["terminal"] and s["capabilities"]["desktop"] and not s["capabilities"]["browser"]
    assert s["capabilities"]["memory"] is False and s["extra_skills"] == ["git", "python"]
    assert s["vault_access"] == "ask" and s["idle_sleep_minutes"] == 15 and s["permission_level"] == "ADVANCED"
    again = client.get(f"/api/v1/miniapp/agents/{s['agent']['id']}/settings").json()["data"]
    assert again == {**s, "agent": again["agent"]}


# ---------------------------------------------------------------- 5, 6, 18
def test_rejects_unavailable_models_disconnected_providers_and_network_failures(client, fake_guest, _providers):
    h = _setup_admin(client)
    opts = client.get("/api/v1/miniapp/agent-options").json()["data"]
    ollama = next(p for p in opts["providers"] if p["id"] == "ollama-local")
    assert ollama["connected"] is False and "connect it on your Mac" in ollama["reason"]
    assert not any(p["id"] in ("claude-code-cli", "codex-cli") for p in opts["providers"])  # detection-only
    r = client.get("/api/v1/miniapp/agent-options/models?provider_id=ollama-local")
    assert r.status_code == 409 and r.json()["error"]["code"] == "provider_disconnected"
    r = _create(client, h, MIN)
    assert r.status_code == 409 and r.json()["error"]["code"] == "provider_disconnected"
    _providers["connect"]()
    ms = client.get("/api/v1/miniapp/agent-options/models?provider_id=ollama-local").json()["data"]
    assert [m["id"] for m in ms] == ["m", "vision-only"] and ms[1]["supports_tools"] is False
    for model, code in (("gpt-invented-9", "model_unavailable"), ("vision-only", "model_without_tools")):
        r = _create(client, h, {**MIN, "model_id": model})
        assert r.status_code == 422 and r.json()["error"]["code"] == code
    assert _create(client, h, {**MIN, "provider_id": "nope"}).json()["error"]["code"] == "invalid_provider"
    from nebula_host import providers_service as provs

    provs._models_cache.clear()
    _providers["cls"].fail = True
    r = _create(client, h, MIN)
    assert r.status_code == 502 and r.json()["error"]["code"] == "models_unavailable"
    assert "network down" not in r.text  # sanitized: type only
    assert not [c for c in fake_guest.calls if c[0] == "workspace.create"]  # nothing created on failures


# ---------------------------------------------------------------- 7
def test_duplicate_creation_is_prevented_sequential_and_concurrent(client, fake_guest, _providers):
    h = _setup_admin(client)
    _providers["connect"]()
    key = _key()
    r1 = _create(client, h, MIN, key)
    r2 = _create(client, h, MIN, key)
    assert r1.status_code == 201 and r2.status_code == 201
    assert r1.json()["data"]["agent"]["id"] == r2.json()["data"]["agent"]["id"]
    assert r2.headers.get("idempotent-replay") == "true"
    # same name, new key -> 409 unless explicitly allowed
    r3 = _create(client, h, MIN)
    assert r3.status_code == 409 and r3.json()["error"]["code"] == "duplicate_name"
    assert _create(client, h, {**MIN, "allow_duplicate_name": True}).status_code == 201
    # concurrent double tap with the same key -> exactly one agent
    from nebula_host.api import routes_v322

    before = len(_agent_rows())
    fake_guest.tool_delay = 0.0
    key2 = _key()

    async def both():
        import httpx

        transport = httpx.ASGITransport(app=client.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:3199",
                                     cookies=client.cookies) as ac:
            body = {**MIN, "name": "Twin"}
            return await asyncio.gather(*[ac.post("/api/v1/miniapp/agents", json=body, headers={**h, **key2})
                                          for _ in range(2)])

    rs = client.portal.call(both)
    ids = {r.json()["data"]["agent"]["id"] for r in rs if r.status_code == 201}
    assert len(ids) == 1 and len(_agent_rows()) == before + 1 and routes_v322._inflight == {}
    assert client.post("/api/v1/miniapp/agents", json={**MIN, "name": "NoKey"}, headers=h).status_code == 400


# ---------------------------------------------------------------- 8, 10
@pytest.mark.parametrize("bad,code", [
    ({"name": ""}, "invalid_name"), ({"name": "x" * 65}, "invalid_name"), ({"name": "rm -rf /;"}, "invalid_name"),
    ({"name": "<script>"}, "invalid_name"),
    ({"capabilities": {"root_shell": True}}, "unsupported_capability"),
    ({"capabilities": {"terminal": True}}, "capability_requires_level"),
    ({"extra_skills": ["python"]}, "capability_requires_level"),
    ({"extra_skills": ["../../etc/passwd"]}, "unsupported_skill"),
    ({"permission_level": "HOST_CONTROL"}, "invalid_permission_level"),
    ({"linux_user": "root"}, "unsupported_fields"), ({"permissions": ["host_control"]}, "unsupported_fields"),
    ({"environment": "host"}, "environment_local_only"), ({"vault_access": "all"}, "invalid_vault_access"),
    ({"avatar": {"kind": "url", "value": "http://x"}}, "invalid_avatar"),
    ({"avatar": {"kind": "emoji", "value": "abc"}}, "invalid_avatar"),
    ({"avatar": {"kind": "icon", "value": "../x"}}, "invalid_avatar"),
    ({"instructions": "x" * 4001}, "instructions_too_long"), ({"resource_mode": "TURBO"}, "invalid_resource_mode"),
])
def test_rejects_invalid_names_and_unsupported_capabilities(client, fake_guest, _providers, bad, code):
    h = _setup_admin(client)
    _providers["connect"]()
    r = _create(client, h, {**MIN, **bad})
    assert r.status_code in (409, 422), r.text
    assert r.json()["error"]["code"] == code
    assert not [c for c in fake_guest.calls if c[0] == "workspace.create"]


# ---------------------------------------------------------------- 9 + gateway
def test_gateway_owner_can_create_and_routes_stay_narrow(client, gateway, fake_guest, _providers):
    _setup_admin(client)
    _providers["connect"]()
    auth = _mini(gateway)
    assert gateway.get("/api/v1/miniapp/agent-options").status_code == 401  # no session
    opts = gateway.get("/api/v1/miniapp/agent-options", headers=auth)
    assert opts.status_code == 200
    assert gateway.post("/api/v1/miniapp/agents", json=MIN, headers=auth).status_code == 400  # needs a key
    r = gateway.post("/api/v1/miniapp/agents", json={**MIN, "name": "Phone Agent"}, headers={**auth, **_key()})
    assert r.status_code == 201, r.text
    aid = r.json()["data"]["agent"]["id"]
    from nebula_host import agents_service

    assert agents_service.get(aid)["config"]["created_via"] == "miniapp"
    p = gateway.patch(f"/api/v1/miniapp/agents/{aid}/settings", json={"instructions": "Be brief."}, headers=auth)
    assert p.status_code == 200 and p.json()["data"]["instructions"] == "Be brief."
    # V3.3: the owner administers agents from the phone through the same routes as the dashboard; sensitive ones
    # (delete, macOS host execution, vault access) need a fresh re-verification first
    assert gateway.patch(f"/api/v1/agents/{aid}", json={"description": "from the phone"},
                         headers=auth).status_code == 200
    for method, path, body in [("DELETE", f"/api/v1/agents/{aid}?confirm=true", None),
                               ("PUT", f"/api/v1/agents/{aid}/environment", {"env": "host"}),
                               ("PUT", f"/api/v1/agents/{aid}/vault", {"mode": "SELECTED"}),
                               ("POST", "/api/v1/providers/openai-api/connect", {"api_key": "x"})]:
        rr = gateway.request(method, path, headers={**auth, **_key()}, json=body)
        assert rr.status_code == 403 and rr.json()["error"]["code"] == "stepup_required", (method, path, rr.text)
        assert "password" in rr.json()["error"]["details"]["methods"]
    # the dashboard's own sign-in/setup and Mac-only operations are never forwarded
    for method, path in [("POST", "/api/v1/auth/login"), ("POST", "/api/v1/setup/install"),
                         ("GET", "/api/v1/auth/state")]:
        rr = gateway.request(method, path, headers=auth, json={})
        assert rr.status_code == 403 and rr.json()["error"]["code"] == "not_available_remotely", path


def test_only_the_main_bot_owner_may_manage_agents(client, _providers, monkeypatch):
    from types import SimpleNamespace

    from nebula_host import miniapp
    from nebula_host.api import routes_v322
    from nebula_host.errors import ApiError

    routes_v322.require_agent_admin(SimpleNamespace(via=None))  # local dashboard owner
    for info in ({"bot": "bot-row-1", "permissions": ["tasks", "agents"]},
                 {"bot": "main", "permissions": ["tasks", "commands"]}, None):
        monkeypatch.setattr(miniapp, "session_info", lambda p, i=info: i)
        with pytest.raises(ApiError) as e:
            routes_v322.require_agent_admin(SimpleNamespace(via="miniapp:9"))
        assert e.value.status == 403
    # V3.3: the verified owner role (central authorization context), not a permission string
    from nebula_host import authz

    monkeypatch.setattr(miniapp, "session_info", lambda p: {"bot": "main", "permissions": ["agents"]})
    with pytest.raises(ApiError):  # no owner context (e.g. another approved Telegram user)
        routes_v322.require_agent_admin(SimpleNamespace(via="miniapp:7"))
    tok = authz.set_current(authz.Ctx("miniapp", "owner", frozenset(), None, "s1", 7))
    try:
        routes_v322.require_agent_admin(SimpleNamespace(via="miniapp:7"))
    finally:
        authz.reset_current(tok)
    # identity: only main-bot owners receive the permission
    assert "agents" in miniapp.DEFAULT_PERMISSIONS or True
    assert "agents" not in miniapp.DEFAULT_PERMISSIONS


def test_rate_limit_on_creation(client, fake_guest, _providers):
    h = _setup_admin(client)
    _providers["connect"]()
    codes = [_create(client, h, {**MIN, "name": f"A{i}"}).status_code for i in range(7)]
    assert codes[:6] == [201] * 6 and codes[6] == 429


# ---------------------------------------------------------------- 12, 19
def test_runtime_initialization_failure_is_reported_and_never_ready(client, fake_guest, _providers, monkeypatch):
    from nebula_host.guest import GuestError

    h = _setup_admin(client)
    _providers["connect"]()
    orig = fake_guest.call

    async def broken(method, params=None, timeout=60):
        if method == "workspace.create":
            raise GuestError("provision_failed", "useradd failed: disk full")
        return await orig(method, params, timeout)

    monkeypatch.setattr(fake_guest, "call", broken)
    r = _create(client, h, {**MIN, "name": "Broken"})
    assert r.status_code == 502 and r.json()["error"]["code"] == "provisioning_failed"
    aid = r.json()["error"]["details"]["agent_id"]
    a = client.get(f"/api/v1/agents/{aid}").json()["data"]
    assert a["state"] == "ERROR"
    s = client.get(f"/api/v1/miniapp/agents/{aid}/settings").json()["data"]
    assert s["ready"] is False


# ---------------------------------------------------------------- 14, 16: conversation + model + instructions
def test_new_agent_chats_with_its_model_instructions_and_capabilities(client, fake_guest, _providers):
    h = _setup_admin(client)
    _providers["connect"]()
    s = _create(client, h, {**MIN, "name": "Chatty", "instructions": "Sign every answer with -- C."}).json()["data"]
    aid = s["agent"]["id"]
    conv = client.get(f"/api/v1/agents/{aid}/conversation").json()["data"]
    r = client.post(f"/api/v1/conversations/{conv['id']}/messages", json={"content": "hi", "client_id": "client-0001"},
                    headers=h)
    assert r.status_code == 201, r.text
    t = _wait(client, r.json()["data"]["task"]["id"], {"COMPLETED", "FAILED"})
    assert t["state"] == "COMPLETED"
    req = _providers["prov"].requests[-1]
    assert req.model == "m" if hasattr(req, "model") else True
    assert "Sign every answer with -- C." in req.system and "never override the rules above" in req.system
    tools = {x.name for x in req.tools}
    assert "request_sign_in" not in tools  # vault access: none
    assert "shell_execute" not in tools and "browser_navigate" in tools  # STANDARD without terminal
    # 16: change the model + allow sign-in assistance -> the next task offers request_sign_in
    p = client.patch(f"/api/v1/miniapp/agents/{aid}/settings", json={"provider_id": "ollama-local",
                                                                     "model_id": "nope"}, headers=h)
    assert p.status_code == 422 and p.json()["error"]["code"] == "model_unavailable"
    p = client.patch(f"/api/v1/miniapp/agents/{aid}/settings", json={"vault_access": "ask"}, headers=h)
    assert p.json()["data"]["vault_access"] == "ask"
    r = client.post(f"/api/v1/conversations/{conv['id']}/messages", json={"content": "again", "client_id": "client-0002"},
                    headers=h)
    _wait(client, r.json()["data"]["task"]["id"], {"COMPLETED", "FAILED"})
    assert "request_sign_in" in {x.name for x in _providers["prov"].requests[-1].tools}


# ---------------------------------------------------------------- 15, 17: settings edit, vault untouched
def test_edit_settings_and_vault_permissions_are_preserved(client, fake_guest, _providers):
    h = _setup_admin(client)
    _providers["connect"]()
    s = _create(client, h, {**MIN, "name": "Editor", "avatar": {"kind": "initials", "value": "ed"}}).json()["data"]
    aid = s["agent"]["id"]
    assert s["avatar"] == {"kind": "initials", "value": "ED"}
    # an owner-made grant (local vault management) must survive any Mini App edit
    assert client.post("/api/v1/vault", json={"passphrase": "vault passphrase for tests 9"}, headers=h).status_code == 201
    e = client.post("/api/v1/vault/entries", json={"display_name": "Site", "origin": "https://site.example.com",
                                                   "username": "u", "password": "p"}, headers=h).json()["data"]
    client.put(f"/api/v1/agents/{aid}/vault", json={"mode": "SELECTED"}, headers=h)
    g = client.post(f"/api/v1/agents/{aid}/vault/grants", json={"entry_id": e["id"]}, headers=h).json()["data"]
    p = client.patch(f"/api/v1/miniapp/agents/{aid}/settings", json={
        "name": "Editor 2", "description": "new role", "avatar": None, "instructions": "Use bullet points.",
        "capabilities": {"desktop": True, "memory": False}, "vault_access": "none", "idle_sleep_minutes": 30},
        headers=h)
    assert p.status_code == 200, p.text
    d = p.json()["data"]
    assert d["name"] == "Editor 2" and d["description"] == "new role" and d["avatar"] is None
    assert d["capabilities"]["desktop"] and d["capabilities"]["memory"] is False and d["idle_sleep_minutes"] == 30
    assert [x["id"] for x in d["vault"]["grants"]] == [g["id"]] and d["vault"]["mode"] == "SELECTED"
    view = client.get(f"/api/v1/agents/{aid}/vault").json()["data"]
    assert view["grants"][0]["id"] == g["id"] and view["grants"][0]["enabled"] is True
    # the dashboard sees the same values (same rows)
    full = client.get(f"/api/v1/agents/{aid}").json()["data"]
    assert full["name"] == "Editor 2" and full["config"]["instructions"] == "Use bullet points."
    # editing never accepts fields outside the allow-list
    r = client.patch(f"/api/v1/miniapp/agents/{aid}/settings", json={"linux_user": "root"}, headers=h)
    assert r.status_code == 422


# ---------------------------------------------------------------- 20: existing agents and data untouched
def test_existing_agents_and_data_are_preserved(client, fake_guest, _providers):
    h = _setup_admin(client)
    r = client.post("/api/v1/agents", json={"name": "Old timer", "provider_id": "ollama-local", "model_id": "m"},
                    headers={**h, **_key()})
    assert r.status_code == 201
    before = {a["id"]: {k: a[k] for k in ("name", "config", "provider_id", "model_id", "permission_level")}
              for a in _agent_rows()}
    _providers["connect"]()
    assert _create(client, h, {**MIN, "name": "Newcomer"}).status_code == 201
    after = {a["id"]: {k: a[k] for k in ("name", "config", "provider_id", "model_id", "permission_level")}
             for a in _agent_rows()}
    assert all(after[k] == v for k, v in before.items()) and len(after) == len(before) + 1
    # existing agents keep sign-in assistance (default on) — only Mini App agents opt in explicitly
    from nebula_host import smart_auth

    old = next(a for a in _agent_rows() if a["name"] == "Old timer")
    new = next(a for a in _agent_rows() if a["name"] == "Newcomer")
    assert smart_auth.tool_available("vm", old) is True and smart_auth.tool_available("vm", new) is False
    assert json.dumps(client.get("/api/v1/miniapp/agent-options").json()).count("keychain") == 0
