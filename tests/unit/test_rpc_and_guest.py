"""Host<->guest RPC authentication, RFB input filter, workspace path confinement."""

from __future__ import annotations

import importlib
import os
import struct
import time

import pytest
from nebula_contracts import rpc
from nebula_live.rfb import RFBClientFilter

KEY = b"k" * 32


def test_sign_verify_roundtrip():
    f = rpc.sign(KEY, {"id": "1", "method": "ping", "params": {"a": 1}})
    body = rpc.verify(KEY, f, rpc.NonceCache())
    assert body["method"] == "ping"


def test_bad_mac_rejected():
    f = rpc.sign(b"x" * 32, {"id": "1", "method": "ping"})
    with pytest.raises(rpc.RPCAuthError, match="bad mac"):
        rpc.verify(KEY, f)


def test_tampered_params_rejected():
    f = rpc.sign(KEY, {"id": "1", "method": "workspace.delete", "params": {"agent_id": "a"}})
    f["params"]["agent_id"] = "b"
    with pytest.raises(rpc.RPCAuthError):
        rpc.verify(KEY, f)


def test_replay_rejected():
    cache = rpc.NonceCache()
    f = rpc.sign(KEY, {"id": "1", "method": "ping"})
    rpc.verify(KEY, f, cache)
    with pytest.raises(rpc.RPCAuthError, match="replayed"):
        rpc.verify(KEY, f, cache)


def test_stale_timestamp_rejected():
    f = rpc.sign(KEY, {"id": "1", "method": "ping", "ts": int(time.time()) - 1000})
    with pytest.raises(rpc.RPCAuthError, match="stale"):
        rpc.verify(KEY, f)


def test_linux_user_derivation_is_strict():
    assert rpc.linux_user_for("ab12cd34-0000-4000-8000-000000000000") == "nebula_ab12cd34"
    for bad in ("../../etc", "x; rm -rf /", "nebula_ab12cd34"):
        with pytest.raises(ValueError):
            rpc.linux_user_for(bad)
    assert rpc.is_valid_linux_user("nebula_ab12cd34")
    assert not rpc.is_valid_linux_user("nebula_AB12cd34")
    assert not rpc.is_valid_linux_user("root")


def _handshake(f: RFBClientFilter) -> bytes:
    return f.feed(b"RFB 003.008\n" + b"\x01" + b"\x01")


def test_rfb_filter_drops_input_when_read_only():
    f = RFBClientFilter()
    assert _handshake(f) == b"RFB 003.008\n\x01\x01"
    key = struct.pack(">BBxxI", 4, 1, 0x61)
    ptr = struct.pack(">BBHH", 5, 1, 10, 10)
    fbreq = struct.pack(">BBHHHH", 3, 1, 0, 0, 1280, 800)
    out = f.feed(key + ptr + fbreq)
    assert out == fbreq
    assert f.dropped == 2


def test_rfb_filter_passes_input_with_lease_and_handles_fragmentation():
    f = RFBClientFilter()
    _handshake(f)
    f.allow_input = True
    key = struct.pack(">BBxxI", 4, 1, 0x61)
    out = f.feed(key[:3])
    assert out == b""
    assert f.feed(key[3:]) == key
    enc = struct.pack(">BxH", 2, 2) + struct.pack(">ii", 0, -223)
    assert f.feed(enc) == enc
    cut = struct.pack(">BxxxI", 6, 3) + b"abc"
    assert f.feed(cut) == cut


def test_rfb_filter_unknown_message_raises():
    f = RFBClientFilter()
    _handshake(f)
    with pytest.raises(ValueError):
        f.feed(b"\x63")


@pytest.fixture()
def tools_mod(tmp_path, monkeypatch):
    ws = tmp_path / "home" / "nebula_aaaaaaaa" / "workspace"
    ws.mkdir(parents=True)
    other = tmp_path / "home" / "nebula_bbbbbbbb" / "workspace"
    other.mkdir(parents=True)
    (other / "secret.txt").write_text("B's data")
    monkeypatch.setenv("NEBULA_WORKSPACE", str(ws))
    monkeypatch.setenv("HOME", str(ws.parent))
    import nebula_guest.agent_tools as at

    at = importlib.reload(at)
    return at, ws, other


def test_confine_blocks_traversal_absolute_and_symlinks(tools_mod):
    at, ws, other = tools_mod
    assert at.confine("notes/a.txt") == (ws / "notes/a.txt").resolve()
    for bad in ("../x", "../../nebula_bbbbbbbb/workspace/secret.txt", "/etc/passwd", str(other / "secret.txt"),
                "a/\x00b"):
        with pytest.raises(at.ToolError):
            at.confine(bad)
    os.symlink(other / "secret.txt", ws / "link.txt")
    with pytest.raises(at.ToolError, match="symlink"):
        at.confine("link.txt")
    os.symlink(other, ws / "linkdir")
    with pytest.raises(at.ToolError):
        at.confine("linkdir/secret.txt")


async def test_files_write_read_and_shell_cwd(tools_mod):
    at, ws, _ = tools_mod
    r = await at.files_write({"path": "out/hello.txt", "content": "hi"})
    assert r["bytes_written"] == 2
    r = await at.files_read({"path": "out/hello.txt"})
    assert r["content"] == "hi"
    r = await at.shell_execute({"command": "pwd && echo $NEBULA_WORKSPACE", "cwd": "out"})
    assert r["exit_code"] == 0 and str(ws / "out") in r["stdout"]
    with pytest.raises(at.ToolError):
        await at.shell_execute({"command": "true", "cwd": "../.."})
    r = await at.shell_execute({"command": "sleep 5", "timeout": 1})
    assert r["timed_out"] is True
