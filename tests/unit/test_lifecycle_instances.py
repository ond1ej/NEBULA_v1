"""Instance scoping (W2 lifecycle): two NEBULA installs on one Mac never share a Keychain service, LaunchAgent,
data dir or VM hostname; uninstall --remove-data deletes all and only its own Keychain items; push alerts are
English; the guest Python packages are hash-pinned; the manifest key can be overridden for forks.

Nothing here calls launchctl, the real Keychain or the network: launchctl and keyring are faked, HOME is a tmp dir.
"""

from __future__ import annotations

import base64
import importlib.util
import json
import plistlib
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture()
def home(tmp_path, monkeypatch):
    """A fake HOME so standard_data_dir()/LaunchAgents point into tmp; no instance env leaks in."""
    h = tmp_path / "home"
    h.mkdir()
    monkeypatch.setenv("HOME", str(h))
    for k in ("NEBULA_INSTANCE", "NEBULA_DATA_DIR", "NEBULA_LOG_DIR", "NEBULA_PORT", "NEBULA_KEYCHAIN_SERVICE"):
        monkeypatch.delenv(k, raising=False)
    from nebula_host.config import get_config

    get_config.cache_clear()
    yield h
    get_config.cache_clear()


class FakeKeyring:
    """Stand-in for the `keyring` module: items keyed by (service, account)."""

    def __init__(self) -> None:
        self.items: dict[tuple[str, str], str] = {}

    def set_password(self, service, account, value):
        self.items[(service, account)] = value

    def get_password(self, service, account):
        return self.items.get((service, account))

    def delete_password(self, service, account):
        if (service, account) not in self.items:
            raise KeyError(account)
        del self.items[(service, account)]

    def accounts(self, service):
        return {a for (s, a) in self.items if s == service}


@pytest.fixture()
def fake_keyring(monkeypatch):
    kr = FakeKeyring()
    monkeypatch.setitem(sys.modules, "keyring", kr)
    return kr


# ------------------------------------------------------------------ config + names
def test_default_instance_names(home):
    from nebula_host import config, secrets

    cfg = config.load_config()
    assert cfg.instance_id == "default" and cfg.is_default_instance
    assert cfg.data_dir == home / "Library/Application Support/NEBULA"
    assert cfg.log_dir == home / "Library/Logs/NEBULA"
    assert cfg.launchd_label == "dev.nebula.host"
    assert cfg.vm_hostname == "nebula-vm"
    assert secrets.service_name("default") == "dev.nebula.platform" == secrets.DEFAULT_SERVICE
    assert cfg.lan.https_port == 3443


def test_named_instance_is_scoped_everywhere(home, monkeypatch):
    from nebula_host import config, secrets

    monkeypatch.setenv("NEBULA_INSTANCE", "Test-2")
    cfg = config.load_config()
    assert cfg.instance_id == "test-2"
    assert cfg.data_dir == home / "Library/Application Support/NEBULA-test-2"  # sibling, never nested
    assert cfg.log_dir == cfg.data_dir / "logs"
    assert cfg.launchd_label == "dev.nebula.host.test-2"
    assert cfg.vm_hostname == "nebula-vm-test-2"
    assert secrets.service_name("test-2") == "dev.nebula.platform.test-2"
    config.get_config.cache_clear()
    assert secrets.service_name() == "dev.nebula.platform.test-2"  # this process's instance
    assert cfg.lan.https_port == config.instance_https_port(cfg.instance.port) == 4100 != 3443


@pytest.mark.parametrize("a,b", [("default", "test"), ("test", "test2"), ("a", "default"), ("e2e-test", "e2e")])
def test_two_instances_never_share_service_label_dir_or_hostname(home, a, b):
    from nebula_host import config, secrets

    assert secrets.service_name(a) != secrets.service_name(b)
    assert config.launchd_label(a) != config.launchd_label(b)
    assert config.vm_hostname(a) != config.vm_hostname(b)
    da, db_ = config.instance_data_dir(a), config.instance_data_dir(b)
    assert da != db_ and da not in db_.parents and db_ not in da.parents


@pytest.mark.parametrize("bad", ["", "-x", "x-", "UPPER CASE", "a/b", "a.b", "x" * 33, "../etc"])
def test_invalid_instance_ids_are_refused(bad):
    from nebula_host import config

    with pytest.raises(ValueError):
        config.validate_instance_id(bad)


def test_instance_id_persists_and_mismatch_is_refused(home, monkeypatch):
    from nebula_host import config

    monkeypatch.setenv("NEBULA_INSTANCE", "alpha")
    cfg = config.load_config()
    config.save_config(cfg)
    monkeypatch.delenv("NEBULA_INSTANCE")
    monkeypatch.setenv("NEBULA_DATA_DIR", str(cfg.data_dir))
    assert config.load_config().instance_id == "alpha"  # read back from config.yaml
    monkeypatch.setenv("NEBULA_INSTANCE", "beta")
    with pytest.raises(ValueError, match="instance mismatch"):
        config.load_config()


def test_keychain_service_override(home, monkeypatch):
    from nebula_host import secrets

    monkeypatch.setenv("NEBULA_KEYCHAIN_SERVICE", "org.example.nebula-ci")
    assert secrets.service_name() == "org.example.nebula-ci"
    assert secrets.service_name("default") == "dev.nebula.platform"  # explicit ids stay pure
    monkeypatch.setenv("NEBULA_KEYCHAIN_SERVICE", "bad service!")
    with pytest.raises(ValueError):
        secrets.service_name()


def test_isolation_guard_refuses_default_id_on_foreign_data_dir(home, tmp_path, monkeypatch):
    from nebula_host import config

    monkeypatch.setenv("NEBULA_DATA_DIR", str(tmp_path / "elsewhere"))
    cfg = config.load_config()
    cfg.secret_backend = "keychain"
    with pytest.raises(ValueError, match="share the default instance"):
        cfg.check_instance_isolation()
    cfg.secret_backend = "memory"
    cfg.check_instance_isolation()  # tests / test instances with the memory store are fine
    cfg.secret_backend = "keychain"
    cfg.instance.id = "other"
    cfg.check_instance_isolation()
    monkeypatch.delenv("NEBULA_DATA_DIR")
    std = config.load_config()
    std.secret_backend = "keychain"
    std.check_instance_isolation()  # the default instance in its standard dir


# ------------------------------------------------------------------ Keychain store
def test_keychain_stores_of_two_instances_are_isolated_and_indexed(home, fake_keyring):
    from nebula_host import secrets

    a = secrets.KeychainStore(secrets.service_name("default"))
    b = secrets.KeychainStore(secrets.service_name("test"))
    a.set("nebula:provider.openai-api", "A-VALUE")
    b.set("nebula:provider.openai-api", "B-VALUE")
    assert a.get("nebula:provider.openai-api") == "A-VALUE"
    assert b.get("nebula:provider.openai-api") == "B-VALUE"
    assert a.refs() == ["nebula:provider.openai-api"]
    b.set("nebula:telegram.agentbot.x1", "t")
    assert b.refs() == ["nebula:provider.openai-api", "nebula:telegram.agentbot.x1"]
    b.delete("nebula:telegram.agentbot.x1")
    assert b.refs() == ["nebula:provider.openai-api"]
    assert fake_keyring.accounts("dev.nebula.platform") == {"nebula:provider.openai-api", secrets.INDEX_REF}
    index = json.loads(fake_keyring.items[("dev.nebula.platform.test", secrets.INDEX_REF)])
    assert index == ["nebula:provider.openai-api"]  # names only
    assert "B-VALUE" not in json.dumps(index)


def test_init_store_binds_this_instances_service(home, fake_keyring, monkeypatch):
    from nebula_host import config, secrets

    monkeypatch.setenv("NEBULA_INSTANCE", "zeta")
    config.get_config.cache_clear()
    st = secrets.init_store("keychain")
    try:
        assert st.service == "dev.nebula.platform.zeta"
    finally:
        secrets.init_store("memory")


def _cfg_for(home, monkeypatch, iid):
    from nebula_host import config

    monkeypatch.setenv("NEBULA_INSTANCE", iid)
    monkeypatch.delenv("NEBULA_DATA_DIR", raising=False)
    config.get_config.cache_clear()
    return config.get_config()


def test_remove_data_deletes_all_and_only_this_instances_items(home, fake_keyring, monkeypatch):
    """Instance `test` uninstall --remove-data: every one of its refs goes (index, DB-recorded legacy refs and fixed
    refs), and the default instance's identical refs stay."""
    from nebula_host import db, models, providers_service, secrets
    from nebula_setup import installer
    from sqlalchemy import update

    owner = secrets.KeychainStore(secrets.service_name("default"))
    for ref in ("nebula:guest_rpc_key", "nebula:app.server_key", "nebula:provider.openai-api", "nebula:apns.key",
                "nebula:telegram.agentbot.r1"):
        owner.set(ref, "OWNER")
    cfg = _cfg_for(home, monkeypatch, "test")
    cfg.secret_backend = "keychain"
    cfg.ensure_dirs()
    db.init_engine(cfg.db_path)
    providers_service.ensure_catalog()
    st = secrets.init_store("keychain")
    try:
        assert st.service == "dev.nebula.platform.test"
        for ref in ("nebula:guest_rpc_key", "nebula:app.server_key", "nebula:telegram.callback_key",
                    "nebula:telegram.agentbot.r1", "nebula:provider.anthropic-api"):
            st.set(ref, "TEST")
        # a legacy item written before the index existed, known only from the DB
        fake_keyring.set_password("dev.nebula.platform.test", "nebula:provider.openai-api", "TEST")
        with db.engine().begin() as c:
            c.execute(update(models.providers).where(models.providers.c.id == "openai-api")
                      .values(keychain_ref="nebula:provider.openai-api"))
        out = installer.remove_instance_secrets(cfg)
        assert out["service"] == "dev.nebula.platform.test"
        assert fake_keyring.accounts("dev.nebula.platform.test") == set()
        assert fake_keyring.accounts("dev.nebula.platform") >= {
            "nebula:guest_rpc_key", "nebula:app.server_key", "nebula:provider.openai-api", "nebula:apns.key",
            "nebula:telegram.agentbot.r1"}
        assert all(v == "OWNER" for (s, _), v in fake_keyring.items.items()
                   if s == "dev.nebula.platform" and _ != secrets.INDEX_REF)
    finally:
        secrets.init_store("memory")


def test_remove_data_refuses_a_store_bound_to_another_service(home, fake_keyring, monkeypatch):
    from nebula_host import secrets
    from nebula_setup import installer

    cfg = _cfg_for(home, monkeypatch, "test")
    cfg.secret_backend = "keychain"
    secrets._store = secrets.KeychainStore("dev.nebula.platform")  # wrong: the default instance's service
    try:
        with pytest.raises(installer.InstallError, match="refusing"):
            installer.remove_instance_secrets(cfg)
    finally:
        secrets.init_store("memory")


def test_instance_secret_refs_cover_every_known_ref(dbinit):
    from nebula_host import secrets
    from nebula_setup import installer

    secrets.store().set("nebula:telegram.agentbot.abc", "x")
    refs = set(installer.instance_secret_refs())
    assert {"nebula:guest_rpc_key", "nebula:app.server_key", "nebula:apns.key", "nebula:telegram.callback_key",
            "nebula:telegram.bot_token", "nebula:provider.openai-siwc", "nebula:telegram.agentbot.abc",
            "nebula:provider.openai-api", secrets.INDEX_REF} <= refs


# ------------------------------------------------------------------ LaunchAgent
class FakeLaunchctl:
    def __init__(self, loaded_env: dict[str, str] | None = None):
        self.calls: list[list[str]] = []
        self.loaded: dict[str, str] = {}  # label -> data dir shown by `launchctl print`
        self.loaded_env = loaded_env or {}

    def __call__(self, cmd, **kw):
        self.calls.append(list(cmd))
        assert cmd[0] == "launchctl", cmd
        verb = cmd[1]
        if verb == "print":
            label = cmd[2].rsplit("/", 1)[1]
            if label in self.loaded:
                out = f"state = running\npid = 4242\nenvironment = {{\n  NEBULA_DATA_DIR => {self.loaded[label]}\n}}\n"
                return subprocess.CompletedProcess(cmd, 0, out, "")
            return subprocess.CompletedProcess(cmd, 113, "", "Could not find service")
        if verb == "bootout":
            self.loaded.pop(cmd[2].rsplit("/", 1)[1], None)
            return subprocess.CompletedProcess(cmd, 0, "", "")
        if verb == "bootstrap":
            with open(cmd[3], "rb") as f:
                d = plistlib.load(f)
            self.loaded[d["Label"]] = d["EnvironmentVariables"]["NEBULA_DATA_DIR"]
            return subprocess.CompletedProcess(cmd, 0, "", "")
        if verb == "kickstart":
            return subprocess.CompletedProcess(cmd, 0, "", "")
        raise AssertionError(cmd)

    def verbs(self):
        return [c[1] for c in self.calls]


@pytest.fixture()
def launchctl(home, monkeypatch, tmp_path):
    from nebula_setup import launchd

    fake = FakeLaunchctl()
    monkeypatch.setattr(launchd.subprocess, "run", fake)
    monkeypatch.setattr(launchd.time, "sleep", lambda s: None)
    agents = tmp_path / "LaunchAgents"
    monkeypatch.setattr(launchd, "launch_agents_dir", lambda: agents)
    return fake


def test_launchagent_label_and_plist_are_per_instance(launchctl, home, monkeypatch, tmp_path):
    from nebula_setup import launchd

    cfg = _cfg_for(home, monkeypatch, "test")
    p = launchd.install(["/py", "-m", "nebula_setup.cli", "serve"], tmp_path / "logs")
    assert p.name == "dev.nebula.host.test.plist"
    d = plistlib.loads(p.read_bytes())
    assert d["Label"] == "dev.nebula.host.test"
    assert d["EnvironmentVariables"]["NEBULA_DATA_DIR"] == str(cfg.data_dir)
    assert d["EnvironmentVariables"]["NEBULA_INSTANCE"] == "test"
    assert all("dev.nebula.host.test" in " ".join(c) or c[1] == "bootstrap" for c in launchctl.calls)
    st = launchd.status()
    assert st["label"] == "dev.nebula.host.test" and st["loaded"] and st["data_dir"] == str(cfg.data_dir)


def test_never_touch_a_plist_of_another_data_dir(launchctl, home, monkeypatch, tmp_path):
    """A test install that (wrongly) shares the label must not boot out, rewrite or delete the owner's agent."""
    from nebula_setup import launchd

    owner_dir = home / "Library/Application Support/NEBULA"
    agents = launchd.launch_agents_dir()
    agents.mkdir(parents=True)
    owner_plist = agents / "dev.nebula.host.plist"
    owner_plist.write_bytes(plistlib.dumps({"Label": "dev.nebula.host", "ProgramArguments": ["/owner/python"],
                                            "EnvironmentVariables": {"NEBULA_DATA_DIR": str(owner_dir)}}))
    before = owner_plist.read_bytes()
    other = tmp_path / "other-data"
    with pytest.raises(launchd.LaunchdConflict):
        launchd.install(["/py"], tmp_path / "logs", env={"NEBULA_DATA_DIR": str(other)}, label="dev.nebula.host")
    with pytest.raises(launchd.LaunchdConflict):
        launchd.uninstall("dev.nebula.host", other)
    with pytest.raises(launchd.LaunchdConflict):
        launchd.restart("dev.nebula.host", other)
    with pytest.raises(launchd.LaunchdConflict):
        launchd.stop("dev.nebula.host", other)
    assert owner_plist.read_bytes() == before
    assert not [c for c in launchctl.calls if c[1] in ("bootout", "bootstrap", "kickstart")]
    # the owner itself may manage it
    assert launchd.uninstall("dev.nebula.host", owner_dir) is True
    assert not owner_plist.exists()


def test_legacy_plist_without_data_dir_belongs_to_the_standard_dir(launchctl, home, tmp_path):
    from nebula_setup import launchd

    agents = launchd.launch_agents_dir()
    agents.mkdir(parents=True)
    (agents / "dev.nebula.host.plist").write_bytes(plistlib.dumps({"Label": "dev.nebula.host"}))
    assert launchd.plist_data_dir("dev.nebula.host") == home / "Library/Application Support/NEBULA"
    with pytest.raises(launchd.LaunchdConflict):
        launchd.check_owner("dev.nebula.host", tmp_path / "x")


def test_loaded_job_of_another_data_dir_is_refused_even_without_plist(launchctl, home, tmp_path):
    from nebula_setup import launchd

    launchctl.loaded["dev.nebula.host"] = "/Users/someone/Library/Application Support/NEBULA"
    assert launchd.loaded_data_dir("dev.nebula.host") == Path("/Users/someone/Library/Application Support/NEBULA")
    with pytest.raises(launchd.LaunchdConflict):
        launchd.uninstall("dev.nebula.host", tmp_path / "mine")
    assert "bootout" not in launchctl.verbs()


def test_restart_kickstarts_only_this_label(launchctl, home, monkeypatch, tmp_path):
    from nebula_setup import launchd

    _cfg_for(home, monkeypatch, "kick")
    launchd.install(["/py"], tmp_path / "logs")
    launchctl.calls.clear()
    st = launchd.restart()
    assert ["launchctl", "kickstart", "-k", f"gui/{__import__('os').getuid()}/dev.nebula.host.kick"] in launchctl.calls
    assert st["label"] == "dev.nebula.host.kick"


def test_uninstall_keeps_a_foreign_launchagent(launchctl, dbinit, monkeypatch):
    from nebula_setup import installer, launchd

    agents = launchd.launch_agents_dir()
    agents.mkdir(parents=True, exist_ok=True)
    foreign = agents / f"{dbinit.launchd_label}.plist"
    foreign.write_bytes(plistlib.dumps({"Label": dbinit.launchd_label,
                                        "EnvironmentVariables": {"NEBULA_DATA_DIR": "/elsewhere"}}))
    monkeypatch.setattr(installer.subprocess, "run",
                        lambda *a, **k: subprocess.CompletedProcess(a, 0, "", ""))  # the orphan `ps` probe
    out = installer.uninstall(dbinit, remove_data=False, confirm=None, printer=lambda r: None)
    assert out["launch_agent_removed"] is False and "another NEBULA data dir" in out["launch_agent_kept"]
    assert foreign.exists()


# ------------------------------------------------------------------ install idempotency, VM hostname
def test_install_when_already_ready_does_nothing(dbinit, monkeypatch):
    from nebula_setup import installer

    installer.set_installation(state="READY", vm_image_version="img-1", guest_version="0.1.0")
    (dbinit.vm_bundle).mkdir(parents=True, exist_ok=True)
    (dbinit.vm_bundle / "config.json").write_text("{}")

    def boom(*a, **k):
        raise installer.InstallError("PREFLIGHT", "boom", "must not provision a READY install")

    monkeypatch.setattr(installer, "install_helper", boom)
    monkeypatch.setattr(installer, "provision_guest", boom)
    lines: list[str] = []
    r = installer.install(dbinit, printer=lines.append)
    assert r["already_ready"] is True and r["image_version"] == "img-1"
    assert any("already READY - nothing to do" in ln for ln in lines)
    # --reprovision goes through the full path (stops at our boom)
    r2 = installer.install(dbinit, printer=lambda s: None, reprovision=True)
    assert "error" in r2 or r2.get("already_ready") is not True


def test_seed_uses_the_instance_hostname(tmp_path, monkeypatch):
    from nebula_setup import seed

    keys = {}
    for n in ("client", "host"):
        (tmp_path / n).write_text(f"PRIVATE-{n}")
        (tmp_path / f"{n}.pub").write_text(f"ssh-ed25519 AAAA{n} c")
        keys[n], keys[f"{n}_pub"] = tmp_path / n, tmp_path / f"{n}.pub"
    seen = {}

    def fake_run(cmd, check=True, **kw):
        d = Path(cmd[cmd.index("-o") + 2])
        seen["user"] = (d / "user-data").read_text()
        seen["meta"] = (d / "meta-data").read_text()
        Path(cmd[cmd.index("-o") + 1]).write_bytes(b"iso")
        return subprocess.CompletedProcess(cmd, 0)

    monkeypatch.setattr(seed.subprocess, "run", fake_run)
    seed.build_seed_iso(tmp_path / "seed.iso", "iid", keys, hostname="nebula-vm-test")
    assert "hostname: nebula-vm-test" in seen["user"] and "local-hostname: nebula-vm-test" in seen["meta"]


def test_dhcp_lease_lookup_matches_exact_hostname_or_mac():
    from nebula_host.vm import lease_ip

    leases = ("{\n\tname=nebula-vm-test\n\tip_address=192.168.64.9\n\thw_address=1,aa:bb:cc:0:0:9\n}\n"
              "{\n\tname=nebula-vm\n\tip_address=192.168.64.3\n\thw_address=1,aa:bb:cc:0:0:3\n}\n")
    assert lease_ip(leases, "nebula-vm") == "192.168.64.3"  # not the -test VM listed first
    assert lease_ip(leases, "nebula-vm-test") == "192.168.64.9"
    assert lease_ip(leases, "nebula-vm", "aa:bb:cc:0:0:9") == "192.168.64.9"  # MAC wins
    assert lease_ip(leases, "nebula-vm-other") is None


# ------------------------------------------------------------------ push, manifest key, guest supply chain
def test_push_alerts_are_english_generic_and_topic_is_not_built_in(dbinit, monkeypatch):
    from nebula_host import push

    monkeypatch.delenv("NEBULA_APNS_TOPIC", raising=False)
    assert push.settings()["topic"] is None
    for t in ("task.completed", "task.failed", "task.approval.requested", "owner.approval.requested", "auth.request"):
        m = push.message_for({"type": t, "payload": {"agent_name": "Ada", "summary": "SECRET-TEXT",
                                                     "password": "hunter2"}})
        assert m and m["body"].startswith("Ada ") and m["body"].isascii() and m["title"].isascii()
        assert "SECRET" not in json.dumps(m) and "hunter2" not in json.dumps(m)
    monkeypatch.setenv("NEBULA_APNS_TOPIC", "org.example.nebula")
    assert push.settings()["topic"] == "org.example.nebula"
    assert "topic" in push.status()["missing"] or push.status()["topic"] == "org.example.nebula"


def _signed_manifest(tmp_path):
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

    k = Ed25519PrivateKey.generate()
    pub = base64.b64encode(k.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)).decode()
    d = tmp_path / "fork"
    (d / "keys").mkdir(parents=True)
    raw = json.dumps({"url": "https://x/y.img", "sha256": "0" * 64, "image_version": "fork", "format": "qcow2"}).encode()
    (d / "manifest.json").write_bytes(raw)
    (d / "manifest.json.sig").write_text(base64.b64encode(k.sign(raw)).decode())
    (d / "keys/nebula-release-ed25519.pub").write_text((ROOT / "guest/image-builder/keys/nebula-release-ed25519.pub")
                                                      .read_text())
    return d, pub


def test_manifest_pubkey_override_for_forks(tmp_path, monkeypatch):
    from nebula_setup import image

    d, pub = _signed_manifest(tmp_path)
    monkeypatch.delenv("NEBULA_MANIFEST_PUBKEY", raising=False)
    with pytest.raises(image.ImageError, match="signature"):
        image.load_manifest(d)  # the committed release key does not sign the fork's manifest
    monkeypatch.setenv("NEBULA_MANIFEST_PUBKEY", pub)
    assert image.load_manifest(d)["image_version"] == "fork"
    keyfile = tmp_path / "fork.pub"
    keyfile.write_text(pub + "\n")
    monkeypatch.setenv("NEBULA_MANIFEST_PUBKEY", str(keyfile))
    assert image.load_manifest(d)["image_version"] == "fork"
    assert image.release_pubkey(d)[1].startswith("NEBULA_MANIFEST_PUBKEY file")
    monkeypatch.setenv("NEBULA_MANIFEST_PUBKEY", "not-a-key")
    with pytest.raises(image.ImageError, match="bad_key|not a base64"):
        image.load_manifest(d)
    monkeypatch.delenv("NEBULA_MANIFEST_PUBKEY")
    assert image.release_pubkey()[1] == "committed release key"
    assert image.load_manifest()["url"].startswith("https://")  # the shipped manifest still verifies


def test_guest_requirements_are_pinned_with_hashes_and_match_the_manifest():
    req = (ROOT / "guest/image-builder/requirements-guest.txt").read_text()
    manifest = json.loads((ROOT / "guest/image-builder/manifest.json").read_text())
    pins = {}
    current = None
    for line in req.splitlines():
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        if s.startswith("--hash=sha256:"):
            assert current and len(s.split(":", 1)[1].rstrip(" \\")) == 64
            pins[current] += 1
            continue
        name, sep, ver = s.rstrip(" \\").partition("==")
        assert sep and ver and not any(c in ver for c in "<>=*,"), f"unpinned: {s}"
        current = name.lower()
        pins[current] = 0
    assert pins and all(n > 0 for n in pins.values()), pins
    assert {"playwright", "pillow"} <= set(pins)
    pw = next(ln for ln in req.splitlines() if ln.startswith("playwright=="))
    assert pw.split("==")[1].rstrip(" \\") == manifest["playwright_version"]


STAGE = "/home/nebula-admin/.nebula-stage.Ab12Cd"


def test_provisioning_ships_the_hashed_requirements(dbinit, monkeypatch, tmp_path):
    """Provisioning inputs go to a private 0700 staging dir (never the shared /tmp) with the hashed lock file."""
    from nebula_setup import installer

    sent, cmds, dests = [], [], []

    class VM:
        cfg = dbinit

        def ssh(self, ip, command, timeout=600):
            assert "mktemp -d" in command and "umask 077" in command
            return subprocess.CompletedProcess(command, 0, STAGE + "\n", "")

        def scp(self, ip, files, dest="/tmp/"):
            dests.append(dest)
            sent.extend(Path(f).name for f in files)

        def ssh_base(self, ip):
            return ["ssh", "x"]

    class Proc:
        stdout = iter(["NEBULA_STEP guest_code\n", "NEBULA_PROVISION_OK\n"])

        def wait(self):
            return 0

    monkeypatch.setattr(installer, "build_guest_bundle", lambda out: (out.write_bytes(b"tar"), out)[1])
    monkeypatch.setattr(installer.subprocess, "Popen", lambda cmd, **kw: cmds.append(cmd) or Proc())

    class Job:
        def step(self, *a, **k):
            pass

    installer.provision_guest(VM(), "192.168.64.2", Job(), {"playwright_version": "1.65.2", "guest_version": "1"})
    assert "requirements-guest.txt" in sent and dests == [STAGE + "/"]
    cmd = cmds[0][-1]
    assert f"NEBULA_GUEST_REQUIREMENTS={STAGE}/requirements-guest.txt" in cmd
    assert "NEBULA_PLAYWRIGHT_VERSION=1.65.2" in cmd
    assert f"bash {STAGE}/provision.sh {STAGE}/nebula-guest-bundle.tar.gz {STAGE}/rpc.key" in cmd
    assert f"rm -rf {STAGE}" in cmd and "/tmp/" not in cmd


def test_provisioning_refuses_an_unexpected_staging_dir(dbinit):
    from nebula_setup import installer

    class VM:
        def ssh(self, ip, command, timeout=600):
            return subprocess.CompletedProcess(command, 0, "/tmp/evil\n", "")

    with pytest.raises(installer.InstallError, match="staging"):
        installer.make_stage_dir(VM(), "192.168.64.2")


# ------------------------------------------------------------------ TEST instance server settings
def _load_test_instance():
    spec = importlib.util.spec_from_file_location("nebula_test_instance", ROOT / "scripts/test_instance.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_test_instance_settings_are_configurable_and_never_the_owners(home, tmp_path):
    import argparse

    ti = _load_test_instance()
    ns = argparse.Namespace(api_port=None, gateway_port=None, data_dir=None)
    s = ti.resolve_settings(ns, env={})
    assert (s["api_port"], s["gateway_port"], s["keep"]) == (3197, 3196, False)
    s["base"].rmdir()
    s = ti.resolve_settings(ns, env={"NEBULA_TEST_API_PORT": "4100", "NEBULA_TEST_GATEWAY_PORT": "4102",
                                     "NEBULA_TEST_DATA_DIR": str(tmp_path / "ti")})
    assert (s["api_port"], s["gateway_port"], s["keep"]) == (4100, 4102, True)
    assert s["base"] == (tmp_path / "ti").resolve()
    for bad in (dict(api_port=3100), dict(gateway_port=3102), dict(api_port=4000, gateway_port=4000)):
        with pytest.raises(SystemExit):
            ti.resolve_settings(argparse.Namespace(**{**vars(ns), **bad}), env={})
    for bad_dir in (home / "Library/Application Support/NEBULA", home / "Library/Application Support/NEBULA/x",
                    home / "Library/Application Support/NEBULA-other"):
        with pytest.raises(SystemExit):
            ti.resolve_settings(argparse.Namespace(**{**vars(ns), "data_dir": str(bad_dir)}), env={})
    src = (ROOT / "scripts/test_instance.py").read_text()
    assert "/Users/" not in src and "Application Support/NEBULA" not in src
