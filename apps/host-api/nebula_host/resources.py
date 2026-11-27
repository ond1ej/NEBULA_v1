"""Smart resource manager for a 16 GB Mac mini (V2 module 7).

Profiles (persisted in SQLite, default BALANCED) are turned into *effective* limits from measured values — guest
RAM actually present, host memory pressure, free disk — never from fixed numbers alone:

  ECO          1 active desktop, idle agents sleep after 5 min, 1 local + 1 cloud inference at a time
  BALANCED     up to 2 active desktops (V1 default), idle sleep after 20 min, 1 local + 2 cloud inferences
  PERFORMANCE  up to 4 desktops if the guest has the memory for them, idle sleep after 60 min, 1 local + 3 cloud

Local inference is always serialised: two local models at once would push a 16 GB host into swap. The VM size
(4 GB) is never changed automatically, and the memory balloon stays off (decisions D27).
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import re
import subprocess
import time
from collections import deque
from typing import Any

from sqlalchemy import and_, delete, func, select

from nebula_host import db, models
from nebula_host.events import bus

log = logging.getLogger("nebula.resources")
PROFILES = ("ECO", "BALANCED", "PERFORMANCE")
DESKTOP_COST_MB = 750  # measured: XFCE + Xvnc + headed Chromium per agent (docs/decisions.md D26)
GUEST_RESERVED_MB = 900  # guest kernel, guest service, page cache headroom
SAMPLE_S = 20
RETENTION_S = 3 * 86400
ALERT_DEBOUNCE_S = 600
# Admission under macOS memory pressure "warning" (perf audit 2026-11-16). Observed on this Mac: "warning" can last
# 30+ minutes with flat swap and ~3 GB free in the guest while every queued task waited (0 agents working). The VM's
# RAM is a fixed 4 GB allocation, so a cloud-model task inside it adds little host memory; what destabilises the Mac
# is growing swap, a local model (several GB) or "critical". Defaults are conservative and adjustable in settings.
SWAP_WINDOW_S = 120
WARNING_MIN_FREE_PCT = 25  # kern.memorystatus_level (the kernel's free-memory percentage)
WARNING_MAX_SWAP_GROWTH_MB = 256  # swap growth within SWAP_WINDOW_S that counts as "actively swapping"
BASE = {
    "ECO": {"max_active": 1, "idle_sleep_s": 300, "local_inference": 1, "cloud_inference": 1, "host_tasks": 1},
    "BALANCED": {"max_active": 2, "idle_sleep_s": 1200, "local_inference": 1, "cloud_inference": 2, "host_tasks": 2},
    "PERFORMANCE": {"max_active": 4, "idle_sleep_s": 3600, "local_inference": 1, "cloud_inference": 3,
                    "host_tasks": 3},
}


def swap_usage() -> dict[str, float]:
    try:
        out = subprocess.run(["/usr/sbin/sysctl", "-n", "vm.swapusage"], capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.TimeoutExpired):
        return {}
    vals = dict(re.findall(r"(\w+) = ([\d.]+)M", out))
    return {k: float(v) for k, v in vals.items()}


_CPU_TICKS: tuple[int, int] | None = None


def _cpu_ticks() -> tuple[int, int] | None:
    """(busy, total) CPU ticks since boot via host_statistics(HOST_CPU_LOAD_INFO), in-process."""
    import ctypes

    from nebula_host.vm import _libc

    libc = _libc()
    if libc is None:
        return None
    try:
        libc.mach_host_self.restype = ctypes.c_uint32
        ticks = (ctypes.c_uint32 * 4)()  # user, system, idle, nice
        cnt = ctypes.c_uint32(4)
        if libc.host_statistics(libc.mach_host_self(), 3, ctypes.byref(ticks), ctypes.byref(cnt)) != 0:
            return None
    except (AttributeError, OSError):
        return None
    busy = ticks[0] + ticks[1] + ticks[3]
    return busy, busy + ticks[2]


def host_cpu_percent() -> float | None:
    """Host CPU % averaged since the previous call (kernel tick counters, no subprocess); the first call falls back
    to the sum of per-process %CPU from ps."""
    global _CPU_TICKS
    now = _cpu_ticks()
    prev, _CPU_TICKS = _CPU_TICKS, now
    if now and prev and now[1] > prev[1]:
        return round(100.0 * (now[0] - prev[0]) / (now[1] - prev[1]), 1)
    try:
        out = subprocess.run(["/bin/ps", "-A", "-o", "%cpu="], capture_output=True, text=True, timeout=5).stdout
        import os

        total = sum(float(x) for x in out.split() if x.replace(".", "", 1).isdigit())
        return round(min(100.0, total / (os.cpu_count() or 1)), 1)
    except (OSError, subprocess.TimeoutExpired, ValueError):
        return None


class ResourceManager:
    def __init__(self, cfg, orch, guest, live=None) -> None:
        self.cfg = cfg
        self.orch = orch
        self.guest = guest
        self.live = live
        self._sems: dict[str, asyncio.Semaphore] = {}
        self._sem_sizes: dict[str, int] = {}
        self._last: dict[str, Any] = {}
        self._alerts: dict[str, float] = {}
        self._task: asyncio.Task | None = None
        self._guest_total_mb: float | None = None
        self.inflight: dict[str, int] = {"local": 0, "cloud": 0}
        self._swap_hist: deque[tuple[float, float]] = deque(maxlen=120)
        self._pressure: str | None = None
        self._mem: dict[str, Any] = {}
        self._sim: tuple[str, float] | None = None  # (pressure, expires_at): owner-started pressure drill

    # ------------------------------------------------------------------ pressure drill (controlled test interface)
    SIM_LEVELS = ("warning", "critical")

    def simulate(self, pressure: str | None, minutes: float = 5) -> dict[str, Any]:
        """Pretend the Mac is under `warning`/`critical` pressure for a few minutes (E2E drills of deferral and
        recovery without exhausting real memory). It can only make scheduling MORE conservative: a real `critical`
        always wins and `normal` cannot be simulated. None ends the drill."""
        if pressure is None:
            self._sim = None
        else:
            if pressure not in self.SIM_LEVELS:
                raise ValueError("only warning or critical can be simulated")
            self._sim = (pressure, time.time() + max(0.5, min(float(minutes), 30)) * 60)
        st = self.memory()
        return {"simulated": self._sim[0] if self._sim else None,
                "expires_at": self._sim[1] if self._sim else None, "effective_pressure": st.get("memory_pressure")}

    # ------------------------------------------------------------------ memory signals & admission
    def memory(self) -> dict[str, Any]:
        """Current kernel memory signals (cheap); records swap history and announces pressure transitions."""
        from nebula_host import vm

        st = dict(vm.memory_status())
        if self._sim and time.time() > self._sim[1]:
            self._sim = None
        if self._sim:
            order = {"normal": 0, "warning": 1, "critical": 2}
            real = st.get("memory_pressure") or "normal"
            if order.get(self._sim[0], 0) > order.get(real, 0):
                st["memory_pressure"], st["simulated"], st["real_pressure"] = self._sim[0], True, real
        sw = st.get("swap_used_mb")
        if sw is not None and (not self._swap_hist or st["ts"] - self._swap_hist[-1][0] >= 5):
            self._swap_hist.append((st["ts"], float(sw)))
        p = st.get("memory_pressure")
        if p != self._pressure:
            prev, self._pressure = self._pressure, p
            if prev is not None:
                log.info("host memory pressure %s -> %s", prev, p)
                bus.publish("resource.pressure.changed", {"from": prev, "to": p,
                                                          "free_percent": st.get("memory_free_percent"),
                                                          "swap_used_mb": sw, "simulated": bool(st.get("simulated"))})
                if p == "normal" or (prev == "critical" and p == "warning"):
                    self.orch.wake.set()  # queued work may start now
        self._mem = st
        return st

    def swap_growth_mb(self, window_s: float = SWAP_WINDOW_S) -> float:
        now = time.time()
        pts = [v for t, v in self._swap_hist if now - t <= window_s]
        return round(max(0.0, pts[-1] - min(pts)), 1) if len(pts) >= 2 else 0.0

    def _setting_num(self, key: str, default: float) -> float:
        try:
            return float(db.get_setting(key, default))
        except (TypeError, ValueError):
            return default

    def admission(self, env: str, provider_id: str | None) -> tuple[bool, str]:
        """May new agent work start now? normal: yes. critical: no. warning: only cloud-model work, only while swap
        is not growing and the kernel reports enough free memory (concurrency is capped to 1 separately)."""
        st = self.memory()
        p = st.get("memory_pressure")
        if p == "normal":
            return True, ""
        if p == "critical":
            return False, "Mac memory pressure is critical — queued until it eases"
        if provider_id and self._kind(provider_id) == "local":
            return False, "Mac memory pressure is warning and a local model needs several GB — queued until normal"
        growth = self.swap_growth_mb()
        max_growth = self._setting_num("resources.warning_max_swap_growth_mb", WARNING_MAX_SWAP_GROWTH_MB)
        if growth > max_growth:
            return False, f"Mac memory pressure is warning and swap grew {growth:.0f} MB in {SWAP_WINDOW_S // 60} min " \
                          "— queued until it settles"
        free = st.get("memory_free_percent")
        min_free = self._setting_num("resources.warning_min_free_pct", WARNING_MIN_FREE_PCT)
        if free is not None and free < min_free:
            return False, f"Mac memory pressure is warning with {free}% free memory (< {min_free:.0f}%) — queued"
        return True, ""

    # ------------------------------------------------------------------ profile & limits
    def profile(self) -> str:
        p = db.get_setting("resources.profile", "BALANCED")
        return p if p in PROFILES else "BALANCED"

    def set_profile(self, p: str) -> dict[str, Any]:
        if p not in PROFILES:
            raise ValueError(f"profile must be one of {', '.join(PROFILES)}")
        db.set_setting("resources.profile", p)
        self._resize_sems()
        self.orch.wake.set()
        return self.limits()

    def limits(self) -> dict[str, Any]:
        prof = self.profile()
        base = dict(BASE[prof])
        if prof == "BALANCED":
            base["max_active"] = self.cfg.agents.default_active_limit  # V1 setting keeps working
        reasons = []
        cap = base["max_active"]
        if self._guest_total_mb:
            fit = max(1, int((self._guest_total_mb - GUEST_RESERVED_MB) // DESKTOP_COST_MB))
            if fit < cap:
                reasons.append(f"guest RAM {self._guest_total_mb:.0f} MB fits {fit} desktop(s)")
                cap = fit
        pressure = self._pressure or (self._last.get("host") or {}).get("memory_pressure")
        if pressure in ("warning", "critical") and cap > 1:
            cap = 1
            reasons.append("host memory pressure: warning")
        disk_gb = (self._last.get("host") or {}).get("disk_free_gb")
        if disk_gb is not None and disk_gb < 5:
            reasons.append(f"low disk: {disk_gb:.1f} GB free")
        host_cap = base["host_tasks"]
        if pressure in ("warning", "critical") and host_cap > 1:
            host_cap = 1
        return {"profile": prof, **base, "max_active_effective": cap, "host_tasks_effective": host_cap,
                "constraints": reasons, "desktop_cost_mb": DESKTOP_COST_MB,
                "memory": {"pressure": pressure, "free_percent": self._mem.get("memory_free_percent"),
                           "swap_growth_mb_2min": self.swap_growth_mb(),
                           "simulated": self._sim[0] if self._sim else None}}

    def active_limit(self) -> int:
        return self.limits()["max_active_effective"]

    def host_limit(self) -> int:
        """Concurrent native-Mac tasks (V3): no VM memory needed, but they share CPU/RAM with the VM (1 under
        memory pressure)."""
        return int(self.limits()["host_tasks_effective"])

    # ------------------------------------------------------------------ inference
    def _kind(self, provider_id: str) -> str:
        with db.engine().connect() as c:
            mode = c.execute(select(models.providers.c.auth_mode).where(models.providers.c.id == provider_id)).scalar()
        return "local" if mode == "local" else "cloud"

    def _resize_sems(self) -> None:
        lim = self.limits()
        for kind in ("local", "cloud"):
            n = lim[f"{kind}_inference"]
            if self._sem_sizes.get(kind) != n:
                self._sems[kind] = asyncio.Semaphore(n)  # in-flight holders finish on the old semaphore
                self._sem_sizes[kind] = n

    @contextlib.asynccontextmanager
    async def inference_slot(self, provider_id: str):
        kind = self._kind(provider_id)
        if kind not in self._sems:
            self._resize_sems()
        sem = self._sems[kind]
        async with sem:
            self.inflight[kind] += 1
            try:
                yield
            finally:
                self.inflight[kind] -= 1

    # ------------------------------------------------------------------ sampling
    async def start(self) -> None:
        self._resize_sems()
        self._task = asyncio.create_task(self._loop(), name="nebula-resources")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()

    async def _loop(self) -> None:
        n = 0
        while True:
            try:
                await self.sample()
                await self.auto_sleep_idle()
                n += 1
                if n % 90 == 0:
                    with db.engine().begin() as c:
                        c.execute(delete(models.resource_samples).where(
                            models.resource_samples.c.ts < time.time() - RETENTION_S))
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("resource sampling failed")
            await asyncio.sleep(SAMPLE_S)

    async def snapshot(self, max_age: float = 0.0) -> dict[str, Any]:
        """Live resource snapshot. Host numbers, queue and agent states are always fresh (all cheap now); with
        `max_age` > 0 the two guest round trips (ping + per-agent cgroup memory) are reused for that many seconds,
        so several dashboards / Mini Apps polling at once do not each query the VM."""
        from nebula_host.vm import host_resources

        host = await asyncio.to_thread(host_resources, self.cfg.data_dir)
        host["cpu_percent"] = await asyncio.to_thread(host_cpu_percent)
        mem = self.memory()
        host["memory_pressure"] = mem.get("memory_pressure") or host.get("memory_pressure")
        host["memory_free_percent"] = mem.get("memory_free_percent", host.get("memory_free_percent"))
        host["swap_used_mb"] = mem.get("swap_used_mb")
        host["swap_total_mb"] = mem.get("swap_total_mb")
        host["swap_growth_mb_2min"] = self.swap_growth_mb()
        host["disk_free_gb"] = round(host["disk_free_bytes"] / 1e9, 1)
        host["memory_used_percent"] = round(100 * (1 - host["memory_available_bytes"] / host["memory_total_bytes"]), 1) \
            if host.get("memory_total_bytes") else None
        gc = getattr(self, "_guest_cache", None)
        if max_age and gc and time.time() - gc[0] < max_age:
            guest, agents_res = gc[1], gc[2]
        else:
            guest, agents_res = await self._guest_snapshot()
            self._guest_cache = (time.time(), guest, agents_res)
        with db.engine().connect() as c:
            queued = db.rows(c.execute(
                select(models.tasks.c.id, models.tasks.c.agent_id, models.tasks.c.priority, models.tasks.c.created_at,
                       models.tasks.c.source_channel, models.tasks.c.prompt, models.agents.c.name.label("agent_name"))
                .join(models.agents, models.agents.c.id == models.tasks.c.agent_id)
                .where(models.tasks.c.state == "QUEUED")
                .order_by(models.tasks.c.priority.desc(), models.tasks.c.created_at).limit(50)))
            agents = db.rows(c.execute(select(models.agents.c.id, models.agents.c.name, models.agents.c.status,
                                              models.agents.c.last_active_at, models.agents.c.resource_mode)))
        return self._finish_snapshot(host, guest, agents_res, queued, agents)

    async def _guest_snapshot(self) -> tuple[dict[str, Any], dict[str, Any]]:
        from nebula_host.guest import GuestError, GuestUnavailable

        guest: dict[str, Any] = {"status": "unavailable"}
        agents_res: dict[str, Any] = {}
        try:
            ping = await self.guest.ping(timeout=5)
            mem = ping.get("mem") or {}
            self._guest_total_mb = mem.get("MemTotal", 0) / 1024 / 1024 or self._guest_total_mb
            guest = {"status": "ok", "mem_total_mb": round(mem.get("MemTotal", 0) / 1048576),
                     "mem_available_mb": round(mem.get("MemAvailable", 0) / 1048576),
                     "swap_free_mb": round(mem.get("SwapFree", 0) / 1048576) if mem.get("SwapFree") is not None else None,
                     "loadavg": ping.get("loadavg"), "uptime_s": ping.get("uptime_s")}
            try:
                agents_res = (await self.guest.call("resources.agents", {}, timeout=20)).get("agents", {})
            except (GuestError, GuestUnavailable):
                agents_res = {}
        except (GuestError, GuestUnavailable) as e:
            guest = {"status": "unavailable", "detail": str(e)}
        return guest, agents_res

    def _finish_snapshot(self, host: dict[str, Any], guest: dict[str, Any], agents_res: dict[str, Any],
                         queued: list[dict[str, Any]], agents: list[dict[str, Any]]) -> dict[str, Any]:
        for q in queued:
            q["prompt"] = q["prompt"][:120]
            q["waiting_for_resources"] = q["id"] in self.orch.waiting_resources
        for a in agents:
            r = agents_res.get(a["id"]) or {}
            a["memory_mb"] = round(r.get("memory_bytes", 0) / 1048576) if r else None
            a["units"] = r.get("units")
            a["busy"] = a["id"] in self.orch.workers
        snap = {"ts": time.time(), "host": host, "guest": guest, "agents": agents, "queue": queued,
                "active_workers": self.orch.active_count(), "inference_inflight": dict(self.inflight)}
        self._last = snap
        snap["limits"] = self.limits()
        return snap

    async def sample(self) -> dict[str, Any]:
        s = await self.snapshot()
        h, g = s["host"], s["guest"]
        with db.engine().begin() as c:
            c.execute(models.resource_samples.insert().prefix_with("OR REPLACE").values(
                ts=s["ts"], host_mem_used_pct=h.get("memory_used_percent"), host_pressure=h.get("memory_pressure"),
                host_cpu_pct=h.get("cpu_percent"), host_swap_used_mb=h.get("swap_used_mb"),
                disk_free_gb=h.get("disk_free_gb"), vm_rss_mb=round(h.get("vm_resident_bytes", 0) / 1048576),
                guest_mem_avail_mb=g.get("mem_available_mb"), guest_load1=(g.get("loadavg") or [None])[0],
                active_agents=s["active_workers"], queued_tasks=len(s["queue"]), profile=s["limits"]["profile"],
                host_free_pct=h.get("memory_free_percent"), swap_growth_mb=h.get("swap_growth_mb_2min"),
                vm_footprint_mb=round(h["vm_footprint_bytes"] / 1048576) if h.get("vm_footprint_bytes") else None))
        self._alerts_check(s)
        return s

    def _alert(self, kind: str, message: str, level: str = "warning") -> None:
        if time.time() - self._alerts.get(kind, 0) < ALERT_DEBOUNCE_S:
            return
        self._alerts[kind] = time.time()
        bus.publish("resource.alert", {"kind": kind, "level": level, "message": message})

    def _alerts_check(self, s: dict[str, Any]) -> None:
        h, g = s["host"], s["guest"]
        if h.get("memory_pressure") in ("warning", "critical"):
            self._alert("host_pressure", f"Mac memory pressure is {h['memory_pressure']}; new agent work is queued",
                        "critical" if h["memory_pressure"] == "critical" else "warning")
        if (h.get("swap_used_mb") or 0) > 3072:
            self._alert("host_swap", f"Mac is using {h['swap_used_mb']:.0f} MB swap")
        if (h.get("disk_free_gb") or 99) < 5:
            self._alert("disk", f"only {h['disk_free_gb']} GB free disk space", "critical")
        if g.get("status") == "ok" and (g.get("mem_available_mb") or 9999) < 400:
            self._alert("guest_memory", f"VM has only {g['mem_available_mb']} MB available")
        if g.get("status") != "ok":
            self._alert("vm", "the Ubuntu VM is not responding", "critical")

    def history(self, since_s: float = 3600, points: int = 240) -> list[dict[str, Any]]:
        since = time.time() - since_s
        with db.engine().connect() as c:
            n = c.execute(select(func.count()).select_from(models.resource_samples)
                          .where(models.resource_samples.c.ts >= since)).scalar() or 0
            step = max(1, n // points)
            rows = db.rows(c.execute(select(models.resource_samples).where(models.resource_samples.c.ts >= since)
                                     .order_by(models.resource_samples.c.ts)))
        return rows[::step]

    # ------------------------------------------------------------------ auto sleep
    async def auto_sleep_idle(self) -> list[str]:
        idle_s = self.limits()["idle_sleep_s"]
        now = time.time()
        with db.engine().connect() as c:
            cand = db.rows(c.execute(select(models.agents).where(and_(
                models.agents.c.status == "READY", models.agents.c.resource_mode != "ACTIVE_PINNED"))))
            queued = {r.agent_id for r in c.execute(select(models.tasks.c.agent_id).where(
                models.tasks.c.state.in_(["QUEUED", "RECEIVED", "WAITING_PROVIDER", "PAUSED"])))}
        viewing = set()
        if self.live is not None:
            with contextlib.suppress(Exception):
                viewing = {s.get("agent_id") for s in self.live.active_streams()}
        slept = []
        for a in cand:
            # a wake-up or any state change counts as activity (a manually woken desktop is not idle)
            last = max(a.get("last_active_at") or 0, a.get("updated_at") or 0)
            override = (a.get("config") or {}).get("idle_sleep_minutes")
            limit_s = idle_s if override is None else int(override) * 60
            if override == 0:  # 0 = this agent never auto-sleeps
                continue
            if now - last < limit_s or a["id"] in self.orch.workers or a["id"] in queued:
                continue
            if self.orch.control_held(a["id"]) or a["id"] in viewing:
                continue
            try:
                await self.guest.call("workspace.stop", {"agent_id": a["id"]}, timeout=60)
            except Exception as e:  # noqa: BLE001
                log.warning("auto-sleep of %s failed: %s", a["id"], e)
                continue
            from nebula_runtime.orchestrator import set_agent_status

            set_agent_status(a["id"], "SLEEP", f"auto-sleep: idle for {int((now - last) / 60)} min ({self.profile()})")
            slept.append(a["id"])
        return slept
