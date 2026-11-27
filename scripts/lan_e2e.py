#!/usr/bin/env python3
"""Real LAN-access E2E against the installed NEBULA — no AI requests.

Enables LAN access through the API (as the Settings page does), then exercises the dashboard API over the Mac's LAN
address exactly like a second device would: login, CSRF, agents, providers, task submission (agent paused, so no
model is called), SSE, Live Desktop over WebSocket (RFB frames), Take Control, Pause/Resume, optional HTTPS with the
local CA, and verifies that the agents' VM cannot reach the dashboard. Writes build/e2e/lan-e2e.json.
"""

from __future__ import annotations

import asyncio
import json
import os
import socket
import ssl
import sys
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path[:0] = [str(ROOT / p) for p in ("apps/host-api", "apps/setup", "packages/contracts", "packages/provider-adapters")]
import e2e  # noqa: E402

DATA = e2e.DATA  # the instance under test (NEBULA_DATA_DIR / NEBULA_INSTANCE)
OUT = ROOT / "build/e2e/lan-e2e.json"
RES: dict = {}


def rec(key, ok, **ev):
    RES[key] = {"ok": bool(ok), **ev}
    print(("PASS " if ok else "FAIL ") + key, json.dumps(ev, default=str)[:300], flush=True)


class LanApi(e2e.Api):
    def __init__(self, base: str, verify=True) -> None:
        self.base = base
        self.origin = base
        self.c = httpx.Client(base_url=base, timeout=60, headers={"Origin": base}, verify=verify)
        self.csrf = ""


def lan_ip() -> str:
    from nebula_host.lan import lan_interfaces

    return lan_interfaces(force=True)[0]["ip"]


def guest_ssh(cmd: str) -> str:
    from nebula_host.config import load_config
    from nebula_host.vm import VMManager

    vm = VMManager(load_config())
    return vm.ssh(vm.guest_ip(), cmd, timeout=60).stdout.strip()


def main() -> int:
    local = e2e.Api(e2e.PORT)
    local.login_or_setup()
    ip = lan_ip()
    base = f"http://{ip}:{e2e.PORT}"
    RES["lan_ip"] = ip

    st = local.post("/api/v1/system/lan", {"enabled": True, "https": False})
    time.sleep(1.5)
    rec("enable_via_settings_api", st["enabled"] and any(x["running"] for x in st["listening"]),
        listening=st["listening"], addresses=st["addresses"])

    r = httpx.get(f"{base}/api/v1/health", timeout=10)
    rec("lan_http_health", r.status_code == 200, status=r.status_code, guest=r.json()["data"]["guest"]["status"])
    r = httpx.get(f"http://127.0.0.1:{e2e.PORT}/api/v1/health", timeout=10)
    rec("loopback_still_works", r.status_code == 200, status=r.status_code)
    r = httpx.get(f"{base}/api/v1/health", headers={"Host": f"attacker.example:{e2e.PORT}"}, timeout=10)
    rec("lan_dns_rebinding_blocked", r.status_code == 403, status=r.status_code, code=r.json()["error"]["code"])
    r = httpx.get(f"{base}/", timeout=10)
    rec("lan_dashboard_html", r.status_code == 200 and "<div id=" in r.text, status=r.status_code,
        csp=r.headers.get("content-security-policy", "")[:160])

    api = LanApi(base)
    unauth = api.c.get("/api/v1/agents").status_code
    api.login_or_setup()
    cookie = next((c for c in api.c.cookies.jar), None)
    rec("lan_login_cookie_csrf", unauth == 401 and bool(api.csrf) and cookie is not None,
        unauth_status=unauth, cookie_domain=getattr(cookie, "domain", None), secure=getattr(cookie, "secure", None))
    bad = api.c.post("/api/v1/agents", json={"name": "x"}, headers={"x-csrf-token": "wrong"})
    rec("lan_csrf_enforced", bad.status_code == 403, status=bad.status_code, code=bad.json()["error"]["code"])
    xo = api.c.post("/api/v1/agents", json={"name": "x"}, headers={"x-csrf-token": api.csrf, "Origin": "http://evil.example"})
    rec("lan_cross_origin_blocked", xo.status_code == 403, status=xo.status_code, code=xo.json()["error"]["code"])

    agents = api.get("/api/v1/agents")
    provs = api.get("/api/v1/providers")
    rec("lan_agents_and_providers", len(agents) > 0 and len(provs) > 0, agents=[a["name"] for a in agents],
        providers={p["id"]: p["state"] for p in provs if p["state"].startswith("Connected")})
    siwc = api.c.post("/api/v1/providers/openai-siwc/connect", headers={"x-csrf-token": api.csrf})
    rec("lan_siwc_requires_mac", siwc.status_code == 409, status=siwc.status_code, code=siwc.json()["error"]["code"])

    # pick a sleeping agent, wake it (no AI), use it for live/pause/task tests
    ag = next(a for a in agents if a["name"] == os.environ.get("NEBULA_E2E_AGENT", "E2E Agent"))
    api.post(f"/api/v1/agents/{ag['id']}/wake")
    events: list = []

    async def sse_listen(stop: asyncio.Event):
        cookie_hdr = "; ".join(f"{k}={v}" for k, v in api.c.cookies.items())
        async with httpx.AsyncClient(base_url=base, timeout=httpx.Timeout(10, read=None)) as c, \
                c.stream("GET", "/api/v1/events", headers={"Cookie": cookie_hdr}) as resp:
            async for line in resp.aiter_lines():
                if line.startswith("event:"):
                    events.append(line[6:].strip())
                if stop.is_set():
                    break

    async def scenario():
        stop = asyncio.Event()
        sse = asyncio.create_task(sse_listen(stop))
        await asyncio.sleep(1)
        # Pause / Resume (agent level) + task submission while paused: queued, no model call
        p1 = await asyncio.to_thread(api.post, f"/api/v1/agents/{ag['id']}/pause")
        t = await asyncio.to_thread(api.post, f"/api/v1/agents/{ag['id']}/tasks", {"prompt": "LAN test task (not run)",
                                                                                   "max_steps": 1})
        await asyncio.sleep(2.5)
        queued = await asyncio.to_thread(api.get, f"/api/v1/tasks/{t['id']}")
        msgs = await asyncio.to_thread(api.get, f"/api/v1/agents/{ag['id']}/messages")
        stopped = await asyncio.to_thread(api.post, f"/api/v1/tasks/{t['id']}/stop", {"mode": "cancel"})
        p2 = await asyncio.to_thread(api.post, f"/api/v1/agents/{ag['id']}/resume")
        # Live Desktop over LAN WebSocket
        live = await asyncio.to_thread(api.post, f"/api/v1/agents/{ag['id']}/live/connect")
        viewer = asyncio.create_task(e2e.rfb_view(api, live["session_id"], live["token"], frames=100000, interval=0.5))
        await asyncio.sleep(3)
        streams = (await asyncio.to_thread(api.get, "/api/v1/live/sessions"))["active_streams"]
        lease = await asyncio.to_thread(api.post, f"/api/v1/live/sessions/{live['session_id']}/control", {"action": "acquire"})
        rel = await asyncio.to_thread(api.post, f"/api/v1/live/sessions/{live['session_id']}/control", {"action": "release"})
        disc = await asyncio.to_thread(api.delete, f"/api/v1/live/sessions/{live['session_id']}")
        try:
            v = await asyncio.wait_for(viewer, 10)
        except Exception as e:  # noqa: BLE001 - viewer ends when the server closes the socket
            v = {"closed": type(e).__name__}
        after = (await asyncio.to_thread(api.get, "/api/v1/live/sessions"))["active_streams"]
        await asyncio.sleep(1.5)
        stop.set()
        sse.cancel()
        return p1, t, queued, msgs, stopped, p2, live, streams, lease, rel, disc, v, after

    p1, t, queued, msgs, stopped, p2, live, streams, lease, rel, disc, v, after = asyncio.run(scenario())
    rec("lan_pause_resume", p1["state"] == "PAUSED" and p2["state"] in ("READY", "ACTIVE"), paused=p1["state"],
        resumed=p2["state"])
    rec("lan_chat_task_submission", queued["state"] == "QUEUED" and any(m["content"] == "LAN test task (not run)" for m in msgs)
        and stopped["state"] == "CANCELLED", queued=queued["state"], cancelled=stopped["state"], model_calls=0)
    rec("lan_live_websocket", bool(streams) and lease["control"] and not rel["control"] and disc["state"] == "DISCONNECTED"
        and after == [], streams_while_viewing=len(streams), lease=lease["control"], released=not rel["control"],
        disconnected=disc["state"], streams_after=after, viewer=v if isinstance(v, dict) and "closed" in v else
        {k: v.get(k) for k in ("server_version", "geometry", "frames", "desktop_name")})
    rec("lan_sse_realtime", "agent.state.changed" in events and "live.viewer.joined" in events,
        events=sorted(set(events)))
    api.post(f"/api/v1/agents/{ag['id']}/sleep")

    # HTTPS with the local CA
    st = local.post("/api/v1/system/lan", {"enabled": True, "https": True})
    time.sleep(2)
    ca = DATA / "keys/lan_ca.crt"
    ctx = ssl.create_default_context(cafile=str(ca))
    hs = LanApi(f"https://{ip}:3443", verify=ctx)
    r = hs.c.get("/api/v1/health")
    hs.login_or_setup()
    sc = next((c for c in hs.c.cookies.jar), None)
    with socket.create_connection((ip, 3443), timeout=5) as raw, ctx.wrap_socket(raw, server_hostname=ip) as tls:
        version, peer = tls.version(), tls.getpeercert()
    rec("lan_https_local_ca", r.status_code == 200 and sc is not None and sc.secure and r.headers.get("strict-transport-security"),
        tls=version, san=peer.get("subjectAltName"), secure_cookie=getattr(sc, "secure", None), ca_sha256=st["ca"]["sha256"])
    try:
        httpx.get(f"https://{ip}:3443/api/v1/health", timeout=5)  # default trust store: must NOT trust it
        untrusted = "accepted (unexpected)"
    except httpx.ConnectError as e:
        untrusted = f"rejected: {str(e)[:80]}"
    rec("lan_https_untrusted_without_ca", untrusted.startswith("rejected"), result=untrusted)

    # The agents' VM must not reach the dashboard
    g1 = guest_ssh(f"curl -s -m 5 -o /dev/null -w '%{{http_code}}' http://{ip}:{e2e.PORT}/api/v1/health; echo")
    g2 = guest_ssh(f"curl -s -m 5 -o /dev/null -w '%{{http_code}}' http://192.168.64.1:{e2e.PORT}/api/v1/health; echo ' exit='$?")
    rec("vm_cannot_reach_dashboard", g1.strip() == "403" and g2.strip().startswith("000"), via_lan_ip=g1, via_vm_gateway=g2)

    # keep the owner's choice for the final state: HTTP + HTTPS enabled
    RES["final_status"] = local.get("/api/v1/system/lan")
    OUT.write_text(json.dumps(RES, indent=2, default=str))
    fails = [k for k, v in RES.items() if isinstance(v, dict) and v.get("ok") is False]
    print("FAILED:", fails if fails else "none")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
