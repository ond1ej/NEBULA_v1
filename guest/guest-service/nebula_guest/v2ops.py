# ruff: noqa: S103 - plugin and shared directories are deliberately world-readable (root-owned, read-only to agents) or group-shared
"""Root-side V2 operations of the guest service: team shared directories, file bridge, packages, plugins."""

from __future__ import annotations

import base64
import json
import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any

from nebula_guest import workspace as ws

SHARED_ROOT = Path("/srv/nebula/shared")
PLUGIN_ROOT = Path("/opt/nebula/plugins")
PY = "/opt/nebula/venv/bin/python"
FSOP = str(Path(__file__).resolve().parent / "fsop.py")
KEY_RE = re.compile(r"^[0-9a-f]{8,16}$")
PKG_RE = re.compile(r"^[a-z0-9][a-z0-9+.-]{1,62}$")
PLUGIN_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_.-]{1,63}$")
VERSION_RE = re.compile(r"^[0-9]+(\.[0-9]+){0,3}([.-][a-z0-9]+)?$")
PKG_DENY = {"sudo", "openssh-server", "telnetd", "docker.io", "docker-ce", "lxd", "qemu-system", "libvirt-daemon"}


def _group(key: str) -> str:
    return f"nbt_{key}"


def _members_of(group: str) -> set[str]:
    try:
        line = subprocess.run(["getent", "group", group], capture_output=True, text=True).stdout.strip()
    except OSError:
        return set()
    return set(filter(None, line.split(":")[3].split(","))) if line.count(":") >= 3 else set()


def shared_ensure(p: dict[str, Any]) -> dict[str, Any]:
    key = str(p.get("key", ""))
    if not KEY_RE.match(key):
        raise ws.WorkspaceError("invalid_argument", "key must be 8-16 hex chars")
    group = _group(key)
    if subprocess.run(["getent", "group", group], capture_output=True).returncode != 0:
        ws.run(["groupadd", "--system", group])
    SHARED_ROOT.mkdir(parents=True, exist_ok=True)
    os.chmod(SHARED_ROOT, 0o755)
    d = SHARED_ROOT / key
    d.mkdir(exist_ok=True)
    ws.run(["chown", f"root:{group}", str(d)])
    os.chmod(d, 0o2770)  # setgid: new files belong to the team group
    ws.run(["setfacl", "-d", "-m", f"g:{group}:rwX", str(d)], check=False)
    want = set()
    for aid in p.get("agent_ids") or []:
        want.add(ws.get_agent(aid)["linux_user"])
    have = _members_of(group)
    changed = []
    for u in want - have:
        ws.run(["gpasswd", "-a", u, group])
        changed.append(u)
    for u in have - want:
        ws.run(["gpasswd", "-d", u, group], check=False)
        changed.append(u)
    for u in changed:  # group membership applies to new processes: restart running tool servers
        _, tools = ws.unit_names(u)
        if ws.unit_active(tools):
            ws.run(["systemctl", "restart", tools], check=False)
    return {"path": str(d), "group": group, "members": sorted(want), "changed": sorted(changed)}


def shared_delete(p: dict[str, Any]) -> dict[str, Any]:
    key = str(p.get("key", ""))
    if not KEY_RE.match(key) or p.get("confirm") is not True:
        raise ws.WorkspaceError("invalid_argument", "key and confirm=true required")
    d = SHARED_ROOT / key
    if d.is_dir() and not d.is_symlink():
        shutil.rmtree(d)
    ws.run(["groupdel", _group(key)], check=False)
    return {"deleted": str(d)}


def _root_and_user(root: dict[str, Any]) -> tuple[str, str]:
    if root.get("type") == "agent":
        a = ws.get_agent(str(root.get("agent_id", "")))
        return f"/home/{a['linux_user']}/workspace", a["linux_user"]
    if root.get("type") == "shared":
        key = str(root.get("key", ""))
        if not KEY_RE.match(key):
            raise ws.WorkspaceError("invalid_argument", "invalid shared key")
        members = sorted(_members_of(_group(key)))
        if not members:
            raise ws.WorkspaceError("no_members", "the team has no members yet")
        return str(SHARED_ROOT / key), members[0]  # operate with a member's own permissions
    raise ws.WorkspaceError("invalid_argument", "root.type must be agent|shared")


def fs_op(p: dict[str, Any]) -> dict[str, Any]:
    root, user = _root_and_user(p.get("root") or {})
    req = {k: v for k, v in p.items() if k != "root"}
    req["root"] = root
    # fsop.py is stdlib-only: run the file itself in isolated mode (-I ignores PYTHONPATH and user site dirs)
    proc = subprocess.run(["/usr/sbin/runuser", "-u", user, "--", PY, "-I", FSOP],  # absolute: env PATH is minimal
                          input=json.dumps(req), capture_output=True, text=True, timeout=300,
                          env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"}, cwd="/")
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError:
        raise ws.WorkspaceError("fs_failed", (proc.stderr or proc.stdout)[:500]) from None


def packages_install(p: dict[str, Any]) -> dict[str, Any]:
    """apt install of owner-approved packages (the host only calls this after an explicit approval)."""
    names = p.get("names") or []
    if not names or len(names) > 10 or not all(isinstance(n, str) and PKG_RE.match(n) for n in names):
        raise ws.WorkspaceError("invalid_argument", "1-10 valid Debian package names required")
    bad = [n for n in names if n in PKG_DENY]
    if bad:
        raise ws.WorkspaceError("refused", f"not installable through NEBULA: {', '.join(bad)}")
    env = dict(os.environ, DEBIAN_FRONTEND="noninteractive")
    upd = subprocess.run(["apt-get", "update", "-q"], capture_output=True, text=True, timeout=600, env=env)
    r = subprocess.run(["apt-get", "install", "-y", "-q", "--no-install-recommends", *names], capture_output=True,
                       text=True, timeout=1200, env=env)
    return {"names": names, "exit_code": r.returncode, "stdout": r.stdout[-6000:], "stderr": r.stderr[-3000:],
            "update_exit_code": upd.returncode}


def plugins_install(p: dict[str, Any]) -> dict[str, Any]:
    pid, ver = str(p.get("plugin_id", "")), str(p.get("version", ""))
    if not PLUGIN_ID_RE.match(pid) or not VERSION_RE.match(ver):
        raise ws.WorkspaceError("invalid_argument", "invalid plugin id/version")
    files = p.get("files") or {}
    base = PLUGIN_ROOT / pid
    target = base / ver
    tmp = base / f".{ver}.tmp"
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True)
    for relpath, b64 in files.items():
        rp = Path(relpath)
        if rp.is_absolute() or ".." in rp.parts or not relpath or len(relpath) > 200:
            raise ws.WorkspaceError("invalid_plugin", f"bad file path {relpath!r}")
        dst = tmp / rp
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_bytes(base64.b64decode(b64, validate=True))
        os.chmod(dst, 0o644)
    for dp, dns, _ in os.walk(tmp):
        for d in dns:
            os.chmod(os.path.join(dp, d), 0o755)
    os.chmod(tmp, 0o755)
    shutil.rmtree(target, ignore_errors=True)
    os.replace(tmp, target)
    cur = base / "current"
    tmp_link = base / ".current.tmp"
    if tmp_link.is_symlink() or tmp_link.exists():
        tmp_link.unlink()
    os.symlink(ver, tmp_link)
    os.replace(tmp_link, cur)
    os.chmod(base, 0o755)
    os.chmod(PLUGIN_ROOT, 0o755)
    for old in base.iterdir():  # keep current + one previous version for rollback
        if old.name not in (ver, "current") and not old.name.startswith(".") and old.is_dir():
            shutil.rmtree(old, ignore_errors=True)
    return {"installed": pid, "version": ver, "path": str(target)}


def plugins_remove(p: dict[str, Any]) -> dict[str, Any]:
    pid = str(p.get("plugin_id", ""))
    if not PLUGIN_ID_RE.match(pid):
        raise ws.WorkspaceError("invalid_argument", "invalid plugin id")
    shutil.rmtree(PLUGIN_ROOT / pid, ignore_errors=True)
    return {"removed": pid}


def capabilities(p: dict[str, Any]) -> dict[str, Any]:
    return {"pdftotext": bool(shutil.which("pdftotext")), "git": bool(shutil.which("git")),
            "node": bool(shutil.which("node")) or any(Path("/opt/nebula/venv/lib").glob(
                "python3*/site-packages/playwright/driver/node")),
            "python3": bool(shutil.which("python3")), "mousepad": bool(shutil.which("mousepad")),
            "shared_root": SHARED_ROOT.is_dir(), "plugins": sorted(x.name for x in PLUGIN_ROOT.iterdir())
            if PLUGIN_ROOT.is_dir() else [], "vault_broker": _vault_self_test()}


def _vault_self_test() -> dict[str, Any]:
    try:
        from nebula_guest import vaultops

        return vaultops.self_test()
    except Exception as e:  # noqa: BLE001 - capabilities must always answer
        return {"installed": False, "isolated": False, "reason": f"self-test failed: {type(e).__name__}"}


def agent_resources(p: dict[str, Any]) -> dict[str, Any]:
    """Per-agent memory/CPU of the desktop + tool units (systemd cgroup accounting), one systemctl call."""
    reg = ws.load_registry()
    units = []
    for aid, a in (reg.get("agents") or {}).items():
        d, t = ws.unit_names(a["linux_user"])
        units += [(aid, "desktop", d), (aid, "tools", t)]
    out: dict[str, dict[str, Any]] = {}
    if not units:
        return {"agents": out}
    r = subprocess.run(["systemctl", "show", "-p", "Id", "-p", "MemoryCurrent", "-p", "ActiveState", "-p",
                        "CPUUsageNSec", *[u[2] for u in units]], capture_output=True, text=True, timeout=20)
    blocks = [dict(line.split("=", 1) for line in b.splitlines() if "=" in line) for b in r.stdout.strip().split("\n\n")]
    by_unit = {b.get("Id"): b for b in blocks}
    for aid, kind, unit in units:
        b = by_unit.get(unit, {})
        mem = b.get("MemoryCurrent", "")
        cpu = b.get("CPUUsageNSec", "")
        e = out.setdefault(aid, {"memory_bytes": 0, "cpu_ns": 0, "units": {}})
        e["units"][kind] = b.get("ActiveState", "unknown")
        if mem.isdigit():
            e["memory_bytes"] += int(mem)
        if cpu.isdigit():
            e["cpu_ns"] += int(cpu)
    return {"agents": out}
