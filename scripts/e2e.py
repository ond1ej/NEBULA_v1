#!/usr/bin/env python3
"""Hardware E2E matrix (spec §14.2) against the REAL installed NEBULA on this Mac.

Talks to the running host service over HTTP/WebSocket exactly like the dashboard does, and uses the
guest RPC/SSH only to collect independent evidence (Linux users, displays, profiles). Writes
build/e2e/report.json and build/e2e/artifacts/ (real screenshots; render the report with scripts/e2e_report.py) (real screenshots).

Statuses: PASS | FAIL | BLOCKED_BY_CREDENTIALS | NOT_VERIFIED_ON_HARDWARE
"""

from __future__ import annotations

import argparse
import asyncio
import io
import json
import os
import platform
import secrets
import struct
import subprocess
import sys
import time
import traceback
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / p) for p in ("apps/host-api", "apps/setup", "packages/contracts", "packages/agent-runtime",
                                        "packages/provider-adapters", "packages/telegram-gateway", "packages/live-broker")]
from nebula_host.config import default_data_dir, load_config  # noqa: E402

OUT = ROOT / "build/e2e"
ART = ROOT / "build/e2e/artifacts"
DATA = default_data_dir()  # NEBULA_DATA_DIR, else the data dir of NEBULA_INSTANCE (default instance)
PORT = load_config(data_dir=DATA).instance.port  # dashboard/API port of the instance under test (NEBULA_PORT wins)
GW_PORT = PORT + 2  # Mini App gateway default: dashboard port + 2
RESULTS: list[dict] = []


def record(eid: str, title: str, status: str, evidence: dict | str, started: float) -> None:
    RESULTS.append({"id": eid, "title": title, "status": status, "evidence": evidence,
                    "duration_s": round(time.time() - started, 1)})
    print(f"[{status}] {eid} {title}: {json.dumps(evidence, default=str)[:300]}", flush=True)


class Api:
    def __init__(self, port: int) -> None:
        self.base = f"http://127.0.0.1:{port}"
        self.origin = self.base
        self.c = httpx.Client(base_url=self.base, timeout=240, headers={"Origin": self.origin})
        self.csrf = ""

    def login_or_setup(self) -> str:
        st = self.c.get("/api/v1/auth/state").json()["data"]
        cred = DATA / "run" / "initial-admin-password"
        if not st["initialized"]:
            tok = (DATA / "run" / "setup-token").read_text().strip()
            pw = secrets.token_urlsafe(18)
            fd = os.open(cred, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            os.write(fd, f"username=owner\npassword={pw}\n".encode())
            os.close(fd)
            r = self.c.post("/api/v1/auth/setup", json={"username": "owner", "password": pw, "setup_token": tok})
            r.raise_for_status()
            self.csrf = r.json()["data"]["csrf_token"]
            return "created admin 'owner' (password in data dir run/initial-admin-password, mode 0600)"
        kv = dict(line.split("=", 1) for line in cred.read_text().split())
        r = self.c.post("/api/v1/auth/login", json={"username": kv["username"], "password": kv["password"]})
        r.raise_for_status()
        self.csrf = r.json()["data"]["csrf_token"]
        return "logged in"

    def _h(self, extra=None):
        return {"x-csrf-token": self.csrf, **(extra or {})}

    def get(self, path, **kw):
        r = self.c.get(path, **kw)
        r.raise_for_status()
        return r.json()["data"] if r.headers.get("content-type", "").startswith("application/json") else r

    def post(self, path, json_=None, ok=(200, 201, 202), **kw):
        r = self.c.post(path, json=json_, headers=self._h(kw.pop("headers", None)), **kw)
        if r.status_code not in ok:
            raise RuntimeError(f"POST {path} -> {r.status_code} {r.text[:400]}")
        return r.json()["data"]

    def delete(self, path, **kw):
        r = self.c.delete(path, headers=self._h(), **kw)
        if r.status_code >= 300:
            raise RuntimeError(f"DELETE {path} -> {r.status_code} {r.text[:400]}")
        return r.json()["data"]

    def patch(self, path, json_):
        r = self.c.patch(path, json=json_, headers=self._h())
        r.raise_for_status()
        return r.json()["data"]

    def wait_task(self, tid, states, timeout=300):
        end = time.time() + timeout
        t = {}
        while time.time() < end:
            t = self.get(f"/api/v1/tasks/{tid}")
            if t["state"] in states:
                return t
            time.sleep(1)
        raise TimeoutError(f"task {tid} stuck in {t.get('state')}")


def ssh(cmd: str) -> str:
    from nebula_host.config import load_config
    from nebula_host.vm import VMManager

    vm = VMManager(load_config())
    ip = vm.guest_ip()
    return vm.ssh(ip, cmd, timeout=60).stdout


def png_stats(png: bytes) -> dict:
    from PIL import Image

    im = Image.open(io.BytesIO(png)).convert("RGB")
    ex = im.convert("L").getextrema()
    colors = len(im.resize((160, 100)).getcolors(20000) or [])
    return {"size": im.size, "luma_range": ex, "distinct_colors_160x100": colors}


def save(name: str, data: bytes) -> str:
    ART.mkdir(parents=True, exist_ok=True)
    (ART / name).write_bytes(data)
    return f"build/e2e/artifacts/{name}"


# ---------------------------------------------------------------- RFB viewer through the real WS proxy
async def rfb_view(api: Api, sid: str, token: str, *, frames: int = 1, send_pointer: tuple | None = None,
                   interval: float = 0.0) -> dict:
    import websockets

    url = f"ws://127.0.0.1:{api.base.rsplit(':', 1)[1]}/api/v1/live/ws/{sid}?token={token}"
    cookie = "; ".join(f"{k}={v}" for k, v in api.c.cookies.items())
    out: dict = {"bytes": 0}
    async with websockets.connect(url, subprotocols=["binary"], additional_headers={"Cookie": cookie, "Origin": api.origin},
                                  max_size=None) as ws:
        buf = bytearray()

        async def need(n):
            while len(buf) < n:
                m = await asyncio.wait_for(ws.recv(), 20)
                buf.extend(m if isinstance(m, bytes) else m.encode())
                out["bytes"] += len(m)
            d = bytes(buf[:n])
            del buf[:n]
            return d

        ver = await need(12)
        out["server_version"] = ver.decode().strip()
        await ws.send(b"RFB 003.008\n")
        n = (await need(1))[0]
        types = list(await need(n))
        out["security_types"] = types
        await ws.send(bytes([1]))
        res = struct.unpack(">I", await need(4))[0]
        out["security_result"] = res
        await ws.send(bytes([1]))  # shared
        w, h = struct.unpack(">HH", await need(4))
        pf = await need(16)
        name_len = struct.unpack(">I", await need(4))[0]
        out["desktop_name"] = (await need(name_len)).decode(errors="replace")
        out["geometry"] = [w, h]
        bpp = pf[0]
        # 32bpp true colour little endian, raw encoding only
        await ws.send(struct.pack(">BxxxBBBBHHHBBBxxx", 0, 32, 24, 0, 1, 255, 255, 255, 16, 8, 0))
        await ws.send(struct.pack(">BxH", 2, 1) + struct.pack(">i", 0))
        if send_pointer:
            x, y = send_pointer
            await ws.send(struct.pack(">BBHH", 5, 0, x, y))
        from PIL import Image

        img = Image.new("RGB", (w, h))
        got = 0
        t0 = time.time()
        while got < frames:
            if interval and got:
                await asyncio.sleep(interval)
            await ws.send(struct.pack(">BBHHHH", 3, 0, 0, 0, w, h))  # full (non-incremental) frame each time
            while True:
                mt = (await need(1))[0]
                if mt == 0:
                    break
                if mt == 2:  # bell
                    continue
                if mt == 3:
                    await need(3)
                    ln = struct.unpack(">I", await need(4))[0]
                    await need(ln)
                    continue
                if mt == 1:
                    await need(1)
                    _first, nc = struct.unpack(">HH", await need(4))
                    await need(nc * 6)
                    continue
                raise RuntimeError(f"unexpected server msg {mt}")
            await need(1)
            nrects = struct.unpack(">H", await need(2))[0]
            for _ in range(nrects):
                x, y, rw, rh, enc = struct.unpack(">HHHHi", await need(12))
                if enc != 0:
                    raise RuntimeError(f"unexpected encoding {enc}")
                raw = await need(rw * rh * 4)
                img.paste(Image.frombytes("RGB", (rw, rh), raw, "raw", "BGRX"), (x, y))
            got += 1
        out["frames"] = got
        out["fps_estimate"] = round(got / max(time.time() - t0, 0.001), 2)
        out["bpp_server_default"] = bpp
        b = io.BytesIO()
        img.save(b, "PNG")
        out["png"] = b.getvalue()
    return out


# ---------------------------------------------------------------- matrix
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=None)
    ap.add_argument("--model", default="qwen2.5:7b")
    ap.add_argument("--only", default="")
    a = ap.parse_args()
    from nebula_host.config import load_config

    cfg = load_config()
    port = a.port or cfg.instance.port
    OUT.mkdir(parents=True, exist_ok=True)
    api = Api(port)
    meta = {"host": f"{platform.node()} macOS {platform.mac_ver()[0]} {platform.machine()}",
            "ram_gb": int(subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True, text=True).stdout) // 2**30,
            "vm_profile": f"{cfg.vm.ram_mb} MB / {cfg.vm.cpu_count} vCPU / {cfg.vm.disk_gb_limit} GB sparse",
            "started": time.strftime("%Y-%m-%d %H:%M:%S"), "auth": api.login_or_setup(), "model": a.model}
    only = set(a.only.split(",")) if a.only else None
    ctx: dict = {}

    def step(eid, title, fn):
        if only and eid not in only:
            return
        t0 = time.time()
        try:
            status, ev = fn()
        except Exception as e:  # noqa: BLE001
            status, ev = "FAIL", {"error": f"{type(e).__name__}: {e}", "trace": traceback.format_exc()[-1500:]}
        record(eid, title, status, ev, t0)

    # E2E-01 --------------------------------------------------------------
    def e01():
        rep = json.loads((DATA / "install-report.json").read_text())
        h = api.get("/api/v1/health")
        ok = "error" not in rep and rep.get("health", {}).get("ok") and h["guest"]["status"] == "ok"
        return ("PASS" if ok else "FAIL"), {
            "install_report": {k: rep.get(k) for k in ("image_version", "verification", "vm", "security_finalization")},
            "health_check": {k: rep.get("health", {}).get(k) for k in ("rpc_latency_ms", "x_server", "screenshot", "browser")},
            "api_health": h}
    step("E2E-01", "Install from clean state", e01)

    # E2E-02 / 03 -----------------------------------------------------------
    for ag in api.get("/api/v1/agents"):
        ctx.setdefault(ag["name"], ag)

    def mk(name, eid):
        t0 = time.time()
        if name in ctx:
            ag = ctx[name]
        else:
            ag = api.post("/api/v1/agents", {"name": name, "provider_id": "ollama-local", "model_id": a.model,
                                         "permission_level": "ADVANCED"}, headers={"Idempotency-Key": secrets.token_hex(8)})
            ctx[name] = ag
        png = api.c.get(f"/api/v1/agents/{ag['id']}/screenshot").content
        st = png_stats(png)
        u = ag["guest_user"]
        guest = ssh(f"id {u}; sudo ls -ld /home/{u}/workspace /home/{u}/.nebula/browser-profile; "
                    f"systemctl is-active nebula-desktop@{u} nebula-tools@{u}; "
                    f"sudo cat /var/lib/nebula/agents/{u}/desktop.env | grep -E '^DISPLAY='; "
                    f"pgrep -u {u} -a Xvnc | cut -c1-160")
        ok = st["distinct_colors_160x100"] > 5 and "active" in guest and "uid=" in guest
        return ("PASS" if ok else "FAIL"), {"agent": {k: ag[k] for k in ("id", "state", "guest_user", "display_id")},
                                            "create_seconds": round(time.time() - t0, 1), "screenshot": st,
                                            "screenshot_file": save(f"{eid}-{name}-desktop.png", png),
                                            "guest_evidence": guest.strip().splitlines()}
    step("E2E-02", "Create Developer (Linux user, workspace, display, real screenshot)", lambda: mk("Developer", "E2E-02"))
    def e03():
        s, ev = mk("Researcher", "E2E-03")
        d, r = ctx["Developer"], ctx["Researcher"]
        diff = d["guest_user"] != r["guest_user"] and d["display_id"] != r["display_id"]
        perms = ssh(f"sudo -u {d['guest_user']} ls /home/{r['guest_user']} 2>&1 | head -1")
        ev["isolation"] = {"different_user_and_display": diff, "A_reads_B_home": perms.strip()}
        return ("PASS" if s == "PASS" and diff and "Permission denied" in perms else "FAIL"), ev
    step("E2E-03", "Create Researcher (different user, display, browser profile)", e03)

    # E2E-04 -----------------------------------------------------------------
    def e04():
        from nebula_host import secrets as sec
        from nebula_host.guest import GuestClient
        from nebula_setup.installer import guest_key

        sec.init_store("keychain")
        gc = GuestClient(cfg.run_dir / "vm", guest_key)
        d, r = ctx["Developer"], ctx["Researcher"]

        async def go():
            n1, n2 = await asyncio.gather(gc.tool(d["id"], "browser.navigate", {"url": "https://example.com"}),
                                          gc.tool(r["id"], "browser.navigate", {"url": "https://www.wikipedia.org"}))
            await asyncio.sleep(2)
            return n1, n2

        n1, n2 = asyncio.run(go())
        s1 = api.c.get(f"/api/v1/agents/{d['id']}/screenshot").content
        s2 = api.c.get(f"/api/v1/agents/{r['id']}/screenshot").content
        same = s1 == s2
        return ("PASS" if n1["ok"] and n2["ok"] and not same else "FAIL"), {
            "developer": n1.get("result"), "researcher": n2.get("result"), "screenshots_identical": same,
            "files": [save("E2E-04-developer-example.png", s1), save("E2E-04-researcher-wikipedia.png", s2)]}
    step("E2E-04", "Different URLs on concurrently running desktops", e04)

    # E2E-05 -----------------------------------------------------------------
    def e05():
        provs = {p["id"]: p for p in api.get("/api/v1/providers")}
        test = api.post("/api/v1/providers/ollama-local/test")
        if not test["state"].startswith("Connected"):
            return "BLOCKED_BY_CREDENTIALS", {"ollama": test}
        d = ctx["Developer"]
        t = api.post(f"/api/v1/agents/{d['id']}/tasks", {"prompt": "Open https://example.com in your browser, read the "
                     "page, then write its main heading into the file heading.txt in your workspace. Finish with "
                     "task_complete listing heading.txt as an artifact.", "max_steps": 12})
        ctx["e05_task"] = t["id"]
        t = api.wait_task(t["id"], {"COMPLETED", "FAILED", "WAITING_PROVIDER", "CANCELLED"}, timeout=600)
        tools = [s["tool_type"] for s in t["steps"]]
        shot = next((s["screenshot_ref"] for s in reversed(t["steps"]) if s["screenshot_ref"]), None)
        files = []
        if shot:
            files.append(save("E2E-05-task-step.png", api.c.get(f"/api/v1/artifacts/{shot}").content))
        content = ssh(f"sudo cat /home/{d['guest_user']}/workspace/heading.txt 2>&1")
        ok = t["state"] == "COMPLETED" and "browser_navigate" in tools
        return ("PASS" if ok else "FAIL"), {"state": t["state"], "tools": tools, "result": t.get("result"),
                                            "failure_reason": t.get("failure_reason"),
                                            "heading_txt_in_guest": content.strip()[:200], "files": files,
                                            "provider": provs["ollama-local"]["state"]}
    step("E2E-05", "AI task: real provider calls visible browser/shell tools", e05)

    # E2E-06/07 --------------------------------------------------------------
    def e06():
        d = ctx["Developer"]
        before = api.get("/api/v1/live/sessions")["active_streams"]
        bridges_before = json.loads(subprocess.run([str(DATA / "bin/nebula-vm"), "status", "--bundle",
                                                    str(DATA / "vm/shared")], capture_output=True, text=True).stdout).get("active_bridges")
        live = api.post(f"/api/v1/agents/{d['id']}/live/connect")
        mid = api.get("/api/v1/live/sessions")["active_streams"]
        v = asyncio.run(rfb_view(api, live["session_id"], live["token"], frames=3))
        f = save("E2E-06-live-frame.png", v.pop("png"))
        ctx["live_png"] = f
        ok = before == [] and mid == [] and v["frames"] >= 1 and v["security_result"] == 0
        return ("PASS" if ok else "FAIL"), {"streams_before_connect": before, "vsock_bridges_before": bridges_before,
                                            "streams_after_connect_before_ws": mid, "rfb": v, "frame_file": f}
    step("E2E-06", "Live Connect: no video before Connect, real frames after", e06)

    def e07():
        d = ctx["Developer"]
        t = api.post(f"/api/v1/agents/{d['id']}/tasks", {"prompt": "Run the shell command `sleep 20; date > done.txt` "
                     "in your workspace, then call task_complete with done.txt as artifact.", "max_steps": 8})
        live = api.post(f"/api/v1/agents/{d['id']}/live/connect")

        async def view_then_disconnect():
            task = asyncio.create_task(rfb_view(api, live["session_id"], live["token"], frames=200))
            await asyncio.sleep(4)
            streams = api.get("/api/v1/live/sessions")["active_streams"]
            r = await asyncio.to_thread(api.delete, f"/api/v1/live/sessions/{live['session_id']}")
            try:
                await asyncio.wait_for(task, 10)
                closed = "frames finished"
            except Exception as e:  # noqa: BLE001
                closed = f"websocket closed: {type(e).__name__}"
            return streams, r, closed

        streams, r, closed = asyncio.run(view_then_disconnect())
        after = api.get("/api/v1/live/sessions")["active_streams"]
        bridges = json.loads(subprocess.run([str(DATA / "bin/nebula-vm"), "status", "--bundle", str(DATA / "vm/shared")],
                                            capture_output=True, text=True).stdout).get("active_bridges")
        mid_state = api.get(f"/api/v1/tasks/{t['id']}")["state"]
        final = api.wait_task(t["id"], {"COMPLETED", "FAILED", "CANCELLED", "WAITING_PROVIDER"}, timeout=400)
        ok = streams and after == [] and r["state"] == "DISCONNECTED" and final["state"] == "COMPLETED"
        return ("PASS" if ok else "FAIL"), {"streams_while_viewing": streams, "disconnect": r, "ws": closed,
                                            "streams_after": after, "vsock_bridges_after": bridges,
                                            "task_state_right_after_disconnect": mid_state,
                                            "task_final": final["state"], "failure_reason": final.get("failure_reason")}
    step("E2E-07", "Disconnect ends the stream; the AI task continues", e07)

    # E2E-08 -----------------------------------------------------------------
    def e08():
        r = ctx["Researcher"]
        live = api.post(f"/api/v1/agents/{r['id']}/live/connect")

        async def scenario():
            viewer = asyncio.create_task(rfb_view(api, live["session_id"], live["token"], frames=100000, interval=0.5))
            await asyncio.sleep(2)
            lease = await asyncio.to_thread(api.post, f"/api/v1/live/sessions/{live['session_id']}/control",
                                            {"action": "acquire"})
            t = await asyncio.to_thread(api.post, f"/api/v1/agents/{r['id']}/tasks",
                                        {"prompt": "Open https://example.org in the browser and then call task_complete "
                                                   "with the url as artifact.", "max_steps": 8})
            waited = None
            for _ in range(240):
                st = (await asyncio.to_thread(api.get, f"/api/v1/tasks/{t['id']}"))
                if st["state"] == "WAITING_CONTROL":
                    waited = st
                    break
                if st["state"] in ("COMPLETED", "FAILED"):
                    break
                await asyncio.sleep(0.5)
            steps_during = [s["tool_type"] for s in (waited or st)["steps"]]
            await asyncio.sleep(3)
            still = (await asyncio.to_thread(api.get, f"/api/v1/tasks/{t['id']}"))
            rel = await asyncio.to_thread(api.post, f"/api/v1/live/sessions/{live['session_id']}/control",
                                          {"action": "release"})
            final = await asyncio.to_thread(api.wait_task, t["id"], {"COMPLETED", "FAILED", "WAITING_PROVIDER"}, 400)
            viewer.cancel()
            await asyncio.to_thread(api.delete, f"/api/v1/live/sessions/{live['session_id']}")
            return lease, waited, steps_during, still, rel, final

        lease, waited, steps_during, still, rel, final = asyncio.run(scenario())
        gui_during = [s for s in steps_during if s.startswith(("browser_", "desktop_click", "desktop_type"))]
        ok = lease["control"] and waited is not None and still["state"] == "WAITING_CONTROL" and not gui_during \
            and final["state"] == "COMPLETED"
        return ("PASS" if ok else "FAIL"), {"lease": lease, "task_waited_for_control": bool(waited),
                                            "gui_steps_while_user_had_control": gui_during, "release": rel,
                                            "final": final["state"], "steps_after": [s["tool_type"] for s in final["steps"]],
                                            "failure_reason": final.get("failure_reason")}
    step("E2E-08", "Take Control: agent does not click; Release + re-observation", e08)

    # E2E-09 -----------------------------------------------------------------
    def e09():
        d = ctx["Developer"]
        t = api.post(f"/api/v1/agents/{d['id']}/tasks", {"prompt": "Do these steps one at a time: 1) write 'one' to "
                     "p1.txt 2) run `sleep 8` 3) write 'two' to p2.txt 4) write 'three' to p3.txt. Then task_complete "
                     "with p3.txt as artifact.", "max_steps": 12})
        for _ in range(240):
            cur = api.get(f"/api/v1/tasks/{t['id']}")
            if cur["tool_calls_done"] >= 1:
                break
            time.sleep(0.5)
        api.post(f"/api/v1/tasks/{t['id']}/pause", {"mode": "smart"})
        p = api.wait_task(t["id"], {"PAUSED", "COMPLETED", "FAILED"}, timeout=300)
        n1 = p["tool_calls_done"]
        time.sleep(10)
        n2 = api.get(f"/api/v1/tasks/{t['id']}")["tool_calls_done"]
        api.post(f"/api/v1/tasks/{t['id']}/resume")
        f = api.wait_task(t["id"], {"COMPLETED", "FAILED", "WAITING_PROVIDER"}, timeout=600)
        writes = [s for s in f["steps"] if s["tool_type"] == "files_write"]
        paths = [s["args_sanitized"].get("path") for s in writes]
        dup = len(paths) != len(set(paths))
        ok = p["state"] == "PAUSED" and n1 == n2 and p["checkpoint_id"] and f["state"] == "COMPLETED"
        return ("PASS" if ok else "FAIL"), {"paused_state": p["state"], "tool_calls_at_pause": n1,
                                            "tool_calls_10s_later": n2, "checkpoint_id": p["checkpoint_id"],
                                            "final": f["state"], "files_written": paths, "duplicate_writes": dup,
                                            "failure_reason": f.get("failure_reason")}
    step("E2E-09", "Smart Pause: PAUSED, 0 tool calls, Resume from checkpoint", e09)

    # E2E-10..12 Telegram -----------------------------------------------------
    tg = api.get("/api/v1/telegram")
    for eid, title in (("E2E-10", "Telegram pairing"), ("E2E-11", "Telegram multi-agent routing"),
                       ("E2E-12", "Telegram screenshot")):
        if only and eid not in only:
            continue
        if not tg["configured"] or not any(u["status"] == "approved" for u in tg["users"]):
            record(eid, title, "BLOCKED_BY_CREDENTIALS", {"reason": "no BotFather token / paired Telegram account on this "
                                                                    "machine; gateway verified against fake Bot API in "
                                                                    "tests/integration/test_telegram.py"}, time.time())
        else:
            record(eid, title, "NOT_VERIFIED_ON_HARDWARE", {"reason": "requires a human to send Telegram messages"},
                   time.time())

    # E2E-14 -----------------------------------------------------------------
    def e14():
        c = ctx.get("Third") or api.post("/api/v1/agents", {"name": "Third", "provider_id": "ollama-local",
                                                            "model_id": a.model, "permission_level": "ADVANCED"})
        ctx["Third"] = c
        ids = [ctx["Developer"]["id"], ctx["Researcher"]["id"], c["id"]]
        tasks = [api.post(f"/api/v1/agents/{i}/tasks", {"prompt": "Run `sleep 25` in the shell, then task_complete "
                                                                  "(no artifacts needed).", "max_steps": 6})
                 for i in ids]
        snap = []
        for _ in range(60):
            states = [api.get(f"/api/v1/tasks/{t['id']}")["state"] for t in tasks]
            snap.append(states)
            running = sum(s not in ("QUEUED", "COMPLETED", "FAILED") for s in states)
            if running >= 2 and states.count("QUEUED") == 1:
                break
            time.sleep(1)
        sysinfo = api.get("/api/v1/system")
        finals = [api.wait_task(t["id"], {"COMPLETED", "FAILED", "WAITING_PROVIDER"}, 600)["state"] for t in tasks]
        ok = any(s.count("QUEUED") == 1 and sum(x not in ("QUEUED", "COMPLETED", "FAILED") for x in s) == 2 for s in snap)
        return ("PASS" if ok else "FAIL"), {"limit": sysinfo["limits"], "state_snapshots": snap[-5:],
                                            "memory": {k: sysinfo["host"][k] for k in ("memory_pressure",
                                                                                      "memory_free_percent",
                                                                                      "vm_resident_bytes")},
                                            "guest_mem_available": sysinfo["guest"].get("mem"), "final": finals}
    step("E2E-14", "3rd active agent is queued (limit 2 on 16 GB)", e14)

    # E2E-13 -----------------------------------------------------------------
    def e13():
        from nebula_setup import launchd

        before = {"agents": sorted((x["id"], x["guest_user"]) for x in api.get("/api/v1/agents")),
                  "providers": {p["id"]: p["state"] for p in api.get("/api/v1/providers")},
                  "telegram_topics": api.get("/api/v1/telegram")["topics"],
                  "tasks": len(api.get("/api/v1/tasks?limit=500"))}
        st0 = launchd.status()
        if not st0.get("loaded"):
            return "FAIL", {"error": "host service is not running under the LaunchAgent", "launchd": st0}
        pid0 = st0["pid"]
        api.post("/api/v1/system/services/restart")
        t0 = time.time()
        pid1 = None
        while time.time() - t0 < 90:
            time.sleep(2)
            try:
                st = launchd.status()
                if st.get("pid") and st["pid"] != pid0 and httpx.get(f"{api.base}/api/v1/health", timeout=3).status_code == 200:
                    pid1 = st["pid"]
                    break
            except Exception:  # noqa: BLE001
                pass
        restart_s = round(time.time() - t0, 1)
        # crash case: SIGKILL -> launchd KeepAlive restarts it
        os.kill(pid1, 9)
        t1 = time.time()
        pid2 = None
        while time.time() - t1 < 90:
            time.sleep(2)
            try:
                st = launchd.status()
                if st.get("pid") and st["pid"] != pid1 and httpx.get(f"{api.base}/api/v1/health", timeout=3).status_code == 200:
                    pid2 = st["pid"]
                    break
            except Exception:  # noqa: BLE001
                pass
        crash_s = round(time.time() - t1, 1)
        api.c.cookies.clear()
        api.login_or_setup()
        after = {"agents": sorted((x["id"], x["guest_user"]) for x in api.get("/api/v1/agents")),
                 "providers": {p["id"]: p["state"] for p in api.get("/api/v1/providers")},
                 "telegram_topics": api.get("/api/v1/telegram")["topics"],
                 "tasks": len(api.get("/api/v1/tasks?limit=500"))}
        shots = {}
        for ag in api.get("/api/v1/agents"):
            r = api.c.get(f"/api/v1/agents/{ag['id']}/screenshot")
            shots[ag["name"]] = r.status_code == 200 and png_stats(r.content)["distinct_colors_160x100"] > 5
        health = api.get("/api/v1/health")
        ok = pid1 and pid2 and before == after and all(shots.values()) and health["guest"]["status"] == "ok"
        return ("PASS" if ok else "FAIL"), {"pids": [pid0, pid1, pid2], "graceful_restart_s": restart_s,
                                            "crash_restart_s": crash_s, "state_equal_after_restarts": before == after,
                                            "before": before, "after": after, "desktops_after": shots,
                                            "health": health}
    step("E2E-13", "Restart host services (graceful + crash): state restored", e13)

    meta["finished"] = time.strftime("%Y-%m-%d %H:%M:%S")
    rep = {"meta": meta, "results": RESULTS}
    prev = OUT / "report.json"
    if prev.exists() and only:
        old = json.loads(prev.read_text())
        keep = [r for r in old["results"] if r["id"] not in {x["id"] for x in RESULTS}]
        rep["results"] = sorted(keep + RESULTS, key=lambda r: r["id"])
    prev.write_text(json.dumps(rep, indent=2, default=str))
    print(json.dumps({r["id"]: r["status"] for r in rep["results"]}, indent=1))
    return 0 if all(r["status"] != "FAIL" for r in RESULTS) else 1


if __name__ == "__main__":
    sys.exit(main())
