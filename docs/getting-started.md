# Getting started

This guide takes you from a finished install to an agent completing its first task while you watch its desktop. It
assumes you ran `./install.sh` as described in [installation.md](installation.md) and that the installer printed
`Installation complete`.

## 1. Create the administrator

The installer prints a link of the form:

```text
http://127.0.0.1:3100/#/setup?token=<one-time token>
```

Open it in a browser **on the Mac that runs NEBULA**. The setup page asks for a user name and a password of at least
10 characters. The password is stored as an Argon2id hash; NEBULA has no default account and no default password.

- The setup token lives in the data directory (`run/setup-token`, mode `0600`) and is only accepted until the first
  administrator exists. After that the setup route refuses to create another administrator.
- Lost the link? Print it again with `.venv/bin/nebula setup-url`.
- Forgot the password later? Reset it locally with `.venv/bin/nebula reset-password <user>`. This signs out every
  session.
- Repeated failed logins from other devices lock the account for a few minutes. Logins on the Mac itself are only
  rate-limited and never locked out, so a device on your network cannot lock you out.

After you sign in you land on the **Command Center**, which shows the system state, agents, running tasks and pending
approvals. Until you have finished them, a **Get started with NEBULA** checklist there walks you through the steps
below: connect an AI provider, create your first agent, run a harmless sample task, watch it in Live Desktop, and
(optionally) reach NEBULA from your phone.

## 2. Check the system

Open **System** in the sidebar. It shows the VM state, the guest health, logs, and buttons for Repair, Start/Stop VM,
Restart services, Backup DB and Export diagnostics. **Resources** shows memory, CPU, swap and the resource profile
(ECO, BALANCED or PERFORMANCE) that decides how many agent desktops may run at once.

If anything is red, run `.venv/bin/nebula doctor` in a terminal; it explains every failed check. See
[troubleshooting.md](troubleshooting.md).

## 3. Connect an AI provider

Open **AI Providers**. You need at least one connected provider before you can create an agent.

| If you want | Do this |
|---|---|
| Free and fully local | Install [Ollama](https://ollama.com), run `ollama pull qwen2.5:7b` (or another model that supports tool calls), then press **Test connection** on the Ollama card. A 7B model needs about 5 GB of RAM next to the VM. |
| A cloud model billed per token | Paste an OpenAI, Anthropic (Claude API) or Gemini API key, or configure an OpenAI-compatible endpoint. |
| Your ChatGPT plan | Press **Continue with ChatGPT** on the Mac. This uses OpenAI's documented sign-in for local open-source clients. |

Keys are write-only: the dashboard never shows them again, the database keeps only a Keychain reference. Claude and
Gemini consumer subscriptions are not supported. See [providers.md](providers.md) for every option and for spending
limits.

## 4. Create your first agent

Open **Agents → Create Agent**:

1. **Name**, for example `Research`.
2. **Provider** and **model**. Models are listed live from the provider; only tool-capable models are useful.
3. **Permission level**:
   - `READ_ONLY` can read pages and files and change nothing;
   - `STANDARD` (default) gets the browser, its own desktop and its own files, but no terminal;
   - `ADVANCED` adds the terminal, Python, Node.js, git and background processes inside the VM, and plugins with
     network access.
4. **Environment**: keep **Ubuntu VM**. Native execution on the Mac is a separate, opt-in feature (see
   [features/host-execution.md](features/host-execution.md)).

NEBULA creates a Linux user `nebula_<id>` in the VM, a desktop and a browser profile. On a running VM this takes a few
seconds; the agent then shows `READY`.

## 5. Give it a task

Open the agent and type into the chat:

> Open https://example.com and save its main heading to heading.txt

You see each step as it happens: the model's plan, tool calls, screenshots as evidence and the final result. A task
only becomes `COMPLETED` when the runtime has checked the artifacts the agent claims (here, that `heading.txt` exists
in the workspace). Otherwise it ends `FAILED` with the agent's explanation.

If the agent wants to do something risky (pay, send a message, upload, use `sudo`, delete many files), the task stops
in `WAITING_APPROVAL` and an approval card appears in the chat, in **Approvals** and, if paired, in your Telegram chat
with the main bot. Only you, the owner, can resolve it: in the dashboard, in the main bot's Mini App, in the native
app or, for ordinary approvals, with the Telegram buttons. Other Telegram accounts you approve never get the card and
cannot decide it. Approvals that need a fresh verification (payments, account security changes, credentials and vault
sign-ins, `sudo` and other privileged commands, system changes and installs, secret files, data exports, and every
approval of a task on the Mac) are never decided with a Telegram button: the card opens the Mini App or points to the
dashboard, see [telegram.md](telegram.md#approvals-in-the-chat). Approvals expire after 15 minutes and then count as
denied. If you deny an action, every later action of the same kind in that task is denied too.

The rules that decide when to ask are tripwires for the obvious cases, not a security boundary: an agent that tries
can do risky things in ways the rules do not recognise. What contains an agent is the VM (its own Linux user, no
access to your Mac, and a firewall that keeps it off your local network while it keeps Internet access) and the
permission level you give it. See [security-model.md](security-model.md).

You can **Pause**, **Resume** or **Stop** a task at any time. Pausing waits for the current tool call to finish; a
side effect that was in flight when NEBULA restarted is never replayed automatically.

## 6. Watch and take over the desktop

Open the agent's **Live Desktop** tab:

1. **Connect** shows the agent's real screen, read-only. Nothing is streamed before you press it.
2. **Take Control** gives you mouse and keyboard. The agent pauses its GUI actions while you hold control.
3. **Release Control** hands control back; the agent observes the screen again before it continues.
4. **Disconnect** stops the stream. The agent keeps working.

Details: [live-desktop.md](live-desktop.md).

## 7. Next steps

- Reach NEBULA from your phone or laptop over Tailscale Serve, which stays inside your tailnet:
  [remote-access.md](remote-access.md). Once the gateway is on, your owner session can administer NEBULA through it.
- Let agents reach a device on your local network (they cannot by default):
  [configuration.md](configuration.md#vm-network-access).
- Install the iPhone app: [ios-app.md](ios-app.md).
- Control agents from Telegram: [telegram.md](telegram.md).
- Memory, teams, schedules, workflows and files: [features/automation.md](features/automation.md).
- Let agents sign in to websites without seeing passwords: [features/password-vault.md](features/password-vault.md).
- Understand what NEBULA protects and what it does not: [security-model.md](security-model.md).

Keep the Mac awake while agents work: agents pause when macOS sleeps. Preflight warns when system sleep is enabled
(System Settings → Energy).
