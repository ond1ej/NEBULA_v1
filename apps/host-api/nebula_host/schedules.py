"""Persistent scheduler on the Mac host (V2 module 3).

Schedules live in SQLite and survive restarts. Each fire claims a unique (schedule_id, scheduled_for, attempt)
row, so a slot can never run twice (even with concurrent loops or after a crash). Missed fires (host asleep/off)
follow the schedule's misfire policy: skip | run_once | ask (owner confirms via dashboard/Telegram). Overlap
policy skips a fire while the previous run is still active (or queues it). Retries are bounded; every run has a
hard model-request budget (task max_steps) and a maximum runtime (task deadline).
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from typing import Any

from sqlalchemy import and_, select, update
from sqlalchemy.exc import IntegrityError

from nebula_host import cron, db, models
from nebula_host.events import audit, bus

log = logging.getLogger("nebula.schedules")
GRACE_S = 300  # a fire this late still counts as on time
TICK_S = 15
ACTIVE = ("RUNNING",)


class ScheduleError(ValueError):
    pass


def _now() -> float:
    return time.time()


def validate(body: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    name = str(body.get("name") or "").strip()
    if not 1 <= len(name) <= 128:
        raise ScheduleError("name is required")
    out["name"] = name
    tt = body.get("target_type")
    if tt not in ("agent", "team", "workflow"):
        raise ScheduleError("target_type must be agent, team or workflow")
    out["target_type"] = tt
    tid = str(body.get("target_id") or "")
    table = {"agent": models.agents, "team": models.teams, "workflow": models.workflows}[tt]
    with db.engine().connect() as c:
        if not c.execute(select(table.c.id).where(table.c.id == tid)).first():
            raise ScheduleError(f"unknown {tt} {tid}")
    out["target_id"] = tid
    out["prompt"] = str(body.get("prompt") or "")[:20000]
    if tt != "workflow" and not out["prompt"].strip():
        raise ScheduleError("prompt is required for agent and team schedules")
    kind = body.get("kind")
    spec = body.get("spec") or {}
    tzname = str(body.get("timezone") or "UTC")
    try:
        cron.tz(tzname)
        nxt = cron.next_run(str(kind), spec, tzname, _now(), created_ts=_now())
    except cron.CronError as e:
        raise ScheduleError(str(e)) from e
    if kind == "once" and nxt is None:
        raise ScheduleError("the one-time date is in the past")
    out.update(kind=kind, spec=spec, timezone=tzname)
    for k, allowed in (("misfire_policy", ("skip", "run_once", "ask")), ("overlap_policy", ("skip", "queue"))):
        v = body.get(k)
        if v is not None:
            if v not in allowed:
                raise ScheduleError(f"{k} must be one of {', '.join(allowed)}")
            out[k] = v
    for k, lo, hi in (("retry_max", 0, 5), ("retry_delay_s", 30, 86400), ("max_runtime_s", 60, 6 * 3600),
                      ("max_model_calls", 1, 100)):
        if body.get(k) is not None:
            out[k] = max(lo, min(int(body[k]), hi))
    if body.get("notify") is not None:
        out["notify"] = {"telegram": bool((body.get("notify") or {}).get("telegram"))}
    if body.get("enabled") is not None:
        out["enabled"] = bool(body["enabled"])
    return out


def get(schedule_id: str) -> dict[str, Any]:
    with db.engine().connect() as c:
        r = db.row(c.execute(select(models.schedules).where(models.schedules.c.id == schedule_id)).first())
    if not r:
        raise KeyError(schedule_id)
    return r


def list_all() -> list[dict[str, Any]]:
    with db.engine().connect() as c:
        rows = db.rows(c.execute(select(models.schedules).order_by(models.schedules.c.next_run_at)))
        for r in rows:
            r["last_run"] = db.row(c.execute(select(models.schedule_runs).where(
                models.schedule_runs.c.schedule_id == r["id"]).order_by(models.schedule_runs.c.created_at.desc())
                .limit(1)).first())
            table = {"agent": models.agents, "team": models.teams, "workflow": models.workflows}[r["target_type"]]
            r["target_name"] = c.execute(select(table.c.name).where(table.c.id == r["target_id"])).scalar()
    return rows


def runs(schedule_id: str | None = None, limit: int = 100) -> list[dict[str, Any]]:
    with db.engine().connect() as c:
        q = select(models.schedule_runs, models.schedules.c.name.label("schedule_name")).join(
            models.schedules, models.schedules.c.id == models.schedule_runs.c.schedule_id)
        if schedule_id:
            q = q.where(models.schedule_runs.c.schedule_id == schedule_id)
        return db.rows(c.execute(q.order_by(models.schedule_runs.c.created_at.desc()).limit(min(limit, 500))))


class Scheduler:
    def __init__(self, orch, teams=None, workflows=None) -> None:
        self.orch = orch
        self.teams = teams
        self.workflows = workflows
        self._task: asyncio.Task | None = None
        self._stopping = False
        self.wake = asyncio.Event()

    # ------------------------------------------------------------------ CRUD
    def create(self, body: dict[str, Any], actor: str) -> dict[str, Any]:
        v = validate(body)
        sid = str(uuid.uuid4())
        now = _now()
        nxt = cron.next_run(v["kind"], v["spec"], v["timezone"], now, created_ts=now)
        with db.engine().begin() as c:
            c.execute(models.schedules.insert().values(id=sid, **v, next_run_at=nxt, created_at=now, updated_at=now))
        audit(actor, "schedule.create", sid, {"name": v["name"], "kind": v["kind"]})
        self.wake.set()
        return get(sid)

    def update(self, schedule_id: str, body: dict[str, Any], actor: str) -> dict[str, Any]:
        cur = get(schedule_id)
        merged = {**{k: cur[k] for k in ("name", "target_type", "target_id", "prompt", "kind", "spec", "timezone",
                                         "misfire_policy", "overlap_policy", "retry_max", "retry_delay_s",
                                         "max_runtime_s", "max_model_calls", "notify", "enabled")},
                  **{k: v for k, v in body.items() if v is not None}}
        now = _now()
        if set(body) <= {"enabled"} and body.get("enabled") is False:  # pausing never needs re-validation
            with db.engine().begin() as c:
                c.execute(update(models.schedules).where(models.schedules.c.id == schedule_id)
                          .values(enabled=False, updated_at=now))
            audit(actor, "schedule.disable", schedule_id)
            return get(schedule_id)
        v = validate(merged)
        nxt = cron.next_run(v["kind"], v["spec"], v["timezone"], now, created_ts=cur["created_at"])
        with db.engine().begin() as c:
            c.execute(update(models.schedules).where(models.schedules.c.id == schedule_id)
                      .values(**v, next_run_at=nxt, updated_at=now))
        audit(actor, "schedule.update", schedule_id, {k: body[k] for k in body if k != "prompt"})
        self.wake.set()
        return get(schedule_id)

    def delete(self, schedule_id: str, actor: str) -> dict[str, Any]:
        get(schedule_id)
        from sqlalchemy import delete

        with db.engine().begin() as c:
            c.execute(delete(models.schedules).where(models.schedules.c.id == schedule_id))
        audit(actor, "schedule.delete", schedule_id)
        return {"deleted": schedule_id}

    # ------------------------------------------------------------------ loop
    async def start(self) -> None:
        await self.reconcile()
        self._task = asyncio.create_task(self._loop(), name="nebula-schedules")

    async def stop(self) -> None:
        self._stopping = True
        if self._task:
            self._task.cancel()

    async def _loop(self) -> None:
        while not self._stopping:
            try:
                await asyncio.wait_for(self.wake.wait(), TICK_S)
            except TimeoutError:
                pass
            self.wake.clear()
            try:
                await self.tick()
            except Exception:
                log.exception("scheduler tick failed")

    async def tick(self, now: float | None = None) -> list[str]:
        now = now or _now()
        fired = []
        with db.engine().connect() as c:
            due = db.rows(c.execute(select(models.schedules).where(and_(
                models.schedules.c.enabled.is_(True), models.schedules.c.next_run_at.is_not(None),
                models.schedules.c.next_run_at <= now))))
        for s in due:
            slot = s["next_run_at"]
            nxt = cron.next_run(s["kind"], s["spec"], s["timezone"], max(now, slot), created_ts=s["created_at"])
            with db.engine().begin() as c:  # claim: only the loop that moves next_run_at fires this slot
                n = c.execute(update(models.schedules).where(and_(models.schedules.c.id == s["id"],
                                                                  models.schedules.c.next_run_at == slot))
                              .values(next_run_at=nxt, last_run_at=now, updated_at=now,
                                      enabled=s["enabled"] if nxt is not None else False)).rowcount
            if not n:
                continue
            late = now - slot
            if late > GRACE_S:
                missed = self._missed_count(s, slot, now)
                if s["misfire_policy"] == "skip":
                    self._record(s, slot, "misfire", "SKIPPED", f"missed by {int(late)} s (host offline/asleep)")
                    continue
                if s["misfire_policy"] == "ask":
                    rid = self._record(s, slot, "misfire", "AWAITING_CONFIRMATION",
                                       f"missed {missed} fire(s); waiting for the owner's confirmation")
                    if rid:
                        from nebula_host import approvals_v2

                        approvals_v2.request("schedule_misfire", {"schedule_id": s["id"], "run_id": rid},
                                             f"Schedule '{s['name']}' missed {missed} run(s) while NEBULA was offline. "
                                             f"Run it once now?", {"scheduled_for": slot})
                    continue
                # run_once: one catch-up run for any number of missed fires
            rid = await self.fire(s, slot, trigger="timer" if late <= GRACE_S else "misfire")
            if rid:
                fired.append(rid)
        await self._retries(now)
        return fired

    def _missed_count(self, s: dict[str, Any], slot: float, now: float) -> int:
        n, t = 0, slot
        while t is not None and t <= now and n < 1000:
            n += 1
            t = cron.next_run(s["kind"], s["spec"], s["timezone"], t, created_ts=s["created_at"])
        return n

    def _record(self, s: dict[str, Any], slot: float, trigger: str, state: str, detail: str,
                attempt: int = 1) -> str | None:
        rid = str(uuid.uuid4())
        try:
            with db.engine().begin() as c:
                c.execute(models.schedule_runs.insert().values(
                    id=rid, schedule_id=s["id"], scheduled_for=slot, attempt=attempt, trigger=trigger, state=state,
                    detail=detail, created_at=_now(), started_at=_now() if state == "RUNNING" else None,
                    finished_at=_now() if state in ("SKIPPED",) else None))
        except IntegrityError:
            return None  # this slot already ran: never twice
        bus.publish("schedule.run.started" if state == "RUNNING" else "schedule.run.finished",
                    {"schedule_id": s["id"], "run_id": rid, "name": s["name"], "state": state, "detail": detail})
        return rid

    async def fire(self, s: dict[str, Any], slot: float, trigger: str = "timer", attempt: int = 1,
                   run_id: str | None = None) -> str | None:
        if s["overlap_policy"] == "skip" and trigger != "retry":
            with db.engine().connect() as c:
                active = c.execute(select(models.schedule_runs.c.id).where(and_(
                    models.schedule_runs.c.schedule_id == s["id"], models.schedule_runs.c.state.in_(ACTIVE)))).first()
            if active:
                self._record(s, slot, trigger, "SKIPPED", "previous run still active (overlap policy: skip)", attempt)
                return None
        rid = run_id or self._record(s, slot, trigger, "RUNNING", "", attempt)
        if not rid:
            return None
        if run_id:
            with db.engine().begin() as c:
                c.execute(update(models.schedule_runs).where(models.schedule_runs.c.id == run_id)
                          .values(state="RUNNING", started_at=_now(), detail="confirmed by owner"))
        reply = {"schedule_run": rid, "notify_telegram": bool((s.get("notify") or {}).get("telegram"))}
        ref = {"type": "schedule_run", "id": rid, "schedule_id": s["id"]}
        try:
            if s["target_type"] == "agent":
                t = self.orch.enqueue(s["target_id"], s["prompt"], source="schedule", reply_target=reply,
                                      max_steps=s["max_model_calls"], parent_ref=ref, max_runtime_s=s["max_runtime_s"],
                                      origin_depth=1)
                target = {"task_id": t["id"]}
            elif s["target_type"] == "team":
                r = await self.teams.start_run(s["target_id"], s["prompt"], source="schedule", reply_target=reply,
                                               parent_ref=ref, origin_depth=1, max_model_calls=s["max_model_calls"],
                                               actor=f"schedule:{s['id']}")
                target = {"team_run_id": r["id"]}
            else:
                r = await self.workflows.start(s["target_id"], trigger="schedule",
                                               payload={"schedule_id": s["id"], "prompt": s["prompt"]},
                                               actor=f"schedule:{s['id']}", parent_ref=ref, origin_depth=1)
                target = {"workflow_run_id": r["id"]}
        except Exception as e:  # noqa: BLE001 - recorded on the run; retries apply
            self._finish(rid, "FAILED", f"could not start: {e}")
            return rid
        with db.engine().begin() as c:
            c.execute(update(models.schedule_runs).where(models.schedule_runs.c.id == rid).values(target_ref=target))
        return rid

    def _finish(self, run_id: str, state: str, detail: str, result: dict | None = None) -> None:
        with db.engine().begin() as c:
            r = c.execute(select(models.schedule_runs).where(models.schedule_runs.c.id == run_id)).first()
            if not r or r.state not in ("RUNNING",):
                return
            c.execute(update(models.schedule_runs).where(models.schedule_runs.c.id == run_id)
                      .values(state=state, detail=detail[:4000], finished_at=_now()))
            s = c.execute(select(models.schedules).where(models.schedules.c.id == r.schedule_id)).first()
        if s is None:
            return
        bus.publish("schedule.run.finished", {"schedule_id": s.id, "run_id": run_id, "name": s.name, "state": state,
                                              "detail": detail[:1500], "attempt": r.attempt,
                                              "notify_telegram": bool((s.notify or {}).get("telegram")),
                                              "result": result})

    async def _retries(self, now: float) -> None:
        with db.engine().connect() as c:
            failed = db.rows(c.execute(select(models.schedule_runs, models.schedules.c.retry_max,
                                              models.schedules.c.retry_delay_s)
                                       .join(models.schedules, models.schedules.c.id == models.schedule_runs.c.schedule_id)
                                       .where(and_(models.schedule_runs.c.state == "FAILED",
                                                   models.schedule_runs.c.finished_at.is_not(None)))))
        for r in failed:
            if r["attempt"] > r["retry_max"] or now - r["finished_at"] < r["retry_delay_s"]:
                continue
            with db.engine().connect() as c:
                newer = c.execute(select(models.schedule_runs.c.id).where(and_(
                    models.schedule_runs.c.schedule_id == r["schedule_id"],
                    models.schedule_runs.c.scheduled_for == r["scheduled_for"],
                    models.schedule_runs.c.attempt > r["attempt"]))).first()
            if newer:
                continue
            await self.fire(get(r["schedule_id"]), r["scheduled_for"], trigger="retry", attempt=r["attempt"] + 1)

    async def run_now(self, schedule_id: str, actor: str) -> dict[str, Any]:
        s = get(schedule_id)
        rid = await self.fire(s, _now(), trigger="manual")
        audit(actor, "schedule.run_now", schedule_id, {"run_id": rid})
        if not rid:
            raise ScheduleError("not started: the previous run is still active (overlap policy: skip)")
        return next(r for r in runs(schedule_id, 20) if r["id"] == rid)

    async def confirm_misfire(self, run_id: str, approve: bool, actor: str) -> None:
        with db.engine().connect() as c:
            r = db.row(c.execute(select(models.schedule_runs).where(models.schedule_runs.c.id == run_id)).first())
        if not r or r["state"] != "AWAITING_CONFIRMATION":
            return
        if not approve:
            with db.engine().begin() as c:
                c.execute(update(models.schedule_runs).where(models.schedule_runs.c.id == run_id)
                          .values(state="SKIPPED", detail=f"declined by {actor}", finished_at=_now()))
            return
        await self.fire(get(r["schedule_id"]), r["scheduled_for"], trigger="misfire", run_id=run_id)

    # ------------------------------------------------------------------ results
    async def on_event(self, ev: dict[str, Any]) -> None:
        t = ev["type"]
        p = ev.get("payload") or {}
        ref = p.get("parent_ref") or {}
        if ref.get("type") != "schedule_run":
            return
        if t in ("task.completed", "task.failed", "task.cancelled"):
            res = p.get("result") or {}
            state = {"task.completed": "COMPLETED", "task.failed": "FAILED", "task.cancelled": "CANCELLED"}[t]
            self._finish(ref["id"], state, (res.get("summary") or p.get("reason") or state), {"task_id": ev["task_id"]})
        elif t in ("team.run.completed", "team.run.failed"):
            self._finish(ref["id"], "COMPLETED" if t.endswith("completed") else "FAILED",
                         (p.get("result") or {}).get("summary", p.get("state", "")), {"team_run_id": p.get("run_id")})
        elif t == "workflow.run.finished":
            self._finish(ref["id"], "COMPLETED" if p.get("state") == "COMPLETED" else "FAILED",
                         p.get("summary") or p.get("error") or p.get("state", ""), {"workflow_run_id": p.get("run_id")})

    async def reconcile(self) -> None:
        """Runs whose target finished while the host was down get their final state now."""
        from nebula_runtime.orchestrator import get_task

        with db.engine().connect() as c:
            active = db.rows(c.execute(select(models.schedule_runs).where(models.schedule_runs.c.state == "RUNNING")))
        for r in active:
            ref = r.get("target_ref") or {}
            try:
                if ref.get("task_id"):
                    t = get_task(ref["task_id"])
                    if t["state"] in ("COMPLETED", "FAILED", "CANCELLED"):
                        self._finish(r["id"], t["state"], (t.get("result") or {}).get("summary") or t.get("failure_reason")
                                     or t["state"])
                elif ref.get("team_run_id"):
                    with db.engine().connect() as c:
                        st = c.execute(select(models.team_runs.c.state).where(models.team_runs.c.id == ref["team_run_id"])).scalar()
                    if st in ("COMPLETED", "FAILED", "CANCELLED"):
                        self._finish(r["id"], "COMPLETED" if st == "COMPLETED" else "FAILED", st)
                elif ref.get("workflow_run_id"):
                    with db.engine().connect() as c:
                        st = c.execute(select(models.workflow_runs.c.state).where(
                            models.workflow_runs.c.id == ref["workflow_run_id"])).scalar()
                    if st in ("COMPLETED", "FAILED", "CANCELLED"):
                        self._finish(r["id"], "COMPLETED" if st == "COMPLETED" else "FAILED", st)
                elif _now() - (r["started_at"] or 0) > 600:
                    self._finish(r["id"], "FAILED", "interrupted before the target started")
            except KeyError:
                self._finish(r["id"], "FAILED", "target no longer exists")
