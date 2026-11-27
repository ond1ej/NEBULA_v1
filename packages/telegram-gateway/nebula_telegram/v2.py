"""Telegram 2.0 features, kept out of the V1 gateway core: teams, schedules, history, files, model switching,
workflow commands, voice transcription, ZIP intake, inline task controls, result downloads, V2 notifications.

Every entry point is called by TelegramGateway only for an already authorised (paired + approved) user.
"""

from __future__ import annotations

import base64
import io
import logging
import re
import time
import zipfile
from typing import Any

from nebula_host import db, models
from nebula_host.events import audit
from sqlalchemy import and_, select

from nebula_telegram import access

log = logging.getLogger("nebula.telegram.v2")
MAX_SEND = 45 * 1024 * 1024
ZIP_MAX_FILES = 500
ZIP_MAX_TOTAL = 100 * 1024 * 1024
CODE_EXT = re.compile(r"\.(py|js|ts|tsx|jsx|json|ya?ml|toml|ini|cfg|md|txt|csv|tsv|html?|css|scss|sh|sql|xml|go|rs|"
                      r"java|kt|c|h|cpp|hpp|cs|rb|php|swift|ipynb|log|pdf|zip|png|jpe?g|gif|webp)$", re.I)
# /help is answered by nebula_telegram.v3 (HELP_V3) on every bot; this module has no help text of its own


def task_kb(task_id: str) -> dict[str, Any]:
    return {"inline_keyboard": [[{"text": "📊 Status", "callback_data": f"t:s:{task_id}"},
                                 {"text": "⏸ Pause", "callback_data": f"t:p:{task_id}"},
                                 {"text": "▶️ Resume", "callback_data": f"t:r:{task_id}"}],
                                [{"text": "⏹ Stop", "callback_data": f"t:x:{task_id}"},
                                 {"text": "🖼 Screenshot", "callback_data": f"t:i:{task_id}"}]]}


def _svc(gw):
    if gw.v2 is None:
        raise RuntimeError("NEBULA V2 services not attached")
    return gw.v2


def artifact_root(agent_id: str, path: str) -> tuple[str, str]:
    m = re.match(r"^/srv/nebula/shared/([0-9a-f]{8,16})/(.+)$", path)
    if m:
        with db.engine().connect() as c:
            tid = c.execute(select(models.teams.c.id).where(models.teams.c.shared_dir == m.group(1))).scalar()
        if tid:
            return f"team:{tid}", m.group(2)
    rel = re.sub(r"^/home/[^/]+/workspace/", "", path)
    return f"agent:{agent_id}", rel.lstrip("/")


async def send_file(gw, chat_id: int, thread_id: int | None, root: str, path: str, caption: str = "") -> bool:
    svc = _svc(gw)
    st = await svc.files.op(root, "stat", path=path)
    if st.get("type") != "file":
        await gw.api.send_message(chat_id, f"{path} is not a file.", thread_id)
        return False
    if st["size"] > MAX_SEND:
        await gw.api.send_message(chat_id, f"{path} is {st['size'] // 1048576} MB — too large for Telegram; download it "
                                           "in the Dashboard (Files).", thread_id)
        return False
    data = b""
    async for ch in svc.files.read_all(root, path, limit=MAX_SEND):
        data += ch
    await gw.api.send_document(chat_id, path.rsplit("/", 1)[-1], data, caption or path, thread_id)
    return True


# ---------------------------------------------------------------------------- commands
async def command(gw, user: dict[str, Any], cmd: str, args: str, thread_id: int | None,
                  agent_id: str | None) -> bool:
    chat_id = user["chat_id"]
    actor = f"telegram:{user['telegram_user_id']}"

    async def send(t: str, **kw):
        return await gw.api.send_message(chat_id, t, thread_id, **kw)

    svc = gw.v2
    if svc is None:
        return False
    if cmd == "teams":
        from nebula_host import teams as teamsvc

        ts = teamsvc.list_teams()
        if not ts:
            await send("No teams yet — create one in the Dashboard (Teams).")
            return True
        lines = [f"• {t['name']} ({t['mode']}): " + " → ".join(f"{m['role']}·{m['agent_name']}" for m in t["members"])
                 for t in ts]
        await send("Teams:\n" + "\n".join(lines) + "\n\nGive a task: /team <name> <task>")
        return True
    if cmd == "team":
        from nebula_host import teams as teamsvc

        parts = args.split(None, 1)
        t = teamsvc.find_team(parts[0]) if parts else None
        if not t or len(parts) < 2:
            await send("Usage: /team <team name> <task>   (see /teams)")
            return True
        try:
            run = await svc.teams.start_run(t["id"], parts[1], source="telegram",
                                            reply_target={"chat_id": chat_id, "thread_id": thread_id}, actor=actor)
        except Exception as e:  # noqa: BLE001
            await send(f"Team run not started: {e}")
            return True
        await send(f"👥 Team {t['name']} started run #{run['id'][:8]} with {len(run['subtasks'])} subtasks. "
                   "I'll report back here.")
        return True
    if cmd == "schedules":
        from nebula_host import schedules as schedsvc

        rows = schedsvc.list_all()[:15]
        if not rows:
            await send("No schedules. Create them in the Dashboard (Schedules).")
            return True
        lines, kb = [], []
        for s in rows:
            nxt = time.strftime("%d.%m %H:%M", time.localtime(s["next_run_at"])) if s["next_run_at"] else "—"
            last = (s.get("last_run") or {}).get("state", "never")
            lines.append(f"• {s['name']} [{s['kind']}] {'on' if s['enabled'] else 'off'} · next {nxt} · last {last}")
            kb.append([{"text": f"▶️ Run now: {s['name'][:30]}", "callback_data": f"sch:{s['id']}"}])
        await send("Schedules:\n" + "\n".join(lines), reply_markup={"inline_keyboard": kb[:8]})
        return True
    if cmd == "history":
        if not agent_id:
            await gw._choose_agent(chat_id, thread_id, "History of which agent?")
            return True
        with db.engine().connect() as c:
            rows = db.rows(c.execute(select(models.tasks).where(models.tasks.c.agent_id == agent_id)
                                     .order_by(models.tasks.c.created_at.desc()).limit(10)))
        lines = [f"#{t['id'][:8]} {t['state']} · {time.strftime('%d.%m %H:%M', time.localtime(t['created_at']))} · "
                 f"{t['prompt'][:60]}" for t in rows] or ["(no tasks)"]
        await send("Recent tasks:\n" + "\n".join(lines))
        return True
    if cmd == "files":
        if not agent_id:
            await gw._choose_agent(chat_id, thread_id, "Files of which agent?")
            return True
        try:
            r = await svc.files.op(f"agent:{agent_id}", "list", path=args.strip() or ".")
        except Exception as e:  # noqa: BLE001
            await send(f"Cannot list: {e}")
            return True
        ents = r["entries"][:40]
        lines = [f"{'📁' if e['type'] == 'dir' else '📄'} {e['path']}" + (f" ({e['size'] // 1024} KB)" if e["type"] == "file"
                                                                       else "") for e in ents] or ["(empty)"]
        await send(f"Workspace /{r['path']}:\n" + "\n".join(lines) + "\n\nDownload: /get <path>")
        return True
    if cmd == "get":
        if not agent_id or not args.strip():
            await send("Usage: /get <path in the agent workspace>")
            return True
        root, path = artifact_root(agent_id, args.strip())
        try:
            await send_file(gw, chat_id, thread_id, root, path)
            audit(actor, "telegram.file_download", f"{root}:{path}")
        except Exception as e:  # noqa: BLE001
            await send(f"Download failed: {e}")
        return True
    if cmd == "model":
        if not agent_id:
            await gw._choose_agent(chat_id, thread_id, "Model of which agent?")
            return True
        from nebula_host import providers_service as provs

        with db.engine().connect() as c:
            a = c.execute(select(models.agents).where(models.agents.c.id == agent_id)).first()
        try:
            avail = [m.id for m in await provs.list_models_cached(a.provider_id)] if a.provider_id else []
        except Exception:  # noqa: BLE001
            avail = []
        want = args.strip()
        if not want:
            gw._model_choices[chat_id] = avail[:20]
            kb = [[{"text": m[:40], "callback_data": f"mdl:{i}"}] for i, m in enumerate(avail[:20])]
            await send(f"{a.name}: {a.provider_id} / {a.model_id}\nChoose a model:" if avail else
                       f"{a.name}: {a.provider_id} / {a.model_id} (no model list available)",
                       reply_markup={"inline_keyboard": kb} if kb else None)
            return True
        await _set_model(gw, chat_id, thread_id, agent_id, want, avail, actor)
        return True
    if cmd == "wf":
        parts = args.split(None, 1)
        if not parts:
            await send("Usage: /wf <command> <text>")
            return True
        started = await svc.workflows.on_telegram(parts[0].lower(), parts[1] if len(parts) > 1 else "",
                                                  {"chat_id": chat_id, "thread_id": thread_id})
        await send(f"⚙️ Started {len(started)} workflow run(s)." if started else
                   f"No enabled workflow listens to /wf {parts[0]}.")
        return True
    if cmd == "approvals":
        from nebula_host import approvals_v2

        if not await access.require(gw, user, (access.APPROVAL,), chat_id, thread_id, what="/approvals"):
            return True  # pending approvals are listed (and decided) by the owner only
        with db.engine().connect() as c:
            pend = db.rows(c.execute(select(models.approvals).where(models.approvals.c.decision.is_(None))
                                     .where(models.approvals.c.expires_at > time.time())))
        owner = approvals_v2.pending()
        if not pend and not owner:
            await send("No pending approvals.")
            return True
        url = access.mini_url(gw)
        for a in pend[:5]:
            buttons = [{"text": "✅ Approve", "callback_data": f"appr:{a['id']}:y"},
                       {"text": "⛔ Reject", "callback_data": f"appr:{a['id']}:n"}]
            text = f"Task approval #{a['id'][:8]}: {a['action_summary'][:500]}"
            if access.task_stepup(a["id"]):
                await send(f"{text}\n{access.stepup_note(gw, url)}", reply_markup=access.stepup_keyboard(gw, buttons))
            else:
                await send(text, reply_markup={"inline_keyboard": [buttons]})
        for a in owner[:5]:
            text = f"{a['kind']} approval: {a['summary'][:500]}"
            if access.owner_stepup(a):
                text += "\n" + access.stepup_note(gw, url)
            await send(text, reply_markup=owner_card_kb(gw, a))
        return True
    return False


def owner_kb(aid: str) -> dict[str, Any]:
    return {"inline_keyboard": [[{"text": "✅ Approve", "callback_data": f"oa:{aid}:y"},
                                 {"text": "⛔ Reject", "callback_data": f"oa:{aid}:n"}]]}


def owner_card_kb(gw, a: dict[str, Any]) -> dict[str, Any]:
    """Owner approval buttons: one tap, except for kinds that need a fresh owner (commands, packages, plugins)."""
    kb = owner_kb(a["id"])
    return access.stepup_keyboard(gw, kb["inline_keyboard"][0]) if access.owner_stepup(a) else kb


async def _set_model(gw, chat_id, thread_id, agent_id, want, avail, actor) -> None:
    from sqlalchemy import update

    if avail and want not in avail:
        await gw.api.send_message(chat_id, f"Unknown model {want!r}.", thread_id)
        return
    with db.engine().begin() as c:
        c.execute(update(models.agents).where(models.agents.c.id == agent_id).values(model_id=want, updated_at=db.now()))
    audit(actor, "agent.model_change", agent_id, {"model_id": want})
    await gw.api.send_message(chat_id, f"Model changed to {want}.", thread_id)


# ---------------------------------------------------------------------------- callbacks
async def callback(gw, user: dict[str, Any], q: dict[str, Any], data: str, chat_id: int,
                   thread_id: int | None) -> bool:
    actor = f"telegram:{user['telegram_user_id']}"
    if data.startswith("t:"):
        _, act, tid = data.split(":", 2)
        from nebula_runtime.orchestrator import get_task

        try:
            t = get_task(tid)
        except KeyError:
            await gw.api.answer_callback(q["id"], "Unknown task")
            return True
        if act == "s":
            await gw.api.answer_callback(q["id"], f"{t['state']} · step {t['current_step']}")
        elif act == "p":
            r = gw.orch.pause(tid, "smart")
            await gw.api.answer_callback(q["id"], f"Task {r['state']}")
        elif act == "r":
            r = gw.orch.resume(tid)
            await gw.api.answer_callback(q["id"], f"Task {r['state']}")
        elif act == "x":
            r = await gw.orch.stop(tid, "cancel")
            await gw.api.answer_callback(q["id"], f"Task {r['state']}")
        elif act == "i":
            from nebula_host.agents_service import desktop_unavailable

            if (why := desktop_unavailable(t["agent_id"])):
                await gw.api.answer_callback(q["id"], f"No screenshot: {why}"[:190])
                return True
            await gw.api.answer_callback(q["id"], "Capturing…")
            res = await gw.guest.tool(t["agent_id"], "desktop.screenshot", {}, timeout=30)
            if res.get("ok"):
                await gw.api.send_photo(chat_id, base64.b64decode(res["result"]["png_b64"]),
                                        f"Task #{tid[:8]} · {time.strftime('%H:%M:%S')}", thread_id)
        audit(actor, f"telegram.task.{act}", tid)
        return True
    if data.startswith("dl:"):
        _, tid, idx = data.split(":")
        from nebula_runtime.orchestrator import get_task

        try:
            t = get_task(tid)
            arts = [a for a in (t.get("result") or {}).get("verified_artifacts", []) if a.get("type") == "file"]
            a = arts[int(idx)]
        except (KeyError, IndexError, ValueError):
            await gw.api.answer_callback(q["id"], "File no longer available")
            return True
        await gw.api.answer_callback(q["id"], "Sending…")
        root, path = artifact_root(t["agent_id"], a["value"])
        try:
            await send_file(gw, chat_id, thread_id, root, path)
            audit(actor, "telegram.file_download", f"{root}:{path}")
        except Exception as e:  # noqa: BLE001
            await gw.api.send_message(chat_id, f"Download failed: {e}", thread_id)
        return True
    if data.startswith("oa:"):
        parts = data.split(":")
        if len(parts) != 3:
            await gw.api.answer_callback(q["id"], "Invalid")
            return True
        _, aid, yn = parts
        from nebula_host import approvals_v2

        if not await access.require(gw, user, (access.APPROVAL,), chat_id, thread_id, q=q, what="oa", target=aid):
            return True  # owner approvals are the owner's decision only
        try:
            a = approvals_v2.get(aid)
        except KeyError:
            await gw.api.answer_callback(q["id"], "Unknown approval")
            return True
        if not a.get("decision") and access.owner_stepup(a):  # commands, packages, plugins: a fresh owner
            await access.stepup_refusal(gw, user, q, chat_id, thread_id, aid, a.get("kind") or "owner")
            return True
        try:
            r = await approvals_v2.resolve(aid, "approved" if yn == "y" else "denied", actor)
            await gw.api.answer_callback(q["id"], r["decision"])
            await gw.api.send_message(chat_id, f"{r['kind']} approval {aid[:8]}: {r['decision']}", thread_id)
        except KeyError:
            await gw.api.answer_callback(q["id"], "Unknown approval")
        return True
    if data.startswith("sch:") and gw.v2 is not None:
        try:
            r = await gw.v2.schedules.run_now(data[4:], actor)
            await gw.api.answer_callback(q["id"], "Started")
            await gw.api.send_message(chat_id, f"▶️ Schedule run started ({r['state']}).", thread_id)
        except Exception as e:  # noqa: BLE001
            await gw.api.answer_callback(q["id"], str(e)[:180])
        return True
    if data.startswith("mdl:"):
        choices = gw._model_choices.get(chat_id) or []
        try:
            want = choices[int(data[4:])]
        except (IndexError, ValueError):
            await gw.api.answer_callback(q["id"], "Expired, use /model again")
            return True
        agent_id = gw._route(user, chat_id, thread_id)
        await gw.api.answer_callback(q["id"], want)
        if agent_id:
            await _set_model(gw, chat_id, thread_id, agent_id, want, choices, actor)
        return True
    return False


# ---------------------------------------------------------------------------- voice & files
async def handle_voice(gw, user: dict[str, Any], agent_id: str, m: dict[str, Any], chat_id: int,
                       thread_id: int | None) -> None:
    from nebula_host import stt

    v = m.get("voice") or m.get("audio") or m.get("video_note") or {}
    maxb = gw.cfg.telegram.max_attachment_mb * 1024 * 1024
    if v.get("file_size", 0) > maxb or v.get("duration", 0) > 600:
        await gw.api.send_message(chat_id, "Voice message too long (max 10 minutes).", thread_id)
        return
    st = stt.status(gw.cfg)
    if st["backend"] is None:
        await gw.api.send_message(chat_id, "🎙 Voice transcription is not set up yet, so nothing was sent anywhere.\n"
                                           + (st["setup_hint"] or ""), thread_id)
        return
    info = await gw.api.get_file(v["file_id"])
    data = await gw.api.download_file(info["file_path"], maxb)
    try:
        r = await stt.transcribe(gw.cfg, data, info["file_path"].rsplit("/", 1)[-1] or "voice.ogg")
    except Exception as e:  # noqa: BLE001
        await gw.api.send_message(chat_id, f"Transcription failed: {e}", thread_id)
        return
    text = r["text"].strip()
    if not text:
        await gw.api.send_message(chat_id, "I could not hear any words in that voice message.", thread_id)
        return
    audit(f"telegram:{user['telegram_user_id']}", "telegram.voice", agent_id, {"backend": r["backend"],
                                                                                "chars": len(text)})
    await gw.api.send_message(chat_id, f"🎙 ({r['backend']}): “{text[:500]}”", thread_id)
    task = gw.orch.enqueue(agent_id, text, source="telegram",
                           reply_target={"chat_id": chat_id, "thread_id": thread_id, "user_id": user["telegram_user_id"]})
    sent = await gw.api.send_message(chat_id, f"✅ Task accepted #{task['id'][:8]} — working on it…", thread_id,
                                     reply_markup=task_kb(task["id"]))
    gw._status_msgs[task["id"]] = (chat_id, sent["message_id"], 0.0)


def allowed_upload(name: str, mime: str, base_re) -> bool:
    return bool(base_re.match(mime) or CODE_EXT.search(name or ""))


async def extract_zip(gw, agent_id: str, data: bytes, base: str) -> dict[str, Any]:
    """Safe ZIP intake: no absolute paths, no '..', no symlinks, bounded file count and total size."""
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        return {"ok": False, "error": "not a valid ZIP archive"}
    infos = [i for i in zf.infolist() if not i.is_dir()]
    if len(infos) > ZIP_MAX_FILES:
        return {"ok": False, "error": f"more than {ZIP_MAX_FILES} files"}
    if sum(i.file_size for i in infos) > ZIP_MAX_TOTAL:
        return {"ok": False, "error": "unpacks to more than 100 MB"}
    svc = _svc(gw)
    written = 0
    for i in infos:
        name = i.filename.replace("\\", "/")
        parts = [p for p in name.split("/") if p not in ("", ".")]
        if name.startswith("/") or ".." in parts or (i.external_attr >> 16) & 0o170000 == 0o120000 or not parts:
            return {"ok": False, "error": f"unsafe entry {i.filename!r} — nothing more was extracted"}
        content = zf.read(i)

        async def gen(b=content):
            yield b

        await svc.files.write_stream(f"agent:{agent_id}", f"{base}/{'/'.join(parts)}", gen(), "telegram:zip")
        written += 1
    return {"ok": True, "files": written, "dir": base}


# ---------------------------------------------------------------------------- notifications
async def notify(gw, ev: dict[str, Any]) -> bool:
    """V2 events. Returns True when the event was fully handled here."""
    t, p = ev["type"], ev.get("payload") or {}
    owners = gw._approved_users()
    if t == "owner.approval.requested":  # to the owner's chat only (B1); other approved accounts never get it
        a = {"id": p["approval_id"], "kind": p.get("kind")}
        text = f"🛂 Approval needed ({p.get('kind')}): {p.get('summary', '')[:700]}"
        if access.owner_stepup(a):
            text += "\n" + access.stepup_note(gw, access.mini_url(gw))
        for u in access.owner_rows(owners):
            await gw.api.send_message(u["chat_id"], text, reply_markup=owner_card_kb(gw, a))
        return True
    if t == "schedule.run.finished":
        if p.get("notify_telegram") and p.get("state") in ("COMPLETED", "FAILED", "SKIPPED"):
            icon = {"COMPLETED": "✅", "FAILED": "⚠️", "SKIPPED": "⏭"}[p["state"]]
            for u in owners:
                await gw.api.send_message(u["chat_id"], f"{icon} Scheduled task “{p.get('name')}” {p['state'].lower()}.\n\n"
                                                        f"{(p.get('detail') or '')[:3000]}")
        return True
    if t in ("team.run.completed", "team.run.failed"):
        rt = p.get("reply_target") or {}
        if p.get("source") == "telegram" and rt.get("chat_id"):
            res = p.get("result") or {}
            icon = "✅" if t.endswith("completed") else "⚠️"
            await gw.api.send_message(rt["chat_id"], f"{icon} Team {p.get('team')} run #{p['run_id'][:8]} "
                                                     f"{p.get('state', '').lower()}.\n\n{(res.get('summary') or '')[:3200]}",
                                      rt.get("thread_id"))
            sent = 0
            for a in res.get("artifacts", []):
                if a.get("type") != "file" or sent >= 5:
                    continue
                from nebula_host import teams as teamsvc

                team = teamsvc.get_team(p["team_id"])
                root, path = artifact_root(team["lead_agent_id"] or "", a["value"])
                try:
                    if await send_file(gw, rt["chat_id"], rt.get("thread_id"), root, path):
                        sent += 1
                except Exception as e:  # noqa: BLE001
                    log.warning("team artifact %s not sent: %s", a["value"], e)
        return True
    if t == "resource.alert" and p.get("level") == "critical":
        for u in owners:
            await gw.api.send_message(u["chat_id"], f"🚨 NEBULA: {p.get('message')}")
        return True
    if t == "task.started" and ev.get("task_id") in gw._status_msgs:
        chat, mid, _ = gw._status_msgs[ev["task_id"]]
        await gw.api.edit_message_text(chat, mid, f"▶️ Task #{ev['task_id'][:8]} started…", reply_markup=task_kb(ev["task_id"]))
        return True
    if t == "task.message" and ev.get("task_id") in gw._status_msgs:
        text = (p.get("text") or "").strip()
        last = gw._asked.get(ev["task_id"], 0)
        if text.endswith("?") and time.time() - last > 60:
            gw._asked[ev["task_id"]] = time.time()
            chat, _, _ = gw._status_msgs[ev["task_id"]]
            await gw.api.send_message(chat, f"💬 Agent asks: {text[-800:]}\n(Reply with a new message to continue.)")
        return True
    return t in ("workflow.step", "team.subtask.changed", "workflow.run.started", "schedule.run.started",
                 "file.created", "memory.changed", "skill.changed", "owner.approval.resolved", "team.run.started")


async def result_buttons(gw, chat_id: int, thread_id: int | None, task_id: str, result: dict[str, Any]) -> None:
    files = [a for a in result.get("verified_artifacts", []) if a.get("type") == "file"][:6]
    if not files:
        return
    kb = [[{"text": f"⬇️ {a['value'].rsplit('/', 1)[-1][:40]}", "callback_data": f"dl:{task_id}:{i}"}]
          for i, a in enumerate(files)]
    await gw.api.send_message(chat_id, "Download result files:", thread_id, reply_markup={"inline_keyboard": kb})


async def send_to_owners(gw, text: str, attach: tuple[str, bytes] | None = None) -> int:
    n = 0
    for u in gw._approved_users():
        await gw.api.send_message(u["chat_id"], text)
        if attach:
            await gw.api.send_document(u["chat_id"], attach[0], attach[1], attach[0])
        n += 1
    return n


def _unused() -> None:
    _ = and_
