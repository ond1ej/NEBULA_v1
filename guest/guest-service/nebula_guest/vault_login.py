"""NEBULA Password Vault login broker — runs ONLY as the dedicated `nebula-vault` Linux user (V3.2).

Started by the root guest service through `systemd-run --uid=nebula-vault --pipe` in a throw-away sandbox
(private /tmp, no access to /home, no new privileges, memory and runtime limits). Standalone on purpose: it is run
with `python -I` and imports nothing from NEBULA, so nothing an agent can write is ever on its import path.

stdin  : one JSON line {origin, allowed_origins, login_url, username, password, timeout_s}
stdout : one JSON line {status, final_url, cookies, blocked}   (cookies go to the guest service, never to the host)

The password is typed only into a headless Chromium with an empty, temporary profile (no extensions, no sync,
nothing saved), only on an exact allowed origin, and only form submissions to allowed origins may leave the page
while it is filled. No screenshots are taken. Every error is reported by type only (messages could echo input).
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from typing import Any
from urllib.parse import urlsplit

USER_SELECTORS = [
    'input[autocomplete="username"]', 'input[type="email"]', 'input[name*="user" i]', 'input[name*="login" i]',
    'input[name*="email" i]', 'input[id*="user" i]', 'input[id*="login" i]', 'input[id*="email" i]',
    'input[type="text"]', 'input:not([type])', 'input[type="tel"]',
]
OTP_SELECTOR = ('input[autocomplete="one-time-code"], input[name*="otp" i], input[name*="totp" i], '
                'input[id*="otp" i], input[name="code"], input[name*="2fa" i], input[name*="mfa" i]')
CAPTCHA_SELECTOR = ('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare.com"], '
                    '.g-recaptcha, .h-captcha, #cf-turnstile, [data-sitekey]')


def origin_of(url: str) -> str:
    p = urlsplit(url or "")
    scheme = (p.scheme or "").lower()
    host = (p.hostname or "").lower().rstrip(".")
    try:
        port = p.port
    except ValueError:
        return ""
    if scheme not in ("http", "https") or not host:
        return ""
    default = 443 if scheme == "https" else 80
    hostpart = f"[{host}]" if ":" in host else host
    return f"{scheme}://{hostpart}" + (f":{port}" if port and port != default else "")


async def _visible(loc) -> bool:
    try:
        return await loc.is_visible()
    except Exception:  # noqa: BLE001
        return False


async def _first_visible(page, selectors: list[str]):
    for sel in selectors:
        loc = page.locator(sel)
        try:
            n = await loc.count()
        except Exception:  # noqa: BLE001
            continue
        for i in range(min(n, 10)):
            el = loc.nth(i)
            if await _visible(el):
                return el
    return None


async def _password_field(page):
    return await _first_visible(page, ['input[type="password"]'])


async def _username_field(page, pw):
    # prefer a username-like field in the same form as the password field
    if pw is not None:
        try:
            form = pw.locator("xpath=ancestor::form[1]")
            if await form.count():
                for sel in USER_SELECTORS:
                    loc = form.locator(sel)
                    for i in range(min(await loc.count(), 5)):
                        el = loc.nth(i)
                        if await _visible(el):
                            return el
        except Exception:  # noqa: BLE001
            pass
    return await _first_visible(page, USER_SELECTORS)


async def _settle(page, ms: int = 1500) -> None:
    try:
        await page.wait_for_load_state("domcontentloaded", timeout=15000)
    except Exception:  # noqa: BLE001
        pass
    try:
        await page.wait_for_load_state("networkidle", timeout=ms * 4)
    except Exception:  # noqa: BLE001
        pass


async def run(req: dict[str, Any]) -> dict[str, Any]:
    allowed = {o for o in req.get("allowed_origins") or [] if isinstance(o, str)}
    origin = req.get("origin")
    login_url = req.get("login_url") or ""
    username = str(req.get("username") or "")
    password = str(req.get("password") or "")
    req["password"] = req["username"] = ""
    if origin not in allowed or origin_of(login_url) not in allowed:
        return {"status": "origin_mismatch"}
    from playwright.async_api import async_playwright

    blocked: list[str] = []
    state = {"filled": False}
    result: dict[str, Any] = {"status": "error"}
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            channel="chromium", headless=True, chromium_sandbox=True,
            args=["--no-first-run", "--disable-sync", "--disable-extensions", "--password-store=basic",
                  "--disable-features=PasswordManagerOnboarding,AutofillServerCommunication,Translate",
                  "--disable-background-networking"])
        try:
            ctx = await browser.new_context(viewport={"width": 1280, "height": 800}, accept_downloads=False,
                                            service_workers="block")
            page = await ctx.new_page()

            async def guard(route, request) -> None:
                o = origin_of(request.url)
                is_nav = request.is_navigation_request() and request.frame == page.main_frame
                if is_nav and o not in allowed:
                    blocked.append(o)
                    await route.abort("blockedbyclient")
                    return
                if state["filled"] and request.method not in ("GET", "HEAD", "OPTIONS") and o not in allowed:
                    blocked.append(o)  # a filled form may only be sent to allowed origins
                    await route.abort("blockedbyclient")
                    return
                await route.continue_()

            await ctx.route("**/*", guard)
            try:
                await page.goto(login_url, wait_until="domcontentloaded", timeout=30000)
            except Exception:  # noqa: BLE001 - blocked redirect or network error
                pass
            await _settle(page)
            if origin_of(page.url) not in allowed:
                return {"status": "redirect_blocked", "final_url": page.url if origin_of(page.url) in allowed
                        else None, "blocked": sorted(set(blocked))[:5]}
            if await _first_visible(page, [CAPTCHA_SELECTOR]):
                return {"status": "needs_owner", "final_url": page.url}
            pw_el = await _password_field(page)
            user_el = await _username_field(page, pw_el)
            if pw_el is None and user_el is not None and username:
                # identifier-first sign-in: user name, continue, then the password step
                state["filled"] = True
                await user_el.fill(username, timeout=10000)
                await user_el.press("Enter")
                await _settle(page)
                if origin_of(page.url) not in allowed:
                    return {"status": "redirect_blocked", "blocked": sorted(set(blocked))[:5]}
                for _ in range(30):
                    pw_el = await _password_field(page)
                    if pw_el is not None:
                        break
                    await asyncio.sleep(0.5)
                user_el = None
            if pw_el is None:
                if await _first_visible(page, [OTP_SELECTOR, CAPTCHA_SELECTOR]):
                    return {"status": "needs_owner", "final_url": page.url}
                return {"status": "no_login_form", "final_url": page.url}
            if origin_of(page.url) not in allowed:
                return {"status": "redirect_blocked", "blocked": sorted(set(blocked))[:5]}
            state["filled"] = True
            if user_el is not None and username:
                await user_el.fill(username, timeout=10000)
            await pw_el.fill(password, timeout=10000)
            password = ""  # noqa: F841 - drop our reference early (best effort)
            before = page.url
            await pw_el.press("Enter")
            # wait until the password form goes away (navigation or SPA re-render)
            for _ in range(40):
                await asyncio.sleep(0.5)
                if blocked:
                    break
                cur = await _password_field(page)
                if cur is None or page.url != before:
                    break
            await _settle(page)
            if blocked:
                result = {"status": "redirect_blocked", "blocked": sorted(set(blocked))[:5]}
            elif origin_of(page.url) not in allowed:
                result = {"status": "redirect_blocked", "blocked": [origin_of(page.url)]}
            elif await _first_visible(page, [OTP_SELECTOR, CAPTCHA_SELECTOR]):
                result = {"status": "needs_owner", "final_url": page.url}
            elif await _password_field(page) is not None:
                result = {"status": "login_failed", "final_url": page.url}
                try:  # never leave the secret in a live field
                    el = await _password_field(page)
                    if el is not None:
                        await el.fill("")
                except Exception:  # noqa: BLE001
                    pass
            else:
                cookies = await ctx.cookies([o + "/" for o in sorted(allowed)])
                result = {"status": "signed_in" if cookies else "no_session", "final_url": page.url,
                          "cookies": cookies[:200]}
        finally:
            await browser.close()
    return result


def main() -> None:
    raw = sys.stdin.buffer.readline(65536)
    try:
        req = json.loads(raw)
        raw = b""
        timeout = float(req.get("timeout_s") or 60)
        out = asyncio.run(asyncio.wait_for(run(req), timeout))
    except TimeoutError:
        out = {"status": "timeout"}
    except Exception as e:  # noqa: BLE001 - type only: messages could contain input
        out = {"status": "error", "detail": type(e).__name__}
    sys.stdout.write(json.dumps(out) + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    os.umask(0o077)
    main()
