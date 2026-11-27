"""Shared workspace & host-guest file bridge (V2 module 8).

Roots
  agent:<agent_id>  the agent's /home/<user>/workspace in the VM (operations run as that Linux user)
  team:<team_id>    the team directory /srv/nebula/shared/<key> (group-owned; operations run as a member)
  exchange          a dedicated folder on the Mac (data_dir/exchange) for macOS <-> VM transfers
  company:<id>      the AI company directory /srv/nebula/shared/<key> in the VM (V3)
  host:<root_id>    an owner-authorised host project folder on the Mac (V3; read-only roots reject writes)

Agents never see macOS files: the exchange folder is only reachable through this API (owner actions).
Every path is confined (no '..', no symlinks, O_NOFOLLOW) on both sides; files with a second hard link are refused
in host project folders; every change lands in file_events.
"""

from __future__ import annotations

import base64
import os
import stat
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

from sqlalchemy import select

from nebula_host import db, models
from nebula_host.events import bus

CHUNK = 2 * 1024 * 1024
MAX_UPLOAD = 200 * 1024 * 1024
TEXT_PREVIEW = 256 * 1024


class FileError(Exception):
    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status, self.code = status, code


def exchange_dir(cfg) -> Path:
    d = cfg.data_dir / "exchange"
    d.mkdir(parents=True, exist_ok=True)
    os.chmod(d, 0o700)
    return d


def list_roots(cfg) -> list[dict[str, Any]]:
    with db.engine().connect() as c:
        agents = db.rows(c.execute(select(models.agents.c.id, models.agents.c.name, models.agents.c.status)
                                   .where(models.agents.c.status.not_in(["DELETING"]))))
        teams = db.rows(c.execute(select(models.teams.c.id, models.teams.c.name, models.teams.c.shared_dir)))
    out = [{"id": f"agent:{a['id']}", "type": "agent", "label": a["name"], "agent_id": a["id"], "status": a["status"]}
           for a in agents]
    out += [{"id": f"team:{t['id']}", "type": "team", "label": f"Team · {t['name']}", "team_id": t["id"],
             "guest_path": f"/srv/nebula/shared/{t['shared_dir']}"} for t in teams if t["shared_dir"]]
    out.append({"id": "exchange", "type": "exchange", "label": "Mac exchange folder", "host_path": str(exchange_dir(cfg))})
    with db.engine().connect() as c:
        comps = db.rows(c.execute(select(models.companies.c.id, models.companies.c.name, models.companies.c.workspace_dir)))
        hroots = db.rows(c.execute(select(models.host_project_roots).where(models.host_project_roots.c.enabled.is_(True))))
    out += [{"id": f"company:{co['id']}", "type": "company", "label": f"Company · {co['name']}", "company_id": co["id"],
             "guest_path": f"/srv/nebula/shared/{co['workspace_dir']}"} for co in comps if co["workspace_dir"]]
    out += [{"id": f"host:{r['id']}", "type": "host", "label": f"Mac project · {r['name']}", "root_id": r["id"],
             "host_path": r["path"], "read_only": r["mode"] == "read_only"} for r in hroots]
    return out


def _guest_root(root: str) -> dict[str, Any] | None:
    if root.startswith("agent:"):
        aid = root[6:]
        with db.engine().connect() as c:
            if not c.execute(select(models.agents.c.id).where(models.agents.c.id == aid)).first():
                raise FileError(404, "root_not_found", "unknown agent")
        return {"type": "agent", "agent_id": aid}
    if root.startswith("team:"):
        with db.engine().connect() as c:
            key = c.execute(select(models.teams.c.shared_dir).where(models.teams.c.id == root[5:])).scalar()
        if not key:
            raise FileError(404, "root_not_found", "unknown team or team has no shared directory")
        return {"type": "shared", "key": key}
    if root.startswith("company:"):
        with db.engine().connect() as c:
            key = c.execute(select(models.companies.c.workspace_dir).where(models.companies.c.id == root[8:])).scalar()
        if not key:
            raise FileError(404, "root_not_found", "unknown company")
        return {"type": "shared", "key": key}
    if root == "exchange" or root.startswith("host:"):
        return None
    raise FileError(400, "invalid_root", "root must be agent:<id>, team:<id>, company:<id>, host:<id> or exchange")


def _host_base(cfg, root: str) -> tuple[Path, bool]:
    if root == "exchange":
        return exchange_dir(cfg), False
    with db.engine().connect() as c:
        r = c.execute(select(models.host_project_roots).where(models.host_project_roots.c.id == root[5:])).first()
    if r is None or not r.enabled:
        raise FileError(404, "root_not_found", "unknown or disabled host project folder")
    base = Path(r.path)
    if not base.is_dir():
        raise FileError(404, "root_missing", f"{r.path} no longer exists")
    return base, r.mode == "read_only"


# ----------------------------------------------------------------------------- host exchange side
# All host-side operations go through hostexec.SafeTree: each path component is opened relative to its parent's
# directory descriptor with O_NOFOLLOW, so a directory that an agent swaps for a symlink in a Mac project folder
# while an API call runs is refused instead of followed (H-03).
def _host_parts(rel: str | None) -> list[str]:
    rel = (rel or ".").lstrip("/")
    if "\x00" in rel:
        raise FileError(400, "invalid_path", "NUL in path")
    parts: list[str] = []
    for part in Path(rel).parts if rel not in ("", ".") else ():
        if part == "..":
            raise FileError(400, "path_outside_root", "'..' is not allowed")
        if part in ("", "."):
            continue
        parts.append(part)
    return parts


def _confine_host(base: Path, rel: str | None) -> Path:
    """Validated path below base (kept for callers that only need the name; no file system access)."""
    return base.joinpath(*_host_parts(rel))


def _rel(parts: list[str]) -> str:
    return "/".join(parts) if parts else "."


def _kind(st: os.stat_result) -> str:
    return "symlink" if stat.S_ISLNK(st.st_mode) else "dir" if stat.S_ISDIR(st.st_mode) else "file"


def _entry(name: str, parts: list[str], st: os.stat_result) -> dict[str, Any]:
    return {"name": name, "path": _rel(parts), "type": _kind(st), "size": st.st_size, "mtime": int(st.st_mtime)}


def _host_op(cfg, req: dict[str, Any], root: str = "exchange") -> dict[str, Any]:
    from nebula_host.hostexec import HostExecError

    try:
        return _host_op_safe(cfg, req, root)
    except HostExecError as e:
        raise FileError(e.status, e.code, e.message) from None


def _host_op_safe(cfg, req: dict[str, Any], root: str) -> dict[str, Any]:
    from nebula_host.hostexec import HostExecError, SafeTree, _lstat_at, safe_copy, safe_replace

    base, read_only = _host_base(cfg, root)
    op = req["op"]
    if read_only and op in ("write", "mkdir", "move", "copy", "rename", "delete"):
        raise FileError(403, "read_only", "this Mac project folder is authorised read-only")
    # A host project folder is writable by sandboxed agent commands, so a file there with a second hard link may be
    # another name for a file outside it: reads and writes refuse it (H-03). The exchange folder lives in the
    # NEBULA data dir, which no agent process can reach, so its files keep working as before.
    t = SafeTree(base, single_link=root != "exchange")
    parts = _host_parts(req.get("path"))
    name = parts[-1] if parts else base.name
    if op == "list":
        st = t.lstat(parts)
        if st is None:
            raise FileError(404, "not_found", "not found")
        if not stat.S_ISDIR(st.st_mode):
            raise FileError(400, "not_a_directory", "not a directory")
        items = [(n, s) for n, s in t.listdir(parts) if n != ".nebula_versions"]
        items.sort(key=lambda x: (not stat.S_ISDIR(x[1].st_mode), x[0].lower()))
        return {"path": _rel(parts), "entries": [_entry(n, [*parts, n], s) for n, s in items][:2000]}
    if op == "stat":
        st = t.lstat(parts) if parts else t.lstat([])
        if st is None:
            raise FileError(404, "not_found", "not found")
        return _entry(name, parts, st)
    if op == "read":
        off, ln = int(req.get("offset", 0)), min(int(req.get("length", CHUNK)), 4 * 1024 * 1024)
        if not parts:
            raise FileError(400, "not_a_file", "not a file")
        data, st = t.read(parts, ln, off)
        return {"data_b64": base64.b64encode(data).decode(), "size": st.st_size, "offset": off,
                "eof": off + len(data) >= st.st_size}
    if op == "write":
        data = base64.b64decode(req.get("data_b64", ""))
        if not req.get("offset") and req.get("keep_version") and root == "exchange" and parts:
            st = t.lstat(parts)
            if st is not None and stat.S_ISREG(st.st_mode):
                _keep_version(t, parts)
        _existed, st = t.write(parts, data, append=bool(req.get("offset", 0)), mode=0o600)
        return {"path": _rel(parts), "size": st.st_size}
    if op == "mkdir":
        t.mkdir(parts)
        return {"path": _rel(parts)}
    if op in ("move", "copy", "rename"):
        dparts = _host_parts(req.get("dest"))
        if not parts:
            raise FileError(400, "refused", "cannot move or copy the root folder")
        dst_st = t.lstat(dparts) if dparts else t.lstat([])
        if dst_st is not None and stat.S_ISDIR(dst_st.st_mode) and op != "rename":
            dparts = [*dparts, parts[-1]]
            dst_st = t.lstat(dparts)
        if not dparts:
            raise FileError(400, "refused", "invalid destination")
        if dst_st is not None and not req.get("overwrite"):
            raise FileError(409, "exists", "destination exists")
        if t.lstat(parts) is None:
            raise FileError(404, "not_found", "not found")
        if op == "copy":
            safe_copy(t, parts, t, dparts, overwrite=bool(req.get("overwrite")))
        else:
            safe_replace(t, parts, t, dparts, overwrite=bool(req.get("overwrite")))
        return {"path": req.get("path"), "dest": _rel(dparts)}
    if op == "delete":
        if not parts:
            raise FileError(400, "refused", "cannot delete the root folder")
        if t.lstat(parts) is None:
            raise FileError(404, "not_found", "not found")
        t.delete(parts, recursive=bool(req.get("recursive")))
        return {"deleted": req.get("path")}
    if op == "search":
        q = str(req.get("query", "")).lower()
        hits = []
        for rel, dns, fns, dfd in t.walk(parts):
            for n in dns + fns:
                if q in n.lower():
                    st = _lstat_at(n, dfd)
                    if st is not None:
                        hits.append(_entry(n, [*parts, *rel, n], st))
        return {"results": hits[:300], "truncated": len(hits) > 300}
    if op == "usage":
        total = files = 0
        for _rel_parts, _dns, fns, dfd in t.walk(parts):
            for n in fns:
                st = _lstat_at(n, dfd)
                if st is not None:
                    total += st.st_size
                    files += 1
        return {"bytes": total, "files": files}
    if op == "versions":
        if not parts:
            return {"versions": []}
        try:
            items = t.listdir([".nebula_versions", *parts[:-1]])
        except (FileNotFoundError, HostExecError):
            items = []
        return {"versions": [{"name": n, "size": s.st_size, "mtime": int(s.st_mtime)}
                             for n, s in sorted(items) if n.startswith(parts[-1] + ".") and stat.S_ISREG(s.st_mode)]}
    raise FileError(400, "invalid_op", f"unknown op {op}")


def _keep_version(t, parts: list[str]) -> None:
    """Keep the previous content of an exchange file (5 newest copies) in .nebula_versions/<dir>/<name>.<ts>."""
    import time as _t

    from nebula_host.hostexec import safe_copy

    vparts = [".nebula_versions", *parts[:-1]]
    safe_copy(t, parts, t, [*vparts, f"{parts[-1]}.{int(_t.time())}"], overwrite=True)
    old = sorted((s.st_mtime, n) for n, s in t.listdir(vparts) if n.startswith(parts[-1] + "."))
    for _m, n in old[:-5]:
        t.delete([*vparts, n])


# ----------------------------------------------------------------------------- public API
def mac_root(root: str) -> bool:
    return root == "exchange" or root.startswith("host:")


def owner_caller() -> bool:
    """The local dashboard (no remote context) or a remote session with the owner role."""
    from nebula_host import authz

    ctx = authz.current()
    return ctx is None or ctx.owner


class FileBridge:
    def __init__(self, cfg, guest) -> None:
        self.cfg = cfg
        self.guest = guest

    async def op(self, root: str, op: str, actor: str | None = None, **kw: Any) -> dict[str, Any]:
        if mac_root(root) and not owner_caller():  # H-01: this Mac's own folders are for the owner only
            raise FileError(403, "owner_only", "Mac folders (exchange and project folders) are for the NEBULA owner only")
        gr = _guest_root(root)
        req = {"op": op, **kw}
        if gr is None:
            import asyncio

            try:
                res = await asyncio.to_thread(_host_op, self.cfg, req, root)
            except FileNotFoundError as e:
                raise FileError(404, "not_found", str(e)) from e
            except OSError as e:
                raise FileError(400, type(e).__name__, str(e)) from e
        else:
            from nebula_host.guest import GuestError, GuestUnavailable

            try:
                r = await self.guest.call("fs.op", {"root": gr, **req}, timeout=300)
            except GuestUnavailable as e:
                raise FileError(503, "vm_unavailable", str(e)) from e
            except GuestError as e:
                raise FileError(400, getattr(e, "code", "guest_error"), str(e)) from e
            if not r.get("ok"):
                err = r.get("error") or {}
                code = err.get("code", "error")
                status = 404 if code in ("not_found", "FileNotFoundError") else 409 if code == "exists" else 400
                raise FileError(status, code, err.get("message", "file operation failed"))
            res = r["result"]
        if actor and op in ("write", "mkdir", "move", "copy", "rename", "delete") and not kw.get("offset"):
            self._history(actor, root, op, kw.get("path", ""), kw.get("dest"), res.get("size"))
        return res

    def _history(self, actor: str, root: str, op: str, path: str, dest: str | None, size: int | None) -> None:
        with db.engine().begin() as c:
            c.execute(models.file_events.insert().values(ts=db.now(), actor=actor, root=root, op=op, path=path,
                                                         dest=dest, size=size))
        if op == "write":
            bus.publish("file.created", {"root": root, "path": path, "size": size, "by": actor})

    async def read_all(self, root: str, path: str, limit: int = MAX_UPLOAD) -> AsyncIterator[bytes]:
        off = 0
        while True:
            r = await self.op(root, "read", path=path, offset=off, length=CHUNK)
            data = base64.b64decode(r["data_b64"])
            if off + len(data) > limit:
                raise FileError(413, "too_large", "file exceeds the transfer limit")
            yield data
            off += len(data)
            if r["eof"] or not data:
                break

    async def write_stream(self, root: str, path: str, chunks: AsyncIterator[bytes], actor: str,
                           keep_version: bool = False) -> dict[str, Any]:
        off = 0
        buf = b""
        res: dict[str, Any] = {}
        async for ch in chunks:
            buf += ch
            while len(buf) >= CHUNK:
                piece, buf = buf[:CHUNK], buf[CHUNK:]
                res = await self.op(root, "write", path=path, offset=off, keep_version=keep_version and off == 0,
                                    data_b64=base64.b64encode(piece).decode())
                off += len(piece)
                if off > MAX_UPLOAD:
                    raise FileError(413, "too_large", "upload exceeds 200 MiB")
        if buf or off == 0:
            res = await self.op(root, "write", path=path, offset=off, keep_version=keep_version and off == 0,
                                data_b64=base64.b64encode(buf).decode())
            off += len(buf)
        self._history(actor, root, "write", path, None, off)
        return {**res, "size": off}

    async def transfer(self, src_root: str, src_path: str, dst_root: str, dst_path: str, actor: str) -> dict[str, Any]:
        """Copy a file between roots (agent <-> agent, agent <-> team, VM <-> Mac exchange)."""
        st = await self.op(src_root, "stat", path=src_path)
        if st["type"] != "file":
            raise FileError(400, "not_a_file", "only single files can be transferred")
        if st["size"] > MAX_UPLOAD:
            raise FileError(413, "too_large", "file exceeds 200 MiB")
        res = await self.write_stream(dst_root, dst_path, self.read_all(src_root, src_path), actor)
        with db.engine().begin() as c:
            c.execute(models.file_events.insert().values(ts=db.now(), actor=actor, root=src_root, op="transfer",
                                                         path=src_path, dest=f"{dst_root}:{dst_path}", size=st["size"]))
        return {"from": f"{src_root}:{src_path}", "to": f"{dst_root}:{dst_path}", "size": res["size"]}

    async def preview(self, root: str, path: str) -> dict[str, Any]:
        st = await self.op(root, "stat", path=path)
        if st["type"] != "file":
            raise FileError(400, "not_a_file", "not a file")
        name = path.lower()
        kind = ("image" if name.endswith((".png", ".jpg", ".jpeg", ".gif", ".webp")) else
                "pdf" if name.endswith(".pdf") else
                "csv" if name.endswith((".csv", ".tsv")) else "text")
        limit = 8 * 1024 * 1024 if kind in ("image", "pdf") else TEXT_PREVIEW
        r = await self.op(root, "read", path=path, offset=0, length=limit)
        data = base64.b64decode(r["data_b64"])
        if kind == "text" and b"\x00" in data[:4096]:
            kind = "binary"
        out: dict[str, Any] = {"path": path, "kind": kind, "size": st["size"], "mtime": st["mtime"],
                               "truncated": not r["eof"]}
        if kind in ("text", "csv"):
            out["text"] = data.decode(errors="replace")
        elif kind in ("image", "pdf"):
            out["data_b64"] = r["data_b64"] if r["eof"] else None
        return out

    def history(self, root: str | None = None, limit: int = 200) -> list[dict[str, Any]]:
        with db.engine().connect() as c:
            q = select(models.file_events)
            if root:
                q = q.where(models.file_events.c.root == root)
            return db.rows(c.execute(q.order_by(models.file_events.c.id.desc()).limit(min(limit, 1000))))
