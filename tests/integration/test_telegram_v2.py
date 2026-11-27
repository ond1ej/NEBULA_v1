"""Telegram 2.0 against the fake Bot API: commands (TG-01), voice (TG-02), files up/down (TG-03), buttons (TG-04).

Uses the real gateway, orchestrator and V2 services with the fake guest; no network, no real STT/AI.
"""

from __future__ import annotations

import asyncio
import io
import time
import zipfile
from types import SimpleNamespace

import pytest

from tests.conftest import ScriptedProvider, call, done
from tests.integration.test_telegram import _bind, _pair, msg, tg  # noqa: F401


@pytest.fixture()
def tg2(tg, fake_guest):  # noqa: F811
    g, fake, orch, created = tg
    from nebula_host.files_service import FileBridge
    from nebula_host.schedules import Scheduler
    from nebula_host.teams import TeamManager
    from nebula_host.workflows import WorkflowEngine

    cfg = g.cfg
    files = FileBridge(cfg, fake_guest)
    teams = TeamManager(orch, fake_guest)
    sched = Scheduler(orch, teams)
    wf = WorkflowEngine(orch, teams, files, g.send_to_owners, sched)
    sched.workflows = wf
    g.v2 = SimpleNamespace(files=files, teams=teams, schedules=sched, workflows=wf)
    return g, fake, orch, created


async def _ready(g, fake):
    await _bind()
    p = await _pair(g, fake)
    await g.approve(p["pairing_id"], "user:owner")
    g.running = True  # notifications on, polling driven manually
    from nebula_host import agents_service

    a = await agents_service.create(g.guest, {"name": "Dev", "provider_id": "ollama-local", "model_id": "m",
                                              "permission_level": "ADVANCED"}, "user:owner")
    g._select(g._user(7, 7), a["id"])
    return a


def _sent(fake, method):
    return [b for m, b in fake.sent if m == method]


async def test_tg01_v2_commands_teams_schedules_history_files_model(tg2, monkeypatch):
    g, fake, orch, _ = tg2
    a = await _ready(g, fake)
    await g._process(msg(7, 7, "/help"))
    assert any("/team <name> <task>" in t for t in fake.texts(7))
    await g._process(msg(7, 7, "/teams"))
    assert any("No teams yet" in t for t in fake.texts(7))
    team = await g.v2.teams.create({"name": "Web", "members": [{"agent_id": a["id"], "role": "Developer"}]}, "u")
    await g._process(msg(7, 7, "/teams"))
    assert any("Web (sequential): Developer·Dev" in t for t in fake.texts(7))
    from nebula_host import providers_service

    monkeypatch.setattr(providers_service, "adapter_for", lambda pid: ScriptedProvider([]))
    orch.cfg.agents.max_steps_per_task = 3
    await g._process(msg(7, 7, "/team Web build a landing page"))
    assert any("Team Web started run" in t for t in fake.texts(7))
    assert g.v2.teams.list_runs(team["id"])[0]["source"] == "telegram"
    s = g.v2.schedules.create({"name": "Morning brief", "target_type": "agent", "target_id": a["id"], "prompt": "brief",
                               "kind": "daily", "spec": {"time": "07:30"}, "timezone": "Europe/Prague"}, "u")
    await g._process(msg(7, 7, "/schedules"))
    sched_msg = [b for b in _sent(fake, "sendMessage") if "Morning brief" in b.get("text", "")][-1]
    assert sched_msg["reply_markup"]["inline_keyboard"][0][0]["callback_data"] == f"sch:{s['id']}"
    await g._process(msg(7, 7, "/history"))
    assert any("Recent tasks:" in t for t in fake.texts(7))
    await g.v2.files.op(f"agent:{a['id']}", "write", path="report.txt", data_b64="cmVwb3J0")
    await g._process(msg(7, 7, "/files"))
    assert any("report.txt" in t for t in fake.texts(7))
    await g._process(msg(7, 7, "/model"))
    assert any("ollama-local / m" in t for t in fake.texts(7))
    await g._process(msg(7, 7, "/model m"))
    assert any("Model changed to m" in t for t in fake.texts(7))
    await g._process(msg(7, 7, "/wf report something"))
    assert any("No enabled workflow listens to /wf report" in t for t in fake.texts(7))


async def test_tg02_voice_local_transcription_and_refusal(tg2, monkeypatch):
    g, fake, orch, _ = tg2
    a = await _ready(g, fake)
    from nebula_host import stt

    # 1) nothing configured: refused, nothing uploaded anywhere
    monkeypatch.setattr(stt, "status", lambda cfg: {"backend": None, "setup_hint": "install whisper.cpp"})
    await g._process(msg(7, 7, "", voice={"file_id": "V1", "duration": 3, "file_size": 1000}))
    assert any("not set up" in t and "nothing was sent" in t for t in fake.texts(7))
    assert not any(m == "getFile" for m, _ in fake.sent)
    # 2) local backend: transcript becomes a task
    monkeypatch.setattr(stt, "status", lambda cfg: {"backend": "whisper_cpp", "setup_hint": None})

    fake.files["f.txt"] = b"OggS" + b"\x00" * 60  # downloaded voice note (content-checked in V3)

    async def fake_transcribe(cfg, data, filename="voice.ogg", language=None):
        assert data.startswith(b"OggS")  # the downloaded voice note
        return {"text": "Otevři example.com a ulož nadpis", "backend": "whisper_cpp (local)", "model": "ggml-base.bin"}

    monkeypatch.setattr(stt, "transcribe", fake_transcribe)
    await g._process(msg(7, 7, "", voice={"file_id": "V2", "duration": 3, "file_size": 1000}))
    from nebula_host import db, models
    from sqlalchemy import select

    with db.engine().connect() as c:
        t = c.execute(select(models.tasks).where(models.tasks.c.agent_id == a["id"])).first()
    assert t.prompt == "Otevři example.com a ulož nadpis" and t.source_channel == "telegram"
    assert any("whisper_cpp (local)" in x for x in fake.texts(7))
    # 3) too long voice notes are refused before downloading
    await g._process(msg(7, 7, "", voice={"file_id": "V3", "duration": 3600, "file_size": 1000}))
    assert any("too long" in x for x in fake.texts(7))


async def test_tg03_zip_upload_extracts_safely_and_result_download(tg2, fake_guest):
    g, fake, orch, _ = tg2
    a = await _ready(g, fake)
    good = io.BytesIO()
    with zipfile.ZipFile(good, "w") as z:
        z.writestr("src/app.py", "print('hi')")
        z.writestr("README.md", "# demo")
    fake.files["f.txt"] = good.getvalue()
    await g._process(msg(7, 7, "", document={"file_id": "Z", "file_name": "project.zip", "mime_type": "application/zip",
                                              "file_size": len(good.getvalue())}))
    assert any("Extracted 2 file(s)" in t for t in fake.texts(7))
    lst = await g.v2.files.op(f"agent:{a['id']}", "list", path="inbox/project/src")
    assert [e["name"] for e in lst["entries"]] == ["app.py"]
    evil = io.BytesIO()
    with zipfile.ZipFile(evil, "w") as z:
        z.writestr("../../escape.txt", "x")
    fake.files["f.txt"] = evil.getvalue()
    await g._process(msg(7, 7, "", document={"file_id": "Z2", "file_name": "evil.zip", "mime_type": "application/zip",
                                              "file_size": 100}))
    assert any("not extracted" in t and "unsafe entry" in t for t in fake.texts(7))
    assert not (fake_guest.fs_base / "escape.txt").exists()
    # result download button: completed task with a verified file artifact
    await g.v2.files.op(f"agent:{a['id']}", "write", path="out/result.csv", data_b64="YSxiCjEsMgo=")
    tid = orch.enqueue(a["id"], "make csv", source="telegram", reply_target={"chat_id": 7})["id"]
    from nebula_runtime.orchestrator import finish

    finish(tid, "COMPLETED", result={"summary": "done", "verified_artifacts": [{"type": "file", "value": "out/result.csv"}]})
    await asyncio.sleep(0.2)
    btn = [b for b in _sent(fake, "sendMessage") if b.get("text") == "Download result files:"]
    assert btn and btn[-1]["reply_markup"]["inline_keyboard"][0][0]["callback_data"] == f"dl:{tid}:0"
    await g._process({"update_id": 990001, "callback_query": {"id": "cb1", "from": {"id": 7}, "data": f"dl:{tid}:0",
                                                               "message": {"chat": {"id": 7}, "message_id": 1}}})
    assert _sent(fake, "sendDocument")  # the CSV was sent back as a document
    await g._process(msg(7, 7, "/get out/result.csv"))
    assert len(_sent(fake, "sendDocument")) == 2


async def test_tg04_task_buttons_approvals_and_owner_approvals(tg2, monkeypatch):
    g, fake, orch, _ = tg2
    await _ready(g, fake)
    from nebula_host import approvals_v2, providers_service

    gate = asyncio.Event()
    monkeypatch.setattr(providers_service, "adapter_for", lambda pid: ScriptedProvider([], block=gate))
    await orch.start()
    try:
        await g._process(msg(7, 7, "Research NEBULA"))
        card = [b for b in _sent(fake, "sendMessage") if b.get("text", "").startswith("NEBULA — Dev")][-1]
        kb = card["reply_markup"]["inline_keyboard"]
        cbs = [c["callback_data"] for row in kb for c in row if "callback_data" in c]
        tid = cbs[0].split(":", 2)[2]
        assert {c[:4] for c in cbs} <= {"c:a:", "c:x:", "c:p:", "c:i:", "c:d:"} and f"c:x:{tid}" in cbs
        await g._process({"update_id": 990101, "callback_query": {"id": "q1", "from": {"id": 7},
                                                                   "data": f"c:x:{tid}",
                                                                   "message": {"chat": {"id": 7}, "message_id": 2}}})
        from nebula_runtime.orchestrator import get_task

        for _ in range(40):
            if get_task(tid)["state"] == "CANCELLED":
                break
            await asyncio.sleep(0.05)
        assert get_task(tid)["state"] == "CANCELLED"
        # unauthorised user pressing a button is refused
        await g._process({"update_id": 990102, "callback_query": {"id": "q2", "from": {"id": 666}, "data": f"c:x:{tid}",
                                                                   "message": {"chat": {"id": 666}, "message_id": 3}}})
        assert ("answerCallbackQuery", {"callback_query_id": "q2", "text": "Not authorized"}) in fake.sent
        # owner approval (workflow gate) through Telegram buttons
        aid = approvals_v2.request("workflow", {"run_id": "r", "node_id": "n"}, "Publish the report?")
        await asyncio.sleep(0.1)
        assert any("Publish the report?" in t for t in fake.texts(7))
        await g._process({"update_id": 990103, "callback_query": {"id": "q3", "from": {"id": 7}, "data": f"oa:{aid}:y",
                                                                   "message": {"chat": {"id": 7}, "message_id": 4}}})
        assert approvals_v2.get(aid)["decision"] == "approved"
        assert approvals_v2.get(aid)["resolved_by"] == "telegram:7"
    finally:
        gate.set()
        await orch.shutdown()


async def test_tg_rate_limit_and_dedup_still_apply(tg2):
    g, fake, *_ = tg2
    await _ready(g, fake)
    g.cfg.telegram.rate_limit_per_minute = 3
    for i in range(5):
        await g._process(msg(7, 7, "/history", update_id=880000 + i))
    assert any("Rate limit" in t for t in fake.texts(7))
    n = len(fake.sent)
    await g._process(msg(7, 7, "/history", update_id=880000))  # duplicate update id: ignored
    assert len(fake.sent) == n
    _ = (call, done, time)
