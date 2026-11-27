# ruff: noqa: F811 - fixtures are imported from other test modules and injected by pytest
"""Release hardening of the host side (audit 03-appsec-host, 04-appsec-vm VM-01/03/07): remote roles get exactly
what the owner gave them, agent bots reach only their own agent, the in-process host file tools are race-free,
the Seatbelt network allowance never reaches this Mac's own services, plus the smaller auth fixes."""

from __future__ import annotations

import asyncio
import os
import threading
import time
import uuid
from pathlib import Path

import pytest

from tests.integration.test_api import _agent, _setup_admin, client  # noqa: F401
from tests.integration.test_v3_api import _pair_agent_bot_user, _pair_owner, _session_as, gateway  # noqa: F401
from tests.unit.test_v3_units import BOT_TOKEN, make_init_data

LOGIN = "correct horse battery"


def _mini(gateway, tg_id=7):
    r = gateway.post("/api/mini/auth", json={"init_data": make_init_data(
        BOT_TOKEN, user_id=tg_id, extra={"query_id": uuid.uuid4().hex})})
    assert r.status_code == 200, r.text
    return {"authorization": f"Bearer {r.json()['data']['token']}"}, r.json()["data"]


def _agent_bot_initdata_session(gateway, tg_id, bot_row="bot-row-1"):
    """A real agent-bot Mini App session: initData signed with that bot's own token."""
    from nebula_host import db, models
    from nebula_host import secrets as sec
    from sqlalchemy import update

    tok = "4242:" + "B" * 35
    sec.store().set("nebula:telegram.agentbot.test", tok)
    with db.engine().begin() as c:
        c.execute(update(models.telegram_bots).where(models.telegram_bots.c.id == bot_row)
                  .values(keychain_ref="nebula:telegram.agentbot.test"))
    r = gateway.post("/api/mini/auth", json={"init_data": make_init_data(
        tok, user_id=tg_id, extra={"query_id": uuid.uuid4().hex})})
    assert r.status_code == 200, r.text
    return {"authorization": f"Bearer {r.json()['data']['token']}"}, r.json()["data"]


def _task_row(agent_id: str, prompt: str) -> str:
    from nebula_host import db, models

    tid = str(uuid.uuid4())
    now = time.time()
    with db.engine().begin() as c:
        c.execute(models.tasks.insert().values(id=tid, agent_id=agent_id, prompt=prompt, state="COMPLETED",
                                               created_at=now, updated_at=now))
    return tid


# ============================================================================ H-01 / VM-01: no implicit widening
def test_operator_gets_exactly_its_stored_permissions(client, gateway):
    h = _setup_admin(client)
    a = _agent(client, h)
    _pair_owner(7)
    _pair_owner(8)  # stored permissions: ["tasks"]
    _owner_auth, owner = _mini(gateway, 7)
    assert set(owner["permissions"]) >= {"files", "approvals", "desktop", "agents"}  # the owner keeps everything
    op, data = _mini(gateway, 8)
    assert data["permissions"] == ["tasks"]
    me = gateway.get("/api/v1/miniapp/me", headers=op).json()["data"]
    assert me["role"] == "operator" and me["permissions"] == ["tasks"]
    for method, path in (("GET", "/api/v1/files/roots"), ("GET", "/api/v1/files/list?root=exchange&path=."),
                         ("POST", f"/api/v1/agents/{a['id']}/live/connect"),
                         ("POST", "/api/v1/companies"), ("POST", "/api/v1/workflows/validate")):
        r = gateway.request(method, path, headers=op, json={})
        assert r.status_code == 403 and r.json()["error"]["code"] == "forbidden", (path, r.text)
    # resolving approvals is the owner's decision only (VM-01), whatever the operator was given
    for path in ("/api/v1/approvals/x", "/api/v1/owner-approvals/x",
                 "/api/v1/smart-auth/sessions/as_" + "a" * 24 + "/token",
                 "/api/v1/smart-auth/sessions/as_" + "a" * 24 + "/submit",
                 "/api/v1/smart-auth/sessions/as_" + "a" * 24 + "/cancel"):
        r = gateway.post(path, headers=op, json={"decision": "approved"})
        assert r.status_code == 403 and r.json()["error"]["code"] == "owner_only", (path, r.text)
    # the operator may still do what it was given
    assert gateway.get("/api/v1/agents", headers=op).status_code == 200


def test_mac_folders_stay_owner_only_even_with_the_files_permission(client, gateway, tmp_path):
    from nebula_host import db, models
    from sqlalchemy import update

    h = _setup_admin(client)
    (tmp_path / "proj").mkdir()
    root = client.post("/api/v1/host/roots", json={"path": str(tmp_path / "proj")}, headers=h).json()["data"]
    _pair_owner(7)
    _pair_owner(8)
    with db.engine().begin() as c:  # the owner gave this operator `files` (for the agents' workspaces)
        c.execute(update(models.telegram_users).where(models.telegram_users.c.telegram_user_id == 8)
                  .values(permissions=["tasks", "files"]))
    op, _ = _mini(gateway, 8)
    ids = {r["id"] for r in gateway.get("/api/v1/files/roots", headers=op).json()["data"]}
    assert "exchange" not in ids and f"host:{root['id']}" not in ids
    for path in ("/api/v1/files/list?root=exchange&path=.", f"/api/v1/files/list?root=host:{root['id']}&path=.",
                 f"/api/v1/files/download?root=host:{root['id']}&path=.env"):
        r = gateway.get(path, headers=op)
        assert r.status_code == 403 and r.json()["error"]["code"] == "owner_only", (path, r.text)
    owner, _ = _mini(gateway, 7)
    ids = {r["id"] for r in gateway.get("/api/v1/files/roots", headers=owner).json()["data"]}
    assert {"exchange", f"host:{root['id']}"} <= ids
    assert gateway.get("/api/v1/files/list?root=exchange&path=.", headers=owner).status_code == 200


def test_approval_resolution_needs_a_fresh_owner_for_vault_and_host(client, gateway):
    from nebula_host import db, models

    h = _setup_admin(client)
    a = _agent(client, h)
    _pair_owner(7)
    owner, _ = _mini(gateway, 7)
    now = time.time()
    tid = _task_row(a["id"], "sign in")
    with db.engine().begin() as c:
        for aid, tool, reason in (("ap-vault", "vault_sign_in", "credential_entry"),
                                  ("ap-plain", "browser_click", "outbound_message")):
            c.execute(models.approvals.insert().values(id=aid, task_id=tid, agent_id=a["id"], tool=tool,
                                                       action_summary="x", reason=reason, created_at=now,
                                                       expires_at=now + 600))
    r = gateway.post("/api/v1/approvals/ap-vault", json={"decision": "approved"}, headers=owner)
    assert r.status_code == 403 and r.json()["error"]["code"] == "stepup_required"
    r = gateway.post("/api/v1/approvals/ap-plain", json={"decision": "denied"}, headers=owner)
    assert r.status_code == 200, r.text  # an owner session suffices for ordinary approvals
    assert gateway.post("/api/v1/auth/stepup", json={"method": "password", "password": LOGIN},
                        headers=owner).status_code == 200
    r = gateway.post("/api/v1/approvals/ap-vault", json={"decision": "denied"}, headers=owner)
    assert r.status_code == 200 and r.json()["data"]["decision"] == "denied"
    # the dashboard on this Mac is the owner (fresh by presence)
    from nebula_host import approvals_v2

    oid = approvals_v2.request("command", {"x": 1}, "run a command")
    assert client.post(f"/api/v1/owner-approvals/{oid}", json={"decision": "denied"}, headers=h).status_code == 200


def test_agent_bot_users_get_the_fixed_small_set(client, gateway):
    from nebula_host import miniapp

    h = _setup_admin(client)
    a = _agent(client, h)
    _pair_owner(7)
    _pair_agent_bot_user(a["id"], 9)  # a third party approved on the agent's bot
    auth, data = _agent_bot_initdata_session(gateway, 9)
    assert data["permissions"] == sorted(miniapp.AGENT_BOT_PERMISSIONS)
    assert "approvals" not in data["permissions"] and "files" not in data["permissions"]


# ============================================================================ H-02: agent bots reach only their agent
def test_agent_bot_is_deny_by_default_and_scoped_by_path_query_and_body(client, gateway):
    from nebula_host import db, models

    h = _setup_admin(client)
    mine = _agent(client, h, name="Mine")
    other = _agent(client, h, name="Other")
    _pair_owner(7)
    _pair_agent_bot_user(mine["id"], 9)
    auth, _ = _agent_bot_initdata_session(gateway, 9)
    t_mine, t_other = _task_row(mine["id"], "mine task"), _task_row(other["id"], "other task")
    # list routes are filtered to the bot's agent
    tasks = gateway.get("/api/v1/tasks", headers=auth).json()["data"]
    assert {t["id"] for t in tasks} == {t_mine}
    agents = gateway.get("/api/v1/agents", headers=auth).json()["data"]
    assert [x["id"] for x in agents] == [mine["id"]]
    # an agent query for another agent is refused by the central gate (method + query are checked there)
    r = gateway.get(f"/api/v1/conversations?agent_id={other['id']}", headers=auth)
    assert r.status_code == 403 and r.json()["error"]["code"] == "not_your_agent", r.text
    convs = gateway.get("/api/v1/conversations", headers=auth).json()["data"]
    assert all(c["agent_id"] == mine["id"] for c in convs)
    # body: never a conversation with another agent
    r = gateway.post("/api/v1/conversations", json={"agent_id": other["id"]}, headers=auth)
    assert r.status_code == 403 and r.json()["error"]["code"] == "not_your_agent"
    assert gateway.post("/api/v1/conversations", json={"agent_id": mine["id"]}, headers=auth).status_code == 201
    # path: other agents' tasks, attachments and screenshots
    assert gateway.get(f"/api/v1/tasks/{t_other}", headers=auth).json()["error"]["code"] == "not_your_agent"
    assert gateway.get(f"/api/v1/tasks/{t_mine}", headers=auth).status_code == 200
    now = time.time()
    with db.engine().begin() as c:
        c.execute(models.attachments.insert().values(
            id="att-other", source="web", agent_id=other["id"], kind="text", mime="text/plain", name="x.txt",
            size=1, sha256="0" * 64, storage="x/x.txt", status="PROCESSED", extracted={}, created_at=now))
    assert gateway.get("/api/v1/attachments/att-other", headers=auth).json()["error"]["code"] == "not_your_agent"
    r = gateway.get(f"/api/v1/artifacts/{other['id']}/{t_other}/1.png", headers=auth)
    assert r.json()["error"]["code"] == "not_your_agent"
    # deny by default: everything that is not on the allowlist, whatever the policy says
    for method, path in (("GET", "/api/v1/approvals"), ("GET", "/api/v1/approval-center"),
                         ("GET", "/api/v1/owner-approvals"), ("GET", "/api/v1/conversations/search?q=x"),
                         ("GET", "/api/v1/files/roots"), ("GET", f"/api/v1/files/list?root=agent:{other['id']}"),
                         ("GET", "/api/v1/notifications"), ("GET", "/api/v1/smart-auth/sessions"),
                         ("GET", "/api/v1/vault/entries"), ("GET", "/api/v1/workflows"),
                         ("POST", "/api/v1/workflows/x/run"), ("POST", "/api/v1/teams/x/runs"),
                         ("GET", f"/api/v1/agents/{mine['id']}/memory"), ("GET", "/api/v1/overview")):
        r = gateway.request(method, path, headers=auth, json={})
        assert r.status_code == 403, (method, path, r.text)
        assert r.json()["error"]["code"] in ("not_available_to_agent_bot", "owner_only", "forbidden"), path


def test_check_ownership_allowlist_units():
    from nebula_host import authz

    assert "/events" in authz.AGENT_BOT_ROUTES and "/approvals/{approval_id}" not in authz.AGENT_BOT_ROUTES
    # every allowlisted template is a real route
    known = {k.split(" ", 1)[1] for k in authz.POLICY}
    assert authz.AGENT_BOT_ROUTES <= known
    # nothing on the allowlist is an administration route reachable without the owner check
    for key, pol in authz.POLICY.items():
        if key.split(" ", 1)[1] in authz.AGENT_BOT_ROUTES:
            assert pol in ("read", "op:tasks", "op:commands", "op:screenshot", "op:desktop", "admin", "admin!"), key


async def test_events_stream_is_filtered_for_agent_bots(client):
    from nebula_host import authz
    from nebula_host.api import routes
    from nebula_host.events import bus
    from starlette.requests import Request

    h = _setup_admin(client)
    mine = _agent(client, h, name="Mine")
    other = _agent(client, h, name="Other")
    _pair_agent_bot_user(mine["id"], 9)
    bus.publish("task.completed", {"summary": "MINE-EVENT"}, agent_id=mine["id"])
    bus.publish("task.completed", {"summary": "OTHER-EVENT"}, agent_id=other["id"])
    bus.publish("vm.state.changed", {"state": "GLOBAL-EVENT"})

    async def receive():
        return {"type": "http.disconnect"}

    async def body(ctx):
        req = Request({"type": "http", "method": "GET", "path": "/api/v1/events", "headers": [],
                       "query_string": b""}, receive)
        tok = authz.set_current(ctx)
        try:
            resp = await routes.events(req, since=0, p=None)
        finally:
            authz.reset_current(tok)
        out = ""
        async for chunk in resp.body_iterator:
            out += chunk if isinstance(chunk, str) else chunk.decode()
        return out

    bot = authz.Ctx("miniapp", "agent_bot", frozenset({"tasks"}), None, "s", 9, "bot-row-1")
    text = await body(bot)
    assert "MINE-EVENT" in text and "OTHER-EVENT" not in text and "GLOBAL-EVENT" not in text
    owner_text = await body(None)  # the dashboard / owner sees everything
    assert "OTHER-EVENT" in owner_text and "GLOBAL-EVENT" in owner_text


# ============================================================================ M-01 / M-02: revocation and owner
def test_revoking_ends_open_sessions_and_never_promotes_an_operator(client, gateway):
    from nebula_host import db, models
    from sqlalchemy import select

    h = _setup_admin(client)
    a = _agent(client, h)
    _pair_owner(7)
    _pair_owner(8)
    owner, _ = _mini(gateway, 7)
    op, _ = _mini(gateway, 8)
    assert gateway.get("/api/v1/miniapp/me", headers=owner).json()["data"]["role"] == "owner"
    with db.engine().connect() as c:
        rows = {r.telegram_user_id: r.id for r in c.execute(select(models.telegram_users.c.id,
                                                                   models.telegram_users.c.telegram_user_id))}
    # M-02: revoking the owner's pairing leaves NO owner; the operator stays an operator
    assert client.post(f"/api/v1/telegram/users/{rows[7]}/revoke", headers=h).status_code == 200
    assert gateway.get("/api/v1/agents", headers=owner).status_code == 401  # M-01: the session ended at once
    me = gateway.get("/api/v1/miniapp/me", headers=op).json()["data"]
    assert me["role"] == "operator" and me["admin"] is False
    assert gateway.get("/api/v1/settings", headers=op).json()["error"]["code"] == "owner_only"
    st = client.get("/api/v1/telegram", headers=h).json()["data"]
    assert st["owner_telegram_user_id"] is None and st["designated_owner_telegram_user_id"] == 7
    # the owner designates the account explicitly on the Dashboard (fresh owner action)
    r = client.post(f"/api/v1/telegram/pairing/{rows[8]}/approve", json={"owner": True}, headers=h)
    assert r.status_code == 200, r.text
    assert gateway.get("/api/v1/miniapp/me", headers=op).json()["data"]["role"] == "owner"
    # M-01 for agent bots: revoking the user on the bot ends its sessions too
    _pair_agent_bot_user(a["id"], 9)
    bot_auth, _ = _agent_bot_initdata_session(gateway, 9)
    assert gateway.get(f"/api/v1/agents/{a['id']}", headers=bot_auth).status_code == 200
    with db.engine().connect() as c:
        urow = c.execute(select(models.telegram_bot_users.c.id).where(
            models.telegram_bot_users.c.telegram_user_id == 9)).scalar()
    r = client.post(f"/api/v1/bots/bot-row-1/users/{urow}/revoke", headers=h)
    assert r.status_code == 200, r.text
    assert gateway.get(f"/api/v1/agents/{a['id']}", headers=bot_auth).status_code == 401
    with db.engine().connect() as c:
        left = c.execute(select(models.sessions.c.id).where(
            models.sessions.c.user_agent.like("nebula-miniapp tg=9 %"))).all()
    assert left == []


def test_owner_pin_bootstrap_is_the_earliest_and_is_stable(client):
    from nebula_host import authz, db, models
    from sqlalchemy import update

    _setup_admin(client)
    _pair_owner(7)
    _pair_owner(8)
    authz.forget_owner_cache()
    assert authz.primary_owner_telegram_id() == 7
    assert authz.designated_owner_telegram_id() == 7  # pinned once, explicitly
    with db.engine().begin() as c:  # approval order changes later: the owner does not
        c.execute(update(models.telegram_users).where(models.telegram_users.c.telegram_user_id == 7)
                  .values(approved_at=time.time() + 100))
    authz.forget_owner_cache()
    assert authz.primary_owner_telegram_id() == 7


# ============================================================================ VM-07: host execution needs admin!
def test_switching_work_to_the_mac_needs_a_fresh_owner(client, gateway):
    from nebula_host import db, models
    from sqlalchemy import update

    h = _setup_admin(client)
    _pair_owner(7)
    _pair_owner(8)
    with db.engine().begin() as c:  # the owner gave this operator `companies`
        c.execute(update(models.telegram_users).where(models.telegram_users.c.telegram_user_id == 8)
                  .values(permissions=["tasks", "companies"]))
    op, _ = _mini(gateway, 8)
    owner, _ = _mini(gateway, 7)
    for body in ({"name": "Co", "default_environment": "host"}, {"name": "Co", "default_root_id": "r1"},
                 {"name": "Co", "members": [{"agent_id": "x", "environment": "host"}]}):
        r = gateway.post("/api/v1/companies", json=body, headers=op)
        assert r.status_code == 403 and r.json()["error"]["code"] == "owner_only", r.text
        r = gateway.post("/api/v1/companies", json=body, headers=owner)
        assert r.status_code == 403 and r.json()["error"]["code"] == "stepup_required", r.text
    for path in ("/api/v1/companies/x", "/api/v1/projects/x"):
        r = gateway.patch(path, json={"default_environment": "host", "environment": "host"}, headers=op)
        assert r.status_code == 403 and r.json()["error"]["code"] == "owner_only", path
    # a VM company is still fine for the operator (the guard only looks at host execution)
    r = gateway.post("/api/v1/companies", json={"name": "Co", "default_environment": "vm"}, headers=op)
    assert r.status_code != 403, r.text
    # and the dashboard owner passes the guard (the body is then validated as before)
    r = client.post("/api/v1/companies", json={"name": "Co2", "default_environment": "host",
                                               "default_root_id": "missing"}, headers=h)
    assert r.status_code != 403, r.text


# ============================================================================ H-03: race-free host file access
def _flipper(base: Path, name: str, target: Path, stop: threading.Event) -> threading.Thread:
    """What a sandboxed background process can do inside the root: swap a directory for a symlink, forever."""
    def run() -> None:
        d, tmp = base / name, base / (name + ".real")
        while not stop.is_set():
            try:
                os.rename(d, tmp) if d.is_dir() and not d.is_symlink() else None
                os.symlink(target, d)
                time.sleep(0)
                os.unlink(d)
                os.rename(tmp, d)
            except OSError:
                pass
    t = threading.Thread(target=run, daemon=True)
    t.start()
    return t


def test_safetree_refuses_symlinks_in_any_component(tmp_path):
    from nebula_host.hostexec import HostExecError, SafeTree

    root, outside = tmp_path / "root", tmp_path / "outside"
    (root / "real").mkdir(parents=True)
    outside.mkdir()
    (outside / "secret.txt").write_text("TOP-SECRET")
    os.symlink(outside, root / "link")
    t = SafeTree(root)
    for fn in (lambda: t.read(["link", "secret.txt"], 100), lambda: t.write(["link", "x.txt"], b"x"),
               lambda: t.mkdir(["link", "sub"]), lambda: t.listdir(["link"]), lambda: t.delete(["link"]),
               lambda: t.write(["link"], b"x")):
        with pytest.raises(HostExecError) as e:
            fn()
        assert e.value.code == "symlink_rejected"
    assert not (outside / "x.txt").exists() and not (outside / "sub").exists()
    os.mkfifo(root / "real" / "fifo")  # a FIFO would block the NEBULA process: refused, never opened blocking
    with pytest.raises(HostExecError) as e:
        t.read(["real", "fifo"], 10)
    assert e.value.code == "not_a_file"


def test_host_file_tools_win_no_symlink_race(client, tmp_path):
    """H-03 regression: while a directory of the root is flipped between a real directory and a symlink to a folder
    outside, the in-process (unsandboxed) host file tools never write or read outside the root."""
    from nebula_host.state import svc

    h = _setup_admin(client)
    a = _agent(client, h)
    proj = tmp_path / "proj"
    (proj / "d").mkdir(parents=True)
    r = client.post("/api/v1/host/roots", json={"path": str(proj)}, headers=h)
    assert r.status_code == 201, r.text
    root_id = r.json()["data"]["id"]
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_text("TOP-SECRET")
    (proj / "d" / "secret.txt").write_text("inside")
    stop = threading.Event()
    flip = _flipper(proj, "d", outside, stop)
    leaked = 0
    loop = asyncio.new_event_loop()
    try:
        for i in range(400):
            loop.run_until_complete(svc.host.tool(a["id"], None, root_id, "files.write",
                                                  {"path": f"d/w{i}.txt", "content": "x"}))
            rr = loop.run_until_complete(svc.host.tool(a["id"], None, root_id, "files.read",
                                                       {"path": "d/secret.txt"}))
            if rr.get("ok") and "TOP-SECRET" in rr["result"]["content"]:
                leaked += 1
    finally:
        stop.set()
        flip.join(5)
        loop.close()
    assert leaked == 0
    assert sorted(p.name for p in outside.iterdir()) == ["secret.txt"]  # nothing was ever written outside


def test_files_service_host_ops_win_no_symlink_race(dbinit, tmp_path):
    from nebula_host import files_service as fs

    cfg = dbinit
    ex = fs.exchange_dir(cfg)
    (ex / "d").mkdir()
    (ex / "d" / "a.txt").write_text("inside")
    outside = tmp_path / "outside2"
    outside.mkdir()
    (outside / "a.txt").write_text("TOP-SECRET")
    stop = threading.Event()
    flip = _flipper(ex, "d", outside, stop)
    leaked = 0
    import base64

    try:
        for i in range(400):
            for req in ({"op": "write", "path": f"d/w{i}.txt", "data_b64": base64.b64encode(b"x").decode()},
                        {"op": "mkdir", "path": f"d/m{i}"}):
                try:
                    fs._host_op(cfg, req)
                except (fs.FileError, OSError):
                    pass
            try:
                rr = fs._host_op(cfg, {"op": "read", "path": "d/a.txt"})
                if b"TOP-SECRET" in base64.b64decode(rr["data_b64"]):
                    leaked += 1
            except (fs.FileError, OSError):
                pass
    finally:
        stop.set()
        flip.join(5)
    assert leaked == 0
    assert sorted(p.name for p in outside.iterdir()) == ["a.txt"]


def test_files_service_host_ops_still_work(dbinit):
    import base64

    from nebula_host import files_service as fs

    cfg = dbinit

    def op(**req):
        return fs._host_op(cfg, req)

    op(op="mkdir", path="a/b")
    op(op="write", path="a/b/f.txt", data_b64=base64.b64encode(b"one").decode())
    op(op="write", path="a/b/f.txt", data_b64=base64.b64encode(b"two").decode(), keep_version=True)
    assert base64.b64decode(op(op="read", path="a/b/f.txt")["data_b64"]) == b"two"
    assert len(op(op="versions", path="a/b/f.txt")["versions"]) == 1
    assert [e["name"] for e in op(op="list", path="a/b")["entries"]] == ["f.txt"]
    op(op="copy", path="a/b/f.txt", dest="a")
    op(op="rename", path="a/f.txt", dest="a/g.txt")
    op(op="move", path="a/g.txt", dest="a/b")
    assert {e["name"] for e in op(op="list", path="a/b")["entries"]} == {"f.txt", "g.txt"}
    with pytest.raises(fs.FileError) as e:
        op(op="copy", path="a/b/f.txt", dest="a/b/g.txt")
    assert e.value.code == "exists"
    assert op(op="search", path=".", query="g.t")["results"][0]["path"] == "a/b/g.txt"
    assert op(op="usage", path=".")["files"] == 3  # f.txt, g.txt + one kept version
    op(op="delete", path="a", recursive=True)
    with pytest.raises(fs.FileError):
        op(op="stat", path="a")
    with pytest.raises(fs.FileError) as e:
        op(op="read", path="../x")
    assert e.value.code == "path_outside_root"


# ============================================================================ VM-03: sandbox network allowance
def test_new_roots_default_to_no_network_and_profile_denies_local_services(client, tmp_path):
    from nebula_host import hostexec

    h = _setup_admin(client)
    (tmp_path / "p").mkdir()
    r = client.post("/api/v1/host/roots", json={"path": str(tmp_path / "p")}, headers=h).json()["data"]
    assert r["allow_network"] is False
    prof = hostexec.sandbox_profile(tmp_path / "p", tmp_path / "home", read_only=False, network=True)
    assert prof.index("(allow network*)") < prof.index("(deny network-outbound (remote unix-socket))")
    assert '(deny network-outbound (remote ip "localhost:*"))' in prof
    off = hostexec.sandbox_profile(tmp_path / "p", tmp_path / "home", read_only=False, network=False)
    assert "allow network" not in off


@pytest.mark.skipif(not os.path.exists("/usr/bin/sandbox-exec"), reason="macOS Seatbelt only")
def test_selftest_proves_loopback_and_unix_sockets_are_denied_with_network_on(client, tmp_path):
    h = _setup_admin(client)
    (tmp_path / "p").mkdir()
    root = client.post("/api/v1/host/roots", json={"path": str(tmp_path / "p"), "allow_network": True},
                       headers=h).json()["data"]
    st = client.post(f"/api/v1/host/roots/{root['id']}/selftest", headers=h).json()["data"]
    probes = {p["probe"]: p for p in st["probes"]}
    assert probes["deny_loopback_tcp"]["passed"] is True, probes["deny_loopback_tcp"]
    assert probes["deny_unix_socket"]["passed"] is True, probes["deny_unix_socket"]
    assert probes["deny_keychain"]["passed"] is True


def test_selftest_uses_this_instances_keychain_service(monkeypatch):
    from nebula_host import hostexec
    from nebula_host import secrets as sec

    monkeypatch.setattr(sec, "service_name", lambda *a, **k: "dev.nebula.platform.test-x", raising=False)
    assert hostexec._keychain_service() == "dev.nebula.platform.test-x"
    monkeypatch.undo()  # the real secrets.service_name(): honours NEBULA_KEYCHAIN_SERVICE (no literal fallback)
    monkeypatch.setenv("NEBULA_KEYCHAIN_SERVICE", "dev.nebula.platform.env-x")
    assert hostexec._keychain_service() == "dev.nebula.platform.env-x"


# ============================================================================ M-03 / L-01 / L-04 / L-05
def test_oauth_callback_error_is_escaped(client):
    r = client.get("/auth/callback?error=%3Cmeta%20http-equiv%3Drefresh%20content%3D0%3Burl%3Dhttps%3A//evil%3E")
    assert r.status_code == 400 and "<meta" not in r.text and "&lt;meta" in r.text
    assert "script-src 'self'" in r.headers["content-security-policy"]


def test_vault_reauth_and_rotate_share_the_persisted_lockout(dbinit, monkeypatch):
    from nebula_host import vault as v

    monkeypatch.setattr(v, "calibrate_kdf", lambda *a, **k: {"alg": "argon2id", "salt": v.b64e(os.urandom(16)),
                                                              "time_cost": 1, "memory_kib": 8192, "parallelism": 1})
    V = v.Vault() if hasattr(v, "Vault") else v.VAULT
    V._keys = None
    V.create("right passphrase 4242", actor="t")
    if V.locked:
        V.unlock("right passphrase 4242", actor="t")
    for i in range(v.FREE_ATTEMPTS):
        with pytest.raises(v.VaultError) as e:
            V.reauth(f"wrong passphrase {i}", actor="t")
        assert e.value.code == "wrong_passphrase"
    with pytest.raises(v.VaultError) as e:
        V.reauth("right passphrase 4242", actor="t")  # locked out: even the right one waits
    assert e.value.code == "rate_limited"
    with pytest.raises(v.VaultError) as e:
        V.rotate("right passphrase 4242", "another passphrase 99", actor="t")
    assert e.value.code == "rate_limited"
    V._keys = None


def test_live_viewer_token_is_claimed_atomically(client):
    from nebula_host import db, models, remote

    a = _agent(client, _setup_admin(client))
    now = time.time()
    cols = {"id": "ls-1", "agent_id": a["id"], "viewer_session_id": "s", "token_hash": "0" * 64, "state": "CONNECTING",
            "created_at": now, "expires_at": now + 90, "control_lease": False}
    with db.engine().begin() as c:
        c.execute(models.live_sessions.insert().values(**{k: v for k, v in cols.items()
                                                          if k in models.live_sessions.c}))
    results = []

    def claim():
        try:
            remote.claim_live_session("ls-1")
            results.append("ok")
        except PermissionError:
            results.append("refused")

    ts = [threading.Thread(target=claim) for _ in range(8)]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    assert results.count("ok") == 1 and results.count("refused") == 7


def test_login_does_not_reveal_accounts_and_lan_cannot_lock_out_the_mac(client):
    from nebula_host import auth
    from nebula_host.errors import ApiError

    _setup_admin(client)
    auth._ip_attempts.clear()
    codes = {}
    for user in ("owner", "nobody-here"):
        seq = []
        for _ in range(6):
            try:
                auth.login(user, "wrong password 123", "192.168.1.50", None)
            except ApiError as e:
                seq.append(e.code)
        codes[user] = seq
        auth._ip_attempts.clear()
    assert codes["owner"] == codes["nobody-here"]  # same answers for a real and an unknown account
    assert codes["owner"][-1] == "account_locked"
    # the LAN client locked the account; the owner on this Mac still signs in
    token, info = auth.login("owner", LOGIN, "127.0.0.1", None)
    assert token and info["user"]["username"] == "owner"


# ============================================================================ L-02 / L-03 / remote access
def test_rate_limit_identity_trusts_only_the_configured_tunnel_header():
    from nebula_host.remote import trusted_client

    hdr = {"cf-connecting-ip": "1.1.1.1", "tailscale-user-login": "me@example.com",
           "x-forwarded-for": "6.6.6.6, 2.2.2.2"}
    assert trusted_client(hdr, "127.0.0.1", "none") == "127.0.0.1"
    assert trusted_client(hdr, "127.0.0.1", "cloudflared_quick") == "1.1.1.1"
    assert trusted_client(hdr, "127.0.0.1", "tailscale_serve") == "me@example.com"
    assert trusted_client(hdr, "127.0.0.1", "tailscale_funnel") == "2.2.2.2"  # the proxy-appended element
    assert trusted_client(hdr, "10.0.0.9", "cloudflared_quick") == "10.0.0.9"  # not via the tunnel: the peer


def test_unauthenticated_gateway_bodies_are_bounded(gateway):
    r = gateway.post("/api/mini/auth", content=b'{"init_data": "' + b"x" * 20000 + b'"}',
                     headers={"content-type": "application/json"})
    assert r.status_code == 413
    r = gateway.post("/api/app/pair/claim", content=b"{" + b" " * 20000 + b"}",
                     headers={"content-type": "application/json"})
    assert r.status_code in (400, 413)


class _FakeTS:
    def __init__(self, status: dict | None = None, dns: str = "mini.tail1234.ts.net") -> None:
        self.calls: list[list[str]] = []
        self.status = status or {}
        self.dns = dns

    def __call__(self, argv, **kw):
        import json
        import subprocess

        self.calls.append(list(argv))
        out = ""
        if argv[1:3] == ["serve", "status"]:
            out = json.dumps(self.status)
        elif argv[1:3] == ["status", "--json"]:
            out = json.dumps({"Self": {"DNSName": self.dns + "."}})
        return subprocess.CompletedProcess(argv, 0, out, "")


async def test_tailscale_serve_is_tailnet_only_scoped_and_never_node_wide(dbinit, monkeypatch):
    from nebula_host import db, remote

    cfg = dbinit
    mgr = remote.RemoteManager(cfg)

    async def nothing(*a, **k):
        return None

    monkeypatch.setattr(mgr, "_listen", nothing)
    monkeypatch.setattr(mgr, "_unlisten", nothing)
    monkeypatch.setattr(mgr, "tunnel_tools", lambda: {"tailscale": "/fake/tailscale", "cloudflared": None})
    fake = _FakeTS()
    monkeypatch.setattr(mgr, "_run", fake)
    # gateway default port = dashboard port + 2 when nothing is stored
    assert remote.settings()["port"] == cfg.instance.port + 2
    assert "tailscale_serve" in remote.TUNNELS and remote.RECOMMENDED_TUNNEL == "tailscale_serve"
    db.set_setting("remote", {**remote.settings(), "enabled": True})
    port = remote.settings()["port"]
    st = await mgr.start_tunnel("tailscale_serve", "owner", confirm=False)  # tailnet-only: no Internet confirm
    assert ["/fake/tailscale", "serve", "--bg", "--yes", "--https=443", f"http://127.0.0.1:{port}"] in fake.calls
    assert not any("funnel" in c for c in fake.calls)
    assert st["public_url"] == "https://mini.tail1234.ts.net" and st["tunnel"] == "tailscale_serve"
    assert st["tunnel_public"] is False
    fake.calls.clear()
    await mgr.stop_tunnel("owner")
    assert ["/fake/tailscale", "serve", "--https=443", "off"] in fake.calls
    assert not any(c[-2:] == ["--bg", "off"] or "reset" in c for c in fake.calls)  # never node-wide
    # Funnel is public: explicit confirmation, and only Funnel's ports
    with pytest.raises(ValueError):
        await mgr.start_tunnel("tailscale_funnel", "owner", confirm=False)
    db.set_setting("remote", {**remote.settings(), "tailscale_https_port": 8443})
    fake.calls.clear()
    st = await mgr.start_tunnel("tailscale_funnel", "owner", confirm=True)
    assert ["/fake/tailscale", "funnel", "--bg", "--yes", "--https=8443", f"http://127.0.0.1:{port}"] in fake.calls
    assert st["public_url"] == "https://mini.tail1234.ts.net:8443" and st["tunnel_public"] is True
    fake.calls.clear()
    await mgr.stop_tunnel("owner")
    assert ["/fake/tailscale", "funnel", "--https=8443", "off"] in fake.calls
    db.set_setting("remote", {**remote.settings(), "tailscale_https_port": 9999})
    with pytest.raises(ValueError):
        await mgr.start_tunnel("tailscale_funnel", "owner", confirm=True)
    # a port that already serves something else on the node is never replaced
    db.set_setting("remote", {**remote.settings(), "tailscale_https_port": 443})
    fake.status = {"TCP": {"443": {"HTTPS": True}},
                   "Web": {"mini.tail1234.ts.net:443": {"Handlers": {"/": {"Proxy": "http://127.0.0.1:8080"}}}}}
    fake.calls.clear()
    with pytest.raises(ValueError) as e:
        await mgr.start_tunnel("tailscale_serve", "owner", confirm=False)
    assert "already serves" in str(e.value)
    assert not any(c[1] == "serve" and "--bg" in c for c in fake.calls)


async def test_gateway_port_never_takes_the_dashboard_or_lan_ports(dbinit):
    from nebula_host import remote

    cfg = dbinit
    mgr = remote.RemoteManager(cfg)
    for port in (cfg.instance.port, cfg.lan.https_port):
        with pytest.raises(ValueError) as e:
            await mgr.configure({"port": port}, "owner")
        assert "3100" not in str(e.value) and "reserved" in str(e.value)


def test_device_pairing_qr_title_is_english():
    src = (Path(__file__).resolve().parents[2] / "apps/host-api/nebula_host/devices.py").read_text()
    assert "pair a device" in src and "spárování" not in src
