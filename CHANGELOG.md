# Changelog

All notable changes to NEBULA are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.0.0] - first public release

Fixed before the tag (found by CI on GitHub's runners and by the final audit):

- Host execution: on a Mac whose active Xcode (`xcode-select -s`) is not `/Applications/Xcode.app`, for example
  `Xcode-beta.app`, every `/usr/bin` developer shim (`git`, `python3`, `clang`, `swift`) failed inside the sandbox
  with "file system sandbox blocked open()". The sandbox now also grants read-only access to the active Xcode bundle.
- Host resources: with no VM running, every resource sample started `/bin/ps`. The in-process libproc answer ("no VM
  process") is now used, and `ps` remains only for when libproc cannot answer.
- Installer: `--yes` never runs a downloaded installer script; the interactive uv installer is pinned.

The first public, open-source release of NEBULA under the MIT License. It is an unsigned developer build installed from
source on an Apple-silicon Mac. Feature status (Stable, Experimental, Planned) is listed in the README.

### Platform

- One-command installer (`install.sh`) with a read-only `--check` mode, prerequisite offers, optional autostart,
  `update.sh` (database backup, build, migration, health check, automatic rollback) and `uninstall.sh` (keeps data
  unless `--remove-data` is confirmed).
- `nebula` CLI: install, status, health, doctor, restart, autostart, update, diagnostics (redacted bundle), vm, repair,
  uninstall, reset-password, setup-url, deploy.
- Instances: several NEBULA installs on one Mac with separate data directories, Keychain services, LaunchAgents and VM
  hostnames.
- Ubuntu 24.04 ARM64 VM on Apple's Virtualization framework, built from the official cloud image verified against an
  Ed25519-signed manifest, a pinned SHA-256 and Ubuntu's signed checksums.
- Per-agent Linux users with their own XFCE desktop, headed Chromium and workspace; host-to-guest RPC over vsock with
  HMAC-signed frames.
- Guest firewall: agents keep Internet access but cannot reach your LAN, the Mac, other VMs, Tailscale (CGNAT),
  link-local or multicast addresses; owner exceptions in `/etc/nebula/firewall-lan-allow.nft`.

### Agents

- Task state machine with checkpoints, pause, resume and stop, verified completion and crash-safe side effects.
- Permission levels (`READ_ONLY`, `STANDARD`, `ADVANCED`) and approvals for risky actions.
- Live Desktop with Take Control and Release Control in the dashboard, the Mini App and the native apps.
- Providers: Ollama, OpenAI, Anthropic and Gemini API keys, OpenAI-compatible endpoints, and Sign in with ChatGPT for
  local open-source clients. Claude and Gemini consumer subscriptions are not supported.
- Memory, teams, schedules, a visual workflow builder, files, skills and local plugins, a resource manager.
- AI Company Mode (experimental), host execution in a Seatbelt sandbox (experimental, opt-in), attachments, voice.
- Password Vault with per-agent grants and an isolated sign-in broker; Smart sign-in (experimental).

### Access

- Web dashboard on `127.0.0.1`, optional LAN access with a local CA.
- Remote gateway (off by default) with Tailscale Serve as the recommended, tailnet-only path, scoped to this
  instance's Tailscale HTTPS port; Tailscale Funnel, Cloudflare quick tunnels and custom proxies are opt-in public
  options for the Telegram Mini App with an explicit confirmation.
- One owner; approvals are owner-only for every remote caller and in every Telegram chat; other Telegram accounts get
  only their stored permissions or one agent's chat and tasks. See Security below.
- Telegram bot, a bot per agent, live task cards and the Telegram Mini App (experimental).
- Native iPhone, iPad and Mac apps (experimental) with Secure Enclave device keys, QR pairing approved on the Mac and
  one Face ID confirmation for sensitive actions. The Apple apps moved to their own repository,
  [NEBULA-iOS](https://github.com/ond1ej/NEBULA-iOS); this repository keeps only the server side (pairing, owner
  confirmation, push).
- English user interface and voice by default, with an optional Czech translation for parts of the dashboard and the
  apps; Czech voice replies only when Czech is detected or chosen.

### Security

Security behaviour of this release, stricter than the pre-release builds:

- **Approvals are owner-only everywhere.** Only the owner decides approvals: through the API, in the Mini App and in
  every Telegram chat (the main bot and every agent bot), where only the owner's own Telegram account can press an
  approval button or use `/approvals`. Anyone else gets "Only the NEBULA owner can decide this.", audited as
  `telegram.approval.denied`. Approval cards, owner approvals and sign-in requests go only to the owner's chat with
  the main bot; an operator whose task waits gets a note instead. Listing approvals (`GET /api/v1/approvals`,
  `/owner-approvals`, `/approval-center`) is owner-only for remote callers.
- **Step-up approvals are decided in the Mini App, not in the chat.** Vault, credential, host and system task
  approvals and owner approvals of commands, packages and plugins need a fresh verification, so no Telegram chat
  button approves or denies them. Their card opens the main bot's Mini App (**Open in NEBULA to decide**) when the
  remote gateway has an HTTPS address, or points to the dashboard. Ordinary approvals stay one tap for the owner.
- **Operator permissions apply in the chat.** An operator's chat commands, card buttons and voice commands need the
  same stored permission as the matching API route; `/newagent`, `/model` and `/approvals` are owner-only. Refusals
  are audited as `telegram.command.denied`.
- **Host network is off by default.** A Mac project folder authorised for host execution has no network access until
  the owner turns it on. With network on, host commands still cannot reach any address of the Mac itself or its
  Unix sockets (except name resolution) (measured on macOS 27.0.1).
- The host refuses a dashboard session that arrives with the remote gateway's header (`401`); the gateway only
  forwards remote sessions.

### Project

- MIT License, third-party notices for bundled components (noVNC under MPL-2.0).
- Documentation for installation, configuration, providers, remote access, Live Desktop, the iOS app, Telegram,
  architecture, the security model, troubleshooting and testing.
- CI on GitHub Actions: Python, dashboard and Swift tests; secret, dependency and license scanning; CodeQL; release
  archives with SHA-256 checksums.

### Known limitations

See [docs/limitations.md](docs/limitations.md). In short: cloud API providers are tested with mocked HTTP only; the
Telegram Mini App was not verified inside the Telegram client on a phone; the approval policy is an advisory, pattern
based tripwire; Internet egress from the VM is not filtered (local-network destinations are blocked, but for IPv6 only
local ranges, not global addresses); host commands with network access are kept away from the Mac itself and nothing
else; `allowed_tools` is a convenience filter; agents share one kernel; there is no signed or notarized app.

[Unreleased]: https://github.com/ond1ej/NEBULA_v1/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/ond1ej/NEBULA_v1/releases/tag/v1.0.0
