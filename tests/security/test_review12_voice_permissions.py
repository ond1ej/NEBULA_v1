# ruff: noqa: F811 - fixtures are imported from other test modules and injected by pytest
"""Review 12, R12-2: a voice note on the main bot is checked once, by what was said (access.VOICE_INTENTS), not by the
blanket `tasks` check every plain message gets. An operator with only `commands` can ask a status question by voice
(docs/telegram.md, docs/features/voice.md) but cannot start a task by voice; typed text and files still need `tasks`.
Fake Bot API, fake speech-to-text and a recorded voice reply, no network."""

from __future__ import annotations

import pytest

from tests.integration.test_api import _setup_admin, client  # noqa: F401
from tests.integration.test_telegram import msg, tg  # noqa: F401
from tests.integration.test_telegram_v3 import tg3  # noqa: F401
from tests.security.test_fixround2_telegram import _owner_and_operator

pytestmark = pytest.mark.asyncio

TASKS_REFUSAL = "You don't have the tasks permission"
COMMANDS_REFUSAL = "You don't have the commands permission"


async def _setup(tg3, monkeypatch, fake_guest, permissions):
    g, fake, orch, *_ = tg3
    from nebula_host import stt
    from nebula_telegram import v3

    a = await _owner_and_operator(g, fake, fake_guest, op_permissions=permissions)
    g._select(g._user(8, 8), a["id"])
    spoken: list[str] = []
    voice_replies: list[str] = []

    async def fake_stt(cfg, data, filename="voice.ogg", language=None):
        return {"text": spoken.pop(0), "backend": "fake (local)", "language": "en"}

    async def fake_reply_voice(ctx, agent_id, text, chat_id, thread_id, lang, *, input_was_voice):
        voice_replies.append(text)

    monkeypatch.setattr(stt, "status", lambda cfg: {"backend": "fake", "setup_hint": None})
    monkeypatch.setattr(stt, "transcribe", fake_stt)
    monkeypatch.setattr(v3, "reply_voice", fake_reply_voice)
    fake.files["f.txt"] = b"OggS" + b"\0" * 60
    return g, fake, orch, a, spoken, voice_replies


def _tasks(agent_id: str) -> list:
    from nebula_host import db, models
    from sqlalchemy import select

    with db.engine().connect() as c:
        return c.execute(select(models.tasks).where(models.tasks.c.agent_id == agent_id)).fetchall()


async def _voice(g, uid: int, n: int = 1, key: str = "voice"):
    await g._process(msg(uid, uid, "", **{key: {"file_id": f"V{n}", "duration": 2, "file_size": 64}}))


async def test_commands_only_operator_can_ask_a_status_question_by_voice(tg3, fake_guest, monkeypatch):
    g, fake, orch, a, spoken, replies = await _setup(tg3, monkeypatch, fake_guest, ["commands"])
    spoken.append("What's the status of the project?")
    await _voice(g, 8)
    assert TASKS_REFUSAL not in " ".join(fake.texts(8)), fake.texts(8)
    assert replies and a["name"] in replies[0], replies  # the status summary was spoken back
    assert _tasks(a["id"]) == []


async def test_commands_only_operator_cannot_create_a_task_by_voice(tg3, fake_guest, monkeypatch):
    g, fake, orch, a, spoken, replies = await _setup(tg3, monkeypatch, fake_guest, ["commands"])
    spoken.append("Please write the quarterly report and email it to the team.")
    await _voice(g, 8)
    assert any(TASKS_REFUSAL in t for t in fake.texts(8)), fake.texts(8)
    assert _tasks(a["id"]) == [] and replies == []


async def test_voice_commands_map_to_the_permission_of_the_typed_command(tg3, fake_guest, monkeypatch):
    g, fake, orch, a, spoken, replies = await _setup(tg3, monkeypatch, fake_guest, ["tasks"])
    spoken.append("pause")  # typed /pause needs commands; so does the spoken one
    await _voice(g, 8, 1)
    assert any(COMMANDS_REFUSAL in t for t in fake.texts(8)), fake.texts(8)
    # a tasks operator still creates tasks by voice
    spoken.append("Please write the quarterly report and email it to the team.")
    await _voice(g, 8, 2)
    assert len(_tasks(a["id"])) == 1


async def test_voice_note_of_an_operator_without_any_permission_still_gets_status_only(tg3, fake_guest, monkeypatch):
    g, fake, orch, a, spoken, replies = await _setup(tg3, monkeypatch, fake_guest, [])
    spoken.append("How is the project going?")
    await _voice(g, 8, 1)
    assert replies, fake.texts(8)
    spoken.append("Build me a website.")
    await _voice(g, 8, 2)
    assert any(TASKS_REFUSAL in t for t in fake.texts(8)) and _tasks(a["id"]) == []


async def test_typed_text_and_audio_files_still_need_tasks(tg3, fake_guest, monkeypatch):
    g, fake, orch, a, spoken, replies = await _setup(tg3, monkeypatch, fake_guest, ["commands"])
    await g._process(msg(8, 8, "write the quarterly report"))
    assert any(TASKS_REFUSAL in t for t in fake.texts(8)), fake.texts(8)
    fake.sent.clear()
    # an audio FILE (not a voice note) with a caption becomes a task without any intent check: tasks is required
    await g._process(msg(8, 8, "", audio={"file_id": "A1", "file_size": 64, "file_name": "x.mp3"},
                         caption="summarize this"))
    assert any(TASKS_REFUSAL in t for t in fake.texts(8)), fake.texts(8)
    assert _tasks(a["id"]) == []
