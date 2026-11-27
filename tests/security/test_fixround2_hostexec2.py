"""Fix round 2 (key: hostexec2).

* NEW-4: a process substitution, a backtick or `$(...)` in the redirect-target position (`> >(cmd)`, `< <(cmd)`,
  `2> >(cmd)`, `&> >(cmd)`, `&>>(cmd)`, `;>(cmd)`, `> \\`cmd\\``) starts a command the allow-list checks; run under
  the REAL sandbox-exec for shell.execute and process.start.
* NEW-5: data dirs are compared by inode, so another spelling (letter case, symlink) of an instance's standard dir
  is that dir; a dir with nebula.db but no recorded id belongs to the default instance; a non-default instance
  records its id (the `instance-id` file) before it creates its database. Fake HOME only.
* N4 / N5: `install.sh --check` never runs corepack's pnpm shim; the Node.js wording.
* N3: no internal version labels in the host GUI-control status or the Mini App's legacy note.
* N2: with network ON, the host Seatbelt profile denies connects to every address of this Mac (EPERM), not only
  127.0.0.1; checked without any listener, so nothing is exposed and no packet leaves the Mac.

Nothing here touches a real data dir, the Keychain, launchctl, a real port or the network.
"""

from __future__ import annotations

import asyncio
import errno
import ipaddress
import os
import re
import socket
import subprocess
import sys
import uuid
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


def _run(coro):
    return asyncio.run(coro)


# ============================================================================ NEW-4: redirect targets
WRITE_MARK = "python3 -c \"open('pwned.txt', 'w').write('x')\""
BYPASSES = [
    f"echo hi > >({WRITE_MARK})",
    f"cat < <({WRITE_MARK})",
    f"git status 2> >({WRITE_MARK})",
    f"echo hi &> >({WRITE_MARK})",
    f"echo hi >> >({WRITE_MARK})",
    f"echo hi >>({WRITE_MARK})",
    f"echo hi &>>({WRITE_MARK})",
    f"echo hi 2>>({WRITE_MARK})",
    f"echo hi >&>({WRITE_MARK})",
    f"echo hi;>({WRITE_MARK})",
    f"echo hi |>({WRITE_MARK})",
    f"echo hi > `{WRITE_MARK}`",
    f"cat <<< `{WRITE_MARK}`",
]


@pytest.mark.parametrize("command", BYPASSES)
def test_parser_sees_programs_in_redirect_targets(command):
    from nebula_runtime.policy import allowed_tools_violation, shell_command_names

    assert "python3" in shell_command_names(command)
    assert "python3" in allowed_tools_violation(command, ["git"])


def test_quoted_substitution_as_redirect_target_cannot_be_checked():
    from nebula_runtime.policy import allowed_tools_violation, shell_command_names

    assert shell_command_names(f'echo hi > "$({WRITE_MARK})"') is None
    assert "cannot be checked" in allowed_tools_violation(f'echo hi > "$({WRITE_MARK})"', ["git"])


@pytest.mark.parametrize("command,names", [
    ("git status 2>&1 | tee build.log", ["git", "tee"]),
    ("git log > >(tee out.txt)", ["git", "tee"]),
    ("make >out.txt 2>&1", ["make"]),
    ("git status &>/dev/null", ["git"]),
    ("git log 2>>err.log", ["git"]),
    ("git diff >&2", ["git"]),
    ("git status >&-", ["git"]),
    ("(git status)>o.txt", ["git"]),
    ("cat < in.txt | wc -l", ["cat", "wc"]),
    ("cat <<< 'text'", ["cat"]),
    ("echo a >| f", ["echo"]),
    ("cat <(git log)", ["cat", "git"]),
    ("> out.txt git status", ["git"]),
])
def test_plain_redirects_still_name_only_the_real_programs(command, names):
    from nebula_runtime.policy import allowed_tools_violation, shell_command_names

    assert shell_command_names(command) == names
    assert allowed_tools_violation(command, ["git", "make"]) is None


@pytest.fixture()
def host(dbinit, tmp_path):
    """A real host executor on a temp project folder (allowed tools: git only)."""
    from nebula_host import hostexec

    proj = tmp_path / "proj"
    proj.mkdir()
    (proj / "README.md").write_text("# demo\n")
    root = hostexec.add_root(dbinit, {"path": str(proj), "allowed_tools": ["git"]}, "owner")
    ex = hostexec.HostExecutor(dbinit)
    aid = str(uuid.uuid4())

    def tool(name, args):
        return _run(ex.tool(aid, "task-fix2", root["id"], name, args))

    return {"ex": ex, "root": root, "proj": proj.resolve(), "tool": tool, "agent": aid}


@pytest.mark.parametrize("command", [BYPASSES[0], BYPASSES[1], BYPASSES[2], BYPASSES[3], BYPASSES[6],
                                     BYPASSES[9], BYPASSES[11]])
def test_shell_execute_refuses_programs_in_redirect_targets(host, command):
    r = host["tool"]("shell.execute", {"command": command})
    assert r["ok"] is False and r["error"]["code"] == "tool_not_allowed", r
    assert "python3" in r["error"]["message"]
    assert not (host["proj"] / "pwned.txt").exists()


def test_process_start_refuses_programs_in_redirect_targets(host):
    r = host["tool"]("process.start", {"command": f"git --version > >({WRITE_MARK})"})
    assert r["ok"] is False and r["error"]["code"] == "tool_not_allowed", r
    assert host["ex"].procs == {}
    assert not (host["proj"] / "pwned.txt").exists()


def test_allowed_tool_with_redirects_still_runs(host):
    r = host["tool"]("shell.execute", {"command": "git --version 2>&1 | tee out.txt > /dev/null && cat out.txt"})
    assert r["ok"] is True and r["result"]["exit_code"] == 0, r
    assert "git version" in r["result"]["stdout"]


# ============================================================================ NEW-5: data dir identity
@pytest.fixture()
def home(tmp_path, monkeypatch):
    """A fake HOME so standard_data_dir() points into tmp; no instance env leaks in or out."""
    h = tmp_path / "home"
    (h / "Library/Application Support").mkdir(parents=True)
    monkeypatch.setenv("HOME", str(h))
    for k in ("NEBULA_INSTANCE", "NEBULA_DATA_DIR", "NEBULA_LOG_DIR", "NEBULA_PORT", "NEBULA_KEYCHAIN_SERVICE"):
        monkeypatch.setenv(k, "x")  # recorded now, so teardown restores the original
        monkeypatch.delenv(k)
    from nebula_host.config import get_config

    get_config.cache_clear()
    yield h
    get_config.cache_clear()


def _std(home: Path) -> Path:
    return home / "Library/Application Support/NEBULA"


def _case_insensitive(d: Path) -> bool:
    probe = d / "CaseProbe"
    probe.mkdir()
    try:
        return (d / "caseprobe").exists()
    finally:
        probe.rmdir()


def _files(d: Path) -> dict[str, bytes]:
    return {p.name: p.read_bytes() for p in sorted(d.iterdir()) if p.is_file()}


def test_another_spelling_of_the_owners_dir_is_the_owners_dir(home, monkeypatch):
    """Audit NEW-5: a lowercase spelling of the owner's dir that holds only nebula.db is still refused."""
    from nebula_host import config

    if not _case_insensitive(home):
        pytest.skip("this volume is case-sensitive: another letter case is another folder")
    std = _std(home)
    std.mkdir()
    (std / "nebula.db").write_bytes(b"owner-db")
    before = _files(std)
    for alias in (home / "Library/Application Support/nebula", home / "library/application support/Nebula/"):
        assert config.conventional_instance_id(alias) == "default"
        monkeypatch.setenv("NEBULA_DATA_DIR", str(alias))
        monkeypatch.setenv("NEBULA_INSTANCE", "test")
        with pytest.raises(ValueError):
            config.load_config()  # the database names no id: the default instance's
        cfg = config.NebulaConfig(data_dir=alias)
        cfg.instance.id = "test"
        with pytest.raises(ValueError, match="default instance's data dir"):
            cfg.check_instance_isolation()
        with pytest.raises(ValueError, match="default instance's data dir"):
            config.save_config(cfg)
        cfg.record_instance()  # never claims another instance's standard dir
    assert _files(std) == before  # no config.yaml, no instance-id file
    # the owner itself, through another spelling and with the Keychain backend, is not refused
    monkeypatch.delenv("NEBULA_INSTANCE")
    monkeypatch.setenv("NEBULA_DATA_DIR", str(home / "Library/Application Support/nebula"))
    own = config.load_config()
    own.secret_backend = "keychain"
    assert own.instance_id == "default"
    own.check_instance_isolation()


def test_another_spelling_of_a_sibling_instance_dir_is_that_instance(home, monkeypatch):
    from nebula_host import config

    alpha = config.instance_data_dir("alpha")
    alpha.mkdir()
    (alpha / "nebula.db").write_bytes(b"")
    assert config.recorded_instance_id(alpha) == "alpha"  # its standard dir, no config.yaml yet
    if _case_insensitive(home):
        alias = alpha.with_name("nebula-ALPHA")
        assert config.conventional_instance_id(alias) == "alpha"
        monkeypatch.setenv("NEBULA_DATA_DIR", str(alias))
        monkeypatch.setenv("NEBULA_INSTANCE", "beta")
        with pytest.raises(ValueError, match="belongs to instance 'alpha'"):
            config.load_config()
    # a name that only looks like a sibling, for a folder that does not exist, is nobody's
    assert config.conventional_instance_id(alpha.with_name("nebula-gamma")) is None
    assert config.conventional_instance_id(alpha.with_name("NEBULA-gamma")) == "gamma"
    monkeypatch.setenv("NEBULA_DATA_DIR", str(alpha))
    monkeypatch.setenv("NEBULA_INSTANCE", "alpha")
    cfg = config.load_config()
    cfg.check_instance_isolation()
    config.save_config(cfg)
    assert config.recorded_instance_id(alpha) == "alpha"


def test_a_lone_database_in_a_custom_dir_is_the_default_instances(home, tmp_path, monkeypatch):
    from nebula_host import config

    d = tmp_path / "old-custom"
    d.mkdir()
    (d / "nebula.db").write_bytes(b"pre-id")
    before = _files(d)
    assert config.recorded_instance_id(d) == "default"
    monkeypatch.setenv("NEBULA_DATA_DIR", str(d))
    monkeypatch.setenv("NEBULA_INSTANCE", "test")
    with pytest.raises(ValueError, match="before instance ids existed.*it has no config.yaml.*default instance"):
        config.load_config()
    cfg = config.NebulaConfig(data_dir=d)
    cfg.instance.id = "test"  # a caller that bypasses load_config cannot claim it either
    with pytest.raises(ValueError, match="belongs to instance 'default'"):
        config.save_config(cfg)
    cfg.record_instance()
    assert _files(d) == before
    monkeypatch.delenv("NEBULA_INSTANCE")
    assert config.load_config().instance_id == "default"


@pytest.mark.parametrize("where", ["standard", "custom"])
def test_a_new_instance_records_its_id_before_its_database(home, tmp_path, monkeypatch, where):
    """`_boot()` creates nebula.db before `install` writes config.yaml (and `status` never writes it): the
    instance-id file keeps that database the instance's own."""
    from nebula_host import config
    from nebula_setup import cli

    d = config.instance_data_dir("lab") if where == "standard" else tmp_path / "lab-data"
    monkeypatch.setenv("NEBULA_INSTANCE", "lab")
    if where == "custom":
        monkeypatch.setenv("NEBULA_DATA_DIR", str(d))
    cfg = cli._boot()  # what install/status do first: dirs, then the database
    assert cfg.instance_id == "lab" and cfg.db_path.exists()
    assert (d / config.INSTANCE_MARKER).read_text() == "lab\n"
    assert (d / config.INSTANCE_MARKER).stat().st_mode & 0o777 == 0o600
    assert not (d / "config.yaml").exists()
    assert config.recorded_instance_id(d) == "lab"
    config.get_config.cache_clear()
    assert config.load_config().instance_id == "lab"  # a second run (`status` before `install`) still works
    config.save_config(cfg)
    assert config.recorded_instance_id(d) == "lab"
    monkeypatch.setenv("NEBULA_DATA_DIR", str(d))
    monkeypatch.setenv("NEBULA_INSTANCE", "beta")
    with pytest.raises(ValueError, match="belongs to instance 'lab'"):
        config.load_config()
    if where == "custom":  # without --instance, the dir names its owner
        (d / "config.yaml").unlink()
        monkeypatch.delenv("NEBULA_INSTANCE")
        assert config.load_config().instance_id == "lab"
        monkeypatch.setenv("NEBULA_INSTANCE", "beta")
        with pytest.raises(ValueError, match="instance-id file"):
            config.load_config()


def test_the_default_instance_and_foreign_dirs_get_no_instance_file(home, tmp_path, monkeypatch):
    from nebula_host import config

    std = _std(home)
    cfg = config.NebulaConfig(data_dir=std)
    cfg.ensure_dirs()
    assert not (std / config.INSTANCE_MARKER).exists()  # the owner's dir stays as it was
    other = config.NebulaConfig(data_dir=std)
    other.instance.id = "test"
    other.record_instance()  # another instance's standard dir: never claimed
    assert not (std / config.INSTANCE_MARKER).exists()
    d = tmp_path / "has-db"
    d.mkdir()
    (d / "nebula.db").write_bytes(b"")
    late = config.NebulaConfig(data_dir=d)
    late.instance.id = "late"
    late.record_instance()  # a database is already there: too late to claim it
    assert not (d / config.INSTANCE_MARKER).exists()


# ============================================================================ install.sh (N4, N5, NEW-5)
def _sh_env(home: Path, **extra: str) -> dict[str, str]:
    env = {k: v for k, v in os.environ.items()
           if not k.startswith(("NEBULA_", "COREPACK_", "XDG_CACHE_HOME", "npm_config_"))}
    env.update(HOME=str(home), **extra)
    return env


def _check(env: dict[str, str], *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["/bin/bash", str(ROOT / "install.sh"), "--check", *args], capture_output=True, text=True,
                          env=env, stdin=subprocess.DEVNULL, timeout=90, cwd=str(ROOT))


@pytest.fixture()
def fake_home(tmp_path):
    h = tmp_path / "home"
    (h / "Library/Application Support").mkdir(parents=True)
    return h


@pytest.mark.skipif(sys.platform != "darwin", reason="macOS installer")
def test_install_check_never_runs_a_corepack_pnpm_shim(tmp_path, fake_home):
    """N4: a corepack shim with an empty cache would download pnpm; --check reports it without running it."""
    corepack = tmp_path / "node/lib/node_modules/corepack/dist"
    corepack.mkdir(parents=True)
    ran = tmp_path / "shim-ran"
    (corepack / "pnpm.js").write_text(f"#!/bin/sh\ntouch '{ran}'\necho 99.0.0\n")
    (corepack / "pnpm.js").chmod(0o755)
    bin_dir = tmp_path / "node/bin"
    bin_dir.mkdir()
    (bin_dir / "pnpm").symlink_to("../lib/node_modules/corepack/dist/pnpm.js")
    env = _sh_env(fake_home, PATH=f"{bin_dir}:{os.environ['PATH']}")
    r = _check(env)
    assert r.returncode in (0, 1), r.stderr  # 1 only when this Mac itself fails a hardware check
    line = next(ln for ln in r.stdout.splitlines() if "pnpm" in ln and "[" in ln)
    assert "through corepack" in line and "not run by this check" in line, line
    assert not ran.exists()
    assert not (fake_home / ".cache").exists()
    # a warm corepack cache: the version comes from its files, still without running the shim
    cache = tmp_path / "corepack-home"
    (cache / "v1/pnpm/10.20.0").mkdir(parents=True)
    (cache / "lastKnownGood.json").write_text('{\n  "pnpm": "10.20.0+sha512.abc"\n}\n')
    r = _check({**env, "COREPACK_HOME": str(cache)})
    assert "pnpm 10.20.0 (through corepack, already downloaded)" in r.stdout
    assert not ran.exists()


@pytest.mark.skipif(sys.platform != "darwin", reason="macOS installer")
def test_install_check_runs_a_real_pnpm_outside_the_project(tmp_path, fake_home):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    log = tmp_path / "pnpm.log"
    (bin_dir / "pnpm").write_text("#!/bin/sh\necho \"$(pwd) $COREPACK_ENABLE_NETWORK "
                                  f"$npm_config_manage_package_manager_versions\" > '{log}'\necho 9.15.4\n")
    (bin_dir / "pnpm").chmod(0o755)
    r = _check(_sh_env(fake_home, PATH=f"{bin_dir}:{os.environ['PATH']}"))
    assert "pnpm 9.15.4" in r.stdout, r.stdout
    assert log.read_text().split() == ["/", "0", "false"]


@pytest.mark.skipif(sys.platform != "darwin", reason="macOS installer")
def test_install_check_node_wording(tmp_path, fake_home):
    """N5: 21.x is refused, so the message must not read as "20.19 or anything later"."""
    text = (ROOT / "install.sh").read_text()
    assert 'NODE_NEED="Node.js 20.19+ on Node 20, or 22.12+"' in text
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / "node").write_text("#!/bin/sh\necho 21.7.3\n")
    (bin_dir / "node").chmod(0o755)
    r = _check(_sh_env(fake_home, PATH=f"{bin_dir}:{os.environ['PATH']}"))
    assert "Node.js v21.7.3 is not supported by the dashboard build: it needs Node.js 20.19+ on Node 20, or 22.12+" \
        in r.stdout, r.stdout


@pytest.mark.skipif(sys.platform != "darwin", reason="macOS installer")
def test_install_check_knows_every_spelling_and_lone_databases(tmp_path, fake_home):
    std = fake_home / "Library/Application Support/NEBULA"
    std.mkdir()
    (std / "nebula.db").write_bytes(b"")
    before = _files(std)
    if _case_insensitive(fake_home):
        alias = fake_home / "Library/Application Support/nebula"
        r = _check(_sh_env(fake_home, NEBULA_DATA_DIR=str(alias)), "--instance", "fixround2-x")
        assert r.returncode == 1 and "belongs to instance 'default'" in r.stdout, r.stdout
    # a custom dir with only a database: the default instance's
    lone = tmp_path / "lone"
    lone.mkdir()
    (lone / "nebula.db").write_bytes(b"")
    r = _check(_sh_env(fake_home, NEBULA_DATA_DIR=str(lone)), "--instance", "fixround2-x")
    assert r.returncode == 1 and "belongs to instance 'default'" in r.stdout, r.stdout
    # a custom dir whose instance-id file names its owner
    marked = tmp_path / "marked"
    marked.mkdir()
    (marked / "nebula.db").write_bytes(b"")
    (marked / "instance-id").write_text("fixround2-lab\n")
    r = _check(_sh_env(fake_home, NEBULA_DATA_DIR=str(marked)), "--instance", "fixround2-other")
    assert r.returncode == 1 and "belongs to instance 'fixround2-lab'" in r.stdout, r.stdout
    r = _check(_sh_env(fake_home, NEBULA_DATA_DIR=str(marked)), "--instance", "fixround2-lab")
    assert "belongs to instance" not in r.stdout, r.stdout
    assert _files(std) == before


# ============================================================================ N3: version labels
def test_no_internal_version_labels_in_user_visible_text():
    from nebula_host import hostexec

    detail = hostexec.gui_permissions()["detail"]
    assert not re.search(r"NEBULA\s+V?\d", detail), detail
    mini = (ROOT / "apps/dashboard/src/mini/screens/ConversationScreen.tsx").read_text()
    assert "NEBULA 3.2" not in mini and "Needs a newer NEBULA on the Mac" in mini


# ============================================================================ N2: the Mac's own addresses
def _own_addresses() -> list[tuple[str, str, int]]:
    """(label, address, family) of this Mac's own addresses to probe; the LAN address is never put in a label."""
    out = subprocess.run(["/sbin/ifconfig"], capture_output=True, text=True, check=True).stdout
    found: list[tuple[str, str, int]] = [("loopback", "127.0.0.1", socket.AF_INET), ("loopback6", "::1", socket.AF_INET6)]
    cur = ""
    lan = bridge = False
    for line in out.splitlines():
        m = re.match(r"^(\S+?):\s", line)
        if m:
            cur = m.group(1)
            continue
        m = re.match(r"^\s+inet (\d+\.\d+\.\d+\.\d+)", line)
        if not m:
            continue
        ip = ipaddress.ip_address(m.group(1))
        if m.group(1) == "192.168.64.1" and not bridge:
            found.append(("vmnet bridge", m.group(1), socket.AF_INET))
            bridge = True
        elif re.fullmatch(r"en\d+", cur) and ip.is_private and not ip.is_link_local and not lan \
                and ip not in ipaddress.ip_network("100.64.0.0/10"):
            found.append(("the Mac's LAN address", m.group(1), socket.AF_INET))
            lan = True
    return found


CONNECT = ("import socket,sys\n"
           "s=socket.socket(int(sys.argv[3]), socket.SOCK_STREAM); s.settimeout(5)\n"
           "try:\n s.connect((sys.argv[1], int(sys.argv[2]))); print('connected')\n"
           "except OSError as e:\n print(e.errno)\n")


@pytest.mark.skipif(sys.platform != "darwin" or not os.path.exists("/usr/bin/sandbox-exec"), reason="macOS Seatbelt")
def test_network_on_denies_every_address_of_this_mac(tmp_path):
    """N2 (VM-03): Seatbelt's `localhost` filter matches all of the Mac's own addresses. Nothing listens on the probe
    port, so a reachable address answers ECONNREFUSED and a sandbox denial is EPERM; no packet leaves the Mac."""
    from nebula_host.hostexec import SANDBOX_EXEC, sandbox_profile

    root, home = tmp_path / "root", tmp_path / "home"
    root.mkdir()
    home.mkdir()
    on = sandbox_profile(root.resolve(), home.resolve(), read_only=False, network=True)
    control = "\n".join(ln for ln in on.splitlines() if 'remote ip "localhost:*"' not in ln)
    assert control != on
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()  # a port nobody listens on

    def connect(addr: str, fam: int, profile: str) -> str:
        argv = [SANDBOX_EXEC, "-p", profile, "/usr/bin/python3", "-I", "-c", CONNECT, addr, str(port), str(int(fam))]
        r = subprocess.run(argv, capture_output=True, text=True, timeout=30, cwd=str(root),
                           env={"PATH": "/usr/bin:/bin", "HOME": str(home)})
        # a probe that never ran (e.g. the python3 shim could not load libxcrun) must not read as a result
        return r.stdout.strip() or f"<probe printed nothing, exit {r.returncode}: {r.stderr.strip()[:300]}>"

    seen = []
    for label, addr, fam in _own_addresses():
        denied, reachable = connect(addr, fam, on), connect(addr, fam, control)
        seen.append(label)
        assert denied == str(errno.EPERM), label
        assert reachable == str(errno.ECONNREFUSED), label  # the denial above is the sandbox, not the network
    assert "loopback" in seen
