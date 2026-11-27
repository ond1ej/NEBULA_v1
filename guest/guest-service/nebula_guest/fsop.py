"""One file-manager operation, executed AS the agent's unprivileged Linux user (runuser), so the kernel enforces
ownership and group permissions in addition to NEBULA's own confinement (no '..', no symlinks, O_NOFOLLOW).

stdin: {"root": "/home/<user>/workspace" | "/srv/nebula/shared/<key>", "op": ..., ...}  stdout: JSON result.
"""

from __future__ import annotations

import base64
import json
import os
import shutil
import stat
import sys
from pathlib import Path
from typing import Any

MAX_CHUNK = 4 * 1024 * 1024
VERSIONS_DIR = ".nebula_versions"
KEEP_VERSIONS = 5


class FsError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def confine(root: Path, rel: str | None) -> Path:
    rel = (rel or ".").lstrip("/")
    if "\x00" in rel:
        raise FsError("invalid_path", "NUL in path")
    cand = root / rel if rel not in ("", ".") else root
    cur = root
    for part in cand.relative_to(root).parts:
        if part == "..":
            raise FsError("path_outside_root", "'..' is not allowed")
        cur = cur / part
        try:
            st = os.lstat(cur)
        except FileNotFoundError:
            break
        if stat.S_ISLNK(st.st_mode):
            raise FsError("symlink_rejected", f"symlink in path: {cur.relative_to(root)}")
    res = cand.resolve()
    if res != root and root not in res.parents:
        raise FsError("path_outside_root", "path resolves outside the allowed directory")
    return res


def rel(root: Path, p: Path) -> str:
    return "." if p == root else str(p.relative_to(root))


def entry(root: Path, p: Path) -> dict[str, Any]:
    st = os.lstat(p)
    kind = "symlink" if stat.S_ISLNK(st.st_mode) else "dir" if stat.S_ISDIR(st.st_mode) else "file"
    return {"name": p.name, "path": rel(root, p), "type": kind, "size": st.st_size, "mtime": int(st.st_mtime)}


def keep_version(root: Path, p: Path) -> None:
    if not p.is_file():
        return
    vd = root / VERSIONS_DIR / rel(root, p.parent)
    vd.mkdir(parents=True, exist_ok=True)
    import time

    shutil.copyfile(p, vd / f"{p.name}.{int(time.time())}", follow_symlinks=False)
    old = sorted(vd.glob(f"{p.name}.*"), key=lambda x: x.stat().st_mtime)
    for o in old[:-KEEP_VERSIONS]:
        o.unlink(missing_ok=True)


def run(req: dict[str, Any]) -> dict[str, Any]:
    root = Path(req["root"]).resolve()
    if not root.is_dir():
        raise FsError("no_root", "directory does not exist")
    op = req.get("op")
    p = confine(root, req.get("path"))
    if op == "list":
        if not p.is_dir():
            raise FsError("not_a_directory", rel(root, p))
        items = [entry(root, c) for c in sorted(p.iterdir(), key=lambda x: (not x.is_dir(), x.name.lower()))
                 if c.name != VERSIONS_DIR][:2000]
        return {"path": rel(root, p), "entries": items}
    if op == "stat":
        if not os.path.lexists(p):
            raise FsError("not_found", rel(root, p))
        return entry(root, p)
    if op == "read":
        if not p.is_file():
            raise FsError("not_a_file", rel(root, p))
        off, ln = int(req.get("offset", 0)), min(int(req.get("length", MAX_CHUNK)), MAX_CHUNK)
        fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, "rb") as fh:
            fh.seek(off)
            data = fh.read(ln)
        size = p.stat().st_size
        return {"path": rel(root, p), "offset": off, "data_b64": base64.b64encode(data).decode(), "size": size,
                "eof": off + len(data) >= size}
    if op == "write":
        data = base64.b64decode(req.get("data_b64", ""), validate=True)
        if len(data) > MAX_CHUNK:
            raise FsError("too_large", "chunk exceeds 4 MiB")
        p.parent.mkdir(parents=True, exist_ok=True)
        confine(root, rel(root, p.parent))
        if req.get("offset", 0) == 0 and req.get("keep_version") and p.exists():
            keep_version(root, p)
        flags = os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW | (os.O_APPEND if req.get("offset", 0) else os.O_TRUNC)
        fd = os.open(p, flags, 0o660)
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
        return {"path": rel(root, p), "size": p.stat().st_size}
    if op == "mkdir":
        p.mkdir(parents=True, exist_ok=True)
        return {"path": rel(root, p)}
    if op in ("move", "copy", "rename"):
        dst = confine(root, req.get("dest"))
        if not os.path.lexists(p):
            raise FsError("not_found", rel(root, p))
        if dst.is_dir() and op != "rename":
            dst = dst / p.name
        if os.path.lexists(dst) and not req.get("overwrite"):
            raise FsError("exists", f"{rel(root, dst)} already exists")
        if p == root:
            raise FsError("refused", "cannot move the root")
        if op == "copy":
            if p.is_dir():
                shutil.copytree(p, dst, symlinks=True, dirs_exist_ok=bool(req.get("overwrite")))
            else:
                shutil.copyfile(p, dst, follow_symlinks=False)
        else:
            os.replace(p, dst)
        return {"path": rel(root, p), "dest": rel(root, dst)}
    if op == "delete":
        if p == root:
            raise FsError("refused", "cannot delete the root directory")
        if not os.path.lexists(p):
            raise FsError("not_found", rel(root, p))
        if p.is_dir() and not p.is_symlink():
            shutil.rmtree(p) if req.get("recursive") else p.rmdir()
        else:
            p.unlink()
        return {"deleted": rel(root, p)}
    if op == "search":
        q = str(req.get("query", "")).lower()
        hits = []
        for dp, dns, fns in os.walk(p):
            dns[:] = [d for d in dns if d != VERSIONS_DIR and not d.startswith(".")]
            for n in dns + fns:
                if q in n.lower():
                    hits.append(entry(root, Path(dp) / n))
                    if len(hits) >= 300:
                        return {"results": hits, "truncated": True}
        return {"results": hits, "truncated": False}
    if op == "usage":
        total, files = 0, 0
        for dp, _, fns in os.walk(p):
            for n in fns:
                try:
                    total += os.lstat(os.path.join(dp, n)).st_size
                    files += 1
                except OSError:
                    pass
        return {"path": rel(root, p), "bytes": total, "files": files}
    if op == "versions":
        vd = root / VERSIONS_DIR / rel(root, p.parent)
        return {"versions": [{"name": v.name, "size": v.stat().st_size, "mtime": int(v.stat().st_mtime)}
                             for v in sorted(vd.glob(f"{p.name}.*"))] if vd.is_dir() else []}
    raise FsError("invalid_op", f"unknown op {op}")


def main() -> None:
    os.umask(0o007)  # team directories: group members keep read/write
    try:
        out = {"ok": True, "result": run(json.loads(sys.stdin.read()))}
    except FsError as e:
        out = {"ok": False, "error": {"code": e.code, "message": str(e)}}
    except (OSError, ValueError, KeyError) as e:
        out = {"ok": False, "error": {"code": type(e).__name__, "message": str(e)[:500]}}
    sys.stdout.write(json.dumps(out))


if __name__ == "__main__":
    main()
