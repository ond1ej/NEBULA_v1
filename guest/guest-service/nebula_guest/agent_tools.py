"""Per-agent tool server. Runs as the agent's unprivileged Linux user, on the agent's own DISPLAY.

Socket: /run/nebula-tools/<user>/tools.sock (directory 0700, owned by the agent; root connects only after checking
that the socket is owned by and served by this agent's uid, see peersock.py). Every tool call first checks that this
agent's X display is not served by another uid (xdisplay.py).
Protocol: one JSON request line {"tool","args"} -> one JSON response line {"ok","result"|"error"}.
All actions are serialized per agent; the browser is a headed Chromium (Playwright persistent
context) visible on this agent's desktop.
"""

from __future__ import annotations

import asyncio
import base64
import io
import json
import os
import re
import signal
import stat
import time
from pathlib import Path
from typing import Any

USER = os.environ.get("USER") or os.getlogin()
HOME = Path(os.environ.get("HOME", f"/home/{USER}"))
WORKSPACE = Path(os.environ.get("NEBULA_WORKSPACE", str(HOME / "workspace"))).resolve()
DISPLAY = os.environ.get("DISPLAY", ":0")
SOCKET_PATH = os.environ.get("NEBULA_TOOLS_SOCKET", f"/run/nebula-tools/{USER}/tools.sock")
PROFILE_DIR = HOME / ".nebula" / "browser-profile"
MAX_OUTPUT = 64 * 1024
MAX_READ = 512 * 1024
MAX_WRITE = 4 * 1024 * 1024
KEYS_RE = re.compile(r"^[A-Za-z0-9_+\-. ]{1,100}$")


class ToolError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


# ---------------------------------------------------------------- paths
SHARED_ROOT = Path(os.environ.get("NEBULA_SHARED_ROOT", "/srv/nebula/shared"))


def _confine_in(root: Path, rel: str) -> Path:
    candidate = root / rel if rel not in ("", ".") else root
    # walk every existing component with lstat: no symlinks allowed anywhere below the root
    cur = root
    for part in candidate.relative_to(root).parts:
        if part == "..":
            raise ToolError("path_outside_workspace", "'..' is not allowed")
        cur = cur / part
        try:
            st = os.lstat(cur)
        except FileNotFoundError:
            break
        if stat.S_ISLNK(st.st_mode):
            raise ToolError("symlink_rejected", f"symlink in path: {cur.relative_to(root)}")
    resolved = candidate.resolve()
    if resolved != root and root not in resolved.parents:
        raise ToolError("path_outside_workspace", f"{rel} resolves outside the allowed directory")
    return resolved


def confine(rel: str | None) -> Path:
    """Resolve a user-supplied path inside the workspace (or a team shared directory this agent belongs to);
    reject traversal and symlink escapes."""
    rel = rel or "."
    if "\x00" in rel:
        raise ToolError("invalid_path", "NUL in path")
    p = Path(rel)
    if p.is_absolute():
        try:
            sub = p.relative_to(SHARED_ROOT)
        except ValueError:
            sub = None
        if sub is not None and sub.parts:
            team_dir = SHARED_ROOT / sub.parts[0]
            try:
                st = os.lstat(team_dir)
            except FileNotFoundError:
                raise ToolError("path_outside_workspace", f"no shared team directory {sub.parts[0]}") from None
            if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode) or not os.access(team_dir, os.R_OK | os.X_OK):
                raise ToolError("permission_denied", "this agent is not a member of that team directory")
            return _confine_in(team_dir, str(Path(*sub.parts[1:])) if len(sub.parts) > 1 else ".")
        try:
            p = p.relative_to(WORKSPACE)
        except ValueError as e:
            raise ToolError("path_outside_workspace", f"{rel} is outside the workspace") from e
    return _confine_in(WORKSPACE, str(p))


def rel_display(p: Path) -> str:
    try:
        return str(p.relative_to(WORKSPACE)) if p != WORKSPACE else "."
    except ValueError:
        return str(p)  # shared team directory: absolute path


# ---------------------------------------------------------------- desktop
async def _run(argv: list[str], timeout: float = 15) -> tuple[int, str, str]:
    env = dict(os.environ, DISPLAY=DISPLAY)
    proc = await asyncio.create_subprocess_exec(*argv, stdout=asyncio.subprocess.PIPE,
                                                stderr=asyncio.subprocess.PIPE, env=env)
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout)
    except TimeoutError:
        proc.kill()
        raise ToolError("timeout", f"{argv[0]} timed out") from None
    return proc.returncode or 0, out.decode(errors="replace"), err.decode(errors="replace")


def _grab_png(scale: float = 1.0) -> dict[str, Any]:
    from PIL import ImageGrab

    # Pillow's XCB grabber reads this agent's own X display (cookie in XAUTHORITY).
    img = ImageGrab.grab(xdisplay=DISPLAY).convert("RGB")
    w, h = img.size
    extrema = img.convert("L").getextrema()
    non_empty = extrema[0] != extrema[1]  # not a single flat colour
    if scale and scale != 1.0:
        img = img.resize((max(1, int(w * scale)), max(1, int(h * scale))))
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=False)
    return {"png_b64": base64.b64encode(buf.getvalue()).decode(), "width": w, "height": h,
            "non_empty": non_empty, "display": DISPLAY, "captured_at": time.time(), "bytes": buf.tell()}


async def desktop_screenshot(args: dict[str, Any]) -> dict[str, Any]:
    scale = float(args.get("scale", 1.0))
    if not 0.1 <= scale <= 1.0:
        raise ToolError("invalid_argument", "scale must be within 0.1..1.0")
    return await asyncio.get_running_loop().run_in_executor(None, _grab_png, scale)


def _int(args: dict[str, Any], k: str, lo: int, hi: int) -> int:
    try:
        v = int(args[k])
    except (KeyError, TypeError, ValueError):
        raise ToolError("invalid_argument", f"{k} must be an integer") from None
    if not lo <= v <= hi:
        raise ToolError("invalid_argument", f"{k} out of range")
    return v


async def desktop_click(args: dict[str, Any]) -> dict[str, Any]:
    x, y = _int(args, "x", 0, 8000), _int(args, "y", 0, 8000)
    button = {"left": "1", "middle": "2", "right": "3"}.get(args.get("button", "left"))
    if not button:
        raise ToolError("invalid_argument", "button must be left|middle|right")
    argv = ["xdotool", "mousemove", "--sync", str(x), str(y), "click"]
    if args.get("double"):
        argv += ["--repeat", "2"]
    argv.append(button)
    before = await _screen_hash()
    rc, _, err = await _run(argv)
    if rc:
        raise ToolError("xdotool_failed", err[:300])
    await asyncio.sleep(0.4)
    after = await _screen_hash()
    # a click that changes nothing visible is reported so the agent can re-observe instead of assuming success
    return {"clicked": [x, y], "button": args.get("button", "left"), "screen_changed": before != after,
            "active_window": await _active_window_name()}


async def desktop_type(args: dict[str, Any]) -> dict[str, Any]:
    text = str(args.get("text", ""))
    if len(text) > 5000:
        raise ToolError("invalid_argument", "text too long")
    rc, _, err = await _run(["xdotool", "type", "--delay", "15", "--", text], timeout=120)
    if rc:
        raise ToolError("xdotool_failed", err[:300])
    return {"typed_chars": len(text)}


async def desktop_keypress(args: dict[str, Any]) -> dict[str, Any]:
    keys = str(args.get("keys", ""))
    if not KEYS_RE.match(keys):
        raise ToolError("invalid_argument", "keys must be xdotool keysyms like 'ctrl+l' or 'Return'")
    rc, _, err = await _run(["xdotool", "key", "--", *keys.split()])
    if rc:
        raise ToolError("xdotool_failed", err[:300])
    return {"keys": keys}


async def desktop_scroll(args: dict[str, Any]) -> dict[str, Any]:
    x, y = _int(args, "x", 0, 8000), _int(args, "y", 0, 8000)
    amount = _int(args, "amount", 1, 50) if "amount" in args else 3
    direction = args.get("direction", "down")
    btn = {"up": "4", "down": "5", "left": "6", "right": "7"}.get(direction)
    if not btn:
        raise ToolError("invalid_argument", "direction must be up|down|left|right")
    rc, _, err = await _run(["xdotool", "mousemove", "--sync", str(x), str(y), "click", "--repeat", str(amount), btn])
    if rc:
        raise ToolError("xdotool_failed", err[:300])
    return {"scrolled": direction, "amount": amount}


# ---------------------------------------------------------------- browser
class Browser:
    def __init__(self) -> None:
        self._pw = None
        self._ctx = None
        self._lock = asyncio.Lock()
        self.focus = None  # tab chosen with browser_tab(switch)
        # V3.4: the last page of a service (not an identity provider's sign-in) shown in a tab, so a sign-in the
        # agent reached in the middle of a provider's flow is started again from that service by NEBULA
        self.service_url: dict[int, str] = {}

    def _track(self, page) -> None:
        def nav(frame) -> None:
            try:
                if frame != page.main_frame:
                    return
                u = urllib.parse.urlsplit(frame.url or "")
                if u.scheme not in ("http", "https") or not u.hostname:
                    return
                from nebula_guest import auth_detect

                if u.hostname.lower() not in auth_detect.IDP_HOSTS:
                    self.service_url[id(page)] = f"{u.scheme}://{u.netloc}{u.path}"[:300]
            except Exception:  # noqa: BLE001 - tracking never breaks browsing
                pass
        page.on("framenavigated", nav)

    def service_of(self, page) -> str | None:
        return self.service_url.get(id(page))

    async def page(self):
        async with self._lock:
            if self._ctx is None:
                from playwright.async_api import async_playwright

                self._pw = await async_playwright().start()
                self._ctx = await self._pw.chromium.launch_persistent_context(
                    str(PROFILE_DIR),
                    headless=False,
                    no_viewport=True,
                    chromium_sandbox=os.environ.get("NEBULA_CHROMIUM_SANDBOX", "1") == "1",
                    args=["--start-maximized", "--no-first-run", "--no-default-browser-check",
                          "--disable-features=Translate", "--password-store=basic",
                          "--hide-crash-restore-bubble"],  # VM restarts must not leave a modal bubble
                    env={**os.environ, "DISPLAY": DISPLAY},
                )
                self._ctx.on("close", lambda *_: self._reset())
                for p in self._ctx.pages:
                    self._track(p)
                self._ctx.on("page", self._track)
            pages = [p for p in self._ctx.pages if not p.is_closed()]
            if self.focus is not None and self.focus in pages:
                return self.focus
            self.focus = None
            return pages[-1] if pages else await self._ctx.new_page()

    def _reset(self) -> None:
        self._ctx = None

    async def close(self) -> None:
        if self._ctx:
            await self._ctx.close()
        if self._pw:
            await self._pw.stop()


BROWSER = Browser()
URL_RE = re.compile(r"^(https?://|about:blank$|file://)", re.I)


async def browser_navigate(args: dict[str, Any]) -> dict[str, Any]:
    url = str(args.get("url", "")).strip()
    if not URL_RE.match(url):
        if re.match(r"^[\w.-]+\.[a-z]{2,}(/.*)?$", url, re.I):
            url = "https://" + url
        else:
            raise ToolError("invalid_url", "url must start with http:// or https://")
    if url.lower().startswith("file://"):
        path = url[7:]
        confine(path)  # file:// only inside the workspace
    page = await BROWSER.page()
    resp = await page.goto(url, wait_until="domcontentloaded", timeout=45000)
    await page.bring_to_front()
    out = {"url": page.url, "title": await page.title(), "status": resp.status if resp else None}
    return await _with_auth_hint(page, out)


async def _auth_hint(page) -> dict[str, Any] | None:
    """Advisory sign-in detection for the host (V3.2.1): one bounded DOM read, no values, no screenshots. The
    trusted classification is made later by the isolated broker in its own browser."""
    try:
        from nebula_guest import auth_detect

        facts = await asyncio.wait_for(page.evaluate(auth_detect.DETECT_JS, False), 2.5)
        return auth_detect.compact(auth_detect.classify(facts))
    except Exception:  # noqa: BLE001 - hints never break a browser action
        return None


async def _with_auth_hint(page, out: dict[str, Any]) -> dict[str, Any]:
    h = await _auth_hint(page)
    if h and h.get("step") not in (None, "none"):
        out["auth_hint"] = h
    return out


CLEAR_SECRETS_JS = """() => { let n = 0; const roots = [document];
 for (let r = 0; r < roots.length && roots.length < 30; r++) for (const h of roots[r].querySelectorAll('*'))
   if (h.shadowRoot && roots.length < 30) roots.push(h.shadowRoot);
 for (const root of roots) for (const el of root.querySelectorAll('input')) {
   const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
   if ((el.type || '').toLowerCase() === 'password' || /password|one-time-code/.test(ac)) {
     if (el.value) { el.value = ''; n++; } } }
 return n; }"""


async def browser_clear_secrets(args: dict[str, Any]) -> dict[str, Any]:
    """V3.4: empty every password / one-time-code field in every tab of the agent's browser (called by the host
    when a sign-in ends, so nothing the owner typed in Live Desktop stays in a field the agent could later read)."""
    cleared = 0
    if BROWSER._ctx is None:
        return {"cleared": 0}
    for p in [p for p in BROWSER._ctx.pages if not p.is_closed()]:
        for fr in p.frames[:12]:
            try:
                cleared += int(await asyncio.wait_for(fr.evaluate(CLEAR_SECRETS_JS), 3))
            except Exception:  # noqa: BLE001 - detached frames, navigation
                continue
    return {"cleared": cleared}


async def browser_auth_hint(args: dict[str, Any]) -> dict[str, Any]:
    page = await BROWSER.page()
    return {"url": page.url, "hint": await _auth_hint(page), "service_url": BROWSER.service_of(page)}


OBSERVE_JS = """
() => {
  const out = [];
  const els = document.querySelectorAll('a,button,input,textarea,select,[role=button],[contenteditable=true]');
  let i = 0;
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.top > innerHeight * 3) continue;
    const ref = 'n' + (i++);
    el.setAttribute('data-nebula-ref', ref);
    // V3.4: the value of a password / one-time-code field never leaves the page (e.g. typed by the owner in Live
    // Desktop): the agent gets its label only
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    const secret = (el.type || '').toLowerCase() === 'password' || /password|one-time-code/.test(ac);
    const val = secret ? '' : (el.value || '');
    out.push({ref: '[data-nebula-ref="' + ref + '"]', tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || undefined, masked: secret || undefined,
      text: (el.innerText || val || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || '').trim().slice(0, 80),
      href: el.getAttribute('href') ? el.href.slice(0, 200) : undefined});
    if (out.length >= 80) break;
  }
  return {elements: out, text: (document.body ? document.body.innerText : '').slice(0, 6000)};
}
"""


async def browser_observe(args: dict[str, Any]) -> dict[str, Any]:
    page = await BROWSER.page()
    try:
        data = await asyncio.wait_for(page.evaluate(OBSERVE_JS), 20)
    except TimeoutError:
        # frozen page/renderer: recover by restarting the browser (profile and cookies are kept on disk)
        await browser_close({})
        raise ToolError("browser_unresponsive", "the page did not respond within 20 s; the browser was restarted — "
                                                "navigate again") from None
    return {"url": page.url, "title": await page.title(), **data}


async def browser_click(args: dict[str, Any]) -> dict[str, Any]:
    sel = str(args.get("selector", ""))
    if not sel or len(sel) > 500:
        raise ToolError("invalid_argument", "selector required")
    page = await BROWSER.page()
    await page.click(sel, timeout=15000)
    await page.wait_for_load_state("domcontentloaded", timeout=15000)
    return await _with_auth_hint(page, {"clicked": sel, "url": page.url, "title": await page.title()})


async def browser_type(args: dict[str, Any]) -> dict[str, Any]:
    sel = str(args.get("selector", ""))
    text = str(args.get("text", ""))
    if not sel or len(text) > 10000:
        raise ToolError("invalid_argument", "selector required, text <= 10000 chars")
    page = await BROWSER.page()
    await page.fill(sel, text, timeout=15000)
    if args.get("submit"):
        await page.press(sel, "Enter")
        await page.wait_for_load_state("domcontentloaded", timeout=15000)
    return {"typed_into": sel, "chars": len(text), "url": page.url}


async def browser_import_cookies(args: dict[str, Any]) -> dict[str, Any]:
    """Session hand-off from the Password Vault broker (called by the root guest service; cookies only — the
    password never reaches this process)."""
    cookies = args.get("cookies")
    if not isinstance(cookies, list) or len(cookies) > 200:
        raise ToolError("invalid_argument", "cookies must be a list (max 200)")
    keep = []
    for c in cookies:
        if isinstance(c, dict) and isinstance(c.get("name"), str) and isinstance(c.get("value"), str) and c.get("domain"):
            keep.append({k: c[k] for k in ("name", "value", "domain", "path", "expires", "httpOnly", "secure",
                                           "sameSite") if k in c})
    await BROWSER.page()  # make sure the agent's persistent browser context exists
    if keep:
        await BROWSER._ctx.add_cookies(keep)
    return {"imported": len(keep)}


# ---------------------------------------------------------------- shell
async def shell_execute(args: dict[str, Any]) -> dict[str, Any]:
    command = str(args.get("command", ""))
    if not command.strip() or len(command) > 8000:
        raise ToolError("invalid_argument", "command required (<= 8000 chars)")
    timeout = min(max(int(args.get("timeout", 60)), 1), 600)
    cwd = confine(args.get("cwd") or ".")
    if not cwd.is_dir():
        raise ToolError("invalid_path", "cwd is not a directory")
    env = {"HOME": str(HOME), "USER": USER, "LOGNAME": USER, "LANG": "C.UTF-8", "DISPLAY": DISPLAY,
           "XAUTHORITY": str(HOME / ".Xauthority"), "TERM": "xterm-256color",
           "PATH": "/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin",
           "NEBULA_WORKSPACE": str(WORKSPACE)}
    started = time.time()
    proc = await asyncio.create_subprocess_exec("/bin/bash", "-c", command, cwd=str(cwd), env=env,
                                                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                                                stdin=asyncio.subprocess.DEVNULL, start_new_session=True)
    timed_out = False
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout)
    except TimeoutError:
        timed_out = True
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        out, err = await proc.communicate()
    return {"exit_code": proc.returncode, "timed_out": timed_out, "elapsed_s": round(time.time() - started, 3),
            "stdout": out[:MAX_OUTPUT].decode(errors="replace"), "stdout_truncated": len(out) > MAX_OUTPUT,
            "stderr": err[:MAX_OUTPUT].decode(errors="replace"), "stderr_truncated": len(err) > MAX_OUTPUT,
            "cwd": str(cwd)}


# ---------------------------------------------------------------- files
async def files_list(args: dict[str, Any]) -> dict[str, Any]:
    p = confine(args.get("path"))
    if not p.is_dir():
        raise ToolError("not_a_directory", str(p))
    entries = []
    for child in sorted(p.iterdir())[:500]:
        st = os.lstat(child)
        entries.append({"name": child.name, "type": "symlink" if stat.S_ISLNK(st.st_mode)
                        else "dir" if stat.S_ISDIR(st.st_mode) else "file",
                        "size": st.st_size, "mtime": int(st.st_mtime)})
    return {"path": rel_display(p), "entries": entries}


async def files_read(args: dict[str, Any]) -> dict[str, Any]:
    p = confine(args.get("path"))
    if not p.is_file():
        raise ToolError("not_a_file", str(args.get("path")))
    limit = min(int(args.get("max_bytes", MAX_READ)), MAX_READ)
    fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as fh:
        data = fh.read(limit + 1)
    return {"path": rel_display(p), "content": data[:limit].decode(errors="replace"),
            "truncated": len(data) > limit, "size": p.stat().st_size}


async def files_write(args: dict[str, Any]) -> dict[str, Any]:
    p = confine(args.get("path"))
    if args.get("content_b64"):
        data = base64.b64decode(str(args["content_b64"]), validate=True)
    else:
        data = str(args.get("content", "")).encode()
    if len(data) > MAX_WRITE:
        raise ToolError("too_large", "content exceeds 4 MiB")
    p.parent.mkdir(parents=True, exist_ok=True)
    confine(str(p.parent))
    flags = os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW | (os.O_APPEND if args.get("append") else os.O_TRUNC)
    fd = os.open(p, flags, 0o640)
    with os.fdopen(fd, "wb") as fh:
        fh.write(data)
    return {"path": rel_display(p), "bytes_written": len(data), "append": bool(args.get("append"))}


async def browser_close(args: dict[str, Any]) -> dict[str, Any]:
    """Free memory between tasks (resource mode IDLE); the profile on disk is kept."""
    was = BROWSER._ctx is not None
    await BROWSER.close()
    BROWSER._ctx = None
    BROWSER._pw = None
    return {"closed": was}


async def health(args: dict[str, Any]) -> dict[str, Any]:
    return {"user": USER, "display": DISPLAY, "workspace": str(WORKSPACE), "pid": os.getpid(),
            "browser_running": BROWSER._ctx is not None}


# ================================================================ V2: advanced computer control & skills
import hashlib  # noqa: E402
import html as _html  # noqa: E402
import shutil  # noqa: E402
import urllib.parse  # noqa: E402

PROC_DIR = HOME / ".nebula" / "procs"
DOWNLOADS = "Downloads"
MAX_DOWNLOAD = 200 * 1024 * 1024
LAUNCHABLE = {"terminal": ["xfce4-terminal"], "files": ["thunar"], "editor": ["mousepad"],
              "text-editor": ["mousepad"], "browser": None}


def _grab_hash() -> str:
    from PIL import ImageGrab

    img = ImageGrab.grab(xdisplay=DISPLAY).convert("L").resize((160, 100))
    return hashlib.blake2b(img.tobytes(), digest_size=16).hexdigest()


async def _screen_hash() -> str | None:
    try:
        return await asyncio.get_running_loop().run_in_executor(None, _grab_hash)
    except Exception:  # noqa: BLE001 - verification is best effort
        return None


async def _active_window_name() -> str | None:
    try:
        rc, out, _ = await _run(["xdotool", "getactivewindow", "getwindowname"], timeout=5)
        return out.strip()[:200] if rc == 0 else None
    except ToolError:
        return None


async def desktop_move(args: dict[str, Any]) -> dict[str, Any]:
    x, y = _int(args, "x", 0, 8000), _int(args, "y", 0, 8000)
    rc, _, err = await _run(["xdotool", "mousemove", "--sync", str(x), str(y)])
    if rc:
        raise ToolError("xdotool_failed", err[:300])
    return {"pointer": [x, y]}


async def desktop_drag(args: dict[str, Any]) -> dict[str, Any]:
    x1, y1 = _int(args, "from_x", 0, 8000), _int(args, "from_y", 0, 8000)
    x2, y2 = _int(args, "to_x", 0, 8000), _int(args, "to_y", 0, 8000)
    before = await _screen_hash()
    for argv in (["xdotool", "mousemove", "--sync", str(x1), str(y1), "mousedown", "1"],
                 ["xdotool", "mousemove", "--sync", str((x1 + x2) // 2), str((y1 + y2) // 2)],
                 ["xdotool", "mousemove", "--sync", str(x2), str(y2), "mouseup", "1"]):
        rc, _, err = await _run(argv)
        if rc:
            await _run(["xdotool", "mouseup", "1"])
            raise ToolError("xdotool_failed", err[:300])
        await asyncio.sleep(0.15)
    return {"dragged": [[x1, y1], [x2, y2]], "screen_changed": before != await _screen_hash()}


async def _windows() -> list[dict[str, Any]]:
    rc, out, _ = await _run(["xdotool", "search", "--onlyvisible", "--name", "."], timeout=10)
    wins = []
    for wid in out.split()[:60]:
        rc1, name, _ = await _run(["xdotool", "getwindowname", wid], timeout=5)
        rc2, geo, _ = await _run(["xdotool", "getwindowgeometry", "--shell", wid], timeout=5)
        g = dict(line.split("=", 1) for line in geo.splitlines() if "=" in line) if rc2 == 0 else {}
        if rc1 == 0 and name.strip():
            wins.append({"id": wid, "title": name.strip()[:200], "x": int(g.get("X", 0)), "y": int(g.get("Y", 0)),
                         "width": int(g.get("WIDTH", 0)), "height": int(g.get("HEIGHT", 0))})
    return [w for w in wins if w["width"] > 40 and w["height"] > 40]


async def desktop_windows(args: dict[str, Any]) -> dict[str, Any]:
    return {"windows": await _windows(), "active": await _active_window_name()}


async def _resolve_window(args: dict[str, Any]) -> str:
    wid = str(args.get("window_id") or "")
    if wid:
        if not wid.isdigit():
            raise ToolError("invalid_argument", "window_id must be numeric (from desktop_windows)")
        return wid
    title = str(args.get("title") or "")
    if not title:
        raise ToolError("invalid_argument", "window_id or title required")
    for w in await _windows():
        if title.lower() in w["title"].lower():
            return w["id"]
    raise ToolError("window_not_found", f"no visible window titled like {title!r}")


async def desktop_window(args: dict[str, Any]) -> dict[str, Any]:
    wid = await _resolve_window(args)
    action = args.get("action", "focus")
    argv = {"focus": ["xdotool", "windowactivate", "--sync", wid],
            "minimize": ["xdotool", "windowminimize", wid],
            "close": ["xdotool", "windowclose", wid],
            "maximize": ["xdotool", "windowsize", wid, "100%", "100%"]}.get(action)
    if not argv:
        raise ToolError("invalid_argument", "action must be focus|minimize|maximize|close")
    rc, _, err = await _run(argv, timeout=10)
    if rc:
        raise ToolError("xdotool_failed", err[:300] or f"{action} failed")
    return {"window_id": wid, "action": action, "active": await _active_window_name()}


async def desktop_launch(args: dict[str, Any]) -> dict[str, Any]:
    app = str(args.get("app", ""))
    if app not in LAUNCHABLE:
        raise ToolError("invalid_argument", f"app must be one of {', '.join(LAUNCHABLE)}")
    if app == "browser":
        page = await BROWSER.page()
        await page.bring_to_front()
        return {"launched": "browser", "url": page.url}
    exe = LAUNCHABLE[app]
    if not exe or not shutil.which(exe[0]):
        raise ToolError("not_installed", f"{app} is not installed in the VM")
    env = dict(os.environ, DISPLAY=DISPLAY)
    proc = await asyncio.create_subprocess_exec(*exe, cwd=str(WORKSPACE), env=env, stdin=asyncio.subprocess.DEVNULL,
                                                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
                                                start_new_session=True)
    await asyncio.sleep(1.2)
    return {"launched": app, "pid": proc.pid, "active": await _active_window_name()}


async def desktop_state(args: dict[str, Any]) -> dict[str, Any]:
    """Current screen state without an image: active window, visible windows, browser tabs, screen hash."""
    st: dict[str, Any] = {"active_window": await _active_window_name(), "windows": await _windows(),
                          "screen_hash": await _screen_hash()}
    if BROWSER._ctx is not None:
        st["browser_tabs"] = [{"index": i, "url": p.url} for i, p in enumerate(BROWSER._ctx.pages) if not p.is_closed()]
    return st


# ---- browser tabs / navigation / downloads
async def _pages() -> list[Any]:
    await BROWSER.page()
    return [p for p in BROWSER._ctx.pages if not p.is_closed()]


async def browser_tabs(args: dict[str, Any]) -> dict[str, Any]:
    pages = await _pages()
    out = []
    for i, p in enumerate(pages):
        try:
            title = await asyncio.wait_for(p.title(), 5)
        except Exception:  # noqa: BLE001
            title = "(not responding)"
        out.append({"index": i, "url": p.url, "title": title})
    return {"tabs": out, "active_index": len(pages) - 1}


async def browser_tab(args: dict[str, Any]) -> dict[str, Any]:
    action = args.get("action", "new")
    pages = await _pages()
    if action == "new":
        page = await BROWSER._ctx.new_page()
        if args.get("url"):
            await browser_navigate({"url": args["url"]})
        return {"opened": True, "index": len(pages), "url": page.url}
    idx = int(args.get("index", -1))
    if not 0 <= idx < len(pages):
        raise ToolError("invalid_argument", f"index must be 0..{len(pages) - 1}")
    page = pages[idx]
    if action == "switch":
        await page.bring_to_front()
        # make the chosen tab the one later tools act on (BROWSER.page() returns the last page)
        BROWSER.focus = page
        return {"switched": idx, "url": page.url, "title": await page.title()}
    if action == "close":
        await page.close()
        return {"closed": idx, "remaining": len(pages) - 1}
    raise ToolError("invalid_argument", "action must be new|switch|close")


async def browser_history(args: dict[str, Any]) -> dict[str, Any]:
    page = await BROWSER.page()
    action = args.get("action", "back")
    if action == "back":
        await page.go_back(timeout=30000)
    elif action == "forward":
        await page.go_forward(timeout=30000)
    elif action == "reload":
        await page.reload(timeout=45000)
    else:
        raise ToolError("invalid_argument", "action must be back|forward|reload")
    return {"url": page.url, "title": await page.title()}


async def browser_download(args: dict[str, Any]) -> dict[str, Any]:
    """Download a URL (with the browser's cookies) or the file behind a link selector into workspace/Downloads."""
    dest_dir = confine(DOWNLOADS)
    dest_dir.mkdir(parents=True, exist_ok=True)
    page = await BROWSER.page()
    if args.get("selector"):
        async with page.expect_download(timeout=60000) as dl_info:
            await page.click(str(args["selector"]), timeout=15000)
        dl = await dl_info.value
        name = Path(dl.suggested_filename).name or "download.bin"
        target = confine(f"{DOWNLOADS}/{name}")
        await dl.save_as(str(target))
    else:
        url = str(args.get("url", ""))
        if not re.match(r"^https?://", url, re.I):
            raise ToolError("invalid_url", "url must start with http:// or https://")
        resp = await BROWSER._ctx.request.get(url, timeout=120000)
        if not resp.ok:
            raise ToolError("download_failed", f"HTTP {resp.status}")
        body = await resp.body()
        if len(body) > MAX_DOWNLOAD:
            raise ToolError("too_large", "download exceeds 200 MiB")
        name = Path(urllib.parse.urlparse(url).path).name or "download.bin"
        name = re.sub(r"[^\w.\-]", "_", name)[:120]
        target = confine(f"{DOWNLOADS}/{name}")
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o640)
        with os.fdopen(fd, "wb") as fh:
            fh.write(body)
    return {"path": rel_display(target), "size": target.stat().st_size}


async def browser_wait(args: dict[str, Any]) -> dict[str, Any]:
    page = await BROWSER.page()
    if args.get("selector"):
        await page.wait_for_selector(str(args["selector"]), timeout=min(int(args.get("timeout_ms", 15000)), 60000))
        return {"found": args["selector"]}
    await asyncio.sleep(min(int(args.get("timeout_ms", 1000)), 30000) / 1000)
    return {"waited_ms": args.get("timeout_ms", 1000)}


async def web_search(args: dict[str, Any]) -> dict[str, Any]:
    """Web research through the agent's own visible browser (DuckDuckGo HTML results page)."""
    q = str(args.get("query", "")).strip()
    if not q or len(q) > 300:
        raise ToolError("invalid_argument", "query required (<= 300 chars)")
    page = await BROWSER.page()
    await page.goto("https://html.duckduckgo.com/html/?q=" + urllib.parse.quote_plus(q), wait_until="domcontentloaded",
                    timeout=45000)
    await page.bring_to_front()
    results = await page.evaluate("""() => [...document.querySelectorAll('.result')].slice(0, 10).map(r => ({
        title: (r.querySelector('.result__a')||{}).innerText || '',
        url: (r.querySelector('.result__a')||{}).href || '',
        snippet: ((r.querySelector('.result__snippet')||{}).innerText || '').slice(0, 300)}))""")
    for r in results:  # unwrap DuckDuckGo redirect links
        m = re.search(r"[?&]uddg=([^&]+)", r.get("url", ""))
        if m:
            r["url"] = urllib.parse.unquote(m.group(1))
    blocked = not results and "anomaly" in (await page.content()).lower()
    return {"query": q, "results": [r for r in results if r.get("url")], "blocked": blocked,
            "note": "search page refused automated access; open sites directly with browser_navigate" if blocked else None}


# ---- files
async def files_mkdir(args: dict[str, Any]) -> dict[str, Any]:
    p = confine(args.get("path"))
    p.mkdir(parents=True, exist_ok=True)
    return {"created": rel_display(p)}


async def files_move(args: dict[str, Any]) -> dict[str, Any]:
    src, dst = confine(args.get("src")), confine(args.get("dst"))
    if not src.exists():
        raise ToolError("not_found", str(args.get("src")))
    if dst.is_dir():
        dst = confine(str(Path(rel_display(dst)) / src.name)) if not str(args.get("dst", "")).startswith("/") else dst / src.name
    if dst.exists() and not args.get("overwrite"):
        raise ToolError("exists", f"{rel_display(dst)} exists (set overwrite)")
    os.replace(src, dst)
    return {"moved": rel_display(src), "to": rel_display(dst)}


async def files_copy(args: dict[str, Any]) -> dict[str, Any]:
    src, dst = confine(args.get("src")), confine(args.get("dst"))
    if not src.exists():
        raise ToolError("not_found", str(args.get("src")))
    if dst.is_dir():
        dst = dst / src.name
    if dst.exists() and not args.get("overwrite"):
        raise ToolError("exists", f"{rel_display(dst)} exists (set overwrite)")
    if src.is_dir():
        shutil.copytree(src, dst, symlinks=True, dirs_exist_ok=bool(args.get("overwrite")))
    else:
        shutil.copyfile(src, dst, follow_symlinks=False)
    return {"copied": rel_display(src), "to": rel_display(dst)}


async def files_delete(args: dict[str, Any]) -> dict[str, Any]:
    p = confine(args.get("path"))
    if p in (WORKSPACE,) or p.parent == SHARED_ROOT:
        raise ToolError("refused", "the workspace / team directory itself cannot be deleted")
    if not p.exists():
        raise ToolError("not_found", str(args.get("path")))
    if p.is_dir():
        if not args.get("recursive"):
            p.rmdir()
        else:
            shutil.rmtree(p)
    else:
        p.unlink()
    return {"deleted": rel_display(p), "recursive": bool(args.get("recursive"))}


async def files_edit(args: dict[str, Any]) -> dict[str, Any]:
    p = confine(args.get("path"))
    if not p.is_file():
        raise ToolError("not_a_file", str(args.get("path")))
    find, repl = str(args.get("find", "")), str(args.get("replace", ""))
    if not find:
        raise ToolError("invalid_argument", "find required")
    data = p.read_text(errors="replace")
    n = data.count(find)
    if n == 0:
        raise ToolError("no_match", "text to replace not found")
    if n > 1 and not args.get("all"):
        raise ToolError("ambiguous", f"{n} matches; set all=true or make 'find' unique")
    data = data.replace(find, repl) if args.get("all") else data.replace(find, repl, 1)
    if len(data.encode()) > MAX_WRITE:
        raise ToolError("too_large", "result exceeds 4 MiB")
    fd = os.open(p, os.O_WRONLY | os.O_TRUNC | os.O_NOFOLLOW)
    with os.fdopen(fd, "w") as fh:
        fh.write(data)
    return {"path": rel_display(p), "replacements": n if args.get("all") else 1}


async def files_search(args: dict[str, Any]) -> dict[str, Any]:
    root = confine(args.get("path"))
    pat = str(args.get("pattern", "")).lower()
    contains = str(args.get("contains", ""))
    hits = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for f in filenames:
            fp = Path(dirpath) / f
            if pat and pat not in f.lower():
                continue
            if contains:
                try:
                    if fp.stat().st_size > 2_000_000 or contains not in fp.read_text(errors="ignore"):
                        continue
                except OSError:
                    continue
            hits.append({"path": rel_display(fp), "size": fp.lstat().st_size})
            if len(hits) >= 200:
                return {"results": hits, "truncated": True}
    return {"results": hits, "truncated": False}


async def files_stat(args: dict[str, Any]) -> dict[str, Any]:
    p = confine(args.get("path"))
    if not p.exists():
        raise ToolError("not_found", str(args.get("path")))
    st = os.lstat(p)
    return {"path": rel_display(p), "type": "dir" if p.is_dir() else "file", "size": st.st_size,
            "mtime": int(st.st_mtime), "mode": oct(st.st_mode & 0o777)}


# ---- processes
async def process_list(args: dict[str, Any]) -> dict[str, Any]:
    rc, out, _ = await _run(["ps", "-u", USER, "-o", "pid=,etimes=,rss=,args="], timeout=10)
    procs = []
    for line in out.splitlines()[:200]:
        parts = line.split(None, 3)
        if len(parts) == 4:
            procs.append({"pid": int(parts[0]), "elapsed_s": int(parts[1]), "rss_kb": int(parts[2]),
                          "command": parts[3][:200]})
    return {"processes": procs}


async def process_kill(args: dict[str, Any]) -> dict[str, Any]:
    pid = _int(args, "pid", 2, 4_194_304)
    if pid == os.getpid():
        raise ToolError("refused", "cannot kill the NEBULA tool server")
    try:
        os.kill(pid, signal.SIGTERM)  # the kernel only allows the agent's own processes
    except ProcessLookupError:
        raise ToolError("not_found", f"no process {pid}") from None
    except PermissionError:
        raise ToolError("permission_denied", "not this agent's process") from None
    return {"terminated": pid}


async def process_start(args: dict[str, Any]) -> dict[str, Any]:
    """Start a long-running background process (e.g. a dev server); output goes to a log file."""
    command = str(args.get("command", ""))
    if not command.strip() or len(command) > 4000:
        raise ToolError("invalid_argument", "command required")
    cwd = confine(args.get("cwd") or ".")
    PROC_DIR.mkdir(parents=True, exist_ok=True)
    pid_name = f"p{int(time.time() * 1000)}"
    log_path = PROC_DIR / f"{pid_name}.log"
    fd = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    env = {"HOME": str(HOME), "USER": USER, "LANG": "C.UTF-8", "DISPLAY": DISPLAY,
           "PATH": "/usr/local/bin:/usr/bin:/bin", "NEBULA_WORKSPACE": str(WORKSPACE)}
    proc = await asyncio.create_subprocess_exec("/bin/bash", "-c", command, cwd=str(cwd), env=env, stdout=fd,
                                                stderr=fd, stdin=asyncio.subprocess.DEVNULL, start_new_session=True)
    os.close(fd)
    await asyncio.sleep(1.0)
    return {"id": pid_name, "pid": proc.pid, "running": proc.returncode is None, "log": str(log_path)}


async def process_output(args: dict[str, Any]) -> dict[str, Any]:
    pid_name = str(args.get("id", ""))
    if not re.match(r"^p\d{10,16}$", pid_name):
        raise ToolError("invalid_argument", "id from process_start required")
    log_path = PROC_DIR / f"{pid_name}.log"
    if not log_path.exists():
        raise ToolError("not_found", pid_name)
    data = log_path.read_bytes()
    return {"id": pid_name, "output": data[-MAX_OUTPUT:].decode(errors="replace"), "bytes": len(data)}


# ---- skills: git, pdf, data, python, node, documents
GIT_SUBCOMMANDS = {"status", "log", "diff", "init", "add", "commit", "clone", "checkout", "switch", "branch", "pull",
                   "fetch", "push", "show", "rev-parse", "restore", "remote", "config", "tag", "stash", "merge"}


async def git_run(args: dict[str, Any]) -> dict[str, Any]:
    argv = args.get("args")
    if not isinstance(argv, list) or not argv or not all(isinstance(a, str) and len(a) < 500 for a in argv):
        raise ToolError("invalid_argument", "args must be a list of strings, e.g. [\"status\"]")
    if argv[0] not in GIT_SUBCOMMANDS:
        raise ToolError("invalid_argument", f"git subcommand {argv[0]!r} is not allowed")
    if argv[0] == "config" and not any(a in argv for a in ("user.name", "user.email", "--get", "--list", "-l")):
        raise ToolError("invalid_argument", "only user.name / user.email / reading config is allowed")
    if any(a.startswith("--upload-pack") or a.startswith("--exec") or a.startswith("-c") for a in argv):
        raise ToolError("invalid_argument", "option not allowed")
    cwd = confine(args.get("cwd") or ".")
    env = {"HOME": str(HOME), "USER": USER, "LANG": "C.UTF-8", "PATH": "/usr/bin:/bin", "GIT_TERMINAL_PROMPT": "0"}
    proc = await asyncio.create_subprocess_exec("git", *argv, cwd=str(cwd), env=env, stdout=asyncio.subprocess.PIPE,
                                                stderr=asyncio.subprocess.PIPE, stdin=asyncio.subprocess.DEVNULL)
    try:
        out, err = await asyncio.wait_for(proc.communicate(), 180)
    except TimeoutError:
        proc.kill()
        raise ToolError("timeout", "git timed out") from None
    return {"exit_code": proc.returncode, "stdout": out[:MAX_OUTPUT].decode(errors="replace"),
            "stderr": err[:8000].decode(errors="replace")}


async def pdf_text(args: dict[str, Any]) -> dict[str, Any]:
    p = confine(args.get("path"))
    if not p.is_file():
        raise ToolError("not_a_file", str(args.get("path")))
    if not shutil.which("pdftotext"):
        raise ToolError("not_installed", "pdftotext (poppler-utils) is not installed in the VM; run Repair")
    first, last = int(args.get("first_page", 1)), int(args.get("last_page", 0))
    argv = ["pdftotext", "-layout", "-f", str(first)] + (["-l", str(last)] if last else []) + [str(p), "-"]
    rc, out, err = await _run(argv, timeout=120)
    if rc:
        raise ToolError("pdf_failed", err[:300])
    rc2, info, _ = await _run(["pdfinfo", str(p)], timeout=30) if shutil.which("pdfinfo") else (1, "", "")
    pages = re.search(r"Pages:\s+(\d+)", info or "")
    return {"path": rel_display(p), "pages": int(pages.group(1)) if pages else None,
            "text": out[:MAX_READ], "truncated": len(out) > MAX_READ}


def _load_table(p: Path, fmt: str) -> list[dict[str, Any]]:
    import csv

    if fmt == "csv" or (fmt == "auto" and p.suffix.lower() in (".csv", ".tsv")):
        with open(p, newline="", errors="replace") as fh:
            sample = fh.read(4096)
            fh.seek(0)
            dialect = csv.Sniffer().sniff(sample) if sample else csv.excel
            return list(csv.DictReader(fh, dialect=dialect))[:200000]
    data = json.loads(p.read_text(errors="replace"))
    if isinstance(data, dict):
        data = next((v for v in data.values() if isinstance(v, list)), [data])
    return [r if isinstance(r, dict) else {"value": r} for r in data][:200000]


def _num(v: Any) -> float | None:
    try:
        return float(str(v).replace(",", "").strip())
    except (TypeError, ValueError):
        return None


async def data_analyze(args: dict[str, Any]) -> dict[str, Any]:
    """Basic data analysis of a CSV/JSON file: row count, per-column types, numeric stats, top values."""
    p = confine(args.get("path"))
    if not p.is_file() or p.stat().st_size > 50 * 1024 * 1024:
        raise ToolError("invalid_argument", "path must be a CSV/JSON file <= 50 MiB")
    rows = _load_table(p, str(args.get("format", "auto")))
    cols: dict[str, dict[str, Any]] = {}
    for r in rows:
        for k, v in r.items():
            c = cols.setdefault(str(k), {"count": 0, "numeric": [], "values": {}})
            if v in (None, ""):
                continue
            c["count"] += 1
            n = _num(v)
            if n is not None:
                c["numeric"].append(n)
            if len(c["values"]) < 5000:
                c["values"][str(v)[:80]] = c["values"].get(str(v)[:80], 0) + 1
    out = {}
    for k, c in list(cols.items())[:100]:
        nums = c["numeric"]
        d: dict[str, Any] = {"non_empty": c["count"]}
        if nums and len(nums) >= 0.8 * max(1, c["count"]):
            s = sorted(nums)
            d.update(type="number", min=s[0], max=s[-1], mean=round(sum(s) / len(s), 4), median=s[len(s) // 2],
                     sum=round(sum(s), 4))
        else:
            top = sorted(c["values"].items(), key=lambda kv: kv[1], reverse=True)[:5]
            d.update(type="text", distinct=len(c["values"]), top=top)
        out[k] = d
    group = args.get("group_by")
    groups = None
    if group and group in cols:
        agg_col = args.get("sum_column")
        groups = {}
        for r in rows:
            g = str(r.get(group, ""))[:80]
            groups.setdefault(g, {"rows": 0, "sum": 0.0})
            groups[g]["rows"] += 1
            if agg_col:
                groups[g]["sum"] += _num(r.get(agg_col)) or 0.0
        groups = dict(sorted(groups.items(), key=lambda kv: kv[1]["rows"], reverse=True)[:50])
    return {"path": rel_display(p), "rows": len(rows), "columns": out, "groups": groups,
            "sample": rows[:3]}


async def data_convert(args: dict[str, Any]) -> dict[str, Any]:
    """Convert between CSV and JSON (workspace files)."""
    import csv

    src, dst = confine(args.get("src")), confine(args.get("dst"))
    rows = _load_table(src, "auto")
    if dst.suffix.lower() == ".json":
        payload = json.dumps(rows, ensure_ascii=False, indent=2).encode()
    elif dst.suffix.lower() == ".csv":
        keys: list[str] = []
        for r in rows:
            keys += [k for k in r if k not in keys]
        buf = io.StringIO()
        w = csv.DictWriter(buf, fieldnames=keys)
        w.writeheader()
        w.writerows(rows)
        payload = buf.getvalue().encode()
    else:
        raise ToolError("invalid_argument", "dst must end with .csv or .json")
    if len(payload) > MAX_WRITE * 4:
        raise ToolError("too_large", "result too large")
    fd = os.open(dst, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o640)
    with os.fdopen(fd, "wb") as fh:
        fh.write(payload)
    return {"src": rel_display(src), "dst": rel_display(dst), "rows": len(rows)}


async def _run_code(interp: list[str], args: dict[str, Any], suffix: str) -> dict[str, Any]:
    cwd = confine(args.get("cwd") or ".")
    timeout = min(max(int(args.get("timeout", 60)), 1), 600)
    if args.get("path"):
        script = confine(args["path"])
        if not script.is_file():
            raise ToolError("not_a_file", str(args["path"]))
    else:
        code = str(args.get("code", ""))
        if not code.strip() or len(code) > 200_000:
            raise ToolError("invalid_argument", "code or path required")
        d = HOME / ".nebula" / "scratch"
        d.mkdir(parents=True, exist_ok=True)
        script = d / f"snippet-{int(time.time() * 1000)}{suffix}"
        script.write_text(code)
    extra = [str(a) for a in (args.get("args") or [])][:50]
    env = {"HOME": str(HOME), "USER": USER, "LANG": "C.UTF-8", "PATH": "/usr/local/bin:/usr/bin:/bin",
           "NEBULA_WORKSPACE": str(WORKSPACE), "DISPLAY": DISPLAY}
    proc = await asyncio.create_subprocess_exec(*interp, str(script), *extra, cwd=str(cwd), env=env,
                                                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                                                stdin=asyncio.subprocess.DEVNULL, start_new_session=True)
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout)
        timed_out = False
    except TimeoutError:
        timed_out = True
        os.killpg(proc.pid, signal.SIGKILL)
        out, err = await proc.communicate()
    return {"exit_code": proc.returncode, "timed_out": timed_out, "stdout": out[:MAX_OUTPUT].decode(errors="replace"),
            "stderr": err[:MAX_OUTPUT].decode(errors="replace")}


async def python_run(args: dict[str, Any]) -> dict[str, Any]:
    return await _run_code(["/usr/bin/python3", "-I"], args, ".py")


def _node_binary() -> str | None:
    if shutil.which("node"):
        return shutil.which("node")
    for cand in Path("/opt/nebula/venv/lib").glob("python3*/site-packages/playwright/driver/node"):
        if os.access(cand, os.X_OK):
            return str(cand)
    return None


async def node_run(args: dict[str, Any]) -> dict[str, Any]:
    node = _node_binary()
    if not node:
        raise ToolError("not_installed", "Node.js is not available in the VM")
    return await _run_code([node], args, ".js")


class _TextOnly(__import__("html.parser").parser.HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.out: list[str] = []
        self._skip = 0

    def handle_starttag(self, tag, attrs):  # noqa: ANN001
        if tag in ("script", "style"):
            self._skip += 1
        elif tag in ("p", "br", "div", "li", "h1", "h2", "h3", "tr"):
            self.out.append("\n")

    def handle_endtag(self, tag):  # noqa: ANN001
        if tag in ("script", "style") and self._skip:
            self._skip -= 1

    def handle_data(self, data):  # noqa: ANN001
        if not self._skip:
            self.out.append(data)


def _md_to_html(md: str) -> str:
    out, in_list, in_code = [], False, False
    for line in md.splitlines():
        if line.startswith("```"):
            out.append("</pre>" if in_code else "<pre>")
            in_code = not in_code
            continue
        if in_code:
            out.append(_html.escape(line))
            continue
        esc = _html.escape(line)
        esc = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", esc)
        esc = re.sub(r"`(.+?)`", r"<code>\1</code>", esc)
        esc = re.sub(r"\[(.+?)\]\((https?://[^)\s]+)\)", r'<a href="\2">\1</a>', esc)
        m = re.match(r"^(#{1,6})\s+(.*)", esc)
        if re.match(r"^\s*[-*]\s+", line):
            if not in_list:
                out.append("<ul>")
                in_list = True
            out.append(f"<li>{re.sub(r'^\s*[-*]\s+', '', esc)}</li>")
            continue
        if in_list:
            out.append("</ul>")
            in_list = False
        if m:
            n = len(m.group(1))
            out.append(f"<h{n}>{m.group(2)}</h{n}>")
        elif esc.strip():
            out.append(f"<p>{esc}</p>")
    if in_list:
        out.append("</ul>")
    return "<!doctype html><meta charset=utf-8><body>" + "\n".join(out) + "</body>"


async def doc_convert(args: dict[str, Any]) -> dict[str, Any]:
    """Document processing: markdown -> html, html -> text, and text statistics."""
    src, dst = confine(args.get("src")), confine(args.get("dst"))
    data = src.read_text(errors="replace")
    if src.stat().st_size > MAX_WRITE:
        raise ToolError("too_large", "source exceeds 4 MiB")
    to = dst.suffix.lower()
    if to == ".html" and src.suffix.lower() in (".md", ".markdown", ".txt"):
        out = _md_to_html(data)
    elif to in (".txt", ".md") and src.suffix.lower() in (".html", ".htm"):
        p = _TextOnly()
        p.feed(data)
        out = re.sub(r"\n{3,}", "\n\n", "".join(p.out)).strip()
    else:
        raise ToolError("invalid_argument", "supported: .md/.txt -> .html, .html -> .txt/.md")
    fd = os.open(dst, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o640)
    with os.fdopen(fd, "w") as fh:
        fh.write(out)
    words = len(re.findall(r"\w+", out))
    return {"src": rel_display(src), "dst": rel_display(dst), "chars": len(out), "words": words}


# ---- plugins (untrusted code, run as this agent's unprivileged user inside the VM)
PLUGIN_ROOT = Path(os.environ.get("NEBULA_PLUGIN_ROOT", "/opt/nebula/plugins"))


async def plugin_run(args: dict[str, Any]) -> dict[str, Any]:
    pid, tool = str(args.get("plugin_id", "")), str(args.get("tool", ""))
    if not re.match(r"^[a-z0-9][a-z0-9_.-]{1,63}$", pid) or not re.match(r"^[a-z][a-z0-9_]{0,47}$", tool):
        raise ToolError("invalid_argument", "plugin_id/tool invalid")
    base = PLUGIN_ROOT / pid / "current"
    manifest = json.loads((base / "nebula-plugin.json").read_text())
    if tool not in {t["name"] for t in manifest.get("tools", [])}:
        raise ToolError("unknown_tool", f"{pid} has no tool {tool}")
    entry = base / manifest["entrypoint"]
    if base.resolve() not in entry.resolve().parents:
        raise ToolError("invalid_plugin", "entrypoint outside plugin")
    env = {"HOME": str(HOME), "USER": USER, "LANG": "C.UTF-8", "PATH": "/usr/bin:/bin",
           "NEBULA_WORKSPACE": str(WORKSPACE), "NEBULA_PLUGIN_TOOL": tool}
    proc = await asyncio.create_subprocess_exec("/usr/bin/python3", "-I", str(entry), tool, cwd=str(WORKSPACE), env=env,
                                                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                                                stderr=asyncio.subprocess.PIPE, start_new_session=True)
    payload = json.dumps({"tool": tool, "args": args.get("args") or {}, "workspace": str(WORKSPACE),
                          "config": args.get("config") or {}}).encode()
    try:
        out, err = await asyncio.wait_for(proc.communicate(payload), min(int(manifest.get("timeout_s", 60)), 300))
    except TimeoutError:
        os.killpg(proc.pid, signal.SIGKILL)
        raise ToolError("timeout", f"plugin {pid}.{tool} timed out") from None
    try:
        result = json.loads(out.decode() or "null")
    except json.JSONDecodeError:
        result = {"raw_output": out[:MAX_OUTPUT].decode(errors="replace")}
    return {"plugin": pid, "tool": tool, "exit_code": proc.returncode, "result": result,
            "stderr": err[:4000].decode(errors="replace")}


TOOLS = {
    "desktop.screenshot": desktop_screenshot,
    "desktop.click": desktop_click,
    "desktop.type": desktop_type,
    "desktop.keypress": desktop_keypress,
    "desktop.scroll": desktop_scroll,
    "browser.navigate": browser_navigate,
    "browser.observe": browser_observe,
    "browser.click": browser_click,
    "browser.type": browser_type,
    "shell.execute": shell_execute,
    "files.list": files_list,
    "files.read": files_read,
    "files.write": files_write,
    "browser.close": browser_close,
    "tools.health": health,
    # V2
    "desktop.move": desktop_move,
    "desktop.drag": desktop_drag,
    "desktop.windows": desktop_windows,
    "desktop.window": desktop_window,
    "desktop.launch": desktop_launch,
    "desktop.state": desktop_state,
    "browser.tabs": browser_tabs,
    "browser.tab": browser_tab,
    "browser.history": browser_history,
    "browser.download": browser_download,
    "browser.wait": browser_wait,
    "web.search": web_search,
    "files.mkdir": files_mkdir,
    "files.move": files_move,
    "files.copy": files_copy,
    "files.delete": files_delete,
    "files.edit": files_edit,
    "files.search": files_search,
    "files.stat": files_stat,
    "process.list": process_list,
    "process.kill": process_kill,
    "process.start": process_start,
    "process.output": process_output,
    "git.run": git_run,
    "pdf.text": pdf_text,
    "data.analyze": data_analyze,
    "data.convert": data_convert,
    "python.run": python_run,
    "node.run": node_run,
    "doc.convert": doc_convert,
    "plugin.run": plugin_run,
    "browser.import_cookies": browser_import_cookies,
    "browser.auth_hint": browser_auth_hint,
    "browser.clear_secrets": browser_clear_secrets,
}
READ_ONLY_CONCURRENT = {"desktop.screenshot", "tools.health", "desktop.state", "process.list", "process.output"}
DISPLAY_GUARD_EXEMPT = {"tools.health"}

_serial = asyncio.Lock()


def display_guard() -> None:
    """Refuse to act while any socket of this agent's display is served by another uid (display squatting by
    another agent, audit VM-06): every tool may start an X client (browser, xdotool, screenshot, shell) that would
    otherwise send this agent's X cookie, pages and input to the other agent's X server."""
    from nebula_guest import xdisplay

    n = xdisplay.display_number(DISPLAY)
    if n is None:
        return
    bad = xdisplay.foreign_listeners(n, os.getuid())
    if bad:
        raise ToolError("display_untrusted", f"display {DISPLAY} is served by another user; refusing to use it "
                                             f"(restart this agent's desktop): {bad}")


async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        line = await reader.readline()
        req = json.loads(line)
        tool = req.get("tool")
        fn = TOOLS.get(tool)
        if fn is not None and tool not in DISPLAY_GUARD_EXEMPT:
            display_guard()
        if fn is None:
            resp: dict[str, Any] = {"ok": False, "error": {"code": "unknown_tool", "message": str(tool)}}
        else:
            # screenshots may run concurrently with an action; everything else is serialized
            if tool in READ_ONLY_CONCURRENT:
                result = await fn(req.get("args") or {})
            else:
                async with _serial:
                    result = await fn(req.get("args") or {})
            resp = {"ok": True, "result": result}
    except ToolError as e:
        resp = {"ok": False, "error": {"code": e.code, "message": str(e)}}
    except Exception as e:  # report, never crash the server
        resp = {"ok": False, "error": {"code": type(e).__name__, "message": str(e)[:1000]}}
    try:
        writer.write(json.dumps(resp).encode() + b"\n")
        await writer.drain()
    finally:
        writer.close()


async def main() -> None:
    WORKSPACE.mkdir(parents=True, exist_ok=True)
    try:
        os.unlink(SOCKET_PATH)
    except FileNotFoundError:
        pass
    old = os.umask(0o177)
    server = await asyncio.start_unix_server(handle, path=SOCKET_PATH, limit=1 << 20)
    os.umask(old)
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)
    async with server:
        await stop.wait()
    await BROWSER.close()


if __name__ == "__main__":
    asyncio.run(main())
