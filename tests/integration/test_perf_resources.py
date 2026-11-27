# ruff: noqa: F811 - the `client` fixture is imported from test_api and injected by pytest
"""Perf audit 2026-11-16: adaptive admission under macOS memory pressure and automatic recovery.

The live Mac showed "warning" for 30+ minutes with flat swap while every queued task waited (0 agents working). The
scheduler now admits cloud-model work under "warning" when swap is not growing and the kernel reports enough free
memory, holds local-model work, holds everything under "critical", and resumes queued work automatically.
"""

from __future__ import annotations

import time

import pytest

from tests.conftest import ScriptedProvider, call, done
from tests.integration.test_api import _agent, _setup_admin, _use_provider, _wait, client  # noqa: F401


@pytest.fixture()
def mem(monkeypatch):
    import nebula_host.vm as vm

    state = {"memory_pressure": "normal", "memory_free_percent": 50, "swap_used_mb": 1000.0}
    monkeypatch.setattr(vm, "memory_status", lambda: {**state, "swap_total_mb": 3072.0,
                                                      "memory_total_bytes": 16 << 30, "ts": time.time()})
    return state


def _cloud(client, h, name):
    """An agent on a cloud provider (auth mode != local): only those may start under "warning"."""
    from nebula_host import db, models
    from sqlalchemy import update

    a = _agent(client, h, name)
    with db.engine().begin() as c:
        c.execute(update(models.providers).where(models.providers.c.id == "openai-api").values(auth_mode="api_key"))
        c.execute(update(models.agents).where(models.agents.c.id == a["id"]).values(provider_id="openai-api"))
    return a


def _complete_turn():
    return [call("task_complete", {"summary": "ok", "success": True}), done()]


def test_normal_warning_normal_transition_resumes_queued_work(client, fake_guest, monkeypatch, mem):
    from nebula_host.state import svc

    h = _setup_admin(client)
    a = _cloud(client, h, "Cloud")
    _use_provider(monkeypatch, ScriptedProvider([_complete_turn(), _complete_turn()]))
    # NORMAL: starts immediately
    t1 = client.post(f"/api/v1/agents/{a['id']}/tasks", json={"prompt": "one"}, headers=h).json()["data"]
    assert _wait(client, t1["id"], {"COMPLETED", "FAILED"})["state"] == "COMPLETED"
    # WARNING with too little free memory: held back, with a visible reason
    mem.update(memory_pressure="warning", memory_free_percent=10)
    t2 = client.post(f"/api/v1/agents/{a['id']}/tasks", json={"prompt": "two"}, headers=h).json()["data"]
    time.sleep(2.5)
    assert client.get(f"/api/v1/tasks/{t2['id']}").json()["data"]["state"] == "QUEUED"
    assert t2["id"] in svc.orch.waiting_resources
    snap = client.get("/api/v1/resources").json()["data"]
    assert snap["limits"]["memory"]["pressure"] == "warning" and snap["limits"]["max_active_effective"] == 1
    # back to NORMAL: the queued task starts by itself (no owner action) and the reservation flag is cleared
    mem.update(memory_pressure="normal", memory_free_percent=45)
    assert _wait(client, t2["id"], {"COMPLETED", "FAILED"}, timeout=10)["state"] == "COMPLETED"
    assert t2["id"] not in svc.orch.waiting_resources


def test_warning_admits_cloud_work_while_swap_is_flat(client, fake_guest, monkeypatch, mem):
    h = _setup_admin(client)
    a = _cloud(client, h, "Cloud")
    mem.update(memory_pressure="warning", memory_free_percent=40)
    _use_provider(monkeypatch, ScriptedProvider([_complete_turn()]))
    t = client.post(f"/api/v1/agents/{a['id']}/tasks", json={"prompt": "x"}, headers=h).json()["data"]
    assert _wait(client, t["id"], {"COMPLETED", "FAILED"})["state"] == "COMPLETED"


def test_warning_holds_local_model_work(client, fake_guest, monkeypatch, mem):
    h = _setup_admin(client)
    a = _agent(client, h, "Local")  # ollama-local: a local model needs several GB of host memory
    mem.update(memory_pressure="warning", memory_free_percent=40)
    _use_provider(monkeypatch, ScriptedProvider([_complete_turn()]))
    t = client.post(f"/api/v1/agents/{a['id']}/tasks", json={"prompt": "x"}, headers=h).json()["data"]
    time.sleep(2.5)
    assert client.get(f"/api/v1/tasks/{t['id']}").json()["data"]["state"] == "QUEUED"
    mem.update(memory_pressure="normal")
    assert _wait(client, t["id"], {"COMPLETED", "FAILED"})["state"] == "COMPLETED"


def test_critical_holds_everything(client, fake_guest, monkeypatch, mem):
    h = _setup_admin(client)
    a = _cloud(client, h, "Cloud")
    mem.update(memory_pressure="critical", memory_free_percent=60)
    _use_provider(monkeypatch, ScriptedProvider([_complete_turn()]))
    t = client.post(f"/api/v1/agents/{a['id']}/tasks", json={"prompt": "x"}, headers=h).json()["data"]
    time.sleep(2.5)
    assert client.get(f"/api/v1/tasks/{t['id']}").json()["data"]["state"] == "QUEUED"


def test_cancelled_waiting_task_releases_its_reservation(client, fake_guest, monkeypatch, mem):
    from nebula_host.state import svc

    h = _setup_admin(client)
    a = _cloud(client, h, "Cloud")
    mem.update(memory_pressure="critical")
    _use_provider(monkeypatch, ScriptedProvider([_complete_turn()]))
    t = client.post(f"/api/v1/agents/{a['id']}/tasks", json={"prompt": "x"}, headers=h).json()["data"]
    time.sleep(2.5)
    assert t["id"] in svc.orch.waiting_resources
    client.post(f"/api/v1/tasks/{t['id']}/stop", json={"mode": "cancel"}, headers=h)
    time.sleep(2.5)
    assert client.get(f"/api/v1/tasks/{t['id']}").json()["data"]["state"] == "CANCELLED"
    assert t["id"] not in svc.orch.waiting_resources


# --------------------------------------------------------------------------------------------- unit level
def _rm(dbinit, monkeypatch, state):
    from types import SimpleNamespace

    import nebula_host.vm as vm
    from nebula_host.resources import ResourceManager

    woke = []
    orch = SimpleNamespace(wake=SimpleNamespace(set=lambda: woke.append(1)), workers={}, waiting_resources=set())
    monkeypatch.setattr(vm, "memory_status", lambda: {**state, "swap_total_mb": 3072.0,
                                                      "memory_total_bytes": 16 << 30, "ts": time.time()})
    return ResourceManager(dbinit, orch, None), woke


def test_admission_rules(dbinit, monkeypatch):
    state = {"memory_pressure": "normal", "memory_free_percent": 50, "swap_used_mb": 1000.0}
    rm, woke = _rm(dbinit, monkeypatch, state)
    monkeypatch.setattr(rm, "_kind", lambda pid: "local" if pid == "ollama-local" else "cloud")
    assert rm.admission("vm", "openai-api") == (True, "")
    state.update(memory_pressure="warning", memory_free_percent=40)
    assert rm.admission("vm", "openai-api")[0] is True
    ok, why = rm.admission("vm", "ollama-local")
    assert not ok and "local model" in why
    state.update(memory_free_percent=10)
    ok, why = rm.admission("host", "openai-api")
    assert not ok and "10% free" in why
    state.update(memory_pressure="critical", memory_free_percent=60)
    assert rm.admission("vm", "openai-api")[0] is False
    # recovery to normal wakes the scheduler so queued work starts at once
    state.update(memory_pressure="normal")
    rm.admission("vm", "openai-api")
    assert woke


def test_admission_holds_while_swap_grows(dbinit, monkeypatch):
    state = {"memory_pressure": "warning", "memory_free_percent": 40, "swap_used_mb": 1000.0}
    rm, _ = _rm(dbinit, monkeypatch, state)
    monkeypatch.setattr(rm, "_kind", lambda pid: "cloud")
    now = time.time()
    rm._swap_hist.extend([(now - 90, 1000.0), (now - 30, 1700.0)])
    state["swap_used_mb"] = 1700.0
    ok, why = rm.admission("vm", "openai-api")
    assert not ok and "swap grew 700 MB" in why
    # samples older than the window no longer count: flat swap admits again
    rm._swap_hist.clear()
    rm._swap_hist.extend([(now - 600, 1000.0), (now - 20, 1700.0)])
    assert rm.admission("vm", "openai-api")[0] is True
    # the owner can tune the thresholds
    from nebula_host import db

    rm._swap_hist.extend([(time.time(), 1900.0)])
    db.set_setting("resources.warning_max_swap_growth_mb", 1000)
    assert rm.admission("vm", "openai-api")[0] is True


def test_host_concurrency_is_one_under_pressure(dbinit, monkeypatch):
    state = {"memory_pressure": "normal", "memory_free_percent": 50, "swap_used_mb": 1000.0}
    rm, _ = _rm(dbinit, monkeypatch, state)
    rm.set_profile("PERFORMANCE")
    rm.memory()
    assert rm.host_limit() == 3
    state.update(memory_pressure="warning")
    rm.memory()
    assert rm.host_limit() == 1 and rm.limits()["max_active_effective"] == 1
    state.update(memory_pressure="normal")
    rm.memory()
    assert rm.host_limit() == 3


def test_memory_status_reads_the_kernel():
    """Real call on the Mac running the tests (no subprocess): sane values and fast."""
    import platform

    import nebula_host.vm as vm

    if platform.system() != "Darwin":
        pytest.skip("macOS only")
    real = vm._kernel_memory_status
    t = time.perf_counter()
    for _ in range(100):
        st = real()
    per_call_ms = (time.perf_counter() - t) * 10
    assert st["memory_pressure"] in ("normal", "warning", "critical")
    assert 0 <= st["memory_free_percent"] <= 100 and st["memory_total_bytes"] > 1 << 30
    assert per_call_ms < 2.0


def test_host_resources_in_process_and_vm_footprint(tmp_path):
    """Real call on the Mac running the tests: no subprocess, fast, and the VM footprint when a VM is running."""
    import platform
    import subprocess

    import nebula_host.resources as res
    import nebula_host.vm as vm

    if platform.system() != "Darwin":
        pytest.skip("macOS only")
    real_status = vm._kernel_memory_status
    orig = vm.memory_status
    vm.memory_status = real_status
    spawned = []
    real_run = subprocess.run
    subprocess.run = lambda *a, **kw: spawned.append(a) or real_run(*a, **kw)
    try:
        vm._real_host_resources(tmp_path)
        t = time.perf_counter()
        r = vm._real_host_resources(tmp_path)
        dt = (time.perf_counter() - t) * 1000
        assert spawned == []  # sysctl / host_statistics64 / libproc, no subprocess
        res.host_cpu_percent()  # the very first call may fall back to ps (no previous tick sample yet)
        time.sleep(0.3)  # kernel CPU ticks advance in 10 ms steps
        spawned.clear()
        cpu = res.host_cpu_percent()
        assert spawned == []
    finally:
        subprocess.run = real_run
        vm.memory_status = orig
    assert dt < 20
    assert r["memory_total_bytes"] > 1 << 30 and 0 < r["memory_available_bytes"] < r["memory_total_bytes"]
    assert r["memory_pressure"] in ("normal", "warning", "critical")
    if r["vm_footprint_bytes"] is not None:  # a VM is running on this Mac: footprint >> ps RSS
        assert r["vm_footprint_bytes"] >= r["vm_resident_bytes"]
    assert cpu is None or 0.0 <= cpu <= 100.0


def test_host_resources_uses_ps_only_when_libproc_cannot_answer(tmp_path, monkeypatch):
    """No VM running (libproc answered) -> no `ps`; libproc unavailable -> the `ps` RSS fallback is used."""
    import subprocess

    import nebula_host.vm as vm

    calls = []

    def fake_run(argv, *a, **kw):
        calls.append(argv)
        return subprocess.CompletedProcess(argv, 0, stdout="2048 /System/Library/Frameworks/Virtualization.framework/"
                                                           "com.apple.Virtualization.VirtualMachine\n10 /bin/zsh\n")

    monkeypatch.setattr(vm.subprocess, "run", fake_run)
    monkeypatch.setattr(vm, "vm_footprint", lambda: (True, None))
    r = vm._real_host_resources(tmp_path)
    assert r["vm_resident_bytes"] == 0 and r["vm_footprint_bytes"] is None
    assert not any(c[0] == "/bin/ps" for c in calls)
    monkeypatch.setattr(vm, "vm_footprint", lambda: (False, None))
    r = vm._real_host_resources(tmp_path)
    assert ["/bin/ps", "-axo", "rss=,comm="] in calls and r["vm_resident_bytes"] == 2048 * 1024
    assert r["vm_footprint_bytes"] is None


def test_pressure_drill_defers_and_resumes(client, fake_guest, monkeypatch, mem):
    """The controlled test interface used for scenario G on the live Mac: a simulated pressure state queues new
    work, ending the drill resumes it, and a drill can never relax real pressure."""
    from nebula_host.state import svc

    h = _setup_admin(client)
    a = _cloud(client, h, "Cloud")
    _use_provider(monkeypatch, ScriptedProvider([_complete_turn()]))
    assert client.post("/api/v1/resources/simulate", json={"pressure": "normal"}, headers=h).status_code == 422
    r = client.post("/api/v1/resources/simulate", json={"pressure": "critical", "minutes": 1}, headers=h).json()["data"]
    assert r["simulated"] == "critical" and r["effective_pressure"] == "critical"
    t = client.post(f"/api/v1/agents/{a['id']}/tasks", json={"prompt": "x"}, headers=h).json()["data"]
    time.sleep(2.5)
    assert client.get(f"/api/v1/tasks/{t['id']}").json()["data"]["state"] == "QUEUED"
    assert t["id"] in svc.orch.waiting_resources
    client.post("/api/v1/resources/simulate", json={"pressure": None}, headers=h)
    assert _wait(client, t["id"], {"COMPLETED", "FAILED"})["state"] == "COMPLETED"
    # real critical pressure is never hidden by a milder drill
    mem.update(memory_pressure="critical")
    r = client.post("/api/v1/resources/simulate", json={"pressure": "warning"}, headers=h).json()["data"]
    assert r["effective_pressure"] == "critical"
    client.post("/api/v1/resources/simulate", json={"pressure": None}, headers=h)


def test_event_stream_replays_current_stage_to_new_subscribers(client, fake_guest, monkeypatch, mem):
    """A dashboard / Mini App opened while a task waits shows WHY at once (live check: the chat only said
    "Waiting in the queue" because the stage event had been published before the page loaded)."""
    import json as _json

    h = _setup_admin(client)
    a = _cloud(client, h, "Cloud")
    mem.update(memory_pressure="critical")
    _use_provider(monkeypatch, ScriptedProvider([_complete_turn()]))
    t = client.post(f"/api/v1/agents/{a['id']}/tasks", json={"prompt": "x"}, headers=h).json()["data"]
    time.sleep(2.5)
    seen = []
    with client.stream("GET", "/api/v1/events") as s:
        buf = ""
        for chunk in s.iter_text():
            buf += chunk
            if "task.stage" in buf:
                break
    for block in buf.split("\n\n"):
        data = [ln[6:] for ln in block.splitlines() if ln.startswith("data: ")]
        if data and "event: task.stage" in block:
            assert not any(ln.startswith("id:") for ln in block.splitlines())  # never moves the resume point
            seen.append(_json.loads(data[0]))
    ev = next(e for e in seen if e["task_id"] == t["id"])
    assert ev["payload"]["stage"] == "waiting_for_resources" and "critical" in ev["payload"]["detail"]
    assert ev["sequence"] is None and ev["replay"] is True
    mem.update(memory_pressure="normal")
    assert _wait(client, t["id"], {"COMPLETED", "FAILED"})["state"] == "COMPLETED"
    from nebula_runtime.orchestrator import live_stage_snapshot

    assert all(s["task_id"] != t["id"] for s in live_stage_snapshot())  # finished tasks are not replayed
