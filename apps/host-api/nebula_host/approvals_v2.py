"""Owner approvals for automation (workflow Wait-for-Approval / approved commands, missed schedules, ...).

Task tool approvals stay in `approvals` (they belong to a running task); these are not tied to a task.
Resolution is dispatched to the registered handler of the approval's kind.
"""

from __future__ import annotations

import time
import uuid
from collections.abc import Awaitable, Callable
from typing import Any

from sqlalchemy import select, update

from nebula_host import db, models
from nebula_host.events import audit, bus

TTL_S = 24 * 3600
_handlers: dict[str, Callable[[dict[str, Any], str, str], Awaitable[None]]] = {}


def register(kind: str, fn: Callable[[dict[str, Any], str, str], Awaitable[None]]) -> None:
    _handlers[kind] = fn


def request(kind: str, ref: dict[str, Any], summary: str, preview: dict | None = None, ttl_s: float = TTL_S) -> str:
    aid = str(uuid.uuid4())
    now = time.time()
    with db.engine().begin() as c:
        c.execute(models.owner_approvals.insert().values(id=aid, kind=kind, ref=ref, summary=summary[:2000],
                                                         preview=preview, created_at=now, expires_at=now + ttl_s))
    bus.publish("owner.approval.requested", {"approval_id": aid, "kind": kind, "summary": summary[:500], "ref": ref,
                                             "expires_at": now + ttl_s})
    return aid


def get(approval_id: str) -> dict[str, Any]:
    with db.engine().connect() as c:
        r = db.row(c.execute(select(models.owner_approvals).where(models.owner_approvals.c.id == approval_id)).first())
    if not r:
        raise KeyError(approval_id)
    return r


# kinds whose approval runs something on the system (an approved command, a package or plugin install): resolving
# them remotely needs a fresh owner (admin!), not just an owner session
STEPUP_KINDS = frozenset({"command", "package_install", "plugin"})


def needs_stepup(a: dict[str, Any]) -> bool:
    return str(a.get("kind") or "") in STEPUP_KINDS


def pending() -> list[dict[str, Any]]:
    now = time.time()
    with db.engine().connect() as c:
        return db.rows(c.execute(select(models.owner_approvals).where(models.owner_approvals.c.decision.is_(None))
                                 .where(models.owner_approvals.c.expires_at > now)
                                 .order_by(models.owner_approvals.c.created_at)))


async def resolve(approval_id: str, decision: str, actor: str) -> dict[str, Any]:
    if decision not in ("approved", "denied"):
        raise ValueError("decision must be approved|denied")
    a = get(approval_id)
    if a["decision"]:
        return a
    if a["expires_at"] < time.time():
        decision = "expired"
    with db.engine().begin() as c:
        n = c.execute(update(models.owner_approvals).where(models.owner_approvals.c.id == approval_id)
                      .where(models.owner_approvals.c.decision.is_(None))
                      .values(decision=decision, resolved_by=actor, resolved_at=time.time())).rowcount
    if not n:
        return get(approval_id)
    audit(actor, f"owner_approval.{decision}", approval_id, {"kind": a["kind"]})
    bus.publish("owner.approval.resolved", {"approval_id": approval_id, "kind": a["kind"], "decision": decision,
                                            "by": actor, "ref": a["ref"]})
    fn = _handlers.get(a["kind"])
    if fn:
        await fn(a["ref"], decision, actor)
    return get(approval_id)


async def expire_old() -> int:
    now = time.time()
    with db.engine().connect() as c:
        ids = [r.id for r in c.execute(select(models.owner_approvals.c.id).where(
            models.owner_approvals.c.decision.is_(None)).where(models.owner_approvals.c.expires_at <= now))]
    for i in ids:
        await resolve(i, "denied", "system:ttl")
    return len(ids)
