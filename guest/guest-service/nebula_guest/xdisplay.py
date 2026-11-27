"""Who serves an X display? Guards an agent's desktop and tool server against display squatting (audit VM-06).

All agents share /tmp/.X11-unix and the abstract socket namespace. While agent B is stopped, agent A can start its own
X server on B's display number. B's clients (tool server, Chromium, screenshots, the XFCE session) would then connect
to A's server and A could watch and drive them. Every X client NEBULA starts as B first checks that each listening
socket of the display is served by B's uid (and, when known, by B's own Xvnc pid), and refuses otherwise.

CLI (used by nebula-desktop-session, runs as the agent):
  python -m nebula_guest.xdisplay --display 21 [--pid PID] [--absent]
    exit 0: every listening socket of :21 belongs to this uid (and PID); with --absent: nothing listens on :21
    exit 3: a socket of :21 belongs to someone else (or, with --absent, anything listens)
"""

from __future__ import annotations

import argparse
import os
import re
import socket
import stat
import sys
from collections.abc import Callable

from nebula_guest.peersock import peer_cred

X11_DIR = "/tmp/.X11-unix"
DISPLAY_RE = re.compile(r"^(?:unix)?:(\d{1,4})(?:\.\d+)?$")


def display_number(display: str) -> int | None:
    m = DISPLAY_RE.match(display or "")
    return int(m.group(1)) if m else None


def _candidates(n: int, x11_dir: str) -> list[tuple[str, str]]:
    out = [("file", f"{x11_dir}/X{n}")]
    if sys.platform.startswith("linux"):  # libxcb tries the abstract socket first on Linux
        out.insert(0, ("abstract", f"\0{x11_dir}/X{n}"))
    return out


def _probe(addr: str) -> tuple[int, int] | None:
    """(pid, uid) of the process listening on `addr`, or None when nothing listens there."""
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(2)
    try:
        s.connect(addr)
        return peer_cred(s)
    except (FileNotFoundError, ConnectionRefusedError):
        return None
    finally:
        s.close()


def listeners(n: int, *, x11_dir: str = X11_DIR,
              probe: Callable[[str], tuple[int, int] | None] = _probe) -> list[dict]:
    """Every socket that would answer DISPLAY=:n, with its owner. A filesystem entry that is a symlink or not a
    socket is reported with uid None (never trusted)."""
    found = []
    for kind, addr in _candidates(n, x11_dir):
        if kind == "file":
            try:
                st = os.lstat(addr)
            except FileNotFoundError:
                continue
            if stat.S_ISLNK(st.st_mode) or not stat.S_ISSOCK(st.st_mode):
                found.append({"kind": kind, "addr": addr, "pid": None, "uid": None, "file_uid": st.st_uid})
                continue
        cred = probe(addr)
        if cred is None:
            continue
        found.append({"kind": kind, "addr": addr.replace("\0", "@"), "pid": cred[0], "uid": cred[1]})
    return found


def foreign_listeners(n: int, uid: int, pid: int | None = None, **kw) -> list[dict]:
    """Listening sockets of display :n that are NOT served by `uid` (and `pid` when given)."""
    return _foreign(listeners(n, **kw), uid, pid)


def _foreign(found: list[dict], uid: int, pid: int | None) -> list[dict]:
    return [item for item in found
            if item["uid"] != uid or (pid is not None and item["pid"] not in (pid, -1))]


def main(argv: list[str] | None = None, **kw) -> int:
    ap = argparse.ArgumentParser(prog="nebula_guest.xdisplay")
    ap.add_argument("--display", type=int, required=True)
    ap.add_argument("--pid", type=int)
    ap.add_argument("--absent", action="store_true", help="succeed only when nothing listens on the display")
    ap.add_argument("--require", action="store_true", help="exit 4 while nothing listens on the display yet")
    a = ap.parse_args(argv)
    found = listeners(a.display, **kw)
    if a.absent:
        if found:
            print(f"display :{a.display} is already served: {found}", file=sys.stderr)
            return 3
        return 0
    bad = _foreign(found, os.getuid(), a.pid)
    if bad:
        print(f"display :{a.display} is served by another process or user: {bad}", file=sys.stderr)
        return 3
    if a.require and not found:
        return 4
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
