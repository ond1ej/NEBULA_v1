"""Host preflight checks (spec §3.2 step 1). Each check: {id, status: pass|warn|fail, detail}."""

from __future__ import annotations

import os
import platform
import shutil
import socket
import subprocess
from pathlib import Path
from typing import Any

import httpx

MIN_MACOS = (13, 0)
MIN_RAM_GB = 8
REC_RAM_GB = 16
MIN_FREE_GB = 20


def _check(cid: str, status: str, detail: str, **extra) -> dict[str, Any]:
    return {"id": cid, "status": status, "detail": detail, **extra}


def run_preflight(data_dir: Path, port: int, helper: Path, vm_ram_mb: int, offline: bool = False,
                  vm_running: bool = False) -> dict[str, Any]:
    checks: list[dict[str, Any]] = []
    ver = platform.mac_ver()[0] or "0"
    parts = tuple(int(x) for x in (ver.split(".") + ["0"])[:2])
    checks.append(_check("macos_version", "pass" if parts >= MIN_MACOS else "fail", f"macOS {ver}",
                         required=">= 13.0"))
    arch = platform.machine()
    checks.append(_check("cpu_arch", "pass" if arch == "arm64" else "fail", arch, required="arm64 (Apple Silicon)"))

    if helper.exists():
        try:
            out = subprocess.run([str(helper), "doctor"], capture_output=True, text=True, timeout=20).stdout
            import json

            d = json.loads(out.strip().splitlines()[-1])
            ok = d.get("virtualization_supported") and d.get("entitlement_ok")
            checks.append(_check("virtualization", "pass" if ok else "fail",
                                 "Virtualization.framework available and helper entitled" if ok else
                                 f"virtualization unavailable: {d.get('probe_message')}"))
        except Exception as e:  # noqa: BLE001
            checks.append(_check("virtualization", "fail", f"helper doctor failed: {e}"))
    else:
        checks.append(_check("virtualization", "fail", f"VM helper missing at {helper}; build with `make helper`"))

    mem = int(subprocess.run(["/usr/sbin/sysctl", "-n", "hw.memsize"], capture_output=True, text=True).stdout.strip() or 0)
    gb = mem / 1024**3
    status = "pass" if gb >= REC_RAM_GB else "warn" if gb >= MIN_RAM_GB else "fail"
    checks.append(_check("memory", status, f"{gb:.0f} GB RAM; VM profile {vm_ram_mb} MB",
                         recommended=f">= {REC_RAM_GB} GB"))
    if vm_ram_mb + 4096 > mem / 1024**2:
        checks.append(_check("vm_profile", "fail", "VM RAM leaves < 4 GB for macOS; lower vm.ram_mb"))

    data_dir.mkdir(parents=True, exist_ok=True)
    free_gb = shutil.disk_usage(data_dir).free / 1024**3
    checks.append(_check("disk_free", "pass" if free_gb >= MIN_FREE_GB else "fail", f"{free_gb:.0f} GB free",
                         required=f">= {MIN_FREE_GB} GB"))
    try:
        probe = data_dir / ".write-probe"
        probe.write_text("ok")
        probe.unlink()
        checks.append(_check("data_dir_writable", "pass", str(data_dir)))
    except OSError as e:
        checks.append(_check("data_dir_writable", "fail", f"{data_dir}: {e}"))

    if offline:
        checks.append(_check("internet", "warn", "offline install requested; image must be imported"))
    else:
        try:
            r = httpx.head("https://cloud-images.ubuntu.com/", timeout=10, follow_redirects=True)
            checks.append(_check("internet", "pass" if r.status_code < 500 else "warn",
                                 f"cloud-images.ubuntu.com HTTP {r.status_code}"))
        except httpx.HTTPError as e:
            checks.append(_check("internet", "fail", f"cannot reach Ubuntu image server: {e}"))

    # AI provider endpoints: detect local blocks (/etc/hosts, DNS sinkholes) so they are not discovered mid-OAuth
    import sys as _sys

    _sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "packages/provider-adapters"))
    from nebula_providers.base import _sinkhole, diagnose_connect

    blocked = []
    for host in ("api.openai.com", "auth.openai.com", "api.anthropic.com", "generativelanguage.googleapis.com"):
        try:
            addrs = {i[4][0] for i in socket.getaddrinfo(host, 443, proto=socket.IPPROTO_TCP)}
        except OSError:
            continue
        if addrs and all(_sinkhole(a) for a in addrs if "." in a):
            blocked.append(diagnose_connect(f"https://{host}").split(";")[0])
    checks.append(_check("provider_endpoints", "warn" if blocked else "pass",
                         "; ".join(blocked) if blocked else "cloud AI endpoints resolve normally",
                         note="blocked endpoints only affect the matching cloud provider; Ollama stays local"))

    s = socket.socket()
    try:
        s.bind(("127.0.0.1", port))
        checks.append(_check("port", "pass", f"127.0.0.1:{port} is free"))
    except OSError:
        checks.append(_check("port", "warn", f"127.0.0.1:{port} is in use (fine if NEBULA itself is running; "
                                             "otherwise set instance.port in config.yaml)"))
    finally:
        s.close()

    fw = "/usr/libexec/ApplicationFirewall/socketfilterfw"
    if os.path.exists(fw):
        out = subprocess.run([fw, "--getglobalstate"], capture_output=True, text=True).stdout.strip()
        checks.append(_check("macos_firewall", "pass", out or "unknown",
                             note="NEBULA binds to 127.0.0.1 only; no inbound firewall rule needed"))
    pm = subprocess.run(["/usr/bin/pmset", "-g"], capture_output=True, text=True).stdout
    sleep_line = next((ln.strip() for ln in pm.splitlines() if ln.strip().startswith("sleep ")), "sleep ?")
    sleeps = sleep_line.split()[1:2] != ["0"]
    checks.append(_check("sleep_policy", "warn" if sleeps else "pass", sleep_line,
                         note="agents pause while the Mac sleeps; set System Settings > Energy > prevent sleep"
                         if sleeps else "system sleep disabled"))
    if vm_running:
        checks.append(_check("vm_state", "pass", "NEBULA VM already running"))
    overall = "fail" if any(c["status"] == "fail" for c in checks) else \
        "warn" if any(c["status"] == "warn" for c in checks) else "pass"
    return {"status": overall, "checks": checks}
