"""NEBULA host configuration (spec §15.1). YAML in the data dir; env overrides for dev/tests."""

from __future__ import annotations

import os
import re
from functools import lru_cache
from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, Field, field_validator

APP_VERSION = "1.0.0"

# ---- instance scoping
# Every NEBULA install on a Mac is an *instance*. The normal install is "default"; a second (for example test)
# install picks another id with `nebula --instance <id> ...` or NEBULA_INSTANCE=<id>. The id scopes everything that
# would otherwise be global to the macOS user: the data dir, the Keychain service (nebula_host.secrets.service_name),
# the LaunchAgent label/plist (launchd_label) and the VM hostname (vm_hostname).
DEFAULT_INSTANCE = "default"
DEFAULT_LAUNCHD_LABEL = "dev.nebula.host"
DEFAULT_VM_HOSTNAME = "nebula-vm"
_INSTANCE_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$")


def validate_instance_id(value: str) -> str:
    v = (value or "").strip().lower()
    if not _INSTANCE_RE.match(v):
        raise ValueError("instance id must be 1-32 characters a-z, 0-9 or '-' (not starting or ending with '-')")
    return v


def env_instance_id() -> str | None:
    v = os.environ.get("NEBULA_INSTANCE")
    return validate_instance_id(v) if v else None


def standard_data_dir() -> Path:
    """Data dir of the default instance."""
    return Path.home() / "Library/Application Support/NEBULA"


def instance_data_dir(instance_id: str) -> Path:
    """Default data dir of an instance: a sibling of the standard dir, never nested inside it."""
    iid = validate_instance_id(instance_id)
    return standard_data_dir() if iid == DEFAULT_INSTANCE else standard_data_dir().with_name(f"NEBULA-{iid}")


def launchd_label(instance_id: str = DEFAULT_INSTANCE) -> str:
    """LaunchAgent label: `dev.nebula.host` for the default instance, `dev.nebula.host.<id>` otherwise."""
    iid = validate_instance_id(instance_id)
    return DEFAULT_LAUNCHD_LABEL if iid == DEFAULT_INSTANCE else f"{DEFAULT_LAUNCHD_LABEL}.{iid}"


def vm_hostname(instance_id: str = DEFAULT_INSTANCE) -> str:
    """Guest hostname (cloud-init + DHCP lease lookup): `nebula-vm`, or `nebula-vm-<id>` for other instances."""
    iid = validate_instance_id(instance_id)
    return DEFAULT_VM_HOSTNAME if iid == DEFAULT_INSTANCE else f"{DEFAULT_VM_HOSTNAME}-{iid}"


# A non-default instance writes its id into this file of its data dir before it creates nebula.db there, so a
# database without config.yaml can be told apart from an install made before instance ids existed (audit NEW-5).
INSTANCE_MARKER = "instance-id"


def _same_dir(a: Path, b: Path) -> bool:
    """Two resolved paths name one directory: equal, or (when both exist) the same device and inode. The inode check
    also catches another spelling on a case-insensitive volume (`.../nebula` for `.../NEBULA`) (audit NEW-5)."""
    if a == b:
        return True
    try:
        return os.path.samefile(a, b)
    except OSError:  # one of them does not exist (yet)
        return False


def conventional_instance_id(data_dir: Path) -> str | None:
    """The instance whose standard data dir `data_dir` is: "default" for the standard dir, `<id>` for its sibling
    `NEBULA-<id>`, None for any other path (a custom dir belongs to whoever recorded an id in it). Existing dirs are
    compared by inode, so a symlink, another letter case or another path to the same folder counts as that dir."""
    d = Path(data_dir).expanduser().resolve()
    std = standard_data_dir().expanduser().resolve()
    if _same_dir(d, std):
        return DEFAULT_INSTANCE
    prefix = f"{std.name}-"
    if d.name[:len(prefix)].casefold() == prefix.casefold() and _same_dir(d.parent, std.parent):
        try:
            iid = validate_instance_id(d.name[len(prefix):])
        except ValueError:
            return None
        if iid == DEFAULT_INSTANCE:
            return None
        if d.name.startswith(prefix) or _same_dir(d, std.parent / f"{prefix}{iid}"):
            return iid
    return None


def marker_instance_id(data_dir: Path) -> str | None:
    """The id in the data dir's INSTANCE_MARKER file, None when there is none (or it holds no valid id)."""
    try:
        text = (Path(data_dir) / INSTANCE_MARKER).read_text().strip()
    except OSError:
        return None
    try:
        return validate_instance_id(text)
    except ValueError:
        return None


def recorded_instance_id(data_dir: Path, raw: dict | None = None, config_path: Path | None = None) -> str | None:
    """The instance an existing data dir already belongs to, in this order: `instance.id` from its config.yaml; the
    id in its INSTANCE_MARKER file; for a dir that holds nebula.db but records no id (an install made before
    instance ids existed, with a config.yaml without an id or with no config.yaml at all: those installs wrote
    config.yaml only when a setting changed), the instance whose standard dir it is, else "default". None when the
    dir records no owner yet."""
    path = config_path or Path(data_dir) / "config.yaml"
    if raw is None:
        raw = (yaml.safe_load(path.read_text()) or {}) if path.exists() else {}
    inst = raw.get("instance") if isinstance(raw, dict) and isinstance(raw.get("instance"), dict) else {}
    if inst.get("id"):
        return validate_instance_id(str(inst["id"]))
    marked = marker_instance_id(data_dir)
    if marked:
        return marked
    if (Path(data_dir) / "nebula.db").exists():
        return conventional_instance_id(data_dir) or DEFAULT_INSTANCE
    return None


def check_data_dir_owner(data_dir: Path, instance_id: str) -> None:
    """Refuse an instance id on a data dir that is another instance's standard dir (the default instance's
    ~/Library/Application Support/NEBULA, or NEBULA-<other>). Using it would rewrite that instance's config.yaml,
    share its database and VM, and leave its service unable to read its own Keychain items."""
    owner = conventional_instance_id(data_dir)
    if owner is None or owner == instance_id:
        return
    if owner == DEFAULT_INSTANCE:
        raise ValueError(
            f"data dir {data_dir} is the default instance's data dir; instance '{instance_id}' must not use it. "
            f"Drop NEBULA_DATA_DIR / --data-dir to use {instance_data_dir(instance_id)}. If config.yaml there now "
            "says another id by mistake, set instance.id back to 'default'.")
    raise ValueError(
        f"data dir {data_dir} belongs to instance '{owner}', not '{instance_id}'. Use `nebula --instance {owner} ...` "
        f"for that instance, or drop NEBULA_DATA_DIR / --data-dir to use {instance_data_dir(instance_id)}.")


def instance_https_port(port: int) -> int:
    """Default LAN HTTPS port of a non-default instance (dashboard port + 1000), so it never takes the default
    instance's 3443."""
    return min(65535, port + 1000)


def default_data_dir() -> Path:
    if os.environ.get("NEBULA_DATA_DIR"):
        return Path(os.environ["NEBULA_DATA_DIR"])
    return instance_data_dir(env_instance_id() or DEFAULT_INSTANCE)


def default_log_dir() -> Path:
    if os.environ.get("NEBULA_LOG_DIR"):
        return Path(os.environ["NEBULA_LOG_DIR"])
    data = default_data_dir()
    if data != standard_data_dir():  # a separate instance keeps its own logs
        return data / "logs"
    return Path.home() / "Library/Logs/NEBULA"


class InstanceCfg(BaseModel):
    id: str = DEFAULT_INSTANCE
    name: str = "My NEBULA"
    bind_host: str = "127.0.0.1"
    port: int = Field(3100, ge=1024, le=65535)
    autostart_after_login: bool = True  # recorded by `nebula install --autostart`; the LaunchAgent is the truth

    @field_validator("id")
    @classmethod
    def _valid_id(cls, v: str) -> str:
        return validate_instance_id(v)


class VMCfg(BaseModel):
    engine: Literal["apple_virtualization"] = "apple_virtualization"
    image_channel: str = "stable"
    ram_mb: int = Field(6144, ge=2048, le=65536)
    cpu_count: int = Field(4, ge=1, le=32)
    disk_gb_limit: int = Field(32, ge=16, le=2048)


class AgentsCfg(BaseModel):
    default_active_limit: int = Field(2, ge=1, le=8)
    default_desktop: str = "1280x800"
    resource_policy: Literal["queue_when_full", "sleep_lru"] = "sleep_lru"
    require_approval_for_sensitive_actions: bool = True
    max_steps_per_task: int = Field(30, ge=1, le=500)
    screenshot_retention_days: int = Field(7, ge=0, le=365)
    min_host_free_mb_for_new_desktop: int = 1200  # guest MemAvailable needed to wake a sleeping desktop
    min_guest_free_mb_for_task: int = 700  # guest MemAvailable needed to start a task on a running desktop


class LiveCfg(BaseModel):
    auto_connect: bool = False
    default_read_only: bool = True
    viewer_session_ttl_seconds: int = Field(90, ge=15, le=3600)
    release_control_on_disconnect: bool = True
    control_lease_seconds: int = Field(300, ge=30, le=3600)


class TelegramCfg(BaseModel):
    enabled: bool = False
    transport: Literal["long_polling"] = "long_polling"
    pairing_ttl_seconds: int = Field(300, ge=60, le=3600)
    api_base: str = "https://api.telegram.org"
    poll_timeout_seconds: int = Field(30, ge=0, le=50)
    max_attachment_mb: int = Field(20, ge=1, le=50)
    rate_limit_per_minute: int = Field(30, ge=1, le=600)


class ProvidersCfg(BaseModel):
    allow_paid_fallback_without_consent: bool = False
    ollama_base_url: str = "http://127.0.0.1:11434"


class LanCfg(BaseModel):
    """Opt-in dashboard access from the local network (physical interfaces only; never the VM bridge / VPN)."""
    enabled: bool = False
    https: bool = False  # additional HTTPS listener using the NEBULA local CA
    https_port: int = Field(3443, ge=1024, le=65535)


class SecurityCfg(BaseModel):
    bind_local_only: bool = True
    allow_host_agent: bool = False
    session_ttl_hours: int = Field(12, ge=1, le=720)
    login_max_attempts: int = Field(5, ge=3, le=50)
    login_lockout_seconds: int = Field(300, ge=30)


class NebulaConfig(BaseModel):
    instance: InstanceCfg = InstanceCfg()
    vm: VMCfg = VMCfg()
    agents: AgentsCfg = AgentsCfg()
    live: LiveCfg = LiveCfg()
    telegram: TelegramCfg = TelegramCfg()
    providers: ProvidersCfg = ProvidersCfg()
    security: SecurityCfg = SecurityCfg()
    lan: LanCfg = LanCfg()

    # runtime (not in YAML)
    data_dir: Path = Field(default_factory=default_data_dir)
    log_dir: Path = Field(default_factory=default_log_dir)
    secret_backend: Literal["keychain", "memory"] = "keychain"
    vm_helper_path: Path | None = None
    repo_root: Path = Path(__file__).resolve().parents[3]

    @field_validator("instance")
    @classmethod
    def _local_only(cls, v: InstanceCfg) -> InstanceCfg:
        return v

    def enforce_local_bind(self) -> None:
        if self.security.bind_local_only and self.instance.bind_host not in ("127.0.0.1", "::1", "localhost"):
            raise ValueError("bind_host must be loopback while security.bind_local_only is true")

    # ---- instance identity
    @property
    def instance_id(self) -> str:
        return self.instance.id

    @property
    def is_default_instance(self) -> bool:
        return self.instance.id == DEFAULT_INSTANCE

    @property
    def launchd_label(self) -> str:
        return launchd_label(self.instance.id)

    @property
    def vm_hostname(self) -> str:
        return vm_hostname(self.instance.id)

    def check_instance_isolation(self) -> None:
        """Refuse a setup that would share another instance's data dir or Keychain items.

        * A non-default id on the default instance's standard data dir (or on NEBULA-<other>) would rewrite that
          instance's config.yaml and share its database, VM and LaunchAgent data dir (check_data_dir_owner).
        * A data dir other than the standard one that uses the real Keychain and is still called "default" would
          read, overwrite and (on `uninstall --remove-data`) delete the default instance's secrets."""
        check_data_dir_owner(self.data_dir, self.instance_id)
        if (self.secret_backend == "keychain" and self.is_default_instance
                and not os.environ.get("NEBULA_KEYCHAIN_SERVICE")
                and not _same_dir(self.data_dir.expanduser().resolve(), standard_data_dir().expanduser().resolve())):
            raise ValueError(
                f"data dir {self.data_dir} is not the default instance's, but its instance id is 'default', so it "
                "would share the default instance's Keychain items. Use `nebula --instance <id> ...` "
                "(or NEBULA_INSTANCE=<id>) for a separate install.")

    # ---- derived paths
    @property
    def db_path(self) -> Path:
        return self.data_dir / "nebula.db"

    @property
    def vm_bundle(self) -> Path:
        return self.data_dir / "vm" / "shared"

    @property
    def run_dir(self) -> Path:
        return self.data_dir / "run"

    @property
    def cache_dir(self) -> Path:
        return self.data_dir / "cache"

    @property
    def keys_dir(self) -> Path:
        return self.data_dir / "keys"

    @property
    def artifacts_dir(self) -> Path:
        return self.data_dir / "artifacts"

    @property
    def config_path(self) -> Path:
        return self.data_dir / "config.yaml"

    def helper_binary(self) -> Path:
        if self.vm_helper_path:
            return self.vm_helper_path
        env = os.environ.get("NEBULA_VM_HELPER")
        if env:
            return Path(env)
        installed = self.data_dir / "bin" / "nebula-vm"
        if installed.exists():
            return installed
        return self.repo_root / "apps/host-vm-helper/.build/release/nebula-vm"

    def ensure_dirs(self) -> None:
        for p in (self.data_dir, self.run_dir, self.cache_dir, self.keys_dir, self.artifacts_dir, self.log_dir,
                  self.data_dir / "vm"):
            p.mkdir(parents=True, exist_ok=True)
            os.chmod(p, 0o700)
        self.record_instance()

    def record_instance(self) -> None:
        """Before a non-default instance creates nebula.db in a data dir that names no owner yet, write its id into
        INSTANCE_MARKER. Without it, a database with no config.yaml (`nebula --instance x status` before `install`,
        or a server that never saved a setting) would read as a pre-instance-id install of the default instance.
        The default instance writes nothing: a database without an id is its own anyway."""
        if self.is_default_instance or self.db_path.exists():
            return
        if conventional_instance_id(self.data_dir) not in (None, self.instance_id):
            return  # another instance's standard dir: check_data_dir_owner refuses it; never claim it here
        if recorded_instance_id(self.data_dir) is not None:
            return  # config.yaml (or an earlier marker) already names the owner
        marker = self.data_dir / INSTANCE_MARKER
        tmp = marker.with_name(marker.name + ".tmp")
        tmp.write_text(self.instance_id + "\n")
        os.chmod(tmp, 0o600)
        os.replace(tmp, marker)

    def yaml_dict(self) -> dict:
        return self.model_dump(include={"instance", "vm", "agents", "live", "telegram", "providers", "security", "lan"})


def load_config(path: Path | None = None, **overrides) -> NebulaConfig:
    data_dir = Path(overrides.pop("data_dir", None) or default_data_dir())
    path = path or data_dir / "config.yaml"
    raw: dict = {}
    if path.exists():
        raw = yaml.safe_load(path.read_text()) or {}
    want = env_instance_id()
    inst_raw = raw.get("instance") if isinstance(raw.get("instance"), dict) else {}
    have = recorded_instance_id(data_dir, raw, path)
    if want and have and have != want:
        if inst_raw.get("id"):
            raise ValueError(f"instance mismatch: {path} belongs to instance '{have}', not '{want}'")
        if marker_instance_id(data_dir):
            raise ValueError(f"instance mismatch: {data_dir} belongs to instance '{have}' (its {INSTANCE_MARKER} "
                             f"file), not '{want}'")
        why = "its config.yaml has no instance.id" if path.exists() else "it has no config.yaml"
        owner = "the default instance" if have == DEFAULT_INSTANCE else f"instance '{have}'"
        raise ValueError(
            f"instance mismatch: {data_dir} holds an install made before instance ids existed (nebula.db exists and "
            f"{why}), so it belongs to {owner}, not '{want}'. If this really is the data of instance '{want}', "
            f"set instance.id: {want} in its config.yaml")
    if want:
        raw = {**raw, "instance": {**inst_raw, "id": want}}
    elif not inst_raw.get("id") and marker_instance_id(data_dir):
        raw = {**raw, "instance": {**inst_raw, "id": marker_instance_id(data_dir)}}  # the dir names its owner
    cfg = NebulaConfig(**raw, data_dir=data_dir, **overrides)
    if os.environ.get("NEBULA_PORT"):
        cfg.instance.port = int(os.environ["NEBULA_PORT"])
    lan_raw = raw.get("lan") if isinstance(raw.get("lan"), dict) else {}
    if not cfg.is_default_instance and "https_port" not in lan_raw:
        # a second instance must not collide with the default instance's LAN HTTPS port (3443)
        cfg.lan.https_port = instance_https_port(cfg.instance.port)
    if os.environ.get("NEBULA_SECRET_BACKEND"):
        cfg.secret_backend = os.environ["NEBULA_SECRET_BACKEND"]  # type: ignore[assignment]
    if os.environ.get("NEBULA_TELEGRAM_API_BASE"):
        cfg.telegram.api_base = os.environ["NEBULA_TELEGRAM_API_BASE"]
    cfg.enforce_local_bind()
    return cfg


def save_config(cfg: NebulaConfig) -> None:
    """Write config.yaml. Never writes an instance id into a data dir that belongs to another instance (its
    standard dir, or a config.yaml / pre-id install that records a different owner)."""
    check_data_dir_owner(cfg.data_dir, cfg.instance_id)
    have = recorded_instance_id(cfg.data_dir)
    if have is not None and have != cfg.instance_id:
        raise ValueError(f"refusing to write instance '{cfg.instance_id}' into {cfg.config_path}: that data dir "
                         f"belongs to instance '{have}'")
    cfg.data_dir.mkdir(parents=True, exist_ok=True)
    tmp = cfg.config_path.with_suffix(".tmp")
    tmp.write_text(yaml.safe_dump(cfg.yaml_dict(), sort_keys=False))
    os.chmod(tmp, 0o600)
    os.replace(tmp, cfg.config_path)


@lru_cache(maxsize=1)
def get_config() -> NebulaConfig:
    return load_config()
