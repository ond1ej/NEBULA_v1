#!/usr/bin/env python3
"""NEBULA 3.3 — Smart Auth 2.0 on the real hardware (real `nebula-vault` broker, real headless Chromium in the VM).
No AI requests, no owner vault, no real accounts: a synthetic Microsoft-style sign-in site is served inside the VM.

The fixture reproduces what made the real Microsoft sign-in fail:
  * one single-page app: the e-mail view fades out and the password view fades in WITHOUT a navigation, and the
    password view keeps an off-screen, aria-hidden copy of the e-mail field (for password managers);
  * the page asks the browser whether WebAuthn exists (like Microsoft's `isFidoSupported`) and, if so, sends the
    sign-in to a passkey page on ANOTHER origin (a dead end for a browser without an authenticator);
  * SMS code, then "Stay signed in?" (NEBULA answers "No"), then the session cookie;
plus a page that never reacts (loop), a page that changes on its own (watcher), a passkey page offering "Use your
password", and a form posting to a lookalike of login.microsoftonline.com.

Part A drives the broker directly over the guest RPC; part B runs the NEBULA host code in-process (temporary data
dir + temporary test vault, real VM guest, deterministic scripted model) for the full chain:
agent -> login page -> e-mail -> password -> SMS code -> signed in -> saved to the (test) vault -> agent resumes.
Part C checks the verified relationship against the REAL Microsoft sites (teams.microsoft.com ->
login.microsoftonline.com): pages are only loaded, nothing is typed, the session is cancelled.

Results: build/e2e/v33-smart-auth.json
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import secrets
import sys
import tempfile
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / "scripts"), str(ROOT / "apps/host-api"), str(ROOT / "apps/setup"),
                str(ROOT / "packages/contracts"), str(ROOT / "packages/agent-runtime"),
                str(ROOT / "packages/provider-adapters"), str(ROOT / "packages/telegram-gateway"),
                str(ROOT / "packages/live-broker")]
import e2e  # noqa: E402

OUT = ROOT / "build/e2e/v33-smart-auth.json"
RES: dict = {"checks": [], "started": time.time(), "ai_requests": 0}

PAGE = r"""<html><head><title>Sign in to your account</title><style>
.view{transition:opacity .45s} .gone{opacity:0} body{font-family:sans-serif}
.moveOffScreen{position:fixed;bottom:0;left:0;width:1px;height:1px;opacity:.01}</style></head>
<body><div id=app>__BODY__</div><script>__JS__</script></body></html>"""

EMAIL_VIEW = """<form id=f1 class=view method=post action="/ms/login" onsubmit="return next(event)">
<h1 role=heading>Sign in</h1><div id=err1 role=alert class=error></div>
<input type=email name=loginfmt id=i0116 autocomplete=username aria-label="Email, phone, or Skype">
<input type=submit id=idSIButton9 value=Next></form>"""

PW_VIEW_JS = """function pwView(u){ const v2=document.createElement('form'); v2.className='view gone'; v2.method='post';
 v2.action='/ms/login'; v2.innerHTML='<h1 role=heading>Enter password</h1><div role=alert class=error></div>'+
 '<input type=email name=loginfmt class=moveOffScreen aria-hidden=true tabindex=-1 value="'+String(u).replace(/[^\\w@.+-]/g,'')+'">'+
 '<input type=password name=passwd id=i0118 autocomplete=current-password aria-label=Password><input type=submit value="Sign in">';
 document.getElementById('app').appendChild(v2); requestAnimationFrame(()=>requestAnimationFrame(()=>v2.classList.remove('gone'))); }
function swapTo(u){ const v1=document.getElementById('f1')||document.getElementById('pk'); v1.classList.add('gone');
 setTimeout(()=>{ v1.remove(); pwView(u); }, 450); }"""

MS_JS = PW_VIEW_JS + """
async function next(e){ e.preventDefault(); const u=document.getElementById('i0116').value;
 const fido=!!(window.PublicKeyCredential && navigator.credentials && navigator.credentials.get);
 const r=await (await fetch('/ms/GetCredentialType',{method:'POST',headers:{'content-type':'application/json'},
   body:JSON.stringify({username:u,isFidoSupported:fido})})).json();
 if(r.route==='fido'){ const f=document.createElement('form'); f.method='post'; f.action=r.fido_url;
   document.body.appendChild(f); f.submit(); return false; }
 if(r.route==='unknown'){ document.getElementById('err1').textContent='This username may be incorrect.'; return false; }
 swapTo(u); return false; }"""

SITE = r'''
import hashlib, http.server, json, secrets, sys, urllib.parse, pathlib, threading, time
P1, P2, USER, PWH, OTPH, MARK, IP = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3], sys.argv[4], sys.argv[5], pathlib.Path(sys.argv[6]), sys.argv[7]
PAGES = json.loads(pathlib.Path(sys.argv[8]).read_text())
SESS = {}
h = lambda s: hashlib.sha256(s.encode()).hexdigest()
def mark(s):
    with MARK.open("a") as f: f.write(s + "\n")
def page(body, js=""): return PAGES["PAGE"].replace("__BODY__", body).replace("__JS__", js)
OTP_FORM = ('<form method=post action="/ms/otp"><h1 role=heading>Enter code</h1><div role=alert class=error>%s</div>'
            '<p>We texted your phone +XX XXXXXXXX42. Please enter the code to sign in.</p>'
            '<input name=otc type=tel autocomplete=one-time-code inputmode=numeric maxlength=6 aria-label=Code>'
            '<input type=submit value=Verify></form>')
KMSI = ('<form method=post action="/ms/kmsi"><h1 role=heading>Stay signed in?</h1>'
        '<p>Do this to reduce the number of times you are asked to sign in.</p>'
        '<button type=submit name=answer value=yes>Yes</button> <button type=submit name=answer value=no>No</button></form>')
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def send(self, code, body, headers=(), ctype="text/html; charset=utf-8"):
        self.send_response(code)
        for k, v in headers: self.send_header(k, v)
        self.send_header("Content-Type", ctype); self.end_headers(); self.wfile.write(body.encode())
    def form(self):
        n = int(self.headers.get("Content-Length") or 0); raw = self.rfile.read(n).decode()
        if (self.headers.get("Content-Type") or "").startswith("application/json"): return json.loads(raw or "{}")
        return {k: v[0] for k, v in urllib.parse.parse_qs(raw).items()}
    def do_GET(self):
        p = urllib.parse.urlsplit(self.path).path
        if self.server.server_port == P2:
            mark("P2_GET " + p); return self.send(200, "<html><body>other origin</body></html>")
        if p == "/ms/start": return self.send(200, page(PAGES["EMAIL_VIEW"], PAGES["MS_JS"]))
        if p == "/pk/start":
            body = ('<div id=pk class=view><h1 role=heading>Sign in with a passkey</h1><p>Use your face, fingerprint, PIN or '
                    'security key to sign in.</p><button type=button onclick="swapTo(\'%s\')">Use your password</button> '
                    '<button type=button>Other ways to sign in</button></div>' % USER)
            return self.send(200, page(body, PAGES["PW_VIEW_JS"]))
        if p == "/loop/start":
            return self.send(200, page(PAGES["EMAIL_VIEW"], "function next(e){e.preventDefault();return false;}"))
        if p == "/auto/start":
            return self.send(200, page(PAGES["EMAIL_VIEW"], PAGES["PW_VIEW_JS"] +
                                       "function next(e){e.preventDefault();return false;} setTimeout(()=>swapTo('x'), 6000);"))
        if p == "/evil/start":
            return self.send(200, page('<form method=post action="https://login-microsoftonline.com/common/login">'
                                       '<h1 role=heading>Sign in</h1><input type=email name=loginfmt autocomplete=username '
                                       'aria-label="Email"><input type=submit value=Next></form>'))
        if p == "/account/ms":
            for part in (self.headers.get("Cookie") or "").split(";"):
                k, _, v = part.strip().partition("=")
                if k == "sid_ms" and SESS.get(v) == "ms":
                    return self.send(200, "<html><title>Account</title><body><h1>Dashboard</h1><p>Welcome back, fixture "
                                          "user (ms)</p><a href='/logout'>Sign out</a></body></html>")
            return self.send(302, "", [("Location", "/ms/start")])
        return self.send(404, "no")
    def do_POST(self):
        p = urllib.parse.urlsplit(self.path).path
        if self.server.server_port == P2:
            mark("P2_POST " + p); return self.send(200, "<html><body>Use your passkey</body></html>")
        b = self.form()
        if p == "/ms/GetCredentialType":
            mark("FIDO:%s" % bool(b.get("isFidoSupported")))
            if b.get("username") != USER: return self.send(200, json.dumps({"route": "unknown"}), ctype="application/json")
            if b.get("isFidoSupported"):
                return self.send(200, json.dumps({"route": "fido", "fido_url": "http://%s:%d/ms/fido" % (IP, P2)}),
                                 ctype="application/json")
            return self.send(200, json.dumps({"route": "password"}), ctype="application/json")
        if p == "/ms/login":
            if h(b.get("passwd", "")) != PWH:
                mark("PW_BAD")
                return self.send(200, page('<form method=post action="/ms/login"><h1 role=heading>Enter password</h1>'
                                           '<div role=alert class=error>Your account or password is incorrect.</div>'
                                           '<input type=password name=passwd autocomplete=current-password aria-label=Password>'
                                           '<input type=submit value="Sign in"></form>'))
            mark("PW_OK"); return self.send(200, page(OTP_FORM % ""))
        if p == "/ms/otp":
            if h(b.get("otc", "")) != OTPH: return self.send(200, page(OTP_FORM % "That code didn't work. Check the code and try again."))
            sid = secrets.token_hex(16); SESS[sid] = "ms"; mark("OTP_OK")
            return self.send(200, page(KMSI), [("Set-Cookie", "sid_ms=%s; HttpOnly; Path=/" % sid)])
        if p == "/ms/kmsi":
            mark("KMSI:" + str(b.get("answer"))); return self.send(302, "", [("Location", "/account/ms")])
        return self.send(404, "no")
for port in (P1, P2):
    s = http.server.ThreadingHTTPServer(("0.0.0.0", port), H)
    threading.Thread(target=s.serve_forever, daemon=True).start()
threading.Event().wait()
'''


def check(name: str, ok: bool, **detail) -> None:
    RES["checks"].append({"name": name, **detail, "status": "PASS" if ok else "FAIL"})
    print(("PASS " if ok else "FAIL ") + name, json.dumps(detail, default=str)[:400] if detail else "", flush=True)


def roles(ev: dict) -> list[str]:
    return [f["role"] for f in ((ev.get("step") or {}).get("fields") or [])]


# ============================================================================ part A: the broker itself
async def part_a(gc, aid: str, ORG: str, ORG2: str, user: str, pw: str, otp: str, mark: str) -> None:
    async def start(path: str, extra: dict | None = None):
        sid = "as_" + secrets.token_hex(12)
        t0 = time.time()
        ev = await gc.call("vault.auth_start", {"session_id": sid, "agent_id": aid, "origin": ORG, "allowed_origins": [ORG],
                                                "url": ORG + path, "timeout_s": 300, **(extra or {})}, timeout=200)
        return sid, ev, round((time.time() - t0) * 1000)

    async def fill(sid, ev, value):
        return await gc.call("vault.auth_step", {"session_id": sid, "agent_id": aid, "step_id": ev["step_id"],
                                                 "values": {ev["step"]["fields"][0]["id"]: value}}, timeout=150)

    async def marks() -> list[str]:
        out = await gc.tool(aid, "shell.execute", {"command": f"cat {mark} 2>/dev/null || true", "timeout": 10})
        return ((out.get("result") or {}).get("stdout") or "").split("\n")

    async def cancel(sid):
        await gc.call("vault.auth_cancel", {"session_id": sid, "agent_id": aid}, timeout=20)

    # A1 the reported Microsoft bug: e-mail -> the next page is the PASSWORD step (single-page swap with a hidden
    # username copy), never the e-mail form again; WebAuthn hidden so the site never routes to the passkey dead end
    sid, ev, ms = await start("/ms/start")
    ok1 = ev.get("event") == "step" and ev["step"]["step"] == "identifier" and roles(ev) == ["email"]
    t0 = time.time()
    ev2 = await fill(sid, ev, user) if ok1 else {}
    step_ms = round((time.time() - t0) * 1000)
    m = await marks()
    check("A1 e-mail -> password step (single-page swap, hidden username ignored), not the e-mail form again",
          ok1 and ev2.get("event") == "step" and ev2["step"]["step"] == "password" and roles(ev2) == ["password"]
          and not ev2.get("error"), first=(ev.get("step") or {}).get("step"), next=(ev2.get("step") or {}).get("step"),
          next_roles=roles(ev2), error=ev2.get("error"), start_ms=ms, email_to_password_ms=step_ms)
    # V3.4: WebAuthn is no longer hidden. On this fixture's plain-http VM address the browser itself exposes no
    # WebAuthn (not a secure context), so this only shows that the sign-in did not end on the passkey origin; the
    # real WebAuthn cases (passkey / security key on a secure origin) are in scripts/v34_smart_auth_e2e.py
    check("A1 the sign-in did not end on the passkey origin (browser capabilities reported as they are)",
          any(x.startswith("FIDO:") for x in m) and not any(x.startswith("P2_POST") for x in m),
          marks=[x for x in m if x])
    RES["timing"] = {"start_ms": ms, "email_to_password_ms": step_ms}
    # A2 wrong password: an error on the page = rejected (same step)
    bad = await fill(sid, ev2, "wrong-" + pw)
    check("A2 wrong password -> same password step, rejected (error shown by the site)",
          bad.get("event") == "step" and bad["step"]["step"] == "password" and bad.get("error") == "rejected",
          error=bad.get("error"), step=(bad.get("step") or {}).get("step"))
    # A3 right password -> SMS code -> code -> 'Stay signed in?' answered No -> signed in
    ev3 = await fill(sid, bad, pw)
    o = (ev3.get("step") or {}).get("otp") or {}
    check("A3 password -> SMS code step (6 digits)", ev3.get("event") == "step" and ev3["step"]["step"] == "otp" and
          o.get("channel") == "sms" and o.get("length") == 6, step=(ev3.get("step") or {}).get("step"), otp=o)
    res = await fill(sid, ev3, otp) if ev3.get("step") else {}
    m = await marks()
    await gc.tool(aid, "browser.navigate", {"url": ORG + "/account/ms"})
    obs = json.dumps((await gc.tool(aid, "browser.observe", {})).get("result") or {})
    check("A3 code -> 'Stay signed in?' answered No by NEBULA -> signed in, session only in the agent's browser",
          res.get("event") == "result" and res.get("status") == "authenticated" and res.get("cookies_imported", 0) >= 1
          and "KMSI:no" in m and "fixture user (ms)" in obs, status=res.get("status"),
          imported=res.get("cookies_imported"), kmsi=[x for x in m if x.startswith("KMSI")])
    # A4 passkey page offering 'Use your password'
    sid, ev, _ = await start("/pk/start", {"passkey_fallback": "ask"})  # V3.4: the owner chooses (no automatic way)
    kinds = [a.get("kind") for a in (ev.get("step") or {}).get("alternatives") or []]
    alt = next((a["id"] for a in (ev.get("step") or {}).get("alternatives") or [] if a["kind"] == "password"), None)
    nxt = await gc.call("vault.auth_choose", {"session_id": sid, "agent_id": aid, "alt_id": alt}, timeout=90) if alt \
        else {}
    check("A4 passkey page -> 'use password' offered (kind only) -> chosen -> password step",
          (ev.get("step") or {}).get("step") == "passkey" and "password" in kinds and nxt.get("event") == "step" and
          nxt["step"]["step"] == "password", kinds=kinds, next=(nxt.get("step") or {}).get("step"))
    await cancel(sid)
    # A5 a page that changes on its own while the owner is answering
    sid, ev, _ = await start("/auto/start")
    same = await gc.call("vault.auth_observe", {"session_id": sid, "agent_id": aid}, timeout=60)
    await asyncio.sleep(7)
    moved = await gc.call("vault.auth_observe", {"session_id": sid, "agent_id": aid}, timeout=60)
    check("A5 observe: unchanged page -> same step; page that switched by itself -> new step (page_changed)",
          same.get("changed") is False and moved.get("changed") is True and
          (moved.get("step") or {}).get("step") == "password" and moved.get("error") == "page_changed",
          same=same.get("changed"), moved=moved.get("changed"), step=(moved.get("step") or {}).get("step"))
    await cancel(sid)
    # A6 a page that never reacts -> no_progress (not 'wrong credentials')
    sid, ev, _ = await start("/loop/start")
    np = await fill(sid, ev, user)
    check("A6 page that does not react -> 'no_progress' (not reported as rejected credentials)",
          np.get("event") == "step" and np.get("error") == "no_progress", error=np.get("error"), event=np.get("event"))
    await cancel(sid)
    # A7 credentials posted to a lookalike of login.microsoftonline.com: blocked before anything leaves
    sid, ev, _ = await start("/evil/start")
    bl = await fill(sid, ev, user)
    check("A7 form posting to login-microsoftonline.com -> blocked by the broker (nothing sent)",
          bl.get("event") == "blocked" and bl.get("origin") == "https://login-microsoftonline.com" and
          bl.get("reason") == "form_target", event=bl.get("event"), origin=bl.get("origin"))
    await cancel(sid)


# ============================================================================ part B: host in-process + real VM
def part_b(gc, aid: str, ORG: str, user: str, pw: str, otp: str, live_agent_row: dict) -> None:
    tmp = Path(tempfile.mkdtemp(prefix="nebula-v33-e2e-"))
    os.environ.update(NEBULA_TESTING="1", NEBULA_SECRET_BACKEND="memory",  # noqa: S106
                      NEBULA_DATA_DIR=str(tmp / "data"), NEBULA_LOG_DIR=str(tmp / "logs"), NEBULA_PORT="3197")
    from fastapi.testclient import TestClient
    from nebula_host import auth, db, models, providers_service
    from nebula_host import vault as vaultmod
    from nebula_host.app import create_app
    from nebula_host.config import get_config
    from nebula_host.state import svc

    from tests.conftest import ScriptedProvider, call, done

    get_config.cache_clear()
    vaultmod.calibrate_kdf = lambda *a, **k: {"alg": "argon2id", "salt": vaultmod.b64e(os.urandom(16)),
                                              "time_cost": 2, "memory_kib": 8192, "parallelism": 1}
    app = create_app()
    with TestClient(app, base_url="http://127.0.0.1:3197") as c:
        svc.guest = gc
        for obj in (svc.orch, svc.live, svc.telegram, svc.teams, svc.files, svc.resources):
            obj.guest = gc
        tok = auth.ensure_setup_token()
        r = c.post("/api/v1/auth/setup", json={"username": "owner", "password": "e2e test owner " + uuid.uuid4().hex,
                                               "setup_token": tok}, headers={"Origin": "http://127.0.0.1:3197"})
        h = {"Origin": "http://127.0.0.1:3197", "x-csrf-token": r.json()["data"]["csrf_token"]}
        from sqlalchemy import JSON

        row = {k: live_agent_row[k] for k in live_agent_row if k in models.agents.c}
        for col in models.agents.c:
            if isinstance(col.type, JSON) and isinstance(row.get(col.name), str):
                row[col.name] = json.loads(row[col.name])
        row.update(status="READY", provider_id="ollama-local", model_id="scripted")
        with db.engine().begin() as conn:
            conn.execute(models.agents.insert().values(**row))
        # the fixture lives on the VM's private IP: this TEMPORARY host allows local-network sign-ins (off by default)
        db.set_setting("smart_auth", {"allow_local_network": True, "observe_interval_s": 3})
        time.sleep(12)  # let the host's one-time broker sweep run before any session exists
        assert c.post("/api/v1/vault", json={"passphrase": "e2e test vault passphrase 1"}, headers=h).status_code == 201

        def sess(task_id, rtype=None, seq_gt=0, timeout=120, states=None):
            end, s = time.time() + timeout, None
            while time.time() < end:
                rows = c.get(f"/api/v1/smart-auth/sessions?task_id={task_id}").json()["data"]
                if rows:
                    s = c.get(f"/api/v1/smart-auth/sessions/{rows[0]['id']}").json()["data"]
                    if states and s["state"] in states:
                        return s
                    if s["state"] in ("AUTHENTICATED", "FAILED", "CANCELLED", "EXPIRED"):
                        return s
                    rq = s.get("request")
                    if not states and rq and rq["seq"] > seq_gt and (rtype is None or rq["type"] == rtype):
                        return s
                time.sleep(0.2)
            raise AssertionError(f"no request ({s and s['state']})")

        def submit(s, **body):
            t = c.post(f"/api/v1/smart-auth/sessions/{s['id']}/token", headers=h).json()["data"]
            return c.post(f"/api/v1/smart-auth/sessions/{s['id']}/submit",
                          json={"request_id": t["request_id"], "token": t["token"], **body}, headers=h)

        def run_task(url):
            asyncio.run(gc.tool(aid, "browser.navigate", {"url": "about:blank"}))
            prov = ScriptedProvider([[call("request_sign_in", {"url": url}, "c1"), done()],
                                     [call("browser_observe", {}, "c2"), done()],
                                     [call("task_complete", {"summary": "read the account page", "success": True},
                                           "c3"), done()]])
            providers_service.adapter_for = lambda pid: prov
            return c.post(f"/api/v1/agents/{aid}/tasks", json={"prompt": "Sign in and read the account page"},
                          headers=h).json()["data"], prov

        def finish(t, timeout=180):
            end = time.time() + timeout
            while time.time() < end:
                tt = c.get(f"/api/v1/tasks/{t['id']}").json()["data"]
                if tt["state"] in ("COMPLETED", "FAILED", "CANCELLED"):
                    return tt
                time.sleep(0.3)
            raise AssertionError("task did not finish")

        def tool_texts(prov):
            res, obs = {}, ""
            for req in prov.requests:
                for m in req.messages:
                    if m.role == "tool" and m.tool_name == "request_sign_in":
                        res = json.loads(m.content)
                    if m.role == "tool" and m.tool_name == "browser_observe":
                        obs = m.content
            return res, obs

        # B1 the full chain with real Chromium
        t, prov = run_task(ORG + "/ms/start")
        s1 = sess(t["id"], "credentials")
        st1, roles1 = s1["state"], [f["role"] for f in s1["request"]["fields"]]
        submit(s1, action="credentials", values={s1["request"]["fields"][0]["id"]: user}, save="vault",
               name="Fixture Microsoft", review_confirmed=True)
        s2 = sess(t["id"], "credentials", seq_gt=s1["request"]["seq"])
        st2, roles2, intent = s2["state"], [f["role"] for f in (s2.get("request") or {}).get("fields") or []], \
            (s2.get("request") or {}).get("save_intent")
        submit(s2, action="credentials", values={s2["request"]["fields"][0]["id"]: pw}, review_confirmed=True)
        s3 = sess(t["id"], "otp", seq_gt=s2["request"]["seq"])
        st3 = s3["state"]
        submit(s3, action="code", values={s3["request"]["fields"][0]["id"]: otp}, review_confirmed=True)
        tt = finish(t)
        res, obs = tool_texts(prov)
        entries = c.get("/api/v1/vault/entries").json()["data"]
        det = vaultmod.VAULT.entry_detail(entries[0]["id"]) if entries else {}
        final = c.get(f"/api/v1/smart-auth/sessions/{s1['id']}").json()["data"]
        check("B1 agent -> e-mail -> password -> SMS code -> signed in -> agent resumed in the signed-in page",
              st1 == "EMAIL_REQUIRED" and roles1 == ["email"] and st2 == "PASSWORD_REQUIRED" and
              roles2 == ["password"] and st3 == "OTP_REQUIRED" and tt["state"] == "COMPLETED" and
              res.get("status") == "authenticated" and "fixture user (ms)" in obs,
              states=[st1, st2, st3, final["state"]], roles=[roles1, roles2], result=res.get("status"))
        check("B1 e-mail + password saved together AFTER the verified sign-in (one credential; code not saved)",
              intent == "vault" and len(entries) == 1 and det.get("username") == user and det.get("has_password") and
              entries[0]["origin"] == ORG, entries=len(entries), origin=entries[0]["origin"] if entries else None)
        # B2 loop guard
        t, prov = run_task(ORG + "/loop/start")
        s = sess(t["id"], "credentials")
        submit(s, action="credentials", values={s["request"]["fields"][0]["id"]: user}, review_confirmed=True)
        s = sess(t["id"], "credentials", seq_gt=s["request"]["seq"])
        first_err = (s.get("request") or {}).get("error")
        submit(s, action="credentials", values={s["request"]["fields"][0]["id"]: user}, review_confirmed=True)
        s = sess(t["id"], "loop", seq_gt=s["request"]["seq"])
        check("B2 page that never reacts: 'no progress', then the loop guard stops (Retry / Live Desktop / Cancel)",
              first_err == "no_progress" and s["state"] == "WAITING_FOR_USER" and
              (s.get("request") or {}).get("type") == "loop", first=first_err, state=s["state"],
              error=s.get("error_code"))
        c.post(f"/api/v1/smart-auth/sessions/{s['id']}/cancel", headers=h)
        finish(t)
        # B3 lookalike destination: RED, fails, never confirmable
        t, prov = run_task(ORG + "/evil/start")
        s = sess(t["id"], "credentials")
        submit(s, action="credentials", values={s["request"]["fields"][0]["id"]: user}, review_confirmed=True)
        s = sess(t["id"], states={"FAILED"})
        finish(t)
        res, _ = tool_texts(prov)
        check("B3 form posting to login-microsoftonline.com -> RED, sign-in stopped, agent told not to sign in there",
              s["state"] == "FAILED" and s["error_code"] == "suspicious_destination" and
              (s.get("trust") or {}).get("level") == "RED" and res.get("reason_code") == "suspicious_destination",
              trust=s.get("trust"), result=res.get("reason_code"))
        # B4 page changes while the owner's form is open: the request is replaced, the old answer refused
        t, prov = run_task(ORG + "/auto/start")
        s = sess(t["id"], "credentials")
        old = c.post(f"/api/v1/smart-auth/sessions/{s['id']}/token", headers=h).json()["data"]
        s2 = sess(t["id"], "credentials", seq_gt=s["request"]["seq"], timeout=40)
        stale = c.post(f"/api/v1/smart-auth/sessions/{s['id']}/submit",
                       json={"request_id": old["request_id"], "token": old["token"], "action": "credentials",
                             "values": {"f0": user}, "review_confirmed": True}, headers=h)
        check("B4 page changed by itself -> dialog replaced (PASSWORD_REQUIRED, page_changed), stale answer refused",
              s2["state"] == "PASSWORD_REQUIRED" and (s2.get("request") or {}).get("error") == "page_changed" and
              stale.status_code == 409, state=s2["state"], stale=stale.status_code)
        c.post(f"/api/v1/smart-auth/sessions/{s['id']}/cancel", headers=h)
        finish(t)
        # C real Microsoft: teams.microsoft.com -> login.microsoftonline.com is verified (GREEN): no question
        db.set_setting("smart_auth", {"allow_local_network": False, "observe_interval_s": 8})
        t, prov = run_task("https://teams.microsoft.com/v2/")
        try:
            s = sess(t["id"], timeout=150, states={"EMAIL_REQUIRED", "IDENTIFIER_REQUIRED", "IDENTIFIER_AND_PASSWORD_REQUIRED",
                                                   "REDIRECT_REVIEW_REQUIRED", "FAILED", "WAITING_FOR_USER"})
        except AssertionError as e:
            s = {"state": f"timeout: {e}"}
        check("C real Teams -> login.microsoftonline.com: verified relationship (GREEN), e-mail step, no warning",
              s.get("state") in ("EMAIL_REQUIRED", "IDENTIFIER_REQUIRED") and s.get("verified_origin") == "https://login.microsoftonline.com"
              and (s.get("trust") or {}).get("level") == "GREEN" and not (s.get("request") or {}).get("review_required"),
              state=s.get("state"), verified=s.get("verified_origin"), trust=s.get("trust"),
              error=s.get("error_code"))
        if s.get("id"):
            c.post(f"/api/v1/smart-auth/sessions/{s['id']}/cancel", headers=h)
        finish(t)
        # secrets nowhere in the host's database/WAL/logs/model requests
        dbp = Path(get_config().db_path)
        blob = (dbp.read_bytes() + (Path(str(dbp) + "-wal").read_bytes() if Path(str(dbp) + "-wal").exists()
                                    else b"")).decode("latin-1")
        for p in (tmp / "logs").rglob("*"):
            if p.is_file():
                blob += p.read_text(errors="replace")
        check("host: password and code absent from DB/WAL/logs (vault ciphertext only)", pw not in blob and otp not in blob)


def main() -> int:
    from nebula_host import secrets as sec
    from nebula_host.config import load_config
    from nebula_host.guest import GuestClient
    from nebula_setup.installer import guest_key

    sec.init_store("keychain")
    gkey = guest_key()
    gc = GuestClient(load_config().run_dir / "vm", lambda: gkey)
    cap = asyncio.run(gc.call("guest.capabilities", {}, timeout=30))
    RES["broker"] = (cap.get("vault_broker") or {})
    if (cap.get("vault_broker") or {}).get("smart_auth_version") not in (2, 3):
        check("VM broker is V3.3+ (protocol 2/3)", False, broker=cap.get("vault_broker"))
    api = e2e.Api(e2e.PORT)
    api.login_or_setup()
    probe = api.post("/api/v1/agents", {"name": "Smart Auth 2 Probe", "provider_id": "anthropic-api",
                                        "model_id": "smart-auth-probe", "permission_level": "STANDARD"},
                     headers={"Idempotency-Key": str(uuid.uuid4())})
    aid = probe["id"]
    user = "fixture-" + secrets.token_hex(4) + "@example.test"
    pw = "CANARY-SA2-" + secrets.token_hex(12)
    otp = f"{secrets.randbelow(900000) + 100000}"
    p1, p2 = 18100 + secrets.randbelow(800), 19100 + secrets.randbelow(800)
    try:
        for _ in range(60):
            if api.get(f"/api/v1/agents/{aid}")["state"] in ("READY", "SLEEPING", "IDLE"):
                break
            time.sleep(1)
        api.post(f"/api/v1/agents/{aid}/wake", {})

        async def setup():
            ip = (await gc.tool(aid, "shell.execute", {"command": "hostname -I | awk '{print $1}'", "timeout": 10}))
            ip = ip["result"]["stdout"].strip()
            home = (await gc.tool(aid, "shell.execute", {"command": "echo $HOME", "timeout": 10}))["result"]["stdout"].strip()
            mark = f"{home}/workspace/smart-auth2-fixture.mark"
            await gc.tool(aid, "files.write", {"path": "smart-auth2-fixture.py", "content": SITE})
            await gc.tool(aid, "files.write", {"path": "smart-auth2-pages.json", "content": json.dumps(
                {"PAGE": PAGE, "EMAIL_VIEW": EMAIL_VIEW, "MS_JS": MS_JS, "PW_VIEW_JS": PW_VIEW_JS})})
            st = await gc.tool(aid, "process.start", {"command": f"python3 smart-auth2-fixture.py {p1} {p2} {user} "
                                                                  f"{hashlib.sha256(pw.encode()).hexdigest()} "
                                                                  f"{hashlib.sha256(otp.encode()).hexdigest()} "
                                                                  f"{mark} {ip} smart-auth2-pages.json"})
            await asyncio.sleep(1.5)
            return ip, mark, (st.get("result") or {}).get("pid")

        ip, mark, pid = asyncio.run(setup())
        ORG, ORG2 = f"http://{ip}:{p1}", f"http://{ip}:{p2}"
        RES["fixture_origin"] = ORG
        asyncio.run(part_a(gc, aid, ORG, ORG2, user, pw, otp, mark))
        import sqlite3

        con = sqlite3.connect(f"file:{e2e.DATA / 'nebula.db'}?mode=ro", uri=True)
        con.row_factory = sqlite3.Row
        row = dict(con.execute("select * from agents where id=?", (aid,)).fetchone())
        con.close()
        try:
            part_b(gc, aid, ORG, user, pw, otp, row)
        except Exception as e:  # noqa: BLE001
            import traceback

            check("part B (host in-process + real VM)", False, error=f"{type(e).__name__}: {str(e)[:300]}",
                  where=traceback.format_exc()[-1500:])

        async def scan():
            tail = pw[-16:]
            out = await gc.tool(aid, "shell.execute", {
                "command": f"grep -rIl --binary-files=text -e '{tail}' -e '{otp}' \"$HOME\" /tmp /dev/shm 2>/dev/null | "
                           f"grep -v smart-auth2-fixture | head -5; echo SCAN_DONE", "timeout": 120})
            o = (out.get("result") or {}).get("stdout", "")
            hits = [x for x in o.splitlines() if x and x != "SCAN_DONE"]
            check("password + code absent from the agent's home (browser profile), /tmp, /dev/shm",
                  "SCAN_DONE" in o and not hits, hits=hits)
            ps = await gc.tool(aid, "shell.execute", {"command": "ps -eo user,cmd | grep -c '[v]ault_auth.py' || true",
                                                       "timeout": 10})
            check("no isolated broker process left running", (ps.get("result") or {}).get("stdout", "").strip() in
                  ("0", ""), count=(ps.get("result") or {}).get("stdout", "").strip())
            if pid:
                await gc.tool(aid, "process.kill", {"pid": pid})

        asyncio.run(scan())
    except Exception as e:  # noqa: BLE001
        check("smart auth 2 live run", False, error=f"{type(e).__name__}: {str(e)[:300]}")
    finally:
        try:
            api.delete(f"/api/v1/agents/{aid}?confirm=true")
            RES["probe_deleted"] = True
        except Exception as e:  # noqa: BLE001
            RES["probe_deleted"] = f"failed: {e}"
    RES["finished"] = time.time()
    RES["summary"] = {s: sum(1 for c in RES["checks"] if c["status"] == s) for s in ("PASS", "FAIL")}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(RES, indent=2, default=str))
    print(json.dumps(RES["summary"]))
    return 0 if RES["summary"]["FAIL"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
