"""Interactive Telegram Messages 3.0: live task cards.

One compact message per task and chat, edited in place as the task progresses (coalesced: at most one edit every
3 s per card, identical renders are skipped). Buttons depend on the lifecycle state and perform real backend
operations. Cards are persisted (telegram_task_cards) so they keep updating after a restart. Approval buttons are
bound to the exact approval, bot and chat with an HMAC tag; callbacks are de-duplicated.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import logging
import secrets as pysecrets
import time
from typing import Any

from nebula_host import db, models
from nebula_host import secrets as sec
from sqlalchemy import and_, select, update
from sqlalchemy.exc import IntegrityError

from nebula_telegram.botapi import TelegramError

log = logging.getLogger("nebula.telegram.cards")
KEY_REF = "nebula:telegram.callback_key"
MIN_EDIT_INTERVAL = 3.0
LEVELS = ("all", "important", "completion", "errors", "silent")

LIFECYCLE = {"RECEIVED": "QUEUED", "QUEUED": "QUEUED", "PLANNING": "RUNNING", "EXECUTING": "RUNNING",
             "VERIFYING": "RUNNING", "PAUSING": "RUNNING", "WAITING_CONTROL": "RUNNING",
             "WAITING_PROVIDER": "RUNNING", "WAITING_APPROVAL": "WAITING_FOR_APPROVAL", "PAUSED": "PAUSED",
             "COMPLETED": "COMPLETED", "FAILED": "FAILED", "CANCELLED": "CANCELLED"}
ICON = {"QUEUED": "🕓", "PREPARING": "⚙️", "RUNNING": "▶️", "WAITING_FOR_APPROVAL": "🛂", "PAUSED": "⏸",
        "COMPLETED": "✅", "FAILED": "⚠️", "CANCELLED": "⏹"}
ENV_LABEL = {"vm": "Ubuntu VM", "host": "Mac mini"}


# ---------------------------------------------------------------------------- callback security
def _key() -> bytes:
    k = sec.store().get(KEY_REF)
    if not k:
        k = pysecrets.token_urlsafe(32)
        sec.store().set(KEY_REF, k)
    return k.encode()


def tag(*parts: Any) -> str:
    mac = hmac.new(_key(), "|".join(str(p) for p in parts).encode(), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(mac[:7]).decode().rstrip("=")


def check_tag(t: str, *parts: Any) -> bool:
    return hmac.compare_digest(t or "", tag(*parts))


def approval_buttons(approval_id: str, bot_key: str, chat_id: int, *, once: bool = False) -> list[dict[str, str]]:
    """once=True: single-use approvals (Password Vault credential use) say so on the button."""
    return [{"text": "✅ Approve once" if once else "✅ Approve",
             "callback_data": f"ap:{approval_id}:y:{tag(approval_id, 'y', bot_key, chat_id)}"},
            {"text": "⛔ Deny" if once else "⛔ Reject",
             "callback_data": f"ap:{approval_id}:n:{tag(approval_id, 'n', bot_key, chat_id)}"}]


def first_time(callback_id: str, bot_key: str, data: str) -> bool:
    """Duplicate callback protection (Telegram may redeliver; users double-tap)."""
    try:
        with db.engine().begin() as c:
            c.execute(models.telegram_callbacks.insert().values(callback_id=str(callback_id)[:64], bot_key=bot_key,
                                                                data=data[:128], processed_at=db.now()))
        return True
    except IntegrityError:
        return False


def purge_callbacks(max_age_s: float = 7 * 86400) -> None:
    with db.engine().begin() as c:
        c.execute(models.telegram_callbacks.delete().where(models.telegram_callbacks.c.processed_at < db.now() - max_age_s))


# ---------------------------------------------------------------------------- notification preferences
def level_of(bot_key: str, chat_id: int) -> str:
    with db.engine().connect() as c:
        if bot_key == "main":
            lv = c.execute(select(models.telegram_users.c.notify_level).where(and_(
                models.telegram_users.c.chat_id == chat_id, models.telegram_users.c.status == "approved"))).scalar()
        else:
            lv = c.execute(select(models.telegram_bot_users.c.notify_level).where(and_(
                models.telegram_bot_users.c.bot_row_id == bot_key, models.telegram_bot_users.c.chat_id == chat_id,
                models.telegram_bot_users.c.status == "approved"))).scalar()
    return lv if lv in LEVELS else "important"


def set_level(bot_key: str, chat_id: int, level: str) -> None:
    if level not in LEVELS:
        raise ValueError("level must be one of " + ", ".join(LEVELS))
    with db.engine().begin() as c:
        if bot_key == "main":
            c.execute(update(models.telegram_users).where(models.telegram_users.c.chat_id == chat_id)
                      .values(notify_level=level))
        else:
            c.execute(update(models.telegram_bot_users).where(and_(models.telegram_bot_users.c.bot_row_id == bot_key,
                                                                   models.telegram_bot_users.c.chat_id == chat_id))
                      .values(notify_level=level))


def wants(level: str, kind: str) -> bool:
    """kind: progress | approval | completion | failure | question"""
    if kind == "approval":
        return True  # approvals are always delivered (silently in silent mode)
    return {"all": True, "important": kind in ("completion", "failure", "question"),
            "completion": kind in ("completion", "failure"), "errors": kind == "failure", "silent": False}[level]


def level_keyboard(bot_key: str) -> dict[str, Any]:
    names = {"all": "🔔 All updates", "important": "⭐ Important only", "completion": "✅ Completion only",
             "errors": "⚠️ Errors only", "silent": "🔕 Silent"}
    return {"inline_keyboard": [[{"text": names[lv], "callback_data": f"nl:{lv}"}] for lv in LEVELS]}


# ---------------------------------------------------------------------------- rendering
def lifecycle(task: dict[str, Any]) -> str:
    st = LIFECYCLE.get(task["state"], task["state"])
    if st == "RUNNING" and task["state"] == "PLANNING" and not task.get("current_step"):
        return "PREPARING"
    return st


# live execution stage per running task (from `task.stage` events): the card says what the agent is doing right now
STAGES: dict[str, tuple[str, str | None, float]] = {}
STAGE_LABEL = {"starting": "starting", "waking_desktop": "waking the desktop", "model_request": "waiting for the AI model",
               "verifying": "verifying the result", "waiting_for_resources": "waiting for free resources"}


def note_stage(task_id: str, stage: str, detail: str | None) -> None:
    STAGES[task_id] = (stage, detail, time.time())
    if len(STAGES) > 500:  # bounded: drop the oldest entries
        for k in sorted(STAGES, key=lambda k: STAGES[k][2])[:100]:
            STAGES.pop(k, None)


def stage_text(task_id: str) -> str | None:
    st = STAGES.get(task_id)
    if not st:
        return None
    stage, detail, _ = st
    if stage == "tool":
        return f"running {detail}" if detail else "running a tool"
    if stage == "waiting_for_resources" and detail:
        return f"waiting for free resources ({detail[:120]})"
    return STAGE_LABEL.get(stage, stage)


def render(task: dict[str, Any], agent_name: str, *, public_url: str | None = None) -> tuple[str, dict[str, Any]]:
    st = lifecycle(task)
    env = (task.get("execution") or {}).get("env", "vm")
    with db.engine().connect() as c:
        step = db.row(c.execute(select(models.task_steps.c.tool_type, models.task_steps.c.result_status,
                                       models.task_steps.c.result_summary)
                                .where(models.task_steps.c.task_id == task["id"])
                                .order_by(models.task_steps.c.seq.desc())).first())
    title = (task["prompt"].strip().splitlines() or [""])[0][:90]
    live = stage_text(task["id"]) if st in ("RUNNING", "PREPARING", "QUEUED") else None
    if st == "WAITING_FOR_APPROVAL":
        cur = "waiting for your approval"
    elif live:
        cur = live
    elif st == "PREPARING":
        cur = "preparing the environment"
    elif step:
        cur = f"{step['tool_type']} ({step['result_status']})"
    elif st == "QUEUED":
        cur = "waiting in queue"
    else:
        cur = "thinking"
    if st in ("COMPLETED", "FAILED", "CANCELLED"):
        res = task.get("result") or {}
        cur = (res.get("summary") or task.get("failure_reason") or st.lower())[:300]
    lines = [f"NEBULA — {agent_name}", f"Task: {title}", f"Status: {ICON.get(st, '')} {st}",
             f"{'Result' if st in ('COMPLETED', 'FAILED', 'CANCELLED') else 'Current step'}: {cur}"]
    if live and step and st not in ("COMPLETED", "FAILED", "CANCELLED"):
        lines.append(f"Last action: {step['tool_type']} ({step['result_status']})")
    lines += [
             f"Progress: {task.get('current_step', 0)}/{task.get('max_steps', 0)} steps",
             f"Environment: {ENV_LABEL.get(env, env)}", f"#{task['id'][:8]}"]
    tid = task["id"]
    rows: list[list[dict[str, Any]]] = []
    if st in ("RUNNING", "PREPARING"):
        rows.append([{"text": "⏸ Pause", "callback_data": f"c:p:{tid}"}, {"text": "⏹ Stop", "callback_data": f"c:x:{tid}"}])
        r2 = [{"text": "📋 Details", "callback_data": f"c:d:{tid}"}]
        if env == "vm":
            r2.insert(0, {"text": "🖼 Screenshot", "callback_data": f"c:i:{tid}"})
            if public_url:
                r2.append({"text": "🖥 Open Desktop", "web_app": {"url": f"{public_url}/mini/#/agents/{task['agent_id']}/desktop"}})
        rows.append(r2)
    elif st == "WAITING_FOR_APPROVAL":
        rows.append([{"text": "📋 Details", "callback_data": f"c:d:{tid}"}, {"text": "⏹ Stop", "callback_data": f"c:x:{tid}"}])
    elif st == "PAUSED":
        rows.append([{"text": "▶️ Resume", "callback_data": f"c:r:{tid}"}, {"text": "⏹ Stop", "callback_data": f"c:x:{tid}"}])
    elif st == "QUEUED":
        rows.append([{"text": "👤 Assign agent", "callback_data": f"c:a:{tid}"}, {"text": "⏹ Stop", "callback_data": f"c:x:{tid}"}])
    elif st == "COMPLETED":
        rows.append([{"text": "⬇️ Download result", "callback_data": f"c:l:{tid}"},
                     {"text": "📁 View files", "callback_data": f"c:f:{tid}"}])
        rows.append([{"text": "📋 Details", "callback_data": f"c:d:{tid}"}])
    elif st in ("FAILED", "CANCELLED"):
        rows.append([{"text": "🔁 Retry", "callback_data": f"c:t:{tid}"}, {"text": "📋 Details", "callback_data": f"c:d:{tid}"}])
    if public_url:
        rows.append([{"text": "📱 Open in NEBULA app", "web_app": {"url": f"{public_url}/mini/#/tasks/{tid}"}}])
    return "\n".join(lines), {"inline_keyboard": rows}


# ---------------------------------------------------------------------------- live cards
class CardService:
    def __init__(self) -> None:
        self.apis: dict[str, Any] = {}  # bot_key -> BotAPI
        self._pending: dict[tuple[str, str, int], asyncio.Task] = {}
        self.public_url: Any = lambda: None  # callable -> https base URL of the Mini App gateway (or None)

    def register(self, bot_key: str, api) -> None:
        self.apis[bot_key] = api

    def unregister(self, bot_key: str) -> None:
        self.apis.pop(bot_key, None)

    async def open(self, bot_key: str, task_id: str, chat_id: int, thread_id: int | None = None) -> None:
        from nebula_runtime.orchestrator import get_task

        api = self.apis.get(bot_key)
        if api is None:
            return
        task = get_task(task_id)
        text, kb = render(task, _agent_name(task["agent_id"]), public_url=self.public_url())
        msg = await api.send_message(chat_id, text, thread_id, reply_markup=kb)
        with db.engine().begin() as c:
            c.execute(models.telegram_task_cards.insert().prefix_with("OR REPLACE").values(
                task_id=task_id, bot_key=bot_key, chat_id=chat_id, thread_id=thread_id, message_id=msg["message_id"],
                state=lifecycle(task), last_hash=_h(text, kb), last_edit_at=time.time(), created_at=db.now()))

    def cards_for(self, task_id: str) -> list[dict[str, Any]]:
        with db.engine().connect() as c:
            return db.rows(c.execute(select(models.telegram_task_cards).where(
                models.telegram_task_cards.c.task_id == task_id)))

    def touch(self, task_id: str, *, final: bool = False) -> None:
        """Schedule a (coalesced) refresh of every card of this task."""
        for card in self.cards_for(task_id):
            if card["state"] == "DELETED":
                continue
            k = (card["bot_key"], task_id, card["chat_id"])
            if k in self._pending and not self._pending[k].done():
                continue
            if not final:
                lv = level_of(card["bot_key"], card["chat_id"])
                if lv in ("completion", "errors", "silent"):
                    continue  # quiet levels: the card is only refreshed at the end
            delay = max(0.0, MIN_EDIT_INTERVAL - (time.time() - (card["last_edit_at"] or 0)))
            self._pending[k] = asyncio.ensure_future(self._edit_later(card, delay))

    async def _edit_later(self, card: dict[str, Any], delay: float) -> None:
        from nebula_runtime.orchestrator import get_task

        try:
            if delay:
                await asyncio.sleep(delay)
            api = self.apis.get(card["bot_key"])
            if api is None:
                return
            task = get_task(card["task_id"])
            text, kb = render(task, _agent_name(task["agent_id"]), public_url=self.public_url())
            hh = _h(text, kb)
            with db.engine().connect() as c:
                cur = c.execute(select(models.telegram_task_cards.c.last_hash).where(and_(
                    models.telegram_task_cards.c.task_id == card["task_id"],
                    models.telegram_task_cards.c.bot_key == card["bot_key"],
                    models.telegram_task_cards.c.chat_id == card["chat_id"]))).scalar()
            if cur == hh:
                return
            state = lifecycle(task)
            try:
                await api.edit_message_text(card["chat_id"], card["message_id"], text, reply_markup=kb)
            except TelegramError as e:
                desc = (e.description or "").lower()
                if "not modified" in desc:
                    pass
                elif e.code == 400 and ("not found" in desc or "message_id_invalid" in desc or "can't be edited" in desc):
                    state = "DELETED"  # the owner deleted the card: stop editing it
                else:
                    raise
            with db.engine().begin() as c:
                c.execute(update(models.telegram_task_cards).where(and_(
                    models.telegram_task_cards.c.task_id == card["task_id"],
                    models.telegram_task_cards.c.bot_key == card["bot_key"],
                    models.telegram_task_cards.c.chat_id == card["chat_id"])).values(
                    last_hash=hh, last_edit_at=time.time(), state=state))
        except KeyError:
            return
        except TelegramError as e:
            log.warning("card edit failed for %s: %s", card["task_id"], e)
        except Exception:  # noqa: BLE001
            log.exception("card refresh failed")
        finally:
            self._pending.pop((card["bot_key"], card["task_id"], card["chat_id"]), None)


def _h(text: str, kb: dict[str, Any]) -> str:
    import json

    return hashlib.sha256((text + json.dumps(kb, sort_keys=True)).encode()).hexdigest()


def _agent_name(agent_id: str) -> str:
    with db.engine().connect() as c:
        return c.execute(select(models.agents.c.name).where(models.agents.c.id == agent_id)).scalar() or agent_id[:8]


cards = CardService()
