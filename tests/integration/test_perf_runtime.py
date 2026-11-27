# ruff: noqa: F811 - the `client` fixture is imported from test_api and injected by pytest
"""Perf audit 2026-11-16: agent pipeline fixes found on the live Mac.

* GUI-only tasks (type/click/keypress) have no file or URL to verify: NEBULA now captures the desktop as evidence
  instead of failing the task after extra model round trips (live tasks 2667edcc / 058f32cd FAILED that way).
* Every finished task carries a timing report (queue, model, tools, orchestration) and live `task.stage` events.
* A screenshot request for a sleeping desktop answers at once (it blocked ~15 s inside the guest).
* The request guard no longer spawns `scutil` on every HTTP request (~10 ms event-loop stall per request).
"""

from __future__ import annotations

import time

from tests.conftest import ScriptedProvider, call, done
from tests.integration.test_api import _agent, _setup_admin, _use_provider, _wait, client  # noqa: F401


def _events(client, task_id: str, type_: str) -> list[dict]:
    from nebula_host import db, models
    from sqlalchemy import select

    with db.engine().connect() as c:
        rows = c.execute(select(models.events.c.payload).where(models.events.c.task_id == task_id)
                         .where(models.events.c.type == type_).order_by(models.events.c.sequence)).all()
    return [r.payload for r in rows]


def test_gui_only_task_completes_with_screenshot_evidence(client, fake_guest, monkeypatch):
    h = _setup_admin(client)
    a = _agent(client, h)
    prov = ScriptedProvider([
        [call("desktop_launch", {"app": "terminal"}), done()],
        [call("desktop_type", {"text": "whoami"}), call("desktop_keypress", {"keys": "Return"}), done()],
        [call("task_complete", {"summary": "typed whoami in the terminal", "success": True}), done()],
    ])
    _use_provider(monkeypatch, prov)
    t = client.post(f"/api/v1/agents/{a['id']}/tasks", json={"prompt": "open a terminal and run whoami"},
                    headers=h).json()["data"]
    t = _wait(client, t["id"], {"COMPLETED", "FAILED"})
    assert t["state"] == "COMPLETED", t.get("failure_reason")
    r = t["result"]
    assert r["verification"] == "screenshot_evidence"
    ev = r["verified_artifacts"][0]
    assert ev["type"] == "screenshot" and ev["value"].endswith(".png") and "final-" in ev["value"]
    assert ev["value"] in r["screenshots"]  # the owner gets the evidence screenshot with the result
    assert len(prov.requests) == 3  # no extra "list artifacts" round trip
    # a fresh capture after the last action (not a stale step screenshot)
    shots = [c for c in fake_guest.calls if c[0] == "tool.call" and c[1]["tool"] == "desktop.screenshot"]
    assert shots and shots[-1][1]["args"] == {}


def test_file_changes_still_require_artifacts(client, fake_guest, monkeypatch):
    """The screenshot evidence is only for pure GUI work: written files must still be listed and verified."""
    h = _setup_admin(client)
    a = _agent(client, h)
    done_no_art = [call("task_complete", {"summary": "wrote it", "success": True}), done()]
    _use_provider(monkeypatch, ScriptedProvider([
        [call("files_write", {"path": "a.txt", "content": "x"}), done()], done_no_art, done_no_art, done_no_art]))
    t = client.post(f"/api/v1/agents/{a['id']}/tasks", json={"prompt": "write a file"}, headers=h).json()["data"]
    t = _wait(client, t["id"], {"COMPLETED", "FAILED"})
    assert t["state"] == "FAILED" and "listed no artifacts" in t["failure_reason"]


def test_gui_task_with_tool_errors_gets_no_free_pass(client, fake_guest, monkeypatch):
    h = _setup_admin(client)
    a = _agent(client, h)
    fake_guest.fail_tools = {"desktop.click"}
    done_no_art = [call("task_complete", {"summary": "clicked", "success": True}), done()]
    _use_provider(monkeypatch, ScriptedProvider([
        [call("desktop_type", {"text": "x"}), call("desktop_click", {"x": 1, "y": 1}), done()],
        done_no_art, done_no_art, done_no_art]))
    t = client.post(f"/api/v1/agents/{a['id']}/tasks", json={"prompt": "click"}, headers=h).json()["data"]
    t = _wait(client, t["id"], {"COMPLETED", "FAILED"})
    assert t["state"] == "FAILED"


def test_finished_task_reports_stage_timings_and_live_stages(client, fake_guest, monkeypatch):
    h = _setup_admin(client)
    a = _agent(client, h)
    fake_guest.tool_delay = 0.05
    _use_provider(monkeypatch, ScriptedProvider([
        [call("browser_navigate", {"url": "https://example.com"}), done()],
        [call("task_complete", {"summary": "ok", "success": True,
                                "artifacts": [{"type": "url", "value": "https://example.com"}]}), done()]]))
    t = client.post(f"/api/v1/agents/{a['id']}/tasks", json={"prompt": "go"}, headers=h).json()["data"]
    t = _wait(client, t["id"], {"COMPLETED", "FAILED"})
    assert t["state"] == "COMPLETED"
    tm = t["result"]["timings"]
    assert tm["model_turns"] == 2 and len(tm["model_ttft_ms"]) == 2
    assert tm["tool_ms"] >= 50  # the guest tool really took >= 50 ms
    assert tm["total_ms"] >= tm["queue_ms"] and tm["orchestration_ms"] >= 0
    for k in ("worker_allocated", "starting", "model_request", "first_model_response", "first_tool", "verifying"):
        assert k in tm["marks_ms"], k
    stages = [e["stage"] for e in _events(client, t["id"], "task.stage")]
    assert stages[0] == "starting" and "model_request" in stages and "tool" in stages and stages[-1] == "verifying"
    tool_ev = next(e for e in _events(client, t["id"], "task.stage") if e["stage"] == "tool")
    assert tool_ev["detail"] == "browser_navigate" and tool_ev["elapsed_ms"] >= 0


def test_failed_task_also_reports_timings(client, fake_guest, monkeypatch):
    h = _setup_admin(client)
    a = _agent(client, h)
    _use_provider(monkeypatch, ScriptedProvider([
        [call("task_complete", {"summary": "cannot", "success": False}), done()]]))
    t = client.post(f"/api/v1/agents/{a['id']}/tasks", json={"prompt": "go"}, headers=h).json()["data"]
    t = _wait(client, t["id"], {"COMPLETED", "FAILED"})
    assert t["state"] == "FAILED"
    for _ in range(40):  # timings are attached right after the runner ends
        t = client.get(f"/api/v1/tasks/{t['id']}").json()["data"]
        if (t.get("result") or {}).get("timings"):
            break
        time.sleep(0.05)
    assert t["result"]["timings"]["model_turns"] == 1


def test_checkpoint_keeps_only_newest_screenshot_and_owner_attachments(client, fake_guest, monkeypatch):
    from nebula_runtime.orchestrator import load_checkpoint

    h = _setup_admin(client)
    a = _agent(client, h)
    _use_provider(monkeypatch, ScriptedProvider([
        [call("desktop_screenshot", {}), done()], [call("desktop_screenshot", {}), done()],
        [call("desktop_screenshot", {}), done()],
        [call("task_complete", {"summary": "looked", "success": True}), done()]]))
    t = client.post(f"/api/v1/agents/{a['id']}/tasks", json={"prompt": "look"}, headers=h).json()["data"]
    _wait(client, t["id"], {"COMPLETED", "FAILED"})
    ck = load_checkpoint(t["id"])
    with_images = [i for i, m in enumerate(ck["messages"]) if m.get("images_b64")]
    assert len(with_images) <= 1  # was: every screenshot re-serialised on every checkpoint save


def test_window_keeps_owner_attachment_images_next_to_the_latest_screenshot():
    from nebula_providers.base import Message
    from nebula_runtime.orchestrator import TaskRunner

    r = TaskRunner.__new__(TaskRunner)
    ck = {"messages": [Message("user", "find the bug", images_b64=["ATTACHED"]).to_json(),
                       Message("tool", "{}", tool_call_id="1", tool_name="desktop_screenshot",
                               images_b64=["OLD"]).to_json(),
                       Message("tool", "{}", tool_call_id="2", tool_name="desktop_screenshot",
                               images_b64=["NEW"]).to_json()]}
    msgs = TaskRunner._window(r, ck)
    assert msgs[0].images_b64 == ["ATTACHED"] and msgs[1].images_b64 == [] and msgs[2].images_b64 == ["NEW"]


def test_screenshot_of_sleeping_desktop_answers_at_once(client, fake_guest):
    h = _setup_admin(client)
    a = _agent(client, h)
    client.post(f"/api/v1/agents/{a['id']}/sleep", headers=h)

    async def slow(*args, **kw):  # what the real guest did for a stopped desktop
        time.sleep(3)
        return {"ok": False, "error": {"code": "x", "message": "[Errno 2] No such file or directory"}}

    fake_guest.tool = slow
    t = time.perf_counter()
    r = client.get(f"/api/v1/agents/{a['id']}/screenshot")
    assert r.status_code == 409 and r.json()["error"]["code"] == "desktop_not_running"
    assert "wake the agent" in r.json()["error"]["message"] and time.perf_counter() - t < 1.0


def test_request_guard_does_not_spawn_scutil_per_request(client, monkeypatch):
    import subprocess

    from nebula_host import lan

    real = subprocess.run
    calls = []

    def spy(cmd, *a, **kw):
        if cmd and "scutil" in str(cmd[0]):
            calls.append(cmd)
        return real(cmd, *a, **kw)

    monkeypatch.setattr(lan.subprocess, "run", spy)
    monkeypatch.setattr(lan, "_mdns_cache", (0.0, None))  # restored after the test
    for _ in range(5):
        lan.mdns_name()
    assert len(calls) <= 1


def test_model_request_budget_per_task(client, fake_guest, monkeypatch):
    """max_model_calls is a hard cap on model requests, independent of the tool-step budget."""
    h = _setup_admin(client)
    a = _agent(client, h)
    prov = ScriptedProvider([[call("desktop_screenshot", {}), done()]] * 10)
    _use_provider(monkeypatch, prov)
    t = client.post(f"/api/v1/agents/{a['id']}/tasks", json={"prompt": "look", "max_steps": 30,
                                                             "max_model_calls": 2}, headers=h).json()["data"]
    t = _wait(client, t["id"], {"COMPLETED", "FAILED"})
    assert t["state"] == "FAILED" and "model request budget of 2 exhausted" in t["failure_reason"]
    assert len(prov.requests) == 2
    r = client.post(f"/api/v1/agents/{a['id']}/tasks", json={"prompt": "x", "max_model_calls": 0}, headers=h)
    assert r.status_code == 422


def test_new_task_after_released_control_starts_without_stale_reobservation(client, fake_guest, monkeypatch):
    """Live finding (scenario A): Take/Release Control on an idle agent made the NEXT, unrelated task start with a
    "the owner took manual control" note plus browser_observe (a Chromium cold start, ~9 s booked as overhead)."""
    from nebula_host.state import svc

    h = _setup_admin(client)
    a = _agent(client, h)
    svc.orch.control_holders[a["id"]] = "live-x"
    svc.orch.release_control(a["id"])  # owner looked at the idle desktop and released it
    assert a["id"] in svc.orch.needs_reobserve
    prov = ScriptedProvider([[call("task_complete", {"summary": "hi", "success": True}), done()]])
    _use_provider(monkeypatch, prov)
    fake_guest.calls.clear()
    t = client.post(f"/api/v1/agents/{a['id']}/tasks", json={"prompt": "say hi"}, headers=h).json()["data"]
    assert _wait(client, t["id"], {"COMPLETED", "FAILED"})["state"] == "COMPLETED"
    first = prov.requests[0].messages
    assert not any("took manual control" in (m.content or "") for m in first)
    assert not [c for c in fake_guest.calls if c[0] == "tool.call" and c[1]["tool"] == "browser.observe"]
    assert a["id"] not in svc.orch.needs_reobserve


def test_nebula_side_vm_calls_count_as_tool_time(client, fake_guest, monkeypatch):
    h = _setup_admin(client)
    a = _agent(client, h)
    fake_guest.tool_delay = 0.1
    _use_provider(monkeypatch, ScriptedProvider([
        [call("desktop_type", {"text": "x"}), done()],
        [call("task_complete", {"summary": "typed", "success": True}), done()]]))
    t = client.post(f"/api/v1/agents/{a['id']}/tasks", json={"prompt": "type"}, headers=h).json()["data"]
    t = _wait(client, t["id"], {"COMPLETED", "FAILED"})
    tm = t["result"]["timings"]
    # desktop_type + its evidence screenshot + the final evidence screenshot: 3 guest calls of >= 100 ms each
    assert tm["tool_ms"] >= 300 and tm["orchestration_ms"] < tm["tool_ms"]


def test_health_skips_the_vm_helper_when_the_guest_answers(client, fake_guest, monkeypatch):
    from nebula_host.guest import GuestUnavailable
    from nebula_host.state import svc

    calls = []

    async def astatus():
        calls.append(1)
        return {"state": "stopped"}

    monkeypatch.setattr(svc.vm, "astatus", astatus)
    h = client.get("/api/v1/health").json()["data"]
    assert h["vm"]["state"] == "running" and h["guest"]["status"] == "ok" and calls == []

    async def down(timeout=5):
        raise GuestUnavailable("no vsock")

    fake_guest.ping = down
    h = client.get("/api/v1/health").json()["data"]
    assert h["vm"]["state"] == "stopped" and h["guest"]["status"] == "vm_not_running" and calls == [1]
