"""Conversations (V3.2): several chats per agent, each with its own message history and task context.

* Every agent has one default conversation (created on demand; migration 0006 created it for agents with history).
  Tasks created without a conversation (dashboard chat, Telegram, automation) land there, so nothing changes for
  older clients.
* Messages are created through ``post_message`` with a client-generated ``client_id``: a retry, a double tap or a
  reconnect returns the original message and task instead of creating a duplicate ((conversation_id, client_id) is
  unique in the database).
* The owner's read marker is per conversation (single-owner install); unread = agent replies after the marker.
"""

from __future__ import annotations

import time
import uuid
from typing import Any

from sqlalchemy import and_, func, or_, select, update
from sqlalchemy.exc import IntegrityError

from nebula_host import db, models
from nebula_host.events import bus

PREVIEW_CHARS = 200
TITLE_CHARS = 200
TERMINAL_STATES = ("COMPLETED", "FAILED", "CANCELLED")


class ConversationError(Exception):
    def __init__(self, code: str, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.code, self.status = code, status


def _agent_name(c, agent_id: str) -> str:
    return c.execute(select(models.agents.c.name).where(models.agents.c.id == agent_id)).scalar() or "Agent"


def default_for(agent_id: str, conn=None) -> str:
    """Id of the agent's default conversation (created on first use)."""
    def _do(c) -> str:
        cid = c.execute(select(models.conversations.c.id).where(and_(
            models.conversations.c.agent_id == agent_id, models.conversations.c.is_default.is_(True)))
            .order_by(models.conversations.c.created_at).limit(1)).scalar()
        if cid:
            return cid
        now = time.time()
        cid = str(uuid.uuid4())
        owner = c.execute(select(models.users.c.id).order_by(models.users.c.created_at).limit(1)).scalar()
        c.execute(models.conversations.insert().values(
            id=cid, agent_id=agent_id, owner_id=owner, title=_agent_name(c, agent_id)[:TITLE_CHARS], is_default=True,
            created_at=now, updated_at=now, last_read_at=now))
        return cid

    if conn is not None:
        return _do(conn)
    with db.engine().begin() as c:
        return _do(c)


def create(agent_id: str, title: str | None, owner_id: str | None) -> dict[str, Any]:
    now = time.time()
    cid = str(uuid.uuid4())
    with db.engine().begin() as c:
        if not c.execute(select(models.agents.c.id).where(models.agents.c.id == agent_id)).first():
            raise ConversationError("agent_not_found", "no such agent", 404)
        c.execute(models.conversations.insert().values(
            id=cid, agent_id=agent_id, owner_id=owner_id, title=(title or "New chat").strip()[:TITLE_CHARS] or
            "New chat", is_default=False, created_at=now, updated_at=now, last_read_at=now))
    return get(cid)


def _row(cid: str) -> dict[str, Any]:
    with db.engine().connect() as c:
        r = db.row(c.execute(select(models.conversations).where(models.conversations.c.id == cid)).first())
    if not r:
        raise ConversationError("conversation_not_found", "no such conversation", 404)
    return r


def _decorate(c, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not rows:
        return []
    ids = [r["id"] for r in rows]
    agents = {a.id: a for a in c.execute(select(models.agents.c.id, models.agents.c.name, models.agents.c.status)
                                         .where(models.agents.c.id.in_({r["agent_id"] for r in rows})))}
    # last message per conversation (one indexed lookup each; lists are capped at 200)
    last: dict[str, Any] = {}
    for cid in ids:
        m = c.execute(select(models.messages.c.role, models.messages.c.content, models.messages.c.created_at)
                      .where(models.messages.c.conversation_id == cid)
                      .order_by(models.messages.c.created_at.desc()).limit(1)).first()
        if m:
            last[cid] = m
    unread = dict(c.execute(
        select(models.messages.c.conversation_id, func.count()).select_from(
            models.messages.join(models.conversations, models.conversations.c.id == models.messages.c.conversation_id))
        .where(models.messages.c.conversation_id.in_(ids)).where(models.messages.c.role == "assistant")
        .where(models.messages.c.created_at > func.coalesce(models.conversations.c.last_read_at, 0))
        .group_by(models.messages.c.conversation_id)).all())
    running: dict[str, Any] = {}
    for t in c.execute(select(models.tasks.c.id, models.tasks.c.state, models.tasks.c.conversation_id)
                       .where(models.tasks.c.conversation_id.in_(ids)).where(models.tasks.c.state.notin_(TERMINAL_STATES))
                       .order_by(models.tasks.c.created_at)):
        running[t.conversation_id] = {"id": t.id, "state": t.state}
    out = []
    for r in rows:
        a = agents.get(r["agent_id"])
        m = last.get(r["id"])
        out.append({
            "id": r["id"], "agent_id": r["agent_id"], "agent_name": a.name if a else "Agent",
            "agent_status": a.status if a else "UNKNOWN", "title": r["title"], "created_at": r["created_at"],
            "updated_at": r["updated_at"], "last_message_at": r["last_message_at"],
            "last_message": {"role": m.role, "content": (m.content or "")[:PREVIEW_CHARS], "created_at": m.created_at}
            if m else None,
            "unread_count": int(unread.get(r["id"], 0)), "archived": r["archived_at"] is not None,
            "is_default": bool(r["is_default"]), "running_task": running.get(r["id"])})
    return out


def get(cid: str) -> dict[str, Any]:
    r = _row(cid)
    with db.engine().connect() as c:
        return _decorate(c, [r])[0]


def list_(agent_id: str | None = None, archived: bool = False, limit: int = 100) -> list[dict[str, Any]]:
    q = select(models.conversations)
    if agent_id:
        q = q.where(models.conversations.c.agent_id == agent_id)
    q = q.where(models.conversations.c.archived_at.isnot(None) if archived else models.conversations.c.archived_at.is_(None))
    q = q.order_by(func.coalesce(models.conversations.c.last_message_at, models.conversations.c.created_at).desc())
    with db.engine().connect() as c:
        rows = db.rows(c.execute(q.limit(max(1, min(limit, 200)))))
        return _decorate(c, rows)


def update_(cid: str, *, title: str | None = None, archived: bool | None = None) -> dict[str, Any]:
    _row(cid)
    vals: dict[str, Any] = {"updated_at": time.time()}
    if title is not None:
        t = title.strip()[:TITLE_CHARS]
        if not t:
            raise ConversationError("invalid_title", "title must not be empty")
        vals["title"] = t
    if archived is not None:
        vals["archived_at"] = time.time() if archived else None
    with db.engine().begin() as c:
        c.execute(update(models.conversations).where(models.conversations.c.id == cid).values(**vals))
    return get(cid)


def mark_read(cid: str) -> dict[str, Any]:
    _row(cid)
    with db.engine().begin() as c:
        c.execute(update(models.conversations).where(models.conversations.c.id == cid).values(last_read_at=time.time()))
    return {"unread_count": 0}


def _task_brief(c, task_ids: set[str]) -> dict[str, dict[str, Any]]:
    if not task_ids:
        return {}
    return {t.id: {"id": t.id, "state": t.state, "started_at": t.started_at, "finished_at": t.finished_at,
                   "failure_reason": (t.failure_reason or None) and t.failure_reason[:500]}
            for t in c.execute(select(models.tasks.c.id, models.tasks.c.state, models.tasks.c.started_at,
                                      models.tasks.c.finished_at, models.tasks.c.failure_reason)
                               .where(models.tasks.c.id.in_(task_ids)))}


def _public_message(m: dict[str, Any], tasks: dict[str, dict[str, Any]]) -> dict[str, Any]:
    return {"id": m["id"], "conversation_id": m["conversation_id"], "agent_id": m["agent_id"], "task_id": m["task_id"],
            "role": m["role"], "channel": m["channel"], "content": m["content"], "attachments": m["attachments"] or [],
            "created_at": m["created_at"], "client_id": m.get("client_id"),
            "task": tasks.get(m["task_id"]) if m["role"] == "user" and m["task_id"] else None}


def messages(cid: str, before: float | None = None, limit: int = 50) -> dict[str, Any]:
    _row(cid)
    limit = max(1, min(limit, 200))
    q = select(models.messages).where(models.messages.c.conversation_id == cid)
    if before is not None:
        q = q.where(models.messages.c.created_at < before)
    with db.engine().connect() as c:
        rows = db.rows(c.execute(q.order_by(models.messages.c.created_at.desc()).limit(limit + 1)))
        has_more = len(rows) > limit
        rows = list(reversed(rows[:limit]))
        tasks = _task_brief(c, {r["task_id"] for r in rows if r["task_id"] and r["role"] == "user"})
    return {"items": [_public_message(r, tasks) for r in rows], "has_more": has_more}


def message_by_client_id(cid: str, client_id: str) -> dict[str, Any] | None:
    with db.engine().connect() as c:
        m = db.row(c.execute(select(models.messages).where(and_(models.messages.c.conversation_id == cid,
                                                                models.messages.c.client_id == client_id))).first())
        if not m:
            return None
        tasks = _task_brief(c, {m["task_id"]} if m["task_id"] else set())
    return _public_message(m, tasks)


def post_message(orch, cid: str, content: str, client_id: str, attachment_ids: list[str] | None = None,
                 source: str = "web", max_model_calls: int | None = None
                 ) -> tuple[dict[str, Any], dict[str, Any] | None, bool]:
    """Create the owner's message + its task. Returns (message, task, replayed)."""
    conv = _row(cid)
    if conv["archived_at"] is not None:
        raise ConversationError("conversation_archived", "unarchive the conversation first", 409)
    existing = message_by_client_id(cid, client_id)
    if existing:
        return existing, _task(existing["task_id"]), True
    try:
        t = orch.enqueue(conv["agent_id"], content, source=source, attachment_ids=attachment_ids or None,
                         conversation_id=cid, client_id=client_id, max_model_calls=max_model_calls)
    except IntegrityError:  # a concurrent request with the same client_id won the race
        existing = message_by_client_id(cid, client_id)
        if existing:
            return existing, _task(existing["task_id"]), True
        raise
    m = message_by_client_id(cid, client_id)
    return m or {}, t, False


def _task(task_id: str | None) -> dict[str, Any] | None:
    if not task_id:
        return None
    from nebula_runtime.orchestrator import get_task

    try:
        return get_task(task_id)
    except KeyError:
        return None


def touch(conn, cid: str | None, ts: float) -> None:
    if cid:
        conn.execute(update(models.conversations).where(models.conversations.c.id == cid)
                     .values(last_message_at=ts, updated_at=ts))


def announce(cid: str | None, message_id: str, role: str, agent_id: str, task_id: str | None) -> None:
    if cid:
        bus.publish("conversation.message", {"conversation_id": cid, "message_id": message_id, "role": role},
                    agent_id=agent_id, task_id=task_id)


def search(q: str, limit: int = 30) -> dict[str, Any]:
    q = (q or "").strip()
    if len(q) < 2:
        return {"conversations": [], "messages": []}
    like = f"%{q.replace('%', '').replace('_', '')[:100]}%"
    limit = max(1, min(limit, 50))
    with db.engine().connect() as c:
        conv_rows = db.rows(c.execute(
            select(models.conversations).join(models.agents, models.agents.c.id == models.conversations.c.agent_id)
            .where(models.conversations.c.archived_at.is_(None))
            .where(or_(models.conversations.c.title.ilike(like), models.agents.c.name.ilike(like)))
            .order_by(func.coalesce(models.conversations.c.last_message_at, models.conversations.c.created_at).desc())
            .limit(limit)))
        convs = _decorate(c, conv_rows)
        hits = c.execute(
            select(models.messages.c.id, models.messages.c.conversation_id, models.messages.c.agent_id,
                   models.messages.c.role, models.messages.c.content, models.messages.c.created_at,
                   models.agents.c.name.label("agent_name"))
            .join(models.agents, models.agents.c.id == models.messages.c.agent_id)
            .where(models.messages.c.conversation_id.isnot(None))
            .where(models.messages.c.content.ilike(like))
            .order_by(models.messages.c.created_at.desc()).limit(limit)).all()
    msgs = []
    for h in hits:
        text = h.content or ""
        i = text.lower().find(q.lower())
        start = max(0, i - 60) if i >= 0 else 0
        snippet = ("…" if start else "") + text[start:start + 180] + ("…" if len(text) > start + 180 else "")
        msgs.append({"message_id": h.id, "conversation_id": h.conversation_id, "agent_id": h.agent_id,
                     "agent_name": h.agent_name, "role": h.role, "snippet": snippet, "created_at": h.created_at})
    return {"conversations": convs, "messages": msgs}
