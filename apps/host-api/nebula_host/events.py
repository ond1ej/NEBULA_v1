"""Persistent event bus (spec §10.3). Every event is written to SQLite first (sequence = PK),
then fanned out to live subscribers (Dashboard SSE, Telegram notifier)."""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable
from typing import Any

from sqlalchemy import select

from nebula_host import db, models

log = logging.getLogger("nebula.events")

EVENT_TYPES = {
    "agent.created", "agent.state.changed", "agent.deleted", "task.queued", "task.started", "task.step",
    "task.approval.requested", "task.approval.resolved", "task.paused", "task.resumed", "task.completed",
    "task.failed", "task.cancelled", "task.message", "vm.state.changed", "provider.quota", "provider.state.changed",
    "telegram.paired", "telegram.pairing.pending", "live.viewer.joined", "live.viewer.left", "live.control.changed",
    "install.progress", "system.health",
    # V2
    "team.run.started", "team.run.completed", "team.run.failed", "team.subtask.changed",
    "schedule.run.started", "schedule.run.finished", "workflow.run.started", "workflow.step", "workflow.run.finished",
    "owner.approval.requested", "owner.approval.resolved", "resource.alert", "file.created", "memory.changed",
    "skill.changed",
    # V3
    "company.created", "company.updated", "company.activity", "company.run.started", "company.run.finished",
    "company.item.changed", "environment.changed", "bot.state.changed", "attachment.processed",
    "remote.state.changed",
    # V3 perf: live execution stages and memory-pressure transitions
    "task.stage", "resource.pressure.changed",
    # V3.2: conversations and the Password Vault (metadata only — never a secret)
    "conversation.message", "vault.status.changed", "vault.access",
    # V3.2.1: Smart Authentication (state + metadata only — never a password, code, token or cookie)
    "auth.session.updated", "auth.request",
    # V4.0: paired native apps (metadata only)
    "app.device.changed",
}


# V4.0: live-only event types (see EventBus.publish_ephemeral)
EPHEMERAL_TYPES = {"task.output.delta"}


class EventBus:
    def __init__(self) -> None:
        self._subs: set[asyncio.Queue] = set()
        self._listeners: list[Callable[[dict[str, Any]], Any]] = []
        self._loop: asyncio.AbstractEventLoop | None = None

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=1000)
        self._subs.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self._subs.discard(q)

    def add_listener(self, fn: Callable[[dict[str, Any]], Any]) -> None:
        self._listeners.append(fn)

    def remove_listener(self, fn: Callable[[dict[str, Any]], Any]) -> None:
        if fn in self._listeners:
            self._listeners.remove(fn)

    def publish(self, type_: str, payload: dict[str, Any] | None = None, *, agent_id: str | None = None,
                task_id: str | None = None) -> dict[str, Any]:
        if type_ not in EVENT_TYPES:
            raise ValueError(f"unknown event type {type_}")
        ev_id = db.new_id()
        ts = db.now()
        with db.engine().begin() as c:
            res = c.execute(models.events.insert().values(id=ev_id, type=type_, agent_id=agent_id, task_id=task_id,
                                                          timestamp=ts, payload=payload or {}))
            seq = res.inserted_primary_key[0]
        ev = {"id": ev_id, "sequence": seq, "type": type_, "agent_id": agent_id, "task_id": task_id,
              "timestamp": ts, "payload": payload or {}}
        self._fanout(ev)
        return ev

    def _fanout(self, ev: dict[str, Any]) -> None:
        def deliver() -> None:
            for q in list(self._subs):
                try:
                    q.put_nowait(ev)
                except asyncio.QueueFull:
                    log.warning("dropping slow SSE subscriber")
                    self._subs.discard(q)
            for fn in self._listeners:
                try:
                    r = fn(ev)
                    if asyncio.iscoroutine(r):
                        asyncio.ensure_future(r)
                except Exception:
                    log.exception("event listener failed")

        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if running is not None and running is self._loop:
            deliver()
        elif self._loop is not None and not self._loop.is_closed():
            self._loop.call_soon_threadsafe(deliver)

    def publish_ephemeral(self, type_: str, payload: dict[str, Any], *, agent_id: str | None = None,
                          task_id: str | None = None) -> None:
        """V4.0: live-only events (streamed model text). Never written to the database, never replayed, no sequence
        (so they never move a client's resume point) and not delivered to listeners such as the Telegram notifier."""
        if type_ not in EPHEMERAL_TYPES:
            raise ValueError(f"unknown ephemeral event type {type_}")
        if not self._subs:
            return
        ev = {"id": None, "sequence": None, "type": type_, "agent_id": agent_id, "task_id": task_id,
              "timestamp": time.time(), "payload": payload}

        def deliver() -> None:
            for q in list(self._subs):
                try:
                    q.put_nowait(ev)
                except asyncio.QueueFull:
                    pass  # a slow client only misses live text; the final message arrives as a normal event

        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if running is not None and running is self._loop:
            deliver()
        elif self._loop is not None and not self._loop.is_closed():
            self._loop.call_soon_threadsafe(deliver)

    def since(self, sequence: int, limit: int = 500) -> list[dict[str, Any]]:
        with db.engine().connect() as c:
            rs = c.execute(select(models.events).where(models.events.c.sequence > sequence)
                           .order_by(models.events.c.sequence).limit(limit))
            return db.rows(rs)


bus = EventBus()


def audit(actor: str, action: str, target: str | None = None, metadata: dict | None = None) -> None:
    from nebula_host.errors import request_id_var
    from nebula_host.secrets import redact_obj

    with db.engine().begin() as c:
        c.execute(models.audit_events.insert().values(ts=db.now(), actor=actor, action=action, target=target,
                                                      metadata=redact_obj(metadata or {}),
                                                      request_id=request_id_var.get() or None))


# Retention (perf audit 2026-11-16): the event log was never pruned. Live stage events only matter while a task runs;
# notification types stay long enough for the notification center; everything else is kept 30 days.
STAGE_RETENTION_S = 2 * 86400
EVENT_RETENTION_S = 30 * 86400
NOTIFY_RETENTION_S = 180 * 86400


def purge_old_events(notify_types: tuple[str, ...], now: float | None = None) -> int:
    from sqlalchemy import and_, delete

    now = now or time.time()
    ev = models.events
    with db.engine().begin() as c:
        n = c.execute(delete(ev).where(and_(ev.c.type == "task.stage", ev.c.timestamp < now - STAGE_RETENTION_S))).rowcount
        n += c.execute(delete(ev).where(and_(ev.c.type.notin_(notify_types),
                                             ev.c.timestamp < now - EVENT_RETENTION_S))).rowcount
        n += c.execute(delete(ev).where(ev.c.timestamp < now - NOTIFY_RETENTION_S)).rowcount
    return n

