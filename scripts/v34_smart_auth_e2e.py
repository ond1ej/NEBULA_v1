#!/usr/bin/env python3
"""NEBULA 3.4 — Smart Authentication 3.0 on the real hardware: the real `nebula-vault` broker with real headless
Chromium in the Ubuntu VM against a synthetic sign-in site served inside the VM. No AI requests, no owner vault, no
real accounts (real Microsoft pages are only loaded in part C; nothing is typed there).

The fixture covers the 20 scenarios of the V3.4 brief plus shadow-DOM and same-origin-iframe forms and a local copy
of a typical self-hosted web app's sign-in form (username + password, JavaScript JSON login, same address
after success, session cookie on a sub-path) for the negative tests (wrong password, empty fields, connection drop,
timeout, page change, cancel) — so no real account is ever locked.

WebAuthn needs a secure context: the passkey / security-key pages are served on http://localhost (a secure
context; rpId 'localhost'), where the browser's real WebAuthn API is available. (V3.3's fixture ran on the VM's
http:// IP, where browsers expose no WebAuthn at all — its "WebAuthn hidden" check therefore proved nothing.)

Part A drives the broker over the guest RPC. Part B runs the NEBULA host in-process (temporary data dir + temporary
test vault, real VM guest, scripted model) for agent -> detection -> owner request -> broker -> browser -> agent,
including the Telegram Mini App path through the real gateway code. Part C: real Teams -> Microsoft sign-in (GREEN).

Results: build/e2e/v34-smart-auth.json
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

OUT = ROOT / "build/e2e/v34-smart-auth.json"
RES: dict = {"checks": [], "started": time.time(), "ai_requests": 0, "timing": {}}

SITE = r'''
import hashlib, http.server, json, secrets, sys, urllib.parse, pathlib, threading, time
CFG = json.loads(pathlib.Path(sys.argv[1]).read_text())
P1, P2 = CFG["p1"], CFG["p2"]
MARK = pathlib.Path(CFG["mark"])
USER, PKUSER, CTFUSER = CFG["user"], CFG["pkuser"], CFG["ctfuser"]
PWH, OTPH, EOTPH, CTFPWH = CFG["pwh"], CFG["otph"], CFG["eotph"], CFG["ctfpwh"]
SESS, APPROVE = {}, {"n": None, "ok": False}
h = lambda s: hashlib.sha256(s.encode()).hexdigest()
def mark(s):
    with MARK.open("a") as f: f.write(s + "\n")
CSS = ("<style>body{font-family:sans-serif}.hidden{display:none}.view{transition:opacity .45s}.gone{opacity:0}"
       ".moveOffScreen{position:fixed;bottom:0;left:0;width:1px;height:1px;opacity:.01}.num{font-size:40px}</style>")
def page(title, body, js=""):
    return ("<html><head><title>%s</title>%s</head><body><div id=app>%s</div><script>%s</script></body></html>"
            % (title, CSS, body, js))
def fm(action, title, inner, err="", button="Sign in", extra=""):
    return ('<form method=post action="%s"%s><h1 role=heading>%s</h1><div role=alert class=error>%s</div>%s'
            '<input type=submit value="%s"></form>') % (action, extra, title, err, inner, button)
UN = '<input type=text name=username autocomplete=username aria-label=Username>'
EM = '<input type=email name=email autocomplete=username aria-label=Email>'
PW = '<input type=password name=password autocomplete=current-password aria-label=Password>'
CODE = '<input name=otc type=text autocomplete=one-time-code inputmode=numeric maxlength=6 aria-label=Code>'
KMSI = ('<form method=post action="/kmsi"><h1 role=heading>Stay signed in?</h1><p>Do this to reduce the number of '
        'times you are asked to sign in.</p><button type=submit name=answer value=yes>Yes</button> '
        '<button type=submit name=answer value=no>No</button></form>')
def home(who):
    return page("Account", "<h1>Dashboard</h1><p>Welcome back, fixture user (%s)</p><a href='/logout'>Sign out</a>" % who)
PW_VIEW_JS = """function pwView(u){ const v2=document.createElement('form'); v2.className='view gone'; v2.method='post';
 v2.action='/ms/login'; v2.innerHTML='<h1 role=heading>Enter password</h1><div role=alert class=error></div>'+
 '<input type=email name=loginfmt class=moveOffScreen aria-hidden=true tabindex=-1 value="'+String(u).replace(/[^\\w@.+-]/g,'')+'">'+
 '<input type=password name=passwd autocomplete=current-password aria-label=Password><input type=submit value="Sign in">';
 document.getElementById('app').appendChild(v2); requestAnimationFrame(()=>requestAnimationFrame(()=>v2.classList.remove('gone'))); }
function swapTo(u){ const v1=document.getElementById('f1')||document.getElementById('pk'); v1.classList.add('gone');
 setTimeout(()=>{ v1.remove(); pwView(u); }, 450); }"""
EMAIL_VIEW = """<form id=f1 class=view method=post action="/ms/login" onsubmit="return next(event)">
<h1 role=heading>Sign in</h1><div id=err1 role=alert class=error></div>
<input type=email name=loginfmt autocomplete=username aria-label="Email, phone, or Skype">
<input type=submit value=Next></form>"""
MS_JS = PW_VIEW_JS + """
async function next(e){ e.preventDefault(); const u=document.querySelector('[name=loginfmt]').value;
 const fido=!!(window.PublicKeyCredential && navigator.credentials && navigator.credentials.get);
 const r=await (await fetch('/ms/GetCredentialType',{method:'POST',headers:{'content-type':'application/json'},
   body:JSON.stringify({username:u,isFidoSupported:fido})})).json();
 if(r.route==='fido'){ location.href=r.fido_url; return false; }
 if(r.route==='unknown'){ document.getElementById('err1').textContent='This username may be incorrect.'; return false; }
 swapTo(u); return false; }"""
WEBAUTHN = """(async () => { const q = new URLSearchParams(location.search); const back = q.get('cancelUrl') || '/';
 try { await navigator.credentials.get({publicKey: {challenge: new Uint8Array(32), rpId: 'localhost', timeout: 600000,
   userVerification: 'required', allowCredentials: [{type: 'public-key', id: new Uint8Array(16), transports: __T__}]}});
   location.href = back; }
 catch (e) { await fetch('/mark?m=__M__:' + e.name).catch(() => 0); __AFTER__ } })();"""
CTF_LOGIN = """<h1 id=loginTitle class=auth-title>Přihlášení</h1>
<form id=loginForm class=auth-form novalidate>
<label for=username>Uživatelské jméno</label><input type=text id=username name=username autocomplete=username autocapitalize=off spellcheck=false maxlength=64 required autofocus>
<label for=password>Heslo</label><input type=password id=password name=password autocomplete=current-password maxlength=1024 required>
<button type=button id=togglePassword aria-label="Zobrazit heslo">👁</button>
<div id=loginError class="auth-error hidden" role=alert></div>
<button type=submit id=loginSubmit><span id=loginSubmitLabel>Přihlásit se</span></button></form>"""
CTF_JS = """(function(){ var form=document.getElementById('loginForm'); var user=document.getElementById('username');
 var pass=document.getElementById('password'); var btn=document.getElementById('loginSubmit'); var errBox=document.getElementById('loginError');
 function showError(m){ errBox.textContent=m; errBox.classList.remove('hidden'); }
 function setLoading(on){ btn.disabled=on; user.disabled=on; pass.disabled=on; btn.setAttribute('aria-busy', on?'true':'false'); }
 form.addEventListener('submit', function(ev){ ev.preventDefault(); errBox.classList.add('hidden');
  if(!user.value.trim()||!pass.value){ showError('Vyplňte uživatelské jméno i heslo.'); return; }
  setLoading(true);
  fetch('api.php?r=auth.login',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-Requested-With':'CTFWS'},
   body:JSON.stringify({username:user.value.trim(),password:pass.value})}).then(function(res){ return res.json().catch(function(){return {};}).then(function(d){return {res:res,data:d};}); })
  .then(function(r){ if(r.res.ok&&r.data&&r.data.ok){ pass.value=''; window.location.replace('./'); return; }
   setLoading(false); showError((r.data&&r.data.message)||'Přihlášení se nezdařilo.'); pass.value=''; })
  .catch(function(){ setLoading(false); showError('Server není dostupný. Zkontrolujte připojení a zkuste to znovu.'); });
 }); })();"""
SWAP_JS = """setTimeout(function(){ document.getElementById('app').innerHTML = '<form method=post action="/ctf/otp"><h1 role=heading>Ověření</h1>'+
 '<p>Zadejte ověřovací kód z SMS.</p><input name=otc type=text autocomplete=one-time-code inputmode=numeric maxlength=6 aria-label=Kód>'+
 '<input type=submit value=Ověřit></form>'; }, 2500);"""
DYN = """<div aria-busy=true><p>Loading…</p></div>"""
DYN_JS = """setTimeout(()=>{ const app=document.getElementById('app');
 app.innerHTML='<form id=f method=post action="/dyn/login" onsubmit="return go(event)"><h1 role=heading>Sign in</h1><div role=alert class=error></div>'+
  '<input type=email name=email autocomplete=username aria-label=Email><input type=submit value=Next></form>';
 let k=0; const t=setInterval(()=>{ document.body.dataset.k=++k; if(k>6) clearInterval(t); }, 100); }, 1200);
async function go(e){ e.preventDefault(); const app=document.getElementById('app'); app.innerHTML='<p aria-busy=true>Checking…</p>';
 await new Promise(r=>setTimeout(r,900)); app.innerHTML='<form method=post action="/dyn/login"><h1 role=heading>Enter password</h1>'+
 '<div role=alert class=error></div><input type=password name=password autocomplete=current-password aria-label=Password>'+
 '<input type=submit value="Sign in"></form>'; return false; }"""
SHADOW_JS = """customElements.define('nebula-login', class extends HTMLElement { constructor(){ super();
 const r=this.attachShadow({mode:'open'}); r.innerHTML='<form method=post action="/shadow/login"><h1 role=heading>Sign in</h1>'+
 '<div role=alert class=error></div><input type=text name=username autocomplete=username aria-label=Username>'+
 '<input type=password name=password autocomplete=current-password aria-label=Password><input type=submit value="Sign in"></form>'; } });"""
def cookie_session(who, path="/"):
    sid = secrets.token_hex(16); SESS[sid] = who
    return ("Set-Cookie", "sid=%s; HttpOnly; Path=%s" % (sid, path)) if who != "ctf" else \
        ("Set-Cookie", "ctfsess=%s; HttpOnly; SameSite=Lax; Path=/ctf/" % sid)
class H(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, *a): pass
    def send(self, code, body, headers=(), ctype="text/html; charset=utf-8"):
        raw = body.encode()
        self.send_response(code)
        for k, v in headers: self.send_header(k, v)
        self.send_header("Content-Type", ctype); self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store"); self.end_headers(); self.wfile.write(raw)
    def redirect(self, to, headers=()):
        return self.send(302, "", [("Location", to), *headers])
    def form(self):
        n = int(self.headers.get("Content-Length") or 0); raw = self.rfile.read(n).decode()
        if (self.headers.get("Content-Type") or "").startswith("application/json"): return json.loads(raw or "{}")
        return {k: v[0] for k, v in urllib.parse.parse_qs(raw).items()}
    def who(self, name="sid"):
        for part in (self.headers.get("Cookie") or "").split(";"):
            k, _, v = part.strip().partition("=")
            if k == name and v in SESS: return SESS[v]
        return None
    def do_GET(self):
        u = urllib.parse.urlsplit(self.path); p = u.path; q = dict(urllib.parse.parse_qsl(u.query))
        if p == "/mark": mark(q.get("m", "")[:80]); return self.send(200, "ok", ctype="text/plain")
        if self.server.server_port == P2:
            if p == "/fido/get":
                js = WEBAUTHN.replace("__T__", "['internal','hybrid']").replace("__M__", "FIDO_ERR").replace(
                    "__AFTER__", "location.href = back;")
                return self.send(200, page("Sign in", "<h1 role=heading>Sign in with a passkey</h1><p>Waiting for "
                                                      "your passkey…</p>", js))
            return self.send(404, "no")
        if p == "/home":
            w = self.who(); return self.send(200, home(w)) if w else self.redirect("/up/start")
        if p == "/logout": return self.send(200, page("Signed out", "<p>Signed out</p>"))
        if p == "/up/start": return self.send(200, page("Sign in", fm("/up/login", "Sign in", UN + PW)))
        if p == "/ep/start": return self.send(200, page("Sign in", fm("/ep/login", "Sign in", EM + PW)))
        if p == "/un/start": return self.send(200, page("Sign in", fm("/un/next", "Sign in", UN, button="Next")))
        if p == "/pw/start":
            return self.send(200, page("Sign in", fm("/pw/login", "Enter password", '<input type=hidden name=username '
                                                     'value="%s">' % USER + PW)))
        if p == "/eotp/start": return self.send(200, page("Sign in", fm("/eotp/login", "Sign in", EM + PW)))
        if p == "/approve/start": return self.send(200, page("Sign in", fm("/approve/login", "Enter password", PW)))
        if p == "/approve/ok": APPROVE["ok"] = True; mark("APPROVED"); return self.send(200, "ok", ctype="text/plain")
        if p == "/approve/status":
            return self.send(200, json.dumps({"ok": APPROVE["ok"]}), ctype="application/json")
        if p == "/approve/done":
            return self.send(200, page("Stay signed in?", KMSI), [cookie_session("approve")]) if APPROVE["ok"] \
                else self.redirect("/approve/start")
        if p == "/ms/start": return self.send(200, page("Sign in to your account", EMAIL_VIEW, MS_JS))
        if p == "/ms/reprocess":
            body = ('<div id=pk class=view><h1 role=heading>Sign in another way</h1>'
                    '<button type=button onclick="swapTo(\'%s\')">Use your password</button> '
                    '<button type=button>Approve a request on my Microsoft Authenticator app</button></div>'
                    % q.get("u", "").replace("'", ""))
            return self.send(200, page("Sign in to your account", body, PW_VIEW_JS))
        if p == "/sk/start":
            after = ("document.getElementById('app').innerHTML = '<h1 role=heading>Use your security key</h1>' + "
                     "'<p>We could not use your security key.</p><a href=\"/sk/other\">Sign in another way</a>';")
            js = WEBAUTHN.replace("__T__", "['usb','nfc']").replace("__M__", "SK_ERR").replace("__AFTER__", after)
            return self.send(200, page("Sign in", "<h1 role=heading>Insert your security key</h1><p>Touch your "
                                                  "security key to continue.</p>", js))
        if p == "/sk/other":
            return self.send(200, page("Sign in", '<h1 role=heading>Choose a way to sign in</h1>'
                                                  '<a href="/sk/pw">Use your password</a> <a href="/alt/sms">Text +XX XXX XXX 42</a>'))
        if p == "/sk/pw": return self.send(200, page("Sign in", fm("/sk/login", "Enter password", PW)))
        if p == "/alt/start":
            return self.send(200, page("Sign in", '<h1 role=heading>Choose a way to sign in</h1>'
                                                  '<a href="/sk/pw">Use your password</a> <a href="/alt/sms">Text +XX XXX XXX 42</a> '
                                                  '<a href="/approve/start">Approve a request on my Microsoft Authenticator app</a>'))
        if p == "/alt/sms":
            return self.send(200, page("Verify", fm("/alt/code", "Enter code", "<p>We texted your phone +XX XXXXXXXX42."
                                                    "</p>" + CODE, button="Verify")))
        if p == "/dyn/start": return self.send(200, page("Sign in", DYN, DYN_JS))
        if p == "/shadow/start": return self.send(200, page("Sign in", "<nebula-login></nebula-login>", SHADOW_JS))
        if p == "/frame/start":
            return self.send(200, page("Portal", '<h1>Welcome to the portal</h1><iframe src="/frame/inner" '
                                                 'style="width:520px;height:420px;border:0"></iframe>'))
        if p == "/frame/inner":
            return self.send(200, page("Sign in", fm("/frame/login", "Sign in", UN + PW, extra=" target=_top")))
        if p == "/evil/start":
            return self.send(200, page("Sign in", '<form method=post action="https://login-microsoftonline.com/common/'
                                                  'login"><h1 role=heading>Sign in</h1><input type=email name=loginfmt '
                                                  'autocomplete=username aria-label="Email"><input type=submit value=Next>'
                                                  '</form>'))
        if p == "/loop/start":
            return self.send(200, page("Sign in", EMAIL_VIEW, "function next(e){e.preventDefault();return false;}"))
        if p in ("/ctf/", "/ctf/index.php"):
            if self.who("ctfsess") == "ctf":
                return self.send(200, page("CTF Writeup Studio", "<h1>CTF Writeup Studio</h1><p>Přihlášen jako "
                                                                 "fixture-ctf</p><button id=logout>Odhlásit</button>"))
            return self.send(200, page("Přihlášení · CTF Writeup Studio", CTF_LOGIN,
                                       CTF_JS + (SWAP_JS if q.get("swap") else "")))
        if p == "/ctf": return self.redirect("/ctf/")
        return self.send(404, "no")
    def do_POST(self):
        u = urllib.parse.urlsplit(self.path); p = u.path; q = dict(urllib.parse.parse_qsl(u.query))
        if self.server.server_port == P2: return self.send(404, "no")
        if p == "/ctf/api.php" and q.get("r") == "auth.login":
            b = self.form(); mark("CTF_API:" + ("user" if b.get("username") else "empty"))
            if b.get("username") == "drop-user":
                self.close_connection = True; self.connection.close(); return
            if b.get("username") == "slow-user":
                time.sleep(30); return self.send(401, json.dumps({"ok": False, "message": "Nesprávné údaje."}),
                                                 ctype="application/json")
            if b.get("username") == CTFUSER and h(b.get("password", "")) == CTFPWH:
                mark("CTF_OK"); return self.send(200, json.dumps({"ok": True}), [cookie_session("ctf")],
                                                 ctype="application/json")
            mark("CTF_BAD")
            return self.send(401, json.dumps({"ok": False, "message": "Nesprávné uživatelské jméno nebo heslo."}),
                             ctype="application/json")
        b = self.form()
        ok_pw = lambda v: h(v or "") == PWH
        if p == "/ms/GetCredentialType":
            mark("FIDO:%s" % bool(b.get("isFidoSupported")))
            if b.get("username") not in (USER, PKUSER):
                return self.send(200, json.dumps({"route": "unknown"}), ctype="application/json")
            if b.get("username") == PKUSER and b.get("isFidoSupported"):
                back = "http://localhost:%d/ms/reprocess?u=%s" % (P1, urllib.parse.quote(PKUSER))
                return self.send(200, json.dumps({"route": "fido", "fido_url": "http://localhost:%d/fido/get?cancelUrl=%s"
                                                  % (P2, urllib.parse.quote(back, safe=""))}), ctype="application/json")
            return self.send(200, json.dumps({"route": "password"}), ctype="application/json")
        if p == "/ms/login":
            if not ok_pw(b.get("passwd")):
                mark("PW_BAD")
                return self.send(200, page("Sign in", fm("/ms/login", "Enter password", '<input type=password name=passwd '
                                 'autocomplete=current-password aria-label=Password>',
                                 err="Your account or password is incorrect.")))
            mark("PW_OK")
            return self.send(200, page("Verify", fm("/ms/otp", "Enter code", "<p>We texted your phone +XX XXXXXXXX42. "
                                                    "Please enter the code to sign in.</p>" + CODE, button="Verify")))
        if p == "/ms/otp":
            if h(b.get("otc", "")) != OTPH:
                return self.send(200, page("Verify", fm("/ms/otp", "Enter code", "<p>We texted your phone.</p>" + CODE,
                                                        err="That code didn't work. Check the code and try again.")))
            return self.send(200, page("Stay signed in?", KMSI), [cookie_session("ms")])
        if p == "/kmsi": mark("KMSI:" + str(b.get("answer"))); return self.redirect("/home")
        if p in ("/up/login", "/shadow/login", "/frame/login"):
            if b.get("username") == USER and ok_pw(b.get("password")):
                return self.redirect("/home", [cookie_session(p.split("/")[1])])
            return self.send(200, page("Sign in", fm(p, "Sign in", UN + PW, err="Your username or password is incorrect.")))
        if p == "/ep/login":
            if b.get("email") == USER and ok_pw(b.get("password")): return self.redirect("/home", [cookie_session("ep")])
            return self.send(200, page("Sign in", fm(p, "Sign in", EM + PW, err="Incorrect email or password.")))
        if p == "/un/next":
            if b.get("username") != USER:
                return self.send(200, page("Sign in", fm("/un/next", "Sign in", UN, err="We couldn't find that account.",
                                                         button="Next")))
            return self.send(200, page("Sign in", fm("/un/login", "Enter password", '<input type=hidden name=username '
                                                     'value="%s">' % USER + PW)))
        if p in ("/un/login", "/pw/login"):
            if b.get("username") == USER and ok_pw(b.get("password")):
                return self.redirect("/home", [cookie_session(p.split("/")[1])])
            return self.send(200, page("Sign in", fm(p, "Enter password", '<input type=hidden name=username value="%s">'
                                                     % USER + PW, err="Incorrect password.")))
        if p == "/eotp/login":
            if b.get("email") == USER and ok_pw(b.get("password")):
                return self.send(200, page("Verify", fm("/eotp/code", "Check your email", "<p>We emailed you a code. "
                                                        "Check your inbox and enter the code.</p>" + CODE, button="Verify")))
            return self.send(200, page("Sign in", fm(p, "Sign in", EM + PW, err="Incorrect email or password.")))
        if p == "/eotp/code":
            if h(b.get("otc", "")) == EOTPH: return self.redirect("/home", [cookie_session("eotp")])
            return self.send(200, page("Verify", fm(p, "Check your email", CODE, err="That code is incorrect.")))
        if p == "/approve/login":
            if not ok_pw(b.get("password")):
                return self.send(200, page("Sign in", fm(p, "Enter password", PW, err="Incorrect password.")))
            APPROVE.update(n="%02d" % (secrets.randbelow(90) + 10), ok=False); mark("APPROVE_N:" + APPROVE["n"])
            js = ("setInterval(async()=>{ const r=await (await fetch('/approve/status')).json();"
                  " if(r.ok) location.href='/approve/done'; }, 800);")
            return self.send(200, page("Approve sign in request", '<h1 role=heading>Approve sign in request</h1><p>Open '
                                       'your Authenticator app, and enter the number shown to sign in.</p><div class=num>'
                                       '%s</div>' % APPROVE["n"], js))
        if p in ("/sk/login", "/dyn/login"):
            if ok_pw(b.get("password")): return self.redirect("/home", [cookie_session(p.split("/")[1])])
            return self.send(200, page("Sign in", fm(p, "Enter password", PW, err="Incorrect password.")))
        if p == "/alt/code":
            if h(b.get("otc", "")) == OTPH: return self.redirect("/home", [cookie_session("alt")])
            return self.send(200, page("Verify", fm(p, "Enter code", CODE, err="That code didn't work.")))
        return self.send(404, "no")
for port in (P1, P2):
    s = http.server.ThreadingHTTPServer(("0.0.0.0", port), H)
    threading.Thread(target=s.serve_forever, daemon=True).start()
threading.Event().wait()
'''


def check(name: str, ok: bool, **detail) -> bool:
    RES["checks"].append({"name": name, **detail, "status": "PASS" if ok else "FAIL"})
    print(("PASS " if ok else "FAIL ") + name, json.dumps(detail, default=str)[:420] if detail else "", flush=True)
    return ok


def roles(ev: dict) -> list[str]:
    return [f["role"] for f in ((ev.get("step") or {}).get("fields") or [])]


def kind(ev: dict) -> str | None:
    return (ev.get("step") or {}).get("step")


# ============================================================================ part A: the broker itself
async def part_a(gc, aid: str, LO: str, LO2: str, cfg: dict) -> None:
    user, pkuser, pw, otp, eotp = cfg["user"], cfg["pkuser"], cfg["pw"], cfg["otp"], cfg["eotp"]
    ctfuser, ctfpw = cfg["ctfuser"], cfg["ctfpw"]

    async def start(path: str, origin: str = LO, allowed: list[str] | None = None, **extra):
        sid = "as_" + secrets.token_hex(12)
        t0 = time.time()
        ev = await gc.call("vault.auth_start", {"session_id": sid, "agent_id": aid, "origin": origin,
                                                "allowed_origins": allowed or [origin], "url": origin + path,
                                                "timeout_s": 300, **extra}, timeout=200)
        return sid, ev, round((time.time() - t0) * 1000)

    async def fill(sid, ev, *values, step_id=None):
        vals = {f["id"]: v for f, v in zip((ev.get("step") or {}).get("fields") or [], values, strict=False)}
        return await gc.call("vault.auth_step", {"session_id": sid, "agent_id": aid,
                                                 "step_id": step_id or ev.get("step_id"), "values": vals}, timeout=150)

    async def choose(sid, ev, want: str):
        alt = next((a["id"] for a in (ev.get("step") or {}).get("alternatives") or [] if a["kind"] == want), None)
        if not alt:
            return {}
        return await gc.call("vault.auth_choose", {"session_id": sid, "agent_id": aid, "alt_id": alt}, timeout=90)

    async def poll(sid, wait_s=20):
        return await gc.call("vault.auth_poll", {"session_id": sid, "agent_id": aid, "wait_s": wait_s}, timeout=80)

    async def observe(sid):
        return await gc.call("vault.auth_observe", {"session_id": sid, "agent_id": aid}, timeout=70)

    async def sh(cmd: str) -> str:
        out = await gc.tool(aid, "shell.execute", {"command": cmd, "timeout": 30})
        return ((out.get("result") or {}).get("stdout") or "")

    async def marks() -> list[str]:
        return [x for x in (await sh(f"cat {cfg['mark']} 2>/dev/null || true")).split("\n") if x]

    async def cancel(sid):
        try:  # a finished session is already gone in the guest
            await gc.call("vault.auth_cancel", {"session_id": sid, "agent_id": aid}, timeout=20)
        except Exception:  # noqa: BLE001
            pass

    last = {"sid": None}
    _start = start

    async def start(path: str, origin: str = LO, allowed: list[str] | None = None, **extra):  # noqa: F811
        if last["sid"]:
            await cancel(last["sid"])  # never leave a session open: one sign-in per agent at a time
        sid, ev, ms = await _start(path, origin, allowed, **extra)
        last["sid"] = sid
        return sid, ev, ms

    async def agent_sees(url: str, text: str) -> bool:
        await gc.tool(aid, "browser.navigate", {"url": url})
        obs = json.dumps((await gc.tool(aid, "browser.observe", {})).get("result") or {}, ensure_ascii=False)
        return text in obs

    def signed(res: dict, evidence: str | None = None) -> bool:
        return res.get("event") == "result" and res.get("status") == "authenticated" and \
            res.get("cookies_imported", 0) >= 1 and (evidence is None or res.get("evidence") == evidence)

    # S01 username + password on one form
    sid, ev, _ = await start("/up/start")
    r1 = roles(ev)
    res = await fill(sid, ev, user, pw)
    check("S01 username + password form -> exactly those two fields -> verified sign-in",
          kind(ev) == "identifier_password" and r1 == ["username", "password"] and signed(res, "signout_control"),
          step=kind(ev), roles=r1, result=res.get("status"), evidence=res.get("evidence"))
    # S02 e-mail + password on one form
    sid, ev, _ = await start("/ep/start")
    r1 = roles(ev)
    res = await fill(sid, ev, user, pw)
    check("S02 e-mail + password form -> e-mail and password fields -> verified sign-in",
          r1 == ["email", "password"] and signed(res), roles=r1, result=res.get("status"))
    # S03 Microsoft-style e-mail -> password (single page swap) ; S14 wrong password ; S06 SMS ; KMSI
    sid, ev, ms = await start("/ms/start")
    ok1 = kind(ev) == "identifier" and roles(ev) == ["email"]
    t0 = time.time()
    ev2 = await fill(sid, ev, user) if ok1 else {}
    e2p = round((time.time() - t0) * 1000)
    m = await marks()
    check("S03 e-mail -> PASSWORD step (single-page swap with a hidden e-mail copy), never the e-mail form again",
          ok1 and kind(ev2) == "password" and roles(ev2) == ["password"] and not ev2.get("error"),
          first=kind(ev), next=kind(ev2), next_roles=roles(ev2), start_ms=ms, email_to_password_ms=e2p,
          phases=ev2.get("timing"))
    check("S03 the site learned the browser's real capabilities (WebAuthn present, not hidden) and still went to "
          "the password for an account without a passkey", "FIDO:True" in m, marks=m[-4:])
    RES["timing"].update(start_to_first_step_ms=ms, email_to_password_ms=e2p, email_to_password_phases=ev2.get("timing"))
    bad = await fill(sid, ev2, "wrong-" + pw)
    check("S14 wrong password -> the same password step, 'rejected' (the site showed its error)",
          kind(bad) == "password" and bad.get("error") == "rejected", step=kind(bad), error=bad.get("error"))
    ev3 = await fill(sid, bad, pw)
    o = (ev3.get("step") or {}).get("otp") or {}
    check("S06 password -> SMS code step (6 digits, channel sms)", kind(ev3) == "otp" and o.get("channel") == "sms" and
          o.get("length") == 6, step=kind(ev3), otp=o)
    res = await fill(sid, ev3, otp) if kind(ev3) == "otp" else {}
    m = await marks()
    check("S06/S20 code -> 'Stay signed in?' answered No -> verified sign-in -> the agent's browser is signed in",
          signed(res) and "KMSI:no" in m and "declined_kmsi" in (res.get("auto") or []) and
          await agent_sees(LO + "/home", "fixture user (ms)"), status=res.get("status"), auto=res.get("auto"),
          evidence=res.get("evidence"))
    # S04 username -> password on two pages
    sid, ev, _ = await start("/un/start")
    ev2 = await fill(sid, ev, user)
    res = await fill(sid, ev2, pw) if kind(ev2) == "password" else {}
    check("S04 username page -> password page -> verified sign-in", roles(ev) == ["username"] and
          roles(ev2) == ["password"] and signed(res), first=roles(ev), next=roles(ev2), result=res.get("status"))
    # S05 password only
    sid, ev, _ = await start("/pw/start")
    res = await fill(sid, ev, pw)
    check("S05 password-only page -> only the password field -> verified sign-in", kind(ev) == "password" and
          roles(ev) == ["password"] and signed(res), step=kind(ev), roles=roles(ev), result=res.get("status"))
    # S07 e-mail one-time code
    sid, ev, _ = await start("/eotp/start")
    ev2 = await fill(sid, ev, user, pw)
    o = (ev2.get("step") or {}).get("otp") or {}
    res = await fill(sid, ev2, eotp) if kind(ev2) == "otp" else {}
    check("S07 e-mail code step (channel email) -> code -> verified sign-in",
          kind(ev2) == "otp" and o.get("channel") == "email" and signed(res), otp=o, result=res.get("status"))
    # S08 authenticator approval with number matching
    sid, ev, _ = await start("/approve/start")
    ev2 = await fill(sid, ev, pw)
    n = next((x.split(":", 1)[1] for x in reversed(await marks()) if x.startswith("APPROVE_N:")), None)
    shown = (ev2.get("step") or {}).get("approval_number")
    waiting = await poll(sid, 3)
    await sh(f"curl -s http://localhost:{cfg['p1']}/approve/ok >/dev/null")
    res = await poll(sid)
    if res.get("event") == "step" and res.get("still_waiting"):
        res = await poll(sid)
    check("S08 authenticator approval: waiting step shows the site's number; after approval -> 'Stay signed in?' "
          "declined -> verified sign-in", kind(ev2) == "device_approval" and shown == n and
          waiting.get("still_waiting") is True and signed(res) and "declined_kmsi" in (res.get("auto") or []),
          step=kind(ev2), number_shown=shown, number_site=n, result=res.get("status"), auto=res.get("auto"))
    # S09 passkey (Microsoft-style FIDO page on another allowed origin; real WebAuthn request, no authenticator)
    sid, ev, _ = await start("/ms/start", allowed=[LO, LO2])
    t0 = time.time()
    ev2 = await fill(sid, ev, pkuser) if kind(ev) == "identifier" else {}
    pk_ms = round((time.time() - t0) * 1000)
    m = await marks()
    check("S09 passkey: the site's real WebAuthn request was cancelled like a person's Cancel (NotAllowedError), "
          "the site fell back, NEBULA chose 'Use your password' -> PASSWORD step",
          kind(ev2) == "password" and roles(ev2) == ["password"] and "FIDO_ERR:NotAllowedError" in m and
          {"passkey_cancelled", "chose_password"} <= set(ev2.get("auto") or []),
          step=kind(ev2), auto=ev2.get("auto"), marks=m[-3:], passkey_to_password_ms=pk_ms)
    RES["timing"]["passkey_to_password_ms"] = pk_ms
    await cancel(sid)
    # S10 physical security key -> other ways -> password
    sid, ev, _ = await start("/sk/start")
    m = await marks()
    check("S10 security key (USB/NFC request) recognised as a security key, cancelled, 'Sign in another way' "
          "opened, password chosen", kind(ev) == "password" and "SK_ERR:NotAllowedError" in m and
          {"security_key_cancelled", "opened_other_ways", "chose_password"} <= set(ev.get("auto") or []),
          step=kind(ev), auto=ev.get("auto"), marks=m[-2:])
    res = await fill(sid, ev, pw) if kind(ev) == "password" else {}
    check("S10 ... then the password signs in", signed(res), result=res.get("status"))
    sid, ev, _ = await start("/sk/start", passkey_fallback="ask")
    check("S10 with 'ask me first': the owner gets the security-key step with its other ways (no automatic choice)",
          kind(ev) in ("security_key", "method_choice") and ev.get("step", {}).get("alternatives"),
          step=kind(ev), alternatives=[a["kind"] for a in (ev.get("step") or {}).get("alternatives") or []],
          webauthn=(ev.get("step") or {}).get("webauthn"))
    await cancel(sid)
    # S11 alternative sign-in method chosen by the owner
    sid, ev, _ = await start("/alt/start", passkey_fallback="ask")
    kinds = sorted(a["kind"] for a in (ev.get("step") or {}).get("alternatives") or [])
    nxt = await choose(sid, ev, "code")
    res = await fill(sid, nxt, otp) if kind(nxt) == "otp" else {}
    check("S11 method choice (password / SMS / app) -> owner chose the SMS code -> code step -> verified sign-in",
          kind(ev) == "method_choice" and {"password", "code", "app"} <= set(kinds) and kind(nxt) == "otp" and
          signed(res), kinds=kinds, next=kind(nxt), result=res.get("status"))
    # S13 phishing lookalike target
    sid, ev, _ = await start("/evil/start")
    bl = await fill(sid, ev, user)
    check("S13 form posting to login-microsoftonline.com -> blocked by the broker before anything is sent",
          bl.get("event") == "blocked" and bl.get("origin") == "https://login-microsoftonline.com" and
          bl.get("reason") == "form_target", event=bl.get("event"), origin=bl.get("origin"))
    await cancel(sid)
    # S15 dynamic DOM (async rendering + delayed swap)
    sid, ev, dms = await start("/dyn/start")
    ev2 = await fill(sid, ev, user) if kind(ev) == "identifier" else {}
    res = await fill(sid, ev2, pw) if kind(ev2) == "password" else {}
    check("S15 dynamic page: the e-mail form rendered late (spinner, DOM still changing) and the password view "
          "rendered after a delay are each read only once the DOM settled", roles(ev) == ["email"] and
          roles(ev2) == ["password"] and signed(res), first=roles(ev), next=roles(ev2), start_ms=dms,
          diag=ev.get("diag"))
    # S17 page changed while the owner types; a stale answer never reaches the page
    sid, ev, _ = await start("/ctf/?swap=1")
    sent0 = len([x for x in await marks() if x.startswith("CTF_API")])
    await asyncio.sleep(3.2)
    late = await fill(sid, ev, ctfuser, "not-the-password")
    sent1 = len([x for x in await marks() if x.startswith("CTF_API")])
    check("S17 page changed while the owner was typing -> the old answer is refused (page_changed), nothing sent",
          (late.get("error") == "page_changed" or late.get("detail") == "page_changed") and sent1 == sent0,
          event=late.get("event"), error=late.get("error") or late.get("detail"), now=kind(late), sent=sent1 - sent0)
    stale = await fill(sid, ev, ctfuser, ctfpw, step_id=1)
    check("S17 an answer for an older step id is refused (stale_step)", stale.get("detail") == "stale_step",
          detail=stale.get("detail"))
    await cancel(sid)
    # X1 shadow DOM form
    sid, ev, _ = await start("/shadow/start")
    res = await fill(sid, ev, user, pw)
    check("X1 sign-in form inside a web component (open shadow DOM) -> fields found and filled -> signed in",
          roles(ev) == ["username", "password"] and signed(res), roles=roles(ev), result=res.get("status"))
    # X2 same-origin iframe
    sid, ev, _ = await start("/frame/start")
    res = await fill(sid, ev, user, pw)
    check("X2 sign-in form inside a same-origin frame -> read and filled there -> signed in",
          roles(ev) == ["username", "password"] and "same_origin_frame" in (ev.get("step") or {}).get("flags", []) and
          signed(res), roles=roles(ev), flags=(ev.get("step") or {}).get("flags"), result=res.get("status"))
    # X3-X7 copy of a typical web app sign-in form structure (local, synthetic account)
    sid, ev, _ = await start("/ctf/")
    r0 = roles(ev)
    bad = await fill(sid, ev, ctfuser, "wrong-" + ctfpw)
    check("X4 app-form copy: wrong password -> same username+password step, rejected (Czech error text)",
          r0 == ["username", "password"] and kind(bad) == "identifier_password" and bad.get("error") == "rejected",
          roles=r0, error=bad.get("error"))
    res = await fill(sid, bad, ctfuser, ctfpw)
    check("X3 app-form copy: JSON login, same address after success (location.replace('./')), session cookie on a "
          "sub-path -> verified sign-in, the session reaches the agent's browser",
          signed(res) and await agent_sees(LO + "/ctf/", "Přihlášen jako"), result=res.get("status"),
          evidence=res.get("evidence"), imported=res.get("cookies_imported"))
    sid, ev, _ = await start("/ctf/")
    before = len([x for x in await marks() if x.startswith("CTF_API")])
    try:
        emp = await fill(sid, ev, "", "x")
    except Exception as e:  # noqa: BLE001 - the VM service refuses empty values before they reach the broker
        emp = {"refused": f"{type(e).__name__}: {str(e)[:60]}"}
    after = len([x for x in await marks() if x.startswith("CTF_API")])
    check("X5 empty username -> refused before the page (VM service) or stopped by the site's own check; nothing "
          "sent, never a sign-in", (bool(emp.get("refused")) or emp.get("event") == "step") and before == after and
          emp.get("status") != "authenticated", refused=emp.get("refused"), error=emp.get("error"),
          sent=after - before)
    await cancel(sid)
    sid, ev, _ = await start("/ctf/")
    drop = await fill(sid, ev, "drop-user", "x-pass-1")
    check("X6 connection dropped during the login request -> not a sign-in and not 'wrong password'",
          drop.get("event") == "step" and drop.get("error") != "rejected" and kind(drop) == "identifier_password",
          error=drop.get("error"), step=kind(drop))
    await cancel(sid)
    sid, ev, _ = await start("/ctf/")
    t0 = time.time()
    slow = await fill(sid, ev, "slow-user", "x-pass-1")
    check("X7 the site does not answer (timeout) -> reported as a step NEBULA cannot confirm, never success",
          slow.get("status") != "authenticated" and (kind(slow) in ("unknown", "identifier_password") or
                                                     slow.get("status") == "unconfirmed"),
          step=kind(slow), status=slow.get("status"), error=slow.get("error"), seconds=round(time.time() - t0, 1))
    await cancel(sid)
    # X8 a page that never reacts
    sid, ev, _ = await start("/loop/start")
    np = await fill(sid, ev, user)
    check("X8 page that does not react -> 'no_progress' (never reported as wrong credentials)",
          np.get("event") == "step" and np.get("error") == "no_progress", error=np.get("error"))
    await cancel(sid)
    # security review finding 1: a password typed into the AGENT's browser (e.g. by the owner in Live Desktop)
    # never reaches the agent through browser_observe, and NEBULA empties such fields when a sign-in ends
    canary = "MASK-CANARY-" + secrets.token_hex(6)
    await gc.tool(aid, "browser.navigate", {"url": LO + "/up/start"})
    await gc.tool(aid, "browser.type", {"selector": "input[type=password]", "text": canary})
    obs = json.dumps((await gc.tool(aid, "browser.observe", {})).get("result") or {})
    cl = ((await gc.tool(aid, "browser.clear_secrets", {})).get("result") or {}).get("cleared")
    await gc.tool(aid, "browser.type", {"selector": "input[name=username]", "text": "visible-name"})
    obs2 = json.dumps((await gc.tool(aid, "browser.observe", {})).get("result") or {})
    check("review: a typed password never appears in browser_observe (masked); NEBULA clears it at the end",
          canary not in obs and '"masked": true' in obs and cl == 1 and "visible-name" in obs2,
          masked='"masked": true' in obs, cleared=cl)
    ps = await sh("ps -eo user,cmd | grep -c '[v]ault_auth.py' || true")
    chrome = await sh("ps -u nebula-vault -o pid= 2>/dev/null | wc -l")
    check("no broker process or isolated Chromium left after part A", ps.strip() in ("0", "") and
          chrome.strip() in ("0", ""), broker=ps.strip(), vault_processes=chrome.strip())


# ============================================================================ part B: host in-process + real VM
def part_b(gc, aid: str, ORG: str, cfg: dict, live_agent_row: dict) -> None:
    user, pw, otp, ctfuser, ctfpw = cfg["user"], cfg["pw"], cfg["otp"], cfg["ctfuser"], cfg["ctfpw"]
    tmp = Path(tempfile.mkdtemp(prefix="nebula-v34-e2e-"))
    os.environ.update(NEBULA_TESTING="1", NEBULA_SECRET_BACKEND="memory",  # noqa: S106
                      NEBULA_DATA_DIR=str(tmp / "data"), NEBULA_LOG_DIR=str(tmp / "logs"), NEBULA_PORT="3197")
    import httpx
    from fastapi.testclient import TestClient
    from nebula_host import auth, db, models, providers_service, remote
    from nebula_host import secrets as sec
    from nebula_host import vault as vaultmod
    from nebula_host.app import create_app
    from nebula_host.config import get_config
    from nebula_host.state import svc

    from tests.conftest import ScriptedProvider, call, done
    from tests.integration.test_v3_api import _Bridge
    from tests.unit.test_v3_units import BOT_TOKEN, make_init_data

    get_config.cache_clear()
    vaultmod.calibrate_kdf = lambda *a, **k: {"alg": "argon2id", "salt": vaultmod.b64e(os.urandom(16)),
                                              "time_cost": 2, "memory_kib": 8192, "parallelism": 1}
    app = create_app()
    owner_pw = "e2e test owner " + uuid.uuid4().hex
    with TestClient(app, base_url="http://127.0.0.1:3197") as c:
        assert isinstance(sec.store(), sec.MemoryStore)  # never the owner's keychain
        svc.guest = gc
        for obj in (svc.orch, svc.live, svc.telegram, svc.teams, svc.files, svc.resources):
            obj.guest = gc
        tok = auth.ensure_setup_token()
        r = c.post("/api/v1/auth/setup", json={"username": "owner", "password": owner_pw, "setup_token": tok},
                   headers={"Origin": "http://127.0.0.1:3197"})
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
        vpass = "e2e test vault passphrase 1"
        assert c.post("/api/v1/vault", json={"passphrase": vpass}, headers=h).status_code == 201

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

        def submit(s, client=c, headers=h, **body):
            t = client.post(f"/api/v1/smart-auth/sessions/{s['id']}/token", headers=headers).json()["data"]
            return client.post(f"/api/v1/smart-auth/sessions/{s['id']}/submit",
                               json={"request_id": t["request_id"], "token": t["token"], **body}, headers=headers)

        def run_task(url, twice=False):
            asyncio.run(gc.tool(aid, "browser.navigate", {"url": "about:blank"}))
            turns = [[call("request_sign_in", {"url": url}, "c1"), done()],
                     [call("browser_observe", {}, "c2"), done()]]
            if twice:
                turns.append([call("request_sign_in", {"url": url}, "c3"), done()])
            turns.append([call("task_complete", {"summary": "read the page", "success": True}, "c9"), done()])
            prov = ScriptedProvider(turns)
            providers_service.adapter_for = lambda pid: prov
            return c.post(f"/api/v1/agents/{aid}/tasks", json={"prompt": "Sign in and read the page"},
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
            res, obs = [], ""
            seen = set()
            for req in prov.requests:
                for m in req.messages:
                    if m.role == "tool" and m.tool_name == "request_sign_in" and m.tool_call_id not in seen:
                        seen.add(m.tool_call_id)
                        res.append(json.loads(m.content))
                    if m.role == "tool" and m.tool_name == "browser_observe":
                        obs = m.content
            return res, obs

        def fid(s, i=0):
            return s["request"]["fields"][i]["id"]

        # B1 the full chain with real Chromium (e-mail -> password -> SMS) and saving to the (test) vault
        t, prov = run_task(ORG + "/ms/start")
        s1 = sess(t["id"], "credentials")
        st1, roles1 = s1["state"], [f["role"] for f in s1["request"]["fields"]]
        submit(s1, action="credentials", values={fid(s1): user}, save="vault", name="Fixture Microsoft",
               review_confirmed=True)
        s2 = sess(t["id"], "credentials", seq_gt=s1["request"]["seq"])
        st2, roles2 = s2["state"], [f["role"] for f in (s2.get("request") or {}).get("fields") or []]
        submit(s2, action="credentials", values={fid(s2): pw}, review_confirmed=True)
        s3 = sess(t["id"], "otp", seq_gt=s2["request"]["seq"])
        st3 = s3["state"]
        submit(s3, action="code", values={fid(s3): otp}, review_confirmed=True)
        tt = finish(t)
        res, obs = tool_texts(prov)
        entries = c.get("/api/v1/vault/entries").json()["data"]
        det = vaultmod.VAULT.entry_detail(entries[0]["id"]) if entries else {}
        check("B1 agent -> EMAIL_REQUIRED -> PASSWORD_REQUIRED -> OTP_REQUIRED -> verified sign-in -> agent "
              "continues on the signed-in page", st1 == "EMAIL_REQUIRED" and roles1 == ["email"] and
              st2 == "PASSWORD_REQUIRED" and roles2 == ["password"] and st3 == "OTP_REQUIRED" and
              tt["state"] == "COMPLETED" and res and res[0].get("status") == "authenticated" and
              "fixture user (ms)" in obs, states=[st1, st2, st3], result=res and res[0].get("status"))
        check("B1 e-mail + password saved as ONE credential after the verified sign-in (code never saved)",
              len(entries) == 1 and det.get("username") == user and det.get("has_password") and
              entries[0]["origin"] == ORG and "login-email" in entries[0]["tags"], entries=len(entries),
              tags=entries[0]["tags"] if entries else None)
        # B2 own-app copy through the host: ONE request with both fields; then 'already signed in'
        t, prov = run_task(ORG + "/ctf/", twice=True)
        s = sess(t["id"], "credentials")
        both = [f["role"] for f in s["request"]["fields"]]
        empty = submit(s, action="credentials", values={fid(s, 0): "", fid(s, 1): ctfpw}, review_confirmed=True)
        s = sess(t["id"], "credentials")
        submit(s, action="credentials", values={fid(s, 0): ctfuser, fid(s, 1): ctfpw}, review_confirmed=True)
        tt = finish(t)
        res, obs = tool_texts(prov)
        check("B2 app-form copy: one request with username + password (IDENTIFIER_AND_PASSWORD_REQUIRED), empty "
              "username refused by NEBULA before the site, verified sign-in, agent reads the signed-in page",
              both == ["username", "password"] and empty.status_code == 400 and res and
              res[0].get("status") == "authenticated" and "Přihlášen jako" in obs,
              roles=both, empty=empty.status_code, result=[x.get("status") for x in res])
        check("B2 a second request_sign_in for the same site -> 'already_signed_in' (the agent's browser keeps the "
              "session), no new owner request", len(res) == 2 and res[1].get("status") == "already_signed_in",
              second=res[1].get("status") if len(res) > 1 else None)
        # B3 expired request
        t, prov = run_task(ORG + "/up/start")
        s = sess(t["id"], "credentials")
        with db.engine().begin() as conn:
            conn.execute(models.auth_sessions.update().where(models.auth_sessions.c.id == s["id"])
                         .values(expires_at=time.time() - 1))
        s = sess(t["id"], states={"EXPIRED"}, timeout=60)
        finish(t)
        res, _ = tool_texts(prov)
        check("S16 expired request -> EXPIRED, broker closed, the agent is told to ask the owner",
              s["state"] == "EXPIRED" and res and res[0].get("status") == "expired", state=s["state"],
              result=res and res[0].get("status"))
        # B4 vault locked -> the dialog says so and offers unlock; after unlock saving works
        c.post("/api/v1/vault/lock", headers=h)
        t, prov = run_task(ORG + "/ep/start")
        s = sess(t["id"], "credentials")
        v_locked = s["request"]["vault"]
        ul = c.post("/api/v1/vault/unlock", json={"passphrase": vpass}, headers=h)
        s = c.get(f"/api/v1/smart-auth/sessions/{s['id']}").json()["data"]
        v_open = s["request"]["vault"]
        sv = submit(s, action="credentials", values={fid(s, 0): user, fid(s, 1): pw}, save="vault",
                    review_confirmed=True)
        s_after = sess(t["id"], states={"AUTHENTICATED", "FAILED", "CANCELLED", "EXPIRED"}, timeout=90)
        finish(t)
        entries = c.get("/api/v1/vault/entries").json()["data"]
        check("S18 vault locked -> shown with its reason and an unlock option; after unlocking the save works and "
              "the same account (same origin + e-mail) is updated, not duplicated",
              v_locked.get("state") == "locked" and not v_locked.get("can_save") and v_locked.get("can_unlock") and
              ul.status_code == 200 and v_open.get("can_save") is True and sv.status_code == 202 and
              s_after["state"] == "AUTHENTICATED" and len(entries) == 1,
              locked=v_locked, unlocked=v_open, state=s_after["state"], entries=len(entries))
        # B5 Telegram Mini App path (real gateway code; owner session from bot-signed initData + fresh step-up)
        try:
            sec.store().set("nebula:telegram.bot_token", BOT_TOKEN)
            with db.engine().begin() as conn:
                conn.execute(models.telegram_users.insert().values(
                    id=str(uuid.uuid4()), telegram_user_id=7, chat_id=7, status="approved", permissions=["tasks"],
                    created_at=time.time()))
            gw = remote.build_gateway(3197, Path("/nonexistent"), forward_client=httpx.AsyncClient(
                transport=_Bridge(c), base_url="http://127.0.0.1:3197"))
            with TestClient(gw, base_url="http://127.0.0.1:3102") as g:
                mr = g.post("/api/mini/auth", json={"init_data": make_init_data(
                    BOT_TOKEN, user_id=7, extra={"query_id": uuid.uuid4().hex})})
                auth_h = {"authorization": f"Bearer {mr.json()['data']['token']}"}
                t, prov = run_task(ORG + "/up/start")
                s = sess(t["id"], "credentials")
                seen = g.get(f"/api/v1/smart-auth/sessions/{s['id']}", headers=auth_h).json()["data"]
                no_fresh = submit(seen, client=g, headers=auth_h, action="credentials",
                                  values={fid(seen, 0): user, fid(seen, 1): pw}, review_confirmed=True)
                su = g.post("/api/v1/auth/stepup", json={"method": "password", "password": owner_pw}, headers=auth_h)
                seen = g.get(f"/api/v1/smart-auth/sessions/{s['id']}", headers=auth_h).json()["data"]
                ok = submit(seen, client=g, headers=auth_h, action="credentials",
                            values={fid(seen, 0): user, fid(seen, 1): pw}, review_confirmed=True)
                RES["s19_debug"] = {"no_fresh": [no_fresh.status_code, no_fresh.text[:300]],
                                    "stepup": [su.status_code, su.text[:200]], "ok": [ok.status_code, ok.text[:300]],
                                    "seen_state": seen.get("state")}
                try:
                    tt = finish(t, timeout=120)
                except AssertionError:
                    RES["s19_debug"]["session"] = c.get(f"/api/v1/smart-auth/sessions/{s['id']}").json()["data"]
                    RES["s19_debug"]["task"] = c.get(f"/api/v1/tasks/{t['id']}").json()["data"]
                    c.post(f"/api/v1/smart-auth/sessions/{s['id']}/cancel", headers=h)
                    c.post(f"/api/v1/tasks/{t['id']}/cancel", headers=h)
                    finish(t, timeout=60)
                res, _ = tool_texts(prov)
                check("S19 Telegram Mini App answer (gateway path, owner role): refused without PIN/fresh step-up, "
                      "accepted after the step-up -> verified sign-in, same backend logic as the dashboard",
                      seen.get("request") is not None and no_fresh.status_code in (401, 403) and
                      su.status_code == 200 and ok.status_code == 202 and res and
                      res[0].get("status") == "authenticated",
                      first=no_fresh.status_code, stepup=su.status_code, second=ok.status_code,
                      result=res and res[0].get("status"))
        except Exception as e:  # noqa: BLE001
            check("S19 Telegram Mini App answer (gateway path)", False, error=f"{type(e).__name__}: {str(e)[:300]}")
        # B6 double submission + cancel
        t, prov = run_task(ORG + "/up/start")
        s = sess(t["id"], "credentials")
        tk = c.post(f"/api/v1/smart-auth/sessions/{s['id']}/token", headers=h).json()["data"]
        body = {"request_id": tk["request_id"], "token": tk["token"], "action": "credentials",
                "values": {fid(s, 0): user, fid(s, 1): "wrong-" + pw}, "review_confirmed": True}
        first = c.post(f"/api/v1/smart-auth/sessions/{s['id']}/submit", json=body, headers=h)
        again = c.post(f"/api/v1/smart-auth/sessions/{s['id']}/submit", json=body, headers=h)
        s = sess(t["id"], "credentials", seq_gt=s["request"]["seq"])
        c.post(f"/api/v1/smart-auth/sessions/{s['id']}/cancel", headers=h)
        s = sess(t["id"], states={"CANCELLED"}, timeout=30)
        finish(t)
        res, _ = tool_texts(prov)
        check("X9 repeated submission: the same answer cannot be sent twice (single-use token)",
              first.status_code == 202 and again.status_code in (400, 403, 409), first=first.status_code,
              again=again.status_code)
        check("X10 wrong password via the host -> LOGIN_ERROR with the same fields; then owner cancels -> "
              "CANCELLED, agent told not to ask again", s["state"] == "CANCELLED" and res and
              res[0].get("status") == "cancelled", state=s["state"], result=res and res[0].get("status"))
        # B7 lookalike destination: RED
        t, prov = run_task(ORG + "/evil/start")
        s = sess(t["id"], "credentials")
        submit(s, action="credentials", values={fid(s): user}, review_confirmed=True)
        s = sess(t["id"], states={"FAILED"})
        finish(t)
        res, _ = tool_texts(prov)
        check("S13 host: lookalike destination -> RED, stopped, agent told not to sign in there",
              s["state"] == "FAILED" and s["error_code"] == "suspicious_destination" and
              (s.get("trust") or {}).get("level") == "RED", trust=s.get("trust"))
        # B8 page change while the owner's form is open: request replaced, old answer refused
        t, prov = run_task(ORG + "/ctf/?swap=1")
        s = sess(t["id"], "credentials")
        old = c.post(f"/api/v1/smart-auth/sessions/{s['id']}/token", headers=h).json()["data"]
        s2 = sess(t["id"], seq_gt=s["request"]["seq"], timeout=40)
        stale = c.post(f"/api/v1/smart-auth/sessions/{s['id']}/submit",
                       json={"request_id": old["request_id"], "token": old["token"], "action": "credentials",
                             "values": {"f0": ctfuser, "f1": "x"}, "review_confirmed": True}, headers=h)
        check("S17 host: the page changed by itself -> the dialog is replaced (OTP_REQUIRED, page_changed) and the "
              "old answer is refused", s2["state"] == "OTP_REQUIRED" and (s2.get("request") or {}).get("error") ==
              "page_changed" and stale.status_code == 409, state=s2["state"], stale=stale.status_code)
        c.post(f"/api/v1/smart-auth/sessions/{s['id']}/cancel", headers=h)
        finish(t)
        # diagnostics: present, structural, no secrets
        evs = c.get(f"/api/v1/smart-auth/sessions/{s1['id']}").json()["data"]["events"]
        dg = [e for e in evs if e["type"] == "step.detected"]
        blob = json.dumps(evs)
        check("diagnostics: every detected step recorded with structural facts (quiet time, roles) and no "
              "value, URL query or page text", dg and all("diag" in (e.get("meta") or {}) for e in dg) and
              pw not in blob and user not in blob and otp not in blob,
              sample=(dg[0].get("meta") if dg else None))
        # C real Microsoft: Teams -> login.microsoftonline.com verified (GREEN), no question; nothing typed
        db.set_setting("smart_auth", {"allow_local_network": False, "observe_interval_s": 8})
        t, prov = run_task("https://teams.microsoft.com/v2/")
        try:
            s = sess(t["id"], timeout=150, states={"EMAIL_REQUIRED", "IDENTIFIER_REQUIRED", "IDENTIFIER_AND_PASSWORD_REQUIRED",
                                                   "REDIRECT_REVIEW_REQUIRED", "FAILED", "WAITING_FOR_USER",
                                                   "UNKNOWN_STEP"})
        except AssertionError as e:
            s = {"state": f"timeout: {e}"}
        check("C real Teams -> login.microsoftonline.com: verified relationship (GREEN), e-mail step, no warning "
              "(nothing typed, cancelled)", s.get("state") in ("EMAIL_REQUIRED", "IDENTIFIER_REQUIRED") and
              s.get("verified_origin") == "https://login.microsoftonline.com" and
              (s.get("trust") or {}).get("level") == "GREEN" and not (s.get("request") or {}).get("review_required"),
              state=s.get("state"), verified=s.get("verified_origin"), trust=s.get("trust"))
        if s.get("id"):
            c.post(f"/api/v1/smart-auth/sessions/{s['id']}/cancel", headers=h)
        finish(t)
        dbp = Path(get_config().db_path)
        blob = (dbp.read_bytes() + (Path(str(dbp) + "-wal").read_bytes() if Path(str(dbp) + "-wal").exists()
                                    else b"")).decode("latin-1")
        for p in (tmp / "logs").rglob("*"):
            if p.is_file():
                blob += p.read_text(errors="replace")
        check("host: passwords and codes absent from DB/WAL/logs (vault ciphertext only)",
              pw not in blob and otp not in blob and ctfpw not in blob)


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
    check("VM broker is V3.4 (protocol 3)", (cap.get("vault_broker") or {}).get("smart_auth_version") == 3,
          broker=cap.get("vault_broker"))
    api = e2e.Api(e2e.PORT)
    api.login_or_setup()
    probe = api.post("/api/v1/agents", {"name": "Smart Auth 3 Probe", "provider_id": "anthropic-api",
                                        "model_id": "smart-auth-probe", "permission_level": "STANDARD"},
                     headers={"Idempotency-Key": str(uuid.uuid4())})
    aid = probe["id"]
    cfg = {"user": "fixture-" + secrets.token_hex(4) + "@example.test",
           "pkuser": "passkey-" + secrets.token_hex(4) + "@example.test",
           "ctfuser": "fixture-ctf-" + secrets.token_hex(3),
           "pw": "CANARY-SA3-" + secrets.token_hex(12), "ctfpw": "CANARY-CTF-" + secrets.token_hex(12),
           "otp": f"{secrets.randbelow(900000) + 100000}", "eotp": f"{secrets.randbelow(900000) + 100000}",
           "p1": 18100 + secrets.randbelow(800), "p2": 19100 + secrets.randbelow(800)}
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
            cfg.update(ip=ip, mark=f"{home}/workspace/smart-auth3-fixture.mark")
            site_cfg = {k: cfg[k] for k in ("p1", "p2", "mark", "user", "pkuser", "ctfuser")}
            site_cfg.update(pwh=hashlib.sha256(cfg["pw"].encode()).hexdigest(),
                            otph=hashlib.sha256(cfg["otp"].encode()).hexdigest(),
                            eotph=hashlib.sha256(cfg["eotp"].encode()).hexdigest(),
                            ctfpwh=hashlib.sha256(cfg["ctfpw"].encode()).hexdigest())
            await gc.tool(aid, "files.write", {"path": "smart-auth3-fixture.py", "content": SITE})
            await gc.tool(aid, "files.write", {"path": "smart-auth3-fixture.json", "content": json.dumps(site_cfg)})
            st = await gc.tool(aid, "process.start", {"command": "python3 smart-auth3-fixture.py smart-auth3-fixture.json"})
            await asyncio.sleep(1.5)
            return (st.get("result") or {}).get("pid")

        pid = asyncio.run(setup())
        LO, LO2, ORG = f"http://localhost:{cfg['p1']}", f"http://localhost:{cfg['p2']}", f"http://{cfg['ip']}:{cfg['p1']}"
        RES["fixture"] = {"secure_context_origin": LO, "second_origin": LO2, "network_origin": ORG}
        try:
            if not os.environ.get("V34_ONLY_B"):
                asyncio.run(part_a(gc, aid, LO, LO2, cfg))
        except Exception as e:  # noqa: BLE001
            import traceback

            check("part A (broker in the VM)", False, error=f"{type(e).__name__}: {str(e)[:300]}",
                  where=traceback.format_exc()[-1500:])
        import sqlite3

        con = sqlite3.connect(f"file:{e2e.DATA / 'nebula.db'}?mode=ro", uri=True)
        con.row_factory = sqlite3.Row
        row = dict(con.execute("select * from agents where id=?", (aid,)).fetchone())
        con.close()
        try:
            if not os.environ.get("V34_ONLY_A"):
                part_b(gc, aid, ORG, cfg, row)
        except Exception as e:  # noqa: BLE001
            import traceback

            check("part B (host in-process + real VM)", False, error=f"{type(e).__name__}: {str(e)[:300]}",
                  where=traceback.format_exc()[-1500:])

        async def scan():
            tails = [cfg["pw"][-16:], cfg["ctfpw"][-16:], cfg["otp"], cfg["eotp"]]
            pat = " ".join(f"-e '{x}'" for x in tails)
            out = await gc.tool(aid, "shell.execute", {
                "command": f"grep -rIl --binary-files=text {pat} \"$HOME\" /tmp /dev/shm 2>/dev/null | "
                           f"grep -v smart-auth3-fixture | head -5; echo SCAN_DONE", "timeout": 120})
            o = (out.get("result") or {}).get("stdout", "")
            hits = [x for x in o.splitlines() if x and x != "SCAN_DONE"]
            check("passwords + codes absent from the agent's home (browser profile), /tmp, /dev/shm",
                  "SCAN_DONE" in o and not hits, hits=hits)
            ps = await gc.tool(aid, "shell.execute", {"command": "ps -eo user,cmd | grep -c '[v]ault_auth.py' || true",
                                                       "timeout": 10})
            check("no isolated broker process left running at the end", (ps.get("result") or {}).get(
                "stdout", "").strip() in ("0", ""), count=(ps.get("result") or {}).get("stdout", "").strip())
            if pid:
                await gc.tool(aid, "process.kill", {"pid": pid})

        asyncio.run(scan())
    except Exception as e:  # noqa: BLE001
        check("smart auth 3 live run", False, error=f"{type(e).__name__}: {str(e)[:300]}")
    finally:
        try:
            api.delete(f"/api/v1/agents/{aid}?confirm=true")
            RES["probe_deleted"] = True
        except Exception as e:  # noqa: BLE001
            RES["probe_deleted"] = f"failed: {e}"
    RES["finished"] = time.time()
    RES["summary"] = {s: sum(1 for c in RES["checks"] if c["status"] == s) for s in ("PASS", "FAIL")}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(RES, indent=2, default=str, ensure_ascii=False))
    print(json.dumps(RES["summary"]))
    return 0 if RES["summary"]["FAIL"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
