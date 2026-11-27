# Telegram

Telegram is an optional way to talk to your agents from your phone. NEBULA offers three pieces:

1. **The main bot**: chat with agents, receive task cards (and, as the owner, approvals), send files and voice notes.
2. **A bot per agent** (optional): talk to one agent directly in its own chat.
3. **The Telegram Mini App** (optional): a full mobile interface inside Telegram. It needs a public HTTPS address.

**Status: Experimental.** The bot logic is tested against a fake Bot API, and outbound delivery to a real chat works;
inbound use from a real phone and the Mini App inside the Telegram client were not part of the release test.

Before you start, know that Telegram chats are **not end-to-end encrypted**: Telegram's servers can read bot
messages. NEBULA never sends secrets through Telegram, and it never accepts passwords typed into a chat.

## The main bot

NEBULA uses **long polling**: it only makes outbound requests to `api.telegram.org`. No public address, webhook or
open port is needed for the bot.

### Set up

1. In Telegram, open **@BotFather**, send `/newbot`, choose a name and a user name, and copy the token.
   Optional: enable topic (threaded) mode for the bot in BotFather, so each agent gets its own topic in your private
   chat with the bot.
2. **Dashboard → Telegram** → paste the token → **Test**. NEBULA checks it with `getMe` and stores it in the macOS
   Keychain; it is never shown again.
3. **Create pairing code** and send `/start <code>` to your bot within 5 minutes (or open the deep link).
4. Back in the dashboard, check the Telegram user id and chat id and press **Approve**. Until you approve, the bot
   gives no access to anything.

The first account you approve on the main bot becomes the designated **owner**. Every other approved account is an
**operator** with only the permissions stored for it (by default tasks, commands and screenshots): no administration
and no approvals, in the chat as well as in the Mini App. See
[Who can do what in the chat](#who-can-do-what-in-the-chat) and [Approvals in the chat](#approvals-in-the-chat). If
the owner's pairing is revoked, no one is promoted automatically, and until an owner is designated again no Telegram
account receives approval cards (decide in the dashboard). To designate yourself, choose **Make this my account** on
your own approved account in **Dashboard → Telegram** (it needs a fresh verification). Operators can still give tasks
to your agents, so approve only people you trust with that.

### Use

Each agent appears as its own topic, or you pick one with `/agents` and `/use`. Any message that is not a command
becomes a task for the selected agent. Files you send are saved to the agent's `inbox/`; ZIP files are extracted
safely (no absolute paths, `..` or symlinks, size and count limits).

| Command | What it does | Who may use it |
|---|---|---|
| `/agents`, `/use` | List and select agents | Any approved account |
| `/newagent` | Create an agent | Owner only |
| `/status` | Status of the current task | Any approved account |
| `/pause`, `/resume`, `/stop` | Control the current task | `commands` |
| `/screenshot` | Screenshot of the agent's desktop | `screenshot` |
| `/model` | Change the agent's model | Owner only |
| `/history` | Recent tasks | Any approved account |
| `/files`, `/get <path>` | Workspace files, download a file | `files` |
| `/teams` | List teams | Any approved account |
| `/team <name> <goal>` | Start a team run | `tasks` |
| `/schedules` | Schedules, with Run now buttons (Run now needs `tasks`) | Any approved account |
| `/wf <command> <text>` | Trigger a workflow with a Telegram trigger | `workflows` |
| `/approvals` | Pending approvals with their buttons | Owner only |
| `/companies`, `/company <name>`, `/progress` | AI Company Mode: list, details, work in progress | Any approved account |
| `/project <company> \| <project> \| <request>` | AI Company Mode: start company work | `companies` |
| `/notify` | Notification level: all, important, completion only, errors only, silent | Any approved account |
| `/voice` | Show the reply mode for voice | Any approved account |
| `/voice auto\|text\|voice\|text_voice` | Change the reply mode for voice | `commands` |
| `/app` | Sends a button that opens the Mini App (when a public URL is configured) | Any approved account |
| `/start`, `/help` | Help | Any approved account |

**Live task cards.** Every task gets a card that is edited as it progresses (status, step, progress, environment),
with Pause, Resume, Stop, Retry, Screenshot, Details and Download buttons. Edits are coalesced to at most one every 3
seconds per card. Approval cards are described in [Approvals in the chat](#approvals-in-the-chat).

**Voice notes.** With speech-to-text configured (see [features/voice.md](features/voice.md)), voice notes are
transcribed; simple intents such as status, pause, resume, stop, screenshot, team or company status are answered from
real data without an AI request, everything else becomes a task. A voice command needs the same permission as the
typed command. Without speech-to-text, voice notes are refused and nothing is uploaded anywhere.

**Multimodal.** Photos, screenshots, PDF, DOCX, CSV and JSON, code, ZIP, audio and video (several at once) with a
caption become a task with attachments. See [features/attachments.md](features/attachments.md).

### Who can do what in the chat

The chat applies the same roles as the API:

- **The owner** (the designated account) may use every command and button.
- **Operators** get exactly the permissions stored for them. The possible permissions are `tasks`, `commands`,
  `screenshot`, `desktop`, `files`, `companies` and `workflows`; approving a pairing stores `tasks`, `commands` and
  `screenshot`, and the dashboard cannot change them yet ([limitations.md](limitations.md)). The table above shows
  what each command needs, and a message, file or voice note that becomes a task needs `tasks`. On cards, Pause,
  Resume, Stop and Retry need `commands`, Screenshot needs `screenshot`, Assign agent needs `tasks` and `commands`, a
  schedule's Run now needs `tasks`, and the buttons that download a result file need `files`. Details, the list of
  result files, the agent choice, the notification level and the company and run buttons work for any approved
  account.
- **Owner only:** `/newagent`, `/model` and their buttons, `/approvals`, every approval button and the **Cancel
  sign-in** button of a sign-in request.

A refused command or button answers "You don't have the commands permission for this. Ask the NEBULA owner." (naming
the missing permission) or "Only the NEBULA owner can do this.", and the audit log records `telegram.command.denied`.
A command NEBULA does not know answers "Unknown command. /help". Agent bots have their own rules, see
[A bot per agent](#a-bot-per-agent).

### Approvals in the chat

Only the owner's own Telegram account decides approvals in a chat, on the main bot and on every agent bot. That covers
task approvals, Password Vault sign-ins, owner approvals (a workflow's approval step or approved command, a company
plan, a missed schedule) and the **Approve plan** buttons of a company card, which only the owner is shown.

- **Cards go to the owner only.** Approval cards, owner approvals and sign-in requests are sent only to the owner's
  private chat with the main bot; operators never receive them. When an operator's own task waits for approval, their
  chat gets a note instead, for example "🛂 Task #1a2b3c4d waits for the NEBULA owner's approval. It continues once
  the owner decides." While no owner is designated, no Telegram account receives approval cards; decide in the
  dashboard.
- **Nobody else can decide.** Anyone else who presses an approval button or sends `/approvals` gets "Only the NEBULA
  owner can decide this.", nothing is decided, and the audit log records `telegram.approval.denied`.
- **Ordinary approvals take one tap.** The Approve and Reject buttons of a task approval card carry an HMAC tag bound
  to the approval, the decision, the bot and the chat, so a forged or replayed button press is refused.
- **Some approvals are never decided in the chat**, neither approved nor denied, because deciding them remotely needs
  a fresh verification of the owner:
  - task approvals of vault or credential tools, such as a Password Vault sign-in;
  - task approvals in the categories `credential_entry`, `account_security`, `privileged` (for example `sudo`),
    `system_change`, `system_install`, `host_delete`, `sensitive_file`, `payment` and `data_export`;
  - every approval of a task that runs on the Mac ([host execution](features/host-execution.md));
  - owner approvals of the kinds `command`, `package_install` and `plugin`.

  Their card says "Deciding this needs you to confirm it's you, so it cannot be decided in the chat." When the remote
  gateway has an HTTPS address (the one `/app` uses), the main bot's card has a single button, **🔐 Open in NEBULA to
  decide**, which opens the Mini App's approvals (`<address>/mini/#/approvals`); you decide there after a fresh
  verification. Without that address the card points to **Dashboard → Approvals** on the Mac, and its buttons only
  repeat that hint (the audit log records `telegram.approval.stepup_required`). The dashboard and the native app can
  decide these approvals too.
- **Agent bots.** A task the owner started through an agent's bot gets its approval card in that bot's chat; see
  [A bot per agent](#a-bot-per-agent).

## A bot per agent

1. In @BotFather create another bot and copy its token.
2. **Dashboard → Bot Network → Add agent bot** → choose the agent → paste the token.
3. NEBULA validates the token (refusing the main bot's token and tokens bound to another agent), stores it in the
   Keychain, and sets the bot's commands and descriptions. The profile photo can only be set in BotFather.
4. Create a pairing code and send `/start <code>` to the new bot. If you are already the paired owner of the main
   bot, you are approved automatically; anyone else needs approval in the dashboard.

Messages, files, voice notes and buttons in an agent bot's chat go only to that agent, and its task cards and results
come back only through that bot. All bots run as coroutines inside the one NEBULA process (up to 24), each with its
own update offset and de-duplication. If Telegram reports a token as revoked (`401`), only that bot stops.

**In the agent bot's chat**, approved users other than the owner keep the bot's commands, each limited to its agent:
`/status`, `/pause`, `/resume`, `/stop`, `/screenshot`, `/history`, `/files`, `/get`, `/voice`, `/notify` and `/app`
(plus `/start` and `/help`). The owner-only commands (`/newagent`, `/model`, `/approvals`) stay the owner's, and they
never decide approvals there. Note that `/files` and `/get` let them list and download the agent's workspace files in
the chat, which the agent bot's Mini App does not offer.

**Approvals in an agent bot.** If the owner started a task through the agent's bot, its approval card appears in that
bot's chat and the owner decides it there with one tap. The exceptions are the approvals that need a fresh
verification (see [Approvals in the chat](#approvals-in-the-chat)): an agent bot's card never opens the Mini App,
because an agent bot's Mini App shows no approvals, so it points to the main bot's Mini App or the dashboard. If anyone
else started the task, they get the "waits for the NEBULA owner's approval" note in the agent bot's chat, and the card
goes to the owner's chat with the main bot.

**The agent bot's Mini App.** Its users, the owner included, get a fixed, small permission set limited to that agent:
its chats, tasks, commands and screenshots (the owner also gets its Live Desktop). It shows only that agent's chats and
tasks and **no approvals**, even to the owner; decide approvals in the dashboard, in the main bot's Mini App or, for
ordinary approvals, with the buttons in the owner's chat. Disabling or removing an agent bot ends its Mini App
sessions immediately.

## The Telegram Mini App

The Mini App is a phone-sized interface that opens inside Telegram: **Chats** (conversations with agents, attachments,
voice, live task stages), **Agents** (status, details, settings, creating agents), **Activity** (approvals, running
and finished tasks, workflow runs) and **Settings** (administration, Password Vault, connections, system). The owner
gets the full administration area and the approvals; sensitive actions need a fresh verification, and this is where
the approvals that a chat button cannot decide are decided. Operators see only what their stored permissions allow and
no approvals: listing approvals is owner-only, so the approvals section of their **Activity** screen shows "Not
available in the Mini App". An agent bot's Mini App shows only that agent.

### Requirements

Telegram opens Mini Apps only from a **public HTTPS origin**. That means publishing NEBULA's remote gateway through
Tailscale Funnel, a Cloudflare quick tunnel or your own reverse proxy. Once it is public, an authenticated owner
session can administer NEBULA from anywhere. A Cloudflare quick tunnel also decrypts the traffic at Cloudflare's edge.
Read the security requirements in
[remote-access.md](remote-access.md#security-requirements-of-the-public-surface) before you do it. If you only want
mobile access for yourself, the native app over Tailscale Serve avoids any public exposure.

### Set up

1. **Dashboard → Remote Access** → enable the gateway.
2. Choose **Tailscale Funnel**, **Cloudflare quick tunnel** or **your own HTTPS reverse proxy**, and press **Start**.
   NEBULA asks you to confirm that the gateway becomes reachable from the Internet.
3. Press **Apply bot menu buttons**. The main bot (and agent bots) get a NEBULA menu button; task cards get "Open in
   NEBULA app" and "Open Desktop" buttons; `/app` sends a launch button.
4. In Telegram, tap the bot's menu button.

You can try the Mini App locally without any tunnel at `http://127.0.0.1:3100/mini/` on the Mac (it uses your
dashboard sign-in).

### How a Mini App session works

1. Telegram passes signed launch data (`initData`) to the page.
2. `POST /api/mini/auth` on the gateway verifies it (HMAC with your bot token, at most 10 minutes old, single use,
   from an approved account of that bot) and returns a Bearer session.
3. The session lasts 1 hour, slides while you use it and ends at the latest 12 hours after sign-in. It works only
   through the gateway. When it expires, reopen the Mini App from Telegram. It ends at once when you revoke the
   account or disable or remove the bot it came from.
4. Sensitive actions ask for a fresh verification: your NEBULA password, or Face ID or a fingerprint through
   Telegram's BiometricManager on a phone you enrolled once.

### Create agents from the Mini App

**Agents → `+`** → name, provider, model → **Create Agent** creates a real agent with its own VM user, desktop and
conversation, through the same service as the dashboard. The server accepts only an allowlist of fields, checks that
the provider is connected and the model is in its live list, requires an `Idempotency-Key` and rate-limits creation
(6 per 10 minutes per session). Native Mac execution, vault grants and deleting agents stay on the Mac.

## Limits

- One bot token can be long-polled by only one process. A `409 Conflict` means another poller or a webhook uses the
  token. Use a separate bot for a second NEBULA instance.
- Private supergroup topic mode is not implemented; private-chat topics and `/use` are.
- Mini App sessions are single-use per launch; after expiry reopen from Telegram.
- Profile photos of bots can only be set in BotFather; NEBULA cannot create bots.
