"""Telegram gateway against an in-process fake Bot API (httpx MockTransport)."""

from __future__ import annotations

import asyncio
import json
import time
import uuid

import httpx
import pytest

TOKEN = "123456789:" + "A" * 35


class FakeBotAPI:
    def __init__(self, topics: bool = True) -> None:
        self.sent: list[tuple[str, dict]] = []
        self.updates: list[dict] = []
        self.topics = topics
        self.next_thread = 100
        self.fail_send_once_429 = False
        self.files: dict[str, bytes] = {}

    def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if "/file/bot" in path:
            return httpx.Response(200, content=self.files.get(path.rsplit("/", 1)[-1], b"data"))
        method = path.rsplit("/", 1)[-1]
        if request.headers.get("content-type", "").startswith("application/json"):
            body = json.loads(request.content or b"{}")
        else:
            body = {"_multipart": True}
        if f"/bot{TOKEN}/" not in path:
            return httpx.Response(401, json={"ok": False, "error_code": 401, "description": "Unauthorized"})
        self.sent.append((method, body))
        if method == "getMe":
            return httpx.Response(200, json={"ok": True, "result": {"id": 42, "is_bot": True, "username": "nebula_test_bot",
                                                                    "first_name": "N", "has_topics_enabled": self.topics}})
        if method == "getUpdates":
            ups, self.updates = self.updates, []
            return httpx.Response(200, json={"ok": True, "result": ups})
        if method == "sendMessage" and self.fail_send_once_429:
            self.fail_send_once_429 = False
            return httpx.Response(429, json={"ok": False, "error_code": 429, "description": "Too Many Requests",
                                             "parameters": {"retry_after": 1}})
        if method == "createForumTopic":
            self.next_thread += 1
            return httpx.Response(200, json={"ok": True, "result": {"message_thread_id": self.next_thread,
                                                                    "name": body["name"], "icon_color": 1}})
        if method == "getFile":
            return httpx.Response(200, json={"ok": True, "result": {"file_id": body["file_id"], "file_path": "docs/f.txt"}})
        return httpx.Response(200, json={"ok": True, "result": {"message_id": len(self.sent)}})

    def texts(self, chat_id: int | None = None) -> list[str]:
        return [b.get("text", "") for m, b in self.sent if m == "sendMessage" and (chat_id is None or b.get("chat_id") == chat_id)]


@pytest.fixture()
def tg(dbinit, fake_guest):
    from nebula_host.config import get_config
    from nebula_runtime.orchestrator import Orchestrator
    from nebula_telegram import gateway as gw

    fake = FakeBotAPI()
    cfg = get_config()
    orch = Orchestrator(cfg, fake_guest)
    created = []

    async def creator(body, actor):
        from nebula_host import agents_service

        a = await agents_service.create(fake_guest, body, actor)
        created.append(a)
        return a

    g = gw.TelegramGateway(cfg, orch, fake_guest, creator)
    g.api._client = httpx.AsyncClient(transport=httpx.MockTransport(fake.handler))
    real_botapi = gw.BotAPI

    class PatchedBotAPI(real_botapi):
        def __init__(self, token_getter, base):
            super().__init__(token_getter, base)
            self._client = httpx.AsyncClient(transport=httpx.MockTransport(fake.handler))

    gw.BotAPI = PatchedBotAPI
    try:
        yield g, fake, orch, created
    finally:
        gw.BotAPI = real_botapi
        from nebula_host import authz
        from nebula_host.events import bus

        g.running = False  # a gateway left on the event bus would react to the events of later tests
        bus.remove_listener(g.on_event)
        authz.forget_owner_cache()


def msg(uid: int, chat: int, text: str, thread: int | None = None, update_id: int | None = None, **extra) -> dict:
    m = {"message_id": int(time.time() * 1000) % 100000, "from": {"id": uid, "is_bot": False, "first_name": "Zed"},
         "chat": {"id": chat, "type": "private"}, "date": int(time.time()), "text": text, **extra}
    if thread:
        m["message_thread_id"] = thread
        m["is_topic_message"] = True
    return {"update_id": update_id or int(uuid.uuid4().int % 10**9), "message": m}


async def _bind():
    from nebula_host.events import bus

    bus.bind_loop(asyncio.get_running_loop())


async def _pair(g, fake, uid=7, chat=7):
    await g.set_token(TOKEN, "user:owner")
    await g.stop()  # drive updates manually in tests
    p = g.create_pairing("user:owner")
    await g._process(msg(uid, chat, f"/start {p['code']}"))
    return p


async def test_token_validated_with_getme_and_stored_in_secret_store(tg):
    g, fake, *_ = tg
    await _bind()
    with pytest.raises(ValueError):
        await g.set_token("not-a-token", "u")
    st = await g.set_token(TOKEN, "user:owner")
    await g.stop()
    assert st["bot_username"] == "nebula_test_bot" and st["configured"] is True
    assert ("getMe", {}) in fake.sent
    from nebula_host import db

    assert TOKEN.encode() not in open(db.engine().url.database, "rb").read()


async def test_pairing_requires_dashboard_approval(tg):
    g, fake, *_ = tg
    await _bind()
    p = await _pair(g, fake)
    st = g.public_status()
    assert st["users"][0]["status"] == "pending"
    assert any("Confirm these numbers" in t for t in fake.texts(7))
    # before approval: no tool access, polite refusal
    await g._process(msg(7, 7, "/agents"))
    assert any("private NEBULA bot" in t for t in fake.texts(7))
    await g.approve(p["pairing_id"], "user:owner")
    assert g.public_status()["users"][0]["status"] == "approved"


async def test_expired_or_reused_code_and_unknown_user_rejected(tg):
    g, fake, *_ = tg
    await _bind()
    await g.set_token(TOKEN, "u")
    await g.stop()
    p = g.create_pairing("u")
    from nebula_host import db, models
    from sqlalchemy import update

    with db.engine().begin() as c:
        c.execute(update(models.telegram_pairings).values(expires_at=time.time() - 1))
    await g._process(msg(9, 9, f"/start {p['code']}"))
    assert g.public_status()["users"] == []
    p2 = g.create_pairing("u")
    await g._process(msg(9, 9, f"/start {p2['code']}"))
    await g._process(msg(10, 10, f"/start {p2['code']}"))  # single use
    users = g.public_status()["users"]
    assert [u["telegram_user_id"] for u in users] == [9]


async def test_duplicate_update_processed_once_and_offset_durable(tg, fake_guest):
    g, fake, orch, _ = tg
    await _bind()
    p = await _pair(g, fake)
    await g.approve(p["pairing_id"], "owner")
    from nebula_host import agents_service

    a = await agents_service.create(fake_guest, {"name": "Dev", "provider_id": "ollama-local", "model_id": "m"}, "t")
    g._select({"id": g.public_status()["users"][0]["id"]}, a["id"])
    up = msg(7, 7, "write a haiku", update_id=555)
    await g._process(up)
    await g._process(up)
    from nebula_host import db, models

    with db.engine().connect() as c:
        n = c.execute(models.tasks.select()).all()
    assert len(n) == 1
    from nebula_telegram.gateway import get_cfg_row

    assert get_cfg_row()["update_offset"] == 556
    assert any(t.startswith("NEBULA — ") and "Status:" in t for t in fake.texts(7))  # V3 live task card


async def test_wrong_chat_id_is_rejected(tg, fake_guest):
    g, fake, *_ = tg
    await _bind()
    p = await _pair(g, fake, uid=7, chat=7)
    await g.approve(p["pairing_id"], "owner")
    fake.sent.clear()
    await g._process(msg(7, 999, "/status"))  # same user, different chat
    assert all("Agent:" not in t for t in fake.texts())


async def test_topics_route_to_correct_agent(tg, fake_guest):
    g, fake, orch, _ = tg
    await _bind()
    from nebula_host import agents_service

    a = await agents_service.create(fake_guest, {"name": "Dev", "provider_id": "ollama-local", "model_id": "m"}, "t")
    b = await agents_service.create(fake_guest, {"name": "Research", "provider_id": "ollama-local", "model_id": "m"}, "t")
    p = await _pair(g, fake)
    await g.approve(p["pairing_id"], "owner")
    topics = {t["agent_id"]: t for t in g.public_status()["topics"]}
    assert topics[a["id"]]["mapping_type"] == "private_topic" and topics[b["id"]]["message_thread_id"]
    await g._process(msg(7, 7, "task for research", thread=topics[b["id"]]["message_thread_id"]))
    await g._process(msg(7, 7, "task for dev", thread=topics[a["id"]]["message_thread_id"]))
    from nebula_host import db, models

    with db.engine().connect() as c:
        rows = {r.prompt: r.agent_id for r in c.execute(models.tasks.select())}
    assert rows == {"task for research": b["id"], "task for dev": a["id"]}


async def test_fallback_without_topics_uses_inline_choice(tg, fake_guest):
    g, fake, *_ = tg
    fake.topics = False
    await _bind()
    from nebula_host import agents_service

    a = await agents_service.create(fake_guest, {"name": "Dev", "provider_id": "ollama-local", "model_id": "m"}, "t")
    p = await _pair(g, fake)
    await g.approve(p["pairing_id"], "owner")
    assert g.public_status()["topics"][0]["mapping_type"] == "command_fallback"
    fake.sent.clear()
    await g._process(msg(7, 7, "hello"))
    kb = [b for m, b in fake.sent if m == "sendMessage" and b.get("reply_markup")]
    assert kb and kb[0]["reply_markup"]["inline_keyboard"][0][0]["callback_data"] == f"use:{a['id']}"
    await g._process(msg(7, 7, "/use Dev"))
    await g._process(msg(7, 7, "now do it"))
    assert any(t.startswith("NEBULA — ") and "Status:" in t for t in fake.texts(7))  # V3 live task card


async def test_forged_callback_from_unpaired_user_ignored(tg):
    g, fake, orch, _ = tg
    await _bind()
    await _pair(g, fake)
    fake.sent.clear()
    await g._process({"update_id": 77, "callback_query": {"id": "cb1", "from": {"id": 666}, "data": "appr:x:y",
                                                          "message": {"chat": {"id": 666}, "message_id": 1}}})
    assert fake.sent[-1][0] == "answerCallbackQuery" and fake.sent[-1][1]["text"] == "Not authorized"


async def test_pause_command_and_screenshot(tg, fake_guest):
    g, fake, orch, _ = tg
    await _bind()
    from nebula_host import agents_service

    a = await agents_service.create(fake_guest, {"name": "Dev", "provider_id": "ollama-local", "model_id": "m"}, "t")
    p = await _pair(g, fake)
    await g.approve(p["pairing_id"], "owner")
    thread = g.public_status()["topics"][0]["message_thread_id"]
    t = orch.enqueue(a["id"], "long job")
    await g._process(msg(7, 7, "/pause", thread=thread))
    from nebula_runtime.orchestrator import get_task

    assert get_task(t["id"])["state"] == "PAUSED"
    assert any("PAUSED" in x for x in fake.texts(7))
    await g._process(msg(7, 7, "/screenshot", thread=thread))
    photos = [b for m, b in fake.sent if m == "sendPhoto"]
    assert photos and any(c[1].get("tool") == "desktop.screenshot" for c in fake_guest.calls)


async def test_document_saved_to_workspace_and_voice_not_faked(tg, fake_guest):
    g, fake, *_ = tg
    await _bind()
    from nebula_host import agents_service

    a = await agents_service.create(fake_guest, {"name": "Dev", "provider_id": "ollama-local", "model_id": "m"}, "t")
    p = await _pair(g, fake)
    await g.approve(p["pairing_id"], "owner")
    thread = g.public_status()["topics"][0]["message_thread_id"]
    await g._process(msg(7, 7, "", thread=thread, document={"file_id": "F1", "file_name": "../../evil.txt",
                                                             "mime_type": "text/plain", "file_size": 4}))
    # V3: validated + stored as an attachment (safe name, no traversal), waiting for instructions
    from nebula_host import attachments as attsvc

    atts = attsvc.list_for(agent_id=a["id"])
    assert atts and atts[0]["name"] == "evil.txt" and ".." not in atts[0]["storage"] and atts[0]["kind"] == "text"
    assert any(t.startswith("📎 evil.txt") for t in fake.texts(7))
    await g._process(msg(7, 7, "", thread=thread, document={"file_id": "F2", "file_name": "x.exe",
                                                             "mime_type": "application/x-msdownload", "file_size": 4}))
    assert any("x.exe was rejected" in t and "not accepted" in t for t in fake.texts(7))
    await g._process(msg(7, 7, "", thread=thread, voice={"file_id": "V", "duration": 2}))
    assert any("not set up" in t and "nothing was sent" in t for t in fake.texts(7))  # V2: real STT or refusal
    _ = a


async def test_send_retries_on_429(tg):
    g, fake, *_ = tg
    await _bind()
    await g.set_token(TOKEN, "u")
    await g.stop()
    fake.fail_send_once_429 = True
    r = await g.api.send_message(1, "hello")
    assert r["message_id"] >= 1
    assert [m for m, _ in fake.sent].count("sendMessage") == 2
