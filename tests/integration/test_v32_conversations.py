# ruff: noqa: F811 - fixtures are imported from other test modules and injected by pytest
"""V3.2 conversations: several chats per agent, idempotent message submission, history scoping, unread state,
search, compatibility with the per-agent endpoints, and access through the Mini App gateway."""

from __future__ import annotations

import asyncio
import uuid

from tests.conftest import ScriptedProvider
from tests.integration.test_api import _agent, _setup_admin, _use_provider, _wait, client  # noqa: F401
from tests.integration.test_v3_api import _pair_owner, gateway  # noqa: F401
from tests.unit.test_v3_units import BOT_TOKEN, make_init_data


def _cid() -> str:
    return uuid.uuid4().hex


def test_default_conversation_and_legacy_task_endpoint(client, monkeypatch):
    h = _setup_admin(client)
    a = _agent(client, h)
    _use_provider(monkeypatch, ScriptedProvider([]))
    conv = client.get(f"/api/v1/agents/{a['id']}/conversation").json()["data"]
    assert conv["is_default"] and conv["agent_id"] == a["id"] and conv["title"] == a["name"]
    # the old per-agent endpoint lands in the default conversation (dashboard chat, Telegram keep working)
    t = client.post(f"/api/v1/agents/{a['id']}/tasks", json={"prompt": "hello"}, headers=h).json()["data"]
    _wait(client, t["id"], {"COMPLETED", "FAILED"})
    msgs = client.get(f"/api/v1/conversations/{conv['id']}/messages").json()["data"]
    assert [m["content"] for m in msgs["items"]][0] == "hello" and msgs["items"][0]["task"]["id"] == t["id"]
    assert client.get(f"/api/v1/agents/{a['id']}/messages").json()["data"][0]["conversation_id"] == conv["id"]
    assert client.get(f"/api/v1/agents/{a['id']}/conversation").json()["data"]["id"] == conv["id"]  # stable


def test_message_submission_is_idempotent_and_creates_one_task(client, monkeypatch):
    h = _setup_admin(client)
    a = _agent(client, h)
    gate = asyncio.Event()
    _use_provider(monkeypatch, ScriptedProvider([], block=gate))
    conv = client.post("/api/v1/conversations", json={"agent_id": a["id"], "title": "Research"}, headers=h).json()["data"]
    assert not conv["is_default"] and conv["title"] == "Research"
    cid = _cid()
    r1 = client.post(f"/api/v1/conversations/{conv['id']}/messages", json={"content": "find X", "client_id": cid},
                     headers=h)
    r2 = client.post(f"/api/v1/conversations/{conv['id']}/messages", json={"content": "find X", "client_id": cid},
                     headers=h)
    assert r1.status_code == 201 and r2.status_code == 200 and r2.headers.get("idempotent-replay") == "true"
    assert r1.json()["data"]["message"]["id"] == r2.json()["data"]["message"]["id"]
    assert r1.json()["data"]["task"]["id"] == r2.json()["data"]["task"]["id"]
    tasks = client.get(f"/api/v1/agents/{a['id']}/tasks").json()["data"]
    assert len(tasks) == 1 and tasks[0]["conversation_id"] == conv["id"]
    items = client.get(f"/api/v1/conversations/{conv['id']}/messages").json()["data"]["items"]
    assert len(items) == 1 and items[0]["client_id"] == cid
    listed = client.get(f"/api/v1/conversations?agent_id={a['id']}").json()["data"]
    mine = next(c for c in listed if c["id"] == conv["id"])
    assert mine["running_task"]["id"] == tasks[0]["id"] and mine["last_message"]["content"] == "find X"
    client.post(f"/api/v1/tasks/{tasks[0]['id']}/stop", json={"mode": "cancel"}, headers=h)
    gate.set()


def test_history_context_is_scoped_to_the_conversation(client, monkeypatch):
    h = _setup_admin(client)
    a = _agent(client, h)
    prov = ScriptedProvider([])
    _use_provider(monkeypatch, prov)
    c1 = client.post("/api/v1/conversations", json={"agent_id": a["id"], "title": "A"}, headers=h).json()["data"]
    c2 = client.post("/api/v1/conversations", json={"agent_id": a["id"], "title": "B"}, headers=h).json()["data"]
    t1 = client.post(f"/api/v1/conversations/{c1['id']}/messages", json={"content": "SECRET-TOPIC-ALPHA",
                                                                        "client_id": _cid()}, headers=h).json()["data"]
    _wait(client, t1["task"]["id"], {"COMPLETED", "FAILED"})
    t2 = client.post(f"/api/v1/conversations/{c2['id']}/messages", json={"content": "unrelated question",
                                                                        "client_id": _cid()}, headers=h).json()["data"]
    _wait(client, t2["task"]["id"], {"COMPLETED", "FAILED"})
    first_prompt_of_t2 = prov.requests[-1].messages[0].content
    # the chat-history section comes only from the same conversation (the agent's long-term memory stays agent-wide,
    # as before — that is a separate, labelled section)
    assert "Recent conversation with the owner" not in first_prompt_of_t2
    t3 = client.post(f"/api/v1/conversations/{c1['id']}/messages", json={"content": "follow up",
                                                                        "client_id": _cid()}, headers=h).json()["data"]
    _wait(client, t3["task"]["id"], {"COMPLETED", "FAILED"})
    p3 = prov.requests[-1].messages[0].content
    section = p3.split("Recent conversation with the owner", 1)[1].split("\n\n", 1)[0]
    assert "SECRET-TOPIC-ALPHA" in section  # the same conversation keeps its context


def test_unread_paging_archive_search_and_validation(client, monkeypatch):
    h = _setup_admin(client)
    a = _agent(client, h, name="Researcher")
    _use_provider(monkeypatch, ScriptedProvider([]))
    conv = client.post("/api/v1/conversations", json={"agent_id": a["id"]}, headers=h).json()["data"]
    for i in range(3):
        r = client.post(f"/api/v1/conversations/{conv['id']}/messages",
                        json={"content": f"question number {i} about quasars", "client_id": _cid()}, headers=h)
        _wait(client, r.json()["data"]["task"]["id"], {"COMPLETED", "FAILED"})
    got = client.get(f"/api/v1/conversations/{conv['id']}").json()["data"]
    assert got["unread_count"] >= 1  # agent replies after the read marker
    assert client.post(f"/api/v1/conversations/{conv['id']}/read", headers=h).json()["data"] == {"unread_count": 0}
    assert client.get(f"/api/v1/conversations/{conv['id']}").json()["data"]["unread_count"] == 0
    page1 = client.get(f"/api/v1/conversations/{conv['id']}/messages?limit=2").json()["data"]
    assert page1["has_more"] and len(page1["items"]) == 2
    older = client.get(f"/api/v1/conversations/{conv['id']}/messages?limit=50&before={page1['items'][0]['created_at']}"
                       ).json()["data"]
    assert all(m["created_at"] < page1["items"][0]["created_at"] for m in older["items"]) and older["items"]
    s = client.get("/api/v1/conversations/search?q=quasars").json()["data"]
    assert s["messages"] and all(m["conversation_id"] == conv["id"] for m in s["messages"])
    assert any(c["id"] == conv["id"] for c in client.get("/api/v1/conversations/search?q=researcher").json()["data"]
               ["conversations"])
    client.patch(f"/api/v1/conversations/{conv['id']}", json={"archived": True, "title": "Space"}, headers=h)
    assert conv["id"] not in [c["id"] for c in client.get("/api/v1/conversations").json()["data"]]
    assert conv["id"] in [c["id"] for c in client.get("/api/v1/conversations?archived=true").json()["data"]]
    r = client.post(f"/api/v1/conversations/{conv['id']}/messages", json={"content": "x", "client_id": _cid()},
                    headers=h)
    assert r.status_code == 409 and r.json()["error"]["code"] == "conversation_archived"
    bad = client.post(f"/api/v1/conversations/{conv['id']}/messages", json={"content": "x", "client_id": "a b"},
                      headers=h)
    assert bad.status_code == 422
    assert client.get("/api/v1/conversations/nope").status_code == 404
    assert client.post("/api/v1/conversations", json={"agent_id": "nope"}, headers=h).status_code == 404


def test_conversation_events_and_agent_deletion_cascade(client, monkeypatch):
    h = _setup_admin(client)
    a = _agent(client, h)
    _use_provider(monkeypatch, ScriptedProvider([]))
    conv = client.get(f"/api/v1/agents/{a['id']}/conversation").json()["data"]
    r = client.post(f"/api/v1/conversations/{conv['id']}/messages", json={"content": "hi", "client_id": _cid()},
                    headers=h).json()["data"]
    _wait(client, r["task"]["id"], {"COMPLETED", "FAILED"})
    from nebula_host import db, models
    from sqlalchemy import select

    with db.engine().connect() as c:
        evs = [e.payload for e in c.execute(select(models.events.c.payload)
                                            .where(models.events.c.type == "conversation.message"))]
    assert {e["role"] for e in evs} >= {"user"} and all(e["conversation_id"] == conv["id"] for e in evs)
    assert client.delete(f"/api/v1/agents/{a['id']}?confirm=true", headers=h).status_code in (200, 202)
    _wait_gone = [x for x in range(100)]
    for _ in _wait_gone:
        with db.engine().connect() as c:
            if not c.execute(select(models.conversations).where(models.conversations.c.agent_id == a["id"])).first():
                break
        __import__("time").sleep(0.05)
    with db.engine().connect() as c:
        assert not c.execute(select(models.conversations).where(models.conversations.c.agent_id == a["id"])).first()


def test_conversations_through_the_mini_app_gateway(client, gateway, monkeypatch):
    h = _setup_admin(client)
    a = _agent(client, h)
    _pair_owner(7)
    gate = asyncio.Event()
    _use_provider(monkeypatch, ScriptedProvider([], block=gate))
    tok = gateway.post("/api/mini/auth", json={"init_data": make_init_data(BOT_TOKEN)}).json()["data"]["token"]
    auth = {"authorization": f"Bearer {tok}"}
    conv = gateway.get(f"/api/v1/agents/{a['id']}/conversation", headers=auth).json()["data"]
    cid = _cid()
    r = gateway.post(f"/api/v1/conversations/{conv['id']}/messages", json={"content": "from phone", "client_id": cid},
                     headers={**auth, "Idempotency-Key": cid})
    assert r.status_code == 201, r.text
    again = gateway.post(f"/api/v1/conversations/{conv['id']}/messages", json={"content": "from phone",
                                                                              "client_id": cid}, headers=auth)
    assert again.status_code == 200 and again.json()["data"]["message"]["id"] == r.json()["data"]["message"]["id"]
    lst = gateway.get("/api/v1/conversations", headers=auth).json()["data"]
    assert lst[0]["id"] == conv["id"] and lst[0]["last_message"]["content"] == "from phone"
    assert gateway.get(f"/api/v1/conversations/{conv['id']}/messages", headers=auth).status_code == 200
    assert gateway.post(f"/api/v1/conversations/{conv['id']}/read", headers=auth).status_code == 200
    client.post(f"/api/v1/tasks/{r.json()['data']['task']['id']}/stop", json={"mode": "cancel"}, headers=h)
    gate.set()


def test_owner_message_keeps_attachment_references_and_voice_webm_is_audio(client, monkeypatch):
    h = _setup_admin(client)
    a = _agent(client, h)
    gate = asyncio.Event()
    _use_provider(monkeypatch, ScriptedProvider([], block=gate))
    png = __import__("base64").b64decode(__import__("tests.conftest", fromlist=["png_b64"]).png_b64())
    att = client.post(f"/api/v1/agents/{a['id']}/attachments", files={"file": ("photo.png", png, "image/png")},
                      headers=h).json()["data"]
    conv = client.get(f"/api/v1/agents/{a['id']}/conversation").json()["data"]
    r = client.post(f"/api/v1/conversations/{conv['id']}/messages", json={
        "content": "Attached: photo.png", "client_id": _cid(), "attachment_ids": [att["id"]]}, headers=h)
    assert r.status_code == 201, r.text
    items = client.get(f"/api/v1/conversations/{conv['id']}/messages").json()["data"]["items"]
    ref = items[-1]["attachments"][0]
    assert ref["id"] == att["id"] and ref["name"] == "photo.png" and ref["kind"] == "image" and "storage" not in ref
    client.post(f"/api/v1/tasks/{r.json()['data']['task']['id']}/stop", json={"mode": "cancel"}, headers=h)
    gate.set()
    # audio-only WebM from MediaRecorder: classified as audio (speech-to-text path), not video
    from nebula_host import attachments as attsvc
    from nebula_host.state import svc

    webm = bytes.fromhex("1a45dfa3") + b"\x9f\x42\x86\x81\x01" + b"webm" + b"\x00" * 64
    got = attsvc.intake(svc.cfg, webm, "voice.webm", "audio/webm", source="web", agent_id=a["id"], kind_hint="voice")
    assert got["kind"] == "voice" and got["mime"] == "audio/webm"
