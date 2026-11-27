# ruff: noqa: F811 - the `client` fixture is imported from test_api and injected by pytest
"""V3 integration: host execution (REAL macOS sandbox-exec processes in a temp project folder), execution
environments, AI Company Mode 2.0 (mixed host/VM), Mini App gateway + initData auth, multimodal attachments API.

AI is scripted (no real model requests); the guest is the fake guest running the real guest fsop module.
"""

from __future__ import annotations

import asyncio
import os
import subprocess
import time
import uuid
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from tests.conftest import ScriptedProvider, call, done
from tests.integration.test_api import _agent, _setup_admin, _use_provider, _wait, client  # noqa: F401
from tests.unit.test_v3_units import BOT_TOKEN, make_init_data


def _until(fn, timeout=15.0, every=0.05):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        last = fn()
        if last:
            return last
        time.sleep(every)
    raise AssertionError(f"condition not met (last={last!r})")


def complete(summary="ok", artifacts=None):
    return [call("task_complete", {"summary": summary, "success": True, "artifacts": artifacts or []},
                 cid=str(uuid.uuid4())), done()]


def _root(client, h, path: Path, **kw) -> dict:
    path.mkdir(parents=True, exist_ok=True)
    r = client.post("/api/v1/host/roots", json={"path": str(path), **kw}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["data"]


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


# ====================================================================================== HOST EXECUTION
def test_host01_authorise_folder_and_reject_bad_paths(client, tmp_path):
    h = _setup_admin(client)
    root = _root(client, h, tmp_path / "Projects" / "MyApp", name="MyApp")
    assert root["path"] == str((tmp_path / "Projects" / "MyApp").resolve()) and root["mode"] == "read_write"
    assert client.post("/api/v1/host/roots", json={"path": root["path"]}, headers=h).status_code == 409
    for bad in ("/etc", "relative/dir", str(tmp_path / "missing")):
        assert client.post("/api/v1/host/roots", json={"path": bad}, headers=h).status_code in (400, 404), bad
    st = client.post(f"/api/v1/host/roots/{root['id']}/selftest", headers=h).json()["data"]
    assert st["passed"] is True, st
    tools = client.get("/api/v1/host/tools").json()["data"]
    assert tools["sandbox"] is True and tools["tools"]["git"]["available"] is True
    assert tools["gui_control"]["available"] is False
    r = client.delete(f"/api/v1/host/roots/{root['id']}", headers=h)
    assert r.status_code == 400  # confirm required
    assert client.delete(f"/api/v1/host/roots/{root['id']}?confirm=true", headers=h).status_code == 200
    assert (tmp_path / "Projects" / "MyApp").is_dir()  # revoking never deletes the folder


def test_host02_to_10_real_sandboxed_execution(client, tmp_path):
    from nebula_host.state import svc

    h = _setup_admin(client)
    a = _agent(client, h)
    proj = tmp_path / "proj"
    root = _root(client, h, proj)
    (proj / "README.md").write_text("# demo\n")
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_text("top secret")
    ex = svc.host

    def t(name, args):
        return _run(ex.tool(a["id"], "task-x", root["id"], name, args))

    # HOST-02 read authorised file
    r = t("files.read", {"path": "README.md"})
    assert r["ok"] and r["result"]["content"] == "# demo\n"
    # HOST-03 modify authorised files (verified on disk)
    assert t("files.write", {"path": "src/app.py", "content": "print(6*7)\n"})["ok"]
    assert (proj / "src/app.py").read_text() == "print(6*7)\n"
    assert t("files.edit", {"path": "src/app.py", "find": "6*7", "replace": "6*8"})["ok"]
    assert (proj / "src/app.py").read_text() == "print(6*8)\n"
    # HOST-04/05 approved tools + tests, as real macOS processes under the sandbox
    r = t("shell.execute", {"command": "python3 src/app.py && python3 -c 'import sys; print(sys.platform)'"})
    assert r["ok"] and r["result"]["exit_code"] == 0 and r["result"]["stdout"].split() == ["48", "darwin"]
    (proj / "test_app.py").write_text("def test_ok():\n    assert 1 + 1 == 2\n")
    r = t("shell.execute", {"command": "python3 -m unittest discover -p 'test_*.py' -q 2>&1; python3 -c "
                                       "\"import test_app; test_app.test_ok(); print('tests passed')\""})
    assert "tests passed" in r["result"]["stdout"]
    # HOST-06 git
    for args in (["init", "-q"], ["add", "-A"]):
        assert t("git.run", {"args": args})["result"]["exit_code"] == 0
    r = t("shell.execute", {"command": "git -c user.email=a@b.c -c user.name=NEBULA commit -qm init && git log --oneline"})
    assert r["result"]["exit_code"] == 0 and "init" in r["result"]["stdout"]
    assert not t("git.run", {"args": ["-c", "core.sshCommand=evil", "status"]})["ok"]
    st = _run(ex.git_status(root["id"]))
    assert st["repository"] is True and st["recent_commits"][0]["subject"] == "init"
    # HOST-07 unauthorised directory: the sandbox blocks reads and writes outside the project
    r = t("shell.execute", {"command": f"cat {outside}/secret.txt; echo x > {outside}/pwn.txt; "
                                       f"ls '{svc.cfg.data_dir}'"})
    assert "top secret" not in r["result"]["stdout"] and not (outside / "pwn.txt").exists()
    assert "Operation not permitted" in r["result"]["stderr"]
    from nebula_host.secrets import service_name

    r = t("shell.execute", {"command": f"security find-generic-password -s {service_name()} 2>&1; echo rc=$?"})
    assert "keychain:" not in r["result"]["stdout"]
    # HOST-08 path traversal & symlinks (file tools)
    for bad in ("../outside/secret.txt", f"{outside}/secret.txt", "/etc/hosts"):
        r = t("files.read", {"path": bad})
        assert not r["ok"] and r["error"]["code"] == "path_outside_root", bad
    os.symlink(outside / "secret.txt", proj / "link.txt")
    r = t("files.read", {"path": "link.txt"})
    assert not r["ok"] and r["error"]["code"] == "symlink_rejected"
    # HOST-09 timeout
    r = t("shell.execute", {"command": "sleep 20", "timeout": 1})
    assert r["result"]["timed_out"] is True and r["result"]["elapsed_s"] < 10
    # read-only root rejects mutations (in-process and in the sandbox)
    client.patch(f"/api/v1/host/roots/{root['id']}", json={"mode": "read_only"}, headers=h)
    r = t("files.write", {"path": "x.txt", "content": "no"})
    assert not r["ok"] and r["error"]["code"] == "read_only"
    r = t("shell.execute", {"command": "echo no > y.txt"})
    assert r["result"]["exit_code"] != 0 and not (proj / "y.txt").exists()
    # HOST-10 audit log
    log = client.get("/api/v1/host/commands", params={"root_id": root["id"]}).json()["data"]
    tools = {e["tool"] for e in log}
    assert {"shell.execute", "git.run", "files.write"} <= tools
    assert any(e["status"] == "timeout" for e in log) and any(e["status"] == "denied" for e in log)


def test_host_task_end_to_end_with_approval(client, tmp_path, monkeypatch):
    """A scripted agent task running natively on the Mac: writes code, runs it, deletes a file (owner approval)."""
    h = _setup_admin(client)
    a = _agent(client, h)
    proj = tmp_path / "MyApp"
    root = _root(client, h, proj)
    (proj / "old.txt").write_text("remove me")
    r = client.put(f"/api/v1/agents/{a['id']}/environment", json={"env": "host", "root_id": root["id"]}, headers=h)
    assert r.status_code == 200 and r.json()["data"]["effective"]["env"] == "host"
    assert not any(w.startswith(("desktop_", "browser_")) for w in r.json()["data"]["tools"])
    prov = ScriptedProvider([
        [call("files_write", {"path": "hello.py", "content": "print('hello from the mac')\n"}),
         call("shell_execute", {"command": "python3 hello.py"}), done()],
        [call("files_delete", {"path": "old.txt"}), done()],
        complete("wrote and ran hello.py", [{"type": "file", "value": "hello.py"}]),
    ])
    _use_provider(monkeypatch, prov)
    t = client.post(f"/api/v1/agents/{a['id']}/tasks", json={"prompt": "write hello.py"}, headers=h).json()["data"]
    assert t["execution"]["env"] == "host"
    _wait(client, t["id"], {"WAITING_APPROVAL"})
    ap = client.get("/api/v1/approval-center").json()["data"]["pending"][0]
    assert ap["kind"] == "task" and ap["environment"] == "host" and "files_delete" in ap["action_summary"]
    client.post(f"/api/v1/approvals/{ap['id']}", json={"decision": "approved"}, headers=h)
    done_t = _wait(client, t["id"], {"COMPLETED", "FAILED"})
    assert done_t["state"] == "COMPLETED", done_t
    res = done_t["result"]
    assert res["environment"] == "host" and res["verified_artifacts"][0]["environment"] == "host"
    assert (proj / "hello.py").exists() and not (proj / "old.txt").exists()
    tools_sent = {t.name for t in prov.requests[0].tools}
    assert "shell_execute" in tools_sent and "desktop_click" not in tools_sent
    assert "macOS" in prov.requests[0].system and str(proj.resolve()) in prov.requests[0].system
    # VM-05: no live desktop is offered for a host agent (it would show the idle VM desktop)
    assert client.post(f"/api/v1/agents/{a['id']}/live/connect", headers=h).status_code == 409


def test_mix05_environment_switch_rules(client, tmp_path, monkeypatch):
    h = _setup_admin(client)
    a = _agent(client, h)
    root = _root(client, h, tmp_path / "p")
    client.post(f"/api/v1/agents/{a['id']}/memory", json={"key": "pref", "value": "Use TypeScript"}, headers=h)
    gate = asyncio.Event()
    _use_provider(monkeypatch, ScriptedProvider([], block=gate))
    t = client.post(f"/api/v1/agents/{a['id']}/tasks", json={"prompt": "long"}, headers=h).json()["data"]
    r = client.put(f"/api/v1/agents/{a['id']}/environment", json={"env": "host", "root_id": root["id"]}, headers=h)
    assert r.status_code == 409 and r.json()["error"]["code"] == "agent_busy"
    client.post(f"/api/v1/tasks/{t['id']}/stop", json={"mode": "cancel"}, headers=h)
    _wait(client, t["id"], {"CANCELLED"})
    r = client.put(f"/api/v1/agents/{a['id']}/environment", json={"env": "host"}, headers=h)
    assert r.status_code == 409 and r.json()["error"]["code"] == "environment_not_ready"  # no folder chosen
    r = client.put(f"/api/v1/agents/{a['id']}/environment", json={"env": "host", "root_id": root["id"]}, headers=h)
    assert r.status_code == 200
    assert len(client.get(f"/api/v1/agents/{a['id']}/memory").json()["data"]) == 1  # memory preserved
    assert client.get(f"/api/v1/agents/{a['id']}").json()["data"]["permission_level"] == "ADVANCED"
    r = client.put(f"/api/v1/agents/{a['id']}/environment", json={"env": "vm"}, headers=h)
    assert r.status_code == 200 and r.json()["data"]["effective"]["env"] == "vm"
    gate.set()


# ====================================================================================== AI COMPANY
def _company(client, h, members, **kw):
    r = client.post("/api/v1/companies", json={"name": kw.pop("name", "NEBULA SOFTWARE"), "objective": "Build apps",
                                               "members": members, **kw}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["data"]


def test_company01_to_04_create_org_project_assign_and_inheritance(client, tmp_path):
    h = _setup_admin(client)
    ceo, dev, qa = (_agent(client, h, n) for n in ("CEO", "Developer", "Tester"))
    root = _root(client, h, tmp_path / "app")
    co = _company(client, h, [{"agent_id": ceo["id"], "role": "ceo"},
                              {"agent_id": dev["id"], "role": "fullstack", "environment": "host"},
                              {"agent_id": qa["id"], "role": "qa", "reports_to": ceo["id"]}],
                  default_environment="vm", roles=["ceo", "fullstack", "qa",
                                                   {"key": "growth_hacker", "title": "Growth Hacker", "stage": 60}])
    assert {r["key"] for r in co["roles"]} == {"ceo", "fullstack", "qa", "growth_hacker"}
    assert co["ceo_agent_id"] == ceo["id"] and co["workspace_dir"]
    org = client.get(f"/api/v1/companies/{co['id']}/org").json()["data"]["nodes"]
    by = {n["name"]: n for n in org}
    assert by["Tester"]["reports_to"] == ceo["id"] and by["Developer"]["reports_to"] == ceo["id"]
    assert by["Developer"]["environment"]["env"] == "host" and by["Tester"]["environment"]["env"] == "vm"
    p = client.post(f"/api/v1/companies/{co['id']}/projects", json={
        "name": "Finance app", "objective": "Personal finance", "host_root_id": root["id"],
        "milestones": [{"title": "MVP"}]}, headers=h).json()["data"]
    assert {m["agent_id"] for m in p["members"]} == {ceo["id"], dev["id"], qa["id"]}  # COMPANY-04 default assignment
    env = {m["agent_name"]: m["environment_effective"] for m in p["members"]}
    assert env["Developer"]["env"] == "host" and env["Developer"]["source"] == "member"
    assert env["Developer"]["root_id"] == root["id"]  # MIX-02 project folder inherited
    assert env["Tester"]["env"] == "vm" and env["Tester"]["source"] == "company"
    # MIX-03: project override + assignment override
    client.patch(f"/api/v1/projects/{p['id']}", json={"environment": "host", "assign": [
        {"agent_id": ceo["id"]}, {"agent_id": dev["id"]}, {"agent_id": qa["id"], "environment": "vm"}]}, headers=h)
    e = client.get(f"/api/v1/agents/{ceo['id']}/environment", params={"project_id": p["id"]}).json()["data"]["effective"]
    assert e["env"] == "host" and e["source"] == "project"
    e = client.get(f"/api/v1/agents/{qa['id']}/environment", params={"project_id": p["id"]}).json()["data"]["effective"]
    assert e["env"] == "vm" and e["source"] == "assignment" and [c["level"] for c in e["chain"]] == [
        "company", "project", "assignment"]
    # COMPANY-09 isolation: an employee cannot join a second company
    r = client.post("/api/v1/companies", json={"name": "Other", "members": [{"agent_id": dev["id"], "role": "qa"}]},
                    headers=h)
    assert r.status_code == 409 and r.json()["error"]["code"] == "agent_in_other_company"


def test_company05_to_07_mix01_ceo_plan_host_dev_vm_tester(client, tmp_path, monkeypatch, fake_guest):
    """CEO plans (company_plan tool), Developer works natively on the Mac, Tester in the VM receives the files
    through a real cross-environment transfer, CEO reviews; plan approval by the owner."""
    from nebula_host.state import svc

    svc.companies.guest = fake_guest
    h = _setup_admin(client)
    ceo, dev, qa = (_agent(client, h, n) for n in ("CEO", "Developer", "Tester"))
    root = _root(client, h, tmp_path / "landing")
    co = _company(client, h, [{"agent_id": ceo["id"], "role": "ceo"},
                              {"agent_id": dev["id"], "role": "frontend", "environment": "host"},
                              {"agent_id": qa["id"], "role": "qa", "environment": "vm"}],
                  approval_policy={"plan_approval": True, "ceo_review": True})
    p = client.post(f"/api/v1/companies/{co['id']}/projects", json={"name": "Landing", "host_root_id": root["id"]},
                    headers=h).json()["data"]
    client.post(f"/api/v1/companies/{co['id']}/knowledge", json={"kind": "requirement", "title": "Brand",
                                                                 "content": "Use the colour #6d28d9"}, headers=h)
    prov = ScriptedProvider([
        # CEO planning task
        [call("company_plan", {"summary": "build then test", "items": [
            {"role": "frontend", "title": "Build landing page", "prompt": "Create index.html"},
            {"role": "qa", "title": "Test landing page", "prompt": "Check index.html", "depends_on": [0]}]}),
         done()],
        complete("plan submitted"),
        # Developer on the Mac
        [call("files_write", {"path": "index.html", "content": "<h1 style='color:#6d28d9'>Hi</h1>"}), done()],
        complete("page built", [{"type": "file", "value": "index.html"}]),
        # Tester in the VM
        complete("page verified: heading present"),
        # CEO review
        complete("Delivered index.html, QA passed. Next: add pricing section."),
    ])
    _use_provider(monkeypatch, prov)
    run = client.post(f"/api/v1/projects/{p['id']}/runs", json={"objective": "Landing page", "planner": "ceo"},
                      headers=h).json()["data"]
    assert run["state"] == "PLANNING" and run["items"][0]["kind"] == "plan"
    _until(lambda: client.get(f"/api/v1/company-runs/{run['id']}").json()["data"]["state"] == "AWAITING_APPROVAL")
    ap = next(a for a in client.get("/api/v1/owner-approvals").json()["data"] if a["kind"] == "company_plan")
    assert "Build landing page" in ap["summary"]
    client.post(f"/api/v1/owner-approvals/{ap['id']}", json={"decision": "approved"}, headers=h)
    final = _until(lambda: (r := client.get(f"/api/v1/company-runs/{run['id']}").json()["data"])["state"] in (
        "COMPLETED", "FAILED") and r, timeout=30)
    assert final["state"] == "COMPLETED", [(i["title"], i["state"], i["result_summary"]) for i in final["items"]]
    items = {i["title"]: i for i in final["items"]}
    assert items["Build landing page"]["environment"] == "host" and items["Test landing page"]["environment"] == "vm"
    tr = items["Test landing page"]["transfers"]
    assert tr and tr[0]["ok"] and tr[0]["from_env"] == "host" and tr[0]["to_env"] == "vm"
    vm_copy = fake_guest.fs_base / f"shared-{co['workspace_dir']}" / p["vm_dir"] / "handoff"
    assert any(f.read_text().startswith("<h1") for f in vm_copy.rglob("index.html"))
    assert (tmp_path / "landing" / "index.html").exists()
    assert final["result"]["ceo_report"] is True and "pricing" in final["result"]["summary"]
    # prompts: company knowledge injected as data, transferred path given to the tester
    tester_prompt = next(r.messages[0].content for r in prov.requests if "Test landing page" in r.messages[0].content)
    assert "#6d28d9" in tester_prompt and "/handoff/" in tester_prompt
    acts = client.get(f"/api/v1/companies/{co['id']}/activity").json()["data"]
    assert {"plan", "assign", "transfer", "result", "run"} <= {a["kind"] for a in acts}
    kn = client.get(f"/api/v1/companies/{co['id']}/knowledge", params={"kind": "report"}).json()["data"]
    assert kn and "COMPLETED" in kn[0]["content"]


def test_company06_dependency_failure_retry_budget_and_restart_recovery(client, tmp_path, monkeypatch, fake_guest):
    from nebula_host.state import svc

    svc.companies.guest = fake_guest
    h = _setup_admin(client)
    dev, qa = _agent(client, h, "Dev"), _agent(client, h, "QA")
    co = _company(client, h, [{"agent_id": dev["id"], "role": "backend"}, {"agent_id": qa["id"], "role": "qa"}],
                  name="Acme")
    p = client.post(f"/api/v1/companies/{co['id']}/projects", json={"name": "API"}, headers=h).json()["data"]
    fail = [call("task_complete", {"summary": "cannot", "success": False}, cid=str(uuid.uuid4())), done()]
    _use_provider(monkeypatch, ScriptedProvider([fail, fail]))
    run = client.post(f"/api/v1/projects/{p['id']}/runs", json={"objective": "Build API", "planner": "template"},
                      headers=h).json()["data"]
    final = _until(lambda: (r := client.get(f"/api/v1/company-runs/{run['id']}").json()["data"])["state"] in (
        "COMPLETED", "FAILED") and r, timeout=20)
    items = {i["role_key"]: i for i in final["items"]}
    assert final["state"] == "FAILED" and items["backend"]["attempts"] == 2 and items["backend"]["state"] == "FAILED"
    assert items["qa"]["state"] == "SKIPPED"  # COMPANY-06 dependency
    # retry after fixing: backend succeeds, QA runs
    _use_provider(monkeypatch, ScriptedProvider([complete("fixed"), complete("qa ok")]))
    client.post(f"/api/v1/company-items/{items['backend']['id']}/retry", headers=h)
    final = _until(lambda: (r := client.get(f"/api/v1/company-runs/{run['id']}").json()["data"])["state"] == "COMPLETED"
                   and r, timeout=20)
    assert all(i["state"] == "COMPLETED" for i in final["items"])
    # budget: a run with a 1-request budget fails the second item without starting it
    _use_provider(monkeypatch, ScriptedProvider([complete("b")]))
    run2 = client.post(f"/api/v1/projects/{p['id']}/runs", json={"objective": "small", "max_model_calls": 1},
                       headers=h).json()["data"]
    f2 = _until(lambda: (r := client.get(f"/api/v1/company-runs/{run2['id']}").json()["data"])["state"] in (
        "COMPLETED", "FAILED") and r, timeout=20)
    assert f2["state"] == "FAILED" and "budget" in next(i for i in f2["items"] if i["role_key"] == "qa")["result_summary"]
    # COMPANY-08 restart recovery: a task finished while the company manager was not listening
    gate = asyncio.Event()
    _use_provider(monkeypatch, ScriptedProvider([], block=gate))
    run3 = client.post(f"/api/v1/projects/{p['id']}/runs", json={"objective": "recover"}, headers=h).json()["data"]
    item = _until(lambda: next((i for i in client.get(f"/api/v1/company-runs/{run3['id']}").json()["data"]["items"]
                                if i["state"] == "RUNNING" and i["task_id"]), None))
    from nebula_host.events import bus

    bus.remove_listener(svc.companies.on_event)  # the company manager is "down" while the task finishes
    try:
        gate.set()
        _wait(client, item["task_id"], {"COMPLETED"})
        time.sleep(0.2)
        assert client.get(f"/api/v1/company-runs/{run3['id']}").json()["data"]["items"][0]["state"] == "RUNNING"
    finally:
        bus.add_listener(svc.companies.on_event)
    _use_provider(monkeypatch, ScriptedProvider([complete("qa after restart")]))
    asyncio.run_coroutine_threadsafe(svc.companies.reconcile(), svc.orch._loop_task.get_loop()).result(10)
    final3 = _until(lambda: (r := client.get(f"/api/v1/company-runs/{run3['id']}").json()["data"])["state"] in (
        "COMPLETED", "FAILED") and r, timeout=20)
    assert final3["state"] == "COMPLETED" and final3["items"][1]["result_summary"] == "qa after restart"


# ====================================================================================== MINI APP GATEWAY
class _Bridge(httpx.AsyncBaseTransport):
    """Gateway -> main app through the main TestClient (same event loop as the app's services)."""

    def __init__(self, tc: TestClient) -> None:
        self.tc = tc

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        url = request.url.raw_path.decode()
        r = await asyncio.to_thread(self.tc.request, request.method, url, headers=dict(request.headers),
                                    content=request.content)
        return httpx.Response(r.status_code, headers={k: v for k, v in r.headers.items()
                                                      if k.lower() not in ("content-length", "content-encoding")},
                              stream=httpx.ByteStream(r.content))  # unread stream, like a real HTTP upstream


def _pair_owner(tg_id: int = 7) -> None:
    from nebula_host import db, models
    from nebula_host import secrets as sec

    sec.store().set("nebula:telegram.bot_token", BOT_TOKEN)
    with db.engine().begin() as c:
        c.execute(models.telegram_users.insert().values(id=str(uuid.uuid4()), telegram_user_id=tg_id, chat_id=tg_id,
                                                        status="approved", permissions=["tasks"], created_at=time.time()))


def _pair_agent_bot_user(agent_id: str | None, tg_id: int = 7, bot_row: str = "bot-row-1") -> None:
    """An enabled agent bot (bound to agent_id) with tg_id approved on it — what an agent bot's Mini App needs."""
    from nebula_host import db, models
    from sqlalchemy import select

    now = time.time()
    with db.engine().begin() as c:
        if c.execute(select(models.telegram_bots.c.id).where(models.telegram_bots.c.id == bot_row)).first() is None:
            c.execute(models.telegram_bots.insert().values(
                id=bot_row, agent_id=agent_id, bot_id=4000 + abs(hash(bot_row)) % 1000, keychain_ref="x",
                enabled=True, status="ACTIVE", update_offset=0, created_at=now, updated_at=now))
        c.execute(models.telegram_bot_users.insert().values(
            id=str(uuid.uuid4()), bot_row_id=bot_row, telegram_user_id=tg_id, chat_id=tg_id, status="approved",
            notify_level="important", approved_at=now, created_at=now))


def _session_as(tg_id: int, bot: str, like: str = "nebula-miniapp%") -> None:
    """Re-label open Mini App sessions as (tg_id, bot): the identity must really be approved for that bot, because
    the host re-checks it (and takes the CURRENT permissions) on every request."""
    from nebula_host import db, miniapp, models
    from sqlalchemy import update

    with db.engine().begin() as c:
        c.execute(update(models.sessions).where(models.sessions.c.user_agent.like(like))
                  .values(user_agent=f"nebula-miniapp tg={tg_id} bot={bot} perms=ignored"))
    miniapp.forget_identity_cache()


@pytest.fixture()
def gateway(client):
    from nebula_host import remote

    gw = remote.build_gateway(3199, Path("/nonexistent"), forward_client=httpx.AsyncClient(
        transport=_Bridge(client), base_url="http://127.0.0.1:3199"), listen_port=3102)
    with TestClient(gw, base_url="http://127.0.0.1:3102") as g:
        yield g


def test_mini01_to_08_auth_scope_and_unauthorised(client, gateway, monkeypatch):
    h = _setup_admin(client)
    a = _agent(client, h)
    _pair_owner(7)
    # MINI-02 invalid / MINI-03 expired / not paired
    assert gateway.post("/api/mini/auth", json={"init_data": "user=%7B%7D&hash=00"}).status_code == 401
    r = gateway.post("/api/mini/auth", json={"init_data": make_init_data(BOT_TOKEN, auth_date=int(time.time()) - 7200)})
    assert r.status_code == 401 and r.json()["error"]["code"] == "expired"
    r = gateway.post("/api/mini/auth", json={"init_data": make_init_data(BOT_TOKEN, user_id=999)})
    assert r.status_code == 403 and r.json()["error"]["code"] == "not_paired"
    # MINI-01 valid
    init = make_init_data(BOT_TOKEN)
    r = gateway.post("/api/mini/auth", json={"init_data": init})
    assert r.status_code == 200, r.text
    tok = r.json()["data"]["token"]
    assert r.json()["data"]["telegram_user"]["id"] == 7
    # replay of the same initData is refused
    assert gateway.post("/api/mini/auth", json={"init_data": init}).json()["error"]["code"] == "replayed"
    auth = {"authorization": f"Bearer {tok}"}
    me = gateway.get("/api/v1/miniapp/me", headers=auth).json()["data"]
    assert me["telegram_user_id"] == 7 and "desktop" in me["permissions"]
    # MINI-04 agents from the real backend
    agents = gateway.get("/api/v1/agents", headers=auth).json()["data"]
    assert [x["id"] for x in agents] == [a["id"]]
    # MINI-05 task creation + MINI-06 company management through the gateway
    gate = asyncio.Event()
    _use_provider(monkeypatch, ScriptedProvider([], block=gate))
    r = gateway.post(f"/api/v1/agents/{a['id']}/tasks", json={"prompt": "from Telegram"}, headers=auth)
    assert r.status_code == 201, r.text
    t = r.json()["data"]
    assert gateway.post(f"/api/v1/tasks/{t['id']}/stop", json={"mode": "cancel"}, headers=auth).status_code == 200
    r = gateway.post("/api/v1/companies", json={"name": "Mini Co", "members": [{"agent_id": a["id"], "role": "ceo"}]},
                     headers=auth)
    assert r.status_code == 201
    from nebula_host import db, models
    from sqlalchemy import select

    with db.engine().connect() as c:
        actors = [x.actor for x in c.execute(select(models.audit_events.c.actor).where(
            models.audit_events.c.action.in_(["task.create", "company.create"])))]
    assert actors and all(x == "miniapp:7" for x in actors)
    # MINI-08 unauthorised resource access
    assert gateway.get("/api/v1/agents").status_code == 401  # no token
    assert gateway.get("/api/v1/agents", headers={"authorization": "Bearer nope"}).status_code == 401
    # V3.3: the verified owner administers NEBULA from the phone (same routes, same policy as the dashboard);
    # sensitive operations need a fresh re-verification; the dashboard's own sign-in/setup is never forwarded
    for path in ("/api/v1/settings", "/api/v1/providers", "/api/v1/audit"):
        assert gateway.get(path, headers=auth).status_code == 200, path
    for method, path in (("POST", "/api/v1/host/roots"), ("POST", "/api/v1/bots"),
                         ("POST", "/api/v1/system/services/restart"), ("DELETE", f"/api/v1/agents/{a['id']}"),
                         ("PATCH", "/api/v1/remote")):
        r = gateway.request(method, path, headers=auth, json={})
        assert r.status_code == 403 and r.json()["error"]["code"] == "stepup_required", path
    for method, path in (("POST", "/api/v1/auth/login"), ("POST", "/api/v1/setup/install")):
        r = gateway.request(method, path, headers=auth, json={})
        assert r.status_code == 403 and r.json()["error"]["code"] == "not_available_remotely", path
    r = gateway.post("/api/v1/auth/stepup", json={"method": "password", "password": "wrong"}, headers=auth)
    assert r.status_code == 401 and r.json()["error"]["code"] == "wrong_password"
    r = gateway.post("/api/v1/auth/stepup", json={"method": "password", "password": "correct horse battery"},
                     headers=auth)
    assert r.status_code == 200 and r.json()["data"]["fresh_until"] > time.time()
    r = gateway.post("/api/v1/host/roots", headers=auth, json={})
    assert r.status_code != 403, r.text  # fresh now: reaches the route (which validates the body)
    # the Mini App session is useless on the dashboard port (only valid through the gateway)
    r = client.get("/api/v1/agents", headers={"cookie": f"nebula_session={tok}"})
    assert r.status_code == 401
    # permissions of a non-owner Telegram user (operator) are enforced; administration is never available to them
    _pair_owner(8)  # a second approved main-bot user: an operator with its stored permissions (tasks) only
    _session_as(8, "main")
    r = gateway.post(f"/api/v1/agents/{a['id']}/live/connect", headers=auth)
    assert r.status_code == 403 and "desktop" in r.json()["error"]["message"]
    r = gateway.get("/api/v1/settings", headers=auth)
    assert r.status_code == 403 and r.json()["error"]["code"] == "owner_only"
    _pair_agent_bot_user(a["id"], 7)  # an agent's own bot never gets administration either
    _session_as(7, "bot-row-1")
    assert gateway.get("/api/v1/vault/entries/x", headers=auth).json()["error"]["code"] == "owner_only"
    # LIVE-09: an unauthorised viewer cannot open the desktop WebSocket through the gateway
    from starlette.websockets import WebSocketDisconnect

    with pytest.raises(WebSocketDisconnect):
        with gateway.websocket_connect("/api/v1/live/ws/x?token=y&session_token=bogus") as ws:
            ws.receive_bytes()
    # revoke: the token stops working
    assert client.delete("/api/v1/miniapp/sessions", headers=h).json()["data"]["revoked"] >= 1
    assert gateway.get("/api/v1/agents", headers=auth).status_code == 401
    gate.set()


def test_monitor_notifications_capabilities_and_center(client):
    h = _setup_admin(client)
    _agent(client, h)
    for path in ("/api/v1/monitor", "/api/v1/notifications", "/api/v1/v3/capabilities", "/api/v1/approval-center",
                 "/api/v1/environments", "/api/v1/voice/status", "/api/v1/remote", "/api/v1/bots", "/api/v1/overview"):
        r = client.get(path)
        assert r.status_code == 200, (path, r.text[:300])
    csp = client.get("/api/v1/health").headers["content-security-policy"]
    assert "media-src 'self' blob:" in csp  # voice previews / attachments play from blob: URLs
    m = client.get("/api/v1/monitor").json()["data"]
    assert m["resource_profile"]["profile"] in ("ECO", "BALANCED", "PERFORMANCE") and "vm" in m["workers"]


def test_gateway_rejects_foreign_hosts_and_rate_limits(client, gateway):
    from nebula_host import db

    assert gateway.get("/healthz").json() == {"ok": True}
    assert gateway.get("/healthz", headers={"host": "evil.example"}).status_code == 421
    assert gateway.get("/api/v1/../../etc/passwd").status_code in (403, 404)
    db.set_setting("remote", {"rate_limit_per_min": 30})
    codes = [gateway.get("/healthz").status_code for _ in range(40)]
    assert 429 in codes


# ====================================================================================== MULTIMODAL API
def _png() -> bytes:
    import base64

    from tests.conftest import png_b64

    return base64.b64decode(png_b64())


def _tiny_pdf(text: str) -> bytes:
    objs = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
            None, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    stream = f"BT /F1 18 Tf 20 100 Td ({text}) Tj ET".encode()
    out = b"%PDF-1.4\n"
    offs = []
    for i, o in enumerate(objs, 1):
        offs.append(len(out))
        body = (b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream") if o is None else o.encode()
        out += b"%d 0 obj\n" % i + body + b"\nendobj\n"
    x = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1) + b"".join(b"%010d 00000 n \n" % o for o in offs)
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, x)
    return out


def test_mm01_to_08_upload_process_and_task_link(client, tmp_path, monkeypatch, fake_guest):
    import io
    import zipfile

    h = _setup_admin(client)
    a = _agent(client, h)

    def up(name, data, mime):
        return client.post(f"/api/v1/agents/{a['id']}/attachments", files={"file": (name, data, mime)}, headers=h)

    img = up("screenshot.png", _png(), "image/png")
    assert img.status_code == 201, img.text
    im = img.json()["data"]
    assert im["kind"] == "image" and im["status"] == "PROCESSED" and im["extracted"]["width"] == 64
    thumb = client.get(f"/api/v1/attachments/{im['id']}/content", params={"derived": "derived/model.jpg"})
    assert thumb.status_code == 200 and thumb.content[:3] == b"\xff\xd8\xff"  # re-encoded JPEG (metadata stripped)
    pdf = up("spec.pdf", _tiny_pdf("NEBULA specification 42"), "application/pdf").json()["data"]
    assert pdf["kind"] == "pdf" and "NEBULA specification 42" in pdf["extracted"]["excerpt"] and pdf["extracted"]["pages"] == 1
    ns = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
    d = io.BytesIO()
    with zipfile.ZipFile(d, "w") as z:
        z.writestr("[Content_Types].xml", "<Types/>")
        z.writestr("word/document.xml", f"<w:document {ns}><w:body><w:p><w:r><w:t>Login requirements</w:t></w:r></w:p>"
                                        "</w:body></w:document>")
    docx = up("req.docx", d.getvalue(), "application/octet-stream").json()["data"]
    assert docx["kind"] == "docx" and "Login requirements" in docx["extracted"]["excerpt"]
    zb = io.BytesIO()
    with zipfile.ZipFile(zb, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("app/main.py", "print('hi')")
        z.writestr("../escape.py", "x")
    zz = up("project.zip", zb.getvalue(), "application/zip").json()["data"]
    assert zz["kind"] == "zip" and zz["extracted"]["archive"]["entries"] == 1
    assert zz["extracted"]["archive"]["unsafe_entries"] == ["../escape.py"]
    bomb = io.BytesIO()
    with zipfile.ZipFile(bomb, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("zeros", b"\0" * (40 * 1024 * 1024))
    bz = up("bomb.zip", bomb.getvalue(), "application/zip").json()["data"]
    assert bz["status"] == "FAILED" and "compression ratio" in bz["error"]
    csvd = up("data.csv", b"name,amount\nrent,1200\nfood,300\n", "text/csv").json()["data"]
    assert csvd["extracted"]["table"]["columns"] == ["name", "amount"]
    # MM-05 video: a real 2-second clip made with ffmpeg -> metadata + bounded frame sampling
    vid = tmp_path / "ui.mp4"
    subprocess.run(["/opt/homebrew/bin/ffmpeg", "-loglevel", "error", "-f", "lavfi", "-i",
                    "testsrc=duration=2:size=320x240:rate=10", "-pix_fmt", "yuv420p", str(vid)], check=True)
    vv = up("ui.mp4", vid.read_bytes(), "video/mp4").json()["data"]
    assert vv["kind"] == "video" and vv["status"] == "PROCESSED", vv
    assert 1.5 <= vv["extracted"]["media"]["duration_s"] <= 2.5 and vv["extracted"]["media"]["video"]["width"] == 320
    assert 1 <= len(vv["extracted"]["frames"]) <= 6
    # MM-08 unsupported / dangerous formats
    for name, data, mime in (("x.exe", b"MZ\x90\0" + b"\0" * 64, "application/octet-stream"),
                             ("blob.bin", b"\0\1\2\3" * 64, "application/octet-stream"),
                             ("fake.png", b"#!/bin/sh\nrm -rf /\n", "image/png")):
        r = up(name, data, mime)
        assert r.status_code == 415, (name, r.text)
    # MM-06 several attachments in one task + MM-07 vision honesty (scripted model has no vision)
    prov = ScriptedProvider([complete("compared")])
    _use_provider(monkeypatch, prov)
    ids = [im["id"], pdf["id"], vv["id"]]
    t = client.post(f"/api/v1/agents/{a['id']}/tasks", json={"prompt": "Compare these", "attachment_ids": ids},
                    headers=h).json()["data"]
    _wait(client, t["id"], {"COMPLETED"})
    first = prov.requests[0].messages[0].content
    assert "ATTACHMENTS" in first and "spec.pdf" in first and "NEBULA specification 42" in first
    assert "cannot see the attached images" in first and prov.requests[0].messages[0].images_b64 == []
    linked = client.get(f"/api/v1/agents/{a['id']}/attachments", params={"task_id": t["id"]}).json()["data"]
    assert {x["id"] for x in linked} == set(ids)
    img_after = client.get(f"/api/v1/attachments/{im['id']}").json()["data"]
    assert img_after["extracted"]["vision"]["used"] is False  # never claims an analysis that did not happen
    # attachments can't be reused or borrowed by another agent's task
    b = _agent(client, h, "Other")
    r = client.post(f"/api/v1/agents/{b['id']}/tasks", json={"prompt": "x", "attachment_ids": [pdf["id"]]}, headers=h)
    assert r.status_code == 400


def test_mm07_vision_capable_model_receives_images(client, monkeypatch):
    h = _setup_admin(client)
    a = _agent(client, h)
    from nebula_providers.base import ModelInfo

    class Vision(ScriptedProvider):
        async def list_models(self, account_id: str = ""):
            return [ModelInfo("m", "m", supports_images=True)]

    prov = Vision([complete("the error dialog says 404")])
    _use_provider(monkeypatch, prov)
    from nebula_host import providers_service

    providers_service._models_cache.clear() if hasattr(providers_service, "_models_cache") else None
    im = client.post(f"/api/v1/agents/{a['id']}/attachments", files={"file": ("err.png", _png(), "image/png")},
                     headers=h).json()["data"]
    t = client.post(f"/api/v1/agents/{a['id']}/tasks", json={"prompt": "Find the problem", "attachment_ids": [im["id"]]},
                    headers=h).json()["data"]
    _wait(client, t["id"], {"COMPLETED"})
    msg0 = prov.requests[0].messages[0]
    assert len(msg0.images_b64) == 1 and prov.requests[0].send_images is True
    v = client.get(f"/api/v1/attachments/{im['id']}").json()["data"]["extracted"]["vision"]
    assert v["used"] is True and "scripted" in v["model"] or "ollama" in v["model"]
