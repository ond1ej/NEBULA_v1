"""Telegram 3.0 features shared by the main NEBULA bot and every per-agent bot.

* Voice Agent 2.0: transcription (local whisper.cpp preferred, cloud only with consent), Czech/English voice commands
  answered from real data, tasks with conversation context, spoken replies (local macOS TTS).
* Multimodal intake: photos, screenshots, documents (PDF/DOCX/TXT/CSV/JSON/code/ZIP), audio, video, several files
  per task (media groups) — validated, stored, processed and linked to the task.
* Live task cards + real button actions (pause/resume/stop/retry/screenshot/details/files/download/approve/reject/
  assign), notification levels, company commands.

``ctx`` is the bot context: ``key`` ("main" | telegram_bots.id), ``api``, ``cfg``, ``orch``, ``guest``, ``svc``
(service container) and ``fixed_agent`` (the bound agent of an agent bot, None for the main bot).
Every entry point is only called for an authorised (paired + approved) user of that bot; what that user may do (the
owner, an operator with its stored permissions, an agent-bot user) is checked with nebula_telegram.access.
"""

from __future__ import annotations

import asyncio
import base64
import logging
import time
from typing import Any

from nebula_host import db, models
from nebula_host.events import audit
from sqlalchemy import and_, select

from nebula_telegram import access
from nebula_telegram import cards as cardsvc
from nebula_telegram.botapi import TelegramError

log = logging.getLogger("nebula.telegram.v3")
MEDIA_GROUP_WAIT = 2.5
HELP_V3 = (
    "NEBULA\n"
    "Send text, a voice message, photos/screenshots, documents (PDF, DOCX, TXT, CSV, JSON, code, ZIP), audio or "
    "video — several files at once work too. Each task gets a live card with buttons.\n\n"
    "/agents · /use <name> · /status · /pause /resume /stop · /screenshot · /history · /files · /get <path>\n"
    "/companies – AI companies   /company <name> – details   /project <company> | <project> | <request>\n"
    "/progress – company work in progress   /approvals – pending approvals\n"
    "/teams · /team <name> <task> · /schedules · /wf <cmd> <text> · /model\n"
    "/voice – voice reply mode   /notify – notification level   /app – open the NEBULA Mini App\n"
    "/help – this help")
_groups: dict[tuple[str, str], dict[str, Any]] = {}


def actor(ctx, user: dict[str, Any]) -> str:
    return f"telegram:{user['telegram_user_id']}" + ("" if ctx.key == "main" else f"@bot:{ctx.key[:8]}")


def _agent(agent_id: str) -> dict[str, Any] | None:
    with db.engine().connect() as c:
        return db.row(c.execute(select(models.agents).where(models.agents.c.id == agent_id)).first())


def _agents() -> list[dict[str, Any]]:
    with db.engine().connect() as c:
        return db.rows(c.execute(select(models.agents.c.id, models.agents.c.name, models.agents.c.status)
                                 .order_by(models.agents.c.created_at)))


def public_url(ctx) -> str | None:
    try:
        from nebula_host import remote

        return remote.public_base()
    except Exception:  # noqa: BLE001
        return None


# ============================================================================ tasks
async def create_task(ctx, user: dict[str, Any], agent_id: str, text: str, chat_id: int, thread_id: int | None,
                      *, attachment_ids: list[str] | None = None, voice: bool = False,
                      language: str | None = None) -> dict[str, Any] | None:
    rt = {"chat_id": chat_id, "thread_id": thread_id, "user_id": user["telegram_user_id"]}
    if ctx.key != "main":
        rt["bot"] = ctx.key
    if voice:
        rt["voice"] = True
        rt["language"] = language
    try:
        task = ctx.orch.enqueue(agent_id, text, source="telegram", reply_target=rt, attachment_ids=attachment_ids)
    except Exception as e:  # noqa: BLE001
        await ctx.api.send_message(chat_id, f"Could not queue the task: {e}", thread_id)
        return None
    audit(actor(ctx, user), "telegram.task.create", task["id"], {"agent_id": agent_id, "attachments":
                                                                   len(attachment_ids or []), "voice": voice})
    try:
        await cardsvc.cards.open(ctx.key, task["id"], chat_id, thread_id)
    except TelegramError as e:
        log.warning("task card failed: %s", e)
    return task


# ============================================================================ messages
async def handle_message(ctx, user: dict[str, Any], agent_id: str, m: dict[str, Any], chat_id: int,
                         thread_id: int | None) -> bool:
    """Voice, audio, video and file messages. Returns True when handled (plain text goes the normal way)."""
    if m.get("voice") or m.get("video_note"):
        await voice_message(ctx, user, agent_id, m, chat_id, thread_id)
        return True
    if any(m.get(k) for k in ("photo", "document", "video", "audio", "animation")):
        await file_message(ctx, user, agent_id, m, chat_id, thread_id)
        return True
    return False


def _file_ref(m: dict[str, Any]) -> tuple[str, str, str, int, str | None]:
    """(file_id, name, declared_mime, size, kind_hint)"""
    if m.get("photo"):
        ph = m["photo"][-1]
        return ph["file_id"], f"photo-{m['message_id']}.jpg", "image/jpeg", ph.get("file_size", 0), None
    for k, hint in (("document", None), ("video", "video"), ("audio", "audio"), ("animation", "video")):
        d = m.get(k)
        if d:
            ext = {"video": ".mp4", "audio": ".mp3", "animation": ".mp4"}.get(k, "")
            return (d["file_id"], d.get("file_name") or f"{k}-{m['message_id']}{ext}",
                    d.get("mime_type", "application/octet-stream"), d.get("file_size", 0), hint)
    raise ValueError("no file in message")


async def _download_intake(ctx, user, agent_id, m, chat_id, thread_id, kind_hint: str | None = None) -> dict | None:
    from nebula_host import attachments as attsvc

    file_id, name, mime, size, hint = _file_ref(m) if not kind_hint else (
        (m.get("voice") or m.get("video_note"))["file_id"], f"voice-{m['message_id']}.ogg",
        (m.get("voice") or {}).get("mime_type", "audio/ogg" if m.get("voice") else "video/mp4"),
        (m.get("voice") or m.get("video_note") or {}).get("file_size", 0), kind_hint)
    maxb = min(ctx.cfg.telegram.max_attachment_mb, 20) * 1024 * 1024  # Bot API download limit: 20 MB
    if size and size > maxb:
        await ctx.api.send_message(chat_id, f"⚠️ {name} is too large ({size // 1048576} MB; max {maxb // 1048576} MB "
                                            "via Telegram). Upload it in the Dashboard instead.", thread_id)
        return None
    try:
        info = await ctx.api.get_file(file_id)
        data = await ctx.api.download_file(info["file_path"], maxb)
        att = await asyncio.to_thread(
            attsvc.intake, ctx.cfg, data, name, mime, source="telegram", agent_id=agent_id,
            telegram_user_id=user["telegram_user_id"], chat_id=chat_id, bot_key=ctx.key,
            conversation=f"tg:{ctx.key}:{chat_id}", kind_hint=hint)
    except attsvc.AttachmentError as e:
        await ctx.api.send_message(chat_id, f"⚠️ {name} was rejected: {e.message}", thread_id)
        return None
    except TelegramError as e:
        await ctx.api.send_message(chat_id, f"⚠️ Could not download {name}: {e.description}", thread_id)
        return None
    att = await attsvc.process(ctx.cfg, att["id"])
    env = _env_of(agent_id)
    try:
        await attsvc.deliver_to_workspace(ctx.cfg, att, ctx.svc.files if ctx.svc else None,
                                          getattr(ctx.svc, "host", None), env)
    except Exception as e:  # noqa: BLE001 - the attachment still reaches the task through its extracted data
        log.warning("workspace delivery failed: %s", e)
    return attsvc.get(att["id"])


def _env_of(agent_id: str) -> str:
    from nebula_host import environments

    a = _agent(agent_id)
    return environments.agent_execution(a)["env"] if a else "vm"


async def file_message(ctx, user, agent_id, m, chat_id, thread_id) -> None:
    gid = m.get("media_group_id")
    att = await _download_intake(ctx, user, agent_id, m, chat_id, thread_id)
    caption = (m.get("caption") or "").strip()
    if gid:  # several files in one message group -> one task once the group is complete
        key = (ctx.key, str(gid))
        g = _groups.setdefault(key, {"atts": [], "caption": "", "chat": chat_id, "thread": thread_id, "task": None,
                                     "agent": agent_id, "user": user})
        if att:
            g["atts"].append(att)
        if caption:
            g["caption"] = caption
        if g["task"] is None:
            g["task"] = asyncio.ensure_future(_flush_group(ctx, key))
        return
    if not att:
        return
    if att["kind"] == "zip" and _env_of(agent_id) == "vm" and ctx.svc is not None:
        await _extract_zip(ctx, agent_id, att, chat_id, thread_id)
    if not caption:
        await ctx.api.send_message(chat_id, f"📎 {_describe(att)}\nSend what I should do with it (or reply with a "
                                            "caption next time) — I'll include it in the next task.", thread_id)
        _pending_atts(ctx.key, chat_id).append(att["id"])
        return
    ids = _pending_atts(ctx.key, chat_id, take=True) + [att["id"]]
    await create_task(ctx, user, agent_id, caption, chat_id, thread_id, attachment_ids=ids)


async def _extract_zip(ctx, agent_id: str, att: dict[str, Any], chat_id: int, thread_id) -> None:
    """V2 behaviour kept: safe extraction of a ZIP into the agent's inbox (traversal/symlinks/limits enforced)."""
    from nebula_host import attachments as attsvc

    from nebula_telegram import v2 as tg2

    data = attsvc.path_of(ctx.cfg, att).read_bytes()
    stem = att["name"][:-4] if att["name"].lower().endswith(".zip") else att["name"]
    try:
        z = await tg2.extract_zip(ctx, agent_id, data, f"inbox/{stem}")
    except Exception as e:  # noqa: BLE001
        z = {"ok": False, "error": str(e)[:200]}
    await ctx.api.send_message(chat_id, f"🗜 Extracted {z['files']} file(s) to {z['dir']}" if z["ok"] else
                               f"ZIP kept as a file but not extracted: {z['error']}", thread_id)


async def _flush_group(ctx, key) -> None:
    await asyncio.sleep(MEDIA_GROUP_WAIT)
    g = _groups.pop(key, None)
    if not g or not g["atts"]:
        return
    chat_id, thread_id = g["chat"], g["thread"]
    ids = _pending_atts(ctx.key, chat_id, take=True) + [a["id"] for a in g["atts"]]
    if not g["caption"]:
        _pending_atts(ctx.key, chat_id).extend(ids)
        await ctx.api.send_message(chat_id, f"📎 {len(g['atts'])} files received:\n" +
                                   "\n".join(f"• {_describe(a)}" for a in g["atts"]) +
                                   "\nTell me what to do with them.", thread_id)
        return
    await create_task(ctx, g["user"], g["agent"], g["caption"], chat_id, thread_id, attachment_ids=ids)


_pending: dict[tuple[str, int], list[str]] = {}
_pending_at: dict[tuple[str, int], float] = {}
PENDING_TTL = 1800  # files sent without instructions wait 30 minutes for the next message


def _pending_atts(key: str, chat_id: int, take: bool = False) -> list[str]:
    k = (key, chat_id)
    if time.time() - _pending_at.get(k, time.time()) > PENDING_TTL:
        _pending.pop(k, None)
    if take:
        _pending_at.pop(k, None)
        return _pending.pop(k, [])
    _pending_at[k] = time.time()
    return _pending.setdefault(k, [])


def take_pending(key: str, chat_id: int) -> list[str]:
    return _pending_atts(key, chat_id, take=True)


def _describe(att: dict[str, Any]) -> str:
    ex = att.get("extracted") or {}
    d = f"{att['name']} ({att['kind']}, {max(att['size'] // 1024, 1)} KB)"
    if att["status"] == "FAILED":
        return d + f" — processing failed: {att.get('error')}"
    if ex.get("pages"):
        d += f", {ex['pages']} pages"
    if ex.get("chars"):
        d += f", {ex['chars']} characters of text"
    if ex.get("media"):
        d += f", {ex['media'].get('duration_s')} s"
    if ex.get("frames"):
        d += f", {len(ex['frames'])} frames sampled"
    if ex.get("archive"):
        d += f", {ex['archive']['entries']} entries"
    return d


# ============================================================================ voice
async def voice_message(ctx, user, default_agent: str, m, chat_id, thread_id) -> None:
    from nebula_host import stt, voice

    v = m.get("voice") or m.get("video_note") or {}
    if v.get("duration", 0) > 600:
        await ctx.api.send_message(chat_id, "Voice message too long (max 10 minutes).", thread_id)
        return
    st = stt.status(ctx.cfg)
    if st["backend"] is None:
        await ctx.api.send_message(chat_id, "🎙 Voice transcription is not set up yet, so nothing was sent "
                                            "anywhere.\n" + (st["setup_hint"] or ""), thread_id)
        return
    att = await _download_intake(ctx, user, default_agent, m, chat_id, thread_id, kind_hint="voice")
    if not att:
        return
    tr = (att.get("extracted") or {}).get("transcript") or {}
    if not tr.get("ok"):
        await ctx.api.send_message(chat_id, f"Transcription failed: {tr.get('error', 'unknown error')}", thread_id)
        return
    text = (tr.get("text") or "").strip()
    if not text:
        await ctx.api.send_message(chat_id, "I could not hear any words in that voice message.", thread_id)
        return
    lang = tr.get("language") or voice.detect_language(text)
    lang = lang if lang in ("cs", "en") else voice.detect_language(text)
    agents = [a for a in _agents() if not ctx.fixed_agent or a["id"] == ctx.fixed_agent]
    parsed = voice.parse(text, agents, default_agent)
    agent_id = ctx.fixed_agent or parsed["agent_id"] or default_agent
    audit(actor(ctx, user), "telegram.voice", agent_id, {"backend": tr.get("backend"), "chars": len(text),
                                                         "intent": parsed["intent"]})
    await ctx.api.send_message(chat_id, f"🎙 ({tr.get('backend')}): “{text[:600]}”", thread_id)
    if parsed["addressed"] and not ctx.fixed_agent and ctx.key == "main":
        from nebula_telegram import gateway as gwmod  # noqa: F401  (selection is remembered like /use)

        with db.engine().begin() as c:
            c.execute(models.telegram_users.update().where(models.telegram_users.c.id == user["id"])
                      .values(selected_agent_id=agent_id))
    intent = parsed["intent"]
    if not await access.require(ctx, user, access.VOICE_INTENTS.get(intent, ("commands",)), chat_id, thread_id,
                                what=f"voice:{intent}"):
        return  # a voice command needs the same permission as the typed one
    if intent == "task":
        att_ids = take_pending(ctx.key, chat_id) + [att["id"]]
        await create_task(ctx, user, agent_id, parsed["text"], chat_id, thread_id, attachment_ids=att_ids,
                          voice=True, language=lang)
        return
    reply = await _voice_intent(ctx, user, intent, agent_id, lang, chat_id, thread_id)
    if reply:
        await reply_voice(ctx, agent_id, reply, chat_id, thread_id, lang, input_was_voice=True)


async def _voice_intent(ctx, user, intent: str, agent_id: str, lang: str, chat_id: int, thread_id) -> str | None:
    from nebula_host import voice

    if intent == "status":
        return voice.status_summary(agent_id, lang)
    if intent == "team_status":
        return voice.team_summary(lang)
    if intent == "company_status":
        return voice.company_summary(lang)
    with db.engine().connect() as c:
        if intent == "resume":
            t = db.row(c.execute(select(models.tasks).where(and_(models.tasks.c.agent_id == agent_id,
                       models.tasks.c.state.in_(["PAUSED", "WAITING_PROVIDER"])))
                       .order_by(models.tasks.c.created_at.desc())).first())
        else:
            t = db.row(c.execute(select(models.tasks).where(and_(models.tasks.c.agent_id == agent_id,
                       models.tasks.c.state.notin_(["COMPLETED", "FAILED", "CANCELLED"])))
                       .order_by(models.tasks.c.created_at.desc())).first())
    if intent == "screenshot":
        await _screenshot(ctx, agent_id, chat_id, thread_id, f"Screenshot · {time.strftime('%H:%M:%S')}")
        return None
    if not t:
        return "Žádný odpovídající úkol." if lang == "cs" else "No matching task."
    if intent == "pause":
        r = ctx.orch.pause(t["id"], "smart")
    elif intent == "resume":
        r = ctx.orch.resume(t["id"])
    else:
        r = await ctx.orch.stop(t["id"], "cancel")
    audit(actor(ctx, user), f"telegram.voice.{intent}", t["id"])
    cardsvc.cards.touch(t["id"], final=True)
    return (f"Úkol {t['id'][:8]} je teď {r['state']}." if lang == "cs" else f"Task {t['id'][:8]} is now {r['state']}.")


async def reply_voice(ctx, agent_id: str, text: str, chat_id: int, thread_id, lang: str, *,
                      input_was_voice: bool) -> None:
    from nebula_host import tts, voice

    a = _agent(agent_id) or {}
    vs = voice.agent_voice(a)
    send_text, send_voice = voice.should_speak(vs["reply_mode"], input_was_voice)
    if send_text:
        await ctx.api.send_message(chat_id, text[:4000], thread_id)
    if send_voice:
        language = vs["language"] if vs["language"] in ("cs", "en") else lang
        try:
            r = await tts.synthesize(text, language=language, voice=vs.get("voice"), rate=float(vs.get("rate") or 1.0),
                                     provider=vs.get("provider"))
            await ctx.api.send_voice(chat_id, r["audio"], "", thread_id, r.get("duration_s"), r["mime"])
        except Exception as e:  # noqa: BLE001
            log.warning("voice reply failed: %s", e)
            if not send_text:
                await ctx.api.send_message(chat_id, text[:4000] + f"\n\n(voice reply failed: {e})", thread_id)


async def _screenshot(ctx, agent_id: str, chat_id: int, thread_id, caption: str) -> None:
    if _env_of(agent_id) == "host":
        await ctx.api.send_message(chat_id, "This agent works natively on the Mac (no desktop to capture).", thread_id)
        return
    from nebula_host.agents_service import desktop_unavailable

    if (why := desktop_unavailable(agent_id)):
        await ctx.api.send_message(chat_id, f"No screenshot: {why}.", thread_id)
        return
    res = await ctx.guest.tool(agent_id, "desktop.screenshot", {}, timeout=30)
    if res.get("ok"):
        await ctx.api.send_photo(chat_id, base64.b64decode(res["result"]["png_b64"]), caption, thread_id)
    else:
        await ctx.api.send_message(chat_id, f"Screenshot failed: {(res.get('error') or {}).get('message')}", thread_id)


# ============================================================================ commands
async def command(ctx, user: dict[str, Any], cmd: str, args: str, thread_id: int | None, agent_id: str | None) -> bool:
    chat_id = user["chat_id"]

    async def send(t: str, **kw):
        return await ctx.api.send_message(chat_id, t, thread_id, **kw)

    if cmd == "help":
        await send(HELP_V3)
        return True
    if cmd == "notify":
        lv = args.strip().lower()
        if lv in cardsvc.LEVELS:
            cardsvc.set_level(ctx.key, chat_id, lv)
            await send(f"Notifications: {lv}")
        else:
            await send(f"Notification level: {cardsvc.level_of(ctx.key, chat_id)}", reply_markup=cardsvc.level_keyboard(ctx.key))
        return True
    if cmd == "app":
        url = public_url(ctx)
        if not url:
            await send("The NEBULA Mini App needs a public HTTPS address that you set up in the Dashboard "
                       "(Settings → Remote access). Until then use the Dashboard on your local network.")
        else:
            await send("Open NEBULA:", reply_markup={"inline_keyboard": [[{"text": "📱 Open NEBULA", "web_app":
                                                                            {"url": f"{url}/mini/"}}]]})
        return True
    if cmd == "voice":
        target = ctx.fixed_agent or agent_id
        if not target:
            await send("Select an agent first (/agents).")
            return True
        from nebula_host import voice as vsvc

        a = _agent(target)
        mode = args.strip().lower()
        if mode in vsvc.REPLY_MODES:
            cfg = dict(a.get("config") or {})
            cfg["voice"] = {**vsvc.agent_voice(a), "reply_mode": mode}
            with db.engine().begin() as c:
                c.execute(models.agents.update().where(models.agents.c.id == target).values(config=cfg))
            audit(actor(ctx, user), "agent.voice.reply_mode", target, {"mode": mode})
            await send(f"{a['name']}: voice replies = {mode}")
        else:
            await send(f"{a['name']}: voice replies = {vsvc.agent_voice(a)['reply_mode']}\n/voice text | voice | "
                       "text_voice | auto")
        return True
    if ctx.fixed_agent:
        return False  # company commands live on the main bot
    if cmd == "companies":
        from nebula_host import companies as cosvc

        cos = cosvc.list_companies()
        if not cos:
            await send("No AI companies yet — create one in the Dashboard (Companies) or the Mini App.")
            return True
        kb = [[{"text": f"🏢 {c['name']} · {c['member_count']} people · {c['active_runs']} active",
                "callback_data": f"co:{c['id']}"}] for c in cos[:10]]
        await send("AI companies:", reply_markup={"inline_keyboard": kb})
        return True
    if cmd == "company":
        from nebula_host import companies as cosvc

        co = cosvc.find_company(args.strip()) if args.strip() else None
        if not co:
            await send("Usage: /company <name>   (see /companies)")
            return True
        await send_company(ctx, chat_id, thread_id, co["id"], owner=access.is_owner(user))
        return True
    if cmd == "project":
        from nebula_host import companies as cosvc

        parts = [p.strip() for p in args.split("|")]
        if len(parts) < 3 or not all(parts[:3]):
            await send("Usage: /project <company> | <project> | <what to do>")
            return True
        co = cosvc.find_company(parts[0])
        if not co:
            await send(f"Unknown company {parts[0]!r}")
            return True
        proj = next((p for p in cosvc.get_company(co["id"])["projects"] if p["name"].lower() == parts[1].lower()), None)
        if not proj:
            await send(f"Unknown project {parts[1]!r} in {co['name']}")
            return True
        try:
            run = await ctx.svc.companies.start_run(proj["id"], parts[2], planner="template", source="telegram",
                                                    reply_target={"chat_id": chat_id, "thread_id": thread_id},
                                                    actor=actor(ctx, user))
        except Exception as e:  # noqa: BLE001
            await send(f"Run not started: {e}")
            return True
        await send(f"🏢 {co['name']} · {proj['name']}: run #{run['id'][:8]} started with {len(run['items'])} work "
                   "item(s). I'll report progress here.", reply_markup={"inline_keyboard": [[
                       {"text": "📊 Progress", "callback_data": f"cr:{run['id']}"}]]})
        return True
    if cmd == "progress":
        from nebula_host import companies as cosvc

        lines = []
        for co in cosvc.list_companies():
            d = cosvc.get_company(co["id"])
            for r in d["recent_runs"][:3]:
                if r["state"] in ("RUNNING", "PLANNING", "AWAITING_APPROVAL", "PAUSED"):
                    run = cosvc.get_run(r["id"])
                    done = sum(1 for i in run["items"] if i["state"] == "COMPLETED")
                    lines.append(f"🏢 {co['name']} #{r['id'][:8]} {r['state']}: {done}/{len(run['items'])} items")
        await send("\n".join(lines) or "No company work in progress.")
        return True
    return False


async def send_company(ctx, chat_id: int, thread_id, company_id: str, *, owner: bool = False) -> None:
    """A company card. Plan approval buttons only for the owner (approvals are the owner's decision)."""
    from nebula_host import companies as cosvc

    d = cosvc.get_company(company_id)
    lines = [f"🏢 {d['name']} — {d['objective'][:200] or d['description'][:200]}",
             f"Default environment: {'Mac mini' if d['default_environment'] == 'host' else 'Ubuntu VM'}",
             f"Employees: {d['stats']['members']} · projects: {d['stats']['projects']} · running items: "
             f"{d['stats']['running_items']} · AI requests used: {d['stats']['model_calls_used']}"]
    for m in d["members"][:15]:
        env = m["environment_effective"]["env"]
        lines.append(f"• {m['role_title']}: {m['agent_name']} — {m['lifecycle']} ({'Mac' if env == 'host' else 'VM'})")
    kb = [[{"text": f"📊 Run #{r['id'][:8]} {r['state']}", "callback_data": f"cr:{r['id']}"}] for r in d["recent_runs"][:4]]
    url = public_url(ctx)
    if url:
        kb.append([{"text": "📱 Open company", "web_app": {"url": f"{url}/mini/#/companies/{company_id}"}}])
    if d["pending_approvals"] and owner:
        for a in d["pending_approvals"][:3]:
            kb.append([{"text": "✅ Approve plan", "callback_data": f"oa:{a['id']}:y"},
                       {"text": "⛔ Reject plan", "callback_data": f"oa:{a['id']}:n"}])
    await ctx.api.send_message(chat_id, "\n".join(lines), thread_id, reply_markup={"inline_keyboard": kb} if kb else None)


# ============================================================================ callbacks
async def callback(ctx, user: dict[str, Any], q: dict[str, Any], data: str, chat_id: int, thread_id) -> bool:
    if not (data.startswith(("c:", "ap:", "as:", "co:", "cr:", "nl:"))):
        return False
    if not cardsvc.first_time(q["id"], ctx.key, data):
        await ctx.api.answer_callback(q["id"], "Already processed")
        return True
    who = actor(ctx, user)
    if data.startswith("nl:"):
        cardsvc.set_level(ctx.key, chat_id, data[3:])
        await ctx.api.answer_callback(q["id"], f"Notifications: {data[3:]}")
        return True
    if data.startswith("co:"):
        await ctx.api.answer_callback(q["id"])
        if not ctx.fixed_agent:
            await send_company(ctx, chat_id, thread_id, data[3:], owner=access.is_owner(user))
        return True
    if data.startswith("cr:"):
        from nebula_host import companies as cosvc

        if ctx.fixed_agent:
            await ctx.api.answer_callback(q["id"], "Use the main NEBULA bot for companies")
            return True
        try:
            run = cosvc.get_run(data[3:])
        except cosvc.CompanyError:
            await ctx.api.answer_callback(q["id"], "Unknown run")
            return True
        await ctx.api.answer_callback(q["id"], run["state"])
        lines = [f"Run #{run['id'][:8]} — {run['state']} · AI requests {run['model_calls_used']}/{run['max_model_calls']}"]
        for it in run["items"]:
            env = "Mac" if it.get("environment") == "host" else "VM" if it.get("environment") else "—"
            lines.append(f"{cardsvc.ICON.get(cardsvc.LIFECYCLE.get(it['state'], it['state']), '•')} {it['title'][:60]} · "
                         f"{it.get('agent_name') or '?'} · {env} · {it['state']}")
        await ctx.api.send_message(chat_id, "\n".join(lines)[:4000], thread_id)
        return True
    if data.startswith("ap:"):
        parts = data.split(":")
        if len(parts) != 4:
            await ctx.api.answer_callback(q["id"], "Invalid")
            return True
        _, aid, yn, tg = parts
        if not await access.require(ctx, user, (access.APPROVAL,), chat_id, thread_id, q=q, what="ap", target=aid):
            return True  # approvals are the owner's decision, on the main bot and on every agent bot
        if not cardsvc.check_tag(tg, aid, yn, ctx.key, chat_id):
            audit(who, "telegram.approval.forged", aid)
            await ctx.api.answer_callback(q["id"], "This button is not valid here", alert=True)
            return True
        with db.engine().connect() as c:
            ap = db.row(c.execute(select(models.approvals).where(models.approvals.c.id == aid)).first())
        if not ap:
            await ctx.api.answer_callback(q["id"], "Unknown approval")
            return True
        if ctx.fixed_agent and ap["agent_id"] != ctx.fixed_agent:
            await ctx.api.answer_callback(q["id"], "Not this agent's approval", alert=True)
            return True
        if ap["decision"]:
            await ctx.api.answer_callback(q["id"], f"Already {ap['decision']}")
            return True
        if access.task_stepup(aid):  # needs a fresh owner over the API: never decided by a chat button
            await access.stepup_refusal(ctx, user, q, chat_id, thread_id, aid, "task")
            return True
        r = ctx.orch.resolve_approval(aid, "approved" if yn == "y" else "denied", who)
        await ctx.api.answer_callback(q["id"], r["decision"])
        await ctx.api.send_message(chat_id, f"{'✅' if r['decision'] == 'approved' else '⛔'} {r['decision']}: "
                                            f"{ap['action_summary'][:300]}", thread_id)
        cardsvc.cards.touch(ap["task_id"], final=True)
        return True
    from nebula_runtime.orchestrator import get_task

    if data.startswith("as:"):
        _, tid, idx = data.split(":")
        choices = _assign_choices.get((ctx.key, chat_id)) or []
        try:
            target = choices[int(idx)]
            t = get_task(tid)
        except (IndexError, ValueError, KeyError):
            await ctx.api.answer_callback(q["id"], "Expired")
            return True
        if t["state"] not in ("QUEUED", "RECEIVED"):
            await ctx.api.answer_callback(q["id"], "Already started — cannot reassign")
            return True
        await ctx.orch.stop(tid, "cancel")
        rt = dict(t.get("reply_target") or {})
        new = ctx.orch.enqueue(target, t["prompt"], source="telegram", reply_target=rt)
        audit(who, "telegram.task.reassign", tid, {"to": target, "new_task": new["id"]})
        await ctx.api.answer_callback(q["id"], "Reassigned")
        cardsvc.cards.touch(tid, final=True)
        await cardsvc.cards.open(ctx.key, new["id"], chat_id, thread_id)
        return True
    # task card buttons
    _, act, tid = data.split(":", 2)
    try:
        t = get_task(tid)
    except KeyError:
        await ctx.api.answer_callback(q["id"], "Unknown task")
        return True
    if ctx.fixed_agent and t["agent_id"] != ctx.fixed_agent:
        await ctx.api.answer_callback(q["id"], "Not this agent's task", alert=True)
        return True
    if act == "p":
        r = ctx.orch.pause(tid, "smart")
        await ctx.api.answer_callback(q["id"], f"Task {r['state']}")
    elif act == "r":
        r = ctx.orch.resume(tid)
        await ctx.api.answer_callback(q["id"], f"Task {r['state']}")
    elif act == "x":
        r = await ctx.orch.stop(tid, "cancel")
        await ctx.api.answer_callback(q["id"], f"Task {r['state']}")
    elif act == "i":
        await ctx.api.answer_callback(q["id"], "Capturing…")
        await _screenshot(ctx, t["agent_id"], chat_id, thread_id, f"Task #{tid[:8]} · {time.strftime('%H:%M:%S')}")
    elif act == "t":
        if t["state"] not in ("FAILED", "CANCELLED"):
            await ctx.api.answer_callback(q["id"], "Only failed or cancelled tasks can be retried")
            return True
        rt = dict(t.get("reply_target") or {})
        new = ctx.orch.enqueue(t["agent_id"], t["prompt"], source="telegram", reply_target=rt,
                               execution=t.get("execution"), conversation_id=t.get("conversation_id"))
        audit(who, "telegram.task.retry", tid, {"new_task": new["id"]})
        await ctx.api.answer_callback(q["id"], "Retrying")
        await cardsvc.cards.open(ctx.key, new["id"], chat_id, thread_id)
        return True
    elif act == "d":
        await ctx.api.answer_callback(q["id"])
        with db.engine().connect() as c:
            steps = db.rows(c.execute(select(models.task_steps).where(models.task_steps.c.task_id == tid)
                                      .order_by(models.task_steps.c.seq.desc()).limit(8)))
        lines = [f"Task #{tid[:8]} · {t['state']} · {(t.get('execution') or {}).get('env', 'vm')}",
                 f"Prompt: {t['prompt'][:600]}"]
        lines += [f"{s['seq']}. {s['tool_type']} → {s['result_status']}: {(s['result_summary'] or '')[:120]}"
                  for s in reversed(steps)]
        if t.get("failure_reason"):
            lines.append(f"Reason: {t['failure_reason'][:500]}")
        await ctx.api.send_message(chat_id, "\n".join(lines)[:4000], thread_id)
        return True
    elif act in ("l", "f"):
        await ctx.api.answer_callback(q["id"])
        res = t.get("result") or {}
        files = [a for a in res.get("verified_artifacts", []) if a.get("type") == "file"]
        if not files:
            await ctx.api.send_message(chat_id, "No verified result files for this task.", thread_id)
            return True
        if act == "f":
            await ctx.api.send_message(chat_id, "Result files:\n" + "\n".join(
                f"• {a['value']} ({a.get('size', '?')} B)" for a in files), thread_id)
        else:
            from nebula_telegram import v2 as tg2

            kb = [[{"text": f"⬇️ {str(a['value']).rsplit('/', 1)[-1][:40]}", "callback_data": f"dl:{tid}:{i}"}]
                  for i, a in enumerate(files[:6])]
            await ctx.api.send_message(chat_id, "Download:", thread_id, reply_markup={"inline_keyboard": kb})
            _ = tg2
        return True
    elif act == "a":
        await ctx.api.answer_callback(q["id"])
        if ctx.fixed_agent:
            await ctx.api.send_message(chat_id, "Agent bots always use their own agent.", thread_id)
            return True
        ags = [a for a in _agents() if a["id"] != t["agent_id"]][:10]
        _assign_choices[(ctx.key, chat_id)] = [a["id"] for a in ags]
        kb = [[{"text": f"{a['name']} · {a['status']}", "callback_data": f"as:{tid}:{i}"}] for i, a in enumerate(ags)]
        await ctx.api.send_message(chat_id, "Assign this queued task to:", thread_id, reply_markup={"inline_keyboard": kb})
        return True
    audit(who, f"telegram.card.{act}", tid)
    cardsvc.cards.touch(tid, final=True)
    return True


_assign_choices: dict[tuple[str, int], list[str]] = {}


# ============================================================================ notifications
def _event_bot(ev: dict[str, Any]) -> str | None:
    rt = (ev.get("payload") or {}).get("reply_target") or {}
    return rt.get("bot")


async def on_task_event(ctx, ev: dict[str, Any]) -> None:
    """Card refresh + results for tasks that belong to this bot context."""
    t, tid = ev["type"], ev.get("task_id")
    if not tid:
        return
    final = t in ("task.completed", "task.failed", "task.cancelled")
    if t == "task.stage":
        p = ev.get("payload") or {}
        cardsvc.note_stage(tid, str(p.get("stage") or ""), p.get("detail"))
    if final:
        cardsvc.STAGES.pop(tid, None)
    if t in ("task.started", "task.step", "task.stage", "task.paused", "task.resumed", "task.approval.requested",
             "task.approval.resolved") or final:
        cardsvc.cards.touch(tid, final=final or t.startswith("task.approval"))


async def deliver_result(ctx, ev: dict[str, Any]) -> None:
    """Completion / failure message for a task created through this bot (respecting notification levels)."""
    from nebula_runtime.orchestrator import get_task

    p, tid = ev["payload"], ev["task_id"]
    rt = p.get("reply_target") or {}
    chat, thread = rt.get("chat_id"), rt.get("thread_id")
    if not chat:
        return
    level = cardsvc.level_of(ctx.key, chat)
    kind = "completion" if ev["type"] == "task.completed" else "failure"
    if not cardsvc.wants(level, kind):
        return
    try:
        task = get_task(tid)
    except KeyError:
        return
    res = p.get("result") or {}
    if ev["type"] == "task.completed":
        summary = (res.get("summary") or "").strip()
        from nebula_host import voice as vsvc

        # spoken in the language of the request (voice tasks) or of the text itself; English unless it is Czech
        if rt.get("voice"):
            await reply_voice(ctx, task["agent_id"], f"✅ {summary[:3000]}", chat, thread,
                              rt.get("language") or vsvc.detect_language(summary), input_was_voice=True)
        else:
            await ctx.api.send_message(chat, f"✅ Task #{tid[:8]} completed ({res.get('verification')}).\n\n"
                                             f"{summary[:3000]}", thread)
            if vsvc.agent_voice(_agent(task["agent_id"]) or {})["reply_mode"] in ("voice", "text_voice") and summary:
                await reply_voice(ctx, task["agent_id"], summary[:1500], chat, thread, vsvc.detect_language(summary),
                                  input_was_voice=False)
    else:
        word = "failed" if ev["type"] == "task.failed" else "cancelled"
        await ctx.api.send_message(chat, f"⚠️ Task #{tid[:8]} {word}: {p.get('reason')}", thread)


_asked: dict[str, float] = {}


async def forward_question(ctx, ev: dict[str, Any], rt: dict[str, Any]) -> None:
    """The agent asked the owner something in plain text: forward it (rate limited, level 'question')."""
    text = ((ev.get("payload") or {}).get("text") or "").strip()
    tid = ev.get("task_id") or ""
    if not text.endswith("?") or not rt.get("chat_id") or time.time() - _asked.get(tid, 0) < 60:
        return
    if not cardsvc.wants(cardsvc.level_of(ctx.key, rt["chat_id"]), "question"):
        return
    _asked[tid] = time.time()
    await ctx.api.send_message(rt["chat_id"], f"💬 Agent asks: {text[-800:]}\n(Reply with a new message to continue.)",
                               rt.get("thread_id"))


async def send_approval(ctx, chat_id: int, thread_id, ev: dict[str, Any], *, silent: bool = False) -> None:
    """A task approval card for the owner's chat. Ordinary approvals: one tap (HMAC-bound buttons). Approvals that
    need a fresh owner over the API (vault, credential, host and system): the card opens the Mini App instead (or
    says where to decide); its chat buttons never decide them."""
    p = ev["payload"]
    vault = p.get("tool") == "vault_sign_in"
    buttons = cardsvc.approval_buttons(p["approval_id"], ctx.key, chat_id, once=vault)
    stepup = access.task_stepup(p["approval_id"], p)
    kb = access.stepup_keyboard(ctx, buttons) if stepup else {"inline_keyboard": [buttons]}
    if vault:  # metadata only: agent, credential name, origin, action, task, expiry — never a secret
        pv = p.get("preview") or {}
        text = (f"🔐 Password Vault — approval needed\nAgent: {pv.get('agent_name')}\nCredential: "
                f"{pv.get('credential_name')}\nDestination: {pv.get('origin')}\nAction: sign in\n"
                f"Task: #{ev['task_id'][:8]}\nExpires: {time.strftime('%H:%M', time.localtime(p.get('expires_at') or 0))}"
                f"\nThe agent never sees the password; NEBULA signs in separately.")
    else:
        text = f"🛂 Approval needed (task #{ev['task_id'][:8]}):\n{p.get('summary', '')[:700]}\nReason: {p.get('reason')}"
    if stepup:
        text += "\n" + access.stepup_note(ctx, access.mini_url(ctx))
    await ctx.api.send_message(chat_id, text, thread_id, reply_markup=kb, silent=silent)


async def send_waiting_note(ctx, chat_id: int, thread_id, ev: dict[str, Any], *, silent: bool = False) -> None:
    """The requester of a task is not the owner: no approval card, only a note that the owner decides."""
    await ctx.api.send_message(chat_id, f"🛂 Task #{(ev.get('task_id') or '')[:8]} waits for the NEBULA owner's "
                                        "approval. It continues once the owner decides.", thread_id, silent=silent)


_SIGN_IN_ACTIONS = {"credentials": "sign in", "otp": "enter a verification code", "recovery_code":
                    "enter a recovery code", "confirm_destination": "review where the sign-in continues",
                    "device_approval": "approve the sign-in on your device", "manual":
                    "finish one step in Live Desktop (CAPTCHA / passkey)"}
# V3.4: what the page asks right now (the state comes from the broker's own reading of the page)
_SIGN_IN_STATES = {"EMAIL_REQUIRED": "enter your e-mail address", "USERNAME_REQUIRED": "enter your username",
                   "PHONE_REQUIRED": "enter your phone number", "IDENTIFIER_REQUIRED": "enter your username or e-mail",
                   "PASSWORD_REQUIRED": "enter your password",
                   "IDENTIFIER_AND_PASSWORD_REQUIRED": "enter your username/e-mail and password",
                   "OTP_REQUIRED": "enter a verification code",
                   "AUTHENTICATOR_APPROVAL": "approve the sign-in in your authenticator app",
                   "PASSKEY_REQUIRED": "choose another way to sign in (the site asks for a passkey)",
                   "SECURITY_KEY_REQUIRED": "choose another way to sign in (the site asks for a security key)",
                   "LOGIN_ERROR": "check the sign-in details (the site did not accept them)",
                   "UNKNOWN_STEP": "check a sign-in step NEBULA could not recognise (Live Desktop)",
                   "REDIRECT_REVIEW_REQUIRED": "review where the sign-in continues"}
_sign_in_sent: dict[str, float] = {}


async def send_sign_in(ctx, chat_id: int, thread_id, ev: dict[str, Any], *, silent: bool = False) -> None:
    """Smart Authentication request (V3.2.1): metadata + a button to the secure Mini App form. Never a field to type
    a secret into, never a secret (Telegram chats are not a secure channel for passwords or codes)."""
    p = ev.get("payload") or {}
    rid = str(p.get("request_id") or "")
    key = f"{chat_id}:{rid}"
    if not rid or key in _sign_in_sent:
        return
    _sign_in_sent[key] = time.time()
    for k in [k for k, t in _sign_in_sent.items() if time.time() - t > 3600]:
        _sign_in_sent.pop(k, None)
    sid = str(p.get("session_id") or "")
    action = _SIGN_IN_STATES.get(str(p.get("state"))) or _SIGN_IN_ACTIONS.get(str(p.get("request_type")),
                                                                             "help with a sign-in")
    exp = time.strftime("%H:%M", time.localtime(p.get("expires_at") or time.time()))
    where = (f"Verified site: {p.get('origin')}" if p.get("verified") else
             f"Requested site (not verified yet): {p.get('origin')}")
    if p.get("request_type") == "confirm_destination" and p.get("destination"):
        where += f"\nThe sign-in wants to continue on: {p.get('destination')} — not approved yet"
    trust = {"GREEN": "🟢 Verified sign-in page", "YELLOW": "🟡 Review the address before entering anything",
             "RED": "🔴 Blocked as suspicious"}.get(str(p.get("trust") or ""))
    if trust:
        where += f"\n{trust}"
    text = (f"🔐 NEBULA — Authentication required\n{p.get('agent_name') or 'An agent'} needs you to {action} on "
            f"{p.get('site')}.\n{where}\nTask #{(ev.get('task_id') or '')[:8]} · "
            f"expires {exp}\nWhat you enter is never shown to the agent or the AI model.")
    rows = []
    url = public_url(ctx)
    if url:
        rows.append([{"text": "🔐 Open secure form", "web_app": {"url": f"{url}/mini/#/auth/{sid}"}}])
    else:
        text += "\nOpen NEBULA on your Mac (Dashboard → Approvals) to continue."
    rows.append([{"text": "✖️ Cancel sign-in", "callback_data": f"auth:{sid}:c"}])
    await ctx.api.send_message(chat_id, text, thread_id, reply_markup={"inline_keyboard": rows}, silent=silent)


async def company_notify(ctx, ev: dict[str, Any], owners: list[dict[str, Any]]) -> bool:
    t, p = ev["type"], ev.get("payload") or {}
    if t == "company.run.finished":
        res = p.get("result") or {}
        icon = "✅" if p.get("state") == "COMPLETED" else "⚠️"
        rt = p.get("reply_target") or {}
        targets = [(rt["chat_id"], rt.get("thread_id"))] if rt.get("chat_id") else [(u["chat_id"], None) for u in owners]
        for chat, thread in targets:
            if not cardsvc.wants(cardsvc.level_of(ctx.key, chat), "completion" if icon == "✅" else "failure"):
                continue
            await ctx.api.send_message(chat, f"{icon} 🏢 {p.get('company')} · {p.get('project')}: run #{p['run_id'][:8]} "
                                             f"{str(p.get('state', '')).lower()}.\n\n{(res.get('summary') or '')[:3200]}",
                                       thread, reply_markup={"inline_keyboard": [[{"text": "📊 Details",
                                                                                    "callback_data": f"cr:{p['run_id']}"}]]})
        return True
    if t == "company.run.started":
        rt = p.get("reply_target") or {}
        if p.get("source") != "telegram":
            for u in owners:
                if cardsvc.wants(cardsvc.level_of(ctx.key, u["chat_id"]), "progress"):
                    await ctx.api.send_message(u["chat_id"], f"🏢 {p.get('company')} · {p.get('project')}: run "
                                                             f"#{p['run_id'][:8]} started ({p.get('planner')}).")
        return True
    return t in ("company.item.changed", "company.activity", "company.created", "company.updated",
                 "environment.changed", "bot.state.changed", "attachment.processed", "host.command",
                 "remote.state.changed")
