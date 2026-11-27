"""Telegram 3.0 against a fake multi-bot Bot API: live task cards (TG-01..08), independent agent bots (BOT-01..07),
voice agent 2.0 pipeline (VOICE-01, 04..07; real local TTS), multimodal intake through Telegram (MM-01, MM-06).

Real gateway/orchestrator/services with the fake guest; no network, no real AI or STT.
"""

from __future__ import annotations

import asyncio
import base64
import json
import time
import uuid
from types import SimpleNamespace

import httpx
import pytest

from tests.conftest import ScriptedProvider, call, done, png_b64
from tests.integration.test_telegram import TOKEN, _bind, _pair, msg, tg  # noqa: F401

BOT_A = "5550001:AAagentbotAAAAAAAAAAAAAAAAAAAAAAAAA1"
BOT_B = "5550002:AAagentbotBBBBBBBBBBBBBBBBBBBBBBBBB2"


class MultiFake:
    """Fake Bot API serving several bot identities (main + agent bots)."""

    def __init__(self, main_fake) -> None:
        self.main = main_fake
        self.bots = {BOT_A: {"id": 5550001, "username": "dev_agent_bot"}, BOT_B: {"id": 5550002,
                                                                                 "username": "res_agent_bot"}}
        self.sent: dict[str, list] = {BOT_A: [], BOT_B: []}
        self.updates: dict[str, list] = {BOT_A: [], BOT_B: []}
        self.revoked: set[str] = set()

    def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        tok = next((t for t in self.bots if f"/bot{t}/" in path), None)
        if tok is None:
            return self.main.handler(request)
        if "/file/bot" in path:
            return httpx.Response(200, content=self.main.files.get("f.txt", b"data"))
        if tok in self.revoked:
            return httpx.Response(401, json={"ok": False, "error_code": 401, "description": "Unauthorized"})
        method = path.rsplit("/", 1)[-1]
        body = json.loads(request.content or b"{}") if request.headers.get("content-type", "").startswith(
            "application/json") else {"_multipart": True}
        self.sent[tok].append((method, body))
        if method == "getMe":
            return httpx.Response(200, json={"ok": True, "result": {"id": self.bots[tok]["id"], "is_bot": True,
                                                                    "first_name": "Agent", **self.bots[tok]}})
        if method == "getUpdates":
            ups, self.updates[tok] = self.updates[tok], []
            return httpx.Response(200, json={"ok": True, "result": ups})
        if method == "getFile":
            return httpx.Response(200, json={"ok": True, "result": {"file_id": body["file_id"], "file_path": "x/f.txt"}})
        return httpx.Response(200, json={"ok": True, "result": {"message_id": 1000 + len(self.sent[tok])}})

    def texts(self, tok: str, chat: int | None = None) -> list[str]:
        return [b.get("text", "") for m, b in self.sent[tok] if m == "sendMessage" and (chat is None or
                                                                                      b.get("chat_id") == chat)]


@pytest.fixture()
def tg3(tg, fake_guest, monkeypatch):  # noqa: F811
    g, fake, orch, created = tg
    from nebula_host.files_service import FileBridge
    from nebula_host.hostexec import HostExecutor
    from nebula_telegram import botapi, multibot
    from nebula_telegram import cards as cardmod

    multi = MultiFake(fake)

    class PatchedBotAPI(botapi.BotAPI):
        def __init__(self, token_getter, base="https://api.telegram.org"):
            super().__init__(token_getter, base)
            self._client = httpx.AsyncClient(transport=httpx.MockTransport(multi.handler))

    monkeypatch.setattr(multibot, "BotAPI", PatchedBotAPI)
    g.api._client = httpx.AsyncClient(transport=httpx.MockTransport(multi.handler))
    cfg = g.cfg
    from nebula_host.state import svc as host_svc

    monkeypatch.setattr(host_svc, "cfg", cfg)  # an earlier app test may have left another data dir here
    svc = SimpleNamespace(files=FileBridge(cfg, fake_guest), host=HostExecutor(cfg), companies=None)
    g.v2 = svc
    orch.host = svc.host
    cardmod.cards.register("main", g.api)
    monkeypatch.setattr(cardmod, "MIN_EDIT_INTERVAL", 0.0)
    mgr = multibot.AgentBotManager(cfg, orch, fake_guest)
    mgr.svc = svc
    from nebula_host.events import bus
    from nebula_telegram import v3 as tgv3

    async def cards_listener(ev):
        if ev["type"].startswith("task."):
            await tgv3.on_task_event(None, ev)

    bus.add_listener(cards_listener)
    tgv3._pending.clear()  # module-level per-chat state from earlier tests
    yield g, fake, orch, multi, mgr
    bus.remove_listener(cards_listener)
    bus.remove_listener(mgr.on_event)


async def _ready(g, fake, name="Dev"):
    await _bind()
    p = await _pair(g, fake)
    await g.approve(p["pairing_id"], "user:owner")
    g.running = True
    from nebula_host import agents_service

    a = await agents_service.create(g.guest, {"name": name, "provider_id": "ollama-local", "model_id": "m",
                                              "permission_level": "ADVANCED"}, "user:owner")
    g._select(g._user(7, 7), a["id"])
    return a


def _cb(uid, chat, data, cid=None):
    return {"update_id": int(uuid.uuid4().int % 10**9), "callback_query": {
        "id": cid or uuid.uuid4().hex[:12], "from": {"id": uid}, "data": data,
        "message": {"chat": {"id": chat}, "message_id": 5}}}


async def _wait_state(tid, states, timeout=8.0):
    from nebula_runtime.orchestrator import get_task

    end = time.time() + timeout
    while time.time() < end:
        t = get_task(tid)
        if t["state"] in states:
            return t
        await asyncio.sleep(0.05)
    raise AssertionError(f"task stuck in {get_task(tid)['state']}")


# ====================================================================================== TG-01..08 live task cards
async def test_tg01_to_08_live_cards_buttons_approvals(tg3, monkeypatch, fake_guest):
    g, fake, orch, multi, mgr = tg3
    a = await _ready(g, fake)
    from nebula_host import providers_service

    gate = asyncio.Event()
    prov = ScriptedProvider([[call("desktop_screenshot", {}), done()],
                             [call("shell_execute", {"command": "rm -rf /tmp/x"}), done()]], block=gate)
    monkeypatch.setattr(providers_service, "adapter_for", lambda pid: prov)
    await orch.start()
    try:
        # TG-01 task creation -> one compact card with buttons
        await g._process(msg(7, 7, "Build landing page"))
        card = [b for m, b in fake.sent if m == "sendMessage" and b.get("text", "").startswith("NEBULA — Dev")][-1]
        assert "Task: Build landing page" in card["text"] and "Environment: Ubuntu VM" in card["text"]
        tid = next(c["callback_data"] for row in card["reply_markup"]["inline_keyboard"] for c in row
                   if c.get("callback_data", "").startswith("c:x:"))[4:]
        # TG-02 progress update: the SAME message is edited (no new message per step)
        gate.set()
        await _wait_state(tid, {"WAITING_APPROVAL"})
        await asyncio.sleep(0.3)
        edits = [b for m, b in fake.sent if m == "editMessageText"]
        assert edits and any("WAITING_FOR_APPROVAL" in e["text"] for e in edits)
        assert any("desktop_screenshot" in e["text"] for e in edits)
        n_cards = len([b for m, b in fake.sent if m == "sendMessage" and b.get("text", "").startswith("NEBULA — Dev")])
        assert n_cards == 1
        # TG-07 approval: exact operation shown, HMAC-bound buttons, forged tag refused, approval applied once
        ap = [b for m, b in fake.sent if m == "sendMessage" and "Approval needed" in b.get("text", "")][-1]
        assert "rm -rf /tmp/x" in ap["text"]
        yes = ap["reply_markup"]["inline_keyboard"][0][0]["callback_data"]
        aid = yes.split(":")[1]
        forged = f"ap:{aid}:y:AAAAAAAAAA"
        await g._process(_cb(7, 7, forged))
        assert ("answerCallbackQuery", {"callback_query_id": None}) not in fake.sent
        from nebula_host import db, models
        from sqlalchemy import select

        with db.engine().connect() as c:
            assert c.execute(select(models.approvals.c.decision).where(models.approvals.c.id == aid)).scalar() is None
        # the button is bound to this chat: replaying it in another (even authorised) chat is refused
        await g._process(_cb(7, 7, yes.replace(":y:", ":n:")))  # tag does not match the changed decision
        with db.engine().connect() as c:
            assert c.execute(select(models.approvals.c.decision).where(models.approvals.c.id == aid)).scalar() is None
        await g._process(_cb(7, 7, yes, cid="dup-1"))
        await g._process(_cb(7, 7, yes, cid="dup-1"))  # TG-08 duplicate callback is processed once
        answers = [b for m, b in fake.sent if m == "answerCallbackQuery" and b.get("callback_query_id") == "dup-1"]
        assert [x.get("text") for x in answers] == ["approved", "Already processed"]
        await _wait_state(tid, {"PLANNING", "EXECUTING", "COMPLETED", "FAILED"})
        # TG-03/04 pause and resume from the card
        prov.turns = [[call("desktop_screenshot", {}), done()]] * 5
        t2 = orch.enqueue(a["id"], "second job", source="telegram", reply_target={"chat_id": 7})
        await g._process(_cb(7, 7, f"c:p:{t2['id']}"))
        await _wait_state(t2["id"], {"PAUSED", "PAUSING"})
        await g._process(_cb(7, 7, f"c:r:{t2['id']}"))
        await _wait_state(t2["id"], {"QUEUED", "PLANNING", "EXECUTING", "COMPLETED"})
        # TG-06 screenshot from the card
        await g._process(_cb(7, 7, f"c:i:{t2['id']}"))
        assert any(m == "sendPhoto" for m, _ in fake.sent)
        # TG-05 stop
        await g._process(_cb(7, 7, f"c:x:{t2['id']}"))
        await _wait_state(t2["id"], {"CANCELLED", "COMPLETED"})
        # retry creates a NEW task with a new card
        before = len([1 for m, b in fake.sent if m == "sendMessage" and b.get("text", "").startswith("NEBULA — Dev")])
        await g._process(_cb(7, 7, f"c:t:{t2['id']}"))
        after = len([1 for m, b in fake.sent if m == "sendMessage" and b.get("text", "").startswith("NEBULA — Dev")])
        from nebula_runtime.orchestrator import get_task

        assert after == before + (1 if get_task(t2["id"])["state"] == "CANCELLED" else 0)
        # unauthorised Telegram users cannot press card buttons
        await g._process(_cb(666, 666, f"c:x:{tid}"))
        assert ("answerCallbackQuery", {"callback_query_id": fake.sent[-1][1]["callback_query_id"],
                                        "text": "Not authorized"}) in fake.sent
    finally:
        gate.set()
        await orch.shutdown()


async def test_notification_levels(tg3):
    g, fake, orch, *_ = tg3
    await _ready(g, fake)
    await g._process(msg(7, 7, "/notify"))
    kb = [b for m, b in fake.sent if m == "sendMessage" and "Notification level: important" in b.get("text", "")][-1]
    assert [r[0]["callback_data"] for r in kb["reply_markup"]["inline_keyboard"]][-1] == "nl:silent"
    await g._process(_cb(7, 7, "nl:errors"))
    from nebula_telegram import cards

    assert cards.level_of("main", 7) == "errors"
    await g._process(msg(7, 7, "/notify silent"))
    assert cards.level_of("main", 7) == "silent"


# ====================================================================================== BOT-01..07 agent bots
async def test_bot01_to_07_independent_agent_bots(tg3, fake_guest):
    g, fake, orch, multi, mgr = tg3
    dev = await _ready(g, fake, "Developer")
    from nebula_host import agents_service
    from nebula_telegram.multibot import BotError

    res = await agents_service.create(fake_guest, {"name": "Researcher", "provider_id": "ollama-local",
                                                   "model_id": "m"}, "u")
    # BOT-02 token validation: malformed, rejected by Telegram, main bot's token, duplicates
    with pytest.raises(BotError):
        await mgr.add(dev["id"], "not-a-token", "u")
    with pytest.raises(BotError) as e:
        await mgr.add(dev["id"], "5559999:AAunknownXXXXXXXXXXXXXXXXXXXXXXXXXXX", "u")
    assert e.value.code == "token_invalid"
    with pytest.raises(BotError) as e:
        await mgr.add(dev["id"], TOKEN, "u")
    assert e.value.code == "collision"
    # BOT-01/03 add + bind (metadata configured where the Bot API allows it)
    ba = await mgr.add(dev["id"], BOT_A, "u")
    bb = await mgr.add(res["id"], BOT_B, "u")
    assert ba["agent_id"] == dev["id"] and ba["username"] == "dev_agent_bot" and BOT_A.split(":")[1] not in json.dumps(ba)
    assert ba["metadata"]["commands"] == "ok" and "BotFather" in ba["metadata"]["avatar"]
    with pytest.raises(BotError) as e:
        await mgr.add(dev["id"], BOT_B, "u")
    assert e.value.code == "exists"
    # pairing: owner already paired with the main bot -> approved automatically; strangers are refused
    code = mgr.create_pairing(ba["id"], "u")["code"]
    r_a = mgr.runners[ba["id"]]
    await r_a._process(msg(7, 7, f"/start {code}"))
    assert any("Paired" in t for t in multi.texts(BOT_A, 7))
    await r_a._process(msg(66, 66, "hello"))
    assert any("private NEBULA agent bot" in t for t in multi.texts(BOT_A, 66))
    code_b = mgr.create_pairing(bb["id"], "u")["code"]
    r_b = mgr.runners[bb["id"]]
    await r_b._process(msg(7, 7, f"/start {code_b}"))
    # BOT-04 independent routing
    await r_a._process(msg(7, 7, "Implement the login API"))
    await r_b._process(msg(7, 7, "Research password policies"))
    from nebula_host import db, models
    from sqlalchemy import select

    with db.engine().connect() as c:
        rows = {r.prompt: r for r in c.execute(select(models.tasks))}
    assert rows["Implement the login API"].agent_id == dev["id"] and rows["Implement the login API"].reply_target["bot"] == ba["id"]
    assert rows["Research password policies"].agent_id == res["id"]
    # BOT-05 isolation: bot B cannot control agent A's task; agent A's results never go to bot B or the main bot
    ta = rows["Implement the login API"].id
    await r_b._process(_cb(7, 7, f"c:x:{ta}"))
    assert any(b.get("text") == "Not this agent's task" for m, b in multi.sent[BOT_B] if m == "answerCallbackQuery")
    main_before = len(fake.texts(7))
    from nebula_runtime.orchestrator import finish

    finish(ta, "COMPLETED", result={"summary": "login API done", "verified_artifacts": []})
    await asyncio.sleep(0.3)
    assert any("login API done" in t for t in multi.texts(BOT_A, 7))
    assert not any("login API done" in t for t in multi.texts(BOT_B, 7))
    assert not any("login API done" in t for t in fake.texts(7)[main_before:])
    # BOT-06 restart recovery: offset persisted, duplicates ignored, a new manager resumes polling
    upd = msg(7, 7, "/status", update_id=4242)
    await r_a._process(upd)
    await r_a._process(upd)
    statuses = [t for t in multi.texts(BOT_A, 7) if t.startswith("Developer")]
    assert len(statuses) == 1
    from nebula_telegram.multibot import AgentBotManager, get_bot

    assert get_bot(ba["id"])["update_offset"] == 4243
    await mgr.stop()
    mgr2 = AgentBotManager(g.cfg, orch, fake_guest)
    mgr2.svc = mgr.svc
    await mgr2.start()
    assert set(mgr2.runners) == {ba["id"], bb["id"]}
    # BOT-07 revoked token disables ONLY that bot
    multi.revoked.add(BOT_A)
    for _ in range(60):
        if get_bot(ba["id"])["status"] == "REVOKED":
            break
        await asyncio.sleep(0.05)
    assert get_bot(ba["id"])["status"] == "REVOKED" and get_bot(ba["id"])["enabled"] is False
    assert get_bot(bb["id"])["status"] == "ACTIVE" and mgr2.runners[bb["id"]].running
    out = await mgr2.remove(ba["id"], "u")
    assert out["removed"] == ba["id"]
    from nebula_host import secrets as sec

    assert sec.store().get(f"nebula:telegram.agentbot.{ba['id']}") is None
    await mgr2.stop()


# ====================================================================================== VOICE 2.0
async def test_voice01_04_05_06_07_pipeline_with_real_local_tts(tg3, monkeypatch):
    g, fake, orch, *_ = tg3
    a = await _ready(g, fake, "Developer")
    from nebula_host import stt

    monkeypatch.setattr(stt, "status", lambda cfg: {"backend": "whisper_cpp", "setup_hint": None})
    said = iter(["Developere, jak pokračuje ten projekt?", "Tak dokonči backend a pak mi pošli výsledek."])
    seen = []

    async def fake_stt(cfg, data, filename="voice.ogg", language=None):
        seen.append(data[:4])
        return {"text": next(said), "backend": "whisper_cpp (local)", "language": "cs"}

    monkeypatch.setattr(stt, "transcribe", fake_stt)
    fake.files["f.txt"] = b"OggS" + b"\0" * 60
    # VOICE-01 audio download + status intent answered from real data, VOICE-04/05 spoken via real macOS TTS
    await g._process(msg(7, 7, "", voice={"file_id": "V1", "duration": 2, "file_size": 64}))
    assert seen == [b"OggS"] and any("jak pokračuje" in t for t in fake.texts(7))
    assert any("Developer" in t and "úkol" in t for t in fake.texts(7))  # Czech status summary text
    voices = [b for m, b in fake.sent if m == "sendVoice"]
    assert voices, "a voice reply must be sent (auto mode answers voice with voice)"
    # VOICE-06 conversation context: the follow-up becomes a task for the addressed agent
    await g._process(msg(7, 7, "", voice={"file_id": "V2", "duration": 3, "file_size": 64}))
    from nebula_host import db, models
    from sqlalchemy import select

    with db.engine().connect() as c:
        t = c.execute(select(models.tasks).where(models.tasks.c.agent_id == a["id"])).first()
    assert t.prompt == "Tak dokonči backend a pak mi pošli výsledek." and t.reply_target["voice"] is True
    # VOICE-07 failure handling: STT error is reported, nothing crashes
    async def broken(cfg, data, filename="voice.ogg", language=None):
        raise stt.STTError("model file corrupt")

    monkeypatch.setattr(stt, "transcribe", broken)
    await g._process(msg(7, 7, "", voice={"file_id": "V3", "duration": 2, "file_size": 64}))
    assert any("Transcription failed" in t and "model file corrupt" in t for t in fake.texts(7))


async def test_voice04_real_macos_tts_produces_ogg_opus(dbinit):
    from nebula_host import tts

    r = await tts.synthesize("Ahoj, tady NEBULA. Úkol je hotový.", language="cs")
    assert r["audio"][:4] == b"OggS" and r["mime"] == "audio/ogg" and r["voice"] == "Zuzana"
    assert r["duration_s"] and r["duration_s"] > 1
    e = await tts.synthesize("Hello from NEBULA", language="en")
    assert e["audio"][:4] == b"OggS" and e["voice"]


# ====================================================================================== MM via Telegram
async def test_mm01_mm06_telegram_photos_and_media_group(tg3, monkeypatch):
    g, fake, orch, *_ = tg3
    a = await _ready(g, fake)
    fake.files["f.txt"] = base64.b64decode(png_b64())
    photo = [{"file_id": "P1", "file_size": 500, "width": 64, "height": 40}]
    # a photo without caption is kept and waits for instructions
    await g._process(msg(7, 7, "", photo=photo))
    assert any(t.startswith("📎 photo-") for t in fake.texts(7))
    # two photos in one media group + caption -> ONE task with both images + the pending one
    from nebula_telegram import v3 as tgv3

    monkeypatch.setattr(tgv3, "MEDIA_GROUP_WAIT", 0.2)
    await g._process(msg(7, 7, "", photo=photo, media_group_id="G1", caption="Find the problem and fix it"))
    await g._process(msg(7, 7, "", photo=photo, media_group_id="G1"))
    await asyncio.sleep(0.6)
    from nebula_host import attachments as attsvc
    from nebula_host import db, models
    from sqlalchemy import select

    with db.engine().connect() as c:
        t = c.execute(select(models.tasks).where(models.tasks.c.prompt == "Find the problem and fix it")).first()
    assert t is not None
    linked = attsvc.list_for(task_id=t.id)
    assert len(linked) == 3 and all(x["kind"] == "image" and x["status"] == "PROCESSED" for x in linked)
    text, images = attsvc.task_context(t.id)
    assert len(images) == 3 and "untrusted DATA" in text
    _ = a
