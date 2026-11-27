"""NEBULA host service: FastAPI app factory + lifespan wiring of all modules."""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

from nebula_host import auth, authz, db, secrets
from nebula_host import providers_service as provs
from nebula_host.config import APP_VERSION, NebulaConfig, get_config
from nebula_host.errors import ApiError, error_body, install_handlers, request_id_var
from nebula_host.events import audit, bus
from nebula_host.guest import GuestClient
from nebula_host.state import svc
from nebula_host.vm import VMManager

log = logging.getLogger("nebula")
_TOKEN_QS = __import__("re").compile(r"((?:token|code|state)=)[^&\s\"]+")
_BOT_TOKEN = __import__("re").compile(r"(/(?:file/)?bot)\d{5,15}:[A-Za-z0-9_-]{20,}")  # Telegram Bot API URLs


def redact_text(s: str) -> str:
    return _BOT_TOKEN.sub(r"\1[REDACTED]", _TOKEN_QS.sub(r"\1[REDACTED]", s))


class _RedactFilter(logging.Filter):
    """Live viewer tokens travel in the WebSocket query string; never write them to logs.

    Arguments are redacted one by one (formatters such as uvicorn's access log read record.args). A template with
    arguments is never edited on its own (that would eat a "token=%s" placeholder); when a secret is only visible in
    the merged message (template + argument), the record keeps the redacted message instead. Tracebacks too."""

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.args, tuple):  # (a single dict argument is stored as the dict itself)
            record.args = tuple(redact_text(a) if isinstance(a, str) else redact_text(str(a)) if _is_url(a) else a
                                for a in record.args)
        if not record.args:
            if isinstance(record.msg, str):
                record.msg = redact_text(record.msg)
        else:
            try:
                full = record.getMessage()
            except Exception:  # noqa: BLE001 - a malformed record: the handler reports it as usual
                return True
            safe = redact_text(full)
            if safe != full:
                record.msg, record.args = safe, ()
        if record.exc_info and not record.exc_text:
            record.exc_text = logging.Formatter().formatException(record.exc_info)
        if record.exc_text:
            record.exc_text = redact_text(record.exc_text)
        return True


def _is_url(a) -> bool:
    return type(a).__name__ == "URL"  # httpx.URL in "HTTP Request: %s %s" log records


_REDACTED_LOGGERS = ("uvicorn.access", "uvicorn.error", "uvicorn", "nebula", "httpx", "httpcore")


def _add_redaction(target: logging.Filterer) -> None:
    if not any(isinstance(f, _RedactFilter) for f in target.filters):
        target.addFilter(_RedactFilter())


def install_log_redaction() -> None:
    """Redact tokens in every record that reaches a handler. A logger's own filters do not run for records that
    propagate from its children (nebula.telegram, nebula.live, ...), so the filter is also attached to every handler
    that exists now: the root logger's (logging.basicConfig, pytest), uvicorn's and any other logger's (VM-18).
    Called again at start-up, after uvicorn has configured logging."""
    # httpx logs every request URL at INFO; Telegram Bot API URLs embed the bot token -> quiet + redact
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    for name in _REDACTED_LOGGERS:
        _add_redaction(logging.getLogger(name))
    loggers = [logging.getLogger(), *(lg for lg in list(logging.root.manager.loggerDict.values())
                                      if isinstance(lg, logging.Logger))]
    for lg in loggers:
        for h in list(lg.handlers):
            _add_redaction(h)
DASHBOARD_DIST = Path(__file__).resolve().parents[2] / "dashboard" / "dist"


def _authz_gate(request: Request):
    """V3.3 central authorization for requests that came through the Mini App gateway (the local dashboard is the
    owner on this Mac and is checked by the routes as before). Same policy table for both interfaces.

    Fail closed (NEW-1): routes treat "no context" (authz.current() is None) as the local dashboard owner, so a
    remote session must never reach a route without one. A remote session (Mini App or paired app) whose identity
    is no longer valid (revoked, its bot disabled or removed, its device revoked) is answered 401 here; a remote
    session without the gateway header is refused by auth.require_session, and a dashboard (non-remote) session
    WITH the gateway header is refused both here and there (N11)."""
    import hmac

    path = request.url.path
    sent = request.headers.get("x-nebula-gateway")
    if not path.startswith("/api/v1/") or not sent:
        return None, None
    from nebula_host import miniapp, remote

    if not hmac.compare_digest(sent, remote.GATEWAY_SECRET):
        return JSONResponse(error_body("unauthenticated", "invalid gateway credential"), status_code=401), None
    p = auth._session_from_token(request.cookies.get(auth.COOKIE))
    if p is None:
        return None, None  # no valid session: the route answers 401 (the gateway forwards remote sessions only)
    if not p.via:  # N11: a dashboard session never comes through the gateway; refuse it before any route runs
        return JSONResponse(error_body("unauthenticated", "the remote gateway only forwards remote sessions"),
                            status_code=401), None
    info = miniapp.session_info(p)
    if info is None:
        return JSONResponse(error_body("unauthenticated", "this remote session is no longer valid; open the app "
                                                          "again"), status_code=401), None
    rel = path[len("/api/v1"):]
    hit = authz.match(request.method, rel)
    if hit is None or hit[0] in ("public", "local"):
        return JSONResponse(error_body("not_available_remotely", "this action is only available on the Mac"),
                            status_code=403), None
    try:
        ctx = authz.context_for(p, info)
        authz.evaluate(ctx, hit[0])
        authz.check_ownership(ctx, rel, request.method, dict(request.query_params))
    except authz.Denied as d:
        audit(p.actor, "authz.denied", None, {"route": hit[1], "code": d.code})
        return JSONResponse(error_body(d.code, d.message, d.details), status_code=d.status), None
    return None, ctx


class GuardMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        rid = request.headers.get("x-request-id") or str(uuid.uuid4())
        if len(rid) > 64:
            rid = str(uuid.uuid4())
        token = request_id_var.set(rid)
        try:
            try:
                auth.check_client(request.client.host if request.client else None)
                auth.check_host_and_origin(request.headers.get("host"), request.headers.get("origin"),
                                           state_changing=request.method in ("POST", "PUT", "PATCH", "DELETE"))
            except ApiError as e:
                return JSONResponse(error_body(e.code, e.message), status_code=e.status)
            denied, ctx = _authz_gate(request)
            if denied is not None:
                return denied
            ctx_token = authz.set_current(ctx)
            try:
                resp = await call_next(request)
            finally:
                authz.reset_current(ctx_token)
        finally:
            request_id_var.reset(token)
        host = request.headers.get("host", "127.0.0.1")  # already validated against the allowlist above
        resp.headers["X-Request-ID"] = rid
        resp.headers["X-Content-Type-Options"] = "nosniff"
        resp.headers["X-Frame-Options"] = "DENY"
        resp.headers["Referrer-Policy"] = "no-referrer"
        resp.headers["Cross-Origin-Opener-Policy"] = "same-origin"
        if request.url.scheme == "https":
            resp.headers["Strict-Transport-Security"] = "max-age=31536000"
        mini = request.url.path.startswith("/mini")  # Mini App local preview may load Telegram's WebApp script
        resp.headers["Content-Security-Policy"] = (
            f"default-src 'self'; script-src 'self'{' https://telegram.org' if mini else ''}; "
            "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; "
            f"connect-src 'self' ws://{host} wss://{host}; font-src 'self' data:; "
            "frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'")
        return resp


async def _retention_loop(cfg: NebulaConfig) -> None:
    while True:
        try:
            days = cfg.agents.screenshot_retention_days
            cutoff = time.time() - days * 86400
            removed = 0
            if days > 0 and cfg.artifacts_dir.exists():
                for p in cfg.artifacts_dir.rglob("*.png"):
                    if p.stat().st_mtime < cutoff:
                        p.unlink(missing_ok=True)
                        removed += 1
                for d in sorted(cfg.artifacts_dir.glob("*/*"), reverse=True):
                    if d.is_dir() and not any(d.iterdir()):
                        shutil.rmtree(d, ignore_errors=True)
            auth.purge_expired_sessions()
            from nebula_host import approvals_v2

            await approvals_v2.expire_old()
            from nebula_telegram.cards import purge_callbacks

            from nebula_host import attachments as attsvc

            n = attsvc.cleanup_expired(cfg)
            purge_callbacks()
            from nebula_host.api.routes_v3 import NOTIFY_TYPES
            from nebula_host.events import purge_old_events

            pruned = purge_old_events(NOTIFY_TYPES)
            if pruned:
                log.info("retention: removed %d old events", pruned)
            if n:
                log.info("retention: removed %d expired attachments", n)
            if removed:
                log.info("retention: removed %d screenshots older than %d days", removed, days)
        except Exception:
            log.exception("retention loop failed")
        await asyncio.sleep(3600)


async def _vault_autolock_loop() -> None:
    """Auto-lock the Password Vault after its inactivity timeout even when nobody calls the API."""
    from nebula_host.vault import VAULT

    while True:
        try:
            VAULT.check_auto_lock()
        except Exception:  # noqa: BLE001
            log.exception("vault auto-lock check failed")
        await asyncio.sleep(15)


async def _smart_auth_loop() -> None:
    """Smart Authentication housekeeping: expire unanswered sign-in requests (releases the paused task and the
    isolated browser) and, once after start, close broker sessions a previous host process left in the VM."""
    from nebula_host import smart_auth

    swept = False
    while True:
        try:
            await smart_auth.expire_due()
            if not swept and svc.guest is not None:
                try:
                    # only sessions this host does not know (a sign-in started right after start-up survives)
                    await svc.guest.call("vault.auth_cancel_all", {"keep": list(smart_auth._RT),
                                                                   "host_id": smart_auth.host_instance_id()},
                                         timeout=10)
                    swept = True
                except Exception:  # noqa: BLE001 - VM not up yet / older guest: retry next round
                    pass
        except Exception:  # noqa: BLE001
            log.exception("smart auth housekeeping failed")
        await asyncio.sleep(10)


_restart_times: list[float] = []


async def _guest_monitor() -> None:
    """Detect an unresponsive guest (VM running but RPC dead) and surface it; never force-stops on its own."""
    fails = 0
    reported = False
    while True:
        await asyncio.sleep(15)
        try:
            if not svc.vm or not svc.vm.exists():
                continue
            st = await svc.vm.astatus()
            if st.get("state") == "stopped" and db.get_setting("vm.desired_state", "running") == "running":
                # the VM was not stopped by the owner: recover it (bounded, with backoff)
                restarts = [t for t in _restart_times if t > time.time() - 3600]
                _restart_times[:] = restarts
                if len(restarts) < 3:
                    _restart_times.append(time.time())
                    log.error("VM stopped unexpectedly; restarting it (attempt %d/3 this hour)", len(restarts) + 1)
                    bus.publish("vm.state.changed", {"state": "restarting", "reason": "unexpected stop"})
                    await asyncio.to_thread(svc.vm.start, 60)
                    bus.publish("vm.state.changed", {"state": "running", "by": "recovery"})
                elif not reported:
                    reported = True
                    bus.publish("vm.state.changed", {"state": "failed", "detail": "VM keeps stopping; see vm-helper.log"})
                continue
            if st.get("state") != "running":
                fails = 0
                continue
            await svc.guest.ping(timeout=10)
            if reported:
                bus.publish("vm.state.changed", {"state": "running", "guest": "responsive"})
            fails, reported = 0, False
        except Exception as e:  # noqa: BLE001
            fails += 1
            if fails >= 3 and not reported:
                reported = True
                log.error("guest unresponsive for ~90 s: %s", e)
                bus.publish("vm.state.changed", {"state": "unresponsive", "detail": str(e)[:300],
                                                 "hint": "check host memory pressure; System -> Stop VM / Start VM"})


async def _vm_supervisor() -> None:
    """Bring the VM up after login/restart if it should be running, then reconcile agents with the guest."""
    from nebula_setup.installer import get_installation

    from nebula_host import agents_service

    inst = get_installation()
    if not inst or inst["state"] != "READY":
        return
    if db.get_setting("vm.desired_state", "running") == "running" and svc.vm.exists():
        try:
            st = await asyncio.to_thread(svc.vm.status)
            if st.get("state") != "running":
                log.info("starting VM (desired state: running)")
                await asyncio.to_thread(svc.vm.start, 60)
                bus.publish("vm.state.changed", {"state": "running", "by": "supervisor"})
        except Exception as e:  # noqa: BLE001
            log.error("VM autostart failed: %s", e)
            return
    for _ in range(60):
        try:
            await svc.guest.ping(timeout=3)
            break
        except Exception:  # noqa: BLE001
            await asyncio.sleep(2)
    r = await agents_service.reconcile(svc.guest)
    log.info("agent reconcile: %s", r)


@asynccontextmanager
async def lifespan(app: FastAPI):
    cfg = get_config()
    cfg.ensure_dirs()
    install_log_redaction()  # again: handlers added after create_app() (uvicorn's log config) get the filter too
    svc.cfg = cfg
    svc.started_at = time.time()
    secrets.init_store(cfg.secret_backend)
    await asyncio.to_thread(db.init_engine, cfg.db_path)
    bus.bind_loop(asyncio.get_running_loop())
    provs.ensure_catalog()
    tok = auth.ensure_setup_token()
    if tok:
        log.warning("No administrator yet. Open http://127.0.0.1:%d/#/setup?token=<token from %s>",
                    cfg.instance.port, auth.setup_token_path())

    from nebula_live.broker import LiveBroker
    from nebula_runtime.orchestrator import Orchestrator
    from nebula_setup.installer import guest_key
    from nebula_telegram.gateway import TelegramGateway

    svc.vm = VMManager(cfg)
    svc.guest = GuestClient(svc.vm.run_dir, guest_key)
    svc.orch = Orchestrator(cfg, svc.guest)
    svc.live = LiveBroker(cfg, svc.guest, svc.orch)

    async def create_agent_from_telegram(body: dict, actor: str) -> dict:
        from nebula_host import agents_service

        defaults = db.get_setting("agents.defaults", {}) or {}
        body = {**{k: v for k, v in defaults.items() if k in ("provider_id", "model_id")}, **body}
        return await agents_service.create(svc.guest, body, actor)

    svc.telegram = TelegramGateway(cfg, svc.orch, svc.guest, create_agent_from_telegram)
    # ---- V2 services
    from nebula_host import approvals_v2, memory, skills
    from nebula_host.files_service import FileBridge
    from nebula_host.resources import ResourceManager
    from nebula_host.schedules import Scheduler
    from nebula_host.teams import TeamManager
    from nebula_host.workflows import WorkflowEngine

    skills.ensure_builtins()
    svc.files = FileBridge(cfg, svc.guest)
    svc.teams = TeamManager(svc.orch, svc.guest)
    svc.resources = ResourceManager(cfg, svc.orch, svc.guest, svc.live)
    svc.orch.resources = svc.resources
    svc.schedules = Scheduler(svc.orch, svc.teams)
    svc.workflows = WorkflowEngine(svc.orch, svc.teams, svc.files, svc.telegram.send_to_owners, svc.schedules)
    svc.schedules.workflows = svc.workflows
    svc.telegram.v2 = svc  # teams / schedules / workflows / files for Telegram 2.0 commands
    v2_listeners = (svc.teams.on_event, svc.schedules.on_event, svc.workflows.on_event)
    for listener in v2_listeners:
        bus.add_listener(listener)

    async def _approve_workflow(ref: dict, decision: str, actor: str) -> None:
        ev = svc.workflows.waiters.get(f"approval:{ref.get('approval_id')}")
        if ev:
            ev.set()

    async def _approve_misfire(ref: dict, decision: str, actor: str) -> None:
        await svc.schedules.confirm_misfire(ref["run_id"], decision == "approved", actor)

    # ---- V3 services
    from nebula_telegram import v3 as tg3
    from nebula_telegram.cards import cards as task_cards
    from nebula_telegram.multibot import AgentBotManager

    from nebula_host import remote as remotesvc
    from nebula_host.companies import CompanyManager
    from nebula_host.hostexec import HostExecutor

    svc.host = HostExecutor(cfg)
    svc.orch.host = svc.host
    svc.companies = CompanyManager(svc.orch, svc.files, svc.guest, svc.host)
    svc.bots = AgentBotManager(cfg, svc.orch, svc.guest)
    svc.bots.svc = svc
    svc.remote = remotesvc.RemoteManager(cfg)
    task_cards.public_url = remotesvc.public_base

    async def _cards_listener(ev: dict) -> None:
        if ev["type"].startswith("task."):
            await tg3.on_task_event(None, ev)

    from nebula_host import push

    v3_listeners = (svc.companies.on_event, _cards_listener, push.listener)  # V4.0: APNs (off until configured)
    for listener in v3_listeners:
        bus.add_listener(listener)

    async def _approve_company_plan(ref: dict, decision: str, actor: str) -> None:
        await svc.companies.on_plan_decision(ref, decision, actor)

    approvals_v2.register("company_plan", _approve_company_plan)
    approvals_v2.register("workflow", _approve_workflow)
    approvals_v2.register("command", _approve_workflow)
    approvals_v2.register("schedule_misfire", _approve_misfire)
    sem = db.get_setting("memory.semantic", {}) or {}
    if sem.get("enabled") and memory.OllamaEmbedder.available(cfg.providers.ollama_base_url, sem.get("model", "")):
        memory.configure_semantic(memory.OllamaEmbedder(cfg.providers.ollama_base_url, sem["model"]))
    from nebula_host import smart_auth

    n_auth = smart_auth.recover()  # no secret survives a restart: open sign-in requests need fresh owner input
    if n_auth:
        log.info("smart auth: %d open sign-in request(s) expired by the restart", n_auth)
    await svc.orch.start()
    await svc.live.start()
    await svc.telegram.start()
    await svc.resources.start()
    await svc.teams.reconcile()
    await svc.companies.reconcile()
    await svc.bots.start()
    await svc.remote.start()
    await svc.schedules.start()
    await svc.workflows.resume_all()
    from nebula_host.lan import LanManager

    svc.lan = LanManager(cfg, app)
    await svc.lan.start()  # persisted setting: LAN listeners come back after every restart / login
    bg = [asyncio.create_task(_retention_loop(cfg)), asyncio.create_task(_vm_supervisor()),
          asyncio.create_task(_guest_monitor()), asyncio.create_task(_vault_autolock_loop()),
          asyncio.create_task(_smart_auth_loop())]
    log.info("NEBULA %s listening on http://%s:%d", APP_VERSION, cfg.instance.bind_host, cfg.instance.port)
    try:
        yield
    finally:
        for t in bg:
            t.cancel()
        for listener in (*v2_listeners, *v3_listeners):  # a stopped app instance must not keep reacting to events
            bus.remove_listener(listener)
        await svc.remote.stop()
        await svc.bots.stop()
        await svc.host.shutdown()
        await svc.lan.stop()
        await svc.schedules.stop()
        await svc.resources.stop()
        await svc.telegram.stop()
        await svc.live.stop()
        await svc.orch.shutdown()
        from nebula_host.vault import VAULT

        VAULT.lock("service_stop", actor="system:shutdown")  # keys never outlive the process state


def create_app() -> FastAPI:
    app = FastAPI(title="NEBULA Host API", version=APP_VERSION, lifespan=lifespan,
                  docs_url="/api/docs", redoc_url=None, openapi_url="/api/openapi.json")
    install_handlers(app)

    @app.exception_handler(authz.Denied)
    async def _denied(_req: Request, exc: authz.Denied):  # an in-route authorization check never becomes a 500
        return JSONResponse(error_body(exc.code, exc.message, exc.details), status_code=exc.status)

    install_log_redaction()
    # JSON lists (tasks, audit, notifications, overview: 14–35 KB) shrink ~80 % for LAN / HTTPS / Mini App clients.
    # SSE, images, audio, video, archives and precompressed static files are never (re)compressed.
    from starlette.middleware.gzip import DEFAULT_EXCLUDED_CONTENT_TYPES, GZipMiddleware

    app.add_middleware(GZipMiddleware, minimum_size=2048, compresslevel=5,
                       exclude_content_types=(*DEFAULT_EXCLUDED_CONTENT_TYPES, "audio/*", "application/zip",
                                              "application/gzip", "application/octet-stream", "application/pdf"))
    app.add_middleware(GuardMiddleware)
    from nebula_host.api import routes

    app.include_router(routes.router)
    from nebula_host.api import routes_v2

    app.include_router(routes_v2.router)
    from nebula_host.api import routes_v3

    app.include_router(routes_v3.router)
    from nebula_host.api import routes_v32, routes_v33, routes_v321, routes_v322

    app.include_router(routes_v32.router)
    app.include_router(routes_v321.router)
    app.include_router(routes_v322.router)
    app.include_router(routes_v33.router)
    from nebula_host.api import routes_v40

    app.include_router(routes_v40.router)
    app.add_api_websocket_route("/api/v1/live/ws/{session_id}", routes.live_ws)
    app.add_api_route("/auth/callback", routes.siwc_callback, methods=["GET"], include_in_schema=False)

    @app.get("/{path:path}", include_in_schema=False)
    async def spa(path: str, request: Request):
        if path.startswith("api/"):
            raise ApiError(404, "not_found", "unknown API route")
        dist = Path(os.environ.get("NEBULA_DASHBOARD_DIST", DASHBOARD_DIST))
        if path == "mini" or path.startswith("mini/"):  # Telegram Mini App (local preview)
            page = dist / "mini.html"
            if page.exists():
                return FileResponse(page, headers={"Cache-Control": "no-store"})
        f = (dist / path).resolve()
        if path and f.is_file() and dist.resolve() in f.parents and not f.name.endswith((".br", ".gz")):
            from nebula_host.static import file_response

            return file_response(f, request.headers.get("accept-encoding"), immutable=path.startswith("assets/"))
        index = dist / "index.html"
        if index.exists():
            return FileResponse(index, headers={"Cache-Control": "no-store"})
        return JSONResponse({"message": "NEBULA API is running; dashboard not built (make dashboard)."})

    return app


app = create_app()
