# ruff: noqa: F811 - fixtures are imported from other test modules and injected by pytest
"""Fix round 2, Telegram (reviews 10 NEW-3 and 11 B1, N3, N8, N9, N11): approvals are the owner's decision in the bot
chats too, approvals that need a fresh owner are never decided by a chat button, operators' chat commands follow
their stored permissions, approval read routes are owner-only remotely, and a dashboard session never passes as a
gateway session.

The proofs of concept from both reviews (an operator pressing appr:/oa:/ap:, an operator creating an ADVANCED agent
from the chat) are kept below as regression tests that now fail closed. Fake Bot API, fake guest, no network; the
in-process remote gateway uses 3197 as a Host label only (nothing is bound)."""

from __future__ import annotations

import asyncio
import time
import uuid
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from fastapi.testclient import TestClient

from tests.integration.test_api import _setup_admin, client  # noqa: F401
from tests.integration.test_telegram import _bind, _pair, msg, tg  # noqa: F401
from tests.integration.test_telegram_v3 import BOT_A, tg3  # noqa: F401
from tests.integration.test_v3_api import _Bridge, _pair_owner
from tests.security.test_host_security_release import _mini

ROOT = Path(__file__).resolve().parents[2]
URL = "https://nebula.example.test"


@pytest.fixture(autouse=True)
def _no_leftover_gateways():
    """The shared Telegram fixtures never unregister their gateway from the event bus. Silence every listener a
    test of this module added, so its (running) gateways cannot react to events of later tests."""
    from nebula_host import authz
    from nebula_host.events import bus

    before = list(bus._listeners)
    yield
    for fn in [f for f in bus._listeners if f not in before]:
        owner = getattr(fn, "__self__", None)
        if owner is not None and hasattr(owner, "running"):
            owner.running = False
        bus.remove_listener(fn)
    authz.forget_owner_cache()


# ============================================================================ helpers
async def _second_user(g, uid: int, permissions: list[str] | None = None) -> None:
    """Pair and approve another account of the main bot: an operator (default tasks, commands, screenshot)."""
    from nebula_host import db, models

    p = g.create_pairing("user:owner")
    await g._process(msg(uid, uid, f"/start {p['code']}"))
    await g.approve(p["pairing_id"], "user:owner")
    if permissions is not None:
        _set_permissions(uid, permissions)
    with db.engine().connect() as c:
        assert c.execute(models.telegram_users.select().where(models.telegram_users.c.telegram_user_id == uid)
                         ).first().status == "approved"


def _set_permissions(uid: int, permissions: list[str]) -> None:
    from nebula_host import db, models
    from sqlalchemy import update

    with db.engine().begin() as c:
        c.execute(update(models.telegram_users).where(models.telegram_users.c.telegram_user_id == uid)
                  .values(permissions=permissions))


async def _owner_and_operator(g, fake, fake_guest, *, op_permissions: list[str] | None = None):
    from nebula_host import agents_service, authz

    await _bind()
    p = await _pair(g, fake, uid=7, chat=7)
    await g.approve(p["pairing_id"], "user:owner")
    await _second_user(g, 8, op_permissions)
    authz.forget_owner_cache()
    assert authz.primary_owner_telegram_id() == 7  # 8 is an operator
    a = await agents_service.create(fake_guest, {"name": "Dev", "provider_id": "ollama-local", "model_id": "m"}, "t")
    return a


def _cb(uid: int, data: str, cid: str | None = None, chat: int | None = None) -> dict:
    return {"update_id": int(uuid.uuid4().int % 10**9), "callback_query": {
        "id": cid or uuid.uuid4().hex[:12], "from": {"id": uid}, "data": data,
        "message": {"chat": {"id": chat or uid}, "message_id": 5}}}


def _answers(sent, cid: str) -> list[dict]:
    return [b for m, b in sent if m == "answerCallbackQuery" and b.get("callback_query_id") == cid]


async def _press(g, fake, uid: int, data: str, chat: int | None = None) -> dict:
    cid = uuid.uuid4().hex[:12]
    await g._process(_cb(uid, data, cid, chat))
    got = _answers(fake.sent, cid)
    assert got, f"no answer to {data}"
    return got[-1]


def _task(orch, agent_id: str, prompt: str = "send the report", *, by: int | None = None, env: str | None = None,
          rt: dict | None = None) -> str:
    from nebula_host import db, models
    from sqlalchemy import update

    if rt is None and by is not None:
        rt = {"chat_id": by, "thread_id": None, "user_id": by}
    t = orch.enqueue(agent_id, prompt, **({"source": "telegram", "reply_target": rt} if rt else {}))
    if env:
        with db.engine().begin() as c:
            c.execute(update(models.tasks).where(models.tasks.c.id == t["id"]).values(execution={"env": env}))
    return t["id"]


def _approval(task_id: str, agent_id: str, tool: str = "browser_click", reason: str = "outbound_message") -> str:
    from nebula_host import db, models

    aid = str(uuid.uuid4())
    now = time.time()
    with db.engine().begin() as c:
        c.execute(models.approvals.insert().values(id=aid, task_id=task_id, agent_id=agent_id, tool=tool,
                                                   action_summary=f"use {tool}", reason=reason,
                                                   created_at=now, expires_at=now + 600))
    return aid


def _decision(aid: str) -> tuple[str | None, str | None]:
    from nebula_host import db, models
    from sqlalchemy import select

    with db.engine().connect() as c:
        r = c.execute(select(models.approvals.c.decision, models.approvals.c.resolved_by)
                      .where(models.approvals.c.id == aid)).first()
    return (r.decision, r.resolved_by) if r else (None, None)


def _audits(action: str, actor: str | None = None) -> list[dict]:
    from nebula_host import db, models
    from sqlalchemy import select

    q = select(models.audit_events).where(models.audit_events.c.action == action)
    if actor:
        q = q.where(models.audit_events.c.actor == actor)
    with db.engine().connect() as c:
        return db.rows(c.execute(q))


def _event(aid: str, task_id: str, agent_id: str, tool: str = "browser_click", reason: str = "outbound_message"):
    return {"type": "task.approval.requested", "agent_id": agent_id, "task_id": task_id,
            "payload": {"approval_id": aid, "tool": tool, "summary": f"use {tool}", "reason": reason,
                        "expires_at": time.time() + 600}}


def _messages(sent, chat: int) -> list[dict]:
    return [b for m, b in sent if m == "sendMessage" and b.get("chat_id") == chat]


def _buttons(body: dict) -> list[dict]:
    return [b for row in (body.get("reply_markup") or {}).get("inline_keyboard", []) for b in row]


# ============================================================================ NEW-3 / B1: approvals are the owner's
async def test_operator_cannot_decide_any_approval_in_the_chat(tg, fake_guest):
    """Review 10 PoC (oa: on a `command` owner approval) and review 11 PoC (appr: on a task approval), plus ap: with a
    VALID HMAC tag for the operator's own chat: nothing is decided, the operator is told why, and it is audited."""
    from nebula_host import approvals_v2
    from nebula_telegram import access
    from nebula_telegram import cards as cardsvc

    g, fake, orch, _ = tg
    a = await _owner_and_operator(g, fake, fake_guest)
    t = _task(orch, a["id"], by=8)
    task_ap = _approval(t, a["id"])
    r = await _press(g, fake, 8, f"appr:{task_ap}:y")
    assert r["text"] == access.NOT_OWNER_APPROVAL and r.get("show_alert") is True
    tag = cardsvc.tag(task_ap, "y", "main", 8)  # a genuine button for the operator's chat
    r = await _press(g, fake, 8, f"ap:{task_ap}:y:{tag}")
    assert r["text"] == access.NOT_OWNER_APPROVAL
    assert _decision(task_ap) == (None, None)

    cmd_ap = approvals_v2.request("command", {"x": 1}, "run a command")  # a fresh-owner kind over HTTP
    plain_ap = approvals_v2.request("workflow", {"run_id": "r", "node_id": "n"}, "publish the report")
    for oid in (cmd_ap, plain_ap):
        r = await _press(g, fake, 8, f"oa:{oid}:y")
        assert r["text"] == access.NOT_OWNER_APPROVAL
        assert approvals_v2.get(oid)["decision"] is None and approvals_v2.get(oid)["resolved_by"] is None
    denied = _audits("telegram.approval.denied", "telegram:8")
    assert {d["target"] for d in denied} >= {task_ap, cmd_ap, plain_ap} and len(denied) >= 4
    assert all(d["metadata"]["reason"] == "not_owner" for d in denied)


async def test_operator_approvals_command_lists_nothing(tg, fake_guest):
    from nebula_host import approvals_v2
    from nebula_telegram import access

    g, fake, orch, _ = tg
    a = await _owner_and_operator(g, fake, fake_guest)
    g.v2 = SimpleNamespace()  # V2 services attached (the command lives there)
    _approval(_task(orch, a["id"]), a["id"])
    approvals_v2.request("workflow", {"run_id": "r", "node_id": "n"}, "Second one?")
    fake.sent.clear()
    await g._process(msg(8, 8, "/approvals"))
    out = _messages(fake.sent, 8)
    assert [m["text"] for m in out] == [access.NOT_OWNER_APPROVAL]
    assert not any(_buttons(m) for m in out)
    assert _audits("telegram.approval.denied", "telegram:8")


async def test_operator_cannot_create_an_agent_from_the_chat(tg, fake_guest):
    """Review 11 PoC: /newagent + name + lvl:ADVANCED from an operator created an ADVANCED agent."""
    from nebula_host import db, models
    from nebula_telegram import access
    from sqlalchemy import select

    g, fake, orch, created = tg
    await _owner_and_operator(g, fake, fake_guest)
    fake.sent.clear()
    await g._process(msg(8, 8, "/newagent"))
    assert access.NOT_OWNER in [m["text"] for m in _messages(fake.sent, 8)]
    assert 8 not in g._wizard
    await g._process(msg(8, 8, "OpAgent"))
    g._wizard[8] = {"step": "level", "name": "OpAgent", "thread_id": None}  # even with a wizard left open
    r = await _press(g, fake, 8, "lvl:ADVANCED")
    assert r["text"] == access.NOT_OWNER
    assert created == []
    with db.engine().connect() as c:
        assert c.execute(select(models.agents.c.id).where(models.agents.c.name == "OpAgent")).first() is None


async def test_approval_cards_and_owner_approvals_go_to_the_owners_chat_only(tg, fake_guest):
    from nebula_host import approvals_v2

    g, fake, orch, _ = tg
    a = await _owner_and_operator(g, fake, fake_guest)
    g.running = True  # notifications on (polling is driven by hand)
    fake.sent.clear()
    t = _task(orch, a["id"], "operator job", by=8)  # the operator asked for this task
    aid = _approval(t, a["id"])
    await g._notify(_event(aid, t, a["id"]))
    owner_cards = [m for m in _messages(fake.sent, 7) if "Approval needed" in m["text"]]
    assert len(owner_cards) == 1 and all(b["callback_data"].startswith(f"ap:{aid}:") for b in _buttons(owner_cards[0]))
    to_op = _messages(fake.sent, 8)
    assert [m["text"] for m in to_op] == [f"🛂 Task #{t[:8]} waits for the NEBULA owner's approval. It continues "
                                          "once the owner decides."]
    assert not any(_buttons(m) for m in to_op)
    # owner approvals (workflow gates, commands, ...) reach the owner only
    fake.sent.clear()
    approvals_v2.request("workflow", {"run_id": "r", "node_id": "n"}, "Publish the report?")
    await asyncio.sleep(0.1)
    assert any("Publish the report?" in m["text"] for m in _messages(fake.sent, 7))
    assert not any("Publish the report?" in m["text"] for m in _messages(fake.sent, 8))
    # sign-in requests (answering or cancelling them is the owner's) too
    fake.sent.clear()
    await g._notify({"type": "auth.request", "agent_id": a["id"], "task_id": t, "payload": {
        "request_id": "rq-" + uuid.uuid4().hex[:8], "session_id": "as_" + "a" * 24, "site": "github.com",
        "origin": "https://github.com", "agent_name": "Dev", "request_type": "credentials"}})
    assert any("Authentication required" in m["text"] for m in _messages(fake.sent, 7))
    assert _messages(fake.sent, 8) == []
    r = await _press(g, fake, 8, "auth:as_" + "a" * 24 + ":c")
    assert r["text"] == "Only the NEBULA owner can do this."


async def test_owner_still_decides_ordinary_approvals_with_one_tap(tg, fake_guest):
    from nebula_host import approvals_v2
    from nebula_telegram import cards as cardsvc

    g, fake, orch, created = tg
    a = await _owner_and_operator(g, fake, fake_guest)
    g.running = True
    t = _task(orch, a["id"], by=7)
    aid = _approval(t, a["id"])
    fake.sent.clear()
    await g._notify(_event(aid, t, a["id"]))
    card = [m for m in _messages(fake.sent, 7) if "Approval needed" in m["text"]][-1]
    yes = _buttons(card)[0]["callback_data"]
    assert yes == f"ap:{aid}:y:{cardsvc.tag(aid, 'y', 'main', 7)}"  # HMAC-bound to the approval, bot and chat
    assert "cannot be decided in the chat" not in card["text"] and not any("web_app" in b for b in _buttons(card))
    r = await _press(g, fake, 7, yes)
    assert r["text"] == "approved" and _decision(aid) == ("approved", "telegram:7")
    legacy = _approval(t, a["id"])
    r = await _press(g, fake, 7, f"appr:{legacy}:n")
    assert r["text"] == "denied" and _decision(legacy) == ("denied", "telegram:7")
    oid = approvals_v2.request("workflow", {"run_id": "r", "node_id": "n"}, "Publish?")
    r = await _press(g, fake, 7, f"oa:{oid}:y")
    assert r["text"] == "approved" and approvals_v2.get(oid)["resolved_by"] == "telegram:7"
    # the owner keeps administration from the chat: /newagent creates an ADVANCED agent
    await g._process(msg(7, 7, "/newagent"))
    await g._process(msg(7, 7, "OwnerAgent"))
    await _press(g, fake, 7, "lvl:ADVANCED")
    assert [(x["name"], x["permission_level"]) for x in created] == [("OwnerAgent", "ADVANCED")]


# ============================================================================ step-up kinds never resolve in the chat
async def test_stepup_approvals_are_never_decided_by_a_chat_button(tg, fake_guest):
    from nebula_host import approvals_v2
    from nebula_telegram import access
    from nebula_telegram import cards as cardsvc

    g, fake, orch, _ = tg
    a = await _owner_and_operator(g, fake, fake_guest)
    t_vm = _task(orch, a["id"], by=7)
    t_host = _task(orch, a["id"], "on the Mac", by=7, env="host")
    cases = [_approval(t_vm, a["id"], "vault_sign_in", "credential_entry"),  # Password Vault
             _approval(t_vm, a["id"], "credential_fill", "outbound_message"),  # credential tool
             _approval(t_vm, a["id"], "shell_execute", "privileged"),  # system
             _approval(t_vm, a["id"], "shell_execute", "system_install"),
             _approval(t_host, a["id"], "browser_click", "outbound_message")]  # any approval of a task on the Mac
    for aid in cases:
        for data in (f"ap:{aid}:y:{cardsvc.tag(aid, 'y', 'main', 7)}", f"ap:{aid}:n:{cardsvc.tag(aid, 'n', 'main', 7)}",
                     f"appr:{aid}:y"):
            r = await _press(g, fake, 7, data)
            assert r["text"] == access.STEPUP_ALERT and r.get("show_alert") is True, (aid, data)
        assert _decision(aid) == (None, None)
    for kind in sorted(approvals_v2.STEPUP_KINDS):
        oid = approvals_v2.request(kind, {"x": 1}, f"a {kind}")
        for yn in ("y", "n"):
            r = await _press(g, fake, 7, f"oa:{oid}:{yn}")
            assert r["text"] == access.STEPUP_ALERT, kind
        assert approvals_v2.get(oid)["decision"] is None
    assert len(_audits("telegram.approval.stepup_required", "telegram:7")) == 3 * len(cases) + \
        2 * len(approvals_v2.STEPUP_KINDS)


async def test_stepup_cards_open_the_mini_app_or_say_where_to_decide(tg, fake_guest, monkeypatch):
    from nebula_host import approvals_v2, remote

    g, fake, orch, _ = tg
    a = await _owner_and_operator(g, fake, fake_guest)
    g.running = True
    t = _task(orch, a["id"], by=7)
    vault = _approval(t, a["id"], "vault_sign_in", "credential_entry")
    # without a public Mini App address: a clear text; the buttons only explain (they never decide, see above)
    fake.sent.clear()
    await g._notify(_event(vault, t, a["id"], "vault_sign_in", "credential_entry"))
    card = [m for m in _messages(fake.sent, 7) if "Password Vault" in m["text"]][-1]
    assert "cannot be decided in the chat" in card["text"] and "Dashboard → Approvals" in card["text"]
    assert [b["text"] for b in _buttons(card)] == ["✅ Approve once", "⛔ Deny"]
    # with one: the only button opens the approvals in the Mini App, where the owner confirms it's them
    monkeypatch.setattr(remote, "public_base", lambda: URL)
    fake.sent.clear()
    await g._notify(_event(vault, t, a["id"], "vault_sign_in", "credential_entry"))
    card = [m for m in _messages(fake.sent, 7) if "Password Vault" in m["text"]][-1]
    assert _buttons(card) == [{"text": "🔐 Open in NEBULA to decide", "web_app": {"url": f"{URL}/mini/#/approvals"}}]
    assert "Open it in the NEBULA Mini App" in card["text"]
    fake.sent.clear()
    approvals_v2.request("package_install", {"x": 1}, "Install ripgrep?")
    await asyncio.sleep(0.1)
    card = [m for m in _messages(fake.sent, 7) if "Install ripgrep?" in m["text"]][-1]
    assert _buttons(card) == [{"text": "🔐 Open in NEBULA to decide", "web_app": {"url": f"{URL}/mini/#/approvals"}}]
    # pressing an old chat button of a step-up approval also offers the Mini App
    fake.sent.clear()
    await _press(g, fake, 7, f"appr:{vault}:y")
    assert any(_buttons(m) == [{"text": "🔐 Open in NEBULA to decide", "web_app": {"url": f"{URL}/mini/#/approvals"}}]
               for m in _messages(fake.sent, 7))
    # ordinary approvals stay one tap even with a Mini App address
    plain = _approval(t, a["id"])
    fake.sent.clear()
    await g._notify(_event(plain, t, a["id"]))
    card = [m for m in _messages(fake.sent, 7) if "Approval needed" in m["text"]][-1]
    assert [b["callback_data"].split(":")[0] for b in _buttons(card)] == ["ap", "ap"]


async def test_owner_approvals_list_marks_stepup_items(tg, fake_guest):
    from nebula_host import approvals_v2

    g, fake, orch, _ = tg
    a = await _owner_and_operator(g, fake, fake_guest)
    g.v2 = SimpleNamespace()
    t = _task(orch, a["id"], by=7)
    plain = _approval(t, a["id"])
    vault = _approval(t, a["id"], "vault_sign_in", "credential_entry")
    approvals_v2.request("command", {"x": 1}, "run a command")
    fake.sent.clear()
    await g._process(msg(7, 7, "/approvals"))
    out = {m["text"].split(":")[0]: m for m in _messages(fake.sent, 7)}
    assert "cannot be decided in the chat" not in out[f"Task approval #{plain[:8]}"]["text"]
    assert "cannot be decided in the chat" in out[f"Task approval #{vault[:8]}"]["text"]
    assert "cannot be decided in the chat" in out["command approval"]["text"]


# ============================================================================ agent bots: the owner's own account only
async def test_agent_bot_approvals_belong_to_the_owner(tg3, fake_guest):
    from nebula_host import db, models
    from nebula_telegram import access
    from nebula_telegram import cards as cardsvc
    from sqlalchemy import select

    g, fake, orch, multi, mgr = tg3
    from tests.integration.test_telegram_v3 import _ready

    dev = await _ready(g, fake, "Developer")
    ba = await mgr.add(dev["id"], BOT_A, "u")
    r_a = mgr.runners[ba["id"]]
    try:
        await r_a._process(msg(7, 7, f"/start {mgr.create_pairing(ba['id'], 'u')['code']}"))  # the owner: approved
        await r_a._process(msg(9, 9, f"/start {mgr.create_pairing(ba['id'], 'u')['code']}"))  # someone else
        with db.engine().connect() as c:
            row9 = c.execute(select(models.telegram_bot_users.c.id).where(
                models.telegram_bot_users.c.telegram_user_id == 9)).scalar()
        mgr.approve_user(ba["id"], row9, "u")
        # a task that user 9 started through the agent bot: no card for 9, the card goes to the owner's main chat
        await r_a._process(msg(9, 9, "Deploy the site"))
        with db.engine().connect() as c:
            t9 = c.execute(select(models.tasks.c.id).where(models.tasks.c.prompt == "Deploy the site")).scalar()
        aid = _approval(t9, dev["id"])
        ev = _event(aid, t9, dev["id"])
        fake.sent.clear()
        await r_a.on_event(ev)
        await g._notify(ev)
        to9 = [b for m, b in multi.sent[BOT_A] if m == "sendMessage" and b.get("chat_id") == 9]
        assert any("waits for the NEBULA owner's approval" in b["text"] for b in to9)
        assert not any(btn.get("callback_data", "").startswith("ap:") for b in to9 for btn in _buttons(b))
        main_card = [m for m in _messages(fake.sent, 7) if "Approval needed" in m["text"]][-1]
        yes = _buttons(main_card)[0]["callback_data"]
        assert yes == f"ap:{aid}:y:{cardsvc.tag(aid, 'y', 'main', 7)}"
        # user 9 presses a GENUINE button for its own chat on the agent bot: refused
        cid = uuid.uuid4().hex[:12]
        await r_a._process(_cb(9, f"ap:{aid}:y:{cardsvc.tag(aid, 'y', ba['id'], 9)}", cid))
        got = [b for m, b in multi.sent[BOT_A] if m == "answerCallbackQuery" and b.get("callback_query_id") == cid]
        assert got and got[-1]["text"] == access.NOT_OWNER_APPROVAL
        assert _decision(aid) == (None, None)
        assert any(d["target"] == aid for d in _audits("telegram.approval.denied", f"telegram:9@bot:{ba['id'][:8]}"))
        # the owner decides it from the main bot's card
        r = await _press(g, fake, 7, yes)
        assert r["text"] == "approved" and _decision(aid) == ("approved", "telegram:7")
        # a task the owner started through the agent bot: the card comes to that chat and the owner decides there
        await r_a._process(msg(7, 7, "Owner job"))
        with db.engine().connect() as c:
            t7 = c.execute(select(models.tasks.c.id).where(models.tasks.c.prompt == "Owner job")).scalar()
        aid7 = _approval(t7, dev["id"])
        ev7 = _event(aid7, t7, dev["id"])
        fake.sent.clear()
        await r_a.on_event(ev7)
        await g._notify(ev7)
        assert not [m for m in _messages(fake.sent, 7) if "Approval needed" in m["text"]]  # not twice
        card = [b for m, b in multi.sent[BOT_A] if m == "sendMessage" and b.get("chat_id") == 7
                and "Approval needed" in b.get("text", "")][-1]
        yes7 = _buttons(card)[0]["callback_data"]
        cid = uuid.uuid4().hex[:12]
        await r_a._process(_cb(7, yes7, cid))
        assert _decision(aid7) == ("approved", f"telegram:7@bot:{ba['id'][:8]}")
    finally:
        await mgr.stop()


# ============================================================================ operators: stored permissions
async def test_operator_commands_follow_the_stored_permissions(tg, fake_guest):
    from nebula_host import db, models
    from nebula_telegram import access
    from sqlalchemy import select

    g, fake, orch, _ = tg
    a = await _owner_and_operator(g, fake, fake_guest)  # operator default: tasks, commands, screenshot
    g.v2 = SimpleNamespace()
    g.cfg.telegram.rate_limit_per_minute = 600  # many commands in one test (the config is rebuilt per test)
    g._select(g._user(8, 8), a["id"])

    async def reply(text: str) -> str:
        fake.sent.clear()
        await g._process(msg(8, 8, text))
        out = _messages(fake.sent, 8)
        return out[-1]["text"] if out else ""

    assert await reply("/model") == access.NOT_OWNER
    assert await reply("/newagent") == access.NOT_OWNER
    assert await reply("/approvals") == access.NOT_OWNER_APPROVAL
    assert await reply("/wf deploy now") == access.refusal(("workflows",))
    assert await reply("/get out/report.csv") == access.refusal(("files",))
    assert await reply("/files") == access.refusal(("files",))
    assert await reply("/project Acme | Site | build it") == access.refusal(("companies",))
    assert await reply("/xyz") == "Unknown command. /help"
    for allowed in ("/pause", "/status", "/history", "/help", "/agents", "/voice"):
        out = await reply(allowed)
        assert out and "permission" not in out and access.NOT_OWNER not in out, (allowed, out)
    assert (await reply("/help")).startswith("NEBULA\n")
    t = _task(orch, a["id"], by=8)
    r = await _press(g, fake, 8, f"c:x:{t}")
    assert "permission" not in r.get("text", "")  # commands: stopping its task is allowed
    # an operator with only `tasks`: no task control, no screenshots, still tasks
    _set_permissions(8, ["tasks"])
    assert await reply("/pause") == access.refusal(("commands",))
    assert await reply("/screenshot") == access.refusal(("screenshot",))
    assert await reply("/voice text") == access.refusal(("commands",))
    t2 = _task(orch, a["id"], "second", by=8)
    for data in (f"c:p:{t2}", f"t:x:{t2}", f"c:t:{t2}"):
        assert (await _press(g, fake, 8, data))["text"] == access.refusal(("commands",)), data
    assert (await _press(g, fake, 8, f"c:i:{t2}"))["text"] == access.refusal(("screenshot",))
    assert (await _press(g, fake, 8, f"dl:{t2}:0"))["text"] == access.refusal(("files",))
    assert (await _press(g, fake, 8, "mdl:0"))["text"] == access.NOT_OWNER
    await reply("write a haiku")
    with db.engine().connect() as c:
        assert c.execute(select(models.tasks.c.id).where(models.tasks.c.prompt == "write a haiku")).first()
    # no permissions at all: not even a task
    _set_permissions(8, [])
    assert await reply("write another haiku") == access.refusal(("tasks",))
    with db.engine().connect() as c:
        assert c.execute(select(models.tasks.c.id).where(models.tasks.c.prompt == "write another haiku")).first() is None
    # files given by the owner: /get is allowed (usage answer, no refusal)
    _set_permissions(8, ["tasks", "files"])
    assert (await reply("/get")).startswith("Usage: /get")
    denied = _audits("telegram.command.denied", "telegram:8")
    assert {d["target"] for d in denied} >= {"/model", "/newagent", "/wf", "/get", "/files", "/project", "/pause",
                                             "message", "c", "t", "dl", "mdl"}
    # the owner keeps everything
    fake.sent.clear()
    await g._process(msg(7, 7, "/get"))
    assert _messages(fake.sent, 7)[-1]["text"].startswith("Usage: /get")


def test_every_chat_command_and_button_is_mapped(dbinit):
    from nebula_telegram import access
    from nebula_telegram import v3 as tg3

    commands = {w[1:] for w in tg3.HELP_V3.replace("·", " ").split() if w.startswith("/") and w[1:].isalpha()}
    commands |= {"start", "newagent", "use", "team", "company"}
    assert commands - set(access.COMMANDS) - {"voice"} == set()
    assert access.command_needs("voice") == () and access.command_needs("voice", "text") == ("commands",)
    assert access.command_needs("nonsense") is None
    for data in ("use:x", "nl:all", "co:x", "cr:x", "c:d:x", "t:s:x"):
        assert access.callback_needs(data) == (), data
    for data, need in (("c:x:t", ("commands",)), ("t:p:t", ("commands",)), ("c:i:t", ("screenshot",)),
                       ("dl:t:0", ("files",)), ("sch:x", ("tasks",)), ("as:t:0", ("tasks", "commands"))):
        assert access.callback_needs(data) == need, data
    for data in ("appr:a:y", "oa:a:y", "ap:a:y:tag"):
        assert access.callback_needs(data) == (access.APPROVAL,)
    for data in ("lvl:ADVANCED", "mdl:0", "auth:as_x:c", "zz:1", "", "c:zz:t"):
        assert access.callback_needs(data) == (access.OWNER,), data  # deny by default
    agent_bot, main = SimpleNamespace(key="bot-row-1"), SimpleNamespace(key="main")
    stranger = {"telegram_user_id": 9, "permissions": []}
    assert not access.allowed(agent_bot, stranger, (access.APPROVAL,))
    assert not access.allowed(agent_bot, stranger, (access.OWNER,))
    assert access.allowed(agent_bot, stranger, ("tasks",))  # confined to its agent by the bot itself
    assert not access.allowed(main, stranger, ("tasks",))
    assert not access.allowed(main, {"telegram_user_id": 8, "permissions": ["tasks"]}, access.VOICE_INTENTS["pause"])
    assert not access.allowed(main, {"telegram_user_id": 8, "permissions": ["approvals", "agents"]}, (access.OWNER,))


# ============================================================================ N9 / N11 on the host
@pytest.fixture()
def gw97(client):
    from nebula_host import remote

    app = remote.build_gateway(3199, Path("/nonexistent"), forward_client=httpx.AsyncClient(
        transport=_Bridge(client), base_url="http://127.0.0.1:3199"), listen_port=3197)
    with TestClient(app, base_url="http://127.0.0.1:3197") as gc:
        yield gc


def test_approval_read_routes_are_owner_only_remotely(client, gw97):
    _setup_admin(client)
    _pair_owner(7)
    _pair_owner(8)  # an operator with stored permissions ["tasks"]
    owner, _ = _mini(gw97, 7)
    op, data = _mini(gw97, 8)
    assert data["permissions"] == ["tasks"]
    for path in ("/api/v1/approvals", "/api/v1/owner-approvals", "/api/v1/approval-center"):
        r = gw97.get(path, headers=op)
        assert r.status_code == 403 and r.json()["error"]["code"] == "owner_only", (path, r.text)
        assert gw97.get(path, headers=owner).status_code == 200, path
        assert client.get(path).status_code == 200, path  # the local dashboard is unchanged


def test_dashboard_session_with_the_gateway_header_is_refused(client, gw97):
    from nebula_host import auth, remote
    from nebula_host.errors import ApiError
    from starlette.requests import Request

    _setup_admin(client)
    assert client.get("/api/v1/settings").status_code == 200  # the local dashboard keeps working
    r = client.get("/api/v1/settings", headers={"x-nebula-gateway": remote.GATEWAY_SECRET})
    assert r.status_code == 401 and r.json()["error"]["code"] == "unauthenticated"
    r = client.get("/api/v1/approval-center", headers={"x-nebula-gateway": remote.GATEWAY_SECRET})
    assert r.status_code == 401
    # auth.require_session refuses it on its own too (defence in depth, independent of the middleware)
    token = client.cookies.get(auth.COOKIE)
    assert token

    def req(*extra):
        return Request({"type": "http", "method": "GET", "path": "/api/v1/x", "query_string": b"",
                        "headers": [(b"cookie", f"{auth.COOKIE}={token}".encode()), *extra]})

    with pytest.raises(ApiError) as e:
        asyncio.run(auth.require_session(req((b"x-nebula-gateway", remote.GATEWAY_SECRET.encode()))))
    assert e.value.status == 401
    assert asyncio.run(auth.require_session(req())).via is None
    # the gateway keeps forwarding remote sessions
    _pair_owner(7)
    owner, _ = _mini(gw97, 7)
    assert gw97.get("/api/v1/settings", headers=owner).status_code == 200


# ============================================================================ N8 / N3 texts
def test_gateway_docstring_and_bot_texts_are_current(dbinit):
    from nebula_host import remote
    from nebula_telegram import v3 as tg3

    doc = remote.__doc__ or ""
    assert "never publishes its admin dashboard" not in doc and "remote gateway" in doc
    assert "administer NEBULA" in doc
    assert tg3.HELP_V3.startswith("NEBULA\n")
    pkg = ROOT / "packages" / "telegram-gateway" / "nebula_telegram"
    for f in pkg.glob("*.py"):
        text = f.read_text()
        assert "NEBULA 3.0" not in text and "NEBULA 2.0" not in text, f.name


async def test_start_and_help_say_nebula(tg, fake_guest):
    g, fake, *_ = tg
    await _owner_and_operator(g, fake, fake_guest)
    for uid in (7, 8):
        fake.sent.clear()
        await g._process(msg(uid, uid, "/start"))
        await g._process(msg(uid, uid, "/help"))
        texts = [m["text"] for m in _messages(fake.sent, uid)]
        assert len(texts) == 2 and all(t.startswith("NEBULA\n") and "3.0" not in t for t in texts)
