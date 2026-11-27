"""NEBULA Smart Authentication broker session (V3.2.1) — runs ONLY as the dedicated `nebula-vault` Linux user.

One process = one authentication session. Started by the root guest service through
`systemd-run --uid=nebula-vault --pipe` in the same throw-away sandbox as the V3.2 login broker (private /tmp, no
/home, no new privileges, memory/runtime limits) and run with `python -I`. It imports nothing from NEBULA except the
root-owned detector file next to it (`auth_detect.py`, standard library only), loaded by path after an ownership
check — nothing an agent can write is ever on its import path.

Protocol: JSON lines. stdin = commands from the guest service, stdout = events.
  start  {op:start, origin, allowed_origins, url, timeout_s}   -> step | redirect | result
  fill   {op:fill, step_id, values:{field_id: value}}          -> step (next or same+error) | blocked | redirect | result
  poll   {op:poll, wait_s}                                      -> step | result           (device approval)
  allow  {op:allow, origins:[...], resume}                      -> step | redirect | result (owner-approved origins;
                                                                  after a blocked form: the same form again)
  choose {op:choose, alt_id}                                    -> step | redirect | result (other way to sign in)
  observe {op:observe}                                          -> step (changed true/false) | redirect | result
  reload {op:reload}                                            -> step | redirect | result (owner: retry)
  handoff {op:handoff}                                          -> result{status:handoff, cookies}  (manual steps)
  cancel {op:cancel} / EOF / deadline                           -> exit

Secrets (passwords, codes) arrive only in `fill`, are typed only into fields of the current step that this process
detected itself on an allowed origin, are never echoed, logged or screenshotted, and are dropped right after the
step. While values are in the page, any request to a non-allowed origin that is not a plain GET is aborted, and any
request (any origin, any method) whose URL or body contains a submitted value outside the allowed origins is
aborted too. Cookies leave only in a final `result` (to the guest service, which hands them to the agent's browser).
"""

from __future__ import annotations

import asyncio
import base64
import importlib.util
import json
import os
import sys
import time
from pathlib import Path
from typing import Any
from urllib.parse import quote, quote_plus, urlsplit

HERE = Path(__file__).resolve().parent
MAX_FRAMES = 6
MAX_INTERSTITIALS = 3
MAX_AUTO = 3  # automatic "use another way" clicks per session (passkey -> other ways -> password)
QUIET_MS = 250  # the DOM must have been unchanged this long before a step is read as the current one
# Resource kinds a sign-in step never needs: not loading them keeps the isolated browser small and fast.
SKIP_TYPES = ("image", "media", "font")
# querySelectorAll across open shadow roots (fields of web-component forms), prefixed to small page functions
DEEP_JS = ("const __deep = (sel) => { const roots = [document]; "
           "for (let r = 0; r < roots.length && roots.length < 30; r++) for (const h of roots[r].querySelectorAll('*')) "
           "if (h.shadowRoot && roots.length < 30) roots.push(h.shadowRoot); "
           "return roots.flatMap(x => Array.from(x.querySelectorAll(sel))); }; ")
# V3.4: WebAuthn is no longer hidden from sites (V3.3 removed the API; that told sites something untrue about the
# browser). The real API stays; auth_detect.OBSERVE_JS only notices a pending passkey / security-key request and lets
# the broker press the user's "Cancel" (this browser has no authenticator, so the request can never finish here).


def _load_detector():
    p = HERE / "auth_detect.py"
    for q in (HERE, p):
        st = q.stat()
        if st.st_uid != 0 or st.st_mode & 0o022:
            raise RuntimeError("detector_untrusted")
    spec = importlib.util.spec_from_file_location("nebula_auth_detect", p)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


D = None  # detector module (loaded in main)


def emit(obj: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def clean_url(url: str) -> str | None:
    try:
        p = urlsplit(url or "")
        return f"{p.scheme}://{p.netloc}{p.path}"[:300] if p.scheme in ("http", "https") else None
    except ValueError:
        return None


def _ip_kind(ip: str) -> str:
    import ipaddress

    try:
        a = ipaddress.ip_address((ip or "").strip("[]"))
    except ValueError:
        return "unknown"
    if a.is_loopback:
        return "loopback"
    return "private" if (a.is_private or a.is_link_local or a.is_reserved or a.is_unspecified) else "public"


class Session:
    def __init__(self, req: dict[str, Any]) -> None:
        self.origin = req["origin"]
        self.allowed: set[str] = {o for o in req.get("allowed_origins") or [] if isinstance(o, str)}
        self.url = str(req.get("url") or "")
        self.deadline = time.time() + min(max(float(req.get("timeout_s") or 600), 30.0), 1800.0)
        self.blocked_nav: str | None = None  # last blocked main-frame GET navigation (redirect; memory only)
        self.blocked_post: str | None = None  # origin a form submission (non-GET navigation) tried to reach
        self.blocked_secret: str | None = None  # origin a request carrying a submitted value tried to reach
        # submitted values (+ encodings): kept in this isolated process for the whole session so the egress filter
        # stays on after the fill (a page may try to send captured values later); never leave this process
        self.egress: list[str] = []
        self._ck_before: dict[tuple, str] = {}  # requested-origin cookies before the last fill
        self.fill_url: str | None = None  # page URL of the last fill
        self.step: dict[str, Any] | None = None
        self.prev: dict[str, Any] | None = None  # the step before the current one (classification context)
        self.step_id = 0
        self.pw = self.browser = self.ctx = self.page = None
        # first-party identity-provider origins whose session cookies may reach the agent (host decides: verified,
        # same-provider relationships only; filtered against the allowed origins at hand-over time)
        self.cookie_origins: list[str] = [o for o in (req.get("cookie_origins") or [])[:4] if isinstance(o, str)]
        # cookie names that prove a sign-in on an origin (e.g. a provider's session cookie): success evidence only
        sc = req.get("session_cookies") if isinstance(req.get("session_cookies"), dict) else {}
        self.session_cookies: dict[str, list[str]] = {
            str(o): [str(n)[:64] for n in v[:8] if isinstance(n, str)] for o, v in list(sc.items())[:4]
            if isinstance(v, list)}
        self.transport: dict[str, dict[str, Any]] = {}  # origin -> {ip, tls, protocol} of its last main document
        self.interstitials = 0
        # V3.4
        self.passkey_fallback = req.get("passkey_fallback") if req.get("passkey_fallback") in ("password", "ask") \
            else "password"
        self.auth_origins: set[str] = set(self.session_cookies)  # identity-provider sign-in origins (exact)
        self.auto: list[str] = []  # automatic actions since the last emitted event (codes only, for the owner)
        self.auto_clicks = 0
        self.wa_cancels = 0
        self.secret_step = False  # a password / code was submitted (or a device approval awaited) in this session
        self.idp_session = False  # the provider's sign-in session cookie exists: the service page is not rendered
        self.crashed = False
        self.form_frame = None  # same-origin child frame that holds the current form (None = the page itself)
        self.wa_frame = None  # frame with a pending passkey / security-key request
        self.timing: dict[str, int] | None = None  # phases of the last submission (milliseconds, diagnostics)
        import secrets as _secrets

        name = "__n" + _secrets.token_hex(8)
        self.observe_js = getattr(D, "OBSERVE_JS", "").replace("__nebulaObs", name)
        self.detect_js = getattr(D, "DETECT_JS", "").replace("__nebulaObs", name)
        self.obs_name = name
        # every sign-in host of the provider (not only those with known cookie names): no generic evidence there
        self.auth_origins |= {o for o in (req.get("auth_origins") or [])[:8] if isinstance(o, str)}

    # ---------------------------------------------------------------- browser
    async def open(self) -> None:
        from playwright.async_api import async_playwright

        self.pw = await async_playwright().start()
        self.browser = await self.pw.chromium.launch(
            channel="chromium", headless=True, chromium_sandbox=True,
            args=["--no-first-run", "--disable-sync", "--disable-extensions", "--password-store=basic",
                  "--disable-features=PasswordManagerOnboarding,AutofillServerCommunication,Translate",
                  "--disable-background-networking",
                  # a heavy web app after the sign-in (e.g. Teams) must end as a crashed tab, not as an
                  # out-of-memory kill of the whole broker (V3.4: the 900 MB limit was hit on 2026-11-18)
                  "--js-flags=--max-old-space-size=512"])
        self.ctx = await self.browser.new_context(viewport={"width": 1280, "height": 900}, accept_downloads=False,
                                                  service_workers="block")
        await self.ctx.add_init_script(self.observe_js)
        self.page = await self.ctx.new_page()
        self.page.on("response", self._on_response)
        self.page.on("crash", self._on_crash)
        await self.ctx.route("**/*", self._guard)
        try:  # WebSockets bypass ctx.route: guard them too (Playwright >= 1.48)
            await self.ctx.route_web_socket("**/*", self._ws_guard)
        except AttributeError:
            pass

    async def _on_response(self, resp) -> None:
        """Transport facts of main-frame documents: the address actually used (DNS rebinding: a public name that
        resolves to a private/loopback address) and whether TLS was used. Chromium itself refuses invalid certificates."""
        try:
            if not resp.request.is_navigation_request() or resp.frame != self.page.main_frame:
                return
            o = D.origin_of(resp.url)
            addr = await resp.server_addr()
            sec = await resp.security_details()
            self.transport[o] = {"ip": _ip_kind((addr or {}).get("ipAddress") or ""), "tls": bool(sec),
                                 "protocol": str((sec or {}).get("protocol") or "")[:16] or None}
        except Exception:  # noqa: BLE001 - facts only
            return

    def transport_of(self, origin: str | None) -> dict[str, Any] | None:
        return self.transport.get(origin or "")

    def _on_crash(self, *_: Any) -> None:
        self.crashed = True

    async def _provider_session(self) -> bool:
        """The identity provider issued or changed its own sign-in session cookie during this sign-in (names from the
        host; values are only compared, never read out)."""
        if not self.session_cookies:
            return False
        origins = [o for o in self.session_cookies if o in self.allowed]
        if not origins:
            return False
        try:
            jar = await self.ctx.cookies([o + "/" for o in origins])
        except Exception:  # noqa: BLE001
            return False
        names = {n for o in origins for n in self.session_cookies[o]}
        before = self._ck_before  # issued or changed in THIS sign-in; a cookie set earlier is no evidence
        return any(c.get("name") in names and c.get("value") and
                   before.get((c.get("name"), c.get("domain"), c.get("path"))) != c.get("value") for c in jar)

    async def _ws_guard(self, ws) -> None:
        o = D.origin_of(ws.url.replace("wss://", "https://", 1).replace("ws://", "http://", 1))
        if self.egress and o not in self.allowed:
            await ws.close()
            return
        ws.connect_to_server()

    async def close(self) -> None:
        try:
            if self.browser:
                await self.browser.close()
        finally:
            if self.pw:
                await self.pw.stop()

    def _leaks(self, url: str, body: str | None) -> bool:
        hay = url + "\n" + (body or "")
        return any(v and v in hay for v in self.egress)

    async def _guard(self, route, request) -> None:
        o = D.origin_of(request.url)
        page = self.page
        is_nav = request.is_navigation_request() and page is not None and request.frame == page.main_frame
        try:
            body = request.post_data
        except Exception:  # noqa: BLE001 - binary bodies
            body = None
        rtype = request.resource_type
        if not is_nav and rtype in SKIP_TYPES:
            await route.abort("blockedbyclient")
            return
        if is_nav and o in self.allowed and o not in self.auth_origins and self.secret_step and not self.idp_session:
            # back on the service after the provider's sign-in: once the provider's session exists, the service app
            # itself is not run here (the agent's browser signs in to it with that session)
            self.idp_session = await self._provider_session()
        if self.idp_session and not is_nav and rtype != "document":
            try:
                fo = D.origin_of(request.frame.url)
            except Exception:  # noqa: BLE001 - no frame (worker): not part of a sign-in page
                fo = ""
            if fo not in self.auth_origins:
                await route.abort("blockedbyclient")
                return
        if is_nav and o not in self.allowed:
            if request.method == "GET":
                self.blocked_nav = request.url
            else:  # a form submission to another origin: never replayed, the owner decides (values re-sent once)
                self.blocked_post = o
            await route.abort("blockedbyclient")
            return
        if self.egress and o not in self.allowed:
            if self._leaks(request.url, body):
                self.blocked_secret = o
                await route.abort("blockedbyclient")
                return
            if request.method not in ("GET", "HEAD", "OPTIONS"):
                await route.abort("blockedbyclient")  # after a fill nothing is posted to other origins
                return
        await route.continue_()

    async def settle(self, idle_ms: int = 1500) -> None:
        try:
            await self.page.wait_for_load_state("domcontentloaded", timeout=15000)
        except Exception:  # noqa: BLE001
            pass
        try:
            await self.page.wait_for_load_state("networkidle", timeout=idle_ms * 3)
        except Exception:  # noqa: BLE001
            pass

    def _root(self):
        """Where the current form lives: the page, or a same-origin child frame holding it."""
        fr = self.form_frame
        if fr is not None:
            try:
                if not fr.is_detached() and D.origin_of(fr.url) == D.origin_of(self.page.url):
                    return fr
            except Exception:  # noqa: BLE001
                pass
        return self.page  # (the page's own locator/evaluate act on its main frame)

    async def detect(self, previous: dict[str, Any] | None = None) -> dict[str, Any]:
        if self.crashed:
            raise RuntimeError("page_crashed")
        facts = await asyncio.wait_for(self.page.evaluate(self.detect_js, True), 10)
        frames = facts.get("frames") or []
        page_o = D.origin_of(self.page.url)
        same_frame = None
        self.wa_frame = self.page.main_frame if facts.get("wa_pending") else None
        for fr in self.page.frames[1:MAX_FRAMES + 1]:
            try:
                sub = await asyncio.wait_for(fr.evaluate(self.detect_js, False), 3)
            except Exception:  # noqa: BLE001 - detached / cross-process frames
                continue
            fo = D.origin_of(fr.url)
            if sub.get("wa_pending") and not facts.get("wa_pending") and fo in self.allowed:
                facts["wa_pending"] = sub["wa_pending"]  # e.g. a provider's passkey frame on an allowed origin
                self.wa_frame = fr
            if any(i.get("type") == "password" and i.get("visible") for i in sub.get("inputs") or []):
                try:
                    direct = fr.parent_frame == self.page.main_frame
                except Exception:  # noqa: BLE001
                    direct = False
                if fo == page_o and fo in self.allowed and direct:
                    same_frame = same_frame or fr  # same-origin frame: readable and fillable like the page
                else:  # embedded third-party sign-in: presence only, never filled
                    frames.append({"origin": fo, "visible": True, "login": True})
        facts["frames"] = frames
        out = D.classify(facts, requested_origin=self.origin, previous=previous)
        used = facts
        self.form_frame = None
        if same_frame is not None and out["step"] in ("none", "unknown", "authenticated"):
            try:
                sub = await asyncio.wait_for(same_frame.evaluate(self.detect_js, True), 5)
                alt = D.classify(sub, requested_origin=self.origin, previous=previous)
            except Exception:  # noqa: BLE001
                alt = None
            if alt and alt["step"] in ("identifier", "identifier_password", "password", "otp", "recovery_code"):
                alt["flags"] = sorted(set(alt["flags"]) | {"same_origin_frame"})
                out, used, self.form_frame = alt, sub, same_frame
        out["unstable"] = bool(used.get("animating")) or bool(used.get("busy")) or used.get("ready") != "complete"
        out["_quiet"] = used.get("quiet_ms") if used.get("observed") else None
        out["_diag"] = D.diagnostics(used, out)
        tr = self.transport_of(out.get("page_origin"))
        if tr:
            out["transport"] = tr
        return out

    @staticmethod
    def _settled(cur: dict[str, Any]) -> bool:
        q = cur.get("_quiet")
        return not cur.get("unstable") and (q is None or q >= QUIET_MS)

    async def stable_detect(self, previous: dict[str, Any] | None = None, max_s: float = 8.0) -> dict[str, Any]:
        """The step shown once the page stopped changing: loaded, no running animation, nothing marked busy and —
        from the MutationObserver installed before the page's own scripts — no DOM change for QUIET_MS (single-page
        sign-ins swap views e-mail -> password without a navigation; a read during the swap must never count). A
        page that never goes quiet (clocks, tickers) is accepted once the same step was read twice 1.5 s apart."""
        t0 = time.time()
        end = t0 + max_s
        last: dict[str, Any] | None = None
        last_at = 0.0
        while True:
            try:
                cur = await self.detect(previous)
            except Exception:  # noqa: BLE001 - navigating: try again
                if self.crashed:
                    raise
                cur = None
            now = time.time()
            if cur is not None:
                if self._settled(cur):
                    return cur  # a quiet page needs one read only (no extra latency)
                if cur.get("_quiet") is None and last is not None and \
                        cur.get("fingerprint") == last.get("fingerprint") and not cur.get("unstable"):
                    return cur  # no observer on this document (e.g. about:blank): two equal reads
                if last is not None and cur.get("fingerprint") == last.get("fingerprint") and \
                        not cur.get("unstable") and now - last_at >= 1.5:
                    return cur
                if last is None or cur.get("fingerprint") != last.get("fingerprint"):
                    last, last_at = cur, now
            if now >= end:
                return cur if cur is not None else await self.detect(previous)
            q = (cur or {}).get("_quiet")
            # still quiet-waiting: exactly the rest of the quiet window; animating / busy: look again shortly
            wait = (QUIET_MS - q) / 1000 + 0.03 if isinstance(q, (int, float)) and q < QUIET_MS else 0.15
            await asyncio.sleep(min(max(wait, 0.08), 0.3))

    async def _click(self, cid: str) -> None:
        try:
            await self._root().locator(f'[data-nebula-click="{cid}"]').first.click(timeout=8000)
        except Exception:  # noqa: BLE001 - the page changed: the next detection tells
            pass

    async def _cancel_webauthn(self) -> bool:
        """The user's own "Cancel" on a pending passkey / security-key request (NotAllowedError, as when a person
        closes the browser's dialog). Nothing about the authenticator is invented."""
        fr = self.wa_frame or self.page.main_frame
        try:
            if D.origin_of(fr.url) not in self.allowed:
                return False
            return bool(await asyncio.wait_for(fr.evaluate(
                "(n) => { const a = window[n]; return !!(a && typeof a.cancel === 'function' && a.cancel()); }",
                self.obs_name), 3))
        except Exception:  # noqa: BLE001
            return False

    async def _crash_result(self) -> dict[str, Any]:
        """The page's renderer died (out of memory). The browser and its cookies survive: a sign-in that already
        produced the provider's session still counts; anything else is reported as such, never as success."""
        if self.secret_step and await self._provider_session():
            return await self.result("authenticated", evidence="provider_session_cookie")
        return {"event": "result", "status": "page_crashed"}

    async def _auto_other_way(self, new: dict[str, Any]) -> bool:
        """Passkey / security key with another way offered: this browser cannot use the key, so (owner setting
        'password', the default) choose the page's own "use your password" control, or open its list of other ways
        first. Only controls the detector found on the current allowed page are clicked; at most MAX_AUTO times."""
        if self.passkey_fallback != "password" or self.auto_clicks >= MAX_AUTO:
            return False
        alts = {a.get("kind"): a.get("id") for a in new.get("alternatives") or []}
        if new.get("step") not in ("passkey", "security_key", "method_choice"):
            return False
        target = alts.get("password") or (alts.get("more") if new["step"] != "method_choice" else None)
        if not target:
            return False
        self.auto_clicks += 1
        self.auto.append("chose_password" if alts.get("password") == target else "opened_other_ways")
        before_url, before_fp = self.page.url, new.get("fingerprint")
        await self._click(target)
        end = time.time() + 6
        while time.time() < end:
            await asyncio.sleep(0.3)
            if self.blocked_nav or self.blocked_post or self.page.url != before_url or self.crashed:
                break
            try:
                if (await self.detect(self.prev)).get("fingerprint") != before_fp:
                    break
            except Exception:  # noqa: BLE001
                break
        return True

    async def _land(self, previous: dict[str, Any] | None) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
        """Where an action led: (event to return, None) or (None, the settled step). Interstitials that only ask
        to remember the browser or to enrol something are answered with the no-change choice (at most 3); a pending
        passkey / security-key request is cancelled (at most twice) and, when the page offers it, the password way
        is chosen (owner setting)."""
        while True:
            if self.crashed:
                return await self._crash_result(), None
            await self.settle()
            if self.blocked_nav and D.origin_of(self.blocked_nav) not in self.allowed:
                return self._redirect_event(), None
            if self.on_error_page():
                return {"event": "result", "status": "unreachable"}, None
            if D.origin_of(self.page.url) not in self.allowed:
                return {"event": "redirect", "origin": D.origin_of(self.page.url), "url": None}, None
            try:
                new = await self.stable_detect(previous)
            except Exception:  # noqa: BLE001
                if self.crashed:
                    return await self._crash_result(), None
                raise
            if new.get("step") == "interstitial" and previous is not None and \
                    self.interstitials < MAX_INTERSTITIALS and (new.get("interstitial") or {}).get("click"):
                self.interstitials += 1
                self.auto.append(f"declined_{(new.get('interstitial') or {}).get('kind') or 'prompt'}")
                await self._click(new["interstitial"]["click"])
                continue
            wa = new.get("webauthn") or {}
            if wa.get("pending") and self.wa_cancels < 2 and await self._cancel_webauthn():
                self.wa_cancels += 1
                self.auto.append(f"{wa.get('kind') or 'passkey'}_cancelled")
                await asyncio.sleep(0.5)  # the site reacts to the cancellation (its own fallback / navigation)
                continue
            if await self._auto_other_way(new):
                continue
            return None, new

    def _take_auto(self) -> list[str]:
        out, self.auto = self.auto[:8], []
        return out

    def _take_timing(self) -> dict[str, int] | None:
        out, self.timing = self.timing, None
        return out

    def _event_step(self, step: dict[str, Any], *, error: str | None = None) -> dict[str, Any]:
        step.pop("unstable", None)
        step.pop("_quiet", None)
        diag = step.pop("_diag", None)
        # every emitted step gets a new id: a fill must name the step it answers (field ids are re-marked per detect)
        if self.step is not None and self.step.get("step") != step.get("step"):
            self.prev = self.step
        self.step_id += 1
        self.step = step
        return {"event": "step", "step_id": self.step_id, "step": step, "page_origin": step.get("page_origin"),
                "url": clean_url(self.page.url), "error": error, "still_waiting": False, "diag": diag,
                "auto": self._take_auto(), "timing": self._take_timing()}

    async def cookies(self) -> list[dict[str, Any]]:
        # the requested site's session, plus (only when the host verified a first-party provider relationship,
        # e.g. Teams -> login.microsoftonline.com) that provider's sign-in origin — never a third-party IdP's cookies.
        # V3.4: also the sign-in page's own path and the current page's path on the requested origin (a session
        # cookie with Path=/app is not sent to "/" and was missed)
        extra = [o for o in self.cookie_origins if o in self.allowed and o != self.origin]
        urls = [self.origin + "/"]
        for u in (self.url, self.page.url if self.page is not None else None):
            cu = clean_url(u or "")
            if cu and D.origin_of(cu) == self.origin and cu not in urls:
                urls.append(cu)
        return (await self.ctx.cookies([*urls, *[o + "/" for o in extra]]))[:300]

    async def _cookie_map(self) -> dict[tuple, str]:
        try:
            return {(c["name"], c.get("domain"), c.get("path")): c["value"] for c in await self.cookies()}
        except Exception:  # noqa: BLE001
            return {}

    async def confirmed(self, new: dict[str, Any]) -> str | None:
        """Positive evidence of a sign-in (V3.4: stricter — 2026-11-18 an identity provider's helper cookies changed
        after an e-mail-only step and that was taken as a sign-in). Returns the kind of evidence or None:
        * provider_session_cookie — a known provider issued its own sign-in session cookie;
        * signout_control — a sign-out control/link on the page, after a password or code was submitted;
        * site_cookie_and_navigation — after a password or code: the site set/changed a cookie, the page left the
          form, shows no sign-in wording, and is not an identity provider's page (they change cookies on every page).
        Never after an identifier alone, never on a page showing an error."""
        if new.get("error") or new.get("step") not in ("none", "authenticated"):
            return None
        after = await self._cookie_map()
        names = {n for o, v in self.session_cookies.items() if o in self.allowed for n in v}
        if names and any(k[0] in names and v and self._ck_before.get(k) != v for k, v in after.items()):
            return "provider_session_cookie"
        if not self.secret_step:
            return None
        if D.origin_of(self.page.url) in self.auth_origins or new.get("login_wording"):
            return None  # identity providers' own pages / sign-in wording: only a provider session cookie counts
        changed = any(self._ck_before.get(k) != v for k, v in after.items())
        if new.get("step") == "authenticated":
            # a visible sign-out control, or a hidden sign-out link together with a new/changed site cookie
            return "signout_control" if (new.get("signout") == "visible" or changed) else None
        # the page left the form (navigation, or — like many apps after location.replace('./') — the same address
        # now shows the app instead of the sign-in form) and the site set/changed a cookie
        if changed:
            return "site_cookie_and_navigation"
        return None

    async def finish_step(self, new: dict[str, Any]) -> dict[str, Any]:
        ev = await self.confirmed(new)
        if ev:
            return await self.result("authenticated", evidence=ev)
        return await self.result("unconfirmed", diag=new.get("_diag"))

    async def result(self, status: str, **extra: Any) -> dict[str, Any]:
        out = {"event": "result", "status": status, "final_url": clean_url(self.page.url)
               if D.origin_of(self.page.url) in self.allowed else None, "auto": self._take_auto(), **extra}
        if status in ("authenticated", "handoff", "unconfirmed"):
            out["cookies"] = await self.cookies()
            if status == "authenticated" and not out["cookies"]:
                out["status"] = "no_session"
                out.pop("cookies")
        return out

    def _redirect_event(self) -> dict[str, Any]:
        o = D.origin_of(self.blocked_nav or "")
        return {"event": "redirect", "origin": o or None, "url": clean_url(self.page.url)}

    # ---------------------------------------------------------------- steps
    async def goto(self, url: str) -> None:
        self.blocked_nav = None
        try:
            await self.page.goto(url, wait_until="domcontentloaded", timeout=30000)
        except Exception:  # noqa: BLE001 - blocked redirect / network error
            pass
        await self.settle()

    def on_error_page(self) -> bool:
        return (self.page.url or "").startswith("chrome-error://")

    async def back_to_form(self) -> None:
        """Aborting a main-frame navigation (our own block of a form submission) leaves Chromium on its error page
        (chrome-error://), not on the form. Go back to the page that had the form — history back, else the same URL
        again on its allowed origin, always a plain GET (the blocked POST is never replayed) — and clear the
        credential fields there (Chromium may restore typed values on history navigation)."""
        if not self.on_error_page():
            return
        try:
            await self.page.go_back(wait_until="domcontentloaded", timeout=30000)
        except Exception:  # noqa: BLE001
            pass
        if self.on_error_page() and self.fill_url and D.origin_of(self.fill_url) in self.allowed:
            try:  # history entry of a POST result cannot be re-loaded without re-posting: open the URL instead
                await self.page.goto(self.fill_url, wait_until="domcontentloaded", timeout=30000)
            except Exception:  # noqa: BLE001
                pass
        await self.settle()
        if self.on_error_page() or D.origin_of(self.page.url) not in self.allowed:
            return
        try:
            cur = await self.detect(self.prev)
        except Exception:  # noqa: BLE001 - still rendering: nothing typed by us is on this new document
            return
        await self._clear([i for f in cur.get("fields") or [] for i in (f.get("ids") or [f["id"]])])

    async def evaluate_page(self, previous: dict[str, Any] | None) -> dict[str, Any]:
        # a navigation NEBULA blocked itself also ends on Chromium's error page: that is a redirect for the owner to
        # review, not an unreachable site — check it first
        if self.blocked_nav and D.origin_of(self.blocked_nav) not in self.allowed:
            return self._redirect_event()
        if self.on_error_page():  # DNS / connection / TLS failure
            return {"event": "result", "status": "unreachable"}
        if D.origin_of(self.page.url) not in self.allowed:
            return {"event": "redirect", "origin": D.origin_of(self.page.url), "url": None}
        ev, step = await self._land(previous)
        if ev is not None:
            return ev
        if previous is None and step["step"] == "authenticated":
            step["step"] = "none"  # a fresh, empty profile cannot be signed in: no sign-in form here
        elif step["step"] in ("none", "authenticated") and previous is not None:
            return await self.finish_step(step)
        return self._event_step(step)

    async def start(self) -> dict[str, Any]:
        if self.origin not in self.allowed or D.origin_of(self.url) not in self.allowed:
            return {"event": "result", "status": "origin_mismatch"}
        await self.open()
        await self.goto(self.url)
        ev = await self.evaluate_page(None)
        if ev.get("event") == "step" and ev["step"]["step"] == "none":
            # one hop: a same-origin "Sign in" link on a landing page
            for c in (await self.page.evaluate(self.detect_js, False)).get("clickables") or []:
                if D.SIGNIN_LINK.match((c.get("t") or "").strip()) and (not c.get("href") or c["href"] in self.allowed):
                    try:
                        await self.page.get_by_text(c["t"], exact=True).first.click(timeout=8000)
                    except Exception:  # noqa: BLE001
                        break
                    await self.settle()
                    ev = await self.evaluate_page(None)
                    break
        if ev.get("event") == "step" and ev["step"]["step"] == "none":
            return {"event": "result", "status": "no_login_form", "final_url": clean_url(self.page.url)}
        return ev

    async def _field_state(self, ids: list[str]) -> list[bool]:
        js = "(ids) => { " + DEEP_JS + "return ids.map(i => { const e = __deep('[data-nebula-auth=\"' + i + '\"]')[0]; " \
             "if (!e || !e.isConnected) return false; const r = e.getBoundingClientRect(); " \
             "return r.width > 2 && r.height > 2; }); }"
        try:
            return await asyncio.wait_for(self._root().evaluate(js, ids), 3)
        except Exception:  # noqa: BLE001 - navigation in progress
            return [False] * len(ids)

    async def _error_count(self) -> int:
        js = ("() => { " + DEEP_JS + "return __deep('[role=alert],[aria-live],.error,.alert-danger,"
              "[class*=\"error\" i],[aria-invalid=\"true\"]').filter(e => { const r = e.getBoundingClientRect(); "
              "return r.width > 2 && r.height > 2 && (e.getAttribute('aria-invalid') === 'true' || "
              "(e.innerText || '').trim().length > 0); }).length; }")
        try:
            return int(await asyncio.wait_for(self._root().evaluate(js), 3))
        except Exception:  # noqa: BLE001
            return 0

    async def _wait_change(self, before_url: str, ids: list[str], seconds: float, errors_before: int = -1) -> bool:
        """Something happened after a submission: navigation, a block, the filled fields went away (single-page
        view switch) or an error appeared next to them."""
        end = time.time() + seconds
        n = 0
        while time.time() < end:
            await asyncio.sleep(0.15)
            n += 1
            if self.blocked_nav or self.blocked_post or self.blocked_secret or self.page.url != before_url:
                return True
            if ids and not all(await self._field_state(ids)):
                return True
            if errors_before >= 0 and n % 6 == 0 and await self._error_count() > errors_before:
                return True
        return False

    async def _type_ok(self, loc, role: str) -> bool:
        """Never an identifier into a password field or a password into a visible text field."""
        try:
            t = str(await loc.evaluate("e => (e.getAttribute('type') || e.type || '').toLowerCase()",
                                       timeout=3000))
        except Exception:  # noqa: BLE001
            return False
        if role == "password":
            return t == "password"
        if role in ("email", "phone", "username", "username_or_email"):
            return t != "password"
        return True

    async def _clear(self, ids: list[str]) -> None:
        for i in ids:
            try:
                await self._root().locator(f'[data-nebula-auth="{i}"]').first.fill("", timeout=2000)
            except Exception:  # noqa: BLE001
                pass

    async def fill(self, step_id: int, values: dict[str, str]) -> dict[str, Any]:
        step = self.step
        if step is None or step_id != self.step_id:
            values.clear()
            return {"event": "error", "detail": "stale_step"}
        fields = {f["id"]: f for f in step.get("fields") or []}
        if not fields or set(values) != set(fields):
            values.clear()
            return {"event": "error", "detail": "fields_mismatch"}
        if D.origin_of(self.page.url) not in self.allowed:
            values.clear()
            return {"event": "redirect", "origin": D.origin_of(self.page.url), "url": None}
        # the page may have re-rendered since the owner saw the step: re-detect and fill only if it is the same step
        cur = await self.detect(self.prev)
        roles = [f["role"] for f in step.get("fields") or []]
        if cur["step"] != step["step"] or [f["role"] for f in cur.get("fields") or []] != roles:
            values.clear()
            if cur["step"] in ("none", "authenticated"):
                return {"event": "error", "detail": "page_changed"}
            return self._event_step(cur, error="page_changed")
        mapped = {new["id"]: values[old["id"]] for old, new in zip(step["fields"], cur["fields"], strict=True)}
        values.clear()
        values = mapped
        fields = {f["id"]: f for f in cur["fields"]}
        self.step = cur
        if any(f.get("role") in ("password", "otp", "recovery_code") for f in cur["fields"]):
            self.secret_step = True  # from now on a sign-in can have happened (never after an identifier alone)
        ids: list[str] = []
        for v in values.values():
            if len(v) >= 4:
                raw = v.encode()
                self.egress += [v, quote(v, safe=""), quote_plus(v), quote_plus(v, safe="*"), quote(v, safe="~*-._"),
                                base64.b64encode(raw).decode().rstrip("="),
                                base64.urlsafe_b64encode(raw).decode().rstrip("=")]
        self.blocked_nav = self.blocked_post = self.blocked_secret = None
        self._ck_before = await self._cookie_map()
        self.fill_url = self.page.url
        last = None
        errors_before = await self._error_count()
        try:
            for fid, f in fields.items():
                v = values[fid]
                if f.get("ids"):  # verification code split over single-character boxes
                    for ch, bid in zip(v, f["ids"], strict=False):
                        loc = self._root().locator(f'[data-nebula-auth="{bid}"]').first
                        await loc.fill(ch, timeout=8000)
                        ids.append(bid)
                        last = loc
                else:
                    loc = self._root().locator(f'[data-nebula-auth="{fid}"]').first
                    if not await self._type_ok(loc, f.get("role") or ""):
                        await self._clear(ids)
                        return {"event": "error", "detail": "page_changed"}
                    await loc.fill(v, timeout=10000)
                    ids.append(fid)
                    last = loc
        finally:
            values.clear()
        before = self.page.url
        t0 = time.monotonic()
        if last is not None:
            try:
                await last.press("Enter", timeout=5000)
            except Exception:  # noqa: BLE001
                pass
        changed = await self._wait_change(before, ids, 4, errors_before)
        if not changed:
            try:  # some forms ignore Enter: press the form's own submit button
                btn = self._root().locator(f'[data-nebula-auth="{ids[-1]}"]').locator(
                    "xpath=ancestor::form[1]//*[self::button[not(@type) or @type='submit'] or "
                    "self::input[@type='submit']]").first
                if await btn.count():
                    await btn.click(timeout=5000)
            except Exception:  # noqa: BLE001
                pass
            await self._wait_change(before, ids, 15, errors_before)
        t1 = time.monotonic()
        await self.settle()
        t2 = time.monotonic()
        if self.blocked_nav and D.origin_of(self.blocked_nav) not in self.allowed:
            return self._redirect_event()
        if self.blocked_post or self.blocked_secret:
            await self._clear(ids)
            if self.blocked_post:  # the aborted submission left the error page: show the form again
                await self.back_to_form()
            return {"event": "blocked", "origin": self.blocked_post or self.blocked_secret,
                    "reason": "form_target" if self.blocked_post else "exfiltration"}
        ev, new = await self._land(step)
        t3 = time.monotonic()
        self.timing = {"change_ms": round((t1 - t0) * 1000), "settle_ms": round((t2 - t1) * 1000),
                       "read_ms": round((t3 - t2) * 1000)}
        if ev is not None:
            return ev
        return await self._next(step, new)

    async def _next(self, step: dict[str, Any], new: dict[str, Any]) -> dict[str, Any]:
        same = new["step"] == step["step"] and [f["role"] for f in new.get("fields") or []] == \
            [f["role"] for f in step.get("fields") or []]
        if same and new["step"] in ("identifier", "identifier_password", "password", "otp", "recovery_code"):
            await self._clear([i for f in new.get("fields") or [] for i in (f.get("ids") or [f["id"]])])
            # 'rejected' only when the page shows an error; the same form without one is 'no progress' (the host's
            # loop guard decides) — never reported as wrong credentials
            return self._event_step(new, error="rejected" if new.get("error") else "no_progress")
        if new["step"] in ("none", "authenticated"):
            return await self.finish_step(new)
        return self._event_step(new)

    async def choose(self, alt_id: str) -> dict[str, Any]:
        """Owner chose another way to finish the step (e.g. 'use my password' instead of a passkey). Only an
        alternative this broker detected on the current page, on an allowed origin, is clicked."""
        step = self.step
        if step is None or alt_id not in {a.get("id") for a in step.get("alternatives") or []}:
            return {"event": "error", "detail": "stale_step"}
        if D.origin_of(self.page.url) not in self.allowed:
            return {"event": "redirect", "origin": D.origin_of(self.page.url), "url": None}
        self.blocked_nav = self.blocked_post = None
        before_url, before_fp = self.page.url, step.get("fingerprint")
        await self._click(alt_id)
        end = time.time() + 6
        while time.time() < end:
            await asyncio.sleep(0.4)
            if self.blocked_nav or self.blocked_post or self.page.url != before_url:
                break
            try:
                if (await self.detect(self.prev)).get("fingerprint") != before_fp:
                    break
            except Exception:  # noqa: BLE001
                break
        ev, new = await self._land(step)
        if ev is not None:
            return ev
        if new.get("fingerprint") == before_fp:
            return self._event_step(new, error="no_progress")
        if new["step"] in ("none", "authenticated"):
            return await self.finish_step(new)
        return self._event_step(new)

    async def observe(self) -> dict[str, Any]:
        """The page while the owner is answering: unchanged -> same step id; changed -> a new step (the host
        replaces the open request so a stale form can never be submitted)."""
        cur = self.step
        if cur is None:
            return {"event": "error", "detail": "no_step"}
        if self.blocked_nav and D.origin_of(self.blocked_nav) not in self.allowed:
            return self._redirect_event()
        if self.on_error_page() or D.origin_of(self.page.url) not in self.allowed:
            return {"event": "step", "step_id": self.step_id, "step": cur, "page_origin": cur.get("page_origin"),
                    "url": None, "error": None, "still_waiting": True, "changed": False}
        try:
            new = await self.stable_detect(self.prev, max_s=3.0)
        except Exception:  # noqa: BLE001
            if self.crashed:
                return await self._crash_result()
            raise
        if (new.get("webauthn") or {}).get("pending") or (
                new["step"] in ("passkey", "security_key") and new.get("fingerprint") != cur.get("fingerprint")):
            # a passkey / security-key prompt appeared by itself: same handling as after an action
            ev, landed = await self._land(cur)
            if ev is not None:
                return ev
            new = landed
        if new.get("fingerprint") == cur.get("fingerprint"):
            return {"event": "step", "step_id": self.step_id, "step": cur, "page_origin": cur.get("page_origin"),
                    "url": clean_url(self.page.url), "error": None, "still_waiting": True, "changed": False}
        if new["step"] in ("none", "authenticated", "interstitial"):
            return {"event": "step", "step_id": self.step_id, "step": cur, "page_origin": cur.get("page_origin"),
                    "url": clean_url(self.page.url), "error": None, "still_waiting": True, "changed": False}
        return {**self._event_step(new, error="page_changed"), "changed": True}

    async def reload(self) -> dict[str, Any]:
        """Owner: retry from the sign-in page after a loop was stopped (a plain GET of the original URL)."""
        self.interstitials = 0
        self.step = self.prev = None
        await self.goto(self.url)
        return await self.evaluate_page(None)

    async def poll(self, wait_s: float) -> dict[str, Any]:
        end = time.time() + min(max(wait_s, 2.0), 45.0)
        prev = self.step
        if prev is None:
            return {"event": "error", "detail": "no_step"}
        self.secret_step = True  # the owner approves on their device: an authentication factor
        while time.time() < end:
            await asyncio.sleep(1.5)
            if self.crashed:
                return await self._crash_result()
            if self.blocked_nav and D.origin_of(self.blocked_nav) not in self.allowed:
                return self._redirect_event()
            try:
                new = await self.detect(prev)
            except Exception:  # noqa: BLE001 - page navigating
                continue
            if new["step"] != prev.get("step") or new.get("approval_number") != prev.get("approval_number"):
                # approved (or the site moved on): settle like after any action — "Stay signed in?" is declined,
                # a passkey prompt cancelled — then read what the page asks now
                ev, landed = await self._land(prev)
                if ev is not None:
                    return ev
                if landed["step"] in ("none", "authenticated"):
                    return await self.finish_step(landed)
                if landed["step"] == prev.get("step") and \
                        landed.get("approval_number") == prev.get("approval_number"):
                    continue
                return self._event_step(landed)
        return {"event": "step", "step_id": self.step_id, "step": prev, "page_origin": prev.get("page_origin"),
                "url": clean_url(self.page.url), "error": None, "still_waiting": True}

    async def allow(self, origins: list[str], resume: bool) -> dict[str, Any]:
        for o in origins[:4]:
            if isinstance(o, str) and D.origin_of(o + "/") == o:
                self.allowed.add(o)
        # only a blocked GET navigation (redirect) is resumed; a blocked form POST is never replayed as a GET —
        # the host re-sends the values through a normal fill instead
        target = self.blocked_nav if resume and self.blocked_nav and D.origin_of(self.blocked_nav) in self.allowed \
            else None
        form_post = self.blocked_post is not None
        self.blocked_nav = self.blocked_post = None
        if target:
            await self.goto(target)
        elif form_post or self.on_error_page():
            # the host re-sends the values on the same step: it must be the form again, never Chromium's error page
            # (reported as an unreachable site) nor an empty page (taken as the end of the sign-in)
            await self.back_to_form()
            if self.on_error_page():
                return {"event": "result", "status": "form_lost"}
            if form_post and D.origin_of(self.page.url) in self.allowed:
                try:
                    gone = (await self.detect(self.prev))["step"] in ("none", "authenticated")
                except Exception:  # noqa: BLE001 - still rendering: evaluate_page decides
                    gone = False
                if gone:
                    return {"event": "result", "status": "form_lost"}
        return await self.evaluate_page(self.step)


async def _readline(deadline: float) -> dict[str, Any] | None:
    remaining = deadline - time.time()
    if remaining <= 0:
        return None
    try:
        raw = await asyncio.wait_for(asyncio.to_thread(sys.stdin.buffer.readline, 70000), remaining)
    except TimeoutError:
        return None
    if not raw:
        return None
    try:
        return json.loads(raw)
    except ValueError:
        return {"op": "invalid"}


async def run() -> None:
    first = await _readline(time.time() + 60)
    if not first or first.get("op") != "start":
        emit({"event": "result", "status": "error", "detail": "no_start"})
        return
    s = Session(first)
    try:
        ev = await asyncio.wait_for(s.start(), 120)
        emit(ev)
        if ev.get("event") == "result":
            return
        while True:
            cmd = await _readline(s.deadline)
            if cmd is None or cmd.get("op") == "cancel":
                return
            op = cmd.get("op")
            try:
                if op == "fill":
                    vals = cmd.get("values") if isinstance(cmd.get("values"), dict) else {}
                    cmd["values"] = {}
                    vals = {str(k)[:8]: str(v)[:4096] for k, v in vals.items() if isinstance(v, str)}
                    ev = await asyncio.wait_for(s.fill(int(cmd.get("step_id") or -1), vals), 90)
                elif op == "poll":
                    ev = await asyncio.wait_for(s.poll(float(cmd.get("wait_s") or 20)), 75)
                elif op == "allow":
                    ev = await asyncio.wait_for(s.allow(list(cmd.get("origins") or []), bool(cmd.get("resume"))), 90)
                elif op == "choose":
                    ev = await asyncio.wait_for(s.choose(str(cmd.get("alt_id") or "")), 60)
                elif op == "observe":
                    ev = await asyncio.wait_for(s.observe(), 50)
                elif op == "reload":
                    ev = await asyncio.wait_for(s.reload(), 90)
                elif op == "handoff":
                    ev = await s.result("handoff")
                else:
                    ev = {"event": "error", "detail": "unknown_op"}
            except TimeoutError:
                ev = {"event": "error", "detail": "step_timeout"}
            except Exception as e:  # noqa: BLE001 - type only: messages could echo input
                ev = {"event": "error", "detail": type(e).__name__}
            if s.crashed and ev.get("event") == "error":
                try:  # the tab died while working (out of memory): the cookies tell whether the sign-in got through
                    ev = await asyncio.wait_for(s._crash_result(), 20)
                except Exception:  # noqa: BLE001
                    ev = {"event": "result", "status": "page_crashed"}
            emit(ev)
            if ev.get("event") == "result":
                return
    except TimeoutError:
        emit({"event": "result", "status": "timeout"})
    except Exception as e:  # noqa: BLE001
        emit({"event": "result", "status": "error", "detail": type(e).__name__})
    finally:
        await s.close()


def main() -> None:
    global D
    os.umask(0o077)
    try:
        D = _load_detector()
    except Exception as e:  # noqa: BLE001
        emit({"event": "result", "status": "error", "detail": f"detector:{type(e).__name__}"})
        return
    asyncio.run(run())


if __name__ == "__main__":
    main()
