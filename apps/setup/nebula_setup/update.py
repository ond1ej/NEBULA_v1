"""`nebula update`: move a git checkout to the newest release tag (or a given ref) and roll the service forward.

Steps: refuse a dirty checkout or a LaunchAgent of another data dir -> `git fetch --tags` -> pick the newest
`vX.Y.Z` tag (or `--ref`) -> back up the database -> check out the target -> build (uv sync --frozen, VM helper,
dashboard) -> deploy a new runtime dir (the previous one is kept) -> run migrations -> restart -> HTTP health check
for the new version. Any failure after the checkout rolls back: the service is stopped, the database backup is
restored, `current` points at the previous runtime again, the previous VM helper is restored, the service is
restarted and the checkout returns to where it was. User data is never deleted.
"""

from __future__ import annotations

import os
import re
import shutil
import sqlite3
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from nebula_setup import health, launchd, runtime

SEMVER_TAG = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)$")
VERSION_FILE = "apps/host-api/nebula_host/config.py"
_VERSION_RE = re.compile(r'^APP_VERSION\s*=\s*"([^"]+)"', re.M)


class UpdateError(RuntimeError):
    pass


def newest_release_tag(tags: list[str]) -> str | None:
    """Highest `vX.Y.Z` (or `X.Y.Z`) tag; pre-release and other tags are ignored."""
    best: tuple[tuple[int, int, int], str] | None = None
    for t in tags:
        m = SEMVER_TAG.match(t.strip())
        if m:
            key = (int(m.group(1)), int(m.group(2)), int(m.group(3)))
            if best is None or key > best[0]:
                best = (key, t.strip())
    return best[1] if best else None


def parse_version(config_py: str) -> str | None:
    m = _VERSION_RE.search(config_py)
    return m.group(1) if m else None


def backup_db(db_path: Path, dest_dir: Path, label: str) -> Path | None:
    """Consistent online SQLite backup (owner-only file). None if there is no database yet."""
    if not db_path.exists():
        return None
    dest_dir.mkdir(parents=True, exist_ok=True)
    os.chmod(dest_dir, 0o700)
    dest = dest_dir / f"nebula-db-{time.strftime('%Y%m%d-%H%M%S')}-{label}.sqlite"
    src = sqlite3.connect(db_path)
    dst = sqlite3.connect(dest)
    try:
        with dst:
            src.backup(dst)
    finally:
        src.close()
        dst.close()
    os.chmod(dest, 0o600)
    return dest


def restore_db(backup: Path, db_path: Path) -> None:
    """Put the backup back (service must be stopped). The failed database is kept next to it for inspection."""
    if db_path.exists():
        shutil.copy2(db_path, db_path.with_name(db_path.name + f".failed-update-{int(time.time())}"))
    for suffix in ("-wal", "-shm"):
        Path(str(db_path) + suffix).unlink(missing_ok=True)
    tmp = db_path.with_name(db_path.name + ".restore")
    shutil.copy2(backup, tmp)
    os.chmod(tmp, 0o600)
    os.replace(tmp, db_path)


class Ops:
    """Side effects of an update; tests replace them."""

    def __init__(self, cfg, root: Path, printer=print, run=subprocess.run, health_timeout: float = 90):
        self.cfg = cfg
        self.root = root
        self.printer = printer
        self.run = run
        self.health_timeout = health_timeout

    # ---- git
    def git(self, *args: str) -> str:
        r = self.run(["git", "-C", str(self.root), *args], capture_output=True, text=True)
        if r.returncode != 0:
            raise UpdateError(f"git {' '.join(args)} failed: {(r.stderr or '').strip()[-300:]}")
        return (r.stdout or "").strip()

    # ---- build + deploy (run the *new* code in a child process)
    def _env(self) -> dict[str, str]:
        return {**os.environ, "NEBULA_INSTANCE": self.cfg.instance_id, "NEBULA_DATA_DIR": str(self.cfg.data_dir)}

    def _checked(self, cmd: list[str], cwd: Path | None = None) -> None:
        self.printer("  $ " + " ".join(cmd))
        r = self.run(cmd, cwd=str(cwd or self.root), env=self._env())
        if r.returncode != 0:
            raise UpdateError(f"command failed ({r.returncode}): {' '.join(cmd)}")

    def checkout_python(self) -> str:
        py = self.root / ".venv/bin/python"
        return str(py) if py.exists() else sys.executable

    def build(self) -> None:
        uv = runtime.find_uv()
        if not uv:
            raise UpdateError("uv not found (needed to install the locked dependencies)")
        self._checked([uv, "sync", "--frozen"])
        if shutil.which("swift"):
            self._checked(["make", "helper"])
        if shutil.which("pnpm"):
            self._checked(["pnpm", "--dir", "apps/dashboard", "install", "--frozen-lockfile"])
            self._checked(["pnpm", "--dir", "apps/dashboard", "build"])
        else:
            self.printer("  [UPDATE] warning: pnpm not found; the dashboard was not rebuilt")

    def resync_checkout(self) -> None:
        uv = runtime.find_uv()
        if uv:
            self.run([uv, "sync", "--frozen"], cwd=str(self.root), env=self._env())

    def deploy(self) -> None:
        self._checked([self.checkout_python(), "-m", "nebula_setup.cli", "deploy", "--no-restart"])

    def migrate(self) -> None:
        self._checked([str(runtime.venv_python(self.cfg.data_dir)), "-m", "nebula_setup.cli", "migrate"], cwd=Path("/"))

    # ---- service
    def managed(self) -> bool:
        return launchd.plist_path(self.cfg.launchd_label).exists()

    def check_owner(self) -> None:
        launchd.check_owner(self.cfg.launchd_label, self.cfg.data_dir)

    def stop(self) -> None:
        launchd.stop(self.cfg.launchd_label, self.cfg.data_dir)

    def restart(self) -> None:
        launchd.restart(self.cfg.launchd_label, self.cfg.data_dir)

    def health(self, expect_version: str | None) -> dict[str, Any]:
        return health.wait(self.cfg.instance.port, self.health_timeout, expect_version=expect_version)

    def rollback_runtime(self) -> dict[str, Any]:
        return runtime.rollback(self.cfg.data_dir, self.printer)


def run_update(cfg, ops: Ops, *, ref: str | None = None, build: bool = True, force: bool = False,
               dry_run: bool = False) -> dict[str, Any]:
    p = ops.printer
    root = ops.root
    report: dict[str, Any] = {"instance": cfg.instance_id}
    if not (root / ".git").exists():
        raise UpdateError(f"{root} is not a git checkout; run `nebula update` (or ./update.sh) from your NEBULA clone")
    if ops.git("status", "--porcelain", "--untracked-files=no"):
        raise UpdateError("the checkout has local changes; commit or stash them before updating")
    ops.check_owner()
    prev_sha = ops.git("rev-parse", "HEAD")
    try:
        prev_branch = ops.git("symbolic-ref", "-q", "--short", "HEAD")
    except UpdateError:
        prev_branch = ""
    p("[UPDATE] fetching release tags")
    ops.git("fetch", "--tags", "--prune", "--quiet")
    target = ref or newest_release_tag(ops.git("tag", "--list").splitlines())
    if not target:
        raise UpdateError("no release tag (vX.Y.Z) found; pass --ref <tag|branch|commit>")
    try:
        target_sha = ops.git("rev-parse", "--verify", "--quiet", f"{target}^{{commit}}")
    except UpdateError as e:
        raise UpdateError(f"unknown ref {target!r}") from e
    try:
        new_version = parse_version(ops.git("show", f"{target_sha}:{VERSION_FILE}"))
    except UpdateError:
        new_version = None
    report.update(previous_commit=prev_sha, target=target, target_commit=target_sha, target_version=new_version)
    if target_sha == prev_sha and not force and runtime.current_target(cfg.data_dir) is not None:
        report["result"] = "up_to_date"
        p(f"[UPDATE] already at {target} ({new_version}); nothing to do (use --force to redeploy)")
        return report
    if dry_run:
        report["result"] = "dry_run"
        p(f"[UPDATE] would update {prev_sha[:12]} -> {target} ({new_version})")
        return report

    backup = backup_db(cfg.db_path, cfg.data_dir / "backups", "pre-update")
    report["db_backup"] = str(backup) if backup else None
    helper = cfg.data_dir / "bin" / "nebula-vm"
    helper_bak = helper.with_name("nebula-vm.pre-update")
    if helper.exists():
        shutil.copy2(helper, helper_bak)
    managed = ops.managed()
    stage, deployed = "checkout", False
    p(f"[UPDATE] {prev_sha[:12]} -> {target} ({new_version}); database backup: {backup}")
    try:
        ops.git("checkout", "--quiet", "--detach", target_sha)
        if build:
            stage = "build"
            ops.build()
        stage = "deploy"
        ops.deploy()
        deployed = True
        stage = "migrate"
        ops.migrate()
        if managed:
            stage = "restart"
            ops.restart()
            stage = "health"
            h = ops.health(new_version)
            report["health"] = h
            if not h.get("ok"):
                raise UpdateError(f"health check failed: {h.get('status') or h.get('detail')}")
        else:
            p("[UPDATE] no LaunchAgent installed: start the new version with `nebula serve` or "
              "`nebula autostart enable`")
    except Exception as e:  # noqa: BLE001 - every failure after the checkout rolls back
        report.update(result="rolled_back", failed_stage=stage, error=str(e))
        p(f"[UPDATE] FAILED at {stage}: {e}; rolling back")
        rb: dict[str, Any] = {}
        if deployed:
            if managed:
                rb["stop"] = _try(ops.stop)
            if backup:
                rb["db_restored"] = _try(lambda: restore_db(backup, cfg.db_path))
            rb["runtime"] = _try(ops.rollback_runtime)
            if helper_bak.exists():
                rb["helper_restored"] = _try(lambda: os.replace(helper_bak, helper))
            if managed:
                rb["restart"] = _try(ops.restart)
                rb["health"] = _try(lambda: ops.health(None))
        rb["checkout"] = _try(lambda: ops.git("checkout", "--quiet", prev_branch or prev_sha))
        if build and stage != "checkout":
            rb["checkout_deps"] = _try(ops.resync_checkout)
            p("[UPDATE] note: rebuild the helper and dashboard in the checkout (make helper dashboard) "
              "if you build from it again")
        report["rollback"] = rb
        return report
    helper_bak.unlink(missing_ok=True)
    report["result"] = "updated"
    p(f"[UPDATE] now running {target} ({new_version}); previous runtime kept for rollback")
    return report


def _try(fn) -> Any:
    try:
        r = fn()
        return True if r is None else r
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)[:300]}
