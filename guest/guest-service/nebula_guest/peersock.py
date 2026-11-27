"""Trusted connects from root to a per-agent unix socket (tool server, Xvnc).

The per-agent runtime directories (/run/nebula-tools/<agent>, /run/nebula-vnc/<agent>) are owned by the agent, so the
agent can replace its socket with a symlink to ANOTHER agent's socket. Root would then follow the link and hand that
other agent's tool server or desktop to the first agent (audit VM-02). Before root talks to such a socket it therefore:

  1. lstat()s the path: it must be a real socket (never a symlink) owned by the agent's uid, inside a real directory
     owned by the agent or root;
  2. connects, then reads the peer credentials of the listening process (SO_PEERCRED) and requires the agent's uid.

Step 2 is the decisive check: it also closes the race between the lstat and the connect, because a socket swapped in
between is served by a process with a different uid. Nothing is sent or forwarded before both checks pass.
"""

from __future__ import annotations

import os
import socket
import stat
import struct


class SocketTrustError(Exception):
    """The socket is not served by the expected agent; the caller must not use it."""

    code = "socket_untrusted"


def peer_cred(sock: socket.socket) -> tuple[int, int]:
    """(pid, uid) of the peer process of a connected AF_UNIX stream socket (Linux: the listener's credentials)."""
    if hasattr(socket, "SO_PEERCRED"):  # Linux: struct ucred {pid_t pid; uid_t uid; gid_t gid;}
        raw = sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
        pid, uid, _gid = struct.unpack("3i", raw)
        return pid, uid
    if hasattr(socket, "LOCAL_PEERCRED"):  # macOS (development/tests only): struct xucred {u_int ver; uid_t uid; ...}
        raw = sock.getsockopt(0, socket.LOCAL_PEERCRED, 76)
        _ver, uid = struct.unpack("=II", raw[:8])
        return -1, uid
    raise SocketTrustError("peer credentials are not available on this platform")


def peer_uid(sock: socket.socket) -> int:
    return peer_cred(sock)[1]


def check_socket_file(path: str, uid: int) -> None:
    """Raise FileNotFoundError when the socket is missing (the server may be restarting), SocketTrustError when
    something is there that root must not connect to."""
    parent = os.path.dirname(path) or "."
    pst = os.lstat(parent)  # FileNotFoundError propagates: the unit is stopped or restarting
    if stat.S_ISLNK(pst.st_mode) or not stat.S_ISDIR(pst.st_mode):
        raise SocketTrustError(f"{parent} is not a real directory")
    if pst.st_uid not in (uid, 0):
        raise SocketTrustError(f"{parent} is owned by uid {pst.st_uid}, expected {uid}")
    st = os.lstat(path)
    if stat.S_ISLNK(st.st_mode):
        raise SocketTrustError(f"{path} is a symlink")
    if not stat.S_ISSOCK(st.st_mode):
        raise SocketTrustError(f"{path} is not a socket")
    if st.st_uid != uid:
        raise SocketTrustError(f"{path} is owned by uid {st.st_uid}, expected {uid}")


def connect_trusted(path: str, uid: int, timeout: float | None = None) -> socket.socket:
    """Connect to `path` only if it is a socket of `uid` and its listening process runs as `uid`."""
    check_socket_file(path, uid)
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        if timeout is not None:
            s.settimeout(timeout)
        s.connect(path)
        got = peer_uid(s)
        if got != uid:
            raise SocketTrustError(f"{path} is served by uid {got}, expected {uid}")
        return s
    except BaseException:
        s.close()
        raise
