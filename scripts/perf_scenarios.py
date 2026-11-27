#!/usr/bin/env python3
"""Realistic end-to-end scenarios after the performance pass, against the installed service, real Mac and real VM.

Default: NO AI inference and NO Telegram messages.
  E  Mini App: signed initData → agents → submit a task (probe agent) → status → Live Desktop take/release/disconnect
  F  Restart recovery: queued task survives a service restart exactly once; Telegram + SSE come back
  G  Memory-pressure drill: simulated critical defers new work, ending the drill resumes it automatically
  --with-ai   A (VM browser task, hard cap 2 model requests) + B (coding on the Mac, hard cap 3 model requests)
The probe agent ("Perf Probe", on the not-connected anthropic-api provider) gets work dispatched without any model
request leaving the Mac (the adapter stops at "API key not configured"); it is deleted at the end. Results:
build/e2e/perf-scenarios.json.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import subprocess
import sys
import time
import uuid
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import e2e  # noqa: E402
import e2e_common  # noqa: E402

E2E_AGENT = os.environ.get("NEBULA_E2E_AGENT", "E2E Agent")  # an existing test agent (never a real one)
LAUNCHD_LABEL = os.environ.get("NEBULA_LAUNCHD_LABEL") or e2e.load_config(data_dir=e2e.DATA).launchd_label

OUT = ROOT / "build/e2e/perf-scenarios.json"
RES: dict = {"started": time.strftime("%Y-%m-%d %H:%M:%S"), "results": {}, "ai_requests": 0}
GW = f"http://127.0.0.1:{e2e.GW_PORT}"
PROBE_MODEL = "perf-probe"


def rec(key: str, status: str, **ev) -> None:
    RES["results"][key] = {"status": status, **ev}
    print(f"[{status}] {key} {json.dumps(ev, default=str)[:400]}", flush=True)


def check(key: str, cond: bool, **ev) -> bool:
    rec(key, "PASS" if cond else "FAIL", **ev)
    return cond


def _ro():
    import sqlite3

    return sqlite3.connect(f"file:{e2e.DATA / 'nebula.db'}?mode=ro", uri=True)


def events_for(api, task_id: str, since: int) -> list[dict]:
    """The persisted event log for one task (read-only DB access; the SSE stream itself is tested elsewhere)."""
    con = _ro()
    try:
        rows = con.execute("select type, payload from events where task_id=? and sequence>? order by sequence",
                           (task_id, since)).fetchall()
    finally:
        con.close()
    return [{"type": t, "payload": json.loads(p or "{}")} for t, p in rows]


def last_seq(api) -> int:
    con = _ro()
    try:
        return con.execute("select coalesce(max(sequence),0) from events").fetchone()[0]
    finally:
        con.close()


def probe_agent(api) -> dict:
    for a in api.get("/api/v1/agents"):
        if a["name"] == "Perf Probe":
            return a
    t = time.time()
    a = api.post("/api/v1/agents", {"name": "Perf Probe", "provider_id": "anthropic-api", "model_id": PROBE_MODEL,
                                    "permission_level": "STANDARD"},
                 headers={"Idempotency-Key": str(uuid.uuid4())})
    rec("SETUP probe agent created", "PASS", seconds=round(time.time() - t, 1), state=a["state"])
    return a


def wait_task(api, tid, states, timeout=120):
    end = time.time() + timeout
    t = {}
    while time.time() < end:
        t = api.get(f"/api/v1/tasks/{tid}")
        if t["state"] in states:
            return t
        time.sleep(0.25)
    return t


# --------------------------------------------------------------------------------------------- G
def scenario_g(api, probe) -> None:
    seq = last_seq(api)
    r = api.post("/api/v1/resources/simulate", {"pressure": "critical", "minutes": 3})
    check("G drill active (critical)", r["effective_pressure"] == "critical", drill=r)
    t0 = time.time()
    t = api.post(f"/api/v1/agents/{probe['id']}/tasks", {"prompt": "pressure drill probe", "max_model_calls": 1})
    time.sleep(5)
    st = api.get(f"/api/v1/tasks/{t['id']}")
    snap = api.get("/api/v1/resources")
    waiting = [q for q in snap["queue"] if q["id"] == t["id"]]
    check("G new work deferred under pressure", st["state"] == "QUEUED" and waiting and waiting[0]["waiting_for_resources"],
          state=st["state"], limits_memory=snap["limits"].get("memory"))
    api.post("/api/v1/resources/simulate", {"pressure": None})
    t1 = time.time()
    done = wait_task(api, t["id"], {"COMPLETED", "FAILED", "CANCELLED", "WAITING_PROVIDER"}, 60)
    started = done.get("started_at") or 0
    evs = events_for(api, t["id"], seq)
    stages = [e["payload"].get("stage") for e in evs if e["type"] == "task.stage"]
    check("G queued work resumes automatically after recovery",
          bool(started) and started >= t1 - 0.5 and "waiting_for_resources" in stages and "starting" in stages,
          resumed_after_s=round(started - t1, 2) if started else None, deferred_s=round(t1 - t0, 1),
          final=done.get("state"), reason=(done.get("failure_reason") or "")[:160], stages=stages)
    snap = api.get("/api/v1/resources")
    check("G reservation released", t["id"] not in {q["id"] for q in snap["queue"]} and snap["active_workers"] == 0,
          active_workers=snap["active_workers"])


# --------------------------------------------------------------------------------------------- E
def scenario_e(api, probe, live_agent) -> None:
    import websockets
    from nebula_host import secrets as sec

    prev = api.get("/api/v1/remote")
    api.patch("/api/v1/remote", {"enabled": True, "port": e2e.GW_PORT})
    try:
        time.sleep(1.5)
        sec.init_store("keychain")
        token = sec.store().get("nebula:telegram.bot_token")
        tg_user = api.get("/api/v1/telegram")["users"][0]["telegram_user_id"]
        gw = httpx.Client(base_url=GW, timeout=60)
        t = time.perf_counter()
        page = gw.get("/mini/", headers={"Accept-Encoding": "br, gzip"})
        assets = re.findall(r'(?:src|href)="(/assets/[^"]+)"', page.text)
        wire = len(page.content)
        encs = set()
        for a in assets:
            with gw.stream("GET", a, headers={"Accept-Encoding": "br, gzip"}) as s:
                wire += len(b"".join(s.iter_raw()))
                encs.add(s.headers.get("content-encoding"))
        load_ms = (time.perf_counter() - t) * 1000
        check("E Mini App served compressed by the gateway", page.status_code == 200 and encs <= {"br", "gzip"},
              wire_bytes=wire, encodings=sorted(e or "none" for e in encs), load_ms=round(load_ms, 1))
        t = time.perf_counter()
        r = gw.post("/api/mini/auth", json={"init_data": e2e_common.init_data(token, tg_user)})
        auth_ms = (time.perf_counter() - t) * 1000
        if not check("E Mini App auth with real bot-signed initData", r.status_code == 200, ms=round(auth_ms, 1)):
            return
        hdr = {"authorization": f"Bearer {r.json()['data']['token']}"}
        tok = r.json()["data"]["token"]
        t = time.perf_counter()
        ags = gw.get("/api/v1/agents", headers=hdr).json()["data"]
        check("E agents list through the gateway", any(a["id"] == probe["id"] for a in ags),
              ms=round((time.perf_counter() - t) * 1000, 1), count=len(ags))
        t = time.perf_counter()
        task = gw.post(f"/api/v1/agents/{probe['id']}/tasks", json={"prompt": "mini app probe", "max_model_calls": 1},
                       headers=hdr)
        sub_ms = (time.perf_counter() - t) * 1000
        tid = task.json()["data"]["id"] if task.status_code in (200, 201) else None
        done = wait_task(api, tid, {"COMPLETED", "FAILED", "CANCELLED", "WAITING_PROVIDER"}, 60) if tid else {}
        check("E task submitted from the Mini App is dispatched", bool(tid) and done.get("started_at"),
              submit_ms=round(sub_ms, 1), final=done.get("state"),
              queue_ms=round((done.get("started_at", 0) - done.get("created_at", 0)) * 1000) if done else None)
        # Live Desktop via the gateway, timed
        aid = live_agent["id"]
        if api.get(f"/api/v1/agents/{aid}")["state"] in ("SLEEP", "STOPPED"):
            api.post(f"/api/v1/agents/{aid}/wake")
            time.sleep(1)

        async def live():
            out = {}
            t = time.perf_counter()
            c = gw.post(f"/api/v1/agents/{aid}/live/connect", headers=hdr).json()["data"]
            out["connect_api_ms"] = round((time.perf_counter() - t) * 1000, 1)
            url = f"ws://127.0.0.1:{e2e.GW_PORT}{c['ws_path']}?token={c['token']}&session_token={tok}"
            t = time.perf_counter()
            async with websockets.connect(url, origin=GW, max_size=None, subprotocols=["binary"]) as ws:
                out["ws_open_ms"] = round((time.perf_counter() - t) * 1000, 1)
                view = await e2e_common.rfb_session(ws, control=False)
                out["first_frame_ms"] = round((time.perf_counter() - t) * 1000, 1)
                out["framebuffer"] = view.get("framebuffer")
                ctl = gw.post(f"/api/v1/live/sessions/{c['session_id']}/control", json={"action": "acquire"},
                              headers=hdr)
                out["take_control"] = ctl.status_code
                out["release"] = gw.post(f"/api/v1/live/sessions/{c['session_id']}/control",
                                         json={"action": "release"}, headers=hdr).status_code
            out["disconnect"] = gw.delete(f"/api/v1/live/sessions/{c['session_id']}", headers=hdr).status_code
            return out

        lv = asyncio.run(live())
        time.sleep(1)
        streams = api.get("/api/v1/live/sessions")["active_streams"]
        check("E Live Desktop connect/take/release/disconnect via Mini App gateway",
              lv.get("take_control") == 200 and lv.get("release") == 200 and lv.get("disconnect") == 200
              and streams == [], **lv)
    finally:
        api.patch("/api/v1/remote", {"enabled": bool(prev.get("enabled")), "port": prev.get("port") or e2e.GW_PORT})


# --------------------------------------------------------------------------------------------- F
def scenario_f(api, probe) -> dict:
    api.post("/api/v1/resources/simulate", {"pressure": "critical", "minutes": 3})
    t = api.post(f"/api/v1/agents/{probe['id']}/tasks", {"prompt": "restart probe", "max_model_calls": 1})
    time.sleep(3)
    before = api.get(f"/api/v1/tasks/{t['id']}")["state"]
    subprocess.run(["launchctl", "kickstart", "-k", f"gui/{os.getuid()}/{LAUNCHD_LABEL}"], check=True)
    t0 = time.time()
    h = e2e_common.wait_health(api)
    restart_s = round(time.time() - t0, 1)
    api2 = e2e.Api(e2e.PORT)
    api2.login_or_setup()
    # the probe has no API key: once dispatched it ends in WAITING_PROVIDER (no request leaves the Mac)
    done = wait_task(api2, t["id"], {"COMPLETED", "FAILED", "CANCELLED", "WAITING_PROVIDER"}, 90)
    import sqlite3

    con = sqlite3.connect(f"file:{e2e.DATA / 'nebula.db'}?mode=ro", uri=True)
    n_tasks = con.execute("select count(*) from tasks where prompt='restart probe'").fetchone()[0]
    n_started = con.execute("select count(*) from events where task_id=? and type='task.started'", (t["id"],)).fetchone()[0]
    con.close()
    sse_ok = False
    with api2.c.stream("GET", "/api/v1/events", timeout=10) as s:
        for chunk in s.iter_raw():
            sse_ok = b"retry" in chunk
            break
    check("F restart: queued task recovered and run exactly once",
          before == "QUEUED" and bool(done.get("started_at")) and n_tasks == 1 and n_started == 1,
          before=before, after=done.get("state"), task_rows=n_tasks, started_events=n_started, restart_s=restart_s)
    check("F restart: Telegram polling and dashboard event stream reconnect", h["telegram"]["polling"] and sse_ok,
          telegram_polling=h["telegram"]["polling"], sse=sse_ok)
    return {"api": api2}


# --------------------------------------------------------------------------------------------- A / B (real AI)
def scenario_a(api) -> None:
    ag = next(a for a in api.get("/api/v1/agents") if a["name"] == E2E_AGENT)
    prompt = ("Open https://example.com in Chromium and tell me the main heading of the page. In your first turn call "
              "browser_navigate and browser_observe together; then call task_complete with the heading in the "
              "summary and the URL as artifact.")
    t = api.post(f"/api/v1/agents/{ag['id']}/tasks", {"prompt": prompt, "max_steps": 8, "max_model_calls": 2})
    done = wait_task(api, t["id"], {"COMPLETED", "FAILED", "CANCELLED"}, 300)
    res = done.get("result") or {}
    RES["ai_requests"] += int(res.get("model_calls") or (res.get("timings") or {}).get("model_turns") or 0)
    shot = api.c.get(f"/api/v1/agents/{ag['id']}/screenshot")
    (ROOT / "build/e2e/v3").mkdir(parents=True, exist_ok=True)
    if shot.status_code == 200:
        (ROOT / "build/e2e/v3/perf-scenario-a.png").write_bytes(shot.content)
    check("A VM browser task: real navigation + heading extracted",
          done.get("state") == "COMPLETED" and "example domain" in (res.get("summary") or "").lower(),
          state=done.get("state"), summary=(res.get("summary") or done.get("failure_reason") or "")[:200],
          verification=res.get("verification"), timings=res.get("timings"),
          screenshot=shot.status_code == 200)


def scenario_b(api) -> None:
    ag = next(a for a in api.get("/api/v1/agents") if a["name"] == E2E_AGENT)
    prompt = ("In the folder perf-calc/ create calc.py with functions add(a, b) and mul(a, b), and test_calc.py with "
              "unittest tests for both. Then run `python3 -m unittest -q` with perf-calc as working directory. Do the "
              "two file writes and the test run in ONE turn. If the tests fail, fix them. Finish with task_complete "
              "listing perf-calc/calc.py and perf-calc/test_calc.py as artifacts.")
    t = api.post(f"/api/v1/agents/{ag['id']}/tasks", {"prompt": prompt, "max_steps": 12, "max_model_calls": 3})
    done = wait_task(api, t["id"], {"COMPLETED", "FAILED", "CANCELLED"}, 300)
    res = done.get("result") or {}
    RES["ai_requests"] += int(res.get("model_calls") or (res.get("timings") or {}).get("model_turns") or 0)
    env = (done.get("execution") or {}).get("env", "vm")
    if env == "host":  # natively on the Mac, inside the authorised project folder
        demo = Path.home() / "NEBULA-Projects" / "v3-demo" / "perf-calc"
        run = subprocess.run(["python3", "-m", "unittest", "-q"], cwd=demo, capture_output=True, text=True,
                             timeout=60) if demo.exists() else None
        files = sorted(p.name for p in demo.glob("*.py")) if demo.exists() else []
        out, ok = ((run.stderr or run.stdout)[-200:], run.returncode == 0) if run else (None, False)
    else:  # in the agent's VM workspace: list + re-run the tests through the guest RPC (no AI)
        from nebula_host import secrets as sec
        from nebula_host.config import load_config
        from nebula_host.guest import GuestClient
        from nebula_setup.installer import guest_key

        sec.init_store("keychain")
        gc = GuestClient(load_config().run_dir / "vm", guest_key)

        async def verify():
            ls = await gc.tool(ag["id"], "files.list", {"path": "perf-calc"})
            rr = await gc.tool(ag["id"], "shell.execute", {"command": "cd perf-calc && python3 -m unittest -q 2>&1",
                                                            "timeout": 60})
            return ls, rr

        ls, rr = asyncio.run(verify())
        files = [e["name"] for e in (ls.get("result") or {}).get("entries", [])] if ls.get("ok") else []
        out = ((rr.get("result") or {}).get("stdout") or "")[-200:]
        ok = rr.get("ok") and rr["result"]["exit_code"] == 0
    check(f"B coding agent ({env}): files created, tests pass (re-run independently)",
          done.get("state") == "COMPLETED" and bool(ok) and "calc.py" in files and "test_calc.py" in files,
          state=done.get("state"), environment=env,
          summary=(res.get("summary") or done.get("failure_reason") or "")[:200], files=files,
          independent_test_run=out, timings=res.get("timings"))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--with-ai", action="store_true")
    ap.add_argument("--skip", default="")
    ap.add_argument("--keep-probe", action="store_true")
    a = ap.parse_args()
    skip = set(filter(None, a.skip.split(",")))
    api = e2e.Api(e2e.PORT)
    api.login_or_setup()
    probe = probe_agent(api)
    live_agent = next(x for x in api.get("/api/v1/agents") if x["name"] == E2E_AGENT)
    try:
        if "G" not in skip:
            scenario_g(api, probe)
        if "E" not in skip:
            scenario_e(api, probe, live_agent)
        if "F" not in skip:
            api = scenario_f(api, probe)["api"]
        if a.with_ai:
            if "A" not in skip:
                scenario_a(api)
            if "B" not in skip:
                scenario_b(api)
    finally:
        try:
            api.post("/api/v1/resources/simulate", {"pressure": None})
        except Exception:  # noqa: BLE001
            pass
        if not a.keep_probe:
            try:
                api.delete(f"/api/v1/agents/{probe['id']}?confirm=true")
                rec("CLEANUP probe agent deleted", "PASS")
            except Exception as e:  # noqa: BLE001
                rec("CLEANUP probe agent deleted", "FAIL", error=str(e)[:200])
        RES["finished"] = time.strftime("%Y-%m-%d %H:%M:%S")
        OUT.parent.mkdir(parents=True, exist_ok=True)
        OUT.write_text(json.dumps(RES, indent=1, default=str))
    fails = [k for k, v in RES["results"].items() if v["status"] == "FAIL"]
    print("\nAI requests used:", RES["ai_requests"], "\nFAIL:", fails or "none")
    return 1 if fails else 0


if __name__ == "__main__":
    raise SystemExit(main())
