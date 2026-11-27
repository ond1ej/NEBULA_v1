"""Shared Ubuntu VM lifecycle via the native Swift helper (`nebula-vm`), plus SSH for provisioning/repair."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any

from nebula_host.config import NebulaConfig

log = logging.getLogger("nebula.vm")


class VMError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def lease_ip(leases: str, hostname: str, mac: str | None = None) -> str | None:
    """IP from macOS /var/db/dhcpd_leases for this VM: the block whose hw_address is this VM's MAC, else the
    block whose name is exactly this instance's hostname (`nebula-vm` must not match `nebula-vm-test`)."""
    blocks = []
    for block in leases.split("}"):
        fields = {}
        for line in block.splitlines():
            k, sep, v = line.strip().partition("=")
            if sep:
                fields[k] = v.strip()
        if fields.get("ip_address"):
            blocks.append(fields)
    if mac:
        for f in blocks:
            hw = f.get("hw_address", "").split(",", 1)[-1].lower()
            if hw and ":".join(p.lstrip("0") or "0" for p in hw.split(":")) == mac:
                return f["ip_address"]
    for f in blocks:
        if f.get("name") == hostname:
            return f["ip_address"]
    return None


class VMManager:
    def __init__(self, cfg: NebulaConfig) -> None:
        self.cfg = cfg

    # ---- paths
    @property
    def bundle(self) -> Path:
        return self.cfg.vm_bundle

    @property
    def run_dir(self) -> Path:
        return self.cfg.run_dir / "vm"

    @property
    def helper(self) -> Path:
        return self.cfg.helper_binary()

    @property
    def ssh_key(self) -> Path:
        return self.cfg.keys_dir / "guest_admin_ed25519"

    @property
    def known_hosts(self) -> Path:
        return self.cfg.keys_dir / "guest_known_hosts"

    @property
    def helper_log(self) -> Path:
        return self.cfg.log_dir / "vm-helper.log"

    def exists(self) -> bool:
        return (self.bundle / "config.json").exists()

    # ---- helper invocation
    def _helper(self, *args: str, timeout: int = 120) -> dict[str, Any]:
        if not self.helper.exists():
            raise VMError("helper_missing", f"VM helper not found at {self.helper} (run `make helper`)")
        p = subprocess.run([str(self.helper), *args], capture_output=True, text=True, timeout=timeout)
        try:
            out = json.loads(p.stdout.strip().splitlines()[-1]) if p.stdout.strip() else {}
        except json.JSONDecodeError:
            out = {"ok": False, "error": "bad_output", "message": p.stdout[-500:] + p.stderr[-500:]}
        if not out.get("ok", False):
            raise VMError(out.get("error", "helper_failed"), out.get("message") or p.stderr[-500:] or "helper failed")
        return out

    def doctor(self) -> dict[str, Any]:
        return self._helper("doctor")

    def create(self, base_raw: Path, seed_iso: Path | None) -> dict[str, Any]:
        if self.exists():
            raise VMError("vm_exists", "a NEBULA VM already exists; refusing to overwrite it")
        self.bundle.parent.mkdir(parents=True, exist_ok=True)
        self.run_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        args = ["create", "--bundle", str(self.bundle), "--base-image", str(base_raw),
                "--cpus", str(self.cfg.vm.cpu_count), "--memory-mb", str(self.cfg.vm.ram_mb),
                "--disk-gb", str(self.cfg.vm.disk_gb_limit), "--name", "nebula-shared",
                "--run-dir", str(self.run_dir)]
        if seed_iso:
            args += ["--seed", str(seed_iso)]
        return self._helper(*args, timeout=600)

    def status(self) -> dict[str, Any]:
        if not self.exists():
            return {"state": "not_created"}
        try:
            return self._helper("status", "--bundle", str(self.bundle), timeout=15)
        except VMError as e:
            return {"state": "error", "error": e.code, "message": str(e)}
        except subprocess.TimeoutExpired:
            return {"state": "unresponsive"}

    def is_running(self) -> bool:
        return self.status().get("state") in ("running", "starting", "stopping")

    def start(self, wait: float = 30) -> dict[str, Any]:
        if not self.exists():
            raise VMError("vm_missing", "VM has not been created; run the installer")
        st = self.status()
        if st.get("state") == "running":
            return st
        self.cfg.log_dir.mkdir(parents=True, exist_ok=True)
        for f in (self.bundle / "console.log", self.helper_log):  # simple size-based rotation (keeps one old copy)
            if f.exists() and f.stat().st_size > 5 * 1024 * 1024:
                os.replace(f, f.with_suffix(f.suffix + ".1"))
        logf = open(self.helper_log, "ab")  # noqa: SIM115 - handed to the child
        subprocess.Popen([str(self.helper), "start", "--bundle", str(self.bundle)], stdout=logf, stderr=logf,
                         stdin=subprocess.DEVNULL, start_new_session=True, close_fds=True)
        logf.close()
        deadline = time.time() + wait
        while time.time() < deadline:
            st = self.status()
            if st.get("state") == "running":
                return st
            if st.get("state") == "error":
                break
            time.sleep(0.5)
        raise VMError("vm_start_failed", f"VM did not reach running state: {st} (see {self.helper_log})")

    def stop(self, force: bool = False, wait: float = 90) -> dict[str, Any]:
        if not self.exists():
            return {"state": "not_created"}
        st = self.status()
        if st.get("state") in ("stopped", "not_created"):
            return st
        args = ["stop", "--bundle", str(self.bundle)] + (["--force"] if force else [])
        self._helper(*args, timeout=30)
        deadline = time.time() + wait
        while time.time() < deadline:
            st = self.status()
            if st.get("state") == "stopped":
                return st
            time.sleep(1)
        if not force:
            return self.stop(force=True, wait=20)
        raise VMError("vm_stop_failed", "VM did not stop")

    def set_resources(self, cpus: int | None = None, memory_mb: int | None = None, remove_seed: bool = False) -> dict:
        args = ["config", "--bundle", str(self.bundle)]
        if cpus:
            args += ["--cpus", str(cpus)]
        if memory_mb:
            args += ["--memory-mb", str(memory_mb)]
        if remove_seed:
            args.append("--remove-seed")
        return self._helper(*args)

    def backup_disk(self, dest: Path) -> dict[str, Any]:
        return self._helper("snapshot", "--bundle", str(self.bundle), "--dest", str(dest), timeout=600)

    def config(self) -> dict[str, Any]:
        try:
            return json.loads((self.bundle / "config.json").read_text())
        except FileNotFoundError:
            return {}

    # ---- networking / SSH (provisioning + repair only; runtime traffic uses vsock)
    def guest_ip(self) -> str | None:
        mac = self.config().get("macAddress")
        if not mac:
            return None
        norm = ":".join(p.lstrip("0") or "0" for p in mac.lower().split(":"))
        try:
            out = subprocess.run(["/usr/sbin/arp", "-an"], capture_output=True, text=True, timeout=10).stdout
        except (OSError, subprocess.TimeoutExpired):
            return None
        for line in out.splitlines():
            m = re.match(r"^\? \((\d+\.\d+\.\d+\.\d+)\) at ([0-9a-f:]+) on bridge", line)
            if m and m.group(2) == norm:
                return m.group(1)
        # fallback: DHCP lease of this VM (its MAC, else this instance's exact hostname)
        try:
            leases = Path("/var/db/dhcpd_leases").read_text()
        except OSError:
            return None
        return lease_ip(leases, getattr(self.cfg, "vm_hostname", "nebula-vm"), norm)

    # SSH keepalives: a guest that stops answering (crashed, or a firewall change dropping the session) ends the
    # command with exit 255 after about 2 minutes instead of leaving the installer waiting forever.
    KEEPALIVE = ["-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=8"]

    def ssh_base(self, ip: str) -> list[str]:
        return ["ssh", "-i", str(self.ssh_key), "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes",
                "-o", f'UserKnownHostsFile="{self.known_hosts}"', "-o", "StrictHostKeyChecking=yes",
                "-o", "ConnectTimeout=5", *self.KEEPALIVE, "-o", "LogLevel=ERROR", f"nebula-admin@{ip}"]

    def ssh(self, ip: str, command: str, timeout: int = 600) -> subprocess.CompletedProcess:
        return subprocess.run([*self.ssh_base(ip), command], capture_output=True, text=True, timeout=timeout)

    def scp(self, ip: str, files: list[Path], dest: str = "/tmp/") -> None:
        cmd = ["scp", "-q", "-i", str(self.ssh_key), "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes",
               "-o", f'UserKnownHostsFile="{self.known_hosts}"', "-o", "StrictHostKeyChecking=yes",
               *self.KEEPALIVE, "-o", "LogLevel=ERROR", *[str(f) for f in files], f"nebula-admin@{ip}:{dest}"]
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        if p.returncode != 0:
            raise VMError("scp_failed", p.stderr[-500:])

    def wait_for_ssh(self, timeout: float = 300) -> str:
        deadline = time.time() + timeout
        last = ""
        while time.time() < deadline:
            ip = self.guest_ip()
            if ip:
                try:
                    p = self.ssh(ip, "cloud-init status --wait >/dev/null 2>&1; echo ready", timeout=240)
                    if "ready" in p.stdout:
                        return ip
                    last = p.stderr[-300:]
                except subprocess.TimeoutExpired:
                    last = "ssh timeout"
            time.sleep(2)
        raise VMError("guest_unreachable", f"guest did not become reachable over SSH: {last}")

    async def astatus(self) -> dict[str, Any]:
        return await asyncio.to_thread(self.status)


_PRESSURE = {1: "normal", 2: "warning", 4: "critical"}


def _sysctl_uint(name: str, size: int = 4) -> int | None:
    import ctypes

    libc = _libc()
    if libc is None:
        return None
    buf = ctypes.c_uint64(0) if size == 8 else ctypes.c_uint32(0)
    sz = ctypes.c_size_t(ctypes.sizeof(buf))
    if libc.sysctlbyname(name.encode(), ctypes.byref(buf), ctypes.byref(sz), None, ctypes.c_size_t(0)) != 0:
        return None
    return int(buf.value)


_LIBC: Any = None


def _libc():
    global _LIBC
    if _LIBC is None:
        try:
            import ctypes
            import ctypes.util

            _LIBC = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)
        except OSError:
            _LIBC = False
    return _LIBC or None


def memory_status() -> dict[str, Any]:
    """Cheap in-process memory signals for scheduling decisions (~5 µs instead of ~25 ms for `host_resources`, which
    spawns sysctl/vm_stat/ps): kernel pressure level, the kernel's free-memory level (the value jetsam uses) and
    swap usage. Falls back to the `sysctl` binary when sysctlbyname is unavailable."""
    import ctypes

    level = _sysctl_uint("kern.memorystatus_vm_pressure_level")
    free_pct = _sysctl_uint("kern.memorystatus_level")
    total = _sysctl_uint("hw.memsize", 8)
    swap_used = swap_total = None
    libc = _libc()
    if libc is not None:
        class _Xsw(ctypes.Structure):
            _fields_ = [("total", ctypes.c_uint64), ("avail", ctypes.c_uint64), ("used", ctypes.c_uint64),
                        ("pagesize", ctypes.c_uint32), ("encrypted", ctypes.c_uint32)]

        x = _Xsw()
        sz = ctypes.c_size_t(ctypes.sizeof(x))
        if libc.sysctlbyname(b"vm.swapusage", ctypes.byref(x), ctypes.byref(sz), None, ctypes.c_size_t(0)) == 0:
            swap_used, swap_total = round(x.used / 1048576, 1), round(x.total / 1048576, 1)
    if level is None or free_pct is None:  # pragma: no cover - non-macOS / sandboxed fallback
        def sysctl(name: str) -> str:
            try:
                return subprocess.run(["/usr/sbin/sysctl", "-n", name], capture_output=True, text=True,
                                      timeout=5).stdout.strip()
            except (OSError, subprocess.TimeoutExpired):
                return ""
        level = int(sysctl("kern.memorystatus_vm_pressure_level") or 1)
        free_pct = int(sysctl("kern.memorystatus_level") or 0)
    return {"memory_pressure": _PRESSURE.get(level, str(level)), "memory_free_percent": free_pct,
            "swap_used_mb": swap_used, "swap_total_mb": swap_total, "memory_total_bytes": total or 0,
            "ts": time.time()}


_kernel_memory_status = memory_status  # the real reader (tests stub `memory_status`)


def _vm_statistics() -> dict[str, int] | None:
    """host_statistics64(HOST_VM_INFO64) in-process: the numbers `vm_stat` prints, in bytes, without a subprocess."""
    import ctypes

    libc = _libc()
    if libc is None:
        return None

    class _VMStat64(ctypes.Structure):
        _fields_ = [("free_count", ctypes.c_uint32), ("active_count", ctypes.c_uint32),
                    ("inactive_count", ctypes.c_uint32), ("wire_count", ctypes.c_uint32),
                    ("zero_fill_count", ctypes.c_uint64), ("reactivations", ctypes.c_uint64),
                    ("pageins", ctypes.c_uint64), ("pageouts", ctypes.c_uint64), ("faults", ctypes.c_uint64),
                    ("cow_faults", ctypes.c_uint64), ("lookups", ctypes.c_uint64), ("hits", ctypes.c_uint64),
                    ("purges", ctypes.c_uint64), ("purgeable_count", ctypes.c_uint32),
                    ("speculative_count", ctypes.c_uint32), ("decompressions", ctypes.c_uint64),
                    ("compressions", ctypes.c_uint64), ("swapins", ctypes.c_uint64), ("swapouts", ctypes.c_uint64),
                    ("compressor_page_count", ctypes.c_uint32), ("throttled_count", ctypes.c_uint32),
                    ("external_page_count", ctypes.c_uint32), ("internal_page_count", ctypes.c_uint32),
                    ("total_uncompressed_pages_in_compressor", ctypes.c_uint64)]

    try:
        libc.mach_host_self.restype = ctypes.c_uint32
        st = _VMStat64()
        cnt = ctypes.c_uint32(ctypes.sizeof(st) // 4)
        if libc.host_statistics64(libc.mach_host_self(), 4, ctypes.byref(st), ctypes.byref(cnt)) != 0:
            return None
    except (AttributeError, OSError):
        return None
    page = _sysctl_uint("hw.pagesize", 8) or 16384
    return {k: getattr(st, k) * page for k in ("free_count", "active_count", "inactive_count", "wire_count",
                                               "purgeable_count", "speculative_count", "compressor_page_count")}


_VM_PID: tuple[float, int | None] = (0.0, None)


def vm_footprint() -> tuple[bool, dict[str, Any] | None]:
    """Real memory footprint of the Virtualization.framework VM process (what Activity Monitor shows). `ps` RSS
    misses the guest RAM (it reported ~300 MB for a VM using ~3 GB), so accounting used the wrong number.

    Returns (measured, footprint). measured is False only when libproc could not answer (not loadable, or the
    rusage call failed), which is when the `ps` fallback in host_resources applies; (True, None) means libproc
    looked and no VM process is running, so there is nothing for `ps` to find either."""
    import ctypes

    global _VM_PID
    try:
        lp = ctypes.CDLL("/usr/lib/libproc.dylib")
    except OSError:
        return False, None

    def name(pid: int) -> str:
        b = ctypes.create_string_buffer(256)
        lp.proc_name(pid, b, 256)
        return b.value.decode(errors="replace")

    pid = _VM_PID[1] if time.time() - _VM_PID[0] < 30 else None
    if pid is None or not name(pid).startswith("com.apple.Virtualization.Virtua"):
        n = lp.proc_listallpids(None, 0)
        buf = (ctypes.c_int * (max(n, 0) + 128))()
        n = lp.proc_listallpids(buf, ctypes.sizeof(buf))
        pid = next((buf[i] for i in range(max(n, 0)) if buf[i] > 0 and
                    name(buf[i]).startswith("com.apple.Virtualization.Virtua")), None)
        _VM_PID = (time.time(), pid)
    if pid is None:
        return True, None
    ru = (ctypes.c_uint64 * 40)()  # struct rusage_info_v2 (uuid, user, system, idle, intr, pageins, wired, resident, ...)
    if lp.proc_pid_rusage(pid, 2, ctypes.byref(ru)) != 0:
        return False, None
    return True, {"pid": pid, "resident_bytes": int(ru[8]), "footprint_bytes": int(ru[9])}


def host_resources(data_dir: Path) -> dict[str, Any]:
    """Host memory/disk/VM numbers. In-process (sysctl, host_statistics64, libproc): ~1 ms instead of ~25 ms for
    the former sysctl/vm_stat/ps subprocesses; the subprocess path remains as a fallback."""
    mem = memory_status()
    total = mem.get("memory_total_bytes") or 0
    pages = _vm_statistics()
    if pages is None:  # pragma: no cover - fallback
        pages = {}
        try:
            out = subprocess.run(["/usr/bin/vm_stat"], capture_output=True, text=True, timeout=5).stdout
            page_size = int(re.search(r"page size of (\d+)", out).group(1))  # type: ignore[union-attr]
            raw = {k.strip(): int(v.strip().rstrip(".") or 0) * page_size for k, v in
                   (line.split(":", 1) for line in out.splitlines()[1:] if ":" in line)}
            pages = {"free_count": raw.get("Pages free", 0), "inactive_count": raw.get("Pages inactive", 0),
                     "speculative_count": raw.get("Pages speculative", 0),
                     "purgeable_count": raw.get("Pages purgeable", 0)}
        except Exception:  # noqa: BLE001
            pass
    available = pages.get("free_count", 0) + pages.get("inactive_count", 0) + pages.get("speculative_count", 0) \
        + pages.get("purgeable_count", 0)
    du = shutil.disk_usage(data_dir if data_dir.exists() else Path.home())
    measured, fp = vm_footprint()
    vm_rss = fp["resident_bytes"] if fp else 0
    if not measured:  # pragma: no cover - fallback; not taken just because no VM is running
        try:
            out = subprocess.run(["/bin/ps", "-axo", "rss=,comm="], capture_output=True, text=True, timeout=5).stdout
            for line in out.splitlines():
                if "com.apple.Virtualization.VirtualMachine" in line:
                    vm_rss += int(line.split()[0]) * 1024
        except Exception:  # noqa: BLE001
            pass
    return {
        "memory_total_bytes": total,
        "memory_available_bytes": available,
        "memory_free_percent": mem.get("memory_free_percent"),
        "memory_pressure": mem.get("memory_pressure"),
        "memory_compressed_bytes": pages.get("compressor_page_count"),
        "memory_wired_bytes": pages.get("wire_count"),
        "swap_used_mb": mem.get("swap_used_mb"),
        "load_avg": list(os.getloadavg()),
        "cpu_count": os.cpu_count(),
        "disk_total_bytes": du.total,
        "disk_free_bytes": du.free,
        "vm_resident_bytes": vm_rss,
        "vm_footprint_bytes": fp["footprint_bytes"] if fp else None,
    }


_real_host_resources = host_resources  # the real reader (scheduler tests stub `host_resources`)
