"""Lifecycle fix round: instance ids never take another instance's data dir (NEW-2), `install.sh --check` on an
installed Mac, the dashboard's Node.js engines, THIRD_PARTY_NOTICES.md in the runtime, wheel-only hashed guest pip
installs, DNS scoped to the VM's resolvers (VM-05), systemd sandboxing of the agent units (VM-16) and the English
fixtures of the TEST instance server.

Nothing here touches a real data dir, the Keychain, launchctl or the network: HOME is a tmp dir wherever a standard
data dir is involved, and the shell scripts only see tmp data dirs of throw-away instance ids.
"""

from __future__ import annotations

import importlib.util
import json
import os
import re
import subprocess
import sys
import types
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
PROVISION = ROOT / "guest/scripts/provision.sh"
UNITS = ROOT / "guest/desktop/systemd"


@pytest.fixture(autouse=True)
def _keep_umask():
    """cli.main() sets umask 077 for the process; give the rest of the suite its umask back."""
    old = os.umask(0o022)
    os.umask(old)
    yield
    os.umask(old)


@pytest.fixture()
def home(tmp_path, monkeypatch):
    """A fake HOME so standard_data_dir() points into tmp; no instance env leaks in or out."""
    h = tmp_path / "home"
    h.mkdir()
    monkeypatch.setenv("HOME", str(h))
    for k in ("NEBULA_INSTANCE", "NEBULA_DATA_DIR", "NEBULA_LOG_DIR", "NEBULA_PORT", "NEBULA_KEYCHAIN_SERVICE"):
        monkeypatch.setenv(k, "x")  # recorded now, so teardown restores the original even after cli.main() sets it
        monkeypatch.delenv(k)
    from nebula_host.config import get_config

    get_config.cache_clear()
    yield h
    get_config.cache_clear()


def _std(home: Path) -> Path:
    return home / "Library/Application Support/NEBULA"


def _legacy_install(d: Path) -> bytes:
    """A data dir installed before instance ids existed: config.yaml without instance.id, plus nebula.db."""
    d.mkdir(parents=True)
    raw = b"instance:\n  name: My NEBULA\n  port: 3100\nvm:\n  ram_mb: 4096\n"
    (d / "config.yaml").write_bytes(raw)
    (d / "nebula.db").write_bytes(b"")
    return raw


# ------------------------------------------------------------------ NEW-2: instance id vs data dir
def test_non_default_instance_on_the_standard_data_dir_is_refused(home, monkeypatch):
    from nebula_host import config

    std = _std(home)
    monkeypatch.setenv("NEBULA_DATA_DIR", str(std))
    monkeypatch.setenv("NEBULA_INSTANCE", "test")
    cfg = config.load_config()
    assert cfg.instance_id == "test" and cfg.data_dir == std
    with pytest.raises(ValueError, match="default instance's data dir"):
        cfg.check_instance_isolation()
    with pytest.raises(ValueError, match="default instance's data dir"):
        config.save_config(cfg)
    assert not std.exists()  # nothing was written
    # a trailing slash or a symlink to it is the same dir
    link = home / "nebula-link"
    std.mkdir(parents=True)
    link.symlink_to(std)
    for alias in (str(std) + "/", str(link)):
        monkeypatch.setenv("NEBULA_DATA_DIR", alias)
        with pytest.raises(ValueError, match="default instance's data dir"):
            config.load_config().check_instance_isolation()
    assert list(std.iterdir()) == []


def test_instance_on_another_instances_data_dir_is_refused(home, monkeypatch):
    from nebula_host import config

    alpha_dir = config.instance_data_dir("alpha")
    assert alpha_dir == home / "Library/Application Support/NEBULA-alpha"
    monkeypatch.setenv("NEBULA_DATA_DIR", str(alpha_dir))
    monkeypatch.setenv("NEBULA_INSTANCE", "beta")
    with pytest.raises(ValueError, match="belongs to instance 'alpha'"):
        config.load_config().check_instance_isolation()
    monkeypatch.delenv("NEBULA_INSTANCE")  # the default id on NEBULA-alpha is refused as well
    with pytest.raises(ValueError, match="belongs to instance 'alpha'"):
        config.load_config().check_instance_isolation()
    monkeypatch.setenv("NEBULA_INSTANCE", "alpha")
    cfg = config.load_config()
    cfg.check_instance_isolation()  # its own dir
    config.save_config(cfg)
    assert config.recorded_instance_id(alpha_dir) == "alpha"
    # unrelated names are no instance's standard dir
    for name in ("NEBULA-", "NEBULA-default", "NEBULA-Bad_Id", "NEBULAx"):
        assert config.conventional_instance_id(alpha_dir.with_name(name)) is None
    assert config.conventional_instance_id(_std(home)) == "default"
    assert config.conventional_instance_id(home / "elsewhere") is None


@pytest.mark.parametrize("where", ["standard", "custom"])
def test_pre_instance_id_install_is_the_default_instance(home, tmp_path, monkeypatch, where):
    """An existing config.yaml without instance.id whose dir holds nebula.db belongs to instance 'default'."""
    from nebula_host import config

    d = _std(home) if where == "standard" else tmp_path / "custom-data"
    raw = _legacy_install(d)
    monkeypatch.setenv("NEBULA_DATA_DIR", str(d))
    assert config.recorded_instance_id(d) == "default"
    monkeypatch.setenv("NEBULA_INSTANCE", "test")
    with pytest.raises(ValueError, match="before instance ids existed"):
        config.load_config()
    monkeypatch.setenv("NEBULA_INSTANCE", "default")
    assert config.load_config().instance_id == "default"
    monkeypatch.delenv("NEBULA_INSTANCE")
    cfg = config.load_config()
    assert cfg.instance_id == "default" and cfg.vm.ram_mb == 4096
    if where == "standard":
        cfg.secret_backend = "keychain"
        cfg.check_instance_isolation()  # the owner's own install keeps working
    cfg.instance.id = "test"  # even a caller that bypasses load_config cannot claim it
    with pytest.raises(ValueError, match="belongs to instance 'default'|default instance's data dir"):
        config.save_config(cfg)
    assert (d / "config.yaml").read_bytes() == raw


def test_config_without_id_and_without_database_is_not_claimed(tmp_path, monkeypatch):
    """A hand-written config.yaml (no id, no database yet) in a custom dir may start any instance."""
    from nebula_host import config

    d = tmp_path / "hand-written"
    d.mkdir()
    (d / "config.yaml").write_text("instance:\n  port: 3190\n")
    monkeypatch.setenv("NEBULA_DATA_DIR", str(d))
    monkeypatch.setenv("NEBULA_INSTANCE", "lab")
    cfg = config.load_config()
    assert cfg.instance_id == "lab" and cfg.instance.port == 3190
    config.save_config(cfg)
    assert config.recorded_instance_id(d) == "lab"


def test_save_config_never_rewrites_another_instances_id(tmp_path, monkeypatch):
    from nebula_host import config

    d = tmp_path / "alpha-data"
    monkeypatch.setenv("NEBULA_DATA_DIR", str(d))
    monkeypatch.setenv("NEBULA_INSTANCE", "alpha")
    cfg = config.load_config()
    config.save_config(cfg)
    before = (d / "config.yaml").read_bytes()
    cfg.instance.id = "beta"
    with pytest.raises(ValueError, match="belongs to instance 'alpha'"):
        config.save_config(cfg)
    assert (d / "config.yaml").read_bytes() == before


def test_cli_refuses_another_instance_on_the_owners_data_dir_and_writes_nothing(home, monkeypatch, capsys):
    """`nebula --instance test --data-dir <standard dir> install` on a pre-instance-id install: refused before
    config.yaml, the database, the LaunchAgent or the installer is touched."""
    from nebula_setup import cli, installer, launchd

    std = _std(home)
    raw = _legacy_install(std)
    before = {p.name: p.stat().st_mtime_ns for p in std.iterdir()}

    def boom(*a, **k):
        raise AssertionError("must not get this far")

    monkeypatch.setattr(installer, "install", boom)
    monkeypatch.setattr(launchd, "install", boom)
    # launchd's own view of subprocess only: patching subprocess.run itself would leak into `run=subprocess.run`
    # defaults of modules first imported during this test
    monkeypatch.setattr(launchd, "subprocess", types.SimpleNamespace(run=boom))
    for cmd in (["install", "--autostart", "no"], ["status"], ["autostart", "enable"], ["migrate"]):
        assert cli.main(["--instance", "test", "--data-dir", str(std), *cmd]) == 2, cmd
        assert "before instance ids existed" in capsys.readouterr().err
    assert (std / "config.yaml").read_bytes() == raw
    assert {p.name: p.stat().st_mtime_ns for p in std.iterdir()} == before
    # a fresh standard dir is refused too, and is not even created
    fresh_home = home / "fresh"
    fresh_home.mkdir()
    monkeypatch.setenv("HOME", str(fresh_home))
    assert cli.main(["--instance", "test", "--data-dir", str(_std(fresh_home)), "status"]) == 2
    assert "default instance's data dir" in capsys.readouterr().err
    assert not _std(fresh_home).exists()


# ------------------------------------------------------------------ runtime contents
def test_runtime_ships_the_third_party_notices():
    from nebula_setup import runtime

    assert "THIRD_PARTY_NOTICES.md" in runtime.COPY and "THIRD_PARTY_NOTICES.md" not in runtime.OPTIONAL
    assert (ROOT / "THIRD_PARTY_NOTICES.md").is_file()
    assert "THIRD_PARTY_NOTICES.md" in (ROOT / "scripts/build-release.sh").read_text()


# ------------------------------------------------------------------ install.sh
def _script_env(tmp_path: Path) -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if not k.startswith("NEBULA_")}
    env.update(NEBULA_SECRET_BACKEND="memory", NEBULA_DATA_DIR=str(tmp_path / "data"))
    return env


def _fake_install(d: Path, instance: str, *, failed: bool = False) -> None:
    (d / "vm/shared").mkdir(parents=True)
    (d / "vm/shared/config.json").write_text("{}")
    (d / "nebula.db").write_bytes(b"")
    (d / "config.yaml").write_text(f"instance:\n  id: {instance}\n  name: My NEBULA\n  port: 3190\n")
    report = {"job_id": "j", "app_version": "1.0.0", "image_version": "img"}
    if failed:
        report["error"] = {"state": "VM_BOOT", "message": "boom"}
    (d / "install-report.json").write_text(json.dumps(report, indent=2))


def _snapshot(base: Path) -> dict[str, tuple[int, int]]:
    return {str(p.relative_to(base)): (p.stat().st_size, p.stat().st_mtime_ns) for p in sorted(base.rglob("*"))}


def _check(tmp_path: Path, instance: str) -> subprocess.CompletedProcess:
    return subprocess.run(["/bin/bash", str(ROOT / "install.sh"), "--check", "--instance", instance],
                          capture_output=True, text=True, env=_script_env(tmp_path), stdin=subprocess.DEVNULL,
                          timeout=90)


@pytest.mark.skipif(sys.platform != "darwin", reason="macOS installer")
def test_install_check_on_an_installed_instance_says_already_installed(tmp_path):
    iid = "fixround-installed"
    _fake_install(tmp_path / "data", iid)
    before = _snapshot(tmp_path)
    r = _check(tmp_path, iid)
    assert r.returncode in (0, 1), r.stderr  # 1 only when this Mac itself fails a hardware check
    out = r.stdout
    assert re.search(r"^Compatibility check", out, re.M), out
    assert "already installed" in out and f"./update.sh --instance {iid}" in out
    assert f".venv/bin/nebula --instance {iid} status" in out
    assert "ready to install" not in out and "nothing was changed" in out
    assert _snapshot(tmp_path) == before  # still changes nothing


@pytest.mark.skipif(sys.platform != "darwin", reason="macOS installer")
def test_install_check_after_a_failed_install_is_not_installed(tmp_path):
    iid = "fixround-failed"
    _fake_install(tmp_path / "data", iid, failed=True)
    r = _check(tmp_path, iid)
    assert r.returncode in (0, 1), r.stderr
    assert "already installed" not in r.stdout and "install not finished" in r.stdout


@pytest.mark.skipif(sys.platform != "darwin", reason="macOS installer")
def test_install_check_refuses_another_instances_data_dir(tmp_path):
    _fake_install(tmp_path / "data", "fixround-owner")
    before = _snapshot(tmp_path)
    r = _check(tmp_path, "fixround-other")
    assert r.returncode == 1
    assert "belongs to instance 'fixround-owner'" in r.stdout and "already installed" not in r.stdout
    assert _snapshot(tmp_path) == before
    # a pre-instance-id install (no id, database present) is the default instance's
    legacy = tmp_path / "legacy"
    _legacy_install(legacy / "data")
    r = _check(legacy, "fixround-other")
    assert r.returncode == 1 and "belongs to instance 'default'" in r.stdout


def _node_version_ok_function() -> str:
    text = (ROOT / "install.sh").read_text()
    m = re.search(r"^node_version_ok\(\) \{\n.*?^\}\n", text, re.M | re.S)
    assert m, "node_version_ok() not found in install.sh"
    return m.group(0)


def test_install_requires_the_dashboards_node_engines():
    """install.sh accepts exactly the Node.js versions the dashboard build runs on: Vite's own engines field in the
    lockfile (the binding constraint), which the dashboard's package.json must not undercut."""
    lock = (ROOT / "apps/dashboard/pnpm-lock.yaml").read_text()
    vite = re.findall(r"^  vite@[0-9.]+:\n    resolution: .*\n    engines: \{node: (.+)\}$", lock, re.M)
    assert vite, "vite entry not found in pnpm-lock.yaml"
    engines = vite[0]
    assert engines == "^20.19.0 || >=22.12.0"  # the cases below encode this range
    pkg = json.loads((ROOT / "apps/dashboard/package.json").read_text())["engines"]["node"]
    assert "20.19.0" in pkg, pkg
    text = (ROOT / "install.sh").read_text()
    assert f'NODE_ENGINES="{engines}"' in text, "install.sh NODE_ENGINES must match Vite's engines"
    fn = _node_version_ok_function()
    good = ["20.19.0", "20.19.5", "20.20.1", "22.12.0", "22.13.1", "23.0.0", "24.11.1", "25.5.0", "v22.12.0"]
    bad = ["20.18.1", "20.0.0", "21.7.3", "22.0.0", "22.11.0", "18.20.4", "16.0.0", "", "abc", "20", "x.19.0"]
    script = fn + "set -euo pipefail\nfor v in \"$@\"; do if node_version_ok \"$v\"; then echo \"ok $v\"; " \
                  "else echo \"no $v\"; fi; done\n"
    r = subprocess.run(["/bin/bash", "-c", script, "bash", *good, *bad], capture_output=True, text=True, check=True)
    lines = r.stdout.splitlines()
    assert lines == [f"ok {v}" for v in good] + [f"no {v}" for v in bad]
    assert "MIN_NODE_MAJOR" not in text  # the old "any 20.x" check is gone


# ------------------------------------------------------------------ guest supply chain + DNS (provision.sh)
def test_guest_pip_installs_are_wheel_only_and_the_lock_is_hash_checked():
    text = PROVISION.read_text()
    pip_lines = [ln for ln in text.splitlines() if "pip install" in ln and not ln.lstrip().startswith("#")]
    assert pip_lines
    assert all("--only-binary :all:" in ln for ln in pip_lines), pip_lines
    lock = [ln for ln in pip_lines if "$GUEST_REQUIREMENTS" in ln]
    assert len(lock) == 1 and "--require-hashes" in lock[0] and lock[0].rstrip().endswith('-r "$GUEST_REQUIREMENTS"')


def _nft_ruleset() -> str:
    text = PROVISION.read_text()
    m = re.search(r"cat > /etc/nftables.conf <<'EOF'\n(.*?)\nEOF\n", text, re.S)
    assert m
    return m.group(1)


def test_guest_dns_is_limited_to_the_vms_resolvers():
    rules = _nft_ruleset()
    dns = [ln.strip() for ln in rules.splitlines() if "dport 53" in ln]
    assert dns == ["ip daddr @dns4 meta l4proto { tcp, udp } th dport 53 accept",
                   "ip6 daddr @dns6 meta l4proto { tcp, udp } th dport 53 accept"]
    assert "set dns4 { type ipv4_addr; }" in rules and "set dns6 { type ipv6_addr; }" in rules
    # the resolver rules come before the private-range drops, the generated file is included before the owner's
    out = rules[rules.index("chain output"):]
    assert out.index("@dns4") < out.index("@blocked4")
    assert rules.index('include "/etc/nebula/firewall-dns.nft"') < rules.index(
        'include "/etc/nebula/firewall-lan-allow.nft"')
    text = PROVISION.read_text()
    assert "> /etc/nebula/firewall-dns.nft" in text and "nft -c -f /etc/nftables.conf" in text


def test_guest_firewall_keeps_the_installers_ssh_session():
    # Found by the clean install on a real VM: the provisioning SSH session predates the ruleset, conntrack picked its
    # next reply up as a new flow to 192.168.64.1, the private-range drop ate it and the installer hung for good.
    rules = _nft_ruleset()
    out = rules[rules.index("chain output"):]
    rule = "ip daddr 192.168.64.1 tcp sport 22 accept"
    assert rule in out
    assert out.index(rule) < out.index("ip daddr @blocked4")
    # the input side still admits SSH only from the host
    assert "ip saddr 192.168.64.1 tcp dport 22 accept" in rules[rules.index("chain input"):rules.index("chain forward")]


def test_host_ssh_and_scp_use_keepalives(tmp_path):
    from nebula_host.vm import VMManager

    class _Cfg:
        keys_dir = tmp_path

    vm = VMManager.__new__(VMManager)
    vm.cfg = _Cfg()
    base = vm.ssh_base("192.168.64.2")
    assert "ServerAliveInterval=15" in base and "ServerAliveCountMax=8" in base
    assert base[-1] == "nebula-admin@192.168.64.2"


def _dns_functions() -> str:
    text = PROVISION.read_text()
    join = re.search(r"^nft_join\(\) \{.*\}\n", text, re.M)
    fn = re.search(r"^dns_resolver_elements\(\) \{.*?^\}\n", text, re.M | re.S)
    assert join and fn
    return join.group(0) + fn.group(0)


def _dns(gw: str, *files: Path) -> list[str]:
    script = "set -euo pipefail\n" + _dns_functions() + 'dns_resolver_elements "$@"\n'
    r = subprocess.run(["/bin/bash", "-c", script, "bash", gw, *map(str, files)], capture_output=True, text=True,
                       check=True)
    return r.stdout.splitlines()


def test_dns_resolver_detection(tmp_path):
    resolved = tmp_path / "resolved.conf"
    resolved.write_text("# upstream servers\nnameserver 192.168.64.1\nnameserver fe80::1%enp0s1\n"
                        "nameserver 127.0.0.53\nnameserver 10.20.30.40\nsearch localdomain\n")
    stub = tmp_path / "stub.conf"
    stub.write_text("nameserver 127.0.0.53\noptions edns0 trust-ad\nnameserver 10.20.30.40\n")
    assert _dns("192.168.64.1", resolved, stub, tmp_path / "missing") == [
        "add element inet filter dns4 { 192.168.64.1, 10.20.30.40 }",
        "add element inet filter dns6 { fe80::1 }"]
    # nothing usable: the vmnet gateway; anything that is not a plain address never reaches nft
    evil = tmp_path / "evil.conf"
    evil.write_text("nameserver 1.1.1.1;flush\nnameserver 8.8.8.8}\nnameserver ::1\nnameserver $(reboot)\n"
                    "nameserver fd00::53;\nnameserver 0.0.0.0\n")
    assert _dns("", evil) == ["add element inet filter dns4 { 192.168.64.1 }"]
    assert _dns("192.168.65.1") == ["add element inet filter dns4 { 192.168.65.1 }"]  # another vmnet subnet


# ------------------------------------------------------------------ systemd sandboxing of the agent units (VM-16)
def _unit(name: str) -> dict[str, dict[str, list[str]]]:
    sections: dict[str, dict[str, list[str]]] = {}
    cur = None
    for raw in (UNITS / name).read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith(("#", ";")):
            continue
        if line.startswith("["):
            cur = sections.setdefault(line.strip("[]"), {})
            continue
        assert cur is not None and "=" in line, raw
        key, _, value = line.partition("=")
        assert "#" not in value, f"inline comments are not comments in unit files: {raw}"
        cur.setdefault(key, []).append(value)
    return sections


HARDENING = {
    "NoNewPrivileges": "yes", "PrivateTmp": "yes", "ProtectProc": "invisible", "ProtectKernelTunables": "yes",
    "ProtectKernelModules": "yes", "ProtectKernelLogs": "yes", "ProtectControlGroups": "yes",
    "RestrictSUIDSGID": "yes", "LockPersonality": "yes", "RestrictRealtime": "yes",
    "RestrictAddressFamilies": "AF_UNIX AF_INET AF_INET6 AF_NETLINK",
}


@pytest.mark.parametrize("name", ["nebula-tools@.service", "nebula-desktop@.service"])
def test_agent_units_are_sandboxed_without_breaking_chromium(name):
    svc = _unit(name)["Service"]
    for key, value in HARDENING.items():
        assert svc.get(key) == [value], (name, key, svc.get(key))
    # these would break Chromium's sandbox (user namespaces), V8's JIT, or ps/free/top in the agent's shell
    for forbidden in ("RestrictNamespaces", "MemoryDenyWriteExecute", "ProcSubset", "PrivateUsers",
                      "SystemCallFilter", "PrivateNetwork"):
        assert forbidden not in svc, (name, forbidden)
    assert svc["User"] == ["%i"] and svc["Group"] == ["%i"]
    assert "AF_VSOCK" not in svc["RestrictAddressFamilies"][0]


def test_tool_server_shares_the_desktops_private_tmp():
    tools, desk = _unit("nebula-tools@.service"), _unit("nebula-desktop@.service")
    assert tools["Unit"]["JoinsNamespaceOf"] == ["nebula-desktop@%i.service"]
    assert tools["Unit"]["After"] == ["nebula-desktop@%i.service"]
    assert desk["Service"]["PrivateTmp"] == tools["Service"]["PrivateTmp"] == ["yes"]
    # unchanged pieces the tool server relies on
    assert tools["Service"]["ProtectHome"] == ["tmpfs"] and tools["Service"]["BindPaths"] == ["/home/%i"]
    assert tools["Service"]["PrivateDevices"] == ["no"]
    assert desk["Service"]["RuntimeDirectory"] == ["nebula-vnc/%i nebula-xdg/%i"]


def test_display_allocation_sees_x_servers_in_private_tmp(monkeypatch):
    """With PrivateTmp the socket file of an agent's own X server is invisible to root; its abstract socket is not."""
    from nebula_guest import workspace, xdisplay

    busy = {21}
    monkeypatch.setattr(xdisplay, "listeners", lambda n, **kw: [{"kind": "abstract", "uid": 1001}] if n in busy
                        else [])
    reg = {"agents": {"a": {"display": 22}}}
    assert workspace.allocate_display(reg) == 23

    def unknown(n, **kw):
        if n == 23:
            raise TimeoutError("no answer")
        return []

    monkeypatch.setattr(xdisplay, "listeners", unknown)
    assert workspace.allocate_display(reg) == 21
    busy_all = {"agents": {str(n): {"display": n} for n in range(21, 23)}}
    assert workspace.allocate_display(busy_all) == 24


# ------------------------------------------------------------------ TEST instance server fixtures
def test_test_instance_fixtures_are_english():
    spec = importlib.util.spec_from_file_location("nebula_test_instance_fix", ROOT / "scripts/test_instance.py")
    ti = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(ti)
    # the shared contract with the iOS / macOS UI tests
    assert ti.CONVERSATION_TITLE == "E2E conversation"
    assert ti.LONG_CONVERSATION_TITLE == "Long conversation"
    assert "> Done – I changed nothing.\n" in ti.ANSWER
    for i in (0, 1, 2, 13):
        msg = ti.seed_message(i, i % 2 == 0)
        assert msg.isascii(), msg
    assert ti.seed_message(4, True) == "Question 4: summarize step 2"
    assert ti.seed_message(5, False).startswith("Answer **5**")
    assert ti.TASK_PROMPT.isascii()
    src = (ROOT / "scripts/test_instance.py").read_text()
    assert not re.search(r"[ěščřžýáíéůúťďňĚŠČŘŽÝÁÍÉŮÚŤĎŇ]", src)
    for czech in ("konverzace", "Shrň", "Otázka", "Odpověď", "bod A", "odstavce"):
        assert czech not in src
