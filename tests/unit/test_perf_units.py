"""Perf audit 2026-11-16: unit checks for live stages on Telegram cards."""

from __future__ import annotations


def _task(state="EXECUTING"):
    return {"id": "t-stage-1", "prompt": "open the docs", "state": state, "execution": {"env": "vm"},
            "current_step": 1, "max_steps": 30, "agent_id": "a1", "result": None, "failure_reason": None}


def test_card_shows_the_live_stage(dbinit):
    from nebula_telegram import cards

    cards.STAGES.clear()
    cards.note_stage("t-stage-1", "model_request", "openai-siwc/gpt")
    text, _ = cards.render(_task(), "Developer")
    assert "Current step: waiting for the AI model" in text
    cards.note_stage("t-stage-1", "tool", "browser_navigate")
    assert "Current step: running browser_navigate" in cards.render(_task(), "Developer")[0]
    cards.note_stage("t-stage-1", "waiting_for_resources", "Mac memory pressure is critical — queued")
    assert "waiting for free resources (Mac memory pressure is critical" in cards.render(_task("QUEUED"), "D")[0]
    # a finished task shows its result, never a stale stage
    done = {**_task("COMPLETED"), "result": {"summary": "docs opened"}}
    assert "Result: docs opened" in cards.render(done, "Developer")[0]


def test_stage_table_is_bounded():
    from nebula_telegram import cards

    cards.STAGES.clear()
    for i in range(700):
        cards.note_stage(f"t{i}", "model_request", None)
    assert len(cards.STAGES) <= 500


def test_event_log_retention(dbinit):
    import time

    from nebula_host import db, models
    from nebula_host.api.routes_v3 import NOTIFY_TYPES
    from nebula_host.events import purge_old_events
    from sqlalchemy import func, select

    now = time.time()
    rows = [("task.stage", now - 3 * 86400), ("task.stage", now - 3600), ("task.step", now - 40 * 86400),
            ("task.step", now - 86400), ("task.completed", now - 40 * 86400), ("task.completed", now - 200 * 86400)]
    with db.engine().begin() as c:
        for i, (t, ts) in enumerate(rows):
            c.execute(models.events.insert().values(id=f"e{i}", type=t, timestamp=ts, payload={}))
    assert purge_old_events(NOTIFY_TYPES, now=now) == 3
    with db.engine().connect() as c:
        left = sorted(r.id for r in c.execute(select(models.events.c.id)))
        assert c.execute(select(func.count()).select_from(models.events)).scalar() == 3
    assert left == ["e1", "e3", "e4"]  # fresh stage, fresh step, 40-day-old notification kept
