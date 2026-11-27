"""Guest side of Smart Authentication (V3.2.1): session manager validation, per-agent binding, cookie routing, output
whitelisting, and the isolated broker process' own safety checks (no Playwright needed here — the real multi-step
login runs in the VM: scripts/v321_smart_auth_e2e.py)."""

from __future__ import annotations

import asyncio
import json
import subprocess
import sys
from pathlib import Path

import pytest

GUEST = Path(__file__).resolve().parents[2] / "guest/guest-service"
sys.path.insert(0, str(GUEST))
SID = "as_" + "ab" * 12
CANARY = "CANARY-GUEST-SA-55aa"


class FakeProc:
    """Stands in for the systemd-run'd broker: replies with canned events, records what it received."""

    def __init__(self, replies):
        self.replies = list(replies)
        self.received: list[dict] = []
        self.returncode = None
        outer = self

        class W:
            def write(self, b):
                outer.received.append(json.loads(b))

            async def drain(self):
                return None

        class R:
            async def readline(self):
                return (json.dumps(outer.replies.pop(0)) + "\n").encode() if outer.replies else b""

        self.stdin, self.stdout = W(), R()

    async def wait(self):
        self.returncode = 0
        return 0

    def kill(self):
        self.returncode = -9


@pytest.fixture()
def vo(monkeypatch):
    from nebula_guest import vaultops

    vaultops._AUTH.clear()
    agents = {"a1": {"linux_user": "nebula_a1"}, "a2": {"linux_user": "nebula_a2"}}
    monkeypatch.setattr(vaultops.ws, "get_agent", lambda aid: agents[aid])
    monkeypatch.setattr(vaultops, "self_test", lambda: {"isolated": True, "installed": True})
    monkeypatch.setattr(vaultops, "smart_auth_ready", lambda: True)
    yield vaultops
    vaultops._AUTH.clear()


def _start_params(**kw):
    return {"session_id": SID, "agent_id": "a1", "origin": "https://a.example", "allowed_origins": ["https://a.example"],
            "url": "https://a.example/login", "timeout_s": 600, **kw}


def _spawn(monkeypatch, vo, proc):
    async def fake_exec(*cmd, **kw):
        fake_exec.cmd = cmd
        return proc

    monkeypatch.setattr(vo.asyncio, "create_subprocess_exec", fake_exec)
    return fake_exec


def test_start_validates_and_runs_broker_as_isolated_user(monkeypatch, vo):
    step = {"step": "identifier_password", "fields": [{"id": "f0", "role": "email", "input": "email", "label": "x"},
                                                      {"id": "f1", "role": "password", "input": "password"}],
            "page_origin": "https://a.example", "confidence": "HIGH", "flags": [], "text": "page text"}
    proc = FakeProc([{"event": "step", "step_id": 1, "step": step, "page_origin": "https://a.example",
                      "url": "https://a.example/login", "cookies": [{"name": "x"}], "html": "<secret>"}])
    ex = _spawn(monkeypatch, vo, proc)
    ev = asyncio.run(vo.auth_start(_start_params()))
    assert "--uid=nebula-vault" in ex.cmd and "-I" in ex.cmd and str(vo.AUTH_SCRIPT) in ex.cmd
    assert "ProtectHome=yes" in ex.cmd and "NoNewPrivileges=yes" in ex.cmd
    assert ev["event"] == "step" and "cookies" not in ev and "html" not in ev  # whitelist only
    assert set(ev["step"]) <= {*vo._STEP_KEYS, "alternatives", "transport"} and "label" not in ev["step"]["fields"][0]
    assert proc.received[0]["op"] == "start" and proc.received[0]["allowed_origins"] == ["https://a.example"]
    # one session per agent, and global limit
    assert asyncio.run(vo.auth_start(_start_params(session_id="as_" + "cd" * 12)))["detail"] == "agent_busy"
    for bad in ({"session_id": "x"}, {"origin": "https://a.example/p"}, {"allowed_origins": ["https://b.example"]},
                {"url": "javascript:alert(1)"}, {"allowed_origins": []}):
        with pytest.raises(vo.ws.WorkspaceError):
            asyncio.run(vo.auth_start(_start_params(**bad)))


def test_step_values_are_validated_cleared_and_bound_to_the_agent(monkeypatch, vo):
    proc = FakeProc([{"event": "step", "step_id": 1, "step": {"step": "password", "fields": []}},
                     {"event": "step", "step_id": 2, "step": {"step": "otp", "fields": []}}])
    _spawn(monkeypatch, vo, proc)
    asyncio.run(vo.auth_start(_start_params()))
    with pytest.raises(vo.ws.WorkspaceError):  # another agent can never drive this session
        asyncio.run(vo.auth_step({"session_id": SID, "agent_id": "a2", "step_id": 1, "values": {"f0": CANARY}}))
    for bad in ({"f0": ""}, {"x": "y"}, {"f0": "a" * 5000}, {f"f{i}": "v" for i in range(5)}, {"f0": 5}):
        with pytest.raises(vo.ws.WorkspaceError):
            asyncio.run(vo.auth_step({"session_id": SID, "agent_id": "a1", "step_id": 1, "values": bad}))
    p = {"session_id": SID, "agent_id": "a1", "step_id": 1, "values": {"f0": CANARY}}
    ev = asyncio.run(vo.auth_step(p))
    assert ev["step_id"] == 2 and p["values"] == {}  # the caller's copy is dropped
    assert proc.received[-1] == {"op": "fill", "step_id": 1, "values": {"f0": CANARY}}
    assert CANARY not in json.dumps(ev)


def test_result_cookies_go_only_to_the_sessions_agent(monkeypatch, vo):
    proc = FakeProc([{"event": "step", "step_id": 1, "step": {"step": "password", "fields": []}},
                     {"event": "result", "status": "authenticated", "final_url": "https://a.example/home",
                      "cookies": [{"name": "sid", "value": "s3ss", "domain": "a.example", "path": "/", "extra": 1}]}])
    _spawn(monkeypatch, vo, proc)
    calls = []
    monkeypatch.setattr(vo, "call_tool", lambda user, tool, args, t: calls.append((user, tool, args)) or
                        {"ok": True, "result": {"imported": len(args["cookies"])}})
    asyncio.run(vo.auth_start(_start_params()))
    ev = asyncio.run(vo.auth_step({"session_id": SID, "agent_id": "a1", "step_id": 1, "values": {"f0": "pw"}}))
    assert ev == {"event": "result", "status": "authenticated", "final_url": "https://a.example/home",
                  "cookies_imported": 1}
    assert calls == [("nebula_a1", "browser.import_cookies", {"cookies": [
        {"name": "sid", "value": "s3ss", "domain": "a.example", "path": "/"}]})]
    assert SID not in vo._AUTH  # a result ends the session


def test_dead_broker_and_cancel_all(monkeypatch, vo):
    proc = FakeProc([{"event": "step", "step_id": 1, "step": {"step": "password", "fields": []}}])
    _spawn(monkeypatch, vo, proc)
    asyncio.run(vo.auth_start(_start_params()))
    ev = asyncio.run(vo.auth_step({"session_id": SID, "agent_id": "a1", "step_id": 1, "values": {"f0": "x"}}))
    assert ev == {"event": "error", "detail": "broker_exited"} and SID not in vo._AUTH
    _spawn(monkeypatch, vo, FakeProc([{"event": "step", "step_id": 1, "step": {"step": "password", "fields": []}}]))
    asyncio.run(vo.auth_start(_start_params()))
    assert asyncio.run(vo.auth_cancel_all({}))["cancelled"] == 1 and vo._AUTH == {}


def test_broker_process_refuses_an_untrusted_detector_file():
    """Run the real script: on this Mac the detector file is not root-owned, so the broker refuses to load it."""
    script = GUEST / "nebula_guest/vault_auth.py"
    r = subprocess.run([sys.executable, "-I", str(script)], input=b'{"op":"start"}\n', capture_output=True,
                       timeout=30)
    out = json.loads(r.stdout.decode().strip().splitlines()[-1])
    assert out == {"event": "result", "status": "error", "detail": "detector:RuntimeError"}


def test_egress_filter_matches_encoded_secrets():
    from nebula_guest import vault_auth

    s = vault_auth.Session({"origin": "https://a.example", "allowed_origins": ["https://a.example"],
                            "url": "https://a.example/login"})
    from urllib.parse import quote, quote_plus

    v = "p@ss word/" + CANARY
    s.egress = [v, quote(v, safe=""), quote_plus(v)]
    assert s._leaks("https://evil.test/c?x=" + quote_plus(v), None)
    assert s._leaks("https://evil.test/c", "pw=" + quote(v, safe=""))
    assert not s._leaks("https://cdn.test/app.js", None)


# ---------------------------------------------------------------------------- broker session vs Chromium navigation
# A page that behaves like Chromium where it matters here: every main-frame navigation (incl. redirect hops) goes
# through the broker's real route guard, an aborted one commits Chromium's error page (chrome-error://), history back
# re-loads a GET entry and restores typed form values, and a POST entry is never re-posted (ERR_CACHE_MISS).
MS = "https://login.microsoftonline.com"
MS_FIDO = "https://login.microsoft.com"
ERROR_PAGE = "chrome-error://chromewebdata/"


class _Req:
    resource_type = "document"

    def __init__(self, page, url, method, body):
        self.url, self.method, self.post_data, self.frame = url, method, body, page.main_frame

    def is_navigation_request(self):
        return True


class _Route:
    action = None

    async def abort(self, reason="failed"):
        self.action = "abort"

    async def continue_(self):
        self.action = "continue"


class _Locator:
    def __init__(self, page, sel):
        self.page, self.sel = page, sel

    @property
    def first(self):
        return self

    def _fid(self):
        import re

        m = re.search(r'data-nebula-auth="([^"]+)"', self.sel)
        return m.group(1) if m else None

    async def fill(self, value, timeout=None):
        fields = self.page.doc.get("fields") or {}
        if self._fid() not in fields:
            raise TimeoutError("element not found")
        fields[self._fid()] = value

    async def press(self, key, timeout=None):  # Enter submits the form the field belongs to
        from urllib.parse import urlencode

        doc = self.page.doc
        await self.page.navigate(doc["action"], "POST", urlencode(doc["fields"]))

    def locator(self, sel):
        return _Locator(self.page, "submit-button")

    async def click(self, timeout=None):
        import copy
        import re

        m = re.search(r'data-nebula-click="([^"]+)"', self.sel)
        target = (self.page.doc.get("clicks") or {}).get(m.group(1) if m else "")
        if target is None:
            raise TimeoutError("element not found")
        if isinstance(target, dict):  # single-page view switch: same URL, new content
            self.page.doc = {"url": self.page.doc["url"], **copy.deepcopy(target)}
        else:
            await self.page.navigate(target, "GET")

    async def count(self):
        return 0

    async def evaluate(self, js, arg=None, timeout=None):  # the element's type attribute
        role = (self.page.doc.get("roles") or {}).get(self._fid())
        if role is None:
            raise TimeoutError("element not found")
        return self.page.doc.get("types", {}).get(self._fid()) or ("password" if role == "password" else "text")


class _Ctx:
    def __init__(self, page=None):
        self.page = page
        self.asked: list[list[str]] = []

    async def cookies(self, urls=None):
        self.asked.append(list(urls or []))
        jar = (self.page.jar if self.page is not None else []) or []
        return [c for c in jar if any(u.startswith(c["origin"]) for u in urls or [])]


class ChromiumLikePage:
    def __init__(self, session, site):
        self.s, self.site = session, site
        self.main_frame = object()
        self.frames = [self.main_frame]
        self.history: list[dict] = []
        self.idx = -1
        self.doc: dict = {"url": "about:blank"}
        self.reached: list[tuple[str, str, str | None]] = []  # requests that reached a server
        self.jar: list[dict] = []  # cookies set by the site: {"origin", "name", "value"}

    @property
    def url(self):
        return self.doc["url"]

    async def wait_for_load_state(self, *a, **k):
        return None

    async def evaluate(self, js, arg=None):
        fields = self.doc.get("fields") or {}
        return [i in fields for i in arg] if isinstance(arg, list) else {}

    def locator(self, sel):
        return _Locator(self, sel)

    async def navigate(self, url, method="GET", body=None, history_entry=None):
        import copy

        route = _Route()
        await self.s._guard(route, _Req(self, url, method, body))
        if route.action == "abort":
            return self._commit({"url": ERROR_PAGE}, history_entry, method="GET")
        self.reached.append((method, url, body))
        res = self.site(method, url)
        if "redirect" in res:  # each redirect hop is a new request through the route handler
            return await self.navigate(res["redirect"], "GET", None, history_entry)
        if res.get("unreachable"):  # DNS / connection failure
            return self._commit({"url": ERROR_PAGE}, history_entry, method="GET")
        for ck in res.get("set_cookies") or []:
            self.jar.append({**ck, "domain": None, "path": "/"})
        return self._commit({"url": url, **copy.deepcopy(res)}, history_entry, method=method)

    def _commit(self, doc, history_entry, method):
        if history_entry is None:  # a new navigation: Chromium remembers the typed values of the page it leaves
            if self.idx >= 0:
                self.history[self.idx]["saved"] = dict(self.doc.get("fields") or {})
            self.history = self.history[: self.idx + 1] + [{"url": doc["url"], "method": method}]
            self.idx += 1
        self.doc = doc

    async def goto(self, url, wait_until=None, timeout=None):
        await self.navigate(url)

    async def go_back(self, wait_until=None, timeout=None):
        if self.idx <= 0:
            return None
        self.idx -= 1
        entry = self.history[self.idx]
        if entry["method"] != "GET" or entry["url"] == ERROR_PAGE:  # ERR_CACHE_MISS: a POST is never re-sent
            self.doc = {"url": ERROR_PAGE}
            return None
        saved = dict(entry.get("saved") or {})
        await self.navigate(entry["url"], "GET", None, history_entry=entry)
        for k, v in saved.items():
            if k in (self.doc.get("fields") or {}):
                self.doc["fields"][k] = v
        return None


@pytest.fixture()
def broker(monkeypatch):
    """The real broker Session with the real detector's origin rules; detection reads the fake document."""
    import importlib.util

    from nebula_guest import vault_auth

    spec = importlib.util.spec_from_file_location("auth_detect_t", GUEST / "nebula_guest/auth_detect.py")
    det = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(det)
    monkeypatch.setattr(vault_auth, "D", det)

    async def detect(self, previous=None):
        doc = self.page.doc
        if self.page.url.startswith("chrome-error://"):
            return {"step": "none", "fields": [], "page_origin": None, "confidence": "LOW", "flags": []}
        step = {"step": doc.get("step", "none"), "page_origin": det.origin_of(self.page.url), "confidence": "HIGH",
                "flags": [], "fields": [{"id": k, "role": r} for k, r in (doc.get("roles") or {}).items()],
                "alternatives": list(doc.get("alternatives") or []), "error": bool(doc.get("error")),
                "interstitial": doc.get("interstitial"), "webauthn": doc.get("webauthn"),
                "login_context": bool(doc.get("login_context")), "approval_number": doc.get("approval_number")}
        step["fingerprint"] = det.fingerprint(step, {"url": self.page.url})
        return step

    monkeypatch.setattr(vault_auth.Session, "detect", detect)

    def make(site, origin=MS, url=MS + "/common/oauth2/authorize", **req):
        s = vault_auth.Session({"origin": origin, "allowed_origins": [origin], "url": url, "timeout_s": 300, **req})
        s.page = ChromiumLikePage(s, site)
        s.ctx = _Ctx(s.page)
        return s

    return make


def _microsoft_like(method, url):
    """Entra-style sign-in: the e-mail form on login.microsoftonline.com posts to login.microsoft.com (FIDO/passkey
    endpoint), which shows the next step."""
    if (method, url) == ("GET", MS + "/common/oauth2/authorize"):
        return {"step": "identifier", "roles": {"f0": "email"}, "fields": {"f0": ""},
                "action": MS_FIDO + "/common/fido/get"}
    if (method, url) == ("POST", MS_FIDO + "/common/fido/get"):
        return {"step": "password", "roles": {"f0": "password"}, "fields": {"f0": ""},
                "action": MS_FIDO + "/common/login"}
    if (method, url) == ("GET", MS + "/sso"):
        return {"redirect": MS_FIDO + "/common/login"}
    if (method, url) == ("GET", MS_FIDO + "/common/login"):
        return {"step": "identifier", "roles": {"f0": "email"}, "fields": {"f0": ""}, "action": MS_FIDO + "/x"}
    if url == MS + "/down":
        return {"unreachable": True}
    return {"step": "none"}


def test_allowed_form_target_offers_the_same_form_again_not_site_unreachable(broker):
    """Regression (Microsoft Teams, V3.3): the e-mail form posted to login.microsoft.com, NEBULA
    blocked it and the owner allowed that destination — the broker then evaluated Chromium's error page left by its
    own block and reported 'unreachable'. Now the form is shown again (fields cleared) and the host's one re-send
    reaches the allowed destination exactly once."""
    s = broker(_microsoft_like)
    email = "owner-" + CANARY + "@example.test"

    async def run():
        await s.goto(s.url)
        ev = await s.evaluate_page(None)
        assert ev["event"] == "step" and ev["step"]["step"] == "identifier"
        blocked = await s.fill(ev["step_id"], {"f0": email})
        assert blocked == {"event": "blocked", "origin": MS_FIDO, "reason": "form_target"}
        # nothing reached the other origin, the page is the form again and holds no typed value
        assert not [r for r in s.page.reached if r[1].startswith(MS_FIDO)]
        assert s.page.url == MS + "/common/oauth2/authorize" and s.page.doc["fields"] == {"f0": ""}
        again = await s.allow([MS_FIDO], True)
        assert again["event"] == "step" and again["step"]["step"] == "identifier", again
        assert again["step"]["page_origin"] == MS and again["step_id"] > ev["step_id"]
        nxt = await s.fill(again["step_id"], {"f0": email})  # the host's single re-send
        assert nxt["event"] == "step" and nxt["step"]["step"] == "password" and nxt["page_origin"] == MS_FIDO
        posts = [r for r in s.page.reached if r[0] == "POST"]
        assert len(posts) == 1 and posts[0][1] == MS_FIDO + "/common/fido/get"

    asyncio.run(run())


def test_blocked_redirect_is_a_redirect_even_on_chromiums_error_page(broker):
    """Regression: a redirect NEBULA blocks also lands on chrome-error://; it must reach the owner as a destination
    to review (then resume there), not as 'site unreachable'."""
    s = broker(_microsoft_like, url=MS + "/sso")

    async def run():
        await s.goto(MS + "/sso")
        assert s.page.url == ERROR_PAGE
        ev = await s.evaluate_page(None)
        assert ev["event"] == "redirect" and ev["origin"] == MS_FIDO, ev
        res = await s.allow([MS_FIDO], True)
        assert res["event"] == "step" and res["step"]["page_origin"] == MS_FIDO

    asyncio.run(run())


def test_a_real_connection_failure_is_still_unreachable(broker):
    s = broker(_microsoft_like, url=MS + "/down")

    async def run():
        await s.goto(MS + "/down")
        assert await s.evaluate_page(None) == {"event": "result", "status": "unreachable"}

    asyncio.run(run())


def test_form_that_cannot_be_reopened_is_form_lost_never_a_sign_in(broker):
    """The blocked form was itself the answer to a POST: Chromium cannot reload it without re-posting, the same URL
    opened again has no form -> 'form_lost' (not 'unreachable', not an unconfirmed sign-in handing over cookies), and
    no POST is ever replayed."""
    org, other = "https://a.example", "https://collector.example"

    def site(method, url):
        if (method, url) == ("GET", org + "/start"):
            return {"step": "identifier", "roles": {"f0": "username"}, "fields": {"f0": ""}, "action": org + "/next"}
        if (method, url) == ("POST", org + "/next"):
            return {"step": "password", "roles": {"f0": "password"}, "fields": {"f0": ""}, "action": other + "/c"}
        return {"step": "none"}

    s = broker(site, origin=org, url=org + "/start")

    async def run():
        await s.goto(org + "/start")
        ev = await s.evaluate_page(None)
        ev = await s.fill(ev["step_id"], {"f0": "user-" + CANARY})
        assert ev["step"]["step"] == "password"
        assert await s.fill(ev["step_id"], {"f0": "pw-" + CANARY}) == {"event": "blocked", "origin": other,
                                                                       "reason": "form_target"}
        assert await s.allow([other], True) == {"event": "result", "status": "form_lost"}
        assert [r[:2] for r in s.page.reached if r[0] == "POST"] == [("POST", org + "/next")]
        assert not [r for r in s.page.reached if r[1].startswith(other)]

    asyncio.run(run())


# ---------------------------------------------------------------------------------------------- broker v2 (V3.3)
EMAIL_FORM = {"step": "identifier", "roles": {"f0": "email"}, "fields": {"f0": ""}, "action": MS + "/next"}
PW_VIEW = {"step": "password", "roles": {"f0": "password"}, "fields": {"f0": ""}, "action": MS + "/login"}


def test_same_form_without_an_error_is_no_progress_and_with_one_is_rejected(broker):
    def site(method, url):
        if url == MS + "/start":
            return EMAIL_FORM
        if (method, url) == ("POST", MS + "/next"):
            return {**EMAIL_FORM, "error": url.endswith("/next") and site.err}
        return {"step": "none"}

    async def run(err):
        site.err = err
        s = broker(site, url=MS + "/start")
        await s.goto(MS + "/start")
        ev = await s.evaluate_page(None)
        return await s.fill(ev["step_id"], {"f0": "owner@example.test"})

    assert asyncio.run(run(False))["error"] == "no_progress"
    assert asyncio.run(run(True))["error"] == "rejected"


def test_an_identifier_is_never_typed_into_a_password_field(broker):
    swapped = {**EMAIL_FORM, "types": {"f0": "password"}}  # the page swapped the element under us

    s = broker(lambda m, u: swapped if u == MS + "/start" else {"step": "none"}, url=MS + "/start")

    async def run():
        await s.goto(MS + "/start")
        ev = await s.evaluate_page(None)
        out = await s.fill(ev["step_id"], {"f0": "owner@example.test"})
        assert out == {"event": "error", "detail": "page_changed"}
        assert s.page.doc["fields"]["f0"] == "" and not [r for r in s.page.reached if r[0] == "POST"]

    asyncio.run(run())


def test_only_a_detected_alternative_is_clicked(broker):
    passkey = {"step": "passkey", "roles": {}, "alternatives": [{"id": "c4", "kind": "password"}],
               "clicks": {"c4": PW_VIEW}}
    s = broker(lambda m, u: passkey if u == MS + "/fido" else {"step": "none"}, url=MS + "/fido",
               passkey_fallback="ask")  # the owner chooses (no automatic "use your password")

    async def run():
        await s.goto(MS + "/fido")
        ev = await s.evaluate_page(None)
        assert ev["step"]["step"] == "passkey"
        assert await s.choose("c9") == {"event": "error", "detail": "stale_step"}
        nxt = await s.choose("c4")
        assert nxt["event"] == "step" and nxt["step"]["step"] == "password"

    asyncio.run(run())


def test_observe_reports_a_page_that_changed_by_itself(broker):
    s = broker(lambda m, u: EMAIL_FORM if u == MS + "/start" else {"step": "none"}, url=MS + "/start")

    async def run():
        await s.goto(MS + "/start")
        ev = await s.evaluate_page(None)
        same = await s.observe()
        assert same["changed"] is False and same["step_id"] == ev["step_id"]
        s.page.doc = {"url": s.page.url, **PW_VIEW}  # e.g. a single-page app switched views on its own
        moved = await s.observe()
        assert moved["changed"] is True and moved["step"]["step"] == "password" and moved["error"] == "page_changed"
        assert moved["step_id"] > ev["step_id"]

    asyncio.run(run())


def test_stay_signed_in_prompt_is_answered_no_and_the_sign_in_completes(broker):
    kmsi = {"step": "interstitial", "roles": {}, "interstitial": {"kind": "kmsi", "click": "c2"},
            "clicks": {"c2": MS + "/done"}}

    def site(method, url):
        if url == MS + "/start":
            return PW_VIEW
        if (method, url) == ("POST", MS + "/login"):
            return {**kmsi, "set_cookies": [{"origin": MS, "name": "ESTSAUTH", "value": "s1"}]}
        if url == MS + "/done":
            return {"step": "authenticated"}
        return {"step": "none"}

    s = broker(site, url=MS + "/start")

    async def run():
        await s.goto(MS + "/start")
        ev = await s.evaluate_page(None)
        res = await s.fill(ev["step_id"], {"f0": "pw-" + CANARY})
        assert res["event"] == "result" and res["status"] == "authenticated", res
        assert s.interstitials == 1 and ("GET", MS + "/done", None) in s.page.reached

    asyncio.run(run())


def test_provider_cookies_reach_the_agent_only_when_verified_and_allowed(broker):
    teams = "https://teams.microsoft.com"
    s = broker(lambda m, u: {"step": "none"}, origin=teams, url=teams + "/", cookie_origins=[MS])

    async def run():
        await s.cookies()
        assert s.ctx.asked[-1] == [teams + "/"]  # MS not allowed (yet): never asked for
        s.allowed.add(MS)
        await s.cookies()
        assert s.ctx.asked[-1] == [teams + "/", MS + "/"]

    asyncio.run(run())


def test_broker_no_longer_hides_webauthn_it_only_observes_and_cancels():
    """V3.4: sites must learn the browser's real capabilities. The API is not removed, replaced with a fake answer
    or extended with an authenticator; the observer only records a pending modal request and can reject it the way
    a person closing the browser's dialog does (NotAllowedError)."""
    from nebula_guest import auth_detect, vault_auth

    assert not hasattr(vault_auth, "NO_WEBAUTHN_JS")
    src = (GUEST / "nebula_guest/vault_auth.py").read_text()
    assert "add_init_script(self.observe_js)" in src and "defineProperty(o, k" not in src
    assert '"OBSERVE_JS", "").replace("__nebulaObs", name)' in src and '"__n" + _secrets.token_hex(8)' in src
    js = auth_detect.OBSERVE_JS
    assert "MutationObserver" in js and "NotAllowedError" in js
    assert "PublicKeyCredential" not in js  # capability checks (isUserVerifyingPlatformAuthenticatorAvailable…) untouched
    assert "mediation === 'conditional'" in js  # passive autofill requests are passed through as they are
    assert "addVirtualAuthenticator" not in src and "WebAuthn.enable" not in src


# ---------------------------------------------------------------- V3.4 regressions (failures observed in testing)
def test_identifier_alone_never_counts_as_a_sign_in(broker):
    """False success: after an e-mail-only step Microsoft showed a page without a form and changed its helper cookies;
    V3.3 took that as 'authenticated'. A sign-in needs a password/code (or the provider's own session cookie)."""
    after = {"step": "none", "set_cookies": [{"origin": MS, "name": "esctx", "value": "x1"},
                                             {"origin": MS, "name": "fpc", "value": "x2"}]}
    s = broker(lambda m, u: EMAIL_FORM if (m, u) == ("GET", MS + "/start") else after, url=MS + "/start",
               session_cookies={MS: ["ESTSAUTH", "ESTSAUTHPERSISTENT"]})

    async def run():
        await s.goto(MS + "/start")
        ev = await s.evaluate_page(None)
        out = await s.fill(ev["step_id"], {"f0": "owner@example.test"})
        assert out["event"] == "result" and out["status"] == "unconfirmed", out
        assert "evidence" not in out

    asyncio.run(run())


def test_provider_page_cookie_churn_is_not_success_but_its_session_cookie_is(broker):
    churn = {"step": "none", "set_cookies": [{"origin": MS, "name": "buid", "value": "b1"}]}
    sess = {"step": "none", "set_cookies": [{"origin": MS, "name": "ESTSAUTH", "value": "s1"}]}
    for after, want in ((churn, "unconfirmed"), (sess, "authenticated")):
        s = broker(lambda m, u, a=after: PW_VIEW if (m, u) == ("GET", MS + "/pw") else a, url=MS + "/pw",
                   session_cookies={MS: ["ESTSAUTH"]})

        async def run(s=s, want=want):
            await s.goto(MS + "/pw")
            ev = await s.evaluate_page(None)
            out = await s.fill(ev["step_id"], {"f0": "pw-test-1234"})
            assert out["status"] == want, out
            if want == "authenticated":
                assert out["evidence"] == "provider_session_cookie"

        asyncio.run(run())


def test_signout_control_counts_only_after_a_password(broker):
    signed = {"step": "authenticated", "set_cookies": [{"origin": MS, "name": "sid", "value": "v1"}]}
    s = broker(lambda m, u: PW_VIEW if (m, u) == ("GET", MS + "/pw") else signed, url=MS + "/pw")

    async def run():
        await s.goto(MS + "/pw")
        ev = await s.evaluate_page(None)
        out = await s.fill(ev["step_id"], {"f0": "pw-test-1234"})
        assert out["status"] == "authenticated" and out["evidence"] == "signout_control"

    asyncio.run(run())
    s = broker(lambda m, u: EMAIL_FORM if (m, u) == ("GET", MS + "/e") else signed, url=MS + "/e")

    async def run2():
        await s.goto(MS + "/e")
        ev = await s.evaluate_page(None)
        out = await s.fill(ev["step_id"], {"f0": "owner@example.test"})
        assert out["status"] == "unconfirmed"  # an e-mail alone cannot have signed anyone in

    asyncio.run(run2())


def test_passkey_page_with_a_password_way_switches_to_the_password(broker):
    """Owner's request: 'cancel the security key, choose another way, click password'. The broker
    does it itself (setting 'password', the default) and tells the owner it did."""
    passkey = {"step": "passkey", "roles": {}, "alternatives": [{"id": "c4", "kind": "password"}],
               "clicks": {"c4": PW_VIEW}, "webauthn": {"kind": "passkey", "pending": False}}
    s = broker(lambda m, u: passkey if u == MS + "/fido" else {"step": "none"}, url=MS + "/fido")

    async def run():
        await s.goto(MS + "/fido")
        ev = await s.evaluate_page(None)
        assert ev["step"]["step"] == "password" and ev["auto"] == ["chose_password"]

    asyncio.run(run())


def test_passkey_page_opens_other_ways_then_chooses_the_password(broker):
    choice = {"step": "method_choice", "roles": {}, "alternatives": [{"id": "c1", "kind": "app"},
                                                                    {"id": "c2", "kind": "password"}],
              "clicks": {"c2": PW_VIEW}}
    key = {"step": "security_key", "roles": {}, "alternatives": [{"id": "c7", "kind": "more"}],
           "clicks": {"c7": choice}, "webauthn": {"kind": "security_key", "pending": False}}
    s = broker(lambda m, u: key if u == MS + "/key" else {"step": "none"}, url=MS + "/key")

    async def run():
        await s.goto(MS + "/key")
        ev = await s.evaluate_page(None)
        assert ev["step"]["step"] == "password" and ev["auto"] == ["opened_other_ways", "chose_password"]

    asyncio.run(run())


def test_pending_webauthn_request_is_cancelled_like_the_users_cancel(broker):
    """A modal passkey request can never finish in this browser (no authenticator): the broker presses the
    user's Cancel (NotAllowedError) at most twice, then the page's own fallback is read."""
    pending = {"step": "passkey", "roles": {}, "webauthn": {"kind": "passkey", "pending": True}}
    s = broker(lambda m, u: pending if u == MS + "/bridge" else {"step": "none"}, url=MS + "/bridge")
    cancelled = []

    async def fake_cancel():
        cancelled.append(1)
        if len(cancelled) == 1:  # the site falls back to its password view after the cancellation
            s.page.doc = {"url": MS + "/reprocess", **PW_VIEW}
        return True

    s._cancel_webauthn = fake_cancel

    async def run():
        await s.goto(MS + "/bridge")
        ev = await s.evaluate_page(None)
        assert ev["step"]["step"] == "password" and "passkey_cancelled" in ev["auto"] and len(cancelled) == 1

    asyncio.run(run())

    stuck = broker(lambda m, u: pending if u == MS + "/bridge" else {"step": "none"}, url=MS + "/bridge")
    n = []

    async def never():
        n.append(1)
        return True

    stuck._cancel_webauthn = never

    async def run2():
        await stuck.goto(MS + "/bridge")
        ev = await stuck.evaluate_page(None)
        assert ev["step"]["step"] == "passkey" and len(n) == 2  # bounded: the owner gets the passkey step

    asyncio.run(run2())


def test_crashed_tab_after_the_password_uses_the_cookies_never_guesses(broker):
    """The Teams web app after the password exceeded the broker's memory and the whole
    broker was killed (broker_lost). Now a crashed tab is reported from the cookies: the provider's session ->
    signed in; nothing -> page_crashed, never success."""
    for jar, want in (([{"origin": MS, "name": "ESTSAUTH", "value": "s1", "domain": None, "path": "/"}],
                       "authenticated"), ([], "page_crashed")):
        s = broker(lambda m, u: PW_VIEW, url=MS + "/pw", session_cookies={MS: ["ESTSAUTH"]})

        async def run(s=s, jar=jar, want=want):
            await s.goto(MS + "/pw")
            await s.evaluate_page(None)
            s.secret_step = True
            s.page.jar = list(jar)
            s.crashed = True
            out = await s._crash_result()
            assert out["status"] == want, out

        asyncio.run(run())


def test_device_approval_then_stay_signed_in_is_declined(broker):
    """After the Authenticator approval Microsoft asks 'Stay signed in?': the waiting loop declines it like after
    any other step (V3.3 handed it to the owner)."""
    approve = {"step": "device_approval", "roles": {}, "approval_number": "42"}
    kmsi = {"step": "interstitial", "roles": {}, "interstitial": {"kind": "kmsi", "click": "c3"},
            "clicks": {"c3": {"step": "none"}}}
    s = broker(lambda m, u: approve if u == MS + "/approve" else {"step": "none"}, url=MS + "/approve",
               session_cookies={MS: ["ESTSAUTH"]})

    async def run():
        await s.goto(MS + "/approve")
        ev = await s.evaluate_page(None)
        assert ev["step"]["step"] == "device_approval" and ev["step"]["approval_number"] == "42"
        s.page.doc = {"url": MS + "/kmsi", **kmsi}  # approved on the phone
        s.page.jar.append({"origin": MS, "name": "ESTSAUTH", "value": "s1", "domain": None, "path": "/"})
        out = await s.poll(6)
        assert out["status"] == "authenticated" and out["evidence"] == "provider_session_cookie"
        assert "declined_kmsi" in out["auto"]

    asyncio.run(run())


def test_light_mode_after_provider_session_blocks_the_service_app(broker):
    """Back on the service after the provider's sign-in, the service's own app is not run in the isolated browser
    (memory): its subresources are refused once the provider's session cookie exists."""
    from nebula_guest import vault_auth

    s = broker(lambda m, u: {"step": "none"}, origin="https://teams.microsoft.com",
               url="https://teams.microsoft.com/", session_cookies={MS: ["ESTSAUTH"]})
    s.allowed |= {MS}
    s.auth_origins = {MS}
    s.secret_step = True

    class Frame:
        url = "https://teams.microsoft.com/v2/"

    class Sub:
        url, method, post_data, frame = "https://teams.microsoft.com/app.js", "GET", None, Frame()
        resource_type = "script"

        def is_navigation_request(self):
            return False

    async def run():
        s.page.jar = [{"origin": MS, "name": "ESTSAUTH", "value": "s1", "domain": None, "path": "/"}]
        nav = _Route()
        await s._guard(nav, _Req(s.page, "https://teams.microsoft.com/v2/", "GET", None))
        assert nav.action == "continue" and s.idp_session is True
        r = _Route()
        await s._guard(r, Sub())
        assert r.action == "abort"
        img = _Route()

        class Img(Sub):
            resource_type = "image"

        await s._guard(img, Img())
        assert img.action == "abort"  # images / fonts / media are never loaded by the broker

    asyncio.run(run())
    assert vault_auth.SKIP_TYPES == ("image", "media", "font")


# ---------------------------------------------------------------- V3.4 security review regressions
def test_review_hidden_signout_link_without_a_cookie_change_is_not_success(broker):
    hidden = {"step": "authenticated"}  # (fake detection: signout not "visible")
    s = broker(lambda m, u: PW_VIEW if (m, u) == ("GET", MS + "/pw") else hidden, url=MS + "/pw")

    async def run():
        await s.goto(MS + "/pw")
        ev = await s.evaluate_page(None)
        out = await s.fill(ev["step_id"], {"f0": "pw-test-1234"})
        assert out["status"] == "unconfirmed", out

    asyncio.run(run())


def test_review_every_provider_sign_in_host_needs_the_provider_cookie(broker):
    """login.microsoft.com is a Microsoft sign-in host without known cookie names: helper-cookie churn there after a
    password is no evidence (finding 2b)."""
    churn = {"step": "none", "set_cookies": [{"origin": MS_FIDO, "name": "fpc", "value": "x"}]}
    s = broker(lambda m, u: PW_VIEW if (m, u) == ("GET", MS_FIDO + "/pw") else churn, origin=MS_FIDO,
               url=MS_FIDO + "/pw", auth_origins=[MS, MS_FIDO], session_cookies={MS: ["ESTSAUTH"]})
    s.allowed |= {MS}  # the password form posts to login.microsoftonline.com (allowed, verified relationship)

    async def run():
        await s.goto(MS_FIDO + "/pw")
        ev = await s.evaluate_page(None)
        out = await s.fill(ev["step_id"], {"f0": "pw-test-1234"})
        assert out["status"] == "unconfirmed", out

    asyncio.run(run())


def test_review_crash_with_an_old_provider_cookie_is_not_success(broker):
    """Finding 2c: the provider cookie existed before the sign-in (unchanged): a crash is not a sign-in."""
    s = broker(lambda m, u: PW_VIEW, url=MS + "/pw", session_cookies={MS: ["ESTSAUTH"]})

    async def run():
        await s.goto(MS + "/pw")
        await s.evaluate_page(None)
        s.page.jar = [{"origin": MS, "name": "ESTSAUTH", "value": "old", "domain": None, "path": "/"}]
        s._ck_before = await s._cookie_map()
        s.secret_step, s.crashed = True, True
        assert (await s._crash_result())["status"] == "page_crashed"

    asyncio.run(run())


def test_review_markers_and_observer_cannot_be_reused_or_forged():
    from nebula_guest import auth_detect as D

    assert "removeAttribute('data-nebula-click')" in D.DETECT_JS and "removeAttribute('data-nebula-auth')" in D.DETECT_JS
    assert "api.snap" in D.DETECT_JS and "Object.freeze" in D.OBSERVE_JS
    facts = {"inputs": [], "quiet_ms": float("inf"), "mutations": float("nan"), "observed": True}
    d = D.diagnostics(facts, {"step": "none"})  # a page poisoning the numbers cannot break detection
    assert d["quiet_ms"] is None and d["mutations"] is None


def test_review_agent_observe_never_returns_secret_field_values():
    src = (GUEST / "nebula_guest/agent_tools.py").read_text()
    js = src[src.index('OBSERVE_JS = """'):src.index('"""', src.index('OBSERVE_JS = """') + 20)]
    assert "el.innerText || val ||" in js and "el.innerText || el.value" not in js
    assert "password|one-time-code" in js and "secret ? '' : (el.value" in js
    assert "add_init_script(auth_detect.OBSERVE_JS)" not in src  # nothing page-visible in the agent's browser
    assert '"browser.clear_secrets": browser_clear_secrets' in src
