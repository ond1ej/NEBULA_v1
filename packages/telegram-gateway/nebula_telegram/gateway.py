"""Telegram gateway (spec §7): single-leader long polling, durable offset + update_id dedup, one-time pairing
with dashboard approval, private-chat topics per agent (fallback: /use + inline keyboard), command set,
screenshots, documents, approvals and task notifications. The bot token never leaves the host."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import logging
import os
import re
import secrets
import socket
import time
import uuid
from collections import defaultdict, deque
from pathlib import Path
from typing import Any

from nebula_host import db, models
from nebula_host import secrets as sec
from nebula_host.events import audit, bus
from sqlalchemy import and_, select, update
from sqlalchemy.exc import IntegrityError

from nebula_telegram.botapi import BotAPI, TelegramError

log = logging.getLogger("nebula.telegram")
TOKEN_REF = "nebula:telegram.bot_token"
TOKEN_RE = re.compile(r"^\d{5,15}:[A-Za-z0-9_-]{30,64}$")
CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
ALLOWED_MIME = re.compile(r"^(text/.*|application/(pdf|json|zip|x-zip-compressed|csv|xml|"
                          r"vnd\.openxmlformats-officedocument\..*)|image/(png|jpeg|webp|gif))$")
SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]+")
from nebula_telegram import access  # noqa: E402  (owner / operator roles in the chat)
from nebula_telegram import cards as cardmod  # noqa: E402
from nebula_telegram import v2 as tg2  # noqa: E402  (Telegram 2.0 features)
from nebula_telegram import v3 as tg3  # noqa: E402  (Telegram 3.0: cards, voice 2.0, multimodal, companies)
from nebula_telegram.cards import cards as task_cards  # noqa: E402

HELP = tg3.HELP_V3


def _stale_local_leader(leader_id: str) -> bool:
    """A lease left by a previous NEBULA process on THIS Mac whose process is gone (e.g. killed during a restart)
    can be taken over at once instead of waiting for the lease to expire."""
    parts = leader_id.split(":")
    if len(parts) < 3 or parts[0] != socket.gethostname() or not parts[1].isdigit():
        return False
    try:
        os.kill(int(parts[1]), 0)
    except ProcessLookupError:
        return True
    except PermissionError:
        return False
    return False


def code_hash(code: str) -> str:
    return hashlib.sha256(code.strip().upper().encode()).hexdigest()


def get_cfg_row() -> dict[str, Any]:
    with db.engine().begin() as c:
        r = c.execute(select(models.telegram_config).where(models.telegram_config.c.id == 1)).first()
        if r is None:
            c.execute(models.telegram_config.insert().values(id=1, enabled=False, update_offset=0, updated_at=db.now()))
            r = c.execute(select(models.telegram_config).where(models.telegram_config.c.id == 1)).first()
    return dict(r._mapping)


def set_cfg(**vals: Any) -> None:
    get_cfg_row()
    vals["updated_at"] = db.now()
    with db.engine().begin() as c:
        c.execute(update(models.telegram_config).where(models.telegram_config.c.id == 1).values(**vals))


class TelegramGateway:
    def __init__(self, cfg, orchestrator, guest, agent_creator=None) -> None:
        self.cfg = cfg
        self.orch = orchestrator
        self.guest = guest
        self.agent_creator = agent_creator  # async (body) -> agent
        self.api = BotAPI(lambda: sec.store().get(TOKEN_REF), cfg.telegram.api_base)
        self.instance_id = f"{socket.gethostname()}:{os.getpid()}:{uuid.uuid4().hex[:8]}"
        self._task: asyncio.Task | None = None
        self._rate: dict[int, deque] = defaultdict(deque)
        self._refused: dict[int, float] = {}
        self._wizard: dict[int, dict[str, Any]] = {}
        self._status_msgs: dict[str, tuple[int, int, float]] = {}  # task_id -> (chat, msg_id, last_edit)
        self.v2 = None  # V2 service container (teams, schedules, workflows, files), set by the app
        self._model_choices: dict[int, list[str]] = {}
        self._asked: dict[str, float] = {}
        self.running = False
        self.last_error: str | None = None
        self.key = "main"  # V3 bot context (shared helpers in nebula_telegram.v3)
        self.fixed_agent: str | None = None
        task_cards.register("main", self.api)
        bus.add_listener(self.on_event)

    @property
    def svc(self):
        return self.v2

    # ------------------------------------------------------------ setup
    async def set_token(self, token: str, actor: str) -> dict[str, Any]:
        token = token.strip()
        if not TOKEN_RE.match(token):
            raise ValueError("this does not look like a BotFather token")
        probe = BotAPI(lambda: token, self.cfg.telegram.api_base)
        try:
            me = await probe.get_me()
        finally:
            await probe.close()
        sec.store().set(TOKEN_REF, token)
        set_cfg(enabled=True, bot_id=me["id"], bot_username=me.get("username"), keychain_ref=TOKEN_REF,
                has_topics_enabled=bool(me.get("has_topics_enabled")),
                allows_users_to_create_topics=bool(me.get("allows_users_to_create_topics")), last_error=None)
        audit(actor, "telegram.token.set", me.get("username"))
        await self.start()
        return self.public_status()

    async def test(self) -> dict[str, Any]:
        me = await self.api.get_me()
        set_cfg(bot_id=me["id"], bot_username=me.get("username"), has_topics_enabled=bool(me.get("has_topics_enabled")),
                allows_users_to_create_topics=bool(me.get("allows_users_to_create_topics")))
        return {"ok": True, "bot": {"id": me["id"], "username": me.get("username"), "first_name": me.get("first_name"),
                                    "has_topics_enabled": bool(me.get("has_topics_enabled")),
                                    "allows_users_to_create_topics": bool(me.get("allows_users_to_create_topics"))}}

    async def disconnect(self, actor: str) -> dict[str, Any]:
        await self.stop()
        sec.store().delete(TOKEN_REF)
        set_cfg(enabled=False, keychain_ref=None, leader_id=None, leader_lease_until=None)
        audit(actor, "telegram.disconnect", None)
        return self.public_status()

    def public_status(self) -> dict[str, Any]:
        r = get_cfg_row()
        with db.engine().connect() as c:
            users = db.rows(c.execute(select(models.telegram_users).order_by(models.telegram_users.c.created_at)))
            topics = db.rows(c.execute(select(models.telegram_topics)))
        from nebula_host import authz

        owner = authz.primary_owner_telegram_id()
        for u in users:
            u["owner"] = bool(owner and u["status"] == "approved" and u["telegram_user_id"] == owner)
        return {"enabled": r["enabled"], "configured": bool(sec.store().get(TOKEN_REF)), "polling": self.running,
                "owner_telegram_user_id": owner, "designated_owner_telegram_user_id":
                    authz.designated_owner_telegram_id(),
                "bot_username": r["bot_username"], "bot_id": r["bot_id"],
                "topics_mode": "private_topics" if r["has_topics_enabled"] else "command_fallback",
                "has_topics_enabled": r["has_topics_enabled"], "update_offset": r["update_offset"],
                "last_poll_at": r["last_poll_at"], "last_error": r["last_error"] or self.last_error,
                "users": users, "topics": topics,
                "note": "Telegram is an external service; messages are not end-to-end encrypted."}

    def create_pairing(self, actor: str) -> dict[str, Any]:
        r = get_cfg_row()
        if not r["enabled"]:
            raise ValueError("configure the bot token first")
        code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(8))
        pid = str(uuid.uuid4())
        now = db.now()
        exp = now + self.cfg.telegram.pairing_ttl_seconds
        with db.engine().begin() as c:
            c.execute(models.telegram_pairings.insert().values(id=pid, code_hash=code_hash(code), expires_at=exp,
                                                               created_at=now))
        audit(actor, "telegram.pairing.create", pid)
        link = f"https://t.me/{r['bot_username']}?start={code}" if r["bot_username"] else None
        return {"pairing_id": pid, "code": code, "expires_at": exp, "deep_link": link,
                "instructions": f"Send /start {code} to @{r['bot_username']} within "
                                f"{self.cfg.telegram.pairing_ttl_seconds // 60} minutes, then approve it here."}

    async def approve(self, pairing_or_user_id: str, actor: str, *, make_owner: bool = False) -> dict[str, Any]:
        """Approve a pending main-bot identity as an operator (tasks, commands, screenshot). The very first approved
        account becomes the owner automatically; afterwards only `make_owner=True` (an explicit owner choice on
        the Dashboard) designates the owner's account — an operator is never promoted silently."""
        with db.engine().begin() as c:
            u = c.execute(select(models.telegram_users).where(
                (models.telegram_users.c.pairing_id == pairing_or_user_id) |
                (models.telegram_users.c.id == pairing_or_user_id))).first()
            if u is None:
                raise LookupError("no pending Telegram identity for this pairing")
            already = u.status == "approved"
            if not already:
                c.execute(update(models.telegram_users).where(models.telegram_users.c.id == u.id)
                          .values(status="approved", approved_at=db.now(),
                                  permissions=["tasks", "commands", "screenshot"]))
        from nebula_host import authz, miniapp

        authz.forget_owner_cache()
        miniapp.forget_identity_cache()
        if make_owner:
            authz.set_owner_telegram_id(int(u.telegram_user_id), actor=actor)
        if already:
            return dict(u._mapping)
        audit(actor, "telegram.pairing.approve", str(u.telegram_user_id), {"chat_id": u.chat_id})
        bus.publish("telegram.paired", {"telegram_user_id": u.telegram_user_id, "chat_id": u.chat_id,
                                        "username": u.username})
        try:
            await self.api.send_message(u.chat_id, "✅ Paired with NEBULA. Setting up your agents…")
            await self.sync_topics_for_user(u.chat_id)
            await self.api.send_message(u.chat_id, HELP)
        except TelegramError as e:
            log.warning("post-approval message failed: %s", e)
        with db.engine().connect() as c:
            return db.row(c.execute(select(models.telegram_users).where(models.telegram_users.c.id == u.id)).first())

    def revoke(self, user_row_id: str, actor: str) -> None:
        """Revoke a main-bot identity and end its open Mini App sessions (M-01). Revoking the owner's account
        leaves no Telegram owner until the owner designates one again (M-02)."""
        with db.engine().begin() as c:
            tg = c.execute(select(models.telegram_users.c.telegram_user_id)
                           .where(models.telegram_users.c.id == user_row_id)).scalar()
            c.execute(update(models.telegram_users).where(models.telegram_users.c.id == user_row_id)
                      .values(status="revoked"))
        from nebula_host import authz, miniapp

        authz.forget_owner_cache()
        ended = miniapp.end_sessions_for(int(tg), "main", actor) if tg else 0
        audit(actor, "telegram.user.revoke", user_row_id, {"sessions_ended": ended})

    # ------------------------------------------------------------ lifecycle
    async def start(self) -> None:
        if self._task and not self._task.done():
            return
        if not get_cfg_row()["enabled"] or not sec.store().get(TOKEN_REF):
            return
        self._task = asyncio.create_task(self._poll_loop(), name="telegram-poll")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        self.running = False
        set_cfg(leader_id=None, leader_lease_until=None)

    def _acquire_leader(self) -> bool:
        now = time.time()
        with db.engine().begin() as c:
            r = c.execute(select(models.telegram_config.c.leader_id, models.telegram_config.c.leader_lease_until)
                          .where(models.telegram_config.c.id == 1)).first()
            if r and r.leader_id and r.leader_id != self.instance_id and (r.leader_lease_until or 0) > now \
                    and not _stale_local_leader(r.leader_id):
                return False
            c.execute(update(models.telegram_config).where(models.telegram_config.c.id == 1)
                      .values(leader_id=self.instance_id, leader_lease_until=now + 90))
        return True

    async def _poll_loop(self) -> None:
        backoff = 1
        while True:
            if not self._acquire_leader():
                self.running = False
                self.last_error = "another NEBULA instance is polling this bot"
                await asyncio.sleep(15)
                continue
            self.running = True
            try:
                offset = get_cfg_row()["update_offset"]
                t0 = time.monotonic()
                updates = await self.api.get_updates(offset, self.cfg.telegram.poll_timeout_seconds)
                set_cfg(last_poll_at=db.now(), last_error=None)
                self.last_error = None
                backoff = 1
                for upd in updates:
                    await self._process(upd)
                if not updates and time.monotonic() - t0 < 0.5:
                    await asyncio.sleep(1.0)  # never spin when the long poll returns instantly
            except asyncio.CancelledError:
                self.running = False
                raise
            except TelegramError as e:
                self.last_error = str(e)
                set_cfg(last_error=str(e)[:500])
                if e.code == 401:
                    log.error("telegram token rejected; polling disabled")
                    set_cfg(enabled=False)
                    self.running = False
                    return
                if e.code == 409:  # webhook set or another poller
                    log.warning("telegram 409 conflict: %s", e.description)
                await asyncio.sleep(min(backoff, 60))
                backoff *= 2
            except Exception as e:  # noqa: BLE001
                log.exception("telegram poll failed")
                self.last_error = f"{type(e).__name__}: {e}"
                await asyncio.sleep(min(backoff, 60))
                backoff *= 2

    async def _process(self, upd: dict[str, Any]) -> None:
        uid = int(upd["update_id"])
        try:
            with db.engine().begin() as c:
                c.execute(models.telegram_updates.insert().values(update_id=uid, processed=False, received_at=db.now()))
        except IntegrityError:
            with db.engine().connect() as c:
                done = c.execute(select(models.telegram_updates.c.processed)
                                 .where(models.telegram_updates.c.update_id == uid)).scalar()
            if done:
                set_cfg(update_offset=max(get_cfg_row()["update_offset"], uid + 1))
                return  # duplicate delivery
        err = None
        try:
            if "message" in upd:
                await self.on_message(upd["message"])
            elif "callback_query" in upd:
                await self.on_callback(upd["callback_query"])
        except Exception as e:  # noqa: BLE001 - one bad update must not stall the queue
            log.exception("update %s failed", uid)
            err = f"{type(e).__name__}: {e}"[:500]
        with db.engine().begin() as c:
            c.execute(update(models.telegram_updates).where(models.telegram_updates.c.update_id == uid)
                      .values(processed=True, error=err))
            c.execute(update(models.telegram_config).where(models.telegram_config.c.id == 1)
                      .values(update_offset=uid + 1))

    # ------------------------------------------------------------ authorization
    def _user(self, tg_user_id: int, chat_id: int) -> dict[str, Any] | None:
        with db.engine().connect() as c:
            return db.row(c.execute(select(models.telegram_users).where(and_(
                models.telegram_users.c.telegram_user_id == tg_user_id, models.telegram_users.c.chat_id == chat_id,
                models.telegram_users.c.status == "approved"))).first())

    def _rate_ok(self, tg_user_id: int) -> bool:
        q = self._rate[tg_user_id]
        now = time.time()
        while q and now - q[0] > 60:
            q.popleft()
        if len(q) >= self.cfg.telegram.rate_limit_per_minute:
            return False
        q.append(now)
        return True

    async def _refuse(self, chat_id: int, tg_user_id: int) -> None:
        if time.time() - self._refused.get(tg_user_id, 0) > 3600:
            self._refused[tg_user_id] = time.time()
            try:
                await self.api.send_message(chat_id, "This is a private NEBULA bot. Access requires pairing by its owner.")
            except TelegramError:
                pass

    # ------------------------------------------------------------ messages
    async def on_message(self, m: dict[str, Any]) -> None:
        chat = m.get("chat", {})
        frm = m.get("from", {})
        chat_id, tg_uid = int(chat.get("id", 0)), int(frm.get("id", 0))
        if frm.get("is_bot"):
            return
        text = (m.get("text") or m.get("caption") or "").strip()
        thread_id = m.get("message_thread_id")
        cmd, args = self._parse_command(text)
        if chat.get("type") != "private":
            return  # V1 pairs private chats only (supergroup topics: future option, see docs)
        if cmd == "start" and args:
            await self._pair(m, args.split()[0])
            return
        user = self._user(tg_uid, chat_id)
        if user is None:
            await self._refuse(chat_id, tg_uid)
            return
        if not self._rate_ok(tg_uid):
            await self.api.send_message(chat_id, "Rate limit: please slow down.", thread_id)
            return
        if chat_id in self._wizard and not cmd:
            if access.is_owner(user):  # /newagent is the owner's; a wizard never survives for anybody else
                await self._wizard_step(user, text, thread_id)
                return
            self._wizard.pop(chat_id, None)
        if cmd:
            await self._command(user, cmd, args, thread_id)
            return
        # Voice notes and video notes are checked by tg3.voice_message once the transcript says what was meant
        # (access.VOICE_INTENTS: a status question needs nothing, a task needs `tasks`, pause/stop need `commands`).
        # Same test as tg3.handle_message, so every other message kind still needs `tasks` here (R12-2).
        is_voice_note = bool(m.get("voice") or m.get("video_note"))
        if not is_voice_note and not await access.require(self, user, access.MESSAGE, chat_id, thread_id,
                                                          what="message"):
            return  # text and files become tasks: an operator needs the tasks permission
        agent_id = self._route(user, chat_id, thread_id)
        if agent_id is None:
            await self._choose_agent(chat_id, thread_id, "Choose which agent should handle this:")
            return
        if await tg3.handle_message(self, user, agent_id, m, chat_id, thread_id):
            return  # voice / photos / documents / audio / video (V3 multimodal + voice 2.0)
        if not text:
            return
        await tg3.create_task(self, user, agent_id, text, chat_id, thread_id,
                              attachment_ids=tg3.take_pending(self.key, chat_id))

    def _parse_command(self, text: str) -> tuple[str | None, str]:
        if not text.startswith("/"):
            return None, ""
        head, _, rest = text.partition(" ")
        cmd = head[1:].split("@", 1)[0].lower()
        return (cmd if re.match(r"^[a-z_]{1,32}$", cmd) else None), rest.strip()

    async def _pair(self, m: dict[str, Any], code: str) -> None:
        chat_id, frm = int(m["chat"]["id"]), m["from"]
        now = time.time()
        with db.engine().begin() as c:
            p = c.execute(select(models.telegram_pairings).where(models.telegram_pairings.c.code_hash == code_hash(code))).first()
            if p is None or p.used_at or p.expires_at < now:
                ok = False
            else:
                ok = True
                c.execute(update(models.telegram_pairings).where(models.telegram_pairings.c.id == p.id)
                          .values(used_at=now, telegram_user_id=frm["id"], chat_id=chat_id))
                existing = c.execute(select(models.telegram_users).where(and_(
                    models.telegram_users.c.telegram_user_id == frm["id"],
                    models.telegram_users.c.chat_id == chat_id))).first()
                name = " ".join(x for x in (frm.get("first_name"), frm.get("last_name")) if x)[:128]
                if existing:
                    if existing.status != "approved":
                        c.execute(update(models.telegram_users).where(models.telegram_users.c.id == existing.id)
                                  .values(status="pending", pairing_id=p.id, username=frm.get("username"),
                                          display_name=name))
                else:
                    c.execute(models.telegram_users.insert().values(
                        id=str(uuid.uuid4()), telegram_user_id=frm["id"], chat_id=chat_id, username=frm.get("username"),
                        display_name=name, status="pending", permissions=[], pairing_id=p.id, created_at=now))
        if not ok:
            await self._refuse(chat_id, int(frm["id"]))
            return
        bus.publish("telegram.pairing.pending", {"pairing_id": p.id, "telegram_user_id": frm["id"], "chat_id": chat_id,
                                                 "username": frm.get("username")})
        await self.api.send_message(chat_id, f"Pairing request received.\nTelegram user ID: {frm['id']}\nChat ID: "
                                             f"{chat_id}\nConfirm these numbers in your local NEBULA Dashboard "
                                             "(Telegram page). No access is granted until you approve.")

    def _route(self, user: dict[str, Any], chat_id: int, thread_id: int | None) -> str | None:
        with db.engine().connect() as c:
            if thread_id:
                r = c.execute(select(models.telegram_topics.c.agent_id).where(and_(
                    models.telegram_topics.c.telegram_chat_id == chat_id,
                    models.telegram_topics.c.message_thread_id == thread_id,
                    models.telegram_topics.c.archived.is_(False)))).first()
                if r:
                    return r.agent_id
            sel = user.get("selected_agent_id")
            if sel and c.execute(select(models.agents.c.id).where(models.agents.c.id == sel)).first():
                return sel
        return None

    async def _choose_agent(self, chat_id: int, thread_id: int | None, text: str) -> None:
        agents = self._agents()
        if not agents:
            await self.api.send_message(chat_id, "No agents yet. Use /newagent or create one in the Dashboard.", thread_id)
            return
        kb = {"inline_keyboard": [[{"text": f"{a['name']} · {a['status']}", "callback_data": f"use:{a['id']}"}]
                                  for a in agents[:20]]}
        await self.api.send_message(chat_id, text, thread_id, reply_markup=kb)

    def _agents(self) -> list[dict[str, Any]]:
        with db.engine().connect() as c:
            return db.rows(c.execute(select(models.agents.c.id, models.agents.c.name, models.agents.c.status,
                                            models.agents.c.provider_id, models.agents.c.model_id)
                                     .order_by(models.agents.c.created_at)))

    def _current_task(self, agent_id: str) -> dict[str, Any] | None:
        with db.engine().connect() as c:
            return db.row(c.execute(select(models.tasks).where(and_(
                models.tasks.c.agent_id == agent_id,
                models.tasks.c.state.notin_(["COMPLETED", "FAILED", "CANCELLED"])))
                .order_by(models.tasks.c.created_at.desc())).first())

    async def _command(self, user: dict[str, Any], cmd: str, args: str, thread_id: int | None) -> None:
        chat_id = user["chat_id"]
        send = lambda t, **kw: self.api.send_message(chat_id, t, thread_id, **kw)  # noqa: E731
        needs = access.command_needs(cmd, args)
        if needs is None and not access.is_owner(user):
            await send("Unknown command. /help")  # deny by default: an unmapped command is the owner's only
            return
        if not await access.require(self, user, needs, chat_id, thread_id, what=f"/{cmd}"):
            return  # operators: exactly their stored permissions; administration and approvals: the owner only
        agent_id = self._route(user, chat_id, thread_id)
        if cmd not in ("start", "agents", "use", "newagent", "status", "pause", "resume", "stop", "screenshot") and \
                await tg3.command(self, user, cmd, args, thread_id, agent_id):
            return
        if cmd not in ("start", "agents", "use", "newagent", "status", "pause", "resume", "stop", "screenshot") and \
                await tg2.command(self, user, cmd, args, thread_id, agent_id):
            return
        if cmd in ("start", "help"):
            await send(HELP)
        elif cmd == "agents":
            agents = self._agents()
            lines = [f"• {a['name']} — {a['status']} ({a['provider_id'] or 'no provider'}/{a['model_id'] or '-'})"
                     for a in agents] or ["(no agents)"]
            await self._choose_agent(chat_id, thread_id, "Agents:\n" + "\n".join(lines))
        elif cmd == "use":
            match = [a for a in self._agents() if a["name"].lower() == args.lower() or a["id"].startswith(args.lower())] \
                if args else []
            if not match:
                await self._choose_agent(chat_id, thread_id, "Which agent?")
                return
            self._select(user, match[0]["id"])
            await send(f"Now talking to {match[0]['name']}.")
        elif cmd == "newagent":
            self._wizard[chat_id] = {"step": "name", "thread_id": thread_id}
            await send("New agent — what name should it have?")
        elif cmd == "status":
            vm = "unknown"
            try:
                p = await self.guest.ping(timeout=5)
                vm = f"running (guest up {int(p['uptime_s'])} s, {p['mem']['MemAvailable'] // 1048576} MB free)"
            except Exception as e:  # noqa: BLE001
                vm = f"unavailable ({type(e).__name__})"
            if not agent_id:
                await send(f"VM: {vm}\nNo agent selected — use /agents.")
                return
            a = next((x for x in self._agents() if x["id"] == agent_id), None)
            t = self._current_task(agent_id)
            with db.engine().connect() as c:
                prov = c.execute(select(models.providers.c.state).where(models.providers.c.id == (a or {}).get("provider_id"))).scalar()
            await send(f"Agent: {a['name']} — {a['status']}\nTask: " +
                       (f"#{t['id'][:8]} {t['state']} step {t['current_step']}" if t else "none") +
                       f"\nProvider: {a['provider_id']} ({prov}) model {a['model_id']}\nVM: {vm}")
        elif cmd in ("pause", "resume", "stop"):
            if not agent_id:
                await self._choose_agent(chat_id, thread_id, "Select an agent first:")
                return
            if cmd == "resume":
                with db.engine().connect() as c:
                    t = db.row(c.execute(select(models.tasks).where(and_(models.tasks.c.agent_id == agent_id,
                               models.tasks.c.state.in_(["PAUSED", "WAITING_PROVIDER"])))
                               .order_by(models.tasks.c.created_at.desc())).first())
            else:
                t = self._current_task(agent_id)
            if not t:
                await send("No matching task.")
                return
            if cmd == "pause":
                r = self.orch.pause(t["id"], "smart")
            elif cmd == "resume":
                r = self.orch.resume(t["id"])
            else:
                r = await self.orch.stop(t["id"], "cancel")
            audit(f"telegram:{user['telegram_user_id']}", f"task.{cmd}", t["id"])
            await send(f"Task #{t['id'][:8]}: {r['state']}")
        elif cmd == "screenshot":
            if not agent_id:
                await self._choose_agent(chat_id, thread_id, "Screenshot of which agent?")
                return
            from nebula_host.agents_service import desktop_unavailable

            if (why := desktop_unavailable(agent_id)):
                await send(f"No screenshot: {why}.")
                return
            res = await self.guest.tool(agent_id, "desktop.screenshot", {}, timeout=30)
            if not res.get("ok"):
                await send(f"Screenshot failed: {(res.get('error') or {}).get('message')}")
                return
            png = base64.b64decode(res["result"]["png_b64"])
            ts = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(res["result"]["captured_at"]))
            await self.api.send_photo(chat_id, png, f"Live screenshot · {ts}", thread_id)
            audit(f"telegram:{user['telegram_user_id']}", "agent.screenshot", agent_id)
        else:
            await send("Unknown command. /help")

    def _select(self, user: dict[str, Any], agent_id: str) -> None:
        with db.engine().begin() as c:
            c.execute(update(models.telegram_users).where(models.telegram_users.c.id == user["id"])
                      .values(selected_agent_id=agent_id))

    async def _wizard_step(self, user: dict[str, Any], text: str, thread_id: int | None) -> None:
        chat_id = user["chat_id"]
        w = self._wizard[chat_id]
        if w["step"] == "name":
            w["name"] = text[:64]
            w["step"] = "level"
            kb = {"inline_keyboard": [[{"text": lvl, "callback_data": f"lvl:{lvl}"}]
                                      for lvl in ("READ_ONLY", "STANDARD", "ADVANCED")]}
            await self.api.send_message(chat_id, "Permission level?", w["thread_id"], reply_markup=kb)

    async def on_callback(self, q: dict[str, Any]) -> None:
        frm = q.get("from", {})
        msg = q.get("message") or {}
        chat_id = int((msg.get("chat") or {}).get("id", 0))
        user = self._user(int(frm.get("id", 0)), chat_id)
        if user is None:
            await self.api.answer_callback(q["id"], "Not authorized")
            return
        data = q.get("data", "")
        thread_id = msg.get("message_thread_id")
        if not await access.require(self, user, access.callback_needs(data), chat_id, thread_id, q=q,
                                    what=data.split(":", 1)[0], target=access.approval_id_of(data)):
            return  # approvals and administration: the owner only; operators: their stored permissions
        if await tg3.callback(self, user, q, data, chat_id, thread_id):
            return
        if data.startswith("use:"):
            aid = data[4:]
            self._select(user, aid)
            a = next((x for x in self._agents() if x["id"] == aid), None)
            await self.api.answer_callback(q["id"], f"Selected {a['name'] if a else aid[:8]}")
            if a:
                await self.api.send_message(chat_id, f"Now talking to {a['name']}.", thread_id)
        elif data.startswith("auth:"):
            from nebula_host import smart_auth

            parts = data.split(":")
            try:
                r = await smart_auth.cancel(parts[1], actor=f"telegram:{user['telegram_user_id']}")
                await self.api.answer_callback(q["id"], "Sign-in cancelled" if r["state"] == "CANCELLED"
                                               else f"Already {r['state'].lower()}")
            except smart_auth.AuthError:
                await self.api.answer_callback(q["id"], "Unknown sign-in request")
        elif data.startswith("appr:"):
            parts = data.split(":")
            if len(parts) != 3:
                await self.api.answer_callback(q["id"], "Invalid")
                return
            _, aid, yn = parts
            decision = "approved" if yn == "y" else "denied"
            if not await access.require(self, user, (access.APPROVAL,), chat_id, thread_id, q=q, what="appr",
                                        target=aid):
                return
            if access.task_stepup(aid):  # needs a fresh owner over the API: never decided by a chat button
                await access.stepup_refusal(self, user, q, chat_id, thread_id, aid, "task")
                return
            try:
                r = self.orch.resolve_approval(aid, decision, f"telegram:{user['telegram_user_id']}")
                await self.api.answer_callback(q["id"], f"{r['decision']}")
                await self.api.send_message(chat_id, f"Approval {aid[:8]}: {r['decision']}", thread_id)
            except KeyError:
                await self.api.answer_callback(q["id"], "Unknown approval")
        elif await tg2.callback(self, user, q, data, chat_id, thread_id):
            return
        elif data.startswith("lvl:") and chat_id in self._wizard:
            w = self._wizard.pop(chat_id)
            level = data[4:]
            await self.api.answer_callback(q["id"], "Creating…")
            await self.api.send_message(chat_id, f"Creating agent {w['name']} ({level}) — preparing its desktop…",
                                        w["thread_id"])
            if self.agent_creator is None:
                await self.api.send_message(chat_id, "Agent creation unavailable.", w["thread_id"])
                return
            try:
                a = await self.agent_creator({"name": w["name"], "permission_level": level},
                                             f"telegram:{user['telegram_user_id']}")
                await self.api.send_message(chat_id, f"Agent {a['name']} is ready (Linux user {a['linux_user']}, "
                                                     f"{a['display_id']}).", w["thread_id"])
            except Exception as e:  # noqa: BLE001
                await self.api.send_message(chat_id, f"Creating the agent failed: {e}", w["thread_id"])
        else:
            await self.api.answer_callback(q["id"])

    async def _save_attachment(self, agent_id: str, m: dict[str, Any], chat_id: int, thread_id: int | None) -> str | None:
        maxb = self.cfg.telegram.max_attachment_mb * 1024 * 1024
        if m.get("document"):
            d = m["document"]
            mime = d.get("mime_type", "application/octet-stream")
            name = re.sub(r"\.{2,}", "_", SAFE_NAME.sub("_", d.get("file_name") or "file"))[:80].lstrip(".") or "file"
            size, file_id = d.get("file_size", 0), d["file_id"]
        else:
            ph = m["photo"][-1]
            mime, name, size, file_id = "image/jpeg", f"photo-{m['message_id']}.jpg", ph.get("file_size", 0), ph["file_id"]
        if not tg2.allowed_upload(name, mime, ALLOWED_MIME):
            await self.api.send_message(chat_id, f"File type {mime} is not accepted.", thread_id)
            return None
        if size and size > maxb:
            await self.api.send_message(chat_id, f"File too large (max {self.cfg.telegram.max_attachment_mb} MB).", thread_id)
            return None
        info = await self.api.get_file(file_id)
        data = await self.api.download_file(info["file_path"], maxb)
        path = f"inbox/{int(time.time())}-{name}"
        r = await self.guest.tool(agent_id, "files.write", {"path": path, "content_b64": base64.b64encode(data).decode()},
                                  timeout=60)
        if not r.get("ok"):
            await self.api.send_message(chat_id, f"Saving the file failed: {(r.get('error') or {}).get('message')}",
                                        thread_id)
            return None
        if name.lower().endswith(".zip") and self.v2 is not None:
            z = await tg2.extract_zip(self, agent_id, data, f"inbox/{name[:-4]}")
            await self.api.send_message(chat_id, f"🗜 Extracted {z['files']} file(s) to {z['dir']}" if z["ok"] else
                                        f"ZIP kept as a file but not extracted: {z['error']}", thread_id)
        return path

    # ------------------------------------------------------------ topics
    async def sync_topics_for_user(self, chat_id: int) -> None:
        cfgr = get_cfg_row()
        for a in self._agents():
            await self._ensure_topic(a["id"], a["name"], chat_id, bool(cfgr["has_topics_enabled"]))

    async def _ensure_topic(self, agent_id: str, name: str, chat_id: int, topics: bool) -> None:
        with db.engine().connect() as c:
            ex = c.execute(select(models.telegram_topics).where(and_(models.telegram_topics.c.agent_id == agent_id,
                                                                     models.telegram_topics.c.telegram_chat_id == chat_id))).first()
        if ex:
            return
        thread_id, mtype = None, "command_fallback"
        if topics:
            try:
                t = await self.api.create_forum_topic(chat_id, f"🤖 {name}")
                thread_id, mtype = t["message_thread_id"], "private_topic"
                await self.api.send_message(chat_id, f"This topic talks to agent {name}. Send a task here.", thread_id)
            except TelegramError as e:
                log.warning("createForumTopic failed (%s); falling back to /use", e)
        with db.engine().begin() as c:
            c.execute(models.telegram_topics.insert().values(id=str(uuid.uuid4()), agent_id=agent_id,
                                                             telegram_chat_id=chat_id, message_thread_id=thread_id,
                                                             mapping_type=mtype, topic_name=name, created_at=db.now()))

    def _approved_users(self) -> list[dict[str, Any]]:
        with db.engine().connect() as c:
            return db.rows(c.execute(select(models.telegram_users).where(models.telegram_users.c.status == "approved")))

    def _topic(self, agent_id: str, chat_id: int) -> int | None:
        with db.engine().connect() as c:
            return c.execute(select(models.telegram_topics.c.message_thread_id).where(and_(
                models.telegram_topics.c.agent_id == agent_id, models.telegram_topics.c.telegram_chat_id == chat_id,
                models.telegram_topics.c.archived.is_(False)))).scalar()

    # ------------------------------------------------------------ notifications (event listener)
    async def on_event(self, ev: dict[str, Any]) -> None:
        if not self.running:
            return
        try:
            await self._notify(ev)
        except TelegramError as e:
            log.warning("notification failed: %s", e)
        except Exception:  # noqa: BLE001
            log.exception("notification error")

    async def send_to_owners(self, text: str, attach: tuple[str, bytes] | None = None) -> int:
        if not self.running:
            return 0
        return await tg2.send_to_owners(self, text, attach)

    def _task_rt(self, task_id: str | None) -> dict[str, Any]:
        if not task_id:
            return {}
        with db.engine().connect() as c:
            rt = c.execute(select(models.tasks.c.reply_target).where(models.tasks.c.id == task_id)).scalar()
        return rt or {}

    async def _notify(self, ev: dict[str, Any]) -> None:
        t, p, aid, tid = ev["type"], ev["payload"], ev.get("agent_id"), ev.get("task_id")
        if t.startswith("task.") and self._task_rt(tid).get("bot"):
            # tasks created through an agent's own bot are reported by that bot (conversation isolation); only an
            # approval that bot's requester may not decide (not the owner) comes to the owner's main chat here
            if t != "task.approval.requested" or access.is_owner_id(access.requester(self._task_rt(tid))):
                return
        if await tg3.company_notify(self, ev, self._approved_users()):
            return
        if t == "auth.request":  # answering or cancelling a sign-in is the owner's (smart-auth routes are admin)
            for u in access.owner_rows(self._approved_users()):
                lv = cardmod.level_of(self.key, u["chat_id"])
                await tg3.send_sign_in(self, u["chat_id"], self._topic(aid, u["chat_id"]), ev, silent=lv == "silent")
            return
        if t == "task.approval.requested":  # approval cards go to the owner's chat only (B1)
            rt = self._task_rt(tid)
            here = not rt.get("bot")  # the task was created in this (main) bot's chat
            for u in access.owner_rows(self._approved_users()):
                lv = cardmod.level_of(self.key, u["chat_id"])
                thread = rt.get("thread_id") if here and rt.get("chat_id") == u["chat_id"] else \
                    self._topic(aid, u["chat_id"])
                await tg3.send_approval(self, u["chat_id"], thread, ev, silent=lv == "silent")
            if here and rt.get("chat_id") and not access.is_owner_id(access.requester(rt)):
                lv = cardmod.level_of(self.key, rt["chat_id"])
                await tg3.send_waiting_note(self, rt["chat_id"], rt.get("thread_id"), ev, silent=lv == "silent")
            return
        if t in ("task.completed", "task.failed", "task.cancelled") and p.get("source") == "telegram" \
                and (p.get("reply_target") or {}).get("chat_id"):
            rt = p["reply_target"]
            self._status_msgs.pop(tid, None)
            await tg3.deliver_result(self, ev)
            if t == "task.completed" and cardmod.wants(cardmod.level_of(self.key, rt["chat_id"]), "completion"):
                res = p.get("result") or {}
                shots = res.get("screenshots") or []
                if shots and not rt.get("voice"):
                    path = Path(self.cfg.artifacts_dir) / shots[-1]
                    if path.exists():
                        await self.api.send_photo(rt["chat_id"], path.read_bytes(), "Final desktop state",
                                                  rt.get("thread_id"))
                await tg2.result_buttons(self, rt["chat_id"], rt.get("thread_id"), tid, res)
            return
        if t == "task.message":
            await tg3.forward_question(self, ev, self._task_rt(tid))
            return
        if await tg2.notify(self, ev):
            return
        if t == "agent.created":
            topics = bool(get_cfg_row()["has_topics_enabled"])
            for u in self._approved_users():
                await self._ensure_topic(aid, p.get("name", aid[:8]), u["chat_id"], topics)
            return
        if t == "agent.deleted":
            for tp in p.get("telegram_topics", []):
                await self.api.send_message(tp["telegram_chat_id"], "Agent deleted. This topic is archived (history "
                                                                    "is kept; delete it in Telegram if you wish).",
                                            tp["message_thread_id"])
            return
        if t == "agent.state.changed" and "name" in (p.get("updated") or []):
            with db.engine().connect() as c:
                name = c.execute(select(models.agents.c.name).where(models.agents.c.id == aid)).scalar()
                rows = db.rows(c.execute(select(models.telegram_topics).where(and_(
                    models.telegram_topics.c.agent_id == aid, models.telegram_topics.c.mapping_type == "private_topic"))))
            for tp in rows:
                await self.api.edit_forum_topic(tp["telegram_chat_id"], tp["message_thread_id"], f"🤖 {name}")
            return
        if not tid:
            return
        rt = p.get("reply_target")
        if t == "task.step" and tid in self._status_msgs and p.get("tool"):
            chat, mid, last = self._status_msgs[tid]
            if time.time() - last > 4:
                self._status_msgs[tid] = (chat, mid, time.time())
                await self.api.edit_message_text(chat, mid, f"⏳ Task #{tid[:8]} · step {p.get('seq')}: {p['tool']} "
                                                            f"({p.get('status')})")
            return
        if t in ("task.completed", "task.failed", "task.cancelled") and rt and p.get("source") == "telegram":
            self._status_msgs.pop(tid, None)
            chat, thread = rt["chat_id"], rt.get("thread_id")
            if t == "task.completed":
                res = p.get("result") or {}
                arts = "\n".join(f"• {a['type']}: {a['value']}" for a in res.get("verified_artifacts", []))
                await self.api.send_message(chat, f"✅ Task #{tid[:8]} completed ({res.get('verification')}).\n\n"
                                                  f"{res.get('summary', '')[:3000]}" + (f"\n\nVerified:\n{arts}" if arts else ""),
                                            thread)
                shots = res.get("screenshots") or []
                if shots:
                    path = Path(self.cfg.artifacts_dir) / shots[-1]
                    if path.exists():
                        await self.api.send_photo(chat, path.read_bytes(), "Final desktop state", thread)
                await tg2.result_buttons(self, chat, thread, tid, res)
            else:
                word = "failed" if t == "task.failed" else "cancelled"
                await self.api.send_message(chat, f"⚠️ Task #{tid[:8]} {word}: {p.get('reason')}", thread)
