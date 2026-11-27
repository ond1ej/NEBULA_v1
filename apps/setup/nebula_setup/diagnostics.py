"""`nebula diagnostics`: a redacted support bundle (.tar.gz, owner-only).

Contains version/instance metadata, the YAML config, installation state, LaunchAgent/VM/runtime status, a health
probe and the tails of the host, VM-helper and guest-provision logs. Everything passes through the secret redactor
and the home directory is replaced by `~`. Never included: the database, keys, Keychain values, workspace files.
"""

from __future__ import annotations

import io
import json
import os
import platform
import sys
import tarfile
import time
from pathlib import Path
from typing import Any

LOGS = ("host.log", "vm-helper.log", "guest-provision.log")
LOG_LINES = 3000


def _scrub(text: str) -> str:
    from nebula_host.secrets import redact

    home = str(Path.home())
    out = redact(text)
    return out.replace(home, "~") if home and home != "/" else out


def _json(obj: Any) -> str:
    from nebula_host.secrets import redact_obj

    return _scrub(json.dumps(redact_obj(obj), indent=2, default=str))


def _safe(fn):
    try:
        return fn()
    except Exception as e:  # noqa: BLE001 - a diagnostics bundle must never fail on one broken part
        return {"error": type(e).__name__, "detail": str(e)[:300]}


def collect(cfg) -> dict[str, str]:
    """{archive name: text} for the bundle."""
    from nebula_host import secrets
    from nebula_host.config import APP_VERSION
    from nebula_host.vm import VMManager

    from nebula_setup import health, installer, launchd, runtime

    files: dict[str, str] = {}
    files["meta.json"] = _json({
        "version": APP_VERSION, "instance": cfg.instance_id, "data_dir": str(cfg.data_dir),
        "log_dir": str(cfg.log_dir), "keychain_service": _safe(lambda: secrets.service_name(cfg.instance_id)),
        "launchd_label": cfg.launchd_label, "python": sys.version.split()[0], "macos": platform.mac_ver()[0],
        "arch": platform.machine(), "created_at": time.strftime("%Y-%m-%dT%H:%M:%S%z")})
    files["config.json"] = _json(cfg.yaml_dict())
    files["installation.json"] = _json(_safe(installer.get_installation))
    files["launch_agent.json"] = _json(_safe(lambda: launchd.status(cfg.launchd_label)))
    files["vm.json"] = _json(_safe(lambda: VMManager(cfg).status()))
    files["runtime.json"] = _json({"current": str(runtime.current_target(cfg.data_dir)),
                                   "previous": str(runtime.previous_target(cfg.data_dir))})
    files["health.json"] = _json(_safe(lambda: health.probe(cfg.instance.port)))
    report = cfg.data_dir / "install-report.json"
    if report.exists():
        files["install-report.json"] = _json(_safe(lambda: json.loads(report.read_text())))
    for name in LOGS:
        p = cfg.log_dir / name
        if p.exists():
            tail = p.read_text(errors="replace").splitlines()[-LOG_LINES:]
            files[f"logs/{name}"] = _scrub("\n".join(tail))
    return files


def build_bundle(cfg, out: Path | None = None) -> Path:
    out = out or cfg.data_dir / "diagnostics" / f"nebula-diagnostics-{time.strftime('%Y%m%d-%H%M%S')}.tar.gz"
    out.parent.mkdir(parents=True, exist_ok=True)
    files = collect(cfg)
    fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as fh, tarfile.open(fileobj=fh, mode="w:gz") as tar:
        for name, text in files.items():
            data = text.encode()
            ti = tarfile.TarInfo(f"nebula-diagnostics/{name}")
            ti.size = len(data)
            ti.mtime = int(time.time())
            ti.mode = 0o600
            tar.addfile(ti, io.BytesIO(data))
    os.chmod(out, 0o600)
    return out
