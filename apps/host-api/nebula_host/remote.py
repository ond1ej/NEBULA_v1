"""Secure remote access for the Telegram Mini App (V3 module 1/2).

Telegram Mini Apps and the native apps need an HTTPS origin. The web dashboard and its password sign-in are never
bound to a public address or served through a tunnel; instead NEBULA runs a separate **remote gateway** (the Mini
App gateway) on a loopback-only port (default: the dashboard port + 2, i.e. 127.0.0.1:3102). Through it an
authenticated owner session can still administer NEBULA (the same central policy table as the dashboard), so the
gateway should be reachable only from devices the owner controls. An HTTPS tunnel or reverse proxy chosen and
enabled by the owner points at that port: Tailscale Serve (recommended: reachable only inside the owner's tailnet),
or — public on the Internet, with an explicit confirmation — Tailscale Funnel or a Cloudflare quick tunnel, or the
owner's own proxy. Tailscale commands are scoped
to this instance's HTTPS port; NEBULA never resets or turns off the node's other Serve/Funnel entries. The gateway

* serves only the Mini App bundle and its assets,
* authenticates every API call with a short-lived Mini App session created from verified Telegram initData
  (Bearer token — no cookies, so no CSRF surface) and enforces the session's permissions,
* forwards the API routes of the central policy table (nebula_host.authz) — never the dashboard's own sign-in/setup
  or Mac-only operations — to the local API, which applies the same role/permission/step-up policy to every caller
  (the owner administers NEBULA from the phone; operators and agent bots keep their limited permissions),
* streams the Live Desktop over an authenticated WebSocket (single-use viewer token + Mini App session),
* rate-limits per client and per session, checks Host, rejects cross-origin requests and sets strict headers
  (CSP allowing telegram.org for the WebApp script; framing only by Telegram Web).

Nothing is exposed until the owner enables the gateway AND sets up a tunnel; NEBULA never configures port
forwarding and never creates external accounts.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import re
import shutil
import socket
import subprocess
import time
from collections import defaultdict, deque
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from fastapi import Request, WebSocket  # module level: annotations are resolved from module globals

from nebula_host import auth, db, miniapp
from nebula_host.events import audit, bus

log = logging.getLogger("nebula.remote")
GATEWAY_SECRET = __import__("secrets").token_urlsafe(32)  # proves to the local API that a call came via the gateway
# no fixed "port" here: without a stored one, settings() uses default_port() (the dashboard port + 2)
DEFAULTS = {"enabled": False, "public_url": None, "tunnel": "none", "rate_limit_per_min": 240,
            "tailscale_https_port": 443}
# provider ids are stable (stored in the DB). "tailscale_serve" (tailnet-only, nothing on the public Internet) is the
# recommended choice; "tailscale_funnel" and "cloudflared_quick" publish the gateway on the Internet.
TUNNELS = ("none", "tailscale_serve", "tailscale_funnel", "cloudflared_quick", "custom")
RECOMMENDED_TUNNEL = "tailscale_serve"
PUBLIC_TUNNELS = ("tailscale_funnel", "cloudflared_quick")
FUNNEL_PORTS = (443, 8443, 10000)  # the only HTTPS ports Tailscale Funnel accepts
MAX_AUTH_BODY = 16 * 1024  # unauthenticated gateway endpoints
MAX_FORWARD_BODY = 60 * 1024 * 1024
MAX_RATE_KEYS = 10_000


class BodyTooLarge(ValueError):
    pass


async def read_limited(request: Request, limit: int) -> bytes:
    """Read a request body, refusing it as soon as it exceeds `limit` (never buffers more: L-03)."""
    cl = request.headers.get("content-length")
    if cl is not None:
        try:
            if int(cl) > limit:
                raise BodyTooLarge("request body too large")
        except ValueError as e:
            if isinstance(e, BodyTooLarge):
                raise
            raise ValueError("bad content-length") from None
    buf = bytearray()
    async for chunk in request.stream():
        buf += chunk
        if len(buf) > limit:
            raise BodyTooLarge("request body too large")
    return bytes(buf)


def claim_live_session(live_session_id: str) -> None:
    """L-04: make the viewer token really single-use. `authorize_ws` checks state == CONNECTING; this conditional
    UPDATE moves exactly one WebSocket from CONNECTING to VIEWING, so two upgrades racing with the same token cannot
    both pass. Raises PermissionError for the loser."""
    from sqlalchemy import and_, update

    from nebula_host import models

    with db.engine().begin() as c:
        n = c.execute(update(models.live_sessions).where(and_(
            models.live_sessions.c.id == live_session_id, models.live_sessions.c.state == "CONNECTING"))
            .values(state="VIEWING", last_seen_at=time.time())).rowcount
    if n != 1:
        raise PermissionError("session already in use (tokens are single-use)")


def _instance_port() -> int:
    try:
        from nebula_host.config import get_config

        return int(get_config().instance.port)
    except Exception:  # noqa: BLE001 - config unavailable (unit context): the default dashboard port
        return 3100


def default_port() -> int:
    """Gateway port when none is stored: the dashboard port + 2 (3102 for the default dashboard port 3100)."""
    return _instance_port() + 2


def reserved_ports(cfg=None) -> set[int]:
    """Ports the gateway must never take: the dashboard port and the LAN listener ports of this instance."""
    if cfg is None:
        try:
            from nebula_host.config import get_config

            cfg = get_config()
        except Exception:  # noqa: BLE001
            return {_instance_port()}
    out = {int(cfg.instance.port)}
    lan = getattr(cfg, "lan", None)
    if lan is not None and getattr(lan, "https_port", None):
        out.add(int(lan.https_port))
    return out

# V3.3: which API routes the gateway forwards comes from the ONE policy table (nebula_host.authz.POLICY): every route
# except the dashboard's own sign-in/setup ("public") and Mac-only operations ("local"). Who may call a forwarded route
# (owner / operator / agent bot), with which permission and how fresh the owner's verification must be is decided by
# the host for every request — the same checks for the dashboard and the Mini App.
_SAFE_PATH = re.compile(r"^/[A-Za-z0-9_\-./]*$")
_DENY_HEADERS = {"host", "cookie", "authorization", "origin", "referer", "x-csrf-token", "content-length",
                 "connection", "accept-encoding", "x-forwarded-for", "x-forwarded-host", "x-real-ip"}


def settings() -> dict[str, Any]:
    return {**DEFAULTS, "port": default_port(), **(db.get_setting("remote", {}) or {})}


def _last_forwarded_for(headers) -> str | None:
    """The address appended by the trusted proxy (the LAST X-Forwarded-For element; earlier ones come from the
    client and can be anything)."""
    parts = [x.strip() for x in (headers.get("x-forwarded-for") or "").split(",") if x.strip()]
    return parts[-1] if parts else None


def trusted_client(headers, peer: str, tunnel: str | None) -> str:
    """The rate-limit identity of a gateway client (L-02). Proxy headers count only when the request reached the
    gateway through the configured tunnel (a loopback peer), and only the header that tunnel sets itself."""
    if peer not in ("127.0.0.1", "::1"):
        return peer
    v = None
    if tunnel == "cloudflared_quick":
        v = headers.get("cf-connecting-ip")  # set (overwritten) by Cloudflare
    elif tunnel == "tailscale_serve":
        v = headers.get("tailscale-user-login") or _last_forwarded_for(headers)  # set by tailscaled for tailnet users
    elif tunnel in ("tailscale_funnel", "custom"):
        v = _last_forwarded_for(headers)
    return (v or peer)[:64]


def public_base() -> str | None:
    s = settings()
    url = (s.get("public_url") or "").rstrip("/")
    return url if s.get("enabled") and url.startswith("https://") else None


def allowed(method: str, path: str) -> tuple[bool, str | None]:
    """(forwarded?, policy) — path-normalisation tricks (`..`, `//`, encoded separators, dots, backslashes) never
    reach the policy table."""
    from nebula_host import authz

    if not _SAFE_PATH.match(path) or "//" in path or path != path.rstrip("/") or len(path) > 300 or \
            any(seg.startswith(".") for seg in path.split("/")[1:]):
        return False, None
    hit = authz.match(method, path)
    if hit is None or hit[0] in ("public", "local"):
        return False, None
    return True, hit[0]


# ============================================================================ gateway app
def build_gateway(main_port: int, dist: Path, forward_client=None, listen_port: int | None = None):
    """The gateway app. `listen_port`: the loopback port it is served on (default: the configured gateway port);
    Host and Origin are checked against it."""
    import httpx
    from fastapi import FastAPI
    from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, StreamingResponse
    from starlette.middleware.base import BaseHTTPMiddleware

    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    client = forward_client or httpx.AsyncClient(base_url=f"http://127.0.0.1:{main_port}",
                                                 timeout=httpx.Timeout(30, read=None))
    hits: dict[str, deque] = defaultdict(deque)
    stats = {"requests": 0, "denied": 0, "rate_limited": 0}
    app.state.stats = stats

    def client_key(request) -> str:
        peer = request.client.host if request.client else "?"
        return trusted_client(request.headers, peer[:64], settings().get("tunnel"))

    def rate_ok(key: str) -> bool:
        limit = int(settings().get("rate_limit_per_min") or 240)
        now = time.time()
        if key not in hits and len(hits) >= MAX_RATE_KEYS:  # bounded: stale keys first, then the oldest
            for k in [k for k, q in hits.items() if not q or now - q[-1] > 60]:
                hits.pop(k, None)
            while len(hits) >= MAX_RATE_KEYS:
                hits.pop(next(iter(hits)))
        q = hits[key]
        while q and now - q[0] > 60:
            q.popleft()
        if len(q) >= limit:
            return False
        q.append(now)
        return True

    def host_ok(host: str | None) -> bool:
        s = settings()
        pub = urlparse(s.get("public_url") or "").netloc
        lp = listen_port or s["port"]
        return (host or "") in {pub, f"127.0.0.1:{lp}", f"localhost:{lp}"} or (
            os.environ.get("NEBULA_TESTING") == "1" and host in ("testserver", "testserver:80"))

    class Guard(BaseHTTPMiddleware):
        async def dispatch(self, request: Request, call_next):
            stats["requests"] += 1
            if not host_ok(request.headers.get("host")):
                stats["denied"] += 1
                return JSONResponse({"error": {"code": "bad_host", "message": "unknown host"}}, status_code=421)
            origin = request.headers.get("origin")
            pub = settings().get("public_url") or ""
            local_origin = f"http://127.0.0.1:{listen_port or settings()['port']}"
            if origin and origin.rstrip("/") not in {pub.rstrip("/"), local_origin} and \
                    os.environ.get("NEBULA_TESTING") != "1":
                stats["denied"] += 1
                return JSONResponse({"error": {"code": "bad_origin", "message": "cross-origin request rejected"}},
                                    status_code=403)
            key = client_key(request)
            tok = (request.headers.get("authorization") or "")[7:][:12]
            if not rate_ok(key) or (tok and not rate_ok("tok:" + tok)):
                stats["rate_limited"] += 1
                return JSONResponse({"error": {"code": "rate_limited", "message": "too many requests"}},
                                    status_code=429)
            resp = await call_next(request)
            resp.headers["X-Content-Type-Options"] = "nosniff"
            resp.headers["Referrer-Policy"] = "no-referrer"
            resp.headers["Strict-Transport-Security"] = "max-age=31536000"
            resp.headers["Content-Security-Policy"] = (
                "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self' 'unsafe-inline'; "
                "img-src 'self' data: blob: https://t.me https://*.telegram.org; media-src 'self' blob:; connect-src 'self' wss: ; "
                "font-src 'self' data:; frame-ancestors https://web.telegram.org https://*.telegram.org; "
                "base-uri 'none'; form-action 'self'; object-src 'none'")
            # the Mini App may record voice messages (MediaRecorder) — only for its own origin
            resp.headers["Permissions-Policy"] = "camera=(), microphone=(self), geolocation=()"
            return resp

    app.add_middleware(Guard)

    def principal(request_or_token) -> tuple[auth.Principal, dict[str, Any]]:
        token = request_or_token if isinstance(request_or_token, str) else \
            (request_or_token.headers.get("authorization") or "")
        if token.lower().startswith("bearer "):
            token = token[7:]
        p = auth._session_from_token(token.strip() or None)
        info = miniapp.session_info(p) if p else None
        if not p or not info:
            raise PermissionError("Mini App session required")
        miniapp.touch(p.session_id)  # sliding expiry while the app is in use (hard cap: 12 h after sign-in)
        return p, info

    @app.get("/healthz")
    async def healthz():
        return {"ok": True}

    @app.get("/")
    async def root():
        return RedirectResponse("/mini/")

    @app.get("/mini")
    @app.get("/mini/")
    @app.get("/mini/{path:path}")
    async def mini(path: str = ""):
        page = dist / "mini.html"
        if not page.exists():
            return JSONResponse({"message": "Mini App not built"}, status_code=503)
        return FileResponse(page, headers={"Cache-Control": "no-store"})

    @app.get("/assets/{path:path}")
    async def assets(path: str, request: Request):
        f = (dist / "assets" / path).resolve()
        if (dist / "assets").resolve() not in f.parents or not f.is_file() or f.name.endswith((".br", ".gz")):
            return JSONResponse({"error": {"code": "not_found"}}, status_code=404)
        from nebula_host.static import file_response

        return file_response(f, request.headers.get("accept-encoding"), immutable=True)

    @app.post("/api/mini/auth")
    async def mini_auth(request: Request):
        try:
            body = json.loads(await read_limited(request, MAX_AUTH_BODY) or b"{}")
            if not isinstance(body, dict):
                raise ValueError("object expected")
            r = miniapp.exchange(str(body.get("init_data") or ""), client=request.headers.get("user-agent", ""))
        except miniapp.MiniAuthError as e:
            return JSONResponse({"error": {"code": e.code, "message": e.message}}, status_code=e.status)
        except BodyTooLarge:
            return JSONResponse({"error": {"code": "too_large", "message": "request body too large"}},
                                status_code=413)
        except (ValueError, json.JSONDecodeError):
            return JSONResponse({"error": {"code": "bad_request", "message": "JSON body with init_data"}}, status_code=400)
        return {"data": r}

    @app.post("/api/mini/logout")
    async def mini_logout(request: Request):
        try:
            p, info = principal(request)
        except PermissionError:
            return JSONResponse({"error": {"code": "unauthenticated"}}, status_code=401)
        miniapp.revoke(p.session_id, f"miniapp:{info['telegram_user_id']}")
        return {"data": {"logged_out": True}}

    # ---------------------------------------------------------------- V4.0: the owner's native NEBULA apps
    def app_error(e) -> JSONResponse:
        return JSONResponse({"error": {"code": e.code, "message": e.message, "details": e.details}},
                            status_code=e.status, headers={"Cache-Control": "no-store"})

    async def app_body(request: Request) -> dict[str, Any]:
        raw = await read_limited(request, MAX_AUTH_BODY)  # L-03: refused before it is buffered
        body = json.loads(raw or b"{}")
        if not isinstance(body, dict):
            raise ValueError("object expected")
        return body

    @app.get("/api/app/hello")
    async def app_hello():
        """Unauthenticated reachability check before pairing: who is this server (no data)."""
        from nebula_host import devices
        from nebula_host.config import APP_VERSION

        return JSONResponse({"data": {"service": "nebula", "version": APP_VERSION, "api": 4,
                                      "server_fingerprint": devices.server_fingerprint()}},
                            headers={"Cache-Control": "no-store"})

    @app.post("/api/app/pair/claim")
    async def app_pair_claim(request: Request):
        from nebula_host import devices

        try:
            return JSONResponse({"data": devices.claim(await app_body(request), client=client_key(request))},
                                status_code=201, headers={"Cache-Control": "no-store"})
        except devices.DeviceError as e:
            stats["denied"] += 1
            return app_error(e)
        except (ValueError, json.JSONDecodeError):
            return JSONResponse({"error": {"code": "bad_request", "message": "JSON object expected"}}, status_code=400)

    @app.post("/api/app/session/challenge")
    async def app_session_challenge(request: Request):
        from nebula_host import devices

        try:
            body = await app_body(request)
            return JSONResponse({"data": devices.session_challenge(str(body.get("device_id") or ""),
                                                                   client=client_key(request))},
                                headers={"Cache-Control": "no-store"})
        except devices.DeviceError as e:
            return app_error(e)
        except (ValueError, json.JSONDecodeError):
            return JSONResponse({"error": {"code": "bad_request", "message": "JSON object expected"}}, status_code=400)

    @app.post("/api/app/session")
    async def app_session(request: Request):
        from nebula_host import devices

        try:
            return JSONResponse({"data": devices.sign_in(await app_body(request), client=client_key(request))},
                                status_code=201, headers={"Cache-Control": "no-store"})
        except devices.DeviceError as e:
            stats["denied"] += 1
            return app_error(e)
        except (ValueError, json.JSONDecodeError):
            return JSONResponse({"error": {"code": "bad_request", "message": "JSON object expected"}}, status_code=400)

    @app.post("/api/app/logout")
    async def app_logout(request: Request):
        from nebula_host import devices

        try:
            p, info = principal(request)
        except PermissionError:
            return JSONResponse({"error": {"code": "unauthenticated"}}, status_code=401)
        if info.get("kind") != "app":
            return JSONResponse({"error": {"code": "app_only"}}, status_code=403)
        devices.logout(p.session_id, info["device_id"])
        return {"data": {"logged_out": True}}

    @app.api_route("/api/v1/{path:path}", methods=["GET", "POST", "PATCH", "PUT", "DELETE"])
    async def forward(path: str, request: Request):
        rel = "/" + path
        ok, perm = allowed(request.method, rel)
        if not ok:
            stats["denied"] += 1
            return JSONResponse({"error": {"code": "not_available_remotely",
                                           "message": "this action is only available in the local Dashboard"}},
                                status_code=403)
        try:
            p, info = principal(request)
        except PermissionError:
            return JSONResponse({"error": {"code": "unauthenticated", "message": "Mini App session required"}},
                                status_code=401)
        if rel == "/miniapp/me":
            from nebula_host import authz

            ctx = authz.context_for(p, info)
            return {"data": {"session_id": p.session_id, **info, "expires_in": miniapp.SESSION_TTL_S,
                             "role": ctx.role, "admin": ctx.owner,
                             "assurance": {"fresh_until": ctx.fresh_until, "fresh": ctx.fresh}}}
        if info.get("kind") != "app" and (rel == "/app/me" or rel == "/app/push"):
            return JSONResponse({"error": {"code": "app_only", "message": "for the NEBULA app only"}},
                                status_code=403)
        from sqlalchemy import select

        from nebula_host import models

        with db.engine().connect() as c:
            row = c.execute(select(models.sessions.c.csrf_token).where(models.sessions.c.id == p.session_id)).first()
        token = (request.headers.get("authorization") or "")[7:].strip()
        headers = {k: v for k, v in request.headers.items() if k.lower() not in _DENY_HEADERS}
        headers.update({"host": f"127.0.0.1:{main_port}", "origin": f"http://127.0.0.1:{main_port}",
                        "cookie": f"{auth.COOKIE}={token}", auth.CSRF_HEADER: row.csrf_token if row else "",
                        "x-nebula-via": p.actor, "x-nebula-gateway": GATEWAY_SECRET,
                        # the raw upstream bytes are relayed: ask only for an encoding the phone accepts
                        "accept-encoding": "gzip" if "gzip" in (request.headers.get("accept-encoding") or "")
                        else "identity"})
        try:
            body = await read_limited(request, MAX_FORWARD_BODY)
        except BodyTooLarge:
            return JSONResponse({"error": {"code": "too_large"}}, status_code=413)
        except ValueError:
            return JSONResponse({"error": {"code": "bad_request"}}, status_code=400)
        req = client.build_request(request.method, f"/api/v1/{path}", params=request.query_params, headers=headers,
                                   content=body)
        upstream = await client.send(req, stream=True)
        out_headers = {k: v for k, v in upstream.headers.items()
                       if k.lower() in ("content-type", "content-disposition", "cache-control", "x-request-id",
                                        "idempotent-replay", "content-encoding", "vary")}  # raw bytes are relayed

        async def body_iter():
            try:
                async for chunk in upstream.aiter_raw():
                    yield chunk
            finally:
                await upstream.aclose()

        return StreamingResponse(body_iter(), status_code=upstream.status_code, headers=out_headers)

    @app.websocket("/api/v1/live/ws/{session_id}")
    async def live_ws(ws: WebSocket, session_id: str):
        from nebula_host.state import svc

        try:
            if not host_ok(ws.headers.get("host")):
                raise PermissionError("bad host")
            p, info = principal(ws.query_params.get("session_token") or "")
            if "desktop" not in info["permissions"]:
                raise PermissionError("desktop permission required")
            s = svc.live.authorize_ws(session_id, ws.query_params.get("token") or "", p.session_id)
            claim_live_session(session_id)
        except PermissionError as e:
            await ws.close(code=4403, reason=str(e)[:100])
            return
        wanted = [x.strip() for x in (ws.headers.get("sec-websocket-protocol") or "").split(",")]
        await ws.accept(subprotocol="binary" if "binary" in wanted else None)  # noVNC asks for "binary"
        audit(p.actor, "live.stream.remote", s["agent_id"], {"live_session_id": session_id})
        await svc.live.stream(ws, s)

    @app.api_route("/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
    async def nothing(path: str):
        return JSONResponse({"error": {"code": "not_found"}}, status_code=404)

    return app


# ============================================================================ manager (listener + tunnel)
class RemoteManager:
    def __init__(self, cfg) -> None:
        self.cfg = cfg
        self.server = None
        self.task: asyncio.Task | None = None
        self.gateway = None
        self.tunnel_proc: subprocess.Popen | None = None
        self.tunnel_url: str | None = None
        self.last_error: str | None = None

    def dist(self) -> Path:
        from nebula_host.app import DASHBOARD_DIST

        return Path(os.environ.get("NEBULA_DASHBOARD_DIST", DASHBOARD_DIST))

    async def start(self) -> None:
        if settings()["enabled"]:
            await self._listen()

    async def stop(self) -> None:
        await self._unlisten()
        self._stop_tunnel_proc()

    async def _listen(self) -> None:
        if self.task and not self.task.done():
            return
        from nebula_host.lan import _QuietServer

        s = settings()
        port = int(s["port"])
        if port in reserved_ports(self.cfg):
            self.last_error = f"port {port} is reserved (the dashboard and LAN ports are reserved)"
            return
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            sock.bind(("127.0.0.1", port))  # loopback only: a tunnel/proxy chosen by the owner connects locally
            sock.listen(64)
            sock.setblocking(False)
        except OSError as e:
            self.last_error = f"cannot listen on 127.0.0.1:{port}: {e}"
            log.error(self.last_error)
            return
        self.gateway = build_gateway(self.cfg.instance.port, self.dist(), listen_port=port)
        self.server = _QuietServer.make(self.gateway, ssl_files=None)
        self.task = asyncio.create_task(self.server.serve(sockets=[sock]), name="miniapp-gateway")
        self.last_error = None
        log.info("Mini App gateway listening on http://127.0.0.1:%d (loopback only)", port)

    async def _unlisten(self) -> None:
        if self.server is not None:
            self.server.should_exit = True
            with contextlib.suppress(Exception):
                await asyncio.wait_for(self.task, 10)
        self.server, self.task = None, None

    async def configure(self, body: dict[str, Any], actor: str) -> dict[str, Any]:
        s = settings()
        if "public_url" in body:
            url = (body.get("public_url") or "").strip().rstrip("/") or None
            if url and not re.match(r"^https://[A-Za-z0-9.-]+(:\d+)?$", url):
                raise ValueError("public_url must be an https:// origin without a path (Telegram requires HTTPS)")
            s["public_url"] = url
        if "tunnel" in body:
            if body["tunnel"] not in TUNNELS:
                raise ValueError(f"tunnel must be one of {', '.join(TUNNELS)}")
            s["tunnel"] = body["tunnel"]
        if "port" in body:
            port = int(body["port"])
            if not 1024 <= port <= 65535 or port in reserved_ports(self.cfg):
                raise ValueError("choose another port (the dashboard and LAN ports are reserved)")
            s["port"] = port
        if "tailscale_https_port" in body:
            tp = int(body["tailscale_https_port"])
            if not 1 <= tp <= 65535:
                raise ValueError("tailscale_https_port must be a TCP port")
            s["tailscale_https_port"] = tp
        if "rate_limit_per_min" in body:
            s["rate_limit_per_min"] = max(30, min(int(body["rate_limit_per_min"]), 2000))
        if "enabled" in body:
            s["enabled"] = bool(body["enabled"])
        db.set_setting("remote", s)
        audit(actor, "remote.configure", None, {k: v for k, v in s.items()})
        await self._unlisten()
        if s["enabled"]:
            await self._listen()
        bus.publish("remote.state.changed", {"enabled": s["enabled"], "public_url": s["public_url"]})
        return self.status()

    # ------------------------------------------------------------------ tunnels (owner-initiated only)
    def tunnel_tools(self) -> dict[str, Any]:
        ts = shutil.which("tailscale") or ("/usr/local/bin/tailscale" if Path("/usr/local/bin/tailscale").exists() else None)
        cf = shutil.which("cloudflared") or ("/opt/homebrew/bin/cloudflared" if Path("/opt/homebrew/bin/cloudflared").exists()
                                             else None)
        return {"tailscale": ts, "cloudflared": cf}

    # Tailscale commands are always scoped to THIS instance's HTTPS port (`--https=<port>`): NEBULA never runs a
    # node-wide `tailscale serve|funnel reset` or `... --bg off`, and refuses a port that already serves something else.
    _run = staticmethod(subprocess.run)  # injectable in tests

    async def _ts(self, argv: list[str], timeout: int = 60) -> subprocess.CompletedProcess:
        try:
            return await asyncio.to_thread(self._run, argv, capture_output=True, text=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            raise ValueError(f"{' '.join(argv[1:3])} did not answer in {timeout} s") from None

    def _ts_target(self, port: int) -> str:
        return f"http://127.0.0.1:{port}"

    async def _ts_port_conflict(self, ts: str, https_port: int, target: str) -> str | None:
        """What already serves this HTTPS port on the node (None: free or already ours)."""
        st = await self._ts([ts, "serve", "status", "--json"], 20)
        if st.returncode != 0:
            raise ValueError(f"cannot read the Tailscale serve configuration: {(st.stderr or st.stdout).strip()[:300]}")
        try:
            cfg = json.loads(st.stdout or "{}") or {}
        except ValueError:
            raise ValueError("cannot read the Tailscale serve configuration") from None
        if str(https_port) in (cfg.get("TCP") or {}) and not any(
                k.rsplit(":", 1)[-1] == str(https_port) for k in (cfg.get("Web") or {})):
            return f"a TCP forwarder on port {https_port}"
        for hostport, web in (cfg.get("Web") or {}).items():
            if hostport.rsplit(":", 1)[-1] != str(https_port):
                continue
            for path, h in ((web or {}).get("Handlers") or {}).items():
                proxy = str((h or {}).get("Proxy") or "")
                if path != "/" or proxy.rstrip("/") not in (target, target.replace("127.0.0.1", "localhost")):
                    return f"{path} -> {proxy or 'another handler'}"
        return None

    async def _ts_dns(self, ts: str) -> str | None:
        st = await self._ts([ts, "status", "--json"], 20)
        try:
            return (json.loads(st.stdout or "{}").get("Self") or {}).get("DNSName", "").rstrip(".") or None
        except ValueError:
            return None

    async def start_tunnel(self, kind: str, actor: str, confirm: bool) -> dict[str, Any]:
        if kind in PUBLIC_TUNNELS and not confirm:
            raise ValueError("starting this tunnel publishes the Mini App gateway on the Internet: confirm=true "
                             "required (Tailscale Serve keeps it inside your tailnet)")
        s = settings()
        if not s["enabled"]:
            raise ValueError("enable the Mini App gateway first")
        tools = self.tunnel_tools()
        port = int(s["port"])
        if kind in ("tailscale_serve", "tailscale_funnel"):
            if not tools["tailscale"]:
                raise ValueError("Tailscale is not installed")
            https_port = int(s.get("tailscale_https_port") or 443)
            if kind == "tailscale_funnel" and https_port not in FUNNEL_PORTS:
                raise ValueError(f"Tailscale Funnel only uses HTTPS ports {', '.join(map(str, FUNNEL_PORTS))}")
            target = self._ts_target(port)
            busy = await self._ts_port_conflict(tools["tailscale"], https_port, target)
            if busy:
                raise ValueError(f"HTTPS port {https_port} of this Mac's Tailscale node already serves {busy}; "
                                 "choose another port for NEBULA (tailscale_https_port) — NEBULA never replaces it")
            verb = "funnel" if kind == "tailscale_funnel" else "serve"
            r = await self._ts([tools["tailscale"], verb, "--bg", "--yes", f"--https={https_port}", target])
            if r.returncode != 0:
                raise ValueError(f"tailscale {verb} failed: {(r.stderr or r.stdout).strip()[:400]}")
            dns = await self._ts_dns(tools["tailscale"])
            self.tunnel_url = (f"https://{dns}" + ("" if https_port == 443 else f":{https_port}")) if dns else None
        elif kind == "cloudflared_quick":
            if not tools["cloudflared"]:
                raise ValueError("cloudflared is not installed")
            self._stop_tunnel_proc()
            self.tunnel_proc = subprocess.Popen(  # noqa: S603 - fixed argv, owner-initiated
                [tools["cloudflared"], "tunnel", "--no-autoupdate", "--url", f"http://127.0.0.1:{port}"],
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            self.tunnel_url = await asyncio.to_thread(self._read_cf_url)
        else:
            raise ValueError("unsupported tunnel")
        if self.tunnel_url:
            await self.configure({"public_url": self.tunnel_url, "tunnel": kind}, actor)
        audit(actor, "remote.tunnel.start", kind, {"url": self.tunnel_url})
        return self.status()

    def _read_cf_url(self) -> str | None:
        end = time.time() + 40
        while self.tunnel_proc and time.time() < end:
            line = self.tunnel_proc.stdout.readline() if self.tunnel_proc.stdout else ""
            m = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", line or "")
            if m:
                return m.group(0)
        return None

    def _stop_tunnel_proc(self) -> None:
        if self.tunnel_proc and self.tunnel_proc.poll() is None:
            self.tunnel_proc.terminate()
        self.tunnel_proc = None

    async def stop_tunnel(self, actor: str) -> dict[str, Any]:
        s = settings()
        tools = self.tunnel_tools()
        if s["tunnel"] in ("tailscale_funnel", "tailscale_serve") and tools["tailscale"]:
            # only THIS instance's port: other Serve/Funnel entries of the node stay untouched
            https_port = int(s.get("tailscale_https_port") or 443)
            verb = "funnel" if s["tunnel"] == "tailscale_funnel" else "serve"
            busy = None
            with contextlib.suppress(ValueError):
                busy = await self._ts_port_conflict(tools["tailscale"], https_port, self._ts_target(int(s["port"])))
            if busy is None:
                await self._ts([tools["tailscale"], verb, f"--https={https_port}", "off"], 30)
            else:
                log.warning("not stopping Tailscale %s on port %d: it now serves %s", verb, https_port, busy)
        self._stop_tunnel_proc()
        self.tunnel_url = None
        await self.configure({"public_url": None, "tunnel": "none"}, actor)
        audit(actor, "remote.tunnel.stop", s["tunnel"])
        return self.status()

    async def apply_menu_buttons(self, actor: str) -> dict[str, Any]:
        """Point the bots' menu button at the Mini App (only when a public HTTPS URL is configured)."""
        from nebula_host.state import svc

        url = public_base()
        out: dict[str, Any] = {}
        if svc.telegram and svc.telegram.running:
            try:
                await svc.telegram.api.set_chat_menu_button(f"{url}/mini/" if url else None)
                out["main"] = "ok" if url else "reset"
            except Exception as e:  # noqa: BLE001
                out["main"] = f"failed: {e}"
        if getattr(svc, "bots", None):
            for key, rn in svc.bots.runners.items():
                try:
                    await rn.api.set_chat_menu_button(f"{url}/mini/#/agents/{rn.fixed_agent}" if url else None)
                    out[key] = "ok" if url else "reset"
                except Exception as e:  # noqa: BLE001
                    out[key] = f"failed: {e}"
        audit(actor, "remote.menu_buttons", url or "reset", out)
        return out

    def status(self) -> dict[str, Any]:
        s = settings()
        tools = self.tunnel_tools()
        gw_stats = getattr(getattr(self.gateway, "state", None), "stats", None) if self.gateway else None
        return {**s, "listening": bool(self.task and not self.task.done()),
                "local_url": f"http://127.0.0.1:{s['port']}/mini/", "public_mini_url":
                    f"{public_base()}/mini/" if public_base() else None, "last_error": self.last_error,
                "tools": {k: bool(v) for k, v in tools.items()}, "tunnel_running": bool(
                    self.tunnel_proc and self.tunnel_proc.poll() is None) or (
                    s["tunnel"] in ("tailscale_funnel", "tailscale_serve") and bool(s["public_url"])),
                "tunnels": list(TUNNELS), "recommended_tunnel": RECOMMENDED_TUNNEL,
                "public_tunnels": list(PUBLIC_TUNNELS), "tunnel_public": s["tunnel"] in PUBLIC_TUNNELS,
                "stats": gw_stats, "sessions": [x for x in miniapp.list_sessions() if x["active"]][:20],
                "setup_required": None if public_base() else (
                    "Choose how your phone reaches NEBULA. Recommended: Tailscale Serve — an HTTPS address that only "
                    "devices in your own tailnet can open (install Tailscale on the phone too); nothing is published "
                    "on the Internet. Alternatives that ARE public on the Internet: Tailscale Funnel (needs Funnel "
                    "enabled in your tailnet policy) or a Cloudflare quick tunnel (install cloudflared; TLS ends at "
                    f"Cloudflare). Or your own HTTPS reverse proxy to 127.0.0.1:{s['port']}. NEBULA never opens "
                    "router ports. A tunnel reaches only the app gateway, never the Dashboard's password sign-in, "
                    "but a signed-in owner session can administer NEBULA through it: keep it private where you can.")}
