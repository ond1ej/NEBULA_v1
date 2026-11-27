"""HTTP API: first-run setup, login, CSRF, Host/Origin guards, idempotency, agents/tasks/approvals with a fake guest."""

from __future__ import annotations

import time
import uuid

import pytest
from fastapi.testclient import TestClient

from tests.conftest import ScriptedProvider, call, done

ORIGIN = {"origin": "http://127.0.0.1:3199"}


@pytest.fixture()
def client(data_dir, fake_guest, monkeypatch):
    from nebula_host import auth
    from nebula_host.app import create_app
    from nebula_host.state import svc

    auth._ip_attempts.clear()

    app = create_app()
    with TestClient(app, base_url="http://127.0.0.1:3199") as c:
        svc.guest = fake_guest
        svc.orch.guest = fake_guest
        svc.live.guest = fake_guest
        svc.telegram.guest = fake_guest
        for name in ("teams", "files", "resources"):  # V2 services
            getattr(svc, name).guest = fake_guest
        yield c


def _setup_admin(client) -> dict:
    from nebula_host import auth

    tok = auth.ensure_setup_token()
    r = client.post("/api/v1/auth/setup", json={"username": "owner", "password": "correct horse battery",
                                                "setup_token": tok}, headers=ORIGIN)
    assert r.status_code == 201, r.text
    return {**ORIGIN, "x-csrf-token": r.json()["data"]["csrf_token"]}


def test_first_run_requires_setup_token(client):
    st = client.get("/api/v1/auth/state").json()["data"]
    assert st["initialized"] is False
    r = client.post("/api/v1/auth/setup", json={"username": "owner", "password": "correct horse battery",
                                                "setup_token": "wrong"}, headers=ORIGIN)
    assert r.status_code == 403 and r.json()["error"]["code"] == "invalid_setup_token"
    _setup_admin(client)
    r = client.post("/api/v1/auth/setup", json={"username": "x", "password": "correct horse battery",
                                                "setup_token": "x"}, headers=ORIGIN)
    assert r.status_code == 409


def test_weak_password_rejected(client):
    from nebula_host import auth

    r = client.post("/api/v1/auth/setup", json={"username": "owner", "password": "admin",
                                                "setup_token": auth.ensure_setup_token()}, headers=ORIGIN)
    assert r.status_code == 422


def test_auth_required_and_csrf(client):
    assert client.get("/api/v1/agents").status_code == 401
    h = _setup_admin(client)
    assert client.get("/api/v1/agents").status_code == 200
    r = client.post("/api/v1/agents", json={"name": "x"}, headers=ORIGIN)  # no CSRF header
    assert r.status_code == 403 and r.json()["error"]["code"] == "csrf_failed"
    assert "request_id" in r.json()
    r = client.post("/api/v1/auth/logout", headers=h)
    assert r.status_code == 200
    assert client.get("/api/v1/agents").status_code == 401


def test_host_and_origin_guards(client):
    h = _setup_admin(client)
    r = client.get("/api/v1/health", headers={"host": "evil.example:3199"})
    assert r.status_code == 403 and r.json()["error"]["code"] == "bad_host"
    r = client.post("/api/v1/agents", json={"name": "a"}, headers={**h, "origin": "https://evil.example"})
    assert r.status_code == 403 and r.json()["error"]["code"] == "bad_origin"


def test_login_lockout(client):
    _setup_admin(client)
    client.cookies.clear()
    for _ in range(5):
        r = client.post("/api/v1/auth/login", json={"username": "owner", "password": "nope-nope-nope"}, headers=ORIGIN)
        assert r.status_code == 401
    r = client.post("/api/v1/auth/login", json={"username": "owner", "password": "correct horse battery"},
                    headers=ORIGIN)
    assert r.status_code == 429 and r.json()["error"]["code"] == "account_locked"


def test_security_headers(client):
    r = client.get("/api/v1/health")
    assert "frame-ancestors 'none'" in r.headers["content-security-policy"]
    assert r.headers["x-frame-options"] == "DENY"


def _agent(client, h, name="Developer", provider="ollama-local", level="ADVANCED"):
    r = client.post("/api/v1/agents", json={"name": name, "provider_id": provider, "model_id": "m",
                                            "permission_level": level}, headers={**h, "Idempotency-Key": str(uuid.uuid4())})
    assert r.status_code == 201, r.text
    return r.json()["data"]


def test_create_agent_provisions_real_workspace_and_is_idempotent(client, fake_guest):
    h = _setup_admin(client)
    key = str(uuid.uuid4())
    body = {"name": "Developer", "provider_id": "ollama-local", "model_id": "m"}
    r1 = client.post("/api/v1/agents", json=body, headers={**h, "Idempotency-Key": key})
    r2 = client.post("/api/v1/agents", json=body, headers={**h, "Idempotency-Key": key})
    assert r1.status_code == 201 and r2.json()["data"]["id"] == r1.json()["data"]["id"]
    assert r2.headers.get("idempotent-replay") == "true"
    a = r1.json()["data"]
    assert a["state"] == "READY" and a["guest_user"].startswith("nebula_") and a["display_id"] == "display-21"
    assert [c for c in fake_guest.calls if c[0] == "workspace.create"] == [("workspace.create",
                                                                            {"agent_id": a["id"], "geometry": "1280x800"})]
    b = _agent(client, h, "Researcher")
    assert b["guest_user"] != a["guest_user"] and b["display_id"] == "display-22"


def test_create_agent_validation(client):
    h = _setup_admin(client)
    for body in ({"name": ""}, {"name": "x; rm -rf /"}, {"name": "ok", "permission_level": "HOST_CONTROL"},
                 {"name": "ok", "desktop_resolution": "99999x1"}, {"name": "ok", "provider_id": "nope"}):
        r = client.post("/api/v1/agents", json=body, headers=h)
        assert r.status_code == 422, body


def test_create_agent_guest_failure_marks_error(client, fake_guest):
    from nebula_host.guest import GuestUnavailable

    h = _setup_admin(client)

    async def boom(method, params=None, timeout=60):
        raise GuestUnavailable("VM is not running")

    fake_guest.call = boom
    r = client.post("/api/v1/agents", json={"name": "X"}, headers=h)
    assert r.status_code == 503 and r.json()["error"]["code"] == "provisioning_failed"
    agents = client.get("/api/v1/agents").json()["data"]
    assert agents[0]["state"] == "ERROR"


def _wait(client, tid, states, timeout=10.0):
    end = time.time() + timeout
    while time.time() < end:
        t = client.get(f"/api/v1/tasks/{tid}").json()["data"]
        if t["state"] in states:
            return t
        time.sleep(0.05)
    raise AssertionError(f"task stuck in {t['state']}")


def _use_provider(monkeypatch, prov):
    from nebula_host import providers_service

    monkeypatch.setattr(providers_service, "adapter_for", lambda pid: prov)


def test_task_runs_tools_and_verifies_artifacts(client, fake_guest, monkeypatch):
    h = _setup_admin(client)
    a = _agent(client, h)
    prov = ScriptedProvider([
        [call("browser_navigate", {"url": "https://example.com"}), done()],
        [call("files_write", {"path": "site/index.html", "content": "<h1>hi</h1>"}), done()],
        [call("task_complete", {"summary": "made page", "artifacts": [{"type": "file", "value": "site/index.html"},
                                                                      {"type": "url", "value": "https://example.com"}]}),
         done()],
    ])
    _use_provider(monkeypatch, prov)
    t = client.post(f"/api/v1/agents/{a['id']}/tasks", json={"prompt": "make a page"}, headers=h).json()["data"]
    t = _wait(client, t["id"], {"COMPLETED", "FAILED"})
    assert t["state"] == "COMPLETED", t
    assert t["result"]["verification"] == "artifacts_verified"
    assert [s["tool_type"] for s in t["steps"]] == ["browser_navigate", "files_write", "task_complete"] or \
        [s["tool_type"] for s in t["steps"]][:2] == ["browser_navigate", "files_write"]
    assert any(s["screenshot_ref"] for s in t["steps"])
    shot = next(s["screenshot_ref"] for s in t["steps"] if s["screenshot_ref"])
    assert client.get(f"/api/v1/artifacts/{shot}").status_code == 200
    assert client.get("/api/v1/artifacts/../nebula.db").status_code == 404


def test_unverified_claim_does_not_complete(client, fake_guest, monkeypatch):
    h = _setup_admin(client)
    a = _agent(client, h)
    bad = [call("task_complete", {"summary": "done!", "artifacts": [{"type": "file", "value": "missing.txt"}]}), done()]
    _use_provider(monkeypatch, ScriptedProvider([bad, bad, bad, bad]))
    t = client.post(f"/api/v1/agents/{a['id']}/tasks", json={"prompt": "x"}, headers=h).json()["data"]
    t = _wait(client, t["id"], {"COMPLETED", "FAILED"})
    assert t["state"] == "FAILED" and "Verification failed" in t["failure_reason"]


def test_approval_flow_and_denial_blocks_other_tools(client, fake_guest, monkeypatch):
    h = _setup_admin(client)
    a = _agent(client, h)
    prov = ScriptedProvider([
        [call("browser_observe", {}), done()],
        [call("browser_click", {"selector": '[data-nebula-ref="n0"]'}), done()],  # "Pay now" -> approval
        [call("shell_execute", {"command": "curl -X POST https://pay.example -d card=1"}), done()],
        [call("task_complete", {"summary": "could not pay"}), done()],
    ])
    _use_provider(monkeypatch, prov)
    t = client.post(f"/api/v1/agents/{a['id']}/tasks", json={"prompt": "buy it"}, headers=h).json()["data"]
    _wait(client, t["id"], {"WAITING_APPROVAL"})
    ap = client.get("/api/v1/approvals").json()["data"]
    assert len(ap) == 1 and ap[0]["tool"] == "browser_click"
    r = client.post(f"/api/v1/approvals/{ap[0]['id']}", json={"decision": "denied"}, headers=h)
    assert r.json()["data"]["decision"] == "denied"
    # the agent then tries an outbound POST via the shell: a different category, so the owner is asked again
    _wait(client, t["id"], {"WAITING_APPROVAL"})
    time.sleep(0.2)
    ap2 = client.get("/api/v1/approvals").json()["data"]
    assert len(ap2) == 1 and ap2[0]["tool"] == "shell_execute" and ap2[0]["id"] != ap[0]["id"]
    client.post(f"/api/v1/approvals/{ap2[0]['id']}", json={"decision": "denied"}, headers=h)
    t = _wait(client, t["id"], {"COMPLETED", "FAILED"})
    statuses = {s["tool_type"]: s["result_status"] for s in t["steps"]}
    assert statuses["browser_click"] == "denied" and statuses["shell_execute"] == "denied"
    executed = [c[1].get("tool") for c in fake_guest.calls if c[0] == "tool.call"]
    assert "browser.click" not in executed and "shell.execute" not in executed
    audit = client.get("/api/v1/audit").json()["data"]
    assert any(a["action"] == "approval.denied" for a in audit)


def test_pause_resume_from_checkpoint(client, fake_guest, monkeypatch):
    import asyncio

    h = _setup_admin(client)
    a = _agent(client, h)
    prov = ScriptedProvider([
        [call("files_write", {"path": "a.txt", "content": "1"}), done()],
        [call("files_write", {"path": "b.txt", "content": "2"}), done()],
        [call("task_complete", {"summary": "ok", "artifacts": [{"type": "file", "value": "b.txt"}]}), done()],
    ])
    _use_provider(monkeypatch, prov)
    fake_guest.block = asyncio.Event()
    t = client.post(f"/api/v1/agents/{a['id']}/tasks", json={"prompt": "two files"}, headers=h).json()["data"]
    _wait(client, t["id"], {"EXECUTING"})
    r = client.post(f"/api/v1/tasks/{t['id']}/pause", json={"mode": "smart"}, headers=h)
    assert r.json()["data"]["state"] == "PAUSING"
    from nebula_host.state import svc

    svc.orch.wake.set()
    loop = svc.orch._loop_task.get_loop()
    loop.call_soon_threadsafe(fake_guest.block.set)
    t2 = _wait(client, t["id"], {"PAUSED"})
    writes_before = len([c for c in fake_guest.calls if c[1].get("tool") == "files.write"])
    assert writes_before == 1 and t2["checkpoint_id"]
    time.sleep(0.3)
    assert len([c for c in fake_guest.calls if c[1].get("tool") == "files.write"]) == 1  # no tool calls while paused
    client.post(f"/api/v1/tasks/{t['id']}/resume", headers=h)
    t3 = _wait(client, t["id"], {"COMPLETED", "FAILED"})
    assert t3["state"] == "COMPLETED"
    assert len([c for c in fake_guest.calls if c[1].get("tool") == "files.write"]) == 2  # no duplicate of a.txt


def test_quota_moves_task_to_waiting_provider(client, monkeypatch):
    from nebula_providers.base import ProviderError

    h = _setup_admin(client)
    a = _agent(client, h)
    _use_provider(monkeypatch, ScriptedProvider([], error=ProviderError("quota", "usage limit reached")))
    t = client.post(f"/api/v1/agents/{a['id']}/tasks", json={"prompt": "x"}, headers=h).json()["data"]
    t = _wait(client, t["id"], {"WAITING_PROVIDER", "FAILED"})
    assert t["state"] == "WAITING_PROVIDER" and "quota" in t["failure_reason"]


def test_active_limit_queues_third_agent(client, fake_guest, monkeypatch):
    import asyncio

    h = _setup_admin(client)
    agents = [_agent(client, h, f"A{i}") for i in range(3)]
    gate = asyncio.Event()
    _use_provider(monkeypatch, ScriptedProvider([], block=gate))
    tasks = [client.post(f"/api/v1/agents/{x['id']}/tasks", json={"prompt": "work"}, headers=h).json()["data"]
             for x in agents]
    time.sleep(1.0)
    states = [client.get(f"/api/v1/tasks/{t['id']}").json()["data"]["state"] for t in tasks]
    assert states.count("QUEUED") == 1 and states.count("PLANNING") == 2, states
    from nebula_host.state import svc

    svc.orch._loop_task.get_loop().call_soon_threadsafe(gate.set)
    for t in tasks:
        _wait(client, t["id"], {"COMPLETED"}, timeout=15)


def test_take_control_blocks_gui_tools(client, fake_guest, monkeypatch):
    import asyncio

    from nebula_host.state import svc

    h = _setup_admin(client)
    a = _agent(client, h)
    _use_provider(monkeypatch, ScriptedProvider([
        [call("browser_navigate", {"url": "https://example.com"}), done()],
        [call("task_complete", {"summary": "ok"}), done()]]))
    loop = svc.orch._loop_task.get_loop()
    asyncio.run_coroutine_threadsafe(svc.orch.acquire_control(a["id"], "live-1"), loop).result(5)
    t = client.post(f"/api/v1/agents/{a['id']}/tasks", json={"prompt": "nav"}, headers=h).json()["data"]
    _wait(client, t["id"], {"WAITING_CONTROL"})
    assert not any(c[1].get("tool") == "browser.navigate" for c in fake_guest.calls)
    loop.call_soon_threadsafe(svc.orch.release_control, a["id"])
    t = _wait(client, t["id"], {"COMPLETED", "FAILED"})
    assert any(c[1].get("tool") == "browser.navigate" for c in fake_guest.calls)
    assert any(c[1].get("tool") == "browser.observe" for c in fake_guest.calls)  # re-observation after release


def test_crash_recovery_never_replays_in_flight_side_effect(dbinit, fake_guest):
    """Simulate a host crash while a shell command was in flight: on restart it must not be re-executed."""
    import asyncio

    from nebula_host import db, models
    from nebula_runtime.orchestrator import Orchestrator, get_task, save_checkpoint

    aid, tid = str(uuid.uuid4()), str(uuid.uuid4())
    now = db.now()
    with db.engine().begin() as c:
        c.execute(models.agents.insert().values(id=aid, name="A", status="ACTIVE", linux_user="nebula_" + aid[:8],
                                                provider_id="ollama-local", model_id="m", permissions=[], capabilities=[],
                                                permission_level="ADVANCED", created_at=now, updated_at=now))
        c.execute(models.tasks.insert().values(id=tid, agent_id=aid, prompt="deploy", state="EXECUTING", max_steps=10,
                                               created_at=now, updated_at=now))
    save_checkpoint(tid, {"messages": [{"role": "user", "content": "deploy"},
                                       {"role": "assistant", "content": "", "tool_calls": [
                                           {"id": "c1", "name": "shell_execute", "arguments": {"command": "./deploy.sh"}}]}],
                          "seq": 1, "pending_side_effects": [{"tool_call_id": "c1", "tool": "shell_execute",
                                                             "status": "in_flight"}]})
    from nebula_host import providers_service
    from nebula_host.config import get_config

    prov = ScriptedProvider([[call("task_complete", {"summary": "checked state, not redeploying"}), done()]])
    orig = providers_service.adapter_for
    providers_service.adapter_for = lambda pid: prov
    try:
        async def go():
            from nebula_host.events import bus

            bus.bind_loop(asyncio.get_running_loop())
            o = Orchestrator(get_config(), fake_guest)
            await o.start()
            for _ in range(200):
                if get_task(tid)["state"] in ("COMPLETED", "FAILED"):
                    break
                await asyncio.sleep(0.05)
            await o.shutdown()

        asyncio.run(go())
    finally:
        providers_service.adapter_for = orig
    assert get_task(tid)["state"] == "COMPLETED"
    assert not any(c[1].get("tool") == "shell.execute" for c in fake_guest.calls)
    msgs = prov.requests[0].messages
    assert any("outcome_unknown" in m.content for m in msgs if m.role == "tool")


def test_live_connect_requires_ws_token_and_isolates_agents(client, fake_guest):
    h = _setup_admin(client)
    a = _agent(client, h, "A")
    b = _agent(client, h, "B")
    r = client.post(f"/api/v1/agents/{a['id']}/live/connect", headers=h).json()["data"]
    assert r["state"] == "CONNECTING" and r["read_only"] is True
    from nebula_host.state import svc

    # no stream exists until the websocket is opened
    assert svc.live.active_streams() == []
    sess = client.get("/api/v1/live/sessions").json()["data"]["sessions"]
    assert all("token_hash" not in s for s in sess)
    with pytest.raises(PermissionError):
        svc.live.authorize_ws(r["session_id"], "wrong-token", sess[0]["viewer_session_id"])
    with pytest.raises(PermissionError):
        svc.live.authorize_ws(r["session_id"], r["token"], "another-login")
    s = svc.live.authorize_ws(r["session_id"], r["token"], sess[0]["viewer_session_id"])
    assert s["agent_id"] == a["id"] != b["id"]
    d = client.delete(f"/api/v1/live/sessions/{r['session_id']}", headers=h).json()["data"]
    assert d["state"] == "DISCONNECTED" and d["active_stream"] is False
    with pytest.raises(PermissionError):
        svc.live.authorize_ws(r["session_id"], r["token"], sess[0]["viewer_session_id"])  # single use


def test_provider_api_key_never_in_db_or_response(client):
    h = _setup_admin(client)
    secret = "sk-ant-test-" + "x" * 40
    r = client.post("/api/v1/providers/anthropic-api/connect", json={"api_key": secret}, headers=h)
    assert r.status_code == 200
    assert secret not in r.text
    from nebula_host import db

    raw = open(db.engine().url.database, "rb").read()
    assert secret.encode() not in raw
    assert secret not in client.get("/api/v1/providers").text
    r = client.post("/api/v1/providers/anthropic-api/connect", json={"api_key": "x", "password": "p"}, headers=h)
    assert r.status_code == 400 and r.json()["error"]["code"] == "forbidden_credential"


def test_siwc_connect_returns_official_authorize_url(client):
    from urllib.parse import parse_qs, urlparse

    h = _setup_admin(client)
    r = client.post("/api/v1/providers/openai-siwc/connect", headers=h).json()["data"]
    u = urlparse(r["authorize_url"])
    q = parse_qs(u.query)
    assert u.netloc == "auth.openai.com" and u.path == "/api/accounts/authorize"
    assert q["client_id"] == ["dynamic_agent_client"] and q["code_challenge_method"] == ["S256"]
    assert q["redirect_uri"] == ["http://127.0.0.1:3199/auth/callback"]
    assert q["ext_agent_host_id"][0].startswith("urn:uuid:")
    assert "chatgpt.tokens.use.direct" in q["scope"][0]
    bad = client.get("/auth/callback?state=forged&code=x")
    assert bad.status_code == 400


def test_cli_modes_are_unsupported_not_fake_connected(client):
    h = _setup_admin(client)
    for pid in ("claude-code-cli", "codex-cli", "google-antigravity"):
        r = client.post(f"/api/v1/providers/{pid}/test", headers=h).json()["data"]
        assert r["state"] == "Unsupported on this version"


def test_openapi_and_health(client):
    spec = client.get("/api/openapi.json").json()
    paths = set(spec["paths"])
    for p in ("/api/v1/health", "/api/v1/agents", "/api/v1/agents/{agent_id}/live/connect",
              "/api/v1/live/sessions/{session_id}/control", "/api/v1/telegram/pairing/{pid}/approve",
              "/api/v1/setup/jobs/{job_id}", "/api/v1/events"):
        assert p in paths, p
    h = client.get("/api/v1/health").json()["data"]
    assert h["db"] == "ok" and h["vm"]["state"] in ("not_created", "stopped", "running", "error")


def test_agent_reported_failure_is_failed_not_completed(client, fake_guest, monkeypatch):
    h = _setup_admin(client)
    a = _agent(client, h)
    fake_guest.fail_tools.add("browser.navigate")
    _use_provider(monkeypatch, ScriptedProvider([
        [call("browser_navigate", {"url": "https://example.com"}), done()],
        [call("task_complete", {"summary": "page did not load", "success": True}), done()],  # claims success
        [call("task_complete", {"summary": "could not load the page", "success": False}), done()],
    ]))
    t = client.post(f"/api/v1/agents/{a['id']}/tasks", json={"prompt": "x"}, headers=h).json()["data"]
    t = _wait(client, t["id"], {"COMPLETED", "FAILED"})
    assert t["state"] == "FAILED" and "could not load" in t["failure_reason"]


def test_openapi_contract_matches_committed(data_dir):
    """Contract test: the committed OpenAPI document must match the app (run scripts/gen-api-doc.py)."""
    import json
    from pathlib import Path

    from nebula_host.app import create_app

    committed = json.loads((Path(__file__).resolve().parents[2] / "packages/contracts/openapi.json").read_text())
    live = json.loads(json.dumps(create_app().openapi(), sort_keys=True))
    assert set(committed["paths"]) == set(live["paths"])
    for p in live["paths"]:
        assert set(committed["paths"][p]) == set(live["paths"][p]), p


def test_text_only_completion_after_failed_verification_does_not_hang(client, fake_guest, monkeypatch):
    """Regression (hardware E2E-14): model writes task_complete as TEXT after a verification failure."""
    from nebula_providers.base import ModelEvent

    h = _setup_admin(client)
    a = _agent(client, h)
    _use_provider(monkeypatch, ScriptedProvider([
        [call("files_write", {"path": "x.txt", "content": "1"}), done()],
        [ModelEvent("text_delta", text="all done"), done()],  # no artifacts -> verification fails, loop continues
        [call("task_complete", {"summary": "ok", "success": True, "artifacts": [{"type": "file", "value": "x.txt"}]}),
         done()],
    ]))
    t = client.post(f"/api/v1/agents/{a['id']}/tasks", json={"prompt": "x"}, headers=h).json()["data"]
    t = _wait(client, t["id"], {"COMPLETED", "FAILED"})
    assert t["state"] == "COMPLETED" and t["result"]["verification"] == "artifacts_verified"


def test_shell_only_task_verified_by_exit_codes(client, fake_guest, monkeypatch):
    h = _setup_admin(client)
    a = _agent(client, h)
    _use_provider(monkeypatch, ScriptedProvider([
        [call("shell_execute", {"command": "sleep 1"}), done()],
        [call("task_complete", {"summary": "slept", "success": True}), done()],
    ]))
    t = client.post(f"/api/v1/agents/{a['id']}/tasks", json={"prompt": "sleep"}, headers=h).json()["data"]
    t = _wait(client, t["id"], {"COMPLETED", "FAILED"})
    assert t["state"] == "COMPLETED" and t["result"]["verification"] == "command_exit_codes"


def test_consented_provider_fallback(client, fake_guest, monkeypatch):
    from nebula_host import providers_service
    from nebula_providers.base import ProviderError

    h = _setup_admin(client)
    r = client.post("/api/v1/agents", json={"name": "F", "provider_id": "ollama-local", "model_id": "m",
                                            "fallback_provider_id": "anthropic-api", "fallback_model_id": "claude-x"},
                    headers=h)
    a = r.json()["data"]
    primary = ScriptedProvider([], error=ProviderError("quota", "limit"))
    backup = ScriptedProvider([[call("task_complete", {"summary": "done by fallback", "success": True}), done()]])
    monkeypatch.setattr(providers_service, "adapter_for", lambda pid: primary if pid == "ollama-local" else backup)
    t = client.post(f"/api/v1/agents/{a['id']}/tasks", json={"prompt": "x"}, headers=h).json()["data"]
    t = _wait(client, t["id"], {"COMPLETED", "FAILED", "WAITING_PROVIDER"})
    assert t["state"] == "COMPLETED" and backup.requests[0].model == "claude-x"


def test_delete_agent_when_vm_down_is_safe(client, fake_guest):
    from nebula_host.guest import GuestUnavailable

    h = _setup_admin(client)
    a = _agent(client, h)

    async def down(timeout=5):
        raise GuestUnavailable("VM is not running")

    fake_guest.ping = down
    r = client.delete(f"/api/v1/agents/{a['id']}?confirm=true", headers=h)
    assert r.status_code == 503 and r.json()["error"]["code"] == "vm_unavailable"
    assert client.get(f"/api/v1/agents/{a['id']}").json()["data"]["state"] == "READY"


def test_host_memory_pressure_queues_tasks(client, fake_guest, monkeypatch):
    import nebula_host.vm as vm

    h = _setup_admin(client)
    a = _agent(client, h)
    monkeypatch.setattr(vm, "host_resources", lambda d: {"memory_pressure": "warning"})
    # warning with little free memory (the kernel's free level below the admission floor) holds new work back
    monkeypatch.setattr(vm, "memory_status", lambda: {"memory_pressure": "warning", "memory_free_percent": 12,
                                                      "swap_used_mb": 2000.0, "swap_total_mb": 3072.0,
                                                      "memory_total_bytes": 16 << 30, "ts": time.time()})
    _use_provider(monkeypatch, ScriptedProvider([[call("task_complete", {"summary": "x", "success": True}), done()]]))
    t = client.post(f"/api/v1/agents/{a['id']}/tasks", json={"prompt": "x"}, headers=h).json()["data"]
    time.sleep(1.0)
    assert client.get(f"/api/v1/tasks/{t['id']}").json()["data"]["state"] == "QUEUED"


def test_guest_memory_low_auto_sleeps_lru_agent(client, fake_guest, monkeypatch):
    h = _setup_admin(client)
    idle = _agent(client, h, "Idle")
    busy = _agent(client, h, "Busy")
    mem = {"v": 300 << 20}
    orig = fake_guest.call

    async def call_(method, params=None, timeout=60):
        if method == "ping":
            return {"pong": True, "mem": {"MemAvailable": mem["v"]}}
        if method == "workspace.stop":
            mem["v"] = 2 << 30  # sleeping the idle desktop frees memory
        return await orig(method, params, timeout)

    fake_guest.call = call_
    _use_provider(monkeypatch, ScriptedProvider([[call("task_complete", {"summary": "x", "success": True}), done()]]))
    t = client.post(f"/api/v1/agents/{busy['id']}/tasks", json={"prompt": "x"}, headers=h).json()["data"]
    t = _wait(client, t["id"], {"COMPLETED", "FAILED"})
    assert t["state"] == "COMPLETED"
    assert client.get(f"/api/v1/agents/{idle['id']}").json()["data"]["state"] == "SLEEP"


def test_model_request_budget_is_hard_cap(client, fake_guest, monkeypatch):
    """max_steps also caps model requests: a model that never calls tools cannot loop past the budget."""
    from nebula_providers.base import ModelEvent

    h = _setup_admin(client)
    a = _agent(client, h)
    talk = [ModelEvent("text_delta", text=""), done()]  # empty answers -> loop continues without tool calls
    prov = ScriptedProvider([[call("files_write", {"path": "x", "content": "1"}), done()]] + [talk] * 10)
    _use_provider(monkeypatch, prov)
    t = client.post(f"/api/v1/agents/{a['id']}/tasks", json={"prompt": "x", "max_steps": 3}, headers=h).json()["data"]
    t = _wait(client, t["id"], {"COMPLETED", "FAILED"})
    assert t["state"] == "FAILED" and len(prov.requests) == 3 and "3 model requests" in t["failure_reason"]
