"""Per-agent workspace provisioning inside the shared Ubuntu VM (runs as root).

Each agent gets: Linux user nebula_<shortid>, /home/<user>/workspace, its own Xvnc display
(:21, :22, ...) with private X11 cookie, XFCE session, browser profile and tool server,
managed by templated systemd units. All operations are idempotent per agent_id.
"""

from __future__ import annotations

import fcntl
import json
import os
import pwd
import re
import shutil
import stat
import subprocess
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from nebula_contracts.rpc import is_valid_linux_user, linux_user_for

STATE_DIR = Path(os.environ.get("NEBULA_GUEST_STATE", "/var/lib/nebula"))
REGISTRY = STATE_DIR / "agents.json"
LOCK = STATE_DIR / "agents.lock"
FIRST_DISPLAY = 21
MAX_DISPLAY = 99
GEOMETRY_RE = re.compile(r"^(\d{3,4})x(\d{3,4})$")
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
DEFAULT_QUOTA_MB = 8192


class WorkspaceError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def run(cmd: list[str], check: bool = True, timeout: int = 120, **kw) -> subprocess.CompletedProcess:
    # argv lists only — never a shell string built from input
    return subprocess.run(cmd, check=check, timeout=timeout, capture_output=True, text=True, **kw)


@contextmanager
def registry_lock():
    STATE_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    with open(LOCK, "a+") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)


def load_registry() -> dict[str, Any]:
    if not REGISTRY.exists():
        return {"agents": {}}
    return json.loads(REGISTRY.read_text())


def save_registry(reg: dict[str, Any]) -> None:
    tmp = REGISTRY.with_suffix(".tmp")
    tmp.write_text(json.dumps(reg, indent=2, sort_keys=True))
    os.chmod(tmp, 0o600)
    os.replace(tmp, REGISTRY)


def validate_agent_id(agent_id: str) -> str:
    if not isinstance(agent_id, str) or not UUID_RE.match(agent_id):
        raise WorkspaceError("invalid_agent_id", "agent_id must be a lowercase UUID")
    return agent_id


def user_exists(name: str) -> bool:
    try:
        pwd.getpwnam(name)
        return True
    except KeyError:
        return False


def unit_names(user: str) -> tuple[str, str]:
    return f"nebula-desktop@{user}.service", f"nebula-tools@{user}.service"


def unit_active(unit: str) -> bool:
    return run(["systemctl", "is-active", "--quiet", unit], check=False).returncode == 0


def _display_in_use(n: int) -> bool:
    """Something already serves display :n. The agent units run with PrivateTmp=yes, so an X server an agent starts
    keeps its socket file and lock file in that agent's private /tmp; its abstract socket (@/tmp/.X11-unix/Xn) is
    still visible to everyone, so probe that too (connect + peer credentials only, no X protocol)."""
    if Path(f"/tmp/.X11-unix/X{n}").exists() or Path(f"/tmp/.X{n}-lock").exists():
        return True
    from nebula_guest import xdisplay  # local import: keeps this module importable without the X helpers

    try:
        return bool(xdisplay.listeners(n))
    except OSError:
        return True  # cannot tell: do not hand out a display that may be taken


def allocate_display(reg: dict[str, Any]) -> int:
    used = {a["display"] for a in reg["agents"].values()}
    for n in range(FIRST_DISPLAY, MAX_DISPLAY + 1):
        if n in used:
            continue
        if _display_in_use(n):
            continue  # port/display collision with a foreign X server
        return n
    raise WorkspaceError("no_display", "no free display numbers")


def home_of(user: str) -> Path:
    return Path("/home") / user


def write_desktop_env(user: str, display: int, geometry: str) -> None:
    d = STATE_DIR / "agents" / user
    d.mkdir(parents=True, exist_ok=True, mode=0o755)
    env = (
        f"NEBULA_DISPLAY={display}\n"
        f"DISPLAY=:{display}\n"
        f"NEBULA_GEOMETRY={geometry}\n"
        f"XAUTHORITY=/home/{user}/.Xauthority\n"
        f"NEBULA_WORKSPACE=/home/{user}/workspace\n"
    )
    p = d / "desktop.env"
    p.write_text(env)
    os.chmod(p, 0o644)


def create_user(user: str) -> None:
    if user_exists(user):
        return
    # no password (locked), no sudo, own primary group, bash login shell for the agent's terminal
    run(["useradd", "--create-home", "--home-dir", str(home_of(user)), "--shell", "/bin/bash",
         "--user-group", "--comment", "NEBULA agent", user])
    run(["passwd", "--lock", user])
    os.chmod(home_of(user), 0o700)


XFCONF_SRC = Path("/opt/nebula/guest/desktop/xfconf")
_NOFOLLOW_DIR = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)


def _open_dir_nofollow(parent_fd: int, name: str, uid: int, gid: int, mode: int | None,
                       create: bool = True) -> int:
    """Open (creating if needed) directory `name` under `parent_fd` WITHOUT following a symlink, then chown/chmod it
    through the fd. The agent owns its home, so any entry may have been replaced with a symlink; running as root,
    following it would chown/chmod an arbitrary target (audit VM-09)."""
    if create:
        try:
            os.mkdir(name, 0o700, dir_fd=parent_fd)
        except FileExistsError:
            pass
    try:
        fd = os.open(name, _NOFOLLOW_DIR, dir_fd=parent_fd)
    except OSError as e:  # ELOOP (symlink) / ENOTDIR (a file)
        raise WorkspaceError("unsafe_home", f"refusing to use {name!r} in the agent home: {e.strerror}") from e
    try:
        st = os.fstat(fd)
        if st.st_uid not in (uid, 0):
            raise WorkspaceError("unsafe_home", f"{name!r} in the agent home is owned by uid {st.st_uid}")
        os.fchown(fd, uid, gid)
        if mode is not None:
            os.fchmod(fd, mode)
    except BaseException:
        os.close(fd)
        raise
    return fd


def _open_path_nofollow(base_fd: int, rel: str, uid: int, gid: int, mode: int | None) -> int:
    """Walk `rel` component by component from `base_fd` with _open_dir_nofollow; returns the last directory's fd."""
    fd = os.dup(base_fd)
    for part in Path(rel).parts:
        if part in ("", ".", ".."):
            os.close(fd)
            raise WorkspaceError("unsafe_home", f"invalid path {rel!r}")
        try:
            nfd = _open_dir_nofollow(fd, part, uid, gid, mode)
        finally:
            os.close(fd)
        fd = nfd
    return fd


def _write_file_nofollow(dir_fd: int, name: str, data: bytes, uid: int, gid: int, *, overwrite: bool) -> bool:
    """Create (or, with overwrite, replace the content of) a regular file without following symlinks."""
    flags = os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)
    flags |= os.O_TRUNC if overwrite else os.O_EXCL
    try:
        fd = os.open(name, flags, 0o644, dir_fd=dir_fd)
    except FileExistsError:
        return False  # keep the agent's own file
    except OSError as e:
        raise WorkspaceError("unsafe_home", f"refusing to write {name!r} in the agent home: {e.strerror}") from e
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_uid not in (uid, 0):
            raise WorkspaceError("unsafe_home", f"{name!r} in the agent home is not the agent's regular file")
        os.write(fd, data)
        os.fchown(fd, uid, gid)
    finally:
        os.close(fd)
    return True


def prepare_home(user: str) -> None:
    """Create the agent's standard directories and XFCE defaults. Runs as root inside a home the agent owns, so it
    never follows a symlink and changes ownership/modes only through file descriptors it opened itself."""
    pw = pwd.getpwnam(user)
    uid, gid = pw.pw_uid, pw.pw_gid
    try:
        home_fd = os.open(str(home_of(user)), _NOFOLLOW_DIR)
    except OSError as e:
        raise WorkspaceError("unsafe_home", f"agent home is missing or not a directory: {e.strerror}") from e
    try:
        for sub, mode in (("workspace", 0o750), (".nebula", 0o700), (".nebula/browser-profile", 0o700),
                          (".config", 0o700), (".cache", 0o700)):
            os.close(_open_path_nofollow(home_fd, sub, uid, gid, mode))
        # XFCE defaults: disable screensaver/lock and power management in the virtual session
        xfconf_fd = _open_path_nofollow(home_fd, ".config/xfce4/xfconf/xfce-perchannel-xml", uid, gid, None)
        try:
            if XFCONF_SRC.exists():
                for f in sorted(XFCONF_SRC.glob("*.xml")):
                    _write_file_nofollow(xfconf_fd, f.name, f.read_bytes(), uid, gid, overwrite=False)
        finally:
            os.close(xfconf_fd)
        autostart_fd = _open_path_nofollow(home_fd, ".config/autostart", uid, gid, None)
        try:
            for name in ("xfce4-screensaver.desktop", "light-locker.desktop", "xfce4-power-manager.desktop"):
                _write_file_nofollow(autostart_fd, name, b"[Desktop Entry]\nHidden=true\n", uid, gid, overwrite=True)
        finally:
            os.close(autostart_fd)
    finally:
        os.close(home_fd)


def wait_for_desktop(user: str, display: int, timeout: float = 45.0) -> dict[str, Any]:
    from nebula_guest.toolclient import call_tool  # local import: avoids cycle

    deadline = time.time() + timeout
    last_err = ""
    while time.time() < deadline:
        desk, tools = unit_names(user)
        if unit_active(desk) and unit_active(tools):
            try:
                shot = call_tool(user, "desktop.screenshot", {"scale": 0.25}, timeout=15)
                if shot.get("ok") and shot["result"].get("non_empty"):
                    return {"x_running": True, "screenshot_non_empty": True,
                            "width": shot["result"]["width"], "height": shot["result"]["height"]}
                last_err = json.dumps(shot.get("error"))[:300]
            except Exception as e:  # tool server still starting
                last_err = str(e)[:300]
        time.sleep(1.0)
    return {"x_running": unit_active(unit_names(user)[0]), "screenshot_non_empty": False, "error": last_err}


def create_workspace(agent_id: str, geometry: str = "1280x800", quota_mb: int = DEFAULT_QUOTA_MB) -> dict[str, Any]:
    validate_agent_id(agent_id)
    if not GEOMETRY_RE.match(geometry):
        raise WorkspaceError("invalid_geometry", "geometry must be WIDTHxHEIGHT")
    w, h = (int(x) for x in geometry.split("x"))
    if not (640 <= w <= 3840 and 480 <= h <= 2160):
        raise WorkspaceError("invalid_geometry", "geometry out of range")
    user = linux_user_for(agent_id)
    with registry_lock():
        reg = load_registry()
        existing = reg["agents"].get(agent_id)
        created_now = existing is None
        if existing:
            display = existing["display"]
        else:
            # Another agent id must never map onto the same Linux user
            for aid, a in reg["agents"].items():
                if a["linux_user"] == user and aid != agent_id:
                    raise WorkspaceError("user_collision", "short id collision; retry with a new agent id")
            display = allocate_display(reg)
            reg["agents"][agent_id] = {"linux_user": user, "display": display, "geometry": geometry,
                                       "quota_mb": quota_mb, "created_at": int(time.time()), "state": "CREATING"}
            save_registry(reg)
    try:
        create_user(user)
        prepare_home(user)
        write_desktop_env(user, display, geometry)
        desk, tools = unit_names(user)
        run(["systemctl", "daemon-reload"])
        run(["systemctl", "enable", "--now", desk])
        run(["systemctl", "enable", "--now", tools])
        health = wait_for_desktop(user, display)
        if not health.get("screenshot_non_empty"):
            raise WorkspaceError("desktop_unhealthy", f"desktop did not become healthy: {health.get('error')}")
    except Exception as e:
        if created_now:
            _cleanup_partial(agent_id, user)
        if isinstance(e, WorkspaceError):
            raise
        raise WorkspaceError("provision_failed", str(e)[:500]) from e
    with registry_lock():
        reg = load_registry()
        reg["agents"][agent_id]["state"] = "ACTIVE"
        save_registry(reg)
    return {
        "workspace_id": f"ws-{user}",
        "agent_id": agent_id,
        "linux_user": user,
        "display_id": f"display-{display}",
        "display": display,
        "workspace_path": str(home_of(user) / "workspace"),
        "desktop_health": health,
        "created": created_now,
        "capabilities": ["desktop", "browser", "shell", "files", "screenshot", "vnc"],
    }


def _cleanup_partial(agent_id: str, user: str) -> None:
    desk, tools = unit_names(user)
    for u in (tools, desk):
        run(["systemctl", "disable", "--now", u], check=False)
    run(["pkill", "-KILL", "-u", user], check=False)
    if user_exists(user):
        run(["userdel", "--remove", user], check=False)
    shutil.rmtree(STATE_DIR / "agents" / user, ignore_errors=True)
    with registry_lock():
        reg = load_registry()
        reg["agents"].pop(agent_id, None)
        save_registry(reg)


def get_agent(agent_id: str) -> dict[str, Any]:
    validate_agent_id(agent_id)
    reg = load_registry()
    a = reg["agents"].get(agent_id)
    if not a:
        raise WorkspaceError("not_found", "unknown agent workspace")
    if not is_valid_linux_user(a["linux_user"]):
        raise WorkspaceError("corrupt_registry", "invalid linux user in registry")
    return a


def start_workspace(agent_id: str) -> dict[str, Any]:
    a = get_agent(agent_id)
    desk, tools = unit_names(a["linux_user"])
    run(["systemctl", "enable", "--now", desk])
    run(["systemctl", "enable", "--now", tools])
    health = wait_for_desktop(a["linux_user"], a["display"])
    _set_state(agent_id, "ACTIVE")
    return {"agent_id": agent_id, "desktop_health": health}


def stop_workspace(agent_id: str) -> dict[str, Any]:
    """SLEEP/STOP: stop GUI + tool server, keep files and account."""
    a = get_agent(agent_id)
    desk, tools = unit_names(a["linux_user"])
    run(["systemctl", "disable", "--now", tools], check=False)
    run(["systemctl", "disable", "--now", desk], check=False)
    _set_state(agent_id, "STOPPED")
    return {"agent_id": agent_id, "stopped": True}


def restart_desktop(agent_id: str) -> dict[str, Any]:
    a = get_agent(agent_id)
    desk, tools = unit_names(a["linux_user"])
    run(["systemctl", "restart", desk])
    run(["systemctl", "restart", tools])
    return {"agent_id": agent_id, "desktop_health": wait_for_desktop(a["linux_user"], a["display"])}


def kill_tools(agent_id: str) -> dict[str, Any]:
    """Emergency stop: kill ONLY this agent's tool server (and its browser/shell children), then restart it.
    The desktop session and every other agent keep running."""
    a = get_agent(agent_id)
    _, tools = unit_names(a["linux_user"])
    run(["systemctl", "kill", "--signal=SIGKILL", tools], check=False)
    run(["systemctl", "restart", tools], check=False)
    return {"agent_id": agent_id, "killed": True, "tools_active": unit_active(tools)}


def _set_state(agent_id: str, state: str) -> None:
    with registry_lock():
        reg = load_registry()
        if agent_id in reg["agents"]:
            reg["agents"][agent_id]["state"] = state
            save_registry(reg)


def delete_workspace(agent_id: str, confirm: bool) -> dict[str, Any]:
    if confirm is not True:
        raise WorkspaceError("confirmation_required", "delete requires confirm=true")
    a = get_agent(agent_id)
    user = a["linux_user"]
    desk, tools = unit_names(user)
    for u in (tools, desk):
        run(["systemctl", "disable", "--now", u], check=False)
    run(["pkill", "-KILL", "-u", user], check=False)
    time.sleep(0.5)
    if user_exists(user):
        run(["userdel", "--remove", user], check=False)
    shutil.rmtree(home_of(user), ignore_errors=True)
    shutil.rmtree(STATE_DIR / "agents" / user, ignore_errors=True)
    with registry_lock():
        reg = load_registry()
        reg["agents"].pop(agent_id, None)
        save_registry(reg)
    leftover = run(["pgrep", "-u", user], check=False).stdout.strip() if user_exists(user) else ""
    return {"agent_id": agent_id, "deleted": True, "orphan_processes": leftover.split() if leftover else []}


def export_workspace(agent_id: str) -> dict[str, Any]:
    a = get_agent(agent_id)
    user = a["linux_user"]
    out_dir = STATE_DIR / "exports"
    out_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    out = out_dir / f"{user}-{int(time.time())}.tar.gz"
    # browser profile excluded (contains cookies/session secrets)
    run(["tar", "-czf", str(out), "-C", str(home_of(user)), "--exclude=.nebula/browser-profile", "workspace"],
        timeout=600)
    os.chmod(out, 0o600)
    return {"agent_id": agent_id, "export_path": str(out), "size_bytes": out.stat().st_size}


def read_export_chunk(path: str, offset: int, length: int) -> dict[str, Any]:
    import base64

    p = Path(path).resolve()
    if p.parent != (STATE_DIR / "exports").resolve() or not p.is_file():
        raise WorkspaceError("invalid_path", "not an export file")
    length = max(0, min(int(length), 4 * 1024 * 1024))
    with open(p, "rb") as fh:
        fh.seek(int(offset))
        data = fh.read(length)
    return {"data_b64": base64.b64encode(data).decode(), "eof": len(data) < length, "size": p.stat().st_size}


def list_workspaces() -> list[dict[str, Any]]:
    reg = load_registry()
    out = []
    for aid, a in reg["agents"].items():
        desk, tools = unit_names(a["linux_user"])
        out.append({"agent_id": aid, **a, "desktop_active": unit_active(desk), "tools_active": unit_active(tools)})
    return out


def disk_usage() -> dict[str, Any]:
    st = os.statvfs("/")
    total = st.f_blocks * st.f_frsize
    free = st.f_bavail * st.f_frsize
    per = {}
    reg = load_registry()
    for aid, a in reg["agents"].items():
        r = run(["du", "-sb", str(home_of(a["linux_user"]))], check=False, timeout=60)
        try:
            per[aid] = int(r.stdout.split()[0])
        except (IndexError, ValueError):
            per[aid] = None
    return {"total_bytes": total, "free_bytes": free, "workspaces": per}


def restore_active() -> list[str]:
    """On guest boot: ensure every ACTIVE workspace has its units running (STOPPED stays stopped)."""
    restored = []
    reg = load_registry()
    for aid, a in reg["agents"].items():
        if a.get("state") == "ACTIVE":
            desk, tools = unit_names(a["linux_user"])
            run(["systemctl", "start", desk], check=False)
            run(["systemctl", "start", tools], check=False)
            restored.append(aid)
    return restored
