"""Per-user LaunchAgent: runs the NEBULA host service after login (spec §3.1: no 24/7-before-login promise).

The label and plist are per instance (`dev.nebula.host` for the default instance, `dev.nebula.host.<id>`
otherwise; see nebula_host.config.launchd_label). Every operation first proves the LaunchAgent belongs to *this*
data dir (the plist's NEBULA_DATA_DIR) and refuses with LaunchdConflict otherwise, so one install can never boot
out, rewrite, restart or delete another install's service.
"""

from __future__ import annotations

import os
import plistlib
import re
import subprocess
import time
from pathlib import Path

DEFAULT_LABEL = "dev.nebula.host"
LABEL = DEFAULT_LABEL  # backwards-compatible name: the default instance's label


class LaunchdConflict(RuntimeError):
    """The LaunchAgent with this label belongs to another NEBULA data dir."""


def _cfg():
    from nebula_host.config import get_config

    return get_config()


def current_label() -> str:
    return _cfg().launchd_label


def launch_agents_dir() -> Path:
    return Path.home() / "Library/LaunchAgents"


def plist_path(label: str | None = None) -> Path:
    return launch_agents_dir() / f"{label or current_label()}.plist"


def _norm(p: str | Path) -> Path:
    return Path(p).expanduser().resolve()


def plist_data_dir(label: str | None = None) -> Path | None:
    """NEBULA_DATA_DIR recorded in the plist (None if there is no readable plist).
    A NEBULA plist without the variable predates instance scoping and served the standard data dir."""
    p = plist_path(label)
    if not p.exists():
        return None
    try:
        with open(p, "rb") as f:
            data = plistlib.load(f)
    except Exception:  # noqa: BLE001 - unreadable/foreign plist: treat as not ours
        return Path("/nonexistent/unreadable-plist")
    env = data.get("EnvironmentVariables") or {}
    if env.get("NEBULA_DATA_DIR"):
        return Path(env["NEBULA_DATA_DIR"])
    from nebula_host.config import standard_data_dir

    return standard_data_dir()


def _print(label: str) -> subprocess.CompletedProcess:
    return subprocess.run(["launchctl", "print", f"gui/{os.getuid()}/{label}"], capture_output=True, text=True)


def loaded_data_dir(label: str | None = None) -> Path | None:
    """NEBULA_DATA_DIR of the loaded job, from `launchctl print` (None if not loaded or not shown)."""
    r = _print(label or current_label())
    if r.returncode != 0:
        return None
    m = re.search(r"NEBULA_DATA_DIR\s*=>\s*(.+)", r.stdout or "")
    return Path(m.group(1).strip()) if m else None


def check_owner(label: str | None = None, data_dir: Path | None = None) -> None:
    """Raise LaunchdConflict if the plist (or the loaded job) with this label serves another data dir."""
    label = label or current_label()
    data_dir = _norm(data_dir or _cfg().data_dir)
    for found in (plist_data_dir(label), loaded_data_dir(label)):
        if found is not None and _norm(found) != data_dir:
            raise LaunchdConflict(f"LaunchAgent {label} belongs to another NEBULA data dir ({found}); not touching it. "
                                  "Use `nebula --instance <id>` for a separate install.")


def install(program: list[str], log_dir: Path, env: dict[str, str] | None = None, *, label: str | None = None,
            data_dir: Path | None = None) -> Path:
    cfg = _cfg()
    label = label or cfg.launchd_label
    env = dict(env or {})
    data_dir = Path(env.get("NEBULA_DATA_DIR") or data_dir or cfg.data_dir)
    env["NEBULA_DATA_DIR"] = str(data_dir)
    env.setdefault("NEBULA_INSTANCE", cfg.instance_id)
    check_owner(label, data_dir)
    log_dir.mkdir(parents=True, exist_ok=True)
    os.chmod(log_dir, 0o700)
    p = plist_path(label)
    p.parent.mkdir(parents=True, exist_ok=True)
    data = {
        "Label": label,
        "ProgramArguments": program,
        "RunAtLoad": True,
        "KeepAlive": {"SuccessfulExit": False},
        "ProcessType": "Interactive",
        "Umask": 0o077,  # logs, DB and files NEBULA creates are private to the owner (logs may contain metadata)
        "ExitTimeOut": 30,
        "StandardOutPath": str(log_dir / "host.log"),
        "StandardErrorPath": str(log_dir / "host.log"),
        "EnvironmentVariables": {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin", **env},
        "ThrottleInterval": 10,
    }
    tmp = p.with_suffix(".plist.tmp")
    with open(tmp, "wb") as f:
        plistlib.dump(data, f)
    os.chmod(tmp, 0o644)
    os.replace(tmp, p)
    uid = os.getuid()
    _bootout_and_wait(uid, label)
    err = ""
    for _ in range(5):  # bootout is asynchronous; bootstrap can transiently fail with EIO (5)
        r = subprocess.run(["launchctl", "bootstrap", f"gui/{uid}", str(p)], capture_output=True, text=True)
        if r.returncode in (0, 17):  # 17 = already loaded
            return p
        err = r.stderr.strip()
        time.sleep(1.5)
    raise RuntimeError(f"launchctl bootstrap failed: {err}")


def _bootout_and_wait(uid: int, label: str | None = None, timeout: float = 20) -> None:
    label = label or current_label()
    subprocess.run(["launchctl", "bootout", f"gui/{uid}/{label}"], capture_output=True)
    end = time.time() + timeout
    while time.time() < end:
        if _print(label).returncode != 0:
            return
        time.sleep(0.3)


def uninstall(label: str | None = None, data_dir: Path | None = None) -> bool:
    """Stop and remove this instance's LaunchAgent. Raises LaunchdConflict if it belongs to another data dir."""
    label = label or current_label()
    check_owner(label, data_dir)
    _bootout_and_wait(os.getuid(), label)
    p = plist_path(label)
    if p.exists():
        p.unlink()
        return True
    return False


def stop(label: str | None = None, data_dir: Path | None = None) -> None:
    """Stop this instance's service until the next restart/login (the plist stays)."""
    label = label or current_label()
    check_owner(label, data_dir)
    _bootout_and_wait(os.getuid(), label)


def restart(label: str | None = None, data_dir: Path | None = None) -> dict:
    """Restart this instance's service now (`launchctl kickstart -k`), loading the plist first if needed."""
    label = label or current_label()
    check_owner(label, data_dir)
    uid = os.getuid()
    if _print(label).returncode != 0:
        p = plist_path(label)
        if not p.exists():
            raise RuntimeError(f"LaunchAgent {label} is not installed; run `nebula autostart enable` or "
                               "`nebula serve` (foreground)")
        r = subprocess.run(["launchctl", "bootstrap", f"gui/{uid}", str(p)], capture_output=True, text=True)
        if r.returncode not in (0, 17):
            raise RuntimeError(f"launchctl bootstrap failed: {r.stderr.strip()}")
    r = subprocess.run(["launchctl", "kickstart", "-k", f"gui/{uid}/{label}"], capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"launchctl kickstart failed: {r.stderr.strip()}")
    return status(label)


def status(label: str | None = None) -> dict:
    label = label or current_label()
    r = _print(label)
    loaded = r.returncode == 0
    state = None
    pid = None
    for line in (r.stdout or "").splitlines():
        line = line.strip()
        if line.startswith("state ="):
            state = line.split("=", 1)[1].strip()
        if line.startswith("pid ="):
            try:
                pid = int(line.split("=", 1)[1].strip())
            except ValueError:
                pid = None
    owner = plist_data_dir(label)
    return {"label": label, "plist": str(plist_path(label)), "installed": plist_path(label).exists(),
            "loaded": loaded, "state": state, "pid": pid, "data_dir": str(owner) if owner else None}
