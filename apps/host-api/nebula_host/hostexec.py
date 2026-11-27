"""Native macOS execution backend (V3, AI Company Mode option A: "Mac mini — Native Execution").

An agent whose effective environment is ``host`` works directly on an owner-authorised project directory on this
Mac. This is real host execution — commands run as macOS processes on the host, not in the Ubuntu VM — confined by:

* Authorisation: only directories the owner added as *host project roots* (canonical realpath, never $HOME itself,
  ~/Library, ~/.ssh, the NEBULA data dir or a parent of those).
* File tools run in-process through SafeTree: every path component is opened relative to its parent's directory
  descriptor with O_NOFOLLOW (no symlinks, no check-then-open race), confined to the root or the agent's home;
  files with a second hard link are refused; read-only roots reject every mutation.
* Commands (shell / git / python / node / pdftotext) run under macOS Seatbelt (``sandbox-exec``) with a deny-default
  profile: read access to system/tool locations, the project root and a NEBULA-managed per-agent home; write access
  only to the project root (unless read-only) and that home; Keychain / pasteboard / WindowServer / TCC and other
  prompt, notification and persistence services blocked; IOKit limited to the GPU; network optional per root (off
  by default). Even with network on, unix sockets and every address of this Mac itself stay denied: Seatbelt's
  ``localhost`` filter (see _NETWORK_RULES) matches all of the Mac's own interface addresses, not only 127.0.0.1.
  Measured with sandbox-exec on macOS 27.0.1 (Apple silicon) against listeners bound to all addresses (0.0.0.0 and
  ::): TCP connects to 127.0.0.1, ::1, the Mac's LAN IPv4 address and the vmnet bridge address 192.168.64.1 (on a
  bridge interface) all fail with EPERM, and so does a UDP send to the LAN address; with the same profile minus the
  ``localhost`` deny, every one of them connects. Other hosts on the LAN were not part of that measurement.
  The project's allowed tools are checked against every program a command line names (a convenience filter, not a
  boundary). Environment variables are rebuilt from scratch (no inherited secrets),
  HOME points to the per-agent home, every command has a timeout, resource limits and a process-group kill.
* Every command and file mutation is audited (``host_commands`` + audit log).

Host *graphical* control (mouse/keyboard on the macOS desktop) is a separate capability that is NOT provided here.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import errno
import json
import logging
import os
import re
import resource
import shutil
import signal
import stat
import time
import uuid
from pathlib import Path
from typing import Any

from nebula_runtime.policy import allowed_tools_violation
from sqlalchemy import select, update

from nebula_host import db, models
from nebula_host import secrets as nebula_secrets
from nebula_host.events import audit

log = logging.getLogger("nebula.hostexec")

SANDBOX_EXEC = "/usr/bin/sandbox-exec"
PATH_ENV = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
MAX_OUTPUT = 64 * 1024
MAX_READ = 256 * 1024
MAX_WRITE = 4 * 1024 * 1024
MAX_BG_PER_AGENT = 3
BG_MAX_LIFETIME = 2 * 3600

# wire tool name -> host implementation key (guest-compatible result shapes)
HOST_TOOLS = {
    "files_list": "files.list", "files_read": "files.read", "files_stat": "files.stat", "files_search": "files.search",
    "files_write": "files.write", "files_edit": "files.edit", "files_mkdir": "files.mkdir", "files_move": "files.move",
    "files_copy": "files.copy", "files_delete": "files.delete", "shell_execute": "shell.execute",
    "process_list": "process.list", "process_start": "process.start", "process_output": "process.output",
    "process_kill": "process.kill", "git_run": "git.run", "python_run": "python.run", "node_run": "node.run",
    "pdf_text": "pdf.text",
}
MUTATING = {"files.write", "files.edit", "files.mkdir", "files.move", "files.copy", "files.delete"}

DEV_TOOLS = {  # detected on the real host (never installed by NEBULA)
    "git": ["--version"], "python3": ["--version"], "node": ["--version"], "npm": ["--version"],
    "npx": ["--version"], "pnpm": ["--version"], "yarn": ["--version"], "swift": ["--version"],
    "xcodebuild": ["-version"], "xcrun": ["--version"], "make": ["--version"], "flutter": ["--version"],
    "dart": ["--version"], "docker": ["--version"], "cargo": ["--version"], "go": ["version"],
    "java": ["-version"], "ruby": ["--version"], "pdftotext": ["-v"], "ffmpeg": ["-version"],
}
TOOL_NOTES = {"flutter": "SDK cache under /opt/homebrew is read-only in the sandbox: `flutter --version` and "
                         "builds that need an SDK update fail; run `flutter precache` yourself first.",
              "docker": "talks to the Docker daemon socket, which the sandbox never allows (a daemon socket would "
                        "give an agent full access to this Mac); run Docker commands yourself."}

SECRET_FILE_RE = re.compile(r"(^|/)(\.env(\.[\w.-]+)?|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|[^/]*\.(pem|key|p12|pfx|"
                            r"keystore|jks|mobileprovision)|\.npmrc|\.pypirc|\.netrc|\.git-credentials|"
                            r"credentials(\.json)?|secrets?\.(json|ya?ml|toml))$", re.I)


class HostExecError(Exception):
    def __init__(self, code: str, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


# ============================================================================ symlink-proof file access (H-03)
# The file tools run in the (unsandboxed) NEBULA process. Checking a path and then opening it by name lets a
# sandboxed process swap a directory for a symlink in between (TOCTOU). SafeTree therefore never re-walks a path by
# name: it opens the trusted base directory, then every component relative to its parent's descriptor with
# O_NOFOLLOW, and performs the final open/mkdir/rename/unlink relative to the parent descriptor it holds.
_O_CLOEXEC = getattr(os, "O_CLOEXEC", 0)
_DIR_OPEN = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | _O_CLOEXEC


def _name_ok(name: str) -> str:
    if not name or name in (".", "..") or "/" in name or "\x00" in name:
        raise HostExecError("invalid_path", f"invalid path component {name!r}")
    return name


def _lstat_at(name: str, dir_fd: int) -> os.stat_result | None:
    try:
        return os.stat(name, dir_fd=dir_fd, follow_symlinks=False)
    except FileNotFoundError:
        return None


def _symlink_error(name: str) -> HostExecError:
    return HostExecError("symlink_rejected", f"{name} is a symlink; symlinks are not followed")


def _raise_if_link(e: OSError, name: str, dir_fd: int) -> None:
    st = _lstat_at(name, dir_fd) if e.errno in (errno.ELOOP, errno.ENOTDIR, errno.EMLINK) else None
    if e.errno == errno.ELOOP or (st is not None and stat.S_ISLNK(st.st_mode)):
        raise _symlink_error(name) from None


def _hardlink_error(name: str) -> HostExecError:
    return HostExecError("hardlink_rejected", f"{name} has more than one hard link, so it may also be a file outside "
                                              "this folder; the file tools do not open such files")


def _open_file_at(dir_fd: int, name: str, flags: int, mode: int = 0o644, *, single_link: bool = False) -> int:
    """Open a regular file in dir_fd (never through a symlink, never a FIFO/device: O_NONBLOCK + fstat check).

    single_link (H-03, hard-link variant): also refuse a file whose link count is above 1. A hard link inside a
    project folder can name a file outside it, and the file tools run unsandboxed. The check uses fstat on the
    descriptor that was opened, so it is race-free, and it runs before anything is read, truncated or written."""
    try:
        fd = os.open(name, flags | os.O_NOFOLLOW | os.O_NONBLOCK | _O_CLOEXEC, mode, dir_fd=dir_fd)
    except OSError as e:
        _raise_if_link(e, name, dir_fd)
        if e.errno == errno.EISDIR:
            raise HostExecError("not_a_file", f"{name} is a directory") from None
        raise
    st = os.fstat(fd)
    if not stat.S_ISREG(st.st_mode):
        os.close(fd)
        raise HostExecError("not_a_file", f"{name} is not a regular file")
    if single_link and st.st_nlink > 1:
        os.close(fd)
        raise _hardlink_error(name)
    return fd


def _copy_file_at(sfd: int, sname: str, dfd: int, dname: str, *, src_single: bool = False,
                  dst_single: bool = False) -> None:
    src = _open_file_at(sfd, sname, os.O_RDONLY, single_link=src_single)
    try:
        dst = _open_file_at(dfd, dname, os.O_WRONLY | os.O_CREAT, single_link=dst_single)
        try:
            os.ftruncate(dst, 0)
            while chunk := os.read(src, 1 << 20):
                os.write(dst, chunk)
        finally:
            os.close(dst)
    finally:
        os.close(src)


def _copy_dir_at(sfd: int, sname: str, dfd: int, dname: str, *, merge: bool, depth: int = 0,
                 src_single: bool = False, dst_single: bool = False) -> None:
    if depth > 64:
        raise HostExecError("too_deep", "directory tree is too deep to copy")
    s = os.open(sname, _DIR_OPEN, dir_fd=sfd)
    try:
        try:
            os.mkdir(dname, 0o755, dir_fd=dfd)
        except FileExistsError:
            if not merge:
                raise
        d = os.open(dname, _DIR_OPEN, dir_fd=dfd)
        try:
            with os.scandir(s) as it:
                entries = [(e.name, e.stat(follow_symlinks=False)) for e in it]
            for name, st in entries:
                if stat.S_ISLNK(st.st_mode):  # copied as a link (like copytree(symlinks=True)), never followed
                    with contextlib.suppress(FileExistsError):
                        os.symlink(os.readlink(name, dir_fd=s), name, dir_fd=d)
                elif stat.S_ISDIR(st.st_mode):
                    _copy_dir_at(s, name, d, name, merge=merge, depth=depth + 1, src_single=src_single,
                                 dst_single=dst_single)
                elif stat.S_ISREG(st.st_mode):
                    _copy_file_at(s, name, d, name, src_single=src_single, dst_single=dst_single)
        finally:
            os.close(d)
    finally:
        os.close(s)


class SafeTree:
    """Descriptor-relative, symlink-refusing access below one trusted base directory (`parts` = path components
    already validated by the caller: no '', '.', '..', '/' or NUL).

    single_link (default on): reads and writes refuse a regular file with more than one hard link, so a link that a
    process created inside the tree to a file outside it is never read or modified through the tree (H-03). Only
    the NEBULA-private exchange folder, which no agent process can write, turns it off."""

    def __init__(self, base: Path, *, single_link: bool = True) -> None:
        self.base = Path(base)
        self.single_link = single_link

    def dir_fd(self, parts: list[str], *, create: bool = False) -> int:
        """Descriptor of base/parts (caller closes); missing directories are created when `create`."""
        fd = os.open(self.base, _DIR_OPEN)
        try:
            for part in parts:
                _name_ok(part)
                try:
                    nfd = os.open(part, _DIR_OPEN, dir_fd=fd)
                except FileNotFoundError:
                    if not create:
                        raise
                    with contextlib.suppress(FileExistsError):
                        os.mkdir(part, 0o755, dir_fd=fd)
                    try:
                        nfd = os.open(part, _DIR_OPEN, dir_fd=fd)
                    except OSError as e:
                        _raise_if_link(e, part, fd)
                        raise
                except OSError as e:
                    _raise_if_link(e, part, fd)
                    if e.errno == errno.ENOTDIR:
                        raise HostExecError("not_a_directory", f"{part} is not a directory") from None
                    raise
                os.close(fd)
                fd = nfd
            return fd
        except BaseException:
            os.close(fd)
            raise

    @contextlib.contextmanager
    def parent(self, parts: list[str], *, create: bool = False):
        if not parts:
            raise HostExecError("refused", "this needs a path inside the folder, not the folder itself")
        fd = self.dir_fd(parts[:-1], create=create)
        try:
            yield fd, _name_ok(parts[-1])
        finally:
            os.close(fd)

    def lstat(self, parts: list[str]) -> os.stat_result | None:
        """lstat of base/parts (None if missing); a symlink as the last component is refused."""
        if not parts:
            fd = os.open(self.base, _DIR_OPEN)
            try:
                return os.fstat(fd)
            finally:
                os.close(fd)
        try:
            with self.parent(parts) as (fd, name):
                st = _lstat_at(name, fd)
        except FileNotFoundError:
            return None
        if st is not None and stat.S_ISLNK(st.st_mode):
            raise _symlink_error(parts[-1])
        return st

    def read(self, parts: list[str], limit: int, offset: int = 0) -> tuple[bytes, os.stat_result]:
        with self.parent(parts) as (fd, name):
            f = _open_file_at(fd, name, os.O_RDONLY, single_link=self.single_link)
        with os.fdopen(f, "rb") as fh:
            st = os.fstat(fh.fileno())
            if offset:
                fh.seek(offset)
            return fh.read(limit), st

    def write(self, parts: list[str], data: bytes, *, append: bool = False, mode: int = 0o644,
              create_parents: bool = True) -> tuple[bool, os.stat_result]:
        """(existed before, stat after). Truncation happens only after the regular-file check."""
        with self.parent(parts, create=create_parents) as (fd, name):
            existed = _lstat_at(name, fd) is not None
            f = _open_file_at(fd, name, os.O_WRONLY | os.O_CREAT | (os.O_APPEND if append else 0), mode,
                              single_link=self.single_link)
            with os.fdopen(f, "wb") as fh:
                if not append:
                    fh.truncate(0)
                fh.write(data)
                fh.flush()
                st = os.fstat(fh.fileno())
        return existed, st

    def listdir(self, parts: list[str]) -> list[tuple[str, os.stat_result]]:
        fd = self.dir_fd(parts)
        try:
            out = []
            with os.scandir(fd) as it:
                for e in it:
                    with contextlib.suppress(FileNotFoundError):
                        out.append((e.name, e.stat(follow_symlinks=False)))
            return out
        finally:
            os.close(fd)

    def mkdir(self, parts: list[str]) -> None:
        os.close(self.dir_fd(parts, create=True))

    def delete(self, parts: list[str], *, recursive: bool = False) -> None:
        with self.parent(parts) as (fd, name):
            st = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if stat.S_ISLNK(st.st_mode):
                raise _symlink_error(name)
            if stat.S_ISDIR(st.st_mode):
                if recursive:
                    shutil.rmtree(name, dir_fd=fd)  # fd-based on macOS/Linux: never follows symlinks
                else:
                    os.rmdir(name, dir_fd=fd)
            else:
                os.unlink(name, dir_fd=fd)

    def walk(self, parts: list[str], skip: tuple[str, ...] = ()):
        """os.fwalk below base/parts: yields (relative parts of the directory, dirnames, filenames, dir fd)."""
        fd = self.dir_fd(parts)
        try:
            for dirpath, dirnames, filenames, dfd in os.fwalk(".", dir_fd=fd, follow_symlinks=False):
                dirnames[:] = [d for d in dirnames if d not in skip]
                yield list(Path(dirpath).parts), dirnames, filenames, dfd
        finally:
            os.close(fd)


def safe_replace(src: SafeTree, sp: list[str], dst: SafeTree, dp: list[str], *, overwrite: bool) -> None:
    with src.parent(sp) as (sfd, sname), dst.parent(dp, create=True) as (dfd, dname):
        st = os.stat(sname, dir_fd=sfd, follow_symlinks=False)
        if stat.S_ISLNK(st.st_mode):
            raise _symlink_error(sname)
        if _lstat_at(dname, dfd) is not None and not overwrite:
            raise HostExecError("exists", "destination exists (set overwrite=true)", 409)
        os.replace(sname, dname, src_dir_fd=sfd, dst_dir_fd=dfd)


def safe_copy(src: SafeTree, sp: list[str], dst: SafeTree, dp: list[str], *, overwrite: bool) -> None:
    with src.parent(sp) as (sfd, sname), dst.parent(dp, create=True) as (dfd, dname):
        st = os.stat(sname, dir_fd=sfd, follow_symlinks=False)
        if stat.S_ISLNK(st.st_mode):
            raise _symlink_error(sname)
        if _lstat_at(dname, dfd) is not None and not overwrite:
            raise HostExecError("exists", "destination exists (set overwrite=true)", 409)
        if stat.S_ISDIR(st.st_mode):
            _copy_dir_at(sfd, sname, dfd, dname, merge=overwrite, src_single=src.single_link,
                         dst_single=dst.single_link)
        else:
            _copy_file_at(sfd, sname, dfd, dname, src_single=src.single_link, dst_single=dst.single_link)


# ============================================================================ authorised roots
def _forbidden_bases(cfg) -> list[Path]:
    home = Path.home().resolve()
    return [home / "Library", home / ".ssh", home / ".gnupg", home / ".aws", home / ".config" / "gcloud",
            home / ".kube", home / ".docker", Path(cfg.data_dir).resolve(), Path("/System"), Path("/Library"),
            Path("/private"), Path("/usr"), Path("/bin"), Path("/sbin"), Path("/opt"), Path("/Applications")]


def validate_root_path(cfg, raw: str) -> Path:
    if not raw or "\x00" in raw:
        raise HostExecError("invalid_path", "a directory path is required")
    p = Path(os.path.expanduser(raw.strip()))
    if not p.is_absolute():
        raise HostExecError("invalid_path", "use an absolute path (e.g. /Users/you/Projects/MyApp)")
    if not p.exists():
        raise HostExecError("not_found", f"{p} does not exist", 404)
    real = p.resolve()
    if not real.is_dir():
        raise HostExecError("not_a_directory", f"{real} is not a directory")
    home = Path.home().resolve()
    if os.environ.get("NEBULA_TESTING") == "1":  # automated tests authorise folders under the temp dir
        import tempfile

        tmp = Path(tempfile.gettempdir()).resolve()
        if tmp in real.parents and Path(cfg.data_dir).resolve() not in (real, *real.parents):
            return real
    if real in (Path("/"), home, home.parent, Path("/Users"), Path("/Volumes")):
        raise HostExecError("too_broad", "authorise a specific project folder, not your home or a system folder")
    for bad in _forbidden_bases(cfg):
        if real == bad or bad in real.parents:
            raise HostExecError("forbidden_location", f"{real} is inside a protected location ({bad})")
        if real in bad.parents:  # the root would contain a protected location
            raise HostExecError("too_broad", f"{real} contains the protected location {bad}")
    if not (home in real.parents or Path("/Volumes") in real.parents):
        raise HostExecError("forbidden_location", "project folders must live in your home folder or on /Volumes")
    return real


def list_roots() -> list[dict[str, Any]]:
    with db.engine().connect() as c:
        rows = db.rows(c.execute(select(models.host_project_roots).order_by(models.host_project_roots.c.created_at)))
    for r in rows:
        r["exists"] = Path(r["path"]).is_dir()
    return rows


def get_root(root_id: str) -> dict[str, Any]:
    with db.engine().connect() as c:
        r = db.row(c.execute(select(models.host_project_roots).where(models.host_project_roots.c.id == root_id)).first())
    if not r:
        raise HostExecError("root_not_found", "unknown host project root", 404)
    return r


def add_root(cfg, body: dict[str, Any], actor: str) -> dict[str, Any]:
    real = validate_root_path(cfg, str(body.get("path", "")))
    mode = body.get("mode", "read_write")
    if mode not in ("read_write", "read_only"):
        raise HostExecError("invalid_mode", "mode must be read_write or read_only")
    tools = [t for t in (body.get("allowed_tools") or []) if t in DEV_TOOLS]
    with db.engine().connect() as c:
        if c.execute(select(models.host_project_roots.c.id).where(models.host_project_roots.c.path == str(real))).first():
            raise HostExecError("exists", "this folder is already authorised", 409)
    rid = str(uuid.uuid4())
    now = db.now()
    with db.engine().begin() as c:
        c.execute(models.host_project_roots.insert().values(
            id=rid, name=(body.get("name") or real.name)[:128], path=str(real), mode=mode,
            allow_network=bool(body.get("allow_network", False)), allowed_tools=tools, enabled=True,
            created_by=actor[:128], created_at=now, updated_at=now))
    audit(actor, "host.root.authorise", str(real), {"root_id": rid, "mode": mode})
    return get_root(rid)


def update_root(root_id: str, body: dict[str, Any], actor: str) -> dict[str, Any]:
    get_root(root_id)
    vals: dict[str, Any] = {}
    if "name" in body and body["name"]:
        vals["name"] = str(body["name"])[:128]
    if "mode" in body:
        if body["mode"] not in ("read_write", "read_only"):
            raise HostExecError("invalid_mode", "mode must be read_write or read_only")
        vals["mode"] = body["mode"]
    for k in ("allow_network", "enabled"):
        if k in body:
            vals[k] = bool(body[k])
    if "allowed_tools" in body:
        vals["allowed_tools"] = [t for t in (body["allowed_tools"] or []) if t in DEV_TOOLS]
    vals["updated_at"] = db.now()
    with db.engine().begin() as c:
        c.execute(update(models.host_project_roots).where(models.host_project_roots.c.id == root_id).values(**vals))
    audit(actor, "host.root.update", root_id, {k: v for k, v in vals.items() if k != "updated_at"})
    return get_root(root_id)


def remove_root(root_id: str, actor: str) -> None:
    r = get_root(root_id)
    with db.engine().begin() as c:
        c.execute(models.host_project_roots.delete().where(models.host_project_roots.c.id == root_id))
    audit(actor, "host.root.revoke", r["path"], {"root_id": root_id})  # the folder itself is never touched


# ============================================================================ tool detection
_tool_cache: dict[str, Any] = {"at": 0.0, "tools": {}}


def detect_tools(force: bool = False) -> dict[str, dict[str, Any]]:
    if not force and time.time() - _tool_cache["at"] < 600:
        return _tool_cache["tools"]
    import subprocess

    out: dict[str, dict[str, Any]] = {}
    for name, vargs in DEV_TOOLS.items():
        exe = shutil.which(name, path=PATH_ENV)
        info: dict[str, Any] = {"available": bool(exe), "path": exe, "version": None}
        if exe:
            try:
                r = subprocess.run([exe, *vargs], capture_output=True, text=True, timeout=8,
                                   env={"PATH": PATH_ENV, "HOME": str(Path.home()), "LANG": "en_US.UTF-8"})
                line = (r.stdout or r.stderr).strip().splitlines()
                info["version"] = line[0][:120] if line else None
            except Exception as e:  # noqa: BLE001 - detection only
                info["version"] = f"(version probe failed: {type(e).__name__})"
        if name in TOOL_NOTES:
            info["note"] = TOOL_NOTES[name]
        out[name] = info
    _tool_cache.update(at=time.time(), tools=out)
    return out


def sandbox_available() -> bool:
    return os.path.exists(SANDBOX_EXEC) and os.access(SANDBOX_EXEC, os.X_OK)


def gui_permissions() -> dict[str, Any]:
    """Native macOS GUI control needs Accessibility + Screen Recording for the controlling process. NEBULA does not
    ship host GUI control; report that honestly together with what a future setup would require."""
    return {"available": False, "accessibility": "not_requested", "screen_recording": "not_requested",
            "detail": "Host GUI control (mouse/keyboard/screen of macOS) is not part of NEBULA. Host agents work "
                      "through files, terminal, git and developer tools only. Graphical work runs on the Ubuntu VM "
                      "desktop. Enabling it later would require granting Accessibility and Screen Recording to the "
                      "NEBULA helper in System Settings → Privacy & Security."}


# ============================================================================ sandbox profile
def _keychain_service() -> str:
    """This instance's Keychain service (the self-test proves the sandbox cannot read it): `dev.nebula.platform`
    for the default instance, `dev.nebula.platform.<id>` for another one, or NEBULA_KEYCHAIN_SERVICE."""
    return nebula_secrets.service_name()


def _sb_str(p: Path | str) -> str:
    return '"' + str(p).replace("\\", "\\\\").replace('"', '\\"') + '"'


def sandbox_profile(root: Path, home: Path, *, read_only: bool, network: bool) -> str:
    reads = ['(literal "/")', *[f'(subpath "{p}")' for p in (
        "/usr", "/bin", "/sbin", "/System", "/Library/Developer", "/Library/Frameworks", "/Library/Apple",
        "/Library/Preferences", "/opt/homebrew", "/private/etc", "/private/var/db/timezone", "/private/var/select",
        "/Applications/Xcode.app", "/dev")],
        '(literal "/private/var/db/xcode_select_link")', '(literal "/etc")', '(literal "/tmp")', '(literal "/var")',
        f"(subpath {_sb_str(root)})", f"(subpath {_sb_str(home)})"]
    writes = [f"(subpath {_sb_str(home)})", '(literal "/dev/null")', '(literal "/dev/zero")',
              '(literal "/dev/dtracehelper")', '(regex #"^/dev/tty")', '(regex #"^/dev/fd/")']
    if not read_only:
        writes.insert(0, f"(subpath {_sb_str(root)})")
    return "\n".join([
        "(version 1)", "(deny default)", '(import "system.sb")',
        "(allow process-fork)", "(allow process-exec)", "(allow signal (target same-sandbox))", "(allow sysctl-read)",
        "(allow file-read-metadata)", "(allow pseudo-tty)", "(allow file-ioctl)", "(allow ipc-posix-shm*)",
        "(allow ipc-posix-sem)", "(allow user-preference-read)",
        *_IOKIT_RULES,
        "(allow file-read* " + " ".join(reads) + ")",
        "(allow file-write* " + " ".join(writes) + ")",
        # xcrun / clang / swift caches live in the per-user temp+cache dirs: only these exact prefixes
        '(allow file-read* file-write* (regex #"^/private/var/folders/[^/]+/[^/]+/T/xcrun_db")'
        ' (regex #"^/private/var/folders/[^/]+/[^/]+/C/(clang|org\\.llvm\\.clang|org\\.swift\\.[^/]*|'
        'com\\.apple\\.DeveloperTools)(/|$)"))',
        "(allow mach-lookup)",
        "(deny mach-lookup " + " ".join(f'(global-name "{n}")' for n in DENIED_MACH_SERVICES) + ")",
        *(_NETWORK_RULES if network else [";; network disabled for this project root"]),
    ])


# Mach services a sandboxed command may never reach (audit L-06 / VM-17). mach-lookup stays allow-by-default:
# Xcode's tools need services that system.sb does not grant (with deny-by-default, xcodebuild no longer recognised
# a Swift package; it looks up FSEvents, DiskArbitration, LaunchServices and CoreSimulator services). So this is a
# denylist: Keychain, pasteboard, WindowServer, LaunchServices/open, TCC, and the services that would let an agent
# put dialogs or notifications in front of the owner, ask for Touch ID, send Apple Events, use AirDrop, fetch URLs
# in the background through a daemon, register login items, drive the Dock or record the screen. git, python3,
# node/npm, curl, swift/swiftc/clang, xcodebuild -version, go, ruby, ffmpeg and the self-test use none of them
# (checked with sandbox-exec on macOS 27, Apple silicon).
DENIED_MACH_SERVICES = (
    "com.apple.SecurityServer", "com.apple.securityd.xpc", "com.apple.security.agent",  # Keychain
    "com.apple.pasteboard.1", "com.apple.windowserver.active",
    "com.apple.coreservices.launchservicesd", "com.apple.CoreServices.coreservicesd",  # `open`, LaunchServices
    "com.apple.tccd", "com.apple.tccd.system",
    "com.apple.UNCUserNotification", "com.apple.UNCUserNotificationAgent",  # dialogs on the owner's screen
    "com.apple.CoreAuthentication.daemon", "com.apple.CoreAuthentication.agent",  # Touch ID / password prompts
    "com.apple.LocalAuthentication.UI", "com.apple.LocalAuthentication.userauthd",
    "com.apple.coreservices.appleevents",  # Apple Events to other apps
    "com.apple.sharingd", "com.apple.SharingServices",  # AirDrop / sharing
    "com.apple.usernoted.client", "com.apple.usernotifications.listener",
    "com.apple.usernotifications.usernotificationservice",  # notifications
    "com.apple.nsurlsessiond",  # background URL sessions: downloads/uploads done by a daemon, not the sandbox
    "com.apple.backgroundtaskmanagementagent", "com.apple.backgroundtaskmanagement",
    "com.apple.backgroundtaskmanagement.registrar", "com.apple.xpc.smd",  # login items / launch agents
    "com.apple.dock.server", "com.apple.replayd", "com.apple.screensharing.agent", "com.apple.ctkd.token-client",
)

# IOKit (audit L-06): only the GPU/graphics services and user clients, the same set as Apple's `system-graphics` in
# system.sb, so Metal and VideoToolbox (ffmpeg -c:v h264_videotoolbox) keep working. Every other driver user client
# (USB, HID, storage, ...) is denied: kernel attack surface that build tools do not need.
_IOKIT_RULES = [
    '(allow iokit-open-service (iokit-registry-entry-class "IOAccelerator" "IOSurfaceRoot" "IOFramebuffer" "AGPM"'
    ' "AppleGraphicsControl" "AppleGraphicsPolicy") (iokit-connection "AppleGraphicsDeviceControl"))',
    '(allow iokit-open-user-client (iokit-connection "IOAccelerator") (iokit-user-client-class'
    ' "IOAccelerationUserClient" "IOSurfaceAcceleratorClient" "IOSurfaceRootUserClient" "IOSurfaceSendRight"'
    ' "IOFramebufferSharedUserClient" "AppleIntelMEUserClient" "AppleSNBFBUserClient" "AGPMClient"'
    ' "AppleGraphicsControlClient" "AppleGraphicsPolicyClient" "AppleMGPUPowerControlClient"))',
]


# VM-03: even when a root allows network access, sandboxed commands never reach this Mac's own services: no unix
# sockets (Docker daemon, the VM helper's control socket, ...) and no address of the Mac itself (NEBULA's API/gateway,
# Ollama, dev servers): Seatbelt's "localhost" matches every local interface address, so 127.0.0.1, ::1, the LAN
# address and the vmnet bridge 192.168.64.1 are all denied (measured, see the module docstring). The denies come
# after the allow, so they win; name resolution (the mDNSResponder socket) stays possible.
_NETWORK_RULES = [
    "(allow network*)",
    "(deny network-outbound (remote unix-socket))",
    '(deny network-outbound (remote ip "localhost:*"))',
    '(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))',
]


def _limits(cpu_s: int):
    def apply() -> None:  # runs in the child before exec
        with contextlib.suppress(Exception):
            resource.setrlimit(resource.RLIMIT_CPU, (cpu_s, cpu_s + 5))
        with contextlib.suppress(Exception):
            resource.setrlimit(resource.RLIMIT_FSIZE, (1 << 30, 1 << 30))  # 1 GiB per file
        with contextlib.suppress(Exception):
            resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    return apply


# ============================================================================ executor
class HostExecutor:
    def __init__(self, cfg) -> None:
        self.cfg = cfg
        self.procs: dict[str, dict[str, Any]] = {}  # bg id -> {proc, agent_id, log, started, cmd, root_id}
        self.running = 0
        self.sem = asyncio.Semaphore(4)  # concurrent host commands (all agents)

    # ------------------------------------------------------------------ paths
    def home_for(self, agent_id: str) -> Path:
        if not re.fullmatch(r"[0-9a-f-]{8,36}", agent_id or ""):
            raise HostExecError("invalid_agent", "bad agent id")
        base = Path(self.cfg.data_dir) / "hosthome"
        h = base / agent_id
        for d in (base, h, h / "tmp", h / "inbox", h / ".nebula"):
            d.mkdir(parents=True, exist_ok=True)
            os.chmod(d, 0o700)
        return h.resolve()

    def _confine(self, root: Path, home: Path, raw: str | None, *, must_exist: bool = False) -> Path:
        rel = (raw or ".").strip()
        if "\x00" in rel:
            raise HostExecError("invalid_path", "NUL in path")
        if rel.startswith("~/"):
            rel = str(home / rel[2:])
        base = root
        p = Path(rel)
        if p.is_absolute():
            rp = Path(os.path.normpath(rel))
            if rp == root or root in rp.parents:
                base, p = root, rp.relative_to(root)
            elif rp == home or home in rp.parents:
                base, p = home, rp.relative_to(home)
            else:
                raise HostExecError("path_outside_root", f"{rel} is outside the authorised project folder")
        cur = base
        for part in p.parts:
            if part == "..":
                raise HostExecError("path_outside_root", "'..' is not allowed")
            if part in ("", "."):
                continue
            cur = cur / part
            try:
                st = os.lstat(cur)
            except FileNotFoundError:
                if must_exist:
                    raise HostExecError("not_found", f"{rel} does not exist", 404) from None
                break
            if stat.S_ISLNK(st.st_mode):
                raise HostExecError("symlink_rejected", f"{part} is a symlink; symlinks are not followed")
        full = (base / p).resolve() if p.parts else base
        if full != base and base not in full.parents:
            raise HostExecError("path_outside_root", "path resolves outside the authorised folder")
        return full

    def _locate(self, root: Path, home: Path, raw: str | None) -> tuple[SafeTree, list[str]]:
        """(trusted base, validated components) for a file-tool path: the project root or the agent's home. The
        file system is only touched later, through SafeTree (descriptor-relative, no symlinks)."""
        rel = (raw or ".").strip()
        if "\x00" in rel:
            raise HostExecError("invalid_path", "NUL in path")
        if rel == "~":
            rel = str(home)
        elif rel.startswith("~/"):
            rel = str(home / rel[2:])
        base, p = root, Path(rel)
        if p.is_absolute():
            rp = Path(os.path.normpath(rel))
            if ".." in Path(rel).parts:
                raise HostExecError("path_outside_root", "'..' is not allowed")
            if rp == root or root in rp.parents:
                base, p = root, rp.relative_to(root)
            elif rp == home or home in rp.parents:
                base, p = home, rp.relative_to(home)
            else:
                raise HostExecError("path_outside_root", f"{rel} is outside the authorised project folder")
        parts: list[str] = []
        for part in p.parts:
            if part == "..":
                raise HostExecError("path_outside_root", "'..' is not allowed")
            if part in ("", "."):
                continue
            parts.append(_name_ok(part))
        return SafeTree(base), parts

    def _display(self, root: Path, home: Path, p: Path) -> str:
        if p == root:
            return "."
        if root in p.parents:
            return str(p.relative_to(root))
        return "~/" + str(p.relative_to(home)) if home in p.parents else str(p)

    # ------------------------------------------------------------------ entry point
    async def tool(self, agent_id: str, task_id: str | None, root_id: str, name: str, args: dict[str, Any]) -> dict[str, Any]:
        t0 = time.time()
        try:
            root_row = get_root(root_id)
            if not root_row["enabled"]:
                raise HostExecError("root_disabled", "this host project folder is disabled by the owner")
            root = Path(root_row["path"]).resolve()
            if not root.is_dir():
                raise HostExecError("root_missing", f"{root} no longer exists")
            home = self.home_for(agent_id)
            ro = root_row["mode"] == "read_only"
            if ro and name in MUTATING:
                raise HostExecError("read_only", "this project folder is authorised read-only")
            fn = getattr(self, "_t_" + name.replace(".", "_"), None)
            if fn is None:
                raise HostExecError("unsupported", f"{name} is not available on the host (VM-only tool)")
            result = await fn(root, home, root_row, agent_id, args)
            self._audit(agent_id, task_id, root_id, name, args, "ok", result, t0)
            return {"ok": True, "result": result}
        except HostExecError as e:
            self._audit(agent_id, task_id, root_id, name, args, "denied" if e.code in (
                "read_only", "path_outside_root", "symlink_rejected", "hardlink_rejected", "tool_not_allowed")
                else "error",
                {"error": e.message}, t0)
            return {"ok": False, "error": {"code": e.code, "message": e.message}}
        except FileNotFoundError as e:
            self._audit(agent_id, task_id, root_id, name, args, "error", {"error": str(e)}, t0)
            return {"ok": False, "error": {"code": "not_found", "message": str(e)}}
        except OSError as e:
            self._audit(agent_id, task_id, root_id, name, args, "error", {"error": str(e)}, t0)
            return {"ok": False, "error": {"code": type(e).__name__, "message": str(e)}}

    def _audit(self, agent_id, task_id, root_id, name, args, status, result, t0) -> None:
        cmd = args.get("command") or (" ".join(map(str, args.get("args") or [])) if name == "git.run" else None) \
            or args.get("path") or args.get("src") or ""
        if name in ("python.run", "node.run") and args.get("code"):
            cmd = f"<{len(str(args['code']))} chars of code>"
        exit_code = result.get("exit_code") if isinstance(result, dict) else None
        if status == "ok" and exit_code not in (None, 0):
            status = "timeout" if result.get("timed_out") else "error"
        with db.engine().begin() as c:
            c.execute(models.host_commands.insert().values(
                ts=db.now(), agent_id=agent_id, task_id=task_id, root_id=root_id, tool=name, command=str(cmd)[:2000],
                cwd=str(args.get("cwd") or "."), status=status, exit_code=exit_code,
                duration_ms=int((time.time() - t0) * 1000),
                detail=(result.get("error") if isinstance(result, dict) else None)))
        if name in MUTATING or name in ("shell.execute", "process.start", "git.run", "python.run", "node.run",
                                        "process.kill"):
            audit(f"agent:{agent_id}", f"host.{name}", root_id, {"task_id": task_id, "status": status,
                                                                 "command": str(cmd)[:300]})

    # ------------------------------------------------------------------ process execution
    def _env(self, home: Path, root: Path) -> dict[str, str]:
        return {"PATH": PATH_ENV, "HOME": str(home), "TMPDIR": str(home / "tmp") + "/", "LANG": "en_US.UTF-8",
                "LC_ALL": "en_US.UTF-8", "TERM": "dumb", "USER": os.environ.get("USER", "nebula"),
                "NEBULA_PROJECT_ROOT": str(root), "GIT_TERMINAL_PROMPT": "0", "NO_COLOR": "1",
                "npm_config_update_notifier": "false", "PIP_DISABLE_PIP_VERSION_CHECK": "1"}

    def _check_tool(self, root_row: dict[str, Any], argv0: str) -> None:
        allowed = root_row.get("allowed_tools") or []
        if allowed and argv0 not in allowed and argv0 not in ("bash", "sh"):
            raise HostExecError("tool_not_allowed", f"{argv0} is not in this project's allowed tools ({', '.join(allowed)})")

    @staticmethod
    def _check_command(root_row: dict[str, Any], command: str) -> None:
        """VM-08: the project's allowed tools apply to EVERY program the command line names (`a; b`, `a && b`,
        pipes, `$(...)`), not just the first word. Shell builtins and plain text utilities stay allowed; a line
        that cannot be analysed (bash -c, eval, variables as program names, ...) is refused while a list is set.
        A convenience filter: the Seatbelt sandbox is the security boundary."""
        bad = allowed_tools_violation(command, root_row.get("allowed_tools") or [])
        if bad:
            raise HostExecError("tool_not_allowed", bad)

    async def _spawn(self, argv: list[str], *, root: Path, home: Path, root_row: dict[str, Any], cwd: Path,
                     timeout: int, stdin: bytes | None = None) -> dict[str, Any]:
        if not sandbox_available():
            raise HostExecError("sandbox_unavailable", "macOS sandbox-exec is unavailable; host commands are disabled")
        profile = sandbox_profile(root, home, read_only=root_row["mode"] == "read_only",
                                  network=bool(root_row["allow_network"]))
        started = time.time()
        async with self.sem:
            self.running += 1
            try:
                proc = await asyncio.create_subprocess_exec(
                    SANDBOX_EXEC, "-p", profile, *argv, cwd=str(cwd), env=self._env(home, root),
                    stdin=asyncio.subprocess.PIPE if stdin is not None else asyncio.subprocess.DEVNULL,
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, start_new_session=True,
                    preexec_fn=_limits(timeout + 30))
                timed_out = False
                try:
                    out, err = await asyncio.wait_for(proc.communicate(stdin), timeout)
                except TimeoutError:
                    timed_out = True
                    with contextlib.suppress(ProcessLookupError):
                        os.killpg(proc.pid, signal.SIGKILL)
                    out, err = await proc.communicate()
            finally:
                self.running -= 1
        return {"exit_code": proc.returncode, "timed_out": timed_out, "elapsed_s": round(time.time() - started, 3),
                "stdout": out[:MAX_OUTPUT].decode(errors="replace"), "stdout_truncated": len(out) > MAX_OUTPUT,
                "stderr": err[:MAX_OUTPUT].decode(errors="replace"), "stderr_truncated": len(err) > MAX_OUTPUT,
                "cwd": self._display(root, home, cwd), "environment": "host"}

    @staticmethod
    def _timeout(args: dict[str, Any], default: int = 60) -> int:
        try:
            return min(max(int(args.get("timeout", default)), 1), 900)
        except (TypeError, ValueError):
            return default

    async def _t_shell_execute(self, root, home, rr, agent_id, args):
        command = str(args.get("command", ""))
        if not command.strip() or len(command) > 8000:
            raise HostExecError("invalid_argument", "command required (<= 8000 chars)")
        self._check_command(rr, command)
        cwd = self._confine(root, home, args.get("cwd"), must_exist=True)
        return await self._spawn(["/bin/bash", "--noprofile", "--norc", "-c", command], root=root, home=home,
                                 root_row=rr, cwd=cwd, timeout=self._timeout(args))

    async def _t_git_run(self, root, home, rr, agent_id, args):
        argv = [str(a) for a in (args.get("args") or [])][:60]
        if not argv:
            raise HostExecError("invalid_argument", "args required, e.g. [\"status\"]")
        bad = None
        if argv[0].startswith("-") and argv[0] not in ("--version", "--no-pager"):
            bad = argv[0]  # global options (-c, -C, --exec-path, --git-dir, --config-env, …) are not allowed
        for x in argv:
            if x in ("-c", "--config", "--config-env") or x.startswith(("--upload-pack", "--receive-pack", "--exec",
                                                                        "--config=", "--template", "--git-dir",
                                                                        "--work-tree", "--ext-diff")):
                bad = bad or x
        if argv[0] in ("clone", "fetch", "pull", "ls-remote", "archive") and "-u" in argv:
            bad = bad or "-u"
        if bad:
            raise HostExecError("invalid_argument", f"git option {bad} is not allowed")
        self._check_tool(rr, "git")
        cwd = self._confine(root, home, args.get("cwd"), must_exist=True)
        return await self._spawn(["/usr/bin/git", *argv], root=root, home=home, root_row=rr, cwd=cwd,
                                 timeout=self._timeout(args, 120))

    async def _run_code(self, root, home, rr, args, interp: list[str], suffix: str, tool: str):
        self._check_tool(rr, tool)
        cwd = self._confine(root, home, args.get("cwd"), must_exist=True)
        if args.get("path"):
            script = self._confine(root, home, str(args["path"]), must_exist=True)
        else:
            code = str(args.get("code", ""))
            if not code.strip() or len(code) > 200_000:
                raise HostExecError("invalid_argument", "code or path required")
            d = home / ".nebula" / "scratch"
            d.mkdir(parents=True, exist_ok=True)
            script = d / f"snippet-{int(time.time() * 1000)}{suffix}"
            script.write_text(code)
        extra = [str(a) for a in (args.get("args") or [])][:50]
        return await self._spawn([*interp, str(script), *extra], root=root, home=home, root_row=rr, cwd=cwd,
                                 timeout=self._timeout(args))

    async def _t_python_run(self, root, home, rr, agent_id, args):
        exe = shutil.which("python3", path=PATH_ENV) or "/usr/bin/python3"
        return await self._run_code(root, home, rr, args, [exe, "-I"], ".py", "python3")

    async def _t_node_run(self, root, home, rr, agent_id, args):
        exe = shutil.which("node", path=PATH_ENV)
        if not exe:
            raise HostExecError("tool_missing", "Node.js is not installed on this Mac")
        return await self._run_code(root, home, rr, args, [exe], ".js", "node")

    async def _t_pdf_text(self, root, home, rr, agent_id, args):
        exe = shutil.which("pdftotext", path=PATH_ENV)
        if not exe:
            raise HostExecError("tool_missing", "pdftotext (poppler) is not installed on this Mac")
        p = self._confine(root, home, args.get("path"), must_exist=True)
        argv = [exe, "-layout", "-enc", "UTF-8"]
        if args.get("first_page"):
            argv += ["-f", str(int(args["first_page"]))]
        if args.get("last_page"):
            argv += ["-l", str(int(args["last_page"]))]
        r = await self._spawn([*argv, str(p), "-"], root=root, home=home, root_row=rr, cwd=root, timeout=120)
        if r["exit_code"] != 0:
            raise HostExecError("pdf_failed", r["stderr"][:300] or "pdftotext failed")
        return {"path": self._display(root, home, p), "text": r["stdout"][:200_000], "truncated": r["stdout_truncated"]}

    # ------------------------------------------------------------------ background processes
    async def _t_process_start(self, root, home, rr, agent_id, args):
        command = str(args.get("command", ""))
        if not command.strip():
            raise HostExecError("invalid_argument", "command required")
        self._check_command(rr, command)  # VM-08: the same whole-command allow-list as shell_execute
        self._reap()
        mine = [p for p in self.procs.values() if p["agent_id"] == agent_id and p["proc"].returncode is None]
        if len(mine) >= MAX_BG_PER_AGENT:
            raise HostExecError("limit", f"at most {MAX_BG_PER_AGENT} background processes per agent")
        if not sandbox_available():
            raise HostExecError("sandbox_unavailable", "macOS sandbox-exec is unavailable")
        cwd = self._confine(root, home, args.get("cwd"), must_exist=True)
        pid_name = f"hp{uuid.uuid4().hex[:8]}"
        logp = home / ".nebula" / f"{pid_name}.log"
        fd = os.open(logp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        profile = sandbox_profile(root, home, read_only=rr["mode"] == "read_only", network=bool(rr["allow_network"]))
        proc = await asyncio.create_subprocess_exec(
            SANDBOX_EXEC, "-p", profile, "/bin/bash", "--noprofile", "--norc", "-c", command, cwd=str(cwd),
            env=self._env(home, root), stdin=asyncio.subprocess.DEVNULL, stdout=fd, stderr=fd,
            start_new_session=True, preexec_fn=_limits(BG_MAX_LIFETIME))
        os.close(fd)
        self.procs[pid_name] = {"proc": proc, "agent_id": agent_id, "log": logp, "started": time.time(),
                                "cmd": command[:300], "root_id": rr["id"]}
        await asyncio.sleep(0.5)
        return {"id": pid_name, "pid": proc.pid, "running": proc.returncode is None, "environment": "host"}

    async def _t_process_output(self, root, home, rr, agent_id, args):
        p = self.procs.get(str(args.get("id", "")))
        if not p or p["agent_id"] != agent_id:
            raise HostExecError("not_found", "no such background process", 404)
        data = p["log"].read_bytes() if p["log"].exists() else b""
        return {"id": args["id"], "running": p["proc"].returncode is None, "exit_code": p["proc"].returncode,
                "output": data[-MAX_OUTPUT:].decode(errors="replace"), "bytes": len(data)}

    async def _t_process_list(self, root, home, rr, agent_id, args):
        self._reap()
        return {"processes": [{"id": k, "pid": v["proc"].pid, "command": v["cmd"], "running": v["proc"].returncode is None,
                               "started": v["started"]} for k, v in self.procs.items() if v["agent_id"] == agent_id]}

    async def _t_process_kill(self, root, home, rr, agent_id, args):
        target = args.get("id") or args.get("pid")
        for k, v in self.procs.items():
            if v["agent_id"] == agent_id and (k == target or str(v["proc"].pid) == str(target)):
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(v["proc"].pid, signal.SIGTERM)
                return {"terminated": v["proc"].pid, "id": k}
        raise HostExecError("not_found", "not one of this agent's host processes", 404)

    def _reap(self) -> None:
        now = time.time()
        for k, v in list(self.procs.items()):
            if v["proc"].returncode is None and now - v["started"] > BG_MAX_LIFETIME:
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(v["proc"].pid, signal.SIGKILL)
            if v["proc"].returncode is not None and now - v["started"] > 3600:
                self.procs.pop(k, None)

    async def kill_agent_processes(self, agent_id: str) -> int:
        n = 0
        for v in self.procs.values():
            if v["agent_id"] == agent_id and v["proc"].returncode is None:
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(v["proc"].pid, signal.SIGKILL)
                n += 1
        return n

    async def shutdown(self) -> None:
        for v in self.procs.values():
            if v["proc"].returncode is None:
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(v["proc"].pid, signal.SIGKILL)

    # ------------------------------------------------------------------ files (in-process, confined)
    # Every file tool goes through SafeTree: components are opened relative to their parent's descriptor with
    # O_NOFOLLOW, so a sandboxed process that swaps a directory for a symlink mid-call is refused (H-03).
    @staticmethod
    def _kind(st: os.stat_result) -> str:
        return "symlink" if stat.S_ISLNK(st.st_mode) else "dir" if stat.S_ISDIR(st.st_mode) else "file"

    async def _t_files_list(self, root, home, rr, agent_id, args):
        t, parts = self._locate(root, home, args.get("path"))
        if t.lstat(parts) is None:
            raise HostExecError("not_found", f"{args.get('path')} does not exist", 404)
        entries = [{"name": n, "type": self._kind(st), "size": st.st_size, "mtime": int(st.st_mtime)}
                   for n, st in sorted(t.listdir(parts), key=lambda x: x[0].lower())[:500]]
        return {"path": self._display(root, home, t.base.joinpath(*parts)), "entries": entries, "environment": "host"}

    async def _t_files_read(self, root, home, rr, agent_id, args):
        t, parts = self._locate(root, home, args.get("path"))
        limit = min(int(args.get("max_bytes") or MAX_READ), MAX_READ)
        if not parts:
            raise HostExecError("not_a_file", str(args.get("path")))
        data, st = t.read(parts, limit + 1)
        return {"path": self._display(root, home, t.base.joinpath(*parts)),
                "content": data[:limit].decode(errors="replace"), "truncated": len(data) > limit, "size": st.st_size}

    async def _t_files_stat(self, root, home, rr, agent_id, args):
        t, parts = self._locate(root, home, args.get("path"))
        st = t.lstat(parts)
        if st is None:
            raise HostExecError("not_found", f"{args.get('path')} does not exist", 404)
        return {"path": self._display(root, home, t.base.joinpath(*parts)),
                "type": "dir" if stat.S_ISDIR(st.st_mode) else "file", "size": st.st_size, "mtime": int(st.st_mtime)}

    async def _t_files_search(self, root, home, rr, agent_id, args):
        t, parts = self._locate(root, home, args.get("path"))
        if t.lstat(parts) is None:
            raise HostExecError("not_found", f"{args.get('path')} does not exist", 404)
        pat, contains = str(args.get("pattern") or "").lower(), str(args.get("contains") or "")
        hits: list[dict[str, Any]] = []
        skip = (".git", "node_modules", ".build", "build", "DerivedData", ".venv", "__pycache__")
        for rel, _dns, fns, dfd in t.walk(parts, skip):
            for n in fns:
                if pat and pat not in n.lower():
                    continue
                st = _lstat_at(n, dfd)
                if st is None or not stat.S_ISREG(st.st_mode):
                    continue  # symlinks and special files are never opened
                shown = t.base.joinpath(*parts, *rel, n)
                if contains:
                    if SECRET_FILE_RE.search(str(shown)) or st.st_size > 2_000_000:
                        continue
                    try:
                        fd = _open_file_at(dfd, n, os.O_RDONLY, single_link=t.single_link)
                        with os.fdopen(fd, "rb") as fh:
                            if contains not in fh.read(2_000_001).decode(errors="ignore"):
                                continue
                    except (OSError, HostExecError):
                        continue
                hits.append({"path": self._display(root, home, shown), "size": st.st_size})
                if len(hits) >= 200:
                    return {"results": hits, "truncated": True}
        return {"results": hits, "truncated": False}

    async def _t_files_write(self, root, home, rr, agent_id, args):
        t, parts = self._locate(root, home, args.get("path"))
        data = base64.b64decode(str(args["content_b64"]), validate=True) if args.get("content_b64") \
            else str(args.get("content", "")).encode()
        if len(data) > MAX_WRITE:
            raise HostExecError("too_large", "content exceeds 4 MiB")
        existed, _st = t.write(parts, data, append=bool(args.get("append")))
        return {"path": self._display(root, home, t.base.joinpath(*parts)), "bytes_written": len(data),
                "append": bool(args.get("append")), "overwrote": existed and not args.get("append"),
                "environment": "host"}

    async def _t_files_edit(self, root, home, rr, agent_id, args):
        t, parts = self._locate(root, home, args.get("path"))
        if t.lstat(parts) is None:
            raise HostExecError("not_found", f"{args.get('path')} does not exist", 404)
        raw, _st = t.read(parts, MAX_WRITE + 1)
        text = raw.decode()
        find, rep = str(args.get("find", "")), str(args.get("replace", ""))
        if not find or find not in text:
            raise HostExecError("not_found", "text to replace was not found")
        n = text.count(find)
        text = text.replace(find, rep) if args.get("all") else text.replace(find, rep, 1)
        t.write(parts, text.encode(), create_parents=False)
        return {"path": self._display(root, home, t.base.joinpath(*parts)), "replacements": n if args.get("all") else 1}

    async def _t_files_mkdir(self, root, home, rr, agent_id, args):
        t, parts = self._locate(root, home, args.get("path"))
        t.mkdir(parts)
        return {"created": self._display(root, home, t.base.joinpath(*parts))}

    async def _t_files_move(self, root, home, rr, agent_id, args):
        st, sp = self._locate(root, home, args.get("src"))
        dt, dp = self._locate(root, home, args.get("dst"))
        if st.lstat(sp) is None:
            raise HostExecError("not_found", f"{args.get('src')} does not exist", 404)
        safe_replace(st, sp, dt, dp, overwrite=bool(args.get("overwrite")))
        return {"moved": self._display(root, home, st.base.joinpath(*sp)),
                "to": self._display(root, home, dt.base.joinpath(*dp))}

    async def _t_files_copy(self, root, home, rr, agent_id, args):
        st, sp = self._locate(root, home, args.get("src"))
        dt, dp = self._locate(root, home, args.get("dst"))
        if st.lstat(sp) is None:
            raise HostExecError("not_found", f"{args.get('src')} does not exist", 404)
        safe_copy(st, sp, dt, dp, overwrite=bool(args.get("overwrite")))
        return {"copied": self._display(root, home, st.base.joinpath(*sp)),
                "to": self._display(root, home, dt.base.joinpath(*dp))}

    async def _t_files_delete(self, root, home, rr, agent_id, args):
        t, parts = self._locate(root, home, args.get("path"))
        if not parts:
            raise HostExecError("refused", "the project root itself cannot be deleted")
        if t.lstat(parts) is None:
            raise HostExecError("not_found", f"{args.get('path')} does not exist", 404)
        t.delete(parts, recursive=bool(args.get("recursive")))
        return {"deleted": self._display(root, home, t.base.joinpath(*parts)), "recursive": bool(args.get("recursive"))}

    # ------------------------------------------------------------------ owner-side helpers
    async def git_status(self, root_id: str) -> dict[str, Any]:
        """Read-only git summary for the project UI (runs sandboxed, network off)."""
        rr = {**get_root(root_id), "allow_network": False, "mode": "read_only", "allowed_tools": []}
        root = Path(rr["path"]).resolve()
        if not (root / ".git").exists():
            return {"repository": False}
        home = self.home_for("00000000-0000-0000-0000-000000000000")
        r = await self._spawn(["/usr/bin/git", "status", "--porcelain=v1", "-b"], root=root, home=home, root_row=rr,
                              cwd=root, timeout=20)
        lg = await self._spawn(["/usr/bin/git", "log", "-5", "--pretty=format:%h\t%ad\t%s", "--date=short"], root=root,
                               home=home, root_row=rr, cwd=root, timeout=20)
        lines = r["stdout"].splitlines()
        return {"repository": True, "branch": lines[0][3:] if lines and lines[0].startswith("##") else None,
                "changes": [ln for ln in lines[1:]][:100], "clean": len(lines) <= 1 and r["exit_code"] == 0,
                "recent_commits": [dict(zip(("hash", "date", "subject"), ln.split("\t", 2), strict=False))
                                   for ln in lg["stdout"].splitlines()],
                "error": r["stderr"][:300] if r["exit_code"] else None}

    async def selftest(self, root_id: str) -> dict[str, Any]:
        """Fixed, read-only probes proving that native execution works AND that the sandbox holds (no user input).
        The network probes run with network access ON, so they prove the loopback / unix-socket denials (VM-03)."""
        import socket
        import tempfile

        rr = get_root(root_id)
        root = Path(rr["path"]).resolve()
        agent = "00000000-0000-0000-0000-000000000000"
        home = self.home_for(agent)
        data = str(Path(self.cfg.data_dir).resolve())
        sh = ["/bin/bash", "--noprofile", "--norc", "-c"]
        probes: list[tuple[str, list[str], str, bool]] = [
            ("cwd_is_project", ["/bin/pwd"], "expect_stdout:" + str(root), False),
            ("git", ["/usr/bin/git", "--version"], "expect_ok", False),
            ("python3", [*sh, "python3 -c 'import sys; print(sys.platform)'"], "expect_stdout:darwin", False),
            ("node", [*sh, "node --version"], "expect_ok_if_installed:node", False),
            ("write_home", [*sh, "echo probe > ~/probe.txt && cat ~/probe.txt"], "expect_stdout:probe", False),
            ("deny_user_library", ["/bin/ls", str(Path.home() / "Library")], "expect_fail", False),
            ("deny_nebula_data", ["/bin/cat", f"{data}/config.yaml"], "expect_fail", False),
            ("deny_ssh", ["/bin/ls", str(Path.home() / ".ssh")], "expect_fail", False),
            ("deny_keychain", ["/usr/bin/security", "find-generic-password", "-s", _keychain_service()],
             "expect_fail", False),
            ("deny_write_outside", [*sh, f"echo x > '{Path.home()}/.nebula-sandbox-escape-probe'"], "expect_fail",
             False),
        ]
        # negative network probes (network ON): a loopback listener and a unix socket opened just for this test,
        # plus the Docker daemon and the VM helper's control socket when they exist. Nothing is sent.
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.bind(("127.0.0.1", 0))
        listener.listen(4)
        sock_dir = Path(tempfile.mkdtemp(prefix="nebula-sb-"))
        unix_path = str(home / ".nebula" / "selftest.sock")
        if len(unix_path) > 100:  # AF_UNIX path limit
            unix_path = str(sock_dir / "s.sock")
        with contextlib.suppress(FileNotFoundError):
            os.unlink(unix_path)
        unix = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        unix.bind(unix_path)
        unix.listen(4)
        probes += [("deny_loopback_tcp", ["/usr/bin/nc", "-z", "-w", "3", "127.0.0.1",
                                          str(listener.getsockname()[1])], "expect_fail", True),
                   ("deny_unix_socket", ["/usr/bin/nc", "-U", unix_path], "expect_fail", True)]
        for name, path in (("deny_docker_socket", "/var/run/docker.sock"),
                           ("deny_docker_socket_user", str(Path.home() / ".docker" / "run" / "docker.sock")),
                           ("deny_vm_control_socket", str(Path(self.cfg.vm_bundle) / "run" / "control.sock"))):
            if os.path.exists(path):
                probes.append((name, ["/usr/bin/nc", "-U", path], "expect_fail", True))
        out = []
        tools = detect_tools()
        try:
            for name, argv, expect, network in probes:
                r = await self._spawn(argv, root=root, home=home, root_row={**rr, "allow_network": network},
                                      cwd=root, timeout=30)
                ok_run = r["exit_code"] == 0
                if expect == "expect_ok":
                    passed = ok_run
                elif expect == "expect_fail":
                    passed = not ok_run
                elif expect.startswith("expect_ok_if_installed:"):
                    passed = ok_run if tools.get(expect.split(":", 1)[1], {}).get("available") else True
                else:
                    passed = ok_run and expect.split(":", 1)[1] in r["stdout"]
                out.append({"probe": name, "passed": passed, "exit_code": r["exit_code"],
                            "output": (r["stdout"] or r["stderr"]).strip()[:200]})
        finally:
            listener.close()
            unix.close()
            with contextlib.suppress(OSError):
                os.unlink(unix_path)
            shutil.rmtree(sock_dir, ignore_errors=True)
        escaped = (Path.home() / ".nebula-sandbox-escape-probe")
        if escaped.exists():  # must never happen; clean up and report
            escaped.unlink()
            out.append({"probe": "escape_file_absent", "passed": False})
        audit("owner", "host.selftest", root_id, {"passed": all(p["passed"] for p in out)})
        return {"root": rr["path"], "passed": all(p["passed"] for p in out), "probes": out}

    def recent_commands(self, root_id: str | None = None, agent_id: str | None = None, limit: int = 100) -> list[dict]:
        with db.engine().connect() as c:
            q = select(models.host_commands)
            if root_id:
                q = q.where(models.host_commands.c.root_id == root_id)
            if agent_id:
                q = q.where(models.host_commands.c.agent_id == agent_id)
            return db.rows(c.execute(q.order_by(models.host_commands.c.id.desc()).limit(min(limit, 500))))

    def status(self) -> dict[str, Any]:
        return {"sandbox": sandbox_available(), "running_commands": self.running,
                "background_processes": sum(1 for v in self.procs.values() if v["proc"].returncode is None),
                "roots": len(list_roots()), "gui_control": gui_permissions()}


def dumps(o: Any) -> str:
    return json.dumps(o, ensure_ascii=False)
