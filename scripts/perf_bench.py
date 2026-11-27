#!/usr/bin/env python3
"""NEBULA performance benchmark against the installed service, the real Mac and the real VM.

No AI requests and no Telegram messages. Uses only test agents for sleep/wake (default "E2E Agent", env NEBULA_E2E_AGENT).
  python scripts/perf_bench.py --label baseline      -> build/perf/baseline.json
  python scripts/perf_bench.py --label after         -> build/perf/after.json
Each section is independent; a failing section is recorded as an error and the run continues.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import statistics
import struct
import subprocess
import sys
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import e2e  # noqa: E402  (Api helper + sys.path for the NEBULA packages)

OUT_DIR = ROOT / "build/perf"
RES: dict = {"started": time.strftime("%Y-%m-%d %H:%M:%S"), "sections": {}}


def stats(xs: list[float]) -> dict:
    xs = sorted(xs)
    if not xs:
        return {"n": 0}
    p95 = xs[min(len(xs) - 1, int(round(0.95 * (len(xs) - 1))))]
    return {"n": len(xs), "p50_ms": round(statistics.median(xs), 2), "p95_ms": round(p95, 2),
            "max_ms": round(xs[-1], 2), "mean_ms": round(statistics.fmean(xs), 2)}


def timed(fn, n: int, warm: int = 2) -> tuple[dict, object]:
    last = None
    for _ in range(warm):
        last = fn()
    xs = []
    for _ in range(n):
        t = time.perf_counter()
        last = fn()
        xs.append((time.perf_counter() - t) * 1000)
    return stats(xs), last


def section(name):
    def deco(fn):
        def run(*a, **kw):
            t0 = time.time()
            try:
                RES["sections"][name] = fn(*a, **kw)
            except Exception as e:  # noqa: BLE001 - one broken section never hides the others
                RES["sections"][name] = {"error": f"{type(e).__name__}: {e}"}
            RES["sections"][name]["_duration_s"] = round(time.time() - t0, 1) \
                if isinstance(RES["sections"][name], dict) else None
            print(f"[{name}] {json.dumps(RES['sections'][name], default=str)[:400]}", flush=True)
        return run
    return deco


# ----------------------------------------------------------------------------------------------- system
def host_snapshot() -> dict:
    def sh(*cmd):
        return subprocess.run(cmd, capture_output=True, text=True, timeout=20).stdout

    out = {"pressure_level": sh("/usr/sbin/sysctl", "-n", "kern.memorystatus_vm_pressure_level").strip(),
           "free_level_pct": sh("/usr/sbin/sysctl", "-n", "kern.memorystatus_level").strip(),
           "swap": sh("/usr/sbin/sysctl", "-n", "vm.swapusage").strip(),
           "load": os.getloadavg()}
    procs = {}
    for line in sh("/bin/ps", "-axo", "pid=,rss=,%cpu=,command=").splitlines():
        parts = line.split(None, 3)
        if len(parts) < 4:
            continue
        pid, rss, cpu, cmd = parts
        key = ("nebula-host" if "nebula_host" in cmd or ("Python" in cmd and "NEBULA/app" in cmd) else
               "vm-process" if "Virtualization.VirtualMachine" in cmd else
               "nebula-vm-helper" if "NEBULA/bin/nebula-vm" in cmd else
               "ollama" if "ollama" in cmd.lower() else None)
        if key:
            p = procs.setdefault(key, {"rss_mb": 0, "cpu_pct": 0.0, "pids": []})
            p["rss_mb"] += round(int(rss) / 1024)
            p["cpu_pct"] += float(cpu)
            p["pids"].append(int(pid))
    # `top` reports the VM's real footprint (guest RAM is not in ps RSS)
    vm = procs.get("vm-process")
    if vm:
        t = sh("/usr/bin/top", "-l", "1", "-stats", "pid,mem,cmprs", "-pid", str(vm["pids"][0]))
        m = re.search(rf"^{vm['pids'][0]}\s+(\S+)\s+(\S+)", t, re.M)
        if m:
            vm["top_mem"], vm["top_compressed"] = m.group(1), m.group(2)
    host = procs.get("nebula-host")
    if host:
        t = sh("/usr/bin/top", "-l", "1", "-stats", "pid,mem,cpu", "-pid", str(host["pids"][0]))
        m = re.search(rf"^{host['pids'][0]}\s+(\S+)", t, re.M)
        if m:
            host["top_mem"] = m.group(1)
    vm_stat = sh("/usr/bin/vm_stat")
    ps = int(re.search(r"page size of (\d+)", vm_stat).group(1))
    pages = {k.strip(): int(v.strip().rstrip(".")) * ps for k, v in re.findall(r"^([^:\n]+):\s+(\d+)\.?$", vm_stat, re.M)}
    out["vm_stat_gb"] = {k: round(pages.get(k, 0) / 1e9, 2) for k in
                         ("Pages free", "Pages active", "Pages inactive", "Pages wired down",
                          "Pages occupied by compressor", "Pages purgeable", "Pages speculative")}
    out["processes"] = procs
    return out


@section("system")
def bench_system() -> dict:
    samples = []
    for _ in range(3):
        samples.append(host_snapshot())
        time.sleep(1)
    return {"samples": samples}


@section("host_resources_cost")
def bench_host_resources() -> dict:
    from nebula_host import resources as rm
    from nebula_host import vm

    data_dir = e2e.DATA
    out = {}
    out["host_resources"], _ = timed(lambda: vm.host_resources(data_dir), 10, 1)
    out["swap_usage"], _ = timed(rm.swap_usage, 10, 1)
    out["host_cpu_percent"], _ = timed(rm.host_cpu_percent, 10, 1)
    fast = getattr(vm, "memory_status", None)
    if fast:
        out["memory_status_fast"], _ = timed(fast, 50, 2)
    return out


# ----------------------------------------------------------------------------------------------- API
API_GETS = ["/api/v1/health", "/api/v1/auth/state", "/api/v1/agents", "/api/v1/tasks?limit=50", "/api/v1/overview",
            "/api/v1/monitor", "/api/v1/resources", "/api/v1/companies", "/api/v1/workflows", "/api/v1/teams",
            "/api/v1/schedules", "/api/v1/providers", "/api/v1/telegram", "/api/v1/approvals", "/api/v1/notifications",
            "/api/v1/remote", "/api/v1/host/roots", "/api/v1/bots", "/api/v1/live/sessions", "/api/v1/audit?limit=100"]


@section("api_latency")
def bench_api(api) -> dict:
    out = {}
    for path in API_GETS:
        def get(p=path):
            r = api.c.get(p, headers={"Accept-Encoding": "gzip, br"})
            return r
        try:
            st, r = timed(get, 25, 2)
            st["status"] = r.status_code
            st["bytes"] = len(r.content)
            st["wire_bytes"] = int(r.headers.get("content-length") or 0) or None
            st["encoding"] = r.headers.get("content-encoding")
            out[path] = st
        except Exception as e:  # noqa: BLE001
            out[path] = {"error": str(e)}
    allp50 = [v["p50_ms"] for v in out.values() if "p50_ms" in v]
    out["_summary"] = {"endpoints": len(allp50), "median_of_p50_ms": round(statistics.median(allp50), 2),
                       "slowest": sorted(((v.get("p95_ms", 0), k) for k, v in out.items() if "p95_ms" in v))[-5:]}
    return out


@section("chat")
def bench_chat(api) -> dict:
    """V3.2 chat paths (3.1.0 fallback: the per-agent endpoints the old Mini App used). Sending uses a temporary probe
    agent on a key-less provider: the task fails before any model request (no AI usage)."""
    import uuid as _uuid

    out: dict = {}
    has_conv = api.c.get("/api/v1/conversations").status_code == 200
    out["api"] = "conversations" if has_conv else "agents (3.1.0)"
    list_path = "/api/v1/conversations" if has_conv else "/api/v1/agents"
    out["list"], _ = timed(lambda: api.c.get(list_path, headers={"Accept-Encoding": "gzip, br"}), 20, 2)
    agents = [a for a in api.get("/api/v1/agents")][:4]
    loads = []
    for i, a in enumerate(agents):
        if has_conv:
            cid = api.get(f"/api/v1/agents/{a['id']}/conversation")["id"]
            path = f"/api/v1/conversations/{cid}/messages?limit=50"
        else:
            path = f"/api/v1/agents/{a['id']}/messages?limit=50"
        st, r = timed(lambda p=path: api.c.get(p, headers={"Accept-Encoding": "gzip, br"}), 15, 1)
        st["bytes"] = len(r.content)
        out[f"load_chat_{i}"] = st
        loads.append(st["p50_ms"])
    out["load_chat_median_p50_ms"] = round(statistics.median(loads), 2) if loads else None
    probe = api.post("/api/v1/agents", {"name": "Perf Chat Probe", "provider_id": "anthropic-api",
                                        "model_id": "perf-probe", "permission_level": "STANDARD"},
                     headers={"Idempotency-Key": str(_uuid.uuid4())})
    try:
        sends = []
        cid = api.get(f"/api/v1/agents/{probe['id']}/conversation")["id"] if has_conv else None
        for k in range(8):
            t = time.perf_counter()
            if has_conv:
                r = api.c.post(f"/api/v1/conversations/{cid}/messages",
                               json={"content": f"bench {k}", "client_id": _uuid.uuid4().hex},
                               headers={"x-csrf-token": api.csrf})
            else:
                r = api.c.post(f"/api/v1/agents/{probe['id']}/tasks", json={"prompt": f"bench {k}"},
                               headers={"x-csrf-token": api.csrf})
            sends.append((time.perf_counter() - t) * 1000)
            assert r.status_code == 201, r.text[:200]
        out["send_message"] = stats(sends)
    finally:
        time.sleep(2)
        api.delete(f"/api/v1/agents/{probe['id']}?confirm=true")
    if api.c.get("/api/v1/vault/status").status_code == 200:
        out["vault_status"], _ = timed(lambda: api.c.get("/api/v1/vault/status"), 20, 2)
        out["vault_entries"], _ = timed(lambda: api.c.get("/api/v1/vault/entries"), 20, 2)
    return out


def _assets(base: str, html: str) -> list[str]:
    return re.findall(r'(?:src|href)="(/assets/[^"]+)"', html)


@section("static_load")
def bench_static(api) -> dict:
    out = {}
    for page in ("/", "/mini/"):
        c = httpx.Client(base_url=api.base, timeout=30, http2=False)
        loads, wire_total = [], 0
        for _ in range(8):
            t = time.perf_counter()
            r = c.get(page, headers={"Accept-Encoding": "gzip, br"})
            assets = _assets(api.base, r.text)
            wire = len(r.content)
            for a in assets:
                with c.stream("GET", a, headers={"Accept-Encoding": "gzip, br"}) as s:
                    body = b"".join(s.iter_raw())
                    wire += len(body)
                    enc = s.headers.get("content-encoding")
                    cache = s.headers.get("cache-control")
            loads.append((time.perf_counter() - t) * 1000)
            wire_total = wire
        out[page] = {"cold_fetch": stats(loads), "assets": assets, "wire_bytes": wire_total,
                     "asset_encoding": enc, "asset_cache_control": cache}
    return out


@section("sse_connect")
def bench_sse(api) -> dict:
    xs = []
    for _ in range(10):
        t = time.perf_counter()
        with api.c.stream("GET", "/api/v1/events") as s:
            for _chunk in s.iter_raw():
                xs.append((time.perf_counter() - t) * 1000)
                break
    return {"first_byte": stats(xs)}


# ----------------------------------------------------------------------------------------------- VM
def pick_agent(api, name: str) -> dict:
    for a in api.get("/api/v1/agents"):
        if a["name"] == name:
            return a
    raise RuntimeError(f"test agent {name!r} not found")


def wait_status(api, aid: str, statuses: set[str], timeout: float = 180) -> tuple[str, float]:
    t0 = time.time()
    while time.time() - t0 < timeout:
        a = api.get(f"/api/v1/agents/{aid}")
        if a["state"] in statuses:
            return a["state"], time.time() - t0
        time.sleep(0.25)
    raise TimeoutError(f"agent {aid} not in {statuses} after {timeout}s")


@section("agent_sleep_wake")
def bench_wake(api, agent: dict) -> dict:
    out = {}
    a = api.get(f"/api/v1/agents/{agent['id']}")
    if a["state"] == "SLEEP":
        t = time.perf_counter()
        api.post(f"/api/v1/agents/{agent['id']}/wake")
        st, _ = wait_status(api, agent["id"], {"READY"})
        out["initial_wake_s"] = round(time.perf_counter() - t, 2)
    walls = []
    for _ in range(2):
        t = time.perf_counter()
        api.post(f"/api/v1/agents/{agent['id']}/sleep")
        wait_status(api, agent["id"], {"SLEEP"})
        sleep_s = time.perf_counter() - t
        t = time.perf_counter()
        api.post(f"/api/v1/agents/{agent['id']}/wake")
        wait_status(api, agent["id"], {"READY"})
        walls.append({"sleep_s": round(sleep_s, 2), "wake_s": round(time.perf_counter() - t, 2)})
    t = time.perf_counter()
    shot = api.c.get(f"/api/v1/agents/{agent['id']}/screenshot")
    out["first_screenshot_after_wake_ms"] = round((time.perf_counter() - t) * 1000, 1)
    out["first_screenshot_non_empty"] = shot.headers.get("x-non-empty")
    out["cycles"] = walls
    return out


@section("vm_latency")
def bench_vm(api, agent: dict) -> dict:
    out = {}
    aid = agent["id"]
    out["screenshot_api"], r = timed(lambda: api.c.get(f"/api/v1/agents/{aid}/screenshot"), 15, 2)
    out["screenshot_bytes"] = len(r.content)
    out["files_list_api"], _ = timed(lambda: api.c.get("/api/v1/files/list", params={"root": f"agent:{aid}",
                                                                                     "path": "."}), 15, 2)
    out["health_guest_latency_ms"] = [api.get("/api/v1/health")["guest"].get("latency_ms") for _ in range(10)]

    from nebula_host import secrets as sec
    from nebula_host.config import load_config
    from nebula_host.guest import GuestClient
    from nebula_setup.installer import guest_key

    sec.init_store("keychain")
    cfg = load_config()
    gc = GuestClient(cfg.run_dir / "vm", guest_key)

    async def go():
        res = {}
        for name, fn in (("ping", lambda: gc.ping()),
                         ("shell_echo", lambda: gc.tool(aid, "shell.execute", {"command": "echo nebula", "timeout": 10})),
                         ("files_list", lambda: gc.tool(aid, "files.list", {"path": "."})),
                         ("desktop_screenshot", lambda: gc.tool(aid, "desktop.screenshot", {})),
                         ("desktop_screenshot_half", lambda: gc.tool(aid, "desktop.screenshot", {"scale": 0.5})),
                         ("desktop_state", lambda: gc.tool(aid, "desktop.state", {}))):
            xs = []
            last = None
            for i in range(14):
                t = time.perf_counter()
                last = await fn()
                if i >= 2:
                    xs.append((time.perf_counter() - t) * 1000)
            res[name] = stats(xs)
            if name.startswith("desktop_screenshot") and isinstance(last, dict) and last.get("ok"):
                res[name]["png_b64_bytes"] = len(last["result"]["png_b64"])
        return res

    out["guest_rpc_direct"] = asyncio.run(go())
    return out


# ----------------------------------------------------------------------------------------------- live
async def rfb_bench(url: str, cookie: str, control_cb=None) -> dict:
    import websockets

    out = {}
    t0 = time.perf_counter()
    async with websockets.connect(url, additional_headers={"Cookie": cookie, "Origin": f"http://127.0.0.1:{e2e.PORT}"},
                                  subprotocols=["binary"], max_size=None) as ws:
        out["ws_open_ms"] = round((time.perf_counter() - t0) * 1000, 1)
        ver = await ws.recv()
        await ws.send(b"RFB 003.008\n")
        n = await ws.recv()
        await ws.send(bytes([1]))
        await ws.recv()
        await ws.send(bytes([1]))
        init = await ws.recv()
        w, h = struct.unpack(">HH", init[:4])
        out["handshake_ms"] = round((time.perf_counter() - t0) * 1000, 1)
        out["server_version"] = ver[:12].decode(errors="replace")
        out["security_types"] = list(n[1:1 + n[0]])
        out["framebuffer"] = [w, h]

        async def full_frame(incremental: int) -> tuple[float, int]:
            t = time.perf_counter()
            await ws.send(struct.pack(">BBHHHH", 3, incremental, 0, 0, w, h))
            got, first = 0, None
            # read until a FramebufferUpdate completed (Raw/zero-copy agnostic: wait for quiet period)
            while True:
                try:
                    msg = await asyncio.wait_for(ws.recv(), 0.6 if got else 8)
                except TimeoutError:
                    break
                if first is None:
                    first = (time.perf_counter() - t) * 1000
                got += len(msg)
            return first or -1, got

        fr = []
        for _ in range(6):
            ms, b = await full_frame(0)
            fr.append({"first_byte_ms": round(ms, 1), "bytes": b})
        out["full_frame_requests"] = fr
        out["full_frame_first_byte"] = stats([x["first_byte_ms"] for x in fr[1:]])
        out["full_frame_bytes"] = [x["bytes"] for x in fr]
        # pointer move -> incremental update latency (cursor/screen change)
        inc = []
        for i in range(6):
            await ws.send(struct.pack(">BBHH", 5, 0, 100 + 40 * i, 100 + 30 * i))
            ms, b = await full_frame(1)
            inc.append({"first_byte_ms": round(ms, 1), "bytes": b})
        out["incremental_after_pointer"] = inc
        # encodings advertised by a noVNC-like client
        out["total_s"] = round(time.perf_counter() - t0, 2)
    return out


async def rfb_encodings(url: str, cookie: str) -> dict:
    """noVNC-like client: Tight + JPEG quality / compression pseudo-encodings; full-frame bytes and time to the last
    byte (quiet period 0.3 s) for several quality levels — what a viewer actually downloads per screen."""
    import websockets

    out = {}
    async with websockets.connect(url, additional_headers={"Cookie": cookie, "Origin": f"http://127.0.0.1:{e2e.PORT}"},
                                  subprotocols=["binary"], max_size=None) as ws:
        await ws.recv()
        await ws.send(b"RFB 003.008\n")
        await ws.recv()
        await ws.send(bytes([1]))
        await ws.recv()
        await ws.send(bytes([1]))
        init = await ws.recv()
        w, h = struct.unpack(">HH", init[:4])

        async def frame(incremental: int) -> tuple[float, int]:
            t = time.perf_counter()
            await ws.send(struct.pack(">BBHHHH", 3, incremental, 0, 0, w, h))
            got, last = 0, None
            while True:
                try:
                    msg = await asyncio.wait_for(ws.recv(), 0.3 if got else 8)
                except TimeoutError:
                    break
                got += len(msg)
                last = time.perf_counter()
            return ((last - t) * 1000 if last else -1), got

        for quality, compress in ((9, 2), (6, 2), (4, 2), (2, 6)):
            encs = [7, 16, 1, 0, -32 + quality, -256 + compress, -223, -224]  # Tight, ZRLE, CopyRect, Raw, pseudo
            await ws.send(struct.pack(">BxH", 2, len(encs)) + b"".join(struct.pack(">i", e) for e in encs))
            await asyncio.sleep(0.2)
            res = []
            for _ in range(4):
                ms, b = await frame(0)
                res.append((ms, b))
            out[f"q{quality}_c{compress}"] = {"full_frame_bytes": res[-1][1],
                                              "time_to_last_byte_ms": stats([r[0] for r in res[1:]])}
    return out


@section("live_desktop")
def bench_live(api, agent: dict) -> dict:
    out = {}
    t = time.perf_counter()
    s = api.post(f"/api/v1/agents/{agent['id']}/live/connect")
    out["connect_api_ms"] = round((time.perf_counter() - t) * 1000, 1)
    cookie = "; ".join(f"{k}={v}" for k, v in api.c.cookies.items())
    sid = s.get("session_id") or s.get("id")
    ws_url = s.get("ws_url") or f"/api/v1/live/ws/{sid}?token={s['token']}"
    if ws_url.startswith("/"):
        ws_url = f"ws://127.0.0.1:{e2e.PORT}" + ws_url
    try:
        out.update(asyncio.run(rfb_bench(ws_url, cookie)))
        # second session: encodings as noVNC requests them, on a content-rich page
        s2 = api.post(f"/api/v1/agents/{agent['id']}/live/connect")
        sid2 = s2.get("session_id") or s2.get("id")
        try:
            out["encodings"] = asyncio.run(rfb_encodings(f"ws://127.0.0.1:{e2e.PORT}/api/v1/live/ws/{sid2}?token={s2['token']}",
                                                         cookie))
        finally:
            api.delete(f"/api/v1/live/sessions/{sid2}")
    finally:
        try:
            api.delete(f"/api/v1/live/sessions/{sid}")
        except Exception as e:  # noqa: BLE001
            out["disconnect_error"] = str(e)
    time.sleep(1)
    out["active_streams_after"] = len(api.get("/api/v1/live/sessions")["active_streams"])
    return out


# ----------------------------------------------------------------------------------------------- DB
@section("db_queries")
def bench_db() -> dict:
    import shutil
    import sqlite3
    import tempfile

    src = e2e.DATA / "nebula.db"
    tmp = Path(tempfile.mkdtemp(prefix="nebula-perf-")) / "copy.db"
    con = sqlite3.connect(f"file:{src}?mode=ro", uri=True)
    dst = sqlite3.connect(tmp)
    con.backup(dst)
    con.close()
    q = {
        "queued_tasks": "select id, agent_id, execution from tasks where state='QUEUED' order by priority desc, created_at",
        "running_tasks": "select id, state from tasks where state in ('PLANNING','EXECUTING','VERIFYING','PAUSING')",
        "agent_tasks_recent": "select * from tasks where agent_id=(select id from agents limit 1) order by created_at desc limit 50",
        "messages_agent": "select * from messages where agent_id=(select id from agents limit 1) order by created_at desc limit 100",
        "events_max_seq": "select max(sequence) from events",
        "events_since": "select * from events where sequence > (select max(sequence)-200 from events) order by sequence",
        "task_steps_task": "select * from task_steps where task_id=(select id from tasks order by created_at desc limit 1) order by seq",
        "checkpoint_latest": "select * from task_checkpoints where task_id=(select id from tasks order by created_at desc limit 1) order by version desc limit 1",
        "audit_recent": "select * from audit_events order by ts desc limit 100",
        "resource_history_1h": "select * from resource_samples where ts >= strftime('%s','now')-3600 order by ts",
        "approvals_pending": "select * from approvals where decision is null",
    }
    out = {}
    for k, sql in q.items():
        try:
            out[k], _ = timed(lambda s=sql: dst.execute(s).fetchall(), 30, 2)
            plan = dst.execute("explain query plan " + sql).fetchall()
            out[k]["plan"] = "; ".join(str(r[-1]) for r in plan)[:240]
        except sqlite3.Error as e:
            out[k] = {"error": str(e)}
    out["_sizes"] = dict(dst.execute(
        "select 'events', count(*) from events union all select 'audit', count(*) from audit_events union all "
        "select 'resource_samples', count(*) from resource_samples union all select 'task_steps', count(*) from "
        "task_steps union all select 'messages', count(*) from messages").fetchall())
    dst.close()
    shutil.rmtree(tmp.parent, ignore_errors=True)
    return out


# ----------------------------------------------------------------------------------------------- main
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", default="baseline")
    ap.add_argument("--port", type=int, default=e2e.PORT)
    ap.add_argument("--agent", default=os.environ.get("NEBULA_E2E_AGENT", "E2E Agent"), help="test agent used for VM/live/sleep-wake measurements (env NEBULA_E2E_AGENT)")
    ap.add_argument("--skip", default="", help="comma separated sections to skip")
    ap.add_argument("--live-url", default="https://en.wikipedia.org/wiki/Mac_mini",
                    help="page opened in the test agent's browser before the Live Desktop measurements ('' = none)")
    a = ap.parse_args()
    skip = set(filter(None, a.skip.split(",")))
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    api = e2e.Api(a.port)
    api.login_or_setup()
    RES["label"] = a.label
    RES["version"] = api.get("/api/v1/health").get("version")
    if "system" not in skip:
        bench_system()
    if "host_resources_cost" not in skip:
        bench_host_resources()
    if "api" not in skip:
        bench_api(api)
    if "static" not in skip:
        bench_static(api)
    if "sse" not in skip:
        bench_sse(api)
    if "chat" not in skip:
        bench_chat(api)
    agent = pick_agent(api, a.agent)
    if "wake" not in skip:
        bench_wake(api, agent)
    if "vm" not in skip:
        bench_vm(api, agent)
    if "live" not in skip:
        if a.live_url:  # same content for every run: a content-rich page in the test agent's browser
            from nebula_host import secrets as sec
            from nebula_host.config import load_config
            from nebula_host.guest import GuestClient
            from nebula_setup.installer import guest_key

            sec.init_store("keychain")
            gc = GuestClient(load_config().run_dir / "vm", guest_key)
            nav = asyncio.run(gc.tool(agent["id"], "browser.navigate", {"url": a.live_url}, timeout=60))
            RES["live_page"] = {"url": a.live_url, "ok": nav.get("ok")}
            time.sleep(2)
        bench_live(api, agent)
    if "db" not in skip:
        bench_db()
    RES["finished"] = time.strftime("%Y-%m-%d %H:%M:%S")
    out = OUT_DIR / f"{a.label}.json"
    out.write_text(json.dumps(RES, indent=1, default=str))
    print("wrote", out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
