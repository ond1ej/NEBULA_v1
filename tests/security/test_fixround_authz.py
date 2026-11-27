# ruff: noqa: F811 - fixtures are imported from other test modules and injected by pytest
"""Fix round "authz": the host fails closed for remote sessions whose identity is gone (NEW-1), the central gate
checks method + agent queries, membership changes in companies that run on this Mac need a fresh owner (VM-07),
child-logger records are redacted (VM-18), atomic vault failure counting (L-01), CGNAT/Tailscale addresses are not
public model endpoints (L-07), a valid GitHub token ref, English-by-default voice and the smaller text fixes."""

from __future__ import annotations

import inspect
import io
import logging
import secrets
import threading
import time
import uuid

import pytest

from tests.integration.test_api import _agent, _setup_admin, client  # noqa: F401
from tests.integration.test_v3_api import _pair_agent_bot_user, _pair_owner, gateway  # noqa: F401
from tests.security.test_host_security_release import _agent_bot_initdata_session, _mini, _task_row


def _direct(client, token: str, method: str = "GET", path: str = "/api/v1/settings", **kw):
    """A request straight to the host app with the gateway header, the way the gateway forwards it (the review's
    NEW-1 proof of concept): no gateway-side identity check in front of it."""
    from nebula_host import auth, remote

    return client.request(method, path, headers={"cookie": f"{auth.COOKIE}={token}",
                                                 "x-nebula-gateway": remote.GATEWAY_SECRET}, **kw)


def _raw_session(user_agent: str) -> str:
    """A session row with the given label (what an old, still-stored remote session looks like)."""
    from nebula_host import auth, db, models
    from sqlalchemy import select

    token = secrets.token_urlsafe(32)
    now = time.time()
    with db.engine().begin() as c:
        uid = c.execute(select(models.users.c.id).where(models.users.c.role == "admin")).scalar()
        c.execute(models.sessions.insert().values(id=db.new_id(), user_id=uid, token_hash=auth.sha256(token),
                                                  csrf_token=secrets.token_urlsafe(24), created_at=now,
                                                  expires_at=now + 3600, last_seen_at=now, user_agent=user_agent))
    return token


def _token(headers: dict) -> str:
    return headers["authorization"][7:]


def _unauthenticated(r) -> bool:
    return r.status_code == 401 and r.json()["error"]["code"] == "unauthenticated"


# ============================================================================ NEW-1: fail closed
def test_disabled_bot_session_sent_straight_to_the_host_is_401(client, gateway):
    from nebula_host import db, miniapp, models
    from sqlalchemy import update

    h = _setup_admin(client)
    a = _agent(client, h)
    _pair_owner(7)
    _pair_agent_bot_user(a["id"], 9)
    bot_auth, _ = _agent_bot_initdata_session(gateway, 9)
    tok = _token(bot_auth)
    # before: the remote session (not the dashboard cookie of this test client) is what the host sees
    r = _direct(client, tok)
    assert r.status_code == 403 and r.json()["error"]["code"] in ("owner_only", "not_available_to_agent_bot"), r.text
    assert _direct(client, tok, path=f"/api/v1/agents/{a['id']}").status_code == 200
    # the race of the review: the bot is disabled, the session row survives, the 3 s identity cache has expired
    with db.engine().begin() as c:
        c.execute(update(models.telegram_bots).where(models.telegram_bots.c.id == "bot-row-1").values(enabled=False))
    miniapp.forget_identity_cache()
    for path in ("/api/v1/settings", "/api/v1/audit", f"/api/v1/agents/{a['id']}", "/api/v1/miniapp/me",
                 "/api/v1/auth/assurance"):
        r = _direct(client, tok, path=path)
        assert _unauthenticated(r), (path, r.status_code, r.text)  # was 200 (owner) for /settings and /audit
    r = _direct(client, tok, "POST", "/api/v1/vault/lock", json={})
    assert _unauthenticated(r), r.text
    assert gateway.get("/api/v1/settings", headers=bot_auth).status_code == 401


def test_deleted_identity_and_revoked_device_sessions_are_401_at_the_host(client, gateway):
    from nebula_host import authz, db, miniapp, models
    from sqlalchemy import delete

    _setup_admin(client)
    _pair_owner(7)
    _pair_owner(8)
    owner, _ = _mini(gateway, 7)
    op, _ = _mini(gateway, 8)
    assert _direct(client, _token(owner)).status_code == 200  # the owner may read settings
    assert _direct(client, _token(op)).json()["error"]["code"] == "owner_only"
    with db.engine().begin() as c:  # the identities are deleted outright (no revoke, the session rows stay)
        c.execute(delete(models.telegram_users))
    miniapp.forget_identity_cache()
    authz.forget_owner_cache()
    for hdr in (owner, op):
        for path in ("/api/v1/settings", "/api/v1/audit", "/api/v1/files/roots", "/api/v1/miniapp/me"):
            r = _direct(client, _token(hdr), path=path)
            assert _unauthenticated(r), (path, r.text)
    # a paired-app session whose device is gone: same answer
    dead_app = _raw_session(f"nebula-app dev=adv_{'0' * 16} platform=ios")
    for path in ("/api/v1/settings", "/api/v1/audit", "/api/v1/agents"):
        assert _unauthenticated(_direct(client, dead_app, path=path)), path
    # a remote session label without the gateway header never counts as the dashboard either
    from nebula_host import auth

    r = client.get("/api/v1/settings", headers={"cookie": f"{auth.COOKIE}={dead_app}"})
    assert r.status_code == 401, r.text


def test_context_for_fails_closed_for_remote_principals_without_session_info():
    from nebula_host import authz
    from nebula_host.auth import Principal

    remote = Principal(session_id="s1", user_id="u1", username="owner", csrf_token="c", via="miniapp:9")
    with pytest.raises(authz.Denied) as e:
        authz.context_for(remote, None)
    assert e.value.status == 401 and e.value.code == "unauthenticated"
    local = authz.context_for(Principal(session_id="s2", user_id="u1", username="owner", csrf_token="c"), None)
    assert local.interface == "local" and local.owner and local.fresh


def test_denied_raised_inside_a_route_is_its_own_answer_not_a_500(data_dir):
    from fastapi.testclient import TestClient
    from nebula_host import authz
    from nebula_host.app import create_app

    app = create_app()

    @app.post("/api/v1/__denied_probe")
    async def _probe():
        raise authz.Denied(401, "unauthenticated", "gone")

    r = TestClient(app, base_url="http://127.0.0.1:3199").post("/api/v1/__denied_probe")
    assert r.status_code == 401 and r.json()["error"]["code"] == "unauthenticated"


def _bot_sessions(bot: str) -> list[str]:
    from nebula_host import db, models
    from sqlalchemy import select

    with db.engine().connect() as c:
        return [r.id for r in c.execute(select(models.sessions.c.id).where(
            models.sessions.c.user_agent.like(f"nebula-miniapp tg=% bot={bot} %")))]


@pytest.mark.parametrize("how", ["disable", "remove"])
def test_disabling_or_removing_a_bot_ends_every_users_sessions_and_clears_the_cache(client, gateway, how):
    from nebula_host import miniapp

    h = _setup_admin(client)
    a = _agent(client, h)
    _pair_owner(7)
    _pair_agent_bot_user(a["id"], 9)
    _pair_agent_bot_user(a["id"], 10)
    s9, _ = _agent_bot_initdata_session(gateway, 9)
    s10, _ = _agent_bot_initdata_session(gateway, 10)
    _raw_session("nebula-miniapp tg=11 bot=bot-row-10 perms=ignored")  # another bot with a similar id
    for hdr in (s9, s10):
        assert gateway.get(f"/api/v1/agents/{a['id']}", headers=hdr).status_code == 200  # fills the cache
    assert len(_bot_sessions("bot-row-1")) == 2 and miniapp._ident_cache
    if how == "disable":
        r = client.post("/api/v1/bots/bot-row-1/enabled", json={"enabled": False}, headers=h)
    else:
        r = client.delete("/api/v1/bots/bot-row-1?confirm=true", headers=h)
    assert r.status_code == 200, r.text
    assert _bot_sessions("bot-row-1") == [] and miniapp._ident_cache == {}
    assert len(_bot_sessions("bot-row-10")) == 1  # exact bot match, never a prefix
    for hdr in (s9, s10):
        assert gateway.get(f"/api/v1/agents/{a['id']}", headers=hdr).status_code == 401
        assert _direct(client, _token(hdr)).status_code == 401


# ============================================================================ gate: method + agent queries
def test_gate_checks_agent_queries_and_the_exact_route(client, gateway):
    h = _setup_admin(client)
    mine, other = _agent(client, h, name="Mine"), _agent(client, h, name="Other")
    _pair_owner(7)
    _pair_agent_bot_user(mine["id"], 9)
    bot, _ = _agent_bot_initdata_session(gateway, 9)
    t_mine = _task_row(mine["id"], "mine")
    _task_row(other["id"], "other")
    tok = _token(bot)
    r = _direct(client, tok, path=f"/api/v1/tasks?agent_id={other['id']}")
    assert r.status_code == 403 and r.json()["error"]["code"] == "not_your_agent", r.text
    r = _direct(client, tok, path=f"/api/v1/tasks?agent_id={mine['id']}")
    assert r.status_code == 200 and {t["id"] for t in r.json()["data"]} == {t_mine}
    r = _direct(client, tok, path="/api/v1/conversations/search?q=x")  # literal route, not /conversations/{cid}
    assert r.status_code == 403 and r.json()["error"]["code"] == "not_available_to_agent_bot"


def test_check_ownership_uses_method_and_query(dbinit):
    from nebula_host import authz

    ctx = authz.Ctx("miniapp", "agent_bot", frozenset({"tasks"}), None, "s", 9, "bot-x")
    with pytest.raises(authz.Denied) as e:  # an allowlisted template, but another agent named in the query
        authz.check_ownership(ctx, "/events", "GET", {"agent_id": "someone-else"})
    assert e.value.code == "not_your_agent"
    with pytest.raises(authz.Denied) as e:  # with the method, only that route's template counts
        authz.check_ownership(ctx, "/conversations/search", "GET", {})
    assert e.value.code == "not_available_to_agent_bot"


# ============================================================================ VM-07: members of host companies
def test_membership_and_assignment_changes_in_host_companies_need_a_fresh_owner(client, gateway):
    from nebula_host import db, models
    from sqlalchemy import update

    h = _setup_admin(client)
    x, y = _agent(client, h, name="Xena"), _agent(client, h, name="Yuri")
    z = _agent(client, h, name="Zoe")
    _pair_owner(7)
    _pair_owner(8)
    with db.engine().begin() as c:  # the owner gave this operator `companies`
        c.execute(update(models.telegram_users).where(models.telegram_users.c.telegram_user_id == 8)
                  .values(permissions=["tasks", "companies"]))
    op, _ = _mini(gateway, 8)
    owner, _ = _mini(gateway, 7)

    def company(name, members):
        r = client.post("/api/v1/companies", json={"name": name, "members": members, "roles": ["ceo", "backend"]},
                        headers=h)
        assert r.status_code == 201, r.text
        return r.json()["data"]

    host_co = company("HostCo", [{"agent_id": x["id"], "role_key": "ceo"}])
    assert client.patch(f"/api/v1/companies/{host_co['id']}", json={"default_environment": "host"},
                        headers=h).status_code == 200  # the owner chose native execution on the Dashboard
    new_members = {"members": [{"agent_id": x["id"], "role_key": "ceo"},
                               {"agent_id": y["id"], "role_key": "backend"}]}
    # Y would inherit `host` from the company without `host` appearing anywhere in the request
    r = gateway.patch(f"/api/v1/companies/{host_co['id']}", json=new_members, headers=op)
    assert r.status_code == 403 and r.json()["error"]["code"] == "owner_only", r.text
    r = gateway.patch(f"/api/v1/companies/{host_co['id']}", json=new_members, headers=owner)
    assert r.status_code == 403 and r.json()["error"]["code"] == "stepup_required", r.text
    r = gateway.post(f"/api/v1/companies/{host_co['id']}/projects", json={"name": "P"}, headers=op)
    assert r.status_code == 403 and r.json()["error"]["code"] == "owner_only", r.text
    # a VM company whose project runs on the Mac: assignments into it are guarded too
    vm_co = company("VmCo", [{"agent_id": z["id"], "role_key": "ceo"}])
    pr = client.post(f"/api/v1/companies/{vm_co['id']}/projects", json={"name": "Native"}, headers=h).json()["data"]
    assert client.patch(f"/api/v1/projects/{pr['id']}", json={"environment": "host"}, headers=h).status_code == 200
    r = gateway.patch(f"/api/v1/projects/{pr['id']}", json={"assign": [{"agent_id": z["id"]}]}, headers=op)
    assert r.status_code == 403 and r.json()["error"]["code"] == "owner_only", r.text
    # renaming is not a membership change, and the dashboard owner passes every guard
    r = gateway.patch(f"/api/v1/projects/{pr['id']}", json={"description": "still fine"}, headers=op)
    assert r.status_code == 200, r.text
    r = client.patch(f"/api/v1/companies/{host_co['id']}", json=new_members, headers=h)
    assert r.status_code == 200, r.text


def test_membership_changes_in_vm_only_companies_stay_open_to_operators(client, gateway):
    from nebula_host import db, models
    from sqlalchemy import update

    h = _setup_admin(client)
    x, y = _agent(client, h, name="Xena"), _agent(client, h, name="Yuri")
    _pair_owner(7)
    _pair_owner(8)
    with db.engine().begin() as c:
        c.execute(update(models.telegram_users).where(models.telegram_users.c.telegram_user_id == 8)
                  .values(permissions=["tasks", "companies"]))
    op, _ = _mini(gateway, 8)
    co = client.post("/api/v1/companies", json={"name": "VmOnly", "roles": ["ceo", "backend"],
                                                "members": [{"agent_id": x["id"], "role_key": "ceo"}]},
                     headers=h).json()["data"]
    r = gateway.patch(f"/api/v1/companies/{co['id']}", json={"members": [
        {"agent_id": x["id"], "role_key": "ceo"}, {"agent_id": y["id"], "role_key": "backend"}]}, headers=op)
    assert r.status_code == 200, r.text
    r = gateway.post(f"/api/v1/companies/{co['id']}/projects", json={"name": "Plain"}, headers=op)
    assert r.status_code == 201, r.text
    # a member-level `host` override (set by the owner) makes the company a host company
    with db.engine().begin() as c:
        c.execute(update(models.company_members).where(models.company_members.c.agent_id == x["id"])
                  .values(environment="host"))
    r = gateway.post(f"/api/v1/companies/{co['id']}/projects", json={"name": "Plain2"}, headers=op)
    assert r.status_code == 403 and r.json()["error"]["code"] == "owner_only", r.text


# ============================================================================ VM-18: child loggers are redacted
def test_child_logger_records_are_redacted_in_handler_output():
    from nebula_host.app import install_log_redaction

    buf = io.StringIO()
    handler = logging.StreamHandler(buf)
    root = logging.getLogger()
    root.addHandler(handler)
    children = [logging.getLogger(n) for n in ("nebula.telegram.v3", "nebula.live", "nebula.smart_auth")]
    levels = [lg.level for lg in children]
    fake = "1234567:" + "A" * 35  # an obviously fake bot token, built at run time
    try:
        install_log_redaction()
        for lg in children:
            lg.setLevel(logging.INFO)
        children[0].info("https://api.telegram.org/bot" + fake + "/getUpdates")
        children[0].info("GET %s", "https://api.telegram.org/file/bot" + fake + "/voice.ogg")
        children[1].warning("viewer ws?token=%s&x=1", "viewerAbCdEf012345")
        children[2].error("callback code=%s state=%s", "c0de0123456789", "st4te0123456789")
        try:
            raise RuntimeError("Client error for url 'https://api.telegram.org/bot" + fake + "/getMe'")
        except RuntimeError:
            children[0].exception("poll failed")
        # uvicorn's access formatter reads the arguments: they stay a tuple of the same shape, redacted one by one
        rec = logging.LogRecord("uvicorn.access", logging.INFO, __file__, 1, '%s - "%s %s HTTP/%s" %d',
                                ("127.0.0.1:5", "GET", "/api/v1/live/ws/x?token=viewerAbCdEf012345", "1.1", 101),
                                None)
        handler.handle(rec)
        assert isinstance(rec.args, tuple) and len(rec.args) == 5 and "viewerAbCdEf012345" not in rec.args[2]
    finally:
        root.removeHandler(handler)
        for lg, lvl in zip(children, levels, strict=True):
            lg.setLevel(lvl)
    out = buf.getvalue()
    for leaked in ("A" * 35, "viewerAbCdEf012345", "c0de0123456789", "st4te0123456789"):
        assert leaked not in out, out
    assert "poll failed" in out and "RuntimeError" in out  # the traceback is kept, only the secret goes
    assert out.count("[REDACTED]") >= 7


# ============================================================================ L-01: atomic failure counting
def test_vault_failures_are_counted_atomically(dbinit, monkeypatch):
    import os

    from nebula_host import db, models
    from nebula_host import vault as v
    from sqlalchemy import select

    monkeypatch.setattr(v, "calibrate_kdf", lambda *a, **k: {"alg": "argon2id", "salt": v.b64e(os.urandom(16)),
                                                              "time_cost": 1, "memory_kib": 8192, "parallelism": 1})
    V = v.VAULT
    V._keys = None
    V.create("right passphrase 4242", actor="t")
    meta = V._meta()  # one stale snapshot for every thread: the count must not come from it
    threads, per_thread, start = 8, 5, threading.Barrier(8)
    lefts: list[int] = []

    def guess():
        start.wait()
        for _ in range(per_thread):
            lefts.append(V._count_failure(meta))

    ts = [threading.Thread(target=guess) for _ in range(threads)]
    for t in ts:
        t.start()
    for t in ts:
        t.join(60)
    with db.engine().connect() as c:
        row = c.execute(select(models.vault_metadata.c.failed_attempts, models.vault_metadata.c.lockout_until)
                        .where(models.vault_metadata.c.vault_id == meta["vault_id"])).first()
    assert row.failed_attempts == threads * per_thread
    assert row.lockout_until and row.lockout_until > time.time()
    assert sorted(lefts)[-1] == v.FREE_ATTEMPTS - 1 and lefts.count(0) == threads * per_thread - v.FREE_ATTEMPTS + 1
    # unlock counts through the same path
    V._keys = None
    with db.engine().begin() as c:
        c.execute(models.vault_metadata.update().values(failed_attempts=0, lockout_until=None))
    with pytest.raises(v.VaultError) as e:
        V.unlock("wrong passphrase", actor="t")
    assert e.value.code == "wrong_passphrase"
    with db.engine().connect() as c:
        assert c.execute(select(models.vault_metadata.c.failed_attempts)).scalar() == 1
    V._keys = None


# ============================================================================ L-07: CGNAT / Tailscale addresses
async def test_byo_endpoint_treats_cgnat_and_tailscale_addresses_as_private(monkeypatch):
    from nebula_providers import adapters
    from nebula_providers.base import ProviderError

    dns = {"mac.tail1234.ts.net": ["100.101.102.103"], "api.example.com": ["93.184.216.34"],
           "edge.example.com": ["100.63.255.255"], "mixed.example.com": ["93.184.216.34", "100.64.0.1"]}

    def fake_resolve(host):
        if host not in dns:
            raise OSError("unknown host")
        return dns[host]

    monkeypatch.setattr(adapters, "resolve_host", fake_resolve)
    monkeypatch.setattr(adapters, "nebula_ports", lambda: {3100, 3102, 3443})
    for bad in ("https://100.64.0.1/v1", "https://100.100.100.100/v1", "https://100.127.255.254/v1",
                "https://[::ffff:100.64.0.1]/v1", "https://[fd7a:115c:a1e0::1]/v1", "http://100.64.0.1/v1",
                "https://mac.tail1234.ts.net/v1", "https://mixed.example.com/v1"):
        with pytest.raises(ProviderError):
            adapters.validate_byo_endpoint(bad)
    # just outside 100.64.0.0/10 is ordinary public address space
    for good in ("https://100.63.255.255/v1", "https://100.128.0.1/v1", "https://edge.example.com/v1",
                 "https://api.example.com/v1"):
        assert adapters.validate_byo_endpoint(good) == good
    a = adapters.OpenAICompatibleAdapter("x", "https://mac.tail1234.ts.net/v1", lambda: "k", "byo")
    with pytest.raises(ProviderError):  # re-checked before the key is sent
        await a.list_models()


# ============================================================================ GitHub token ref
def test_github_token_uses_a_valid_keychain_ref(client, monkeypatch):
    from nebula_host import hosttools
    from nebula_host import secrets as sec

    class RefCheckingStore(sec.MemoryStore):
        """Behaves like the Keychain store: refs must match nebula:<name>."""

        def set(self, ref, value):
            if not sec._REF_RE.match(ref):
                raise ValueError("invalid secret reference")
            super().set(ref, value)

        def get(self, ref):
            return super().get(ref) if ref and sec._REF_RE.match(ref) else None

    store = RefCheckingStore()
    monkeypatch.setattr(sec, "_store", store)
    assert sec._REF_RE.match(hosttools.GITHUB_TOKEN_REF)
    h = _setup_admin(client)
    value = "fixture-" + "x" * 24  # not a real token
    assert client.get("/api/v1/skills/github/token", headers=h).json()["data"] == {"configured": False}
    r = client.post("/api/v1/skills/github/token", json={"token": value}, headers=h)
    assert r.status_code == 200, r.text
    assert client.get("/api/v1/skills/github/token", headers=h).json()["data"] == {"configured": True}
    assert store.get("nebula:github.token") == value

    seen = {}

    class FakeResponse:
        status_code, text, headers = 200, "{}", {}

    class FakeClient:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def request(self, method, path, headers=None, json=None):
            seen.update(method=method, auth=(headers or {}).get("Authorization"))
            return FakeResponse()

    import httpx

    monkeypatch.setattr(httpx, "AsyncClient", FakeClient)
    out = client.portal.call(hosttools.github, {"path": "/repos/o/n/issues", "method": "POST", "body": "{}"})
    assert out["status"] == "ok" and seen == {"method": "POST", "auth": f"Bearer {value}"}
    assert client.delete("/api/v1/skills/github/token", headers=h).status_code == 200
    assert client.get("/api/v1/skills/github/token", headers=h).json()["data"] == {"configured": False}


# ============================================================================ P4 / P5: English by default
@pytest.mark.parametrize("text", ["Send me a summary", "Go to example.com", "Write a report",
                                  "Open the browser and log in to the site", "Please do it", "What's the status?",
                                  "Send the résumé to the team", "Café", "Ask Jak about it", "", "123"])
def test_english_text_is_english(text):
    from nebula_host import voice

    assert voice.detect_language(text) == "en"


@pytest.mark.parametrize("text", ["Udělej to prosím", "Developere, jak pokračuje ten projekt?", "Pošli mi souhrn",
                                  "Jaký je stav týmu?", "Je to hotové?", "jak to jde", "udelej to a posli mi vysledek",
                                  "co delas", "Developere, jak pokracuje ten projekt?", "prosim zkontroluj stav",
                                  "ahoj", "Stav?"])
def test_czech_text_is_czech(text):
    from nebula_host import voice

    assert voice.detect_language(text) == "cs"


def test_speech_defaults_to_english(dbinit):
    from nebula_host import tts, voice
    from nebula_host.api.routes_v3 import PreviewBody

    assert inspect.signature(tts.synthesize).parameters["language"].default == "en"
    assert PreviewBody(text="hi").language == "en"
    for fn in (voice.status_summary, voice.team_summary, voice.company_summary):
        assert inspect.signature(fn).parameters["lang"].default == "en", fn.__name__
    assert voice.status_summary(str(uuid.uuid4())) == "I don't know this agent."
    assert voice.team_summary() == "No team has run yet."
    assert voice.company_summary() == "You have no AI company yet."
    assert voice.status_summary(str(uuid.uuid4()), "cs") == "Tohoto agenta neznám."  # Czech only when asked


# ============================================================================ English server texts, remote defaults
def test_server_texts_are_english_and_version_neutral():
    from nebula_host import providers_service, push

    for _binary, reason in providers_service.CLI_REASONS.values():
        assert "V1" not in reason and "spec" not in reason and "§" not in reason, reason
        assert "in this version" in reason
    titles = {push.message_for({"type": t, "payload": {"agent_name": "Ada"}})["title"]
              for t in ("task.completed", "task.failed", "task.approval.requested", "auth.request")}
    assert titles == {"Task completed", "Task failed", "Approval needed", "Sign-in needed"}


def test_gateway_port_default_is_derived_and_hello_keeps_api_4(client, gateway):
    from nebula_host import remote
    from nebula_host.config import get_config

    assert "port" not in remote.DEFAULTS
    assert remote.settings()["port"] == remote.default_port() == get_config().instance.port + 2
    r = gateway.get("/api/app/hello")
    assert r.status_code == 200 and r.json()["data"]["api"] == 4
