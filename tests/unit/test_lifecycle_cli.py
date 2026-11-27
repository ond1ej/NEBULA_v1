"""Lifecycle CLI (W2): runtime deploy from uv.lock with a kept previous runtime + rollback, HTTP health check,
autostart choice, `nebula update` (newest tag, DB backup, rollback), `nebula diagnostics` redaction and the
root install/update/uninstall scripts. No launchctl, Keychain, network or real data dir is touched."""

from __future__ import annotations

import os
import sqlite3
import subprocess
import sys
import tarfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture(autouse=True)
def _keep_umask():
    """cli.main() sets umask 077 for the process; give the rest of the suite its umask back."""
    old = os.umask(0o022)
    os.umask(old)
    yield
    os.umask(old)


# ------------------------------------------------------------------ runtime
def _fake_src(tmp_path: Path) -> Path:
    from nebula_setup import runtime

    src = tmp_path / "src"
    for rel in runtime.COPY:
        p = src / rel
        if rel in ("apps/dashboard/dist",) or "." not in Path(rel).name or rel == "guest":
            (p).mkdir(parents=True, exist_ok=True)
            (p / "x.txt").write_text(rel)
        else:
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(rel)
    return src


class FakeRun:
    """Records deploy commands; emulates uv export/sync, the purelib query and the import check."""

    def __init__(self, site: Path, import_ok: bool = True):
        self.calls: list[list[str]] = []
        self.site = site
        self.import_ok = import_ok

    def __call__(self, cmd, **kw):
        cmd = [str(c) for c in cmd]
        self.calls.append(cmd)
        if cmd[1:3] == ["export", "--frozen"]:
            Path(cmd[cmd.index("-o") + 1]).write_text("pkg==1.0 \\\n    --hash=sha256:" + "a" * 64 + "\n")
        if "sysconfig" in " ".join(cmd):
            self.site.mkdir(parents=True, exist_ok=True)
            return subprocess.CompletedProcess(cmd, 0, f"{self.site}\n", "")
        if "import nebula_host.app" in " ".join(cmd):
            return subprocess.CompletedProcess(cmd, 0, "ok\n" if self.import_ok else "", "" if self.import_ok
                                               else "ImportError: boom")
        return subprocess.CompletedProcess(cmd, 0, "", "")


@pytest.fixture()
def rt_env(tmp_path, monkeypatch):
    from nebula_setup import runtime

    monkeypatch.setattr(runtime, "find_uv", lambda: "/fake/uv")
    monkeypatch.setattr(runtime, "_python_works", lambda py: True)
    stamps = iter(f"2026010100{i:04d}" for i in range(100))
    monkeypatch.setattr(runtime.time, "strftime", lambda fmt: next(stamps))
    return tmp_path


def test_deploy_installs_exactly_from_uv_lock_and_keeps_previous(rt_env):
    from nebula_setup import runtime

    src = _fake_src(rt_env)
    data = rt_env / "data"
    run = FakeRun(rt_env / "site")
    r1 = runtime.deploy(data, "1.0.0", printer=lambda s: None, src=src, run=run)
    export = next(c for c in run.calls if c[1] == "export")
    assert export[:4] == ["/fake/uv", "export", "--frozen", "--no-dev"] and "--no-emit-project" in export
    assert ["--project", str(src)] == export[export.index("--project"):export.index("--project") + 2]
    sync = next(c for c in run.calls if c[1:3] == ["pip", "sync"])
    assert "--require-hashes" in sync and sync[-1].endswith(runtime.REQUIREMENTS)
    assert not any(c[1:3] == ["pip", "install"] for c in run.calls)  # never unpinned ranges
    assert (Path(r1["target"]) / runtime.REQUIREMENTS).exists()
    assert (Path(r1["target"]) / "uv.lock").exists()
    assert r1["previous"] is None
    pth = (rt_env / "site" / "nebula-runtime.pth").read_text()
    assert str(data / "app/current/apps/host-api") in pth
    r2 = runtime.deploy(data, "1.1.0", printer=lambda s: None, src=src, run=run)
    r3 = runtime.deploy(data, "1.1.0", printer=lambda s: None, src=src, run=run)  # same version twice
    assert runtime.current_target(data).name == Path(r3["target"]).name
    assert runtime.previous_target(data).name == Path(r2["target"]).name
    names = sorted(p.name for p in (data / "app").iterdir() if not p.name.startswith("."))
    assert Path(r1["target"]).name not in names  # older than previous: cleaned up
    assert {Path(r2["target"]).name, Path(r3["target"]).name, "current", "previous"} <= set(names)


def test_failed_import_check_never_leaves_current_on_a_broken_runtime(rt_env):
    from nebula_setup import runtime

    src = _fake_src(rt_env)
    data = rt_env / "data"
    good = runtime.deploy(data, "1.0.0", printer=lambda s: None, src=src, run=FakeRun(rt_env / "site"))
    with pytest.raises(runtime.DeployError, match="import check"):
        runtime.deploy(data, "2.0.0", printer=lambda s: None, src=src, run=FakeRun(rt_env / "site", import_ok=False))
    assert runtime.current_target(data).name == Path(good["target"]).name


def test_rollback_switches_back_and_resyncs_previous_pins(rt_env):
    from nebula_setup import runtime

    src = _fake_src(rt_env)
    data = rt_env / "data"
    run = FakeRun(rt_env / "site")
    a = runtime.deploy(data, "1.0.0", printer=lambda s: None, src=src, run=run)
    b = runtime.deploy(data, "1.1.0", printer=lambda s: None, src=src, run=run)
    run.calls.clear()
    r = runtime.rollback(data, printer=lambda s: None, run=run)
    assert runtime.current_target(data).name == Path(a["target"]).name
    assert r["failed"].endswith(Path(b["target"]).name) and r["dependencies_resynced"] is True
    assert run.calls[0][1:3] == ["pip", "sync"] and run.calls[0][-1] == str(Path(a["target"]) / runtime.REQUIREMENTS)
    with pytest.raises(runtime.DeployError, match="no previous"):
        runtime.rollback(data, printer=lambda s: None, run=run)


def test_deploy_requires_uv_and_the_lockfile(tmp_path, monkeypatch):
    from nebula_setup import runtime

    monkeypatch.setattr(runtime, "find_uv", lambda: None)
    with pytest.raises(runtime.DeployError, match="uv"):
        runtime.deploy(tmp_path / "d", "1.0.0", src=tmp_path)
    with pytest.raises(runtime.DeployError, match="uv.lock"):
        runtime.export_requirements(tmp_path, tmp_path / "r.txt", "/fake/uv", run=lambda *a, **k: None)


def test_real_lockfile_exports_hash_pinned_requirements(tmp_path):
    """The committed uv.lock exports (offline, --frozen) to exact pins with hashes and without dev tools."""
    from nebula_setup import runtime

    uv = runtime.find_uv()
    if not uv:
        pytest.skip("uv not installed")
    out = runtime.export_requirements(ROOT, tmp_path / "req.txt", uv)
    text = out.read_text()
    names = [ln.split("==")[0] for ln in text.splitlines() if ln and not ln.startswith((" ", "#"))]
    assert "fastapi" in names and "pytest" not in names and "ruff" not in names and "nebula" not in names
    assert all("==" in ln for ln in text.splitlines() if ln and not ln.startswith((" ", "#")))
    assert "--hash=sha256:" in text


# ------------------------------------------------------------------ health
class Resp:
    def __init__(self, code, body):
        self.status_code = code
        self._body = body

    def json(self):
        if isinstance(self._body, Exception):
            raise self._body
        return self._body


def test_health_probe_and_wait(monkeypatch):
    import httpx
    from nebula_setup import health

    answers = [httpx.ConnectError("refused"), Resp(503, ValueError("no json")),
               Resp(200, {"data": {"status": "degraded", "api": "ok", "db": "ok", "version": "1.0.0",
                                   "vm": {"state": "stopped"}, "guest": {"status": "vm_not_running"}}})]
    urls = []

    def fake_get(url, timeout):
        urls.append(url)
        a = answers.pop(0)
        if isinstance(a, Exception):
            raise a
        return a

    monkeypatch.setattr(health.httpx, "get", fake_get)
    t = [0.0]
    r = health.wait(3123, timeout=10, interval=1, sleep=lambda s: t.__setitem__(0, t[0] + s), clock=lambda: t[0])
    assert r["ok"] is True and r["attempts"] == 3 and r["version"] == "1.0.0" and r["vm"] == "stopped"
    assert urls == ["http://127.0.0.1:3123/api/v1/health"] * 3
    answers[:] = [Resp(200, {"data": {"api": "ok", "db": "ok", "version": "0.9.0"}})] * 5
    t[0] = 0.0
    r = health.wait(3123, timeout=2, interval=1, expect_version="1.0.0",
                    sleep=lambda s: t.__setitem__(0, t[0] + s), clock=lambda: t[0])
    assert r["ok"] is False and "expected 1.0.0" in r["detail"]
    monkeypatch.setattr(health.httpx, "get", lambda url, timeout: (_ for _ in ()).throw(httpx.ConnectError("x")))
    assert health.probe(1)["status"] == "unreachable"


# ------------------------------------------------------------------ CLI pieces
def test_autostart_choice():
    from nebula_setup.cli import resolve_autostart

    def never(_):
        raise AssertionError("must not prompt")

    assert resolve_autostart("yes", False, never) is True
    assert resolve_autostart("no", True, never) is False
    assert resolve_autostart("ask", False, never) is False  # non-interactive default: no
    assert resolve_autostart("ask", True, lambda q: "y") is True
    assert resolve_autostart("ask", True, lambda q: "") is False

    def eof(_):
        raise EOFError

    assert resolve_autostart("ask", True, eof) is False


def test_pick_free_port_skips_used_ranges_and_the_default_ports():
    from nebula_setup.cli import pick_free_port

    used = {3110, 3122}
    assert pick_free_port(is_free=lambda p: p not in used) == 3130
    assert pick_free_port(is_free=lambda p: True) == 3110
    with pytest.raises(RuntimeError):
        pick_free_port(tries=2, is_free=lambda p: False)


def test_instance_flag_works_before_and_after_the_command(monkeypatch):
    from nebula_setup import cli

    p = cli.build_parser()
    assert p.parse_args(["--instance", "t1", "health"]).instance == "t1"
    assert p.parse_args(["health", "--instance", "t2"]).instance == "t2"
    assert not hasattr(p.parse_args(["health"]), "instance")
    seen = {}
    monkeypatch.setattr(cli, "cmd_health", lambda a: seen.setdefault("env", os.environ.get("NEBULA_INSTANCE")) and 0)
    monkeypatch.setenv("NEBULA_INSTANCE", "placeholder")  # so the teardown restores "unset"
    monkeypatch.delenv("NEBULA_INSTANCE")
    assert cli.main(["--instance", "Probe-1", "health"]) == 0
    assert seen["env"] == "probe-1"
    assert cli.main(["--instance", "bad id", "health"]) == 2


@pytest.fixture()
def no_tty(monkeypatch):
    monkeypatch.setattr(sys.stdin, "isatty", lambda: False, raising=False)


def _fake_install(installer, report):
    def fake(cfg, **kw):
        return dict(report)

    return fake


def test_install_noninteractive_defaults_to_no_autostart(dbinit, monkeypatch, capsys, no_tty):
    from nebula_setup import cli, installer, launchd, runtime

    monkeypatch.setattr(installer, "install", _fake_install(installer, {"image_version": "img", "vm": {}}))
    monkeypatch.setattr(launchd, "status", lambda label=None: {"installed": False, "loaded": False})
    monkeypatch.setattr(runtime, "deploy", lambda *a, **k: (_ for _ in ()).throw(AssertionError("no deploy")))
    monkeypatch.setattr(launchd, "install", lambda *a, **k: (_ for _ in ()).throw(AssertionError("no agent")))
    rc = cli.main(["install"])
    out = capsys.readouterr().out
    assert rc == 0 and "autostart: off" in out and "nebula serve" in out


def test_install_autostart_yes_starts_and_health_checks(dbinit, monkeypatch, capsys, no_tty):
    from nebula_setup import cli, health, installer, launchd, runtime

    calls = []
    monkeypatch.setattr(installer, "install", _fake_install(installer, {"image_version": "img", "vm": {}}))
    monkeypatch.setattr(launchd, "status", lambda label=None: {"installed": False, "loaded": False})
    monkeypatch.setattr(runtime, "deploy", lambda d, v, printer=print: calls.append("deploy") or
                        {"target": str(d / "app/x"), "python": "/venv/python", "runtime": "c"})
    monkeypatch.setattr(launchd, "install", lambda prog, log_dir, env=None, label=None, data_dir=None:
                        calls.append(("agent", label, env["NEBULA_DATA_DIR"], tuple(prog))))
    monkeypatch.setattr(health, "wait", lambda port, timeout, **k: calls.append(("health", port)) or
                        {"ok": True, "version": "1.0.0", "vm": "running", "guest": "ok"})
    assert cli.main(["install", "--autostart", "yes"]) == 0
    assert calls[0] == "deploy"
    assert calls[1] == ("agent", "dev.nebula.host", str(dbinit.data_dir),
                        ("/venv/python", "-m", "nebula_setup.cli", "serve"))
    assert calls[2] == ("health", dbinit.instance.port)
    monkeypatch.setattr(health, "wait", lambda port, timeout, **k: {"ok": False, "status": "unreachable"})
    assert cli.main(["install", "--autostart", "yes"]) == 3  # installed, but not healthy


def test_install_already_ready_keeps_existing_agent(dbinit, monkeypatch, capsys, no_tty):
    from nebula_setup import cli, health, installer, launchd, runtime

    monkeypatch.setattr(installer, "install", _fake_install(installer, {"already_ready": True}))
    monkeypatch.setattr(launchd, "status", lambda label=None: {"installed": True, "loaded": True})
    monkeypatch.setattr(runtime, "current_target", lambda d: d / "app/1")
    monkeypatch.setattr(runtime, "deploy", lambda *a, **k: (_ for _ in ()).throw(AssertionError("no redeploy")))
    monkeypatch.setattr(health, "wait", lambda port, timeout, **k: {"ok": True})
    assert cli.main(["install", "--autostart", "yes"]) == 0
    assert "already installed" in capsys.readouterr().out


def test_noninteractive_isolation_guard_blocks_keychain_on_foreign_dir(data_dir, monkeypatch, capsys):
    from nebula_host.config import get_config
    from nebula_setup import cli

    monkeypatch.setenv("NEBULA_SECRET_BACKEND", "keychain")
    get_config.cache_clear()
    assert cli.main(["status"]) == 2
    assert "share the default instance" in capsys.readouterr().err


# ------------------------------------------------------------------ update
def _git(cwd, *args):
    return subprocess.run(["git", "-C", str(cwd), *args], check=True, capture_output=True, text=True).stdout.strip()


@pytest.fixture()
def repo(tmp_path):
    """origin repo with tags v1.0.0, v1.2.0, v1.10.0, v2.0.0-rc1 and a clone checked out at v1.0.0's branch."""
    origin = tmp_path / "origin"
    origin.mkdir()
    env_args = ["-c", "user.email=t@example.invalid", "-c", "user.name=t", "-c", "commit.gpgsign=false",
                "-c", "tag.gpgsign=false"]

    def commit(version, tag):
        f = origin / "apps/host-api/nebula_host/config.py"
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(f'APP_VERSION = "{version}"\n')
        subprocess.run(["git", *env_args, "-C", str(origin), "add", "-A"], check=True, capture_output=True)
        subprocess.run(["git", *env_args, "-C", str(origin), "commit", "-qm", version], check=True, capture_output=True)
        subprocess.run(["git", *env_args, "-C", str(origin), "tag", tag], check=True, capture_output=True)

    subprocess.run(["git", "init", "-q", "-b", "main", str(origin)], check=True, capture_output=True)
    commit("1.0.0", "v1.0.0")
    clone = tmp_path / "clone"
    subprocess.run(["git", "clone", "-q", str(origin), str(clone)], check=True, capture_output=True)
    for v, t in (("1.2.0", "v1.2.0"), ("1.10.0", "v1.10.0"), ("2.0.0rc1", "v2.0.0-rc1")):
        commit(v, t)
    return clone


class FakeOps:
    def __init__(self, cfg, root, fail_at=None, managed=True):
        from nebula_setup import update

        self.cfg, self.root, self.fail_at, self._managed = cfg, root, fail_at, managed
        self.calls: list = []
        self.lines: list[str] = []
        self.printer = self.lines.append
        self._real = update.Ops(cfg, root, printer=self.printer)

    def git(self, *args):
        return self._real.git(*args)

    def _step(self, name, *extra):
        self.calls.append((name, *extra))
        if name == self.fail_at:
            raise RuntimeError(f"{name} broke")

    def check_owner(self):
        self._step("check_owner")

    def managed(self):
        return self._managed

    def build(self):
        self._step("build")

    def resync_checkout(self):
        self._step("resync")

    def deploy(self):
        self._step("deploy")
        # the "new code" migrates the DB at once (as a broken migration would)
        with sqlite3.connect(self.cfg.db_path) as c:
            c.execute("CREATE TABLE IF NOT EXISTS from_new_version(x)")

    def migrate(self):
        self._step("migrate")

    def stop(self):
        self._step("stop")

    def restart(self):
        self._step("restart")

    def health(self, expect):
        self._step("health", expect)
        return {"ok": self.fail_at != "unhealthy", "status": "degraded" if self.fail_at == "unhealthy" else "ok"}

    def rollback_runtime(self):
        self._step("rollback_runtime")
        return {"target": "prev"}


@pytest.fixture()
def upd_cfg(dbinit):
    with sqlite3.connect(dbinit.db_path) as c:
        c.execute("CREATE TABLE IF NOT EXISTS owner_data(v)")
        c.execute("INSERT INTO owner_data VALUES ('keep me')")
    return dbinit


def test_newest_release_tag_ignores_prereleases():
    from nebula_setup.update import newest_release_tag, parse_version

    assert newest_release_tag(["v1.0.0", "v1.10.0", "v1.2.0", "v2.0.0-rc1", "nightly", "1.9.9"]) == "v1.10.0"
    assert newest_release_tag(["foo"]) is None
    assert parse_version('x = 1\nAPP_VERSION = "1.2.3"\n') == "1.2.3"


def test_update_to_newest_tag_with_backup_and_health(repo, upd_cfg, monkeypatch):
    from nebula_setup import runtime, update

    monkeypatch.setattr(runtime, "current_target", lambda d: d / "app/x")
    ops = FakeOps(upd_cfg, repo)
    r = update.run_update(upd_cfg, ops)
    assert r["result"] == "updated" and r["target"] == "v1.10.0" and r["target_version"] == "1.10.0"
    assert _git(repo, "describe", "--tags", "--exact-match") == "v1.10.0"
    assert [c[0] for c in ops.calls] == ["check_owner", "build", "deploy", "migrate", "restart", "health"]
    assert ("health", "1.10.0") in ops.calls
    backup = Path(r["db_backup"])
    assert backup.exists() and oct(backup.stat().st_mode & 0o777) == "0o600"
    with sqlite3.connect(backup) as c:
        assert c.execute("SELECT v FROM owner_data").fetchone() == ("keep me",)
    again = update.run_update(upd_cfg, FakeOps(upd_cfg, repo))
    assert again["result"] == "up_to_date"


def test_update_rolls_back_on_failed_health_check(repo, upd_cfg, monkeypatch):
    from nebula_setup import runtime, update

    monkeypatch.setattr(runtime, "current_target", lambda d: d / "app/x")
    helper = upd_cfg.data_dir / "bin/nebula-vm"
    helper.parent.mkdir(parents=True, exist_ok=True)
    helper.write_bytes(b"OLD-HELPER")
    start = _git(repo, "rev-parse", "HEAD")
    ops = FakeOps(upd_cfg, repo, fail_at="unhealthy")
    orig_deploy = ops.deploy

    def deploy_and_replace_helper():
        orig_deploy()
        helper.write_bytes(b"NEW-HELPER")

    ops.deploy = deploy_and_replace_helper
    r = update.run_update(upd_cfg, ops, ref="v1.2.0")
    assert r["result"] == "rolled_back" and r["failed_stage"] == "health"
    names = [c[0] for c in ops.calls]
    assert names[-5:] == ["stop", "rollback_runtime", "restart", "health", "resync"]
    assert _git(repo, "rev-parse", "HEAD") == start and _git(repo, "symbolic-ref", "--short", "HEAD") == "main"
    with sqlite3.connect(upd_cfg.db_path) as c:  # the backup was restored: the new version's change is gone
        tables = {t for (t,) in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        assert "from_new_version" not in tables and "owner_data" in tables
    assert helper.read_bytes() == b"OLD-HELPER"
    assert any(p.name.startswith("nebula.db.failed-update-") for p in upd_cfg.db_path.parent.iterdir())


def test_update_failure_before_deploy_only_restores_the_checkout(repo, upd_cfg):
    from nebula_setup import update

    start = _git(repo, "rev-parse", "HEAD")
    ops = FakeOps(upd_cfg, repo, fail_at="build")
    r = update.run_update(upd_cfg, ops)
    assert r["result"] == "rolled_back" and r["failed_stage"] == "build"
    assert "stop" not in [c[0] for c in ops.calls] and "rollback_runtime" not in [c[0] for c in ops.calls]
    assert _git(repo, "rev-parse", "HEAD") == start


def test_update_refuses_dirty_checkout_non_git_and_unknown_ref(repo, upd_cfg, tmp_path):
    from nebula_setup import update

    (repo / "apps/host-api/nebula_host/config.py").write_text("changed\n")
    with pytest.raises(update.UpdateError, match="local changes"):
        update.run_update(upd_cfg, FakeOps(upd_cfg, repo))
    _git(repo, "checkout", "--", ".")
    with pytest.raises(update.UpdateError, match="unknown ref"):
        update.run_update(upd_cfg, FakeOps(upd_cfg, repo), ref="v9.9.9")
    with pytest.raises(update.UpdateError, match="not a git checkout"):
        update.run_update(upd_cfg, FakeOps(upd_cfg, tmp_path))
    r = update.run_update(upd_cfg, FakeOps(upd_cfg, repo), dry_run=True)
    assert r["result"] == "dry_run" and _git(repo, "describe", "--tags", "--exact-match") == "v1.0.0"


# ------------------------------------------------------------------ diagnostics
def test_diagnostics_bundle_is_redacted_and_private(dbinit, monkeypatch):
    from nebula_setup import diagnostics, health, launchd

    monkeypatch.setattr(launchd, "status", lambda label=None: {"label": label, "installed": False})
    monkeypatch.setattr(health, "probe", lambda port: {"ok": False, "status": "unreachable"})
    dbinit.log_dir.mkdir(parents=True, exist_ok=True)
    secret = "sk-" + "Z" * 30
    (dbinit.log_dir / "host.log").write_text(
        f"start\nusing key {secret}\nAuthorization: Bearer {'y' * 40}\nfile {Path.home()}/Documents/x\n")
    (dbinit.data_dir / "install-report.json").write_text('{"token": "abcdefgh12345", "ok": true}')
    out = diagnostics.build_bundle(dbinit, dbinit.data_dir / "diag.tar.gz")
    assert oct(out.stat().st_mode & 0o777) == "0o600"
    with tarfile.open(out) as tar:
        names = tar.getnames()
        blob = "".join(tar.extractfile(m).read().decode() for m in tar.getmembers() if m.isfile())
    assert "nebula-diagnostics/meta.json" in names and "nebula-diagnostics/logs/host.log" in names
    assert not any(n.endswith((".db", ".sqlite")) for n in names)
    assert secret not in blob and "y" * 40 not in blob and "abcdefgh12345" not in blob
    assert str(Path.home()) not in blob and "~/Documents/x" in blob
    assert '"instance": "default"' in blob


# ------------------------------------------------------------------ shell scripts
SCRIPTS = ["install.sh", "update.sh", "uninstall.sh", "scripts/lock-guest-requirements.sh", "scripts/smoke-test.sh"]


@pytest.mark.parametrize("script", SCRIPTS)
def test_shell_scripts_parse_and_are_strict(script):
    p = ROOT / script
    assert os.access(p, os.X_OK), f"{script} not executable"
    subprocess.run(["/bin/bash", "-n", str(p)], check=True)
    text = p.read_text()
    assert "set -euo pipefail" in text and "sudo " not in text.replace("no sudo", "").replace("Never uses sudo", "")


def _script_env(tmp_path):
    env = {k: v for k, v in os.environ.items() if not k.startswith("NEBULA_")}
    env.update(NEBULA_SECRET_BACKEND="memory", NEBULA_INSTANCE="lifecycle-script-test",
               NEBULA_DATA_DIR=str(tmp_path / "data"))
    return env


@pytest.mark.skipif(sys.platform != "darwin", reason="macOS installer")
def test_install_check_changes_nothing(tmp_path):
    marker = {p: p.stat().st_mtime_ns for p in (ROOT / ".venv", ROOT / "apps/dashboard") if p.exists()}
    r = subprocess.run(["/bin/bash", str(ROOT / "install.sh"), "--check", "--instance", "lifecycle-script-test",
                        "--port", "3190"], capture_output=True, text=True, env=_script_env(tmp_path),
                       stdin=subprocess.DEVNULL, timeout=60)
    assert r.returncode in (0, 1), r.stderr
    assert "nothing was changed" in r.stdout and "Checking this Mac" in r.stdout
    assert list(tmp_path.iterdir()) == []  # not even the data dir was created
    assert marker == {p: p.stat().st_mtime_ns for p in marker}


def test_install_rejects_bad_options(tmp_path):
    for args in (["--autostart", "maybe"], ["--instance", "Bad Id"], ["--bogus"]):
        r = subprocess.run(["/bin/bash", str(ROOT / "install.sh"), "--check", *args], capture_output=True, text=True,
                           env=_script_env(tmp_path), stdin=subprocess.DEVNULL, timeout=30)
        assert r.returncode == 2, args


def test_uninstall_remove_data_needs_the_phrase(tmp_path):
    r = subprocess.run(["/bin/bash", str(ROOT / "uninstall.sh"), "--instance", "lifecycle-script-test",
                        "--remove-data"], capture_output=True, text=True, env=_script_env(tmp_path),
                       stdin=subprocess.DEVNULL, timeout=30)
    if "not set up" in r.stderr:
        pytest.skip(".venv/bin/nebula missing")
    assert r.returncode == 2 and "nothing was deleted" in r.stderr
    r = subprocess.run(["/bin/bash", str(ROOT / "uninstall.sh"), "--remove-data", "--confirm", "yes"],
                       capture_output=True, text=True, env=_script_env(tmp_path), stdin=subprocess.DEVNULL, timeout=30)
    assert r.returncode == 2 and "nothing was deleted" in r.stderr
    assert list(tmp_path.iterdir()) == []
