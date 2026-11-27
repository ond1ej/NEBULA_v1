"""Fix round (key: hostexec): VM-08 whole-command allow-list for shell_execute AND process_start, the H-03 hard-link
variant, the instance's Keychain service in the self-test, allow_network off by default in the model, the L-04 live
viewer claim vs the 5 s reaper, and the tightened Seatbelt profile (L-06 / VM-17), run under the REAL sandbox-exec.
"""

from __future__ import annotations

import asyncio
import os
import time
import uuid
from pathlib import Path

import pytest


def _run(coro):
    return asyncio.run(coro)


def _agent_row() -> str:
    from nebula_host import db, models

    aid = str(uuid.uuid4())
    now = db.now()
    with db.engine().begin() as c:
        c.execute(models.agents.insert().values(id=aid, name="A", status="ACTIVE", linux_user="nebula_" + aid[:8],
                                                provider_id="ollama-local", model_id="m", permissions=[],
                                                capabilities=[], permission_level="ADVANCED", created_at=now,
                                                updated_at=now))
    return aid


@pytest.fixture()
def host(dbinit, tmp_path):
    """A real host executor on a temp project folder (allowed tools: git only)."""
    from nebula_host import hostexec

    proj = tmp_path / "proj"
    proj.mkdir()
    (proj / "README.md").write_text("# demo\n")
    root = hostexec.add_root(dbinit, {"path": str(proj), "allowed_tools": ["git"]}, "owner")
    ex = hostexec.HostExecutor(dbinit)
    aid = str(uuid.uuid4())

    def tool(name, args, root_id=None):
        return _run(ex.tool(aid, "task-fix", root_id or root["id"], name, args))

    return {"ex": ex, "root": root, "proj": proj.resolve(), "tool": tool, "agent": aid, "cfg": dbinit}


# ============================================================================ VM-08: whole command line
@pytest.mark.parametrize("command,bad", [
    ("git status; python3 -c 'print(1)'", "python3"),
    ("git status && curl https://x.example", "curl"),
    ("git status || node -e 1", "node"),
    ("git log | awk '{print}'", "awk"),
    ("git status\nrm -rf .", "rm"),
    ("git status & python3 -c 1", "python3"),
    ("echo $(python3 -c 'print(1)')", "python3"),
    ('git status "$(python3 x.py)"', "cannot be checked"),
    ("git status `python3 x.py`", "python3"),
    ("bash -c 'git status'", "cannot be checked"),
    ("sh x.sh", "cannot be checked"),
    ("eval git status", "cannot be checked"),
])
def test_shell_execute_checks_every_program(host, command, bad):
    r = host["tool"]("shell.execute", {"command": command})
    assert r["ok"] is False and r["error"]["code"] == "tool_not_allowed", r
    assert bad in r["error"]["message"]


def test_refused_chain_never_runs_and_is_audited_as_denied(host):
    from nebula_host import db, models
    from sqlalchemy import select

    r = host["tool"]("shell.execute", {"command": "git status; python3 -c \"open('pwned.txt', 'w').write('x')\""})
    assert r["error"]["code"] == "tool_not_allowed"
    assert not (host["proj"] / "pwned.txt").exists()
    with db.engine().connect() as c:
        rows = db.rows(c.execute(select(models.host_commands).where(models.host_commands.c.tool == "shell.execute")))
    assert rows and rows[-1]["status"] == "denied"


def test_allowed_tools_and_basic_utilities_still_run(host):
    r = host["tool"]("shell.execute", {"command": "git --version | head -1 && echo ok"})
    assert r["ok"] is True and r["result"]["exit_code"] == 0, r
    assert "git version" in r["result"]["stdout"] and "ok" in r["result"]["stdout"]


def test_no_allow_list_means_no_restriction(host):
    from nebula_host import hostexec

    hostexec.update_root(host["root"]["id"], {"allowed_tools": []}, "owner")
    r = host["tool"]("shell.execute", {"command": "git --version; python3 -c 'print(6*7)'"})
    assert r["ok"] is True and "42" in r["result"]["stdout"], r


@pytest.mark.parametrize("command", [
    "python3 -c 'import time; time.sleep(5)'",
    "git --version && python3 -c 'print(1)'",
    "git --version; node -e 1",
    "git log | awk '{print}'",
    "echo $(python3 -c 1)",
    "bash -c 'sleep 5'",
])
def test_process_start_uses_the_same_allow_list(host, command):
    r = host["tool"]("process.start", {"command": command})
    assert r["ok"] is False and r["error"]["code"] == "tool_not_allowed", r
    assert host["ex"].procs == {}  # nothing was started


def test_process_start_still_starts_allowed_commands(host):
    ex, aid, rid = host["ex"], host["agent"], host["root"]["id"]

    async def go():  # one event loop for the whole background process
        r = await ex.tool(aid, "task-fix", rid, "process.start", {"command": "git --version"})
        assert r["ok"] is True, r
        out = None
        for _ in range(100):
            out = await ex.tool(aid, "task-fix", rid, "process.output", {"id": r["result"]["id"]})
            if out["ok"] and not out["result"]["running"]:
                break
            await asyncio.sleep(0.05)
        await ex.shutdown()
        return out

    out = _run(go())
    assert out["ok"] and "git version" in out["result"]["output"], out


# ============================================================================ H-03: hard links
def _link_outside(tmp_path: Path, proj: Path, name: str = "hl.txt") -> Path:
    outside = tmp_path / "outside"
    outside.mkdir(exist_ok=True)
    secret = outside / "secret.txt"
    secret.write_text("TOP-SECRET")
    os.link(secret, proj / name)  # a second name, inside the project, for a file outside it
    return secret


def test_safetree_refuses_hard_linked_files(tmp_path):
    from nebula_host.hostexec import HostExecError, SafeTree, safe_copy

    root = tmp_path / "root"
    root.mkdir()
    (root / "a.txt").write_text("inside")
    secret = _link_outside(tmp_path, root)
    t = SafeTree(root)
    for fn in (lambda: t.read(["hl.txt"], 100), lambda: t.write(["hl.txt"], b"overwritten"),
               lambda: t.write(["hl.txt"], b"appended", append=True),
               lambda: safe_copy(t, ["hl.txt"], t, ["copy.txt"], overwrite=False),
               lambda: safe_copy(t, ["a.txt"], t, ["hl.txt"], overwrite=True)):
        with pytest.raises(HostExecError) as e:
            fn()
        assert e.value.code == "hardlink_rejected"
    assert secret.read_text() == "TOP-SECRET" and not (root / "copy.txt").exists()
    os.mkdir(root / "d")
    os.link(secret, root / "d" / "inner.txt")
    with pytest.raises(HostExecError) as e:  # a directory copy refuses a hard-linked file inside it too
        safe_copy(t, ["d"], t, ["d2"], overwrite=False)
    assert e.value.code == "hardlink_rejected"
    # plain files keep working; deleting the extra name removes only that name
    assert t.read(["a.txt"], 100)[0] == b"inside"
    t.delete(["hl.txt"])
    assert secret.read_text() == "TOP-SECRET"
    assert t.read(["a.txt"], 100)[0] == b"inside"
    # a tree that does not ask for it (the NEBULA-private exchange folder) still reads such files
    assert SafeTree(root, single_link=False).read(["d", "inner.txt"], 100)[0] == b"TOP-SECRET"


def test_host_file_tools_refuse_hard_links(host, tmp_path):
    secret = _link_outside(tmp_path, host["proj"])
    for name, args in (("files.read", {"path": "hl.txt"}), ("files.write", {"path": "hl.txt", "content": "x"}),
                       ("files.write", {"path": "hl.txt", "content": "x", "append": True}),
                       ("files.edit", {"path": "hl.txt", "find": "TOP", "replace": "PWN"}),
                       ("files.copy", {"src": "hl.txt", "dst": "copy.txt"})):
        r = host["tool"](name, args)
        assert r["ok"] is False and r["error"]["code"] == "hardlink_rejected", (name, r)
    assert secret.read_text() == "TOP-SECRET"
    r = host["tool"]("files.search", {"path": ".", "contains": "TOP-SECRET"})
    assert r["ok"] and r["result"]["results"] == []  # never opened for content search
    assert host["tool"]("files.read", {"path": "README.md"})["ok"] is True


def test_files_service_host_root_refuses_hard_links_exchange_unchanged(host, tmp_path):
    from nebula_host import files_service as fs

    secret = _link_outside(tmp_path, host["proj"])
    rid = "host:" + host["root"]["id"]
    for req in ({"op": "read", "path": "hl.txt"}, {"op": "write", "path": "hl.txt", "data_b64": "eA=="},
                {"op": "copy", "path": "hl.txt", "dest": "copy.txt"}):
        with pytest.raises(fs.FileError) as e:
            fs._host_op(host["cfg"], req, rid)
        assert e.value.code == "hardlink_rejected", req
    assert secret.read_text() == "TOP-SECRET"
    ex = fs.exchange_dir(host["cfg"])
    os.link(secret, ex / "linked.txt")  # the exchange folder is private to NEBULA: behaviour unchanged
    assert fs._host_op(host["cfg"], {"op": "read", "path": "linked.txt"}, "exchange")["size"] == len("TOP-SECRET")


def test_seatbelt_refuses_to_create_a_hard_link_to_an_outside_file(host, tmp_path):
    """Proof that a sandboxed command cannot plant the link itself (Seatbelt: forbidden-link-priv)."""
    from nebula_host import hostexec

    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_text("TOP-SECRET")
    r = host["tool"]("git.run", {"args": ["--version"]})  # the sandbox works at all
    assert r["ok"] and r["result"]["exit_code"] == 0
    hostexec.update_root(host["root"]["id"], {"allowed_tools": []}, "owner")
    r = host["tool"]("shell.execute", {"command": f"ln '{outside / 'secret.txt'}' hl.txt; echo rc=$?"})
    assert r["ok"] and "rc=0" not in r["result"]["stdout"], r
    assert not (host["proj"] / "hl.txt").exists()


# ============================================================================ self-test Keychain probe
def test_selftest_keychain_probe_uses_the_instance_service(host, monkeypatch):
    from nebula_host import hostexec

    monkeypatch.setenv("NEBULA_KEYCHAIN_SERVICE", "dev.nebula.platform.fixround")
    seen: list[list[str]] = []

    async def fake_spawn(self, argv, **kw):
        seen.append(list(argv))
        return {"exit_code": 1, "stdout": "", "stderr": "", "timed_out": False}

    monkeypatch.setattr(hostexec.HostExecutor, "_spawn", fake_spawn)
    monkeypatch.setattr(hostexec, "detect_tools", lambda force=False: {})
    _run(host["ex"].selftest(host["root"]["id"]))
    assert ["/usr/bin/security", "find-generic-password", "-s", "dev.nebula.platform.fixround"] in seen
    assert not any("dev.nebula.platform" == a for argv in seen for a in argv)  # no fixed literal any more


# ============================================================================ allow_network default
def test_host_root_network_defaults_off_without_a_schema_change(dbinit, tmp_path):
    from nebula_host import db, models
    from sqlalchemy import select

    col = models.host_project_roots.c.allow_network
    assert col.server_default is None and col.default.arg is False  # Python-side default only: no migration
    now = db.now()
    with db.engine().begin() as c:  # a direct insert that does not name the column
        c.execute(models.host_project_roots.insert().values(id="r-direct", name="x", path=str(tmp_path), mode="read_write",
                                                            allowed_tools=[], enabled=True, created_by="t",
                                                            created_at=now, updated_at=now))
        row = c.execute(select(models.host_project_roots).where(models.host_project_roots.c.id == "r-direct")).first()
    assert row.allow_network is False


# ============================================================================ Seatbelt profile (L-06 / VM-17)
def test_profile_has_no_blanket_iokit_and_denies_prompt_services(tmp_path):
    from nebula_host import hostexec

    p = hostexec.sandbox_profile(tmp_path / "p", tmp_path / "h", read_only=False, network=False)
    assert "(allow iokit-open)" not in p and "(allow iokit-open-user-client (iokit-connection \"IOAccelerator\")" in p
    for svc in ("com.apple.SecurityServer", "com.apple.UNCUserNotification", "com.apple.coreservices.appleevents",
                "com.apple.nsurlsessiond", "com.apple.CoreAuthentication.daemon", "com.apple.xpc.smd"):
        assert f'(global-name "{svc}")' in p
    assert p.index("(allow mach-lookup)") < p.index("(deny mach-lookup")


def test_tightened_profile_still_runs_git_python_and_metal(host):
    """The real sandbox with the tightened profile: git and python3 work, and Metal (GPU IOKit user clients) sees
    the same device inside the sandbox as outside it."""
    import shutil
    import subprocess

    from nebula_host import hostexec

    hostexec.update_root(host["root"]["id"], {"allowed_tools": []}, "owner")
    r = host["tool"]("shell.execute", {"command": "git init -q && git --version && python3 -c "
                                                  "'import ssl, sqlite3, sys; print(sys.platform)'"})
    assert r["ok"] and r["result"]["exit_code"] == 0 and "darwin" in r["result"]["stdout"], r
    if not shutil.which("swiftc"):
        return
    (host["proj"] / "m.swift").write_text('import Metal\nprint(MTLCreateSystemDefaultDevice() == nil ? "none" : '
                                          '"gpu")\n')
    r = host["tool"]("shell.execute", {"command": "swiftc m.swift -o m 2>&1 | tail -3 && ./m", "timeout": 300})
    assert r["ok"] and r["result"]["exit_code"] == 0, r
    outside = subprocess.run([str(host["proj"] / "m")], capture_output=True, text=True, timeout=60).stdout.strip()
    assert r["result"]["stdout"].strip().splitlines()[-1] == outside, (r, outside)


# ============================================================================ L-04: claim vs reaper
class _FakeWriter:
    def __init__(self) -> None:
        self.closed = False

    def write(self, data: bytes) -> None:
        pass

    async def drain(self) -> None:
        pass

    def close(self) -> None:
        self.closed = True


class _FakeWS:
    def __init__(self) -> None:
        self.closed = None
        self.gone = asyncio.Event()

    async def close(self, code: int = 1000, reason: str = "") -> None:
        self.closed = (code, reason)
        self.gone.set()

    async def receive(self):
        await self.gone.wait()
        return {"type": "websocket.disconnect"}

    async def send_bytes(self, data: bytes) -> None:
        pass


class _SlowGuest:
    """open_vnc waits until the test lets it finish (a slow VM tunnel)."""

    def __init__(self) -> None:
        self.entered = asyncio.Event()
        self.release = asyncio.Event()
        self.writer = _FakeWriter()

    async def open_vnc(self, agent_id: str):
        self.entered.set()
        await self.release.wait()
        reader = asyncio.StreamReader()
        return reader, self.writer


async def _until(fn, timeout: float = 5.0) -> None:
    end = time.time() + timeout
    while time.time() < end:
        if fn():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("condition not met")


def _claimed(b, aid: str) -> tuple[str, dict]:
    from nebula_host import remote

    vsid = str(uuid.uuid4())
    r = b.connect(aid, vsid)
    s = b.authorize_ws(r["session_id"], r["token"], vsid)
    remote.claim_live_session(r["session_id"])  # the callers' single-use claim, unchanged (remote.py)
    return r["session_id"], s


def test_reaper_keeps_a_claimed_session_whose_tunnel_is_opening(dbinit):
    from nebula_live.broker import OPEN_GRACE_S, LiveBroker

    aid = _agent_row()

    async def go():
        b = LiveBroker(dbinit, _SlowGuest(), None)
        sid, _s = _claimed(b, aid)
        assert b.get(sid)["state"] == "VIEWING"
        await b.reap_once()  # before the fix: "VIEWING without a viewer" -> finalized at once
        assert b.get(sid)["state"] == "VIEWING"
        await b.reap_once(now=time.time() + OPEN_GRACE_S + 1)  # the WebSocket never streamed: reaped after grace
        assert b.get(sid)["state"] == "DISCONNECTED"

    _run(go())


def test_stream_survives_the_reaper_while_open_vnc_is_slow(dbinit):
    from nebula_live.broker import LiveBroker

    aid = _agent_row()

    async def go():
        guest = _SlowGuest()
        b = LiveBroker(dbinit, guest, None)
        sid, s = _claimed(b, aid)
        ws = _FakeWS()
        task = asyncio.create_task(b.stream(ws, s))
        await asyncio.wait_for(guest.entered.wait(), 5)
        for _ in range(3):
            await b.reap_once()
            assert b.get(sid)["state"] == "VIEWING"
        guest.release.set()
        await _until(lambda: sid in b.viewers)
        assert not b.is_opening(sid)
        await b.reap_once()
        assert b.get(sid)["state"] == "VIEWING" and b.active_streams()[0]["session_id"] == sid
        ws.gone.set()  # the browser goes away
        await asyncio.wait_for(task, 5)
        assert b.get(sid)["state"] == "DISCONNECTED" and sid not in b.viewers and guest.writer.closed

    _run(go())


def test_disconnect_while_opening_is_never_revived(dbinit):
    from nebula_live.broker import LiveBroker

    aid = _agent_row()

    async def go():
        guest = _SlowGuest()
        b = LiveBroker(dbinit, guest, None)
        sid, s = _claimed(b, aid)
        ws = _FakeWS()
        task = asyncio.create_task(b.stream(ws, s))
        await asyncio.wait_for(guest.entered.wait(), 5)
        await b.disconnect(sid)
        assert b.get(sid)["state"] == "DISCONNECTED"
        guest.release.set()
        await asyncio.wait_for(task, 5)
        assert b.get(sid)["state"] == "DISCONNECTED"  # the late tunnel did not set VIEWING again
        assert sid not in b.viewers and guest.writer.closed and ws.closed is not None

    _run(go())


def test_old_connecting_session_is_not_reaped_between_authorize_and_claim(dbinit):
    from nebula_host import db, models, remote
    from nebula_live.broker import LiveBroker

    aid = _agent_row()

    async def go():
        b = LiveBroker(dbinit, _SlowGuest(), None)
        vsid = str(uuid.uuid4())
        r = b.connect(aid, vsid)
        sid = r["session_id"]
        with db.engine().begin() as c:  # created 40 s ago, token still valid (TTL 90 s)
            c.execute(models.live_sessions.update().where(models.live_sessions.c.id == sid)
                      .values(created_at=time.time() - 40))
        b.authorize_ws(sid, r["token"], vsid)
        await b.reap_once()  # "CONNECTING for > 30 s" must not end a session whose WebSocket was just authorised
        assert b.get(sid)["state"] == "CONNECTING"
        remote.claim_live_session(sid)
        assert b.get(sid)["state"] == "VIEWING"

    _run(go())


def test_claim_stays_single_use(dbinit):
    from nebula_host import remote
    from nebula_live.broker import LiveBroker

    aid = _agent_row()
    b = LiveBroker(dbinit, _SlowGuest(), None)
    vsid = str(uuid.uuid4())
    r = b.connect(aid, vsid)
    b.authorize_ws(r["session_id"], r["token"], vsid)
    remote.claim_live_session(r["session_id"])
    with pytest.raises(PermissionError):
        remote.claim_live_session(r["session_id"])
    with pytest.raises(PermissionError):
        b.authorize_ws(r["session_id"], r["token"], vsid)


def test_never_opened_session_is_still_reaped(dbinit):
    from nebula_host import db, models
    from nebula_live.broker import LiveBroker

    aid = _agent_row()
    b = LiveBroker(dbinit, None, None)
    r = b.connect(aid, str(uuid.uuid4()))
    with db.engine().begin() as c:
        c.execute(models.live_sessions.update().where(models.live_sessions.c.id == r["session_id"])
                  .values(created_at=time.time() - 40))
    _run(b.reap_once())
    assert b.get(r["session_id"])["state"] == "DISCONNECTED"
