"""Deploy a self-contained NEBULA runtime into the data dir (outside TCC-protected folders).

macOS blocks background (launchd) processes from reading ~/Desktop, ~/Documents and ~/Downloads without a
privacy prompt. The LaunchAgent therefore never runs code from the source checkout: `deploy()` copies the runtime
files (same relative layout) to `<data>/app/<version>-<stamp>/`, installs the dependencies into `<data>/app/venv`
exactly as pinned in `uv.lock` (with hashes), and points the venv at the copied packages with a .pth file.
`current` is an atomic symlink to the active runtime; `previous` points at the one it replaced, which is kept so
`rollback()` (used by `nebula update`) can switch back without a rebuild.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import time
from collections.abc import Callable
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
PACKAGE_DIRS = ["apps/host-api", "apps/setup", "packages/contracts", "packages/agent-runtime",
                "packages/provider-adapters", "packages/telegram-gateway", "packages/live-broker"]
COPY = ["apps/host-api/nebula_host", "apps/setup/nebula_setup", "packages/contracts/nebula_contracts",
        "packages/agent-runtime/nebula_runtime", "packages/provider-adapters/nebula_providers",
        "packages/telegram-gateway/nebula_telegram", "packages/live-broker/nebula_live", "guest", "migrations",
        "scripts/build-guest-bundle.sh", "apps/host-vm-helper/nebula-vm.entitlements", "apps/dashboard/dist",
        "pyproject.toml", "uv.lock", "LICENSE", "README.md", "THIRD_PARTY_NOTICES.md"]
OPTIONAL = {"apps/dashboard/dist", "uv.lock"}
IGNORE = shutil.ignore_patterns("__pycache__", "*.pyc", ".DS_Store", "node_modules")
REQUIREMENTS = "requirements.lock.txt"  # exported from uv.lock into each runtime dir (exact pins + hashes)

Runner = Callable[..., subprocess.CompletedProcess]


class DeployError(RuntimeError):
    pass


def app_root(data_dir: Path) -> Path:
    return data_dir / "app"


def venv_python(data_dir: Path) -> Path:
    return app_root(data_dir) / "venv" / "bin" / "python"


def find_uv() -> str | None:
    for cand in (shutil.which("uv"), "/opt/homebrew/bin/uv", "/usr/local/bin/uv", str(Path.home() / ".local/bin/uv"),
                 str(Path.home() / ".cargo/bin/uv")):
        if cand and os.access(cand, os.X_OK):
            return cand
    return None


def _python_works(py: Path) -> bool:
    try:
        r = subprocess.run([str(py), "-c", "import sys; print(sys.version_info[:2])"], capture_output=True, text=True,
                           timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return False
    return r.returncode == 0 and r.stdout.strip() == str(sys.version_info[:2])


def _link_target(link: Path) -> Path | None:
    if not link.is_symlink():
        return None
    t = Path(os.readlink(link))
    return t if t.is_absolute() else link.parent / t


def current_target(data_dir: Path) -> Path | None:
    return _link_target(app_root(data_dir) / "current")


def previous_target(data_dir: Path) -> Path | None:
    t = _link_target(app_root(data_dir) / "previous")
    return t if t is not None and t.is_dir() else None


def _swap_link(link: Path, target: Path) -> None:
    tmp = link.parent / f".{link.name}.tmp"
    if tmp.is_symlink() or tmp.exists():
        tmp.unlink()
    os.symlink(target, tmp)
    os.replace(tmp, link)


def _new_target(root: Path, version: str) -> Path:
    base = f"{version}-{time.strftime('%Y%m%d%H%M%S')}"
    target, n = root / base, 1
    while target.exists():
        target, n = root / f"{base}.{n}", n + 1
    return target


def copy_tree(src: Path, dest: Path, printer=print) -> None:
    tmp = dest.parent / f".{dest.name}.new"
    if tmp.exists():
        shutil.rmtree(tmp)
    tmp.mkdir(parents=True)
    for rel in COPY:
        s = src / rel
        if not s.exists():
            if rel == "apps/dashboard/dist":
                printer("  [READY] warning: dashboard not built (make dashboard); API-only runtime")
                continue
            if rel in OPTIONAL:
                continue
            raise FileNotFoundError(f"runtime file missing: {s}")
        d = tmp / rel
        d.parent.mkdir(parents=True, exist_ok=True)
        if s.is_dir():
            shutil.copytree(s, d, ignore=IGNORE, symlinks=False)
        else:
            shutil.copy2(s, d)
    tmp.rename(dest)


def export_requirements(src: Path, out: Path, uv: str, run: Runner = subprocess.run) -> Path:
    """Write the exact, hash-pinned runtime requirements from `src/uv.lock` (no dev group, not the project)."""
    if not (src / "uv.lock").exists():
        raise DeployError(f"uv.lock missing in {src}; the runtime is installed exactly from the lockfile")
    run([uv, "export", "--frozen", "--no-dev", "--no-emit-project", "--no-header", "--format", "requirements-txt",
         "--project", str(src), "-o", str(out)], check=True, capture_output=True, text=True)
    return out


def sync_requirements(py: Path, requirements: Path, uv: str, run: Runner = subprocess.run) -> None:
    """Make the venv match the requirements exactly (installs missing, removes extra, verifies hashes)."""
    run([uv, "pip", "sync", "-q", "--require-hashes", "--python", str(py), str(requirements)], check=True)


def _activate(root: Path, target: Path) -> Path | None:
    """Point `current` at target and `previous` at what `current` was. Returns the previous target."""
    current = root / "current"
    prev = _link_target(current)
    if prev is not None and prev.resolve() != target.resolve() and prev.is_dir():
        _swap_link(root / "previous", prev)
    _swap_link(current, target)
    return prev


def cleanup(root: Path) -> list[str]:
    """Keep the venv, `current` and `previous` (and their targets); delete every other runtime dir."""
    keep = {"venv"}
    for name in ("current", "previous"):
        t = _link_target(root / name)
        if t is not None:
            keep.add(t.name)
    removed = []
    for old in root.iterdir():
        if old.is_dir() and not old.is_symlink() and old.name not in keep and not old.name.startswith("."):
            shutil.rmtree(old, ignore_errors=True)
            removed.append(old.name)
    return removed


def deploy(data_dir: Path, version: str, printer=print, *, src: Path | None = None, run: Runner = subprocess.run
           ) -> dict:
    src = src or ROOT
    root = app_root(data_dir)
    root.mkdir(parents=True, exist_ok=True)
    uv = find_uv()
    if not uv:
        raise DeployError("uv not found; install it (./install.sh offers it) — the runtime is installed exactly "
                          "from uv.lock")
    target = _new_target(root, version)
    copy_tree(src, target, printer)
    req = export_requirements(src, target / REQUIREMENTS, uv, run)

    venv = root / "venv"
    py = venv / "bin" / "python"
    if not _python_works(py):
        # missing, or its base interpreter vanished (e.g. Homebrew removed python@3.13 during an upgrade):
        # rebuild it from the interpreter running the deploy instead of leaving a service that cannot restart
        if venv.exists() or venv.is_symlink():
            printer(f"  [FIX] runtime venv unusable ({py}); recreating it with {sys.executable}")
        run([sys.executable, "-m", "venv", "--clear", str(venv)], check=True)
    sync_requirements(py, req, uv, run)
    site = Path(run([str(py), "-c", "import sysconfig; print(sysconfig.get_paths()['purelib'])"],
                    capture_output=True, text=True, check=True).stdout.strip())
    current = root / "current"
    (site / "nebula-runtime.pth").write_text("\n".join(str(current / p) for p in PACKAGE_DIRS) + "\n")
    prev = _activate(root, target)
    check = run([str(py), "-c", "import nebula_host.app, nebula_setup.cli; print('ok')"],
                capture_output=True, text=True, cwd="/")
    if (check.stdout or "").strip() != "ok":
        if prev is not None and prev.is_dir():  # never leave `current` pointing at a runtime that cannot import
            _swap_link(current, prev)
        raise DeployError(f"runtime import check failed: {(check.stderr or '')[-500:]}")
    removed = cleanup(root)
    return {"runtime": str(current), "target": str(target), "previous": str(prev) if prev else None,
            "python": str(py), "version": version, "removed": removed}


def rollback(data_dir: Path, printer=print, *, run: Runner = subprocess.run) -> dict:
    """Switch `current` back to `previous` and re-sync the venv to that runtime's pinned requirements."""
    root = app_root(data_dir)
    prev = previous_target(data_dir)
    if prev is None:
        raise DeployError("no previous runtime to roll back to")
    failed = current_target(data_dir)
    _swap_link(root / "current", prev)
    (root / "previous").unlink(missing_ok=True)
    req = prev / REQUIREMENTS
    uv = find_uv()
    py = root / "venv" / "bin" / "python"
    synced = False
    if req.exists() and uv:
        try:
            sync_requirements(py, req, uv, run)
            synced = True
        except subprocess.CalledProcessError as e:
            printer(f"  [ROLLBACK] warning: could not re-sync dependencies ({e}); the service may need `nebula deploy`")
    else:
        printer("  [ROLLBACK] warning: previous runtime has no pinned requirements; dependencies left as they are")
    return {"runtime": str(root / "current"), "target": str(prev), "failed": str(failed) if failed else None,
            "dependencies_resynced": synced}
