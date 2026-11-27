"""Root-side client for a per-agent tool server (unix socket owned by the agent user).

Root only talks to a socket that is owned by the agent and served by a process running as the agent (see peersock):
an agent cannot point its own socket path at another agent's tool server (audit VM-02).
"""

from __future__ import annotations

import json
import pwd
import socket
import time
from typing import Any

from nebula_contracts.rpc import is_valid_linux_user

from nebula_guest.peersock import SocketTrustError, connect_trusted

__all__ = ["SocketTrustError", "agent_uid", "call_tool", "tool_socket_path"]


def tool_socket_path(user: str) -> str:
    if not is_valid_linux_user(user):
        raise ValueError("invalid linux user")
    return f"/run/nebula-tools/{user}/tools.sock"


def agent_uid(user: str) -> int:
    if not is_valid_linux_user(user):
        raise ValueError("invalid linux user")
    return pwd.getpwnam(user).pw_uid


def _connect(path: str, timeout: float, wait_s: float = 15.0, *, uid: int) -> socket.socket:
    """The tool server may be restarting (e.g. after a team group change or a desktop restart): wait briefly
    for its socket instead of failing the agent's action. A socket that fails the ownership checks is refused at
    once (SocketTrustError), never retried."""
    end = time.monotonic() + wait_s
    while True:
        try:
            return connect_trusted(path, uid, timeout)
        except (FileNotFoundError, ConnectionRefusedError):
            if time.monotonic() >= end:
                raise
            time.sleep(0.3)


def call_tool(user: str, tool: str, args: dict[str, Any], timeout: float = 120) -> dict[str, Any]:
    s = _connect(tool_socket_path(user), timeout, uid=agent_uid(user))
    try:
        s.sendall(json.dumps({"tool": tool, "args": args}).encode() + b"\n")
        buf = bytearray()
        while True:
            chunk = s.recv(1 << 20)
            if not chunk:
                break
            buf += chunk
            if buf.endswith(b"\n"):
                break
        if not buf:
            return {"ok": False, "error": {"code": "tool_server_closed", "message": "no response"}}
        return json.loads(buf)
    finally:
        s.close()
