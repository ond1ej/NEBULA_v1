# Telegram Mini App: design

The Mini App is a conversation-first assistant for the phone. Code: `apps/dashboard/src/mini/**` (own entry
`mini.html`, own Tailwind build `mini.css`). It is served by the remote gateway (on loopback, by default the dashboard
port plus 2, published only through the tunnel the owner configured) and, for local preview, at
`http://127.0.0.1:3100/mini/`. For setup and security see [../telegram.md](../telegram.md) and
[../remote-access.md](../remote-access.md).

## Principles
Minimal, strong hierarchy, conversation first, large touch targets (≥ 44 × 44 px), few visible controls, progressive
disclosure (details behind taps/overflow menus), quick feedback (optimistic sends, skeletons, live task stages),
restrained premium look with NEBULA's own identity (no third-party branding or assets).

## Design tokens (`mini.css`, `theme.ts`)

| Token | Dark (default) | Light |
|-------|----------------|-------|
| background | `#101114` | `#F7F8FA` |
| surface / panel | `#191B20` | `#FFFFFF` |
| surface-2 | `#22252B` | `#F0F2F5` |
| elevated | `#2A2D35` | (derived) |
| text | `#F5F6F8` | `#17191E` |
| text-2 (muted) | `#9B9FA9` | `#666C78` |
| muted (subtle) | `#7D828D` ¹ | (derived) |
| accent / hover | `#8B7CF6` / `#A397FF` | `#7464E8` |
| filled-button accent | `#6E5FE6` ² | `#6B5ADF` ² |
| success / warning / danger | `#36C991` / `#F4B860` / `#F07178` | (derived) |

¹ The specification's `#686D78` fails 4.5:1 contrast on the dark surfaces; `#7D828D` is the closest passing value.
² Filled buttons use a slightly deeper accent so white labels stay ≥ 4.5:1.

Typography: `-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif` (system fonts only, nothing
downloaded); scale caption 12 / footnote 13 / subhead 14 / body 15 / message 16 / headline 17 px; body copy ≥ 14 px.
Motion: 150–250 ms transitions, disabled under `prefers-reduced-motion`. Theme: Settings → Appearance (System / Dark /
Light, stored in `localStorage nebula.mini.theme`); *System* follows Telegram's `colorScheme` + `themeChanged`, or
`prefers-color-scheme` in a normal browser; Telegram's header, background and bottom bar are tinted to match.

## Information architecture

Bottom tab bar: **Chats** (start screen) · **Agents** · **Activity** · **Settings**.

| Screen | Content |
|--------|---------|
| Chats `#/chats` | NEBULA wordmark, connection/health dot (→ Settings › System), search (agents + message content via `/conversations/search`), new conversation (agent picker sheet). Rows: avatar (initials, stable colour), agent + title, preview, relative time, unread badge, running-task dot. Archived conversations at the bottom. |
| Conversation `#/chats/<id>` (also `#/agents/<id>`, `#/agents/<id>/chat`) | Fixed header (back, avatar, name, status, overflow: Live Desktop, details, rename, archive/restore, new chat) and fixed composer; only the list scrolls. Owner bubbles right (accent tint), agent messages left (neutral), system notices centred. Safe Markdown renderer (React elements only; code blocks with Copy; http(s) links only). Attachments: thumbnails + full-screen viewer, audio player + transcript or "Transcription not configured", file chips. Long-press/tap: Copy, timestamp. Inline task status ("Working · Opening browser" → "Completed · 12 s"), tap for steps, approvals, result, screenshots, error, Pause/Stop. Windowed history; "Load earlier messages" keeps the reading position. |
| Composer | Attach sheet (Photo or video · Take photo on capable touch devices · Choose file), chips with XHR upload progress and remove, 50 MB limit, executables blocked client-side (server validates again). Auto-growing textarea, send button only (Enter = newline). Voice: MediaRecorder (ogg → webm → mp4), start/stop/cancel, duration; mic disabled with an explanation when the WebView does not allow it. Drafts per conversation (`nebula.mini.draft.<id>`, text only). Optimistic "Sending…", "Not sent · Retry" reuses the same `client_id` (+ `Idempotency-Key`). |
| Live Desktop `#/agents/<id>/desktop` | Shared viewer: on-demand stream, Take/Release Control (exclusive), quality Auto/High, connection state; closes the stream when left; back returns to the chat. |
| Agents `#/agents` | Searchable list: role, status, model, current task. Tap → chat. ··· / long-press: Details, Settings, Permissions, Password Vault access, Files, Memory, Live Desktop, Sleep/Wake, Pause/Resume, pause/stop current task; Delete shown disabled ("Only in the local Dashboard"). |
| Activity `#/activity` (`#/approvals`) | Filters All / Approvals / Running / Failed; task, owner and vault approvals (Approve / **Approve once** / Deny, each with a confirmation quoting the exact action; vault, credential, host and system approvals and owner approvals of commands, packages and plugins need a fresh verification, which the Mini App asks for when the server requires it, and this is where the Telegram chat's **Open in NEBULA to decide** button lands. Approvals are shown only to the owner on the main bot's Mini App: `GET /approval-center` is owner-only, so an operator gets `403 owner_only` and the approvals section shows "Not available in the Mini App", and an agent bot's Mini App never offers them); running, queued, failed, completed tasks (expandable); recent workflow runs. |
| Settings `#/settings` (searchable) | Account (profile/session, Telegram, security, log out) · Agents & Automation (agents, companies, teams, workflows, schedules, skills, memory) · Data (files, Password Vault, backups → local) · Connections (AI providers, Telegram, bot network, voice, host access, remote access) · System (status: resources + VM, Live Desktops, notifications, logs → local, Appearance). |
| Password Vault (Settings › Password Vault, Agent › Password Vault) | Status (Not set up / Locked / Unlocked, auto-lock), credentials (names and origins, search), agent access and grants, recent access, **Lock now**, revoke per grant. For the owner with a fresh verification: unlock, add, edit, delete, reveal and copy (vault passphrase re-confirmed), Smart sign-in settings, encrypted export and import. Lazy chunks; responses pass a field allowlist, are sent with `no-store` and live only in screen state. |
| Administration `#/admin` | The owner's administration pages (agents, providers, companies, teams, workflows, schedules, tasks, approvals, files, skills, memory, Telegram and bots, voice, remote access and sessions, host access, settings, system, resources), the same components as the dashboard, loaded lazily, with a Bearer token instead of cookies. |

Deep links (`startapp`): `chat_<id>`, `activity`, `vault`, `agent_<id>_details|security|vault`, plus the agent, task,
desktop and company links used by Telegram buttons. Telegram's BackButton mirrors in-app navigation.

**Agent-bot sessions** (an agent's own Telegram bot, role `agent_bot`) get a reduced shell: that agent's chat (the
home screen), its tasks and a task's details, plus its Live Desktop when the session holds the `desktop` permission
(the owner watching their own agent). There is no tab bar, no approvals and no settings; every other route shows a
notice that the main NEBULA bot holds the rest. The host enforces the same limit (`authz.AGENT_BOT_ROUTES`).

## Telegram integration
Safe-area and content-safe-area insets (+ change events, CSS `env()` fallback), `viewportChanged` and
`visualViewport` keyboard handling, `expand()` where supported, BackButton, `themeChanged`, HapticFeedback (send,
approve/deny), graceful fallback in a normal browser. Only documented WebApp APIs.

## Performance
* The initial load is only the Chats shell (about 73 KB of gzip-compressed JavaScript when this design was measured).
* Everything else is lazy: conversation (preloaded on touch or hover of a row), agents, activity, settings, vault,
  Live Desktop, administration.
* No polling while the event stream is connected. Request-budget tests keep it that way: Chats makes 6 requests on
  open, 0 per idle minute and 0 per progress burst; a chat 7 / 0 / 0; Activity 6 / 0 / 0.
* Conversation switching renders cached messages immediately and reconciles in the background.

## Compatibility
If `/conversations` is unavailable, Chats falls back to one chat per agent over the per-agent endpoints. The desktop
dashboard chat uses the per-agent endpoints, which read and write the agent's default conversation.
