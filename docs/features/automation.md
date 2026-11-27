# Memory, teams, schedules, workflows, files and skills

These features build on the same agents and tasks. None of them runs a model by itself: teams, schedules and
workflows create ordinary agent tasks, so policy, approvals, Take Control, checkpoints and per-task limits apply to
automation exactly as they apply to tasks you type.

## Memory

Each agent has a persistent memory in layers: long-term facts, notes and decisions, your preferences, an automatic
history of finished tasks (episodes), project memory and memory shared explicitly with other agents or a team.

- Agents remember on their own: a finished task becomes an episode; sentences such as "remember that...", "I
  prefer..." or "always..." in your messages become preferences; agents store notes with the `memory_store` tool.
- Search uses SQLite FTS5, ranked by relevance, importance and pinning. Optional semantic search with an Ollama
  embedding model (for example `ollama pull nomic-embed-text`) is off by default; full-text search always works.
- Limits keep memory useful and cheap: de-duplication by content hash, at most 1000 entries per agent, 180 days for
  episodes and a hard character budget when memory is added to a prompt.
- Memory is always injected as a labelled data block, never as instructions, and never changes an agent's system
  prompt or permissions. Text written by an agent that looks like instructions is quarantined and not injected
  automatically.
- Memory refuses secrets: API keys, tokens, private keys, password patterns and valid card numbers.
- **Agent → Memory** or **Memory** in the sidebar: search, filter, edit, pin, share, delete. Switch **Auto-save** off
  for an agent that should not remember anything new.

## Teams

A team is a set of agents with roles (for example Developer → Tester → Reviewer), optional instructions, an order, a
lead, and a mode: *sequential* (a pipeline) or *parallel* (everyone at once, the lead reviews last).

- A team run turns a goal into subtasks with dependencies. Each role sees the previous roles' results and writes
  deliverables to the team directory `/srv/nebula/shared/<id>` in the VM (also visible in Files).
- Failures retry once; dependants are then skipped. Only the lead may delegate, with limits on depth and number of
  subtasks. An optional budget caps the model requests of the whole run.
- Runs survive restarts. Telegram: `/teams`, `/team <name> <goal>`.

## Schedules

One-time, interval, daily, weekly, monthly and five-field cron schedules in any IANA time zone, for an agent, a team or
a workflow.

- Misfire policy (what happens if NEBULA was off): skip, run once when back, or ask you.
- Overlap policy (the previous run is still active): skip or queue.
- Bounded retries, maximum runtime and maximum model calls per run; each time slot runs at most once.
- Run now, enable or disable, history. Telegram: `/schedules`.

## Workflows

A drag-and-drop editor for automations that the backend executes:

- **Triggers:** manual, schedule, Telegram command (`/wf <command> <text>`), task completed, file created.
- **Actions:** run agent, run team, read or write file, browser task, generate report (template based, no model call),
  send Telegram message, create task, execute an approved command.
- **Logic:** condition, branch, delay, retry, bounded loop (at most 50 iterations, closed body), parallel, wait for
  approval.

A wait-for-approval step and an execute-command step each create an owner approval, which only the owner decides
(the dashboard, the Mini App, the native app or the owner's Telegram chat). A wait-for-approval step takes one tap in
Telegram; a command needs a fresh verification, so its Telegram card opens the Mini App or points to the dashboard
instead ([telegram.md](../telegram.md#approvals-in-the-chat)).

Workflows are versioned JSON validated on the server, with import, export and duplicate. Runs are persistent and
auditable, and survive restarts: a step that was waiting re-attaches; a non-idempotent step that was interrupted
mid-flight becomes `UNKNOWN` and is never replayed. Workflows refuse automation depth 3 or more, events from depth 2 or
more never trigger workflows, files written by workflows never trigger workflows, and each workflow has an hourly run
limit and at most 3 concurrent runs.

Templates in parameters: `{{trigger.text}}`, `{{nodes.<id>.summary}}`, `{{last.summary}}`, `{{loop.item}}`.

## Files

A file manager for agent workspaces, team directories and a Mac **exchange folder**
(`<data>/exchange`): upload by drag and drop, download, new folder, rename, copy, move, delete with confirmation, a
text editor that keeps the last 5 versions, previews (text, CSV, images, PDF), search and transfers between agents,
teams and the Mac.

Every VM file operation runs as the agent's own Linux user, so the guest kernel enforces permissions in addition to
NEBULA's path checks (no `..`, no symlinks). Single files up to 200 MiB; folders are copied within one root.

## Skills and plugins

- 14 built-in skills map to real tools: Computer, Browser, Filesystem, Terminal, Git, GitHub, Python, Node.js, PDF,
  CSV/JSON, Web research, Documents, Screenshot and Data analysis. Assign a subset to restrict an agent; its permission
  level still applies. GitHub writes need a GitHub token, stored in the Keychain.
- **Plugins** are local ZIP files with a `nebula-plugin.json` manifest (id, name, version, permissions, tools, config
  schema, dependencies, security). NEBULA validates them (size and file limits, no symlinks or `..`), stores them
  read-only in the VM and runs them only there, as the calling agent's user with a timeout. Plugins that need network
  access require `ADVANCED`, and their declared risk categories go through the approval policy. Declared categories
  are trusted metadata; undeclared behaviour is contained only by the agent's Linux user.

## Resource Monitor

Live and historical memory, CPU, swap, disk, VM and per-agent metrics, a priority queue and profiles:

| Profile | Desktops | Idle sleep |
|---|---|---|
| ECO | 1 | after 5 minutes |
| BALANCED (default) | 2 | after 20 minutes |
| PERFORMANCE | up to 4 if the VM has room | after 60 minutes |

Idle desktops never sleep while you watch them or hold Take Control, and they wake automatically for new work. How
admission decisions are made: [../design/resource-manager.md](../design/resource-manager.md).
