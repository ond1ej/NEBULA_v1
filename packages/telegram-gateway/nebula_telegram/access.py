"""Who may do what in a NEBULA Telegram chat: the roles of the API (nebula_host.authz) applied to chat commands,
buttons, voice commands and approval cards (B1 / NEW-3).

* owner           the NEBULA owner's own Telegram account (authz.primary_owner_telegram_id()), on the main bot and on
                  every agent bot: every command. Approvals are decided only by the owner. Approvals that need a fresh
                  owner over the API (approvals_v2.needs_stepup kinds; vault, credential, host and system task
                  approvals) are never decided by a chat button: the card sends the owner to the Mini App or the
                  Dashboard, where the owner confirms it's them. Ordinary approvals stay one tap for the owner.
* operator        any other approved account of the main bot: exactly the permissions stored for it
                  (telegram_users.permissions, by default tasks, commands and screenshot), never administration and
                  never approvals.
* agent-bot user  any other approved account of an agent's own bot: confined to that bot's agent by the bot itself
                  (nebula_telegram.multibot), never approvals and never owner-only commands.

Every command and button maps to the permission of the API route that does the same thing (op:<permission>), to
nothing (what any signed-in role may read) or to the owner. A command or button that is not mapped is refused for
everyone but the owner (deny by default).
"""

from __future__ import annotations

from typing import Any

from nebula_host import db, models
from nebula_host.events import audit
from sqlalchemy import select

OWNER = "owner"  # administration: only the owner
APPROVAL = "approval"  # deciding an approval: only the owner
NOT_OWNER_APPROVAL = "Only the NEBULA owner can decide this."
NOT_OWNER = "Only the NEBULA owner can do this."
STEPUP_ALERT = ("This approval needs you to confirm it's you, so the chat cannot decide it. Open it in the NEBULA "
                "Mini App or in the Dashboard on your Mac.")

# chat commands -> what they need (the API policy of the same operation)
COMMANDS: dict[str, tuple[str, ...]] = {
    # any approved account of this bot (read-only, own chat settings, or a link)
    "start": (), "help": (), "notify": (), "app": (), "agents": (), "use": (), "status": (), "history": (),
    "teams": (), "schedules": (), "companies": (), "company": (), "progress": (),
    # stored permissions
    "pause": ("commands",), "resume": ("commands",), "stop": ("commands",), "screenshot": ("screenshot",),
    "files": ("files",), "get": ("files",), "team": ("tasks",), "project": ("companies",), "wf": ("workflows",),
    # the owner only
    "newagent": (OWNER,), "model": (OWNER,), "approvals": (APPROVAL,),
}
# inline buttons, by callback prefix ("c:" and "t:" task buttons by their action letter)
CALLBACKS: dict[str, tuple[str, ...]] = {
    "use": (), "nl": (), "co": (), "cr": (), "c:d": (), "c:f": (), "c:l": (), "t:s": (),
    "c:p": ("commands",), "c:r": ("commands",), "c:x": ("commands",), "c:t": ("commands",),
    "t:p": ("commands",), "t:r": ("commands",), "t:x": ("commands",),
    "c:i": ("screenshot",), "t:i": ("screenshot",),
    "c:a": ("tasks", "commands"), "as": ("tasks", "commands"),
    "dl": ("files",), "sch": ("tasks",),
    "mdl": (OWNER,), "lvl": (OWNER,), "auth": (OWNER,),
    "appr": (APPROVAL,), "oa": (APPROVAL,), "ap": (APPROVAL,),
}
# a message that is not a command becomes a task (text, files, voice notes: attachments are task input)
MESSAGE: tuple[str, ...] = ("tasks",)
# what a transcribed voice command does (an unknown intent is handled like stop, so it needs commands)
VOICE_INTENTS: dict[str, tuple[str, ...]] = {
    "task": ("tasks",), "pause": ("commands",), "resume": ("commands",), "stop": ("commands",),
    "screenshot": ("screenshot",), "status": (), "team_status": (), "company_status": (),
}


# ---------------------------------------------------------------------------------------------- roles
def owner_id() -> int | None:
    from nebula_host import authz

    return authz.primary_owner_telegram_id()


def is_owner_id(tg_user_id: Any) -> bool:
    owner = owner_id()
    try:
        return bool(owner) and int(tg_user_id or 0) == int(owner)
    except (TypeError, ValueError):
        return False


def is_owner(user: dict[str, Any]) -> bool:
    """The NEBULA owner's own Telegram account (on the main bot or on any agent bot)."""
    return is_owner_id(user.get("telegram_user_id"))


def owner_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The owner's approved chats among a bot's approved users (empty while no owner is designated)."""
    if not rows:
        return []  # nobody paired yet: no owner lookup (and nothing cached) for an event nobody would receive
    owner = owner_id()
    return [r for r in rows if owner and int(r.get("telegram_user_id") or 0) == int(owner)]


def requester(rt: dict[str, Any] | None) -> int | None:
    """The Telegram account a task was created by (private chats: the chat id is the user id)."""
    rt = rt or {}
    v = rt.get("user_id") or rt.get("chat_id")
    try:
        return int(v) if v else None
    except (TypeError, ValueError):
        return None


def stored_permissions(user: dict[str, Any]) -> frozenset[str]:
    from nebula_host import miniapp

    return frozenset(p for p in (user.get("permissions") or []) if p in miniapp.OPERATOR_PERMISSIONS)


def allowed(ctx, user: dict[str, Any], needs: tuple[str, ...] | None) -> bool:
    if not needs:
        return True
    if is_owner(user):
        return True
    if OWNER in needs or APPROVAL in needs:
        return False
    if getattr(ctx, "key", "main") != "main":
        return True  # agent-bot users: the bot itself confines every command and button to its own agent
    have = stored_permissions(user)
    return all(n in have for n in needs)


def command_needs(cmd: str, args: str = "") -> tuple[str, ...] | None:
    """What a chat command needs; None for a command NEBULA does not know."""
    if cmd == "voice":  # showing the reply mode is read-only; changing it is PUT /agents/{id}/voice (op:commands)
        from nebula_host import voice as vsvc

        return ("commands",) if args.strip().lower() in vsvc.REPLY_MODES else ()
    return COMMANDS.get(cmd)


def callback_needs(data: str) -> tuple[str, ...]:
    head, _, rest = (data or "").partition(":")
    key = f"{head}:{rest.split(':', 1)[0]}" if head in ("c", "t") else head
    return CALLBACKS.get(key, (OWNER,))  # deny by default


def refusal(needs: tuple[str, ...]) -> str:
    if APPROVAL in needs:
        return NOT_OWNER_APPROVAL
    if OWNER in needs:
        return NOT_OWNER
    return (f"You don't have the {' and '.join(needs)} permission{'s' if len(needs) > 1 else ''} for this. "
            "Ask the NEBULA owner.")


def _actor(ctx, user: dict[str, Any]) -> str:
    key = getattr(ctx, "key", "main")
    return f"telegram:{user.get('telegram_user_id')}" + ("" if key == "main" else f"@bot:{key[:8]}")


async def require(ctx, user: dict[str, Any], needs: tuple[str, ...] | None, chat_id: int, thread_id=None, *,
                  q: dict[str, Any] | None = None, what: str = "", target: str | None = None) -> bool:
    """True when the sender may go on; otherwise answers the button (or the chat), audits it and returns False."""
    if allowed(ctx, user, needs):
        return True
    needs = needs or ()
    text = refusal(needs)
    if APPROVAL in needs:
        audit(_actor(ctx, user), "telegram.approval.denied", target,
              {"bot": getattr(ctx, "key", "main"), "via": what[:32], "reason": "not_owner"})
    else:
        audit(_actor(ctx, user), "telegram.command.denied", what[:64] or None,
              {"bot": getattr(ctx, "key", "main"), "needs": list(needs)})
    if q is not None:
        await ctx.api.answer_callback(q["id"], text, alert=True)
    else:
        await ctx.api.send_message(chat_id, text, thread_id)
    return False


def approval_id_of(data: str) -> str | None:
    parts = (data or "").split(":")
    return parts[1] if len(parts) > 1 and parts[1] else None


# ---------------------------------------------------------------------------------------------- step-up
def task_stepup(approval_id: str, payload: dict[str, Any] | None = None) -> bool:
    """A task approval that needs a FRESH owner over the API (vault, credential, host and system approvals): the same
    rule as POST /approvals/{id} (nebula_host.api.routes.approval_needs_stepup). Without a stored row the event
    payload decides (tool and reason; no execution environment)."""
    from nebula_host.api.routes import approval_needs_stepup

    with db.engine().connect() as c:
        a = c.execute(select(models.approvals.c.tool, models.approvals.c.reason, models.tasks.c.execution)
                      .outerjoin(models.tasks, models.tasks.c.id == models.approvals.c.task_id)
                      .where(models.approvals.c.id == approval_id)).first()
    if a is None:
        p = payload or {}
        return approval_needs_stepup({"tool": p.get("tool"), "reason": p.get("reason")})
    env = (a.execution or {}).get("env") if isinstance(a.execution, dict) else None
    return approval_needs_stepup({"tool": a.tool, "reason": a.reason}, env)


def owner_stepup(approval: dict[str, Any]) -> bool:
    """An owner approval of a kind that runs something on the system (command, package, plugin)."""
    from nebula_host import approvals_v2

    return approvals_v2.needs_stepup(approval)


def mini_url(ctx) -> str | None:
    """The Mini App address a button of this bot can open to decide approvals. Only the main bot's Mini App shows
    approvals (an agent bot's Mini App never does, not even to the owner)."""
    if getattr(ctx, "key", "main") != "main":
        return None
    try:
        from nebula_host import remote

        return remote.public_base()
    except Exception:  # noqa: BLE001
        return None


def stepup_note(ctx, url: str | None) -> str:
    if url:
        return ("🔐 Deciding this needs you to confirm it's you, so it cannot be decided in the chat. Open it in the "
                "NEBULA Mini App.")
    where = ("the main NEBULA bot's Mini App or the Dashboard on your Mac" if getattr(ctx, "key", "main") != "main"
             else "NEBULA on your Mac (Dashboard → Approvals)")
    return f"🔐 Deciding this needs you to confirm it's you, so it cannot be decided in the chat. Open {where}."


def stepup_row(url: str) -> list[dict[str, Any]]:
    return [{"text": "🔐 Open in NEBULA to decide", "web_app": {"url": f"{url}/mini/#/approvals"}}]


def stepup_keyboard(ctx, chat_buttons: list[dict[str, Any]]) -> dict[str, Any]:
    """A step-up approval's card: a Mini App button when the main bot has a public address; otherwise the usual
    buttons, which only explain where to decide (their callbacks refuse step-up approvals)."""
    url = mini_url(ctx)
    return {"inline_keyboard": [stepup_row(url) if url else chat_buttons]}


async def stepup_refusal(ctx, user: dict[str, Any], q: dict[str, Any], chat_id: int, thread_id, approval_id: str,
                         kind: str) -> None:
    """The owner pressed a chat button of an approval that needs a fresh owner: nothing is decided here."""
    audit(_actor(ctx, user), "telegram.approval.stepup_required", approval_id,
          {"bot": getattr(ctx, "key", "main"), "kind": kind})
    await ctx.api.answer_callback(q["id"], STEPUP_ALERT, alert=True)
    url = mini_url(ctx)
    if url:
        await ctx.api.send_message(chat_id, "Confirm it's you in the NEBULA Mini App to decide this approval.",
                                   thread_id, reply_markup={"inline_keyboard": [stepup_row(url)]})
