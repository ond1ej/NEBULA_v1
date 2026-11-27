"""NEBULA guest service (root, systemd). Listens ONLY on virtio-vsock — no TCP port is opened.

  vsock :7000  authenticated JSON-lines RPC (HMAC-SHA256, timestamp, nonce anti-replay)
  vsock :7001  authenticated VNC tunnel: one signed hello frame, then raw RFB bytes to the
               selected agent's Xvnc unix socket (never any other agent's).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import platform
import socket
import sys
import time
from pathlib import Path
from typing import Any

from nebula_contracts import rpc

from nebula_guest import v2ops as v2
from nebula_guest import vaultops
from nebula_guest import workspace as ws
from nebula_guest.peersock import SocketTrustError, connect_trusted
from nebula_guest.toolclient import agent_uid, call_tool

VERSION = "0.1.0"
KEY_PATH = Path(os.environ.get("NEBULA_RPC_KEY", "/etc/nebula/rpc.key"))
RPC_PORT = int(os.environ.get("NEBULA_RPC_PORT", "7000"))
VNC_PORT = int(os.environ.get("NEBULA_VNC_PORT", "7001"))
STARTED = time.time()
log = logging.getLogger("nebula-guest")
NONCES = rpc.NonceCache()


def load_key() -> bytes:
    data = KEY_PATH.read_bytes().strip()
    return bytes.fromhex(data.decode())


KEY: bytes = b""


def meminfo() -> dict[str, int]:
    out = {}
    for line in Path("/proc/meminfo").read_text().splitlines():
        k, v = line.split(":", 1)
        if k in ("MemTotal", "MemAvailable", "SwapTotal", "SwapFree"):
            out[k] = int(v.split()[0]) * 1024
    return out


def provisioned_version() -> str | None:
    p = Path("/var/lib/nebula/provisioned")
    return p.read_text().strip() if p.exists() else None


def root_fs_writable() -> bool:
    for line in Path("/proc/mounts").read_text().splitlines():
        parts = line.split()
        if len(parts) > 3 and parts[1] == "/":
            return "rw" in parts[3].split(",")
    return False


async def m_ping(p: dict[str, Any]) -> dict[str, Any]:
    return {"pong": True, "version": VERSION, "hostname": platform.node(), "kernel": platform.release(),
            "uptime_s": round(time.time() - STARTED, 1), "loadavg": os.getloadavg(), "mem": meminfo(),
            "provisioned": provisioned_version(), "root_fs_writable": root_fs_writable()}


async def m_system_info(p: dict[str, Any]) -> dict[str, Any]:
    return {**(await m_ping(p)), "disk": await asyncio.to_thread(ws.disk_usage), "workspaces": ws.list_workspaces()}


async def m_tool_call(p: dict[str, Any]) -> dict[str, Any]:
    a = ws.get_agent(p.get("agent_id", ""))
    tool = p.get("tool")
    if not isinstance(tool, str):
        raise ws.WorkspaceError("invalid_argument", "tool required")
    timeout = float(p.get("timeout", 120))
    try:
        res = await asyncio.to_thread(call_tool, a["linux_user"], tool, p.get("args") or {}, min(timeout + 10, 700))
    except SocketTrustError as e:
        log.warning("refused tool socket of %s: %s", a["linux_user"], e)
        raise ws.WorkspaceError("tool_socket_untrusted", f"the agent's tool socket failed the ownership check: {e}") from e
    return res  # {"ok":..., "result"/"error"} forwarded verbatim


async def m_rotate_key(p: dict[str, Any]) -> dict[str, Any]:
    global KEY
    new = p.get("new_key_hex", "")
    if not isinstance(new, str) or len(new) != 64:
        raise ws.WorkspaceError("invalid_argument", "new_key_hex must be 32 bytes hex")
    bytes.fromhex(new)
    tmp = KEY_PATH.with_suffix(".tmp")
    tmp.write_text(new)
    os.chmod(tmp, 0o600)
    os.replace(tmp, KEY_PATH)
    KEY = bytes.fromhex(new)
    return {"rotated": True}


def _thread(fn):
    async def inner(p: dict[str, Any]) -> Any:
        return await asyncio.to_thread(fn, p)
    return inner


METHODS = {
    "ping": m_ping,
    "system.info": m_system_info,
    "workspace.create": _thread(lambda p: ws.create_workspace(p.get("agent_id", ""), p.get("geometry", "1280x800"),
                                                              int(p.get("quota_mb", ws.DEFAULT_QUOTA_MB)))),
    "workspace.start": _thread(lambda p: ws.start_workspace(p.get("agent_id", ""))),
    "workspace.stop": _thread(lambda p: ws.stop_workspace(p.get("agent_id", ""))),
    "workspace.restart_desktop": _thread(lambda p: ws.restart_desktop(p.get("agent_id", ""))),
    "workspace.delete": _thread(lambda p: ws.delete_workspace(p.get("agent_id", ""), p.get("confirm"))),
    "workspace.kill_tools": _thread(lambda p: ws.kill_tools(p.get("agent_id", ""))),
    "workspace.export": _thread(lambda p: ws.export_workspace(p.get("agent_id", ""))),
    "workspace.export_chunk": _thread(lambda p: ws.read_export_chunk(p.get("path", ""), p.get("offset", 0),
                                                                     p.get("length", 1 << 20))),
    "workspace.list": _thread(lambda p: ws.list_workspaces()),
    "tool.call": m_tool_call,
    "guest.rotate_key": m_rotate_key,
    # V2
    "shared.ensure": _thread(v2.shared_ensure),
    "shared.delete": _thread(v2.shared_delete),
    "fs.op": _thread(v2.fs_op),
    "packages.install": _thread(v2.packages_install),
    "plugins.install": _thread(v2.plugins_install),
    "plugins.remove": _thread(v2.plugins_remove),
    "guest.capabilities": _thread(v2.capabilities),
    "resources.agents": _thread(v2.agent_resources),
    # V3.2 Password Vault broker: isolated login as the nebula-vault user, only cookies reach the agent
    "vault.sign_in": vaultops.sign_in,
    # V3.2.1 Smart Authentication: one isolated, multi-step sign-in session per agent (cookies only reach the agent)
    "vault.auth_start": vaultops.auth_start,
    "vault.auth_step": vaultops.auth_step,
    "vault.auth_poll": vaultops.auth_poll,
    "vault.auth_allow": vaultops.auth_allow,
    "vault.auth_choose": vaultops.auth_choose,
    "vault.auth_observe": vaultops.auth_observe,
    "vault.auth_reload": vaultops.auth_reload,
    "vault.auth_handoff": vaultops.auth_handoff,
    "vault.auth_cancel": vaultops.auth_cancel,
    "vault.auth_cancel_all": vaultops.auth_cancel_all,
}


async def handle_rpc(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        while True:
            line = await reader.readline()
            if not line:
                break
            req_id = None
            try:
                frame = rpc.decode_frame(line)
                body = rpc.verify(KEY, frame, NONCES)
                req_id = body.get("id")
                method = body.get("method")
                fn = METHODS.get(method)
                if fn is None:
                    resp = {"id": req_id, "ok": False, "error": {"code": "unknown_method", "message": str(method)}}
                else:
                    result = await fn(body.get("params") or {})
                    resp = {"id": req_id, "ok": True, "result": result}
            except rpc.RPCAuthError as e:
                log.warning("rejected rpc frame: %s", e)
                resp = {"id": req_id, "ok": False, "error": {"code": "unauthorized", "message": str(e)}}
                writer.write(rpc.encode_frame(rpc.sign(KEY, resp)))
                await writer.drain()
                break
            except ws.WorkspaceError as e:
                resp = {"id": req_id, "ok": False, "error": {"code": e.code, "message": str(e)}}
            except Exception as e:
                log.exception("rpc error")
                resp = {"id": req_id, "ok": False, "error": {"code": type(e).__name__, "message": str(e)[:1000]}}
            writer.write(rpc.encode_frame(rpc.sign(KEY, resp)))
            await writer.drain()
    except (ConnectionError, asyncio.IncompleteReadError):
        pass
    finally:
        writer.close()


async def _pipe(r: asyncio.StreamReader, w: asyncio.StreamWriter) -> None:
    try:
        while True:
            data = await r.read(65536)
            if not data:
                break
            w.write(data)
            await w.drain()
    except (ConnectionError, asyncio.CancelledError):
        pass
    finally:
        try:
            w.close()
        except Exception:
            pass


async def handle_vnc(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        line = await asyncio.wait_for(reader.readline(), 10)
        body = rpc.verify(KEY, rpc.decode_frame(line), NONCES)
        if body.get("method") != "vnc.tunnel":
            raise rpc.RPCAuthError("wrong method")
        a = ws.get_agent(body.get("params", {}).get("agent_id", ""))
        # Only an Xvnc socket owned by AND served by this agent's uid: an agent must not be able to point its
        # vnc.sock at another agent's desktop (audit VM-02). Nothing is forwarded before the check passes.
        vs = await asyncio.to_thread(connect_trusted, vnc_socket_path(a["linux_user"]), agent_uid(a["linux_user"]), 10)
        vs.setblocking(False)
        vr, vw = await asyncio.open_unix_connection(sock=vs)
    except Exception as e:
        try:
            writer.write(rpc.encode_frame(rpc.sign(KEY, {"ok": False, "error": str(e)[:200]})))
            await writer.drain()
        finally:
            writer.close()
        return
    writer.write(rpc.encode_frame(rpc.sign(KEY, {"ok": True, "linux_user": a["linux_user"]})))
    await writer.drain()
    log.info("vnc tunnel opened for %s", a["linux_user"])
    await asyncio.gather(_pipe(reader, vw), _pipe(vr, writer))
    log.info("vnc tunnel closed for %s", a["linux_user"])


def vnc_socket_path(user: str) -> str:
    if not rpc.is_valid_linux_user(user):
        raise ValueError("invalid linux user")
    return f"/run/nebula-vnc/{user}/vnc.sock"


def vsock_listener(port: int) -> socket.socket:
    s = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind((socket.VMADDR_CID_ANY, port))
    s.listen(64)
    s.setblocking(False)
    return s


async def main() -> None:
    global KEY
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s", stream=sys.stdout)
    KEY = load_key()
    restored = await asyncio.to_thread(ws.restore_active)
    log.info("restored active workspaces: %s", restored)
    rpc_srv = await asyncio.start_server(handle_rpc, sock=vsock_listener(RPC_PORT), limit=rpc.MAX_FRAME_BYTES)
    vnc_srv = await asyncio.start_server(handle_vnc, sock=vsock_listener(VNC_PORT), limit=1 << 20)
    log.info("nebula-guest %s listening on vsock %d (rpc) and %d (vnc)", VERSION, RPC_PORT, VNC_PORT)
    async with rpc_srv, vnc_srv:
        await asyncio.gather(rpc_srv.serve_forever(), vnc_srv.serve_forever())


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
    _ = json  # keep import for debugging helpers
