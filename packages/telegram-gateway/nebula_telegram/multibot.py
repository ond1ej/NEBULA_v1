"""Independent Telegram bot per agent (V3 module 5) — one shared gateway, many bot identities.

* The owner creates a bot in @BotFather and pastes the token; NEBULA validates it (getMe), rejects collisions with the
  main bot or another agent bot, stores it in the Keychain (never shown again), binds it to exactly one agent and
  configures supported metadata (commands, name, description). Profile photos can only be set in @BotFather.
* Every bot runs as a lightweight long-poll coroutine inside the NEBULA process (no process per bot), with its own
  lease, update offset and de-duplication table, so a failing/revoked bot never affects the others (401 -> REVOKED,
  only that bot stops).
* Pairing per bot (one-time code from the Dashboard). A Telegram user who is already an approved owner of the main
  bot is approved automatically once they present a valid code; anybody else needs Dashboard approval.
* Isolation: an agent bot routes every message, file, voice note and button to its own agent only; tasks it creates
  carry reply_target.bot so results come back only through this bot; callbacks for other agents' tasks are refused.
* Approvals are the owner's (nebula_telegram.access): only the NEBULA owner's own Telegram account decides them here.
  A task the owner started through this bot gets its approval card in this chat; a task anybody else started gets a
  "waits for the owner" note here, and the card goes to the owner's main-bot chat.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import re
import secrets
import socket
import time
import uuid
from collections import defaultdict, deque
from typing import Any

from nebula_host import db, models
from nebula_host import secrets as sec
from nebula_host.events import audit, bus
from sqlalchemy import and_, select, update
from sqlalchemy.exc import IntegrityError

from nebula_telegram import access
from nebula_telegram import cards as cardmod
from nebula_telegram import v3 as tg3
from nebula_telegram.botapi import BotAPI, TelegramError
from nebula_telegram.cards import cards as task_cards

log = logging.getLogger("nebula.telegram.multibot")
TOKEN_RE = re.compile(r"^\d{5,15}:[A-Za-z0-9_-]{30,64}$")
CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
MAX_BOTS = 24
AGENT_COMMANDS = [{"command": "help", "description": "What I can do"},
                  {"command": "status", "description": "My current task"},
                  {"command": "pause", "description": "Pause my task"}, {"command": "resume", "description": "Resume"},
                  {"command": "stop", "description": "Stop my task"},
                  {"command": "screenshot", "description": "Screenshot of my desktop"},
                  {"command": "history", "description": "My recent tasks"},
                  {"command": "files", "description": "My workspace files"},
                  {"command": "voice", "description": "Voice reply mode"},
                  {"command": "notify", "description": "Notification level"},
                  {"command": "app", "description": "Open the NEBULA Mini App"}]


class BotError(ValueError):
    def __init__(self, message: str, status: int = 400, code: str = "invalid_request") -> None:
        super().__init__(message)
        self.message, self.status, self.code = message, status, code


def _ref(row_id: str) -> str:
    return f"nebula:telegram.agentbot.{row_id}"


def get_bot(row_id: str) -> dict[str, Any]:
    with db.engine().connect() as c:
        r = db.row(c.execute(select(models.telegram_bots).where(models.telegram_bots.c.id == row_id)).first())
    if not r:
        raise BotError("bot not found", 404, "bot_not_found")
    return r


def public(r: dict[str, Any], runner: Any = None) -> dict[str, Any]:
    out = {k: v for k, v in r.items() if k not in ("keychain_ref", "leader_id", "leader_lease_until")}
    out["polling"] = bool(runner and runner.running)
    out["token_stored"] = bool(sec.store().get(r["keychain_ref"]))
    with db.engine().connect() as c:
        out["users"] = db.rows(c.execute(select(models.telegram_bot_users).where(
            models.telegram_bot_users.c.bot_row_id == r["id"])))
        out["agent_name"] = c.execute(select(models.agents.c.name).where(models.agents.c.id == r["agent_id"])).scalar()
    return out


class AgentBotRunner:
    """Bot context for nebula_telegram.v3 helpers (key/api/cfg/orch/guest/svc/fixed_agent) + its own poll loop."""

    def __init__(self, mgr: AgentBotManager, row: dict[str, Any]) -> None:
        self.mgr = mgr
        self.key = row["id"]
        self.fixed_agent = row["agent_id"]
        self.cfg, self.orch, self.guest = mgr.cfg, mgr.orch, mgr.guest
        ref = row["keychain_ref"]
        self.api = BotAPI(lambda: sec.store().get(ref), mgr.cfg.telegram.api_base)
        self.instance_id = f"{socket.gethostname()}:{os.getpid()}:{uuid.uuid4().hex[:8]}"
        self.running = False
        self.task: asyncio.Task | None = None
        self._rate: dict[int, deque] = defaultdict(deque)
        self._refused: dict[int, float] = {}

    @property
    def svc(self):
        return self.mgr.svc

    @property
    def v2(self):  # nebula_telegram.v2 helpers (downloads) expect gw.v2
        return self.mgr.svc

    # ------------------------------------------------------------------ lifecycle
    def start(self) -> None:
        task_cards.register(self.key, self.api)
        if not self.task or self.task.done():
            self.task = asyncio.create_task(self._loop(), name=f"tgbot-{self.key[:8]}")

    async def stop(self) -> None:
        task_cards.unregister(self.key)
        if self.task:
            self.task.cancel()
            try:
                await self.task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        self.running = False
        self._set(leader_id=None, leader_lease_until=None)
        await self.api.close()

    def _set(self, **vals: Any) -> None:
        vals["updated_at"] = db.now()
        with db.engine().begin() as c:
            c.execute(update(models.telegram_bots).where(models.telegram_bots.c.id == self.key).values(**vals))

    def _lease(self) -> bool:
        from nebula_telegram.gateway import _stale_local_leader

        now = time.time()
        with db.engine().begin() as c:
            r = c.execute(select(models.telegram_bots.c.leader_id, models.telegram_bots.c.leader_lease_until)
                          .where(models.telegram_bots.c.id == self.key)).first()
            if r is None:
                return False
            if r.leader_id and r.leader_id != self.instance_id and (r.leader_lease_until or 0) > now \
                    and not _stale_local_leader(r.leader_id):
                return False
            c.execute(update(models.telegram_bots).where(models.telegram_bots.c.id == self.key)
                      .values(leader_id=self.instance_id, leader_lease_until=now + 90))
        return True

    async def _loop(self) -> None:
        backoff = 1
        while True:
            if not self._lease():
                self.running = False
                await asyncio.sleep(15)
                continue
            self.running = True
            try:
                row = get_bot(self.key)
                t0 = time.monotonic()
                updates = await self.api.get_updates(row["update_offset"], self.cfg.telegram.poll_timeout_seconds)
                self._set(last_poll_at=db.now(), last_error=None, status="ACTIVE")
                backoff = 1
                for upd in updates:
                    await self._process(upd)
                if not updates and time.monotonic() - t0 < 0.5:
                    await asyncio.sleep(1.0)  # a long poll that returns instantly must never spin the event loop
            except asyncio.CancelledError:
                self.running = False
                raise
            except TelegramError as e:
                if e.code == 401:  # revoked token: only THIS bot stops
                    log.error("agent bot %s token rejected; disabled", self.key)
                    self._set(status="REVOKED", enabled=False, last_error="token revoked or invalid (401)")
                    bus.publish("bot.state.changed", {"bot_id": self.key, "status": "REVOKED"},
                                agent_id=self.fixed_agent)
                    self.running = False
                    return
                self._set(last_error=str(e)[:500], status="ERROR")
                await asyncio.sleep(min(backoff, 60))
                backoff *= 2
            except BotError:
                self.running = False
                return  # bot row deleted
            except Exception as e:  # noqa: BLE001
                log.exception("agent bot poll failed")
                self._set(last_error=f"{type(e).__name__}: {e}"[:500])
                await asyncio.sleep(min(backoff, 60))
                backoff *= 2

    async def _process(self, upd: dict[str, Any]) -> None:
        uid = int(upd["update_id"])
        try:
            with db.engine().begin() as c:
                c.execute(models.telegram_bot_updates.insert().values(bot_row_id=self.key, update_id=uid,
                                                                      processed=False, received_at=db.now()))
        except IntegrityError:
            with db.engine().connect() as c:
                done = c.execute(select(models.telegram_bot_updates.c.processed).where(and_(
                    models.telegram_bot_updates.c.bot_row_id == self.key,
                    models.telegram_bot_updates.c.update_id == uid))).scalar()
            if done:
                self._set(update_offset=max(get_bot(self.key)["update_offset"], uid + 1))
                return
        err = None
        try:
            if "message" in upd:
                await self.on_message(upd["message"])
            elif "callback_query" in upd:
                await self.on_callback(upd["callback_query"])
        except Exception as e:  # noqa: BLE001
            log.exception("agent bot update %s failed", uid)
            err = f"{type(e).__name__}: {e}"[:500]
        with db.engine().begin() as c:
            c.execute(update(models.telegram_bot_updates).where(and_(
                models.telegram_bot_updates.c.bot_row_id == self.key,
                models.telegram_bot_updates.c.update_id == uid)).values(processed=True, error=err))
            c.execute(update(models.telegram_bots).where(models.telegram_bots.c.id == self.key)
                      .values(update_offset=uid + 1, last_update_at=db.now()))

    # ------------------------------------------------------------------ authorisation
    def _user(self, tg_uid: int, chat_id: int) -> dict[str, Any] | None:
        with db.engine().connect() as c:
            u = db.row(c.execute(select(models.telegram_bot_users).where(and_(
                models.telegram_bot_users.c.bot_row_id == self.key,
                models.telegram_bot_users.c.telegram_user_id == tg_uid,
                models.telegram_bot_users.c.chat_id == chat_id,
                models.telegram_bot_users.c.status == "approved"))).first())
        return u

    def _approved_users(self) -> list[dict[str, Any]]:
        with db.engine().connect() as c:
            return db.rows(c.execute(select(models.telegram_bot_users).where(and_(
                models.telegram_bot_users.c.bot_row_id == self.key, models.telegram_bot_users.c.status == "approved"))))

    def _rate_ok(self, tg_uid: int) -> bool:
        q = self._rate[tg_uid]
        now = time.time()
        while q and now - q[0] > 60:
            q.popleft()
        if len(q) >= self.cfg.telegram.rate_limit_per_minute:
            return False
        q.append(now)
        return True

    async def _refuse(self, chat_id: int, tg_uid: int) -> None:
        if time.time() - self._refused.get(tg_uid, 0) > 3600:
            self._refused[tg_uid] = time.time()
            try:
                await self.api.send_message(chat_id, "This is a private NEBULA agent bot. Access requires pairing by "
                                                     "its owner.")
            except TelegramError:
                pass

    async def _pair(self, m: dict[str, Any], code: str) -> None:
        from nebula_telegram.gateway import code_hash

        chat_id, frm = int(m["chat"]["id"]), m["from"]
        now = time.time()
        status = None
        from nebula_host import authz

        is_owner = int(frm["id"]) == (authz.primary_owner_telegram_id() or -1)  # read before the write transaction
        with db.engine().begin() as c:
            p = c.execute(select(models.telegram_pairings).where(and_(
                models.telegram_pairings.c.code_hash == code_hash(code),
                models.telegram_pairings.c.bot_row_id == self.key))).first()
            if p is not None and not p.used_at and p.expires_at >= now:
                c.execute(update(models.telegram_pairings).where(models.telegram_pairings.c.id == p.id)
                          .values(used_at=now, telegram_user_id=frm["id"], chat_id=chat_id))
                # only the NEBULA owner's own Telegram account is approved automatically; anybody else (operators
                # of the main bot included) waits for the owner's approval on the Dashboard
                status = "approved" if is_owner else "pending"
                name = " ".join(x for x in (frm.get("first_name"), frm.get("last_name")) if x)[:128]
                ex = c.execute(select(models.telegram_bot_users.c.id).where(and_(
                    models.telegram_bot_users.c.bot_row_id == self.key,
                    models.telegram_bot_users.c.telegram_user_id == frm["id"]))).first()
                vals = {"chat_id": chat_id, "username": frm.get("username"), "display_name": name, "status": status,
                        "pairing_id": p.id, "approved_at": now if status == "approved" else None}
                if ex:
                    c.execute(update(models.telegram_bot_users).where(models.telegram_bot_users.c.id == ex.id).values(**vals))
                else:
                    c.execute(models.telegram_bot_users.insert().values(id=str(uuid.uuid4()), bot_row_id=self.key,
                                                                        telegram_user_id=frm["id"], created_at=now,
                                                                        **vals))
        if status is None:
            await self._refuse(chat_id, int(frm["id"]))
            return
        audit(f"telegram:{frm['id']}@bot:{self.key[:8]}", f"agentbot.pairing.{status}", self.key)
        bus.publish("bot.state.changed", {"bot_id": self.key, "pairing": status, "telegram_user_id": frm["id"]},
                    agent_id=self.fixed_agent)
        if status == "approved":
            await self.api.send_message(chat_id, "✅ Paired (you are already a verified NEBULA owner). Send me a task, "
                                                 "a voice message or files.\n\n" + tg3.HELP_V3.split("\n\n")[0])
        else:
            await self.api.send_message(chat_id, f"Pairing request received (Telegram user ID {frm['id']}). Approve "
                                                 "it in the NEBULA Dashboard → Telegram Bot Network.")

    # ------------------------------------------------------------------ messages
    async def on_message(self, m: dict[str, Any]) -> None:
        chat, frm = m.get("chat", {}), m.get("from", {})
        chat_id, tg_uid = int(chat.get("id", 0)), int(frm.get("id", 0))
        if frm.get("is_bot") or chat.get("type") != "private":
            return
        text = (m.get("text") or m.get("caption") or "").strip()
        cmd, args = None, ""
        if text.startswith("/"):
            head, _, rest = text.partition(" ")
            c_ = head[1:].split("@", 1)[0].lower()
            cmd, args = (c_ if re.match(r"^[a-z_]{1,32}$", c_) else None), rest.strip()
        if cmd == "start" and args:
            await self._pair(m, args.split()[0])
            return
        user = self._user(tg_uid, chat_id)
        if user is None:
            await self._refuse(chat_id, tg_uid)
            return
        if not self._rate_ok(tg_uid):
            await self.api.send_message(chat_id, "Rate limit: please slow down.")
            return
        if cmd:
            await self._command(user, cmd, args)
            return
        if await tg3.handle_message(self, user, self.fixed_agent, m, chat_id, None):
            return
        if text:
            await tg3.create_task(self, user, self.fixed_agent, text, chat_id, None,
                                  attachment_ids=tg3.take_pending(self.key, chat_id))

    async def _command(self, user: dict[str, Any], cmd: str, args: str) -> None:
        chat_id = user["chat_id"]
        needs = access.command_needs(cmd, args)
        if needs is None and not access.is_owner(user):
            await self.api.send_message(chat_id, "Unknown command. /help")
            return
        if not await access.require(self, user, needs, chat_id, None, what=f"/{cmd}"):
            return  # owner-only commands stay the owner's on an agent bot too
        if await tg3.command(self, user, cmd, args, None, self.fixed_agent):
            return
        from nebula_host import voice

        if cmd in ("start",):
            await self.api.send_message(chat_id, tg3.HELP_V3)
        elif cmd == "status":
            await self.api.send_message(chat_id, voice.status_summary(self.fixed_agent))
        elif cmd in ("pause", "resume", "stop"):
            with db.engine().connect() as c:
                states = ["PAUSED", "WAITING_PROVIDER"] if cmd == "resume" else None
                q = select(models.tasks).where(models.tasks.c.agent_id == self.fixed_agent)
                q = q.where(models.tasks.c.state.in_(states)) if states else \
                    q.where(models.tasks.c.state.notin_(["COMPLETED", "FAILED", "CANCELLED"]))
                t = db.row(c.execute(q.order_by(models.tasks.c.created_at.desc())).first())
            if not t:
                await self.api.send_message(chat_id, "No matching task.")
                return
            r = self.orch.pause(t["id"], "smart") if cmd == "pause" else self.orch.resume(t["id"]) \
                if cmd == "resume" else await self.orch.stop(t["id"], "cancel")
            audit(tg3.actor(self, user), f"task.{cmd}", t["id"])
            task_cards.touch(t["id"], final=True)
            await self.api.send_message(chat_id, f"Task #{t['id'][:8]}: {r['state']}")
        elif cmd == "screenshot":
            await tg3._screenshot(self, self.fixed_agent, chat_id, None, f"Screenshot · {time.strftime('%H:%M:%S')}")
        elif cmd in ("history", "files", "get"):
            from nebula_telegram import v2 as tg2

            fake_user = {**user}
            await tg2.command(self, fake_user, cmd, args, None, self.fixed_agent)
        else:
            await self.api.send_message(chat_id, "Unknown command. /help")

    async def on_callback(self, q: dict[str, Any]) -> None:
        frm, msg = q.get("from", {}), q.get("message") or {}
        chat_id = int((msg.get("chat") or {}).get("id", 0))
        user = self._user(int(frm.get("id", 0)), chat_id)
        if user is None:
            await self.api.answer_callback(q["id"], "Not authorized")
            return
        data = q.get("data", "")
        if not await access.require(self, user, access.callback_needs(data), chat_id, None, q=q,
                                    what=data.split(":", 1)[0], target=access.approval_id_of(data)):
            return  # approvals: only the NEBULA owner's own Telegram account, on an agent bot too
        if await tg3.callback(self, user, q, data, chat_id, None):
            return
        if data.startswith("dl:"):
            from nebula_runtime.orchestrator import get_task

            from nebula_telegram import v2 as tg2

            try:
                if get_task(data.split(":")[1])["agent_id"] != self.fixed_agent:
                    await self.api.answer_callback(q["id"], "Not this agent's task", alert=True)
                    return
            except (KeyError, IndexError):
                await self.api.answer_callback(q["id"], "Unknown task")
                return
            await tg2.callback(self, {**user}, q, data, chat_id, None)
            return
        await self.api.answer_callback(q["id"])

    # ------------------------------------------------------------------ notifications
    async def on_event(self, ev: dict[str, Any]) -> None:
        t, tid = ev["type"], ev.get("task_id")
        if not tid or not t.startswith("task."):
            return
        with db.engine().connect() as c:
            row = c.execute(select(models.tasks.c.reply_target, models.tasks.c.agent_id).where(
                models.tasks.c.id == tid)).first()
        if not row or (row.reply_target or {}).get("bot") != self.key:
            return
        rt = row.reply_target
        if t == "task.approval.requested":
            lv = cardmod.level_of(self.key, rt["chat_id"])
            if access.is_owner_id(access.requester(rt)):  # the owner asked through this bot: decide it here
                await tg3.send_approval(self, rt["chat_id"], None, ev, silent=lv == "silent")
            else:  # anybody else: the card goes to the owner's main-bot chat (TelegramGateway._notify)
                await tg3.send_waiting_note(self, rt["chat_id"], None, ev, silent=lv == "silent")
        elif t in ("task.completed", "task.failed", "task.cancelled"):
            await tg3.deliver_result(self, ev)
            if t == "task.completed":
                from nebula_telegram import v2 as tg2

                await tg2.result_buttons(self, rt["chat_id"], None, tid, (ev.get("payload") or {}).get("result") or {})
        elif t == "task.message":
            await tg3.forward_question(self, ev, rt)


class AgentBotManager:
    def __init__(self, cfg, orch, guest) -> None:
        self.cfg, self.orch, self.guest = cfg, orch, guest
        self.svc: Any = None
        self.runners: dict[str, AgentBotRunner] = {}
        bus.add_listener(self.on_event)

    async def start(self) -> None:
        with db.engine().connect() as c:
            rows = db.rows(c.execute(select(models.telegram_bots).where(models.telegram_bots.c.enabled.is_(True))))
        for r in rows:
            if sec.store().get(r["keychain_ref"]):
                self._run(r)

    def _run(self, row: dict[str, Any]) -> None:
        if row["id"] in self.runners:
            return
        rn = AgentBotRunner(self, row)
        self.runners[row["id"]] = rn
        rn.start()

    async def stop(self) -> None:
        bus.remove_listener(self.on_event)
        for rn in list(self.runners.values()):
            await rn.stop()
        self.runners.clear()

    async def on_event(self, ev: dict[str, Any]) -> None:
        for rn in list(self.runners.values()):
            try:
                await rn.on_event(ev)
            except TelegramError as e:
                log.warning("agent bot %s notification failed: %s", rn.key, e)
            except Exception:  # noqa: BLE001
                log.exception("agent bot notification error")

    def list(self) -> list[dict[str, Any]]:
        with db.engine().connect() as c:
            rows = db.rows(c.execute(select(models.telegram_bots).order_by(models.telegram_bots.c.created_at)))
        return [public(r, self.runners.get(r["id"])) for r in rows]

    async def add(self, agent_id: str, token: str, actor: str, *, configure: bool = True) -> dict[str, Any]:
        token = (token or "").strip()
        if not TOKEN_RE.match(token):
            raise BotError("this does not look like a BotFather token (123456789:AA…)")
        with db.engine().connect() as c:
            agent = db.row(c.execute(select(models.agents).where(models.agents.c.id == agent_id)).first())
            if not agent:
                raise BotError("agent not found", 404, "agent_not_found")
            if c.execute(select(models.telegram_bots.c.id).where(models.telegram_bots.c.agent_id == agent_id)).first():
                raise BotError("this agent already has a bot; remove the binding first", 409, "exists")
            n = len(c.execute(select(models.telegram_bots.c.id)).all())
            main_bot = c.execute(select(models.telegram_config.c.bot_id).where(models.telegram_config.c.id == 1)).scalar()
        if n >= MAX_BOTS:
            raise BotError(f"at most {MAX_BOTS} agent bots")
        probe = BotAPI(lambda: token, self.cfg.telegram.api_base)
        try:
            me = await probe.get_me()
        except TelegramError as e:
            raise BotError(f"Telegram rejected the token ({e.code}: {e.description})", 400, "token_invalid") from e
        finally:
            await probe.close()
        if main_bot and int(me["id"]) == int(main_bot):
            raise BotError("this is the main NEBULA bot's token — create a separate bot for the agent", 409, "collision")
        with db.engine().connect() as c:
            if c.execute(select(models.telegram_bots.c.id).where(models.telegram_bots.c.bot_id == int(me["id"]))).first():
                raise BotError("this bot is already bound to another agent", 409, "collision")
        rid = str(uuid.uuid4())
        sec.store().set(_ref(rid), token)
        now = db.now()
        with db.engine().begin() as c:
            c.execute(models.telegram_bots.insert().values(
                id=rid, agent_id=agent_id, bot_id=int(me["id"]), username=me.get("username"),
                display_name=me.get("first_name"), keychain_ref=_ref(rid), enabled=True, status="ACTIVE",
                update_offset=0, created_at=now, updated_at=now))
        audit(actor, "agentbot.add", rid, {"agent_id": agent_id, "username": me.get("username")})
        meta = await self.configure(rid, agent) if configure else {}
        self._run(get_bot(rid))
        bus.publish("bot.state.changed", {"bot_id": rid, "status": "ACTIVE", "username": me.get("username")},
                    agent_id=agent_id)
        return {**public(get_bot(rid), self.runners.get(rid)), "metadata": meta}

    async def configure(self, row_id: str, agent: dict[str, Any] | None = None) -> dict[str, Any]:
        """Bot metadata supported by the Bot API (the profile photo can only be changed in @BotFather)."""
        r = get_bot(row_id)
        if agent is None:
            with db.engine().connect() as c:
                agent = db.row(c.execute(select(models.agents).where(models.agents.c.id == r["agent_id"])).first())
        api = BotAPI(lambda: sec.store().get(r["keychain_ref"]), self.cfg.telegram.api_base)
        out: dict[str, Any] = {"avatar": "set it in @BotFather → /setuserpic (not possible through the Bot API)"}
        try:
            for name, coro in (("commands", api.set_my_commands(AGENT_COMMANDS)),
                               ("description", api.set_my_description(
                                   f"NEBULA agent {agent['name']}. {agent.get('description') or ''}".strip())),
                               ("short_description", api.set_my_short_description(f"NEBULA agent {agent['name']}"))):
                try:
                    await coro
                    out[name] = "ok"
                except TelegramError as e:
                    out[name] = f"failed: {e.description}"
            try:
                from nebula_host import remote

                url = remote.public_base()
                if url:
                    await api.set_chat_menu_button(f"{url}/mini/#/agents/{r['agent_id']}")
                    out["menu_button"] = "Mini App"
            except Exception as e:  # noqa: BLE001
                out["menu_button"] = f"skipped: {e}"
        finally:
            await api.close()
        return out

    def create_pairing(self, row_id: str, actor: str) -> dict[str, Any]:
        from nebula_telegram.gateway import code_hash

        r = get_bot(row_id)
        if not r["enabled"]:
            raise BotError("enable the bot first", 409)
        code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(8))
        pid = str(uuid.uuid4())
        now = db.now()
        exp = now + self.cfg.telegram.pairing_ttl_seconds
        with db.engine().begin() as c:
            c.execute(models.telegram_pairings.insert().values(id=pid, code_hash=code_hash(code), expires_at=exp,
                                                               created_at=now, bot_row_id=row_id))
        audit(actor, "agentbot.pairing.create", row_id)
        return {"pairing_id": pid, "code": code, "expires_at": exp,
                "deep_link": f"https://t.me/{r['username']}?start={code}" if r["username"] else None,
                "instructions": f"Send /start {code} to @{r['username']} within "
                                f"{self.cfg.telegram.pairing_ttl_seconds // 60} minutes."}

    def approve_user(self, row_id: str, user_row_id: str, actor: str, approve: bool = True) -> dict[str, Any]:
        with db.engine().begin() as c:
            n = c.execute(update(models.telegram_bot_users).where(and_(
                models.telegram_bot_users.c.id == user_row_id, models.telegram_bot_users.c.bot_row_id == row_id))
                .values(status="approved" if approve else "revoked", approved_at=db.now() if approve else None)).rowcount
        if not n:
            raise BotError("no such pairing for this bot", 404)
        from nebula_host import miniapp

        ended = 0
        if not approve:  # M-01: a revoked user's open Mini App sessions of this bot end now
            with db.engine().connect() as c:
                tg = c.execute(select(models.telegram_bot_users.c.telegram_user_id)
                               .where(models.telegram_bot_users.c.id == user_row_id)).scalar()
            ended = miniapp.end_sessions_for(int(tg), row_id, actor) if tg else 0
        miniapp.forget_identity_cache()
        audit(actor, "agentbot.user." + ("approve" if approve else "revoke"), user_row_id,
              {"bot": row_id, "sessions_ended": ended})
        return public(get_bot(row_id), self.runners.get(row_id))

    async def set_enabled(self, row_id: str, enabled: bool, actor: str) -> dict[str, Any]:
        r = get_bot(row_id)
        with db.engine().begin() as c:
            c.execute(update(models.telegram_bots).where(models.telegram_bots.c.id == row_id).values(
                enabled=enabled, status="ACTIVE" if enabled else "DISABLED", updated_at=db.now(),
                last_error=None if enabled else r["last_error"]))
        from nebula_host import miniapp

        if not enabled:  # NEW-1: every user's open Mini App session of this bot ends now (not after a cache expiry)
            miniapp.end_bot_sessions(row_id, actor)
        miniapp.forget_identity_cache()
        if enabled:
            if not sec.store().get(r["keychain_ref"]):
                raise BotError("the token is missing; remove and re-add the bot", 409)
            await self.reconnect(row_id, actor, audit_it=False)
        else:
            rn = self.runners.pop(row_id, None)
            if rn:
                await rn.stop()
        audit(actor, "agentbot.enable" if enabled else "agentbot.disable", row_id)
        bus.publish("bot.state.changed", {"bot_id": row_id, "status": "ACTIVE" if enabled else "DISABLED"},
                    agent_id=r["agent_id"])
        return public(get_bot(row_id), self.runners.get(row_id))

    async def reconnect(self, row_id: str, actor: str, audit_it: bool = True) -> dict[str, Any]:
        rn = self.runners.pop(row_id, None)
        if rn:
            await rn.stop()
        r = get_bot(row_id)
        if r["enabled"]:
            self._run(r)
        if audit_it:
            audit(actor, "agentbot.reconnect", row_id)
        return public(get_bot(row_id), self.runners.get(row_id))

    async def remove(self, row_id: str, actor: str) -> dict[str, Any]:
        r = get_bot(row_id)
        rn = self.runners.pop(row_id, None)
        if rn:
            await rn.stop()
        sec.store().delete(r["keychain_ref"])
        with db.engine().begin() as c:
            c.execute(models.telegram_bots.delete().where(models.telegram_bots.c.id == row_id))
            c.execute(models.telegram_bot_updates.delete().where(models.telegram_bot_updates.c.bot_row_id == row_id))
        from nebula_host import miniapp

        miniapp.end_bot_sessions(row_id, actor)  # NEW-1: also clears the identity cache
        audit(actor, "agentbot.remove", row_id, {"agent_id": r["agent_id"], "username": r["username"]})
        bus.publish("bot.state.changed", {"bot_id": row_id, "status": "REMOVED"}, agent_id=r["agent_id"])
        return {"removed": row_id, "note": "the bot still exists in Telegram; delete it in @BotFather if you wish"}

    def status(self) -> dict[str, Any]:
        rows = self.list()
        return {"bots": len(rows), "polling": sum(1 for r in rows if r["polling"]),
                "errors": sum(1 for r in rows if r["status"] in ("ERROR", "REVOKED"))}


def token_fingerprint(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()[:12]
