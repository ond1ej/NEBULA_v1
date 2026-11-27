# Known limitations

An honest list of what NEBULA 1.0 does not do, has not verified, or restricts on purpose. Security-relevant limits are
explained in more depth in [security-model.md](security-model.md).

## Not verified in this release

- **Cloud API providers** (OpenAI, Anthropic, Gemini, OpenAI-compatible) are covered by contract tests with mocked
  HTTP only. They were not exercised against the live APIs for 1.0.
- **Sign in with ChatGPT** depends on OpenAI's programme for local open-source clients and can change without notice.
- **Telegram from a real phone** (sending commands, voice notes and files, pressing buttons) is tested only against a
  fake Bot API; outbound delivery to a real chat works.
- **The Telegram Mini App inside the Telegram client** (keyboard handling, safe areas, haptics, microphone, one-time
  code autofill, BackButton) is implemented against Telegram's documented WebApp API and tested in jsdom, not on a
  phone inside Telegram.
- **Speech-to-text** with whisper.cpp is implemented but real transcription was not part of the release test.
- **Smart sign-in on real third-party sites** with real accounts and MFA has not been tested; it is tested on
  synthetic sign-in pages in the VM. Real sites vary, and some end in a CAPTCHA or a hand-off to you.
- **Vision analysis** of images by a model and a CEO-planned company run with a real model were not part of the
  release test.
- **Hardware coverage**: end-to-end tests ran on a single Mac mini (Apple silicon, 16 GB). Other Mac models should work
  but are not tested.

## Not implemented

- A signed and notarized Mac app, a `.dmg` or a GUI installer: NEBULA is an unsigned developer build installed from
  source. The VM helper is ad-hoc signed with the Virtualization entitlement, which is enough on your own Mac.
- A prebuilt VM image: the pinned Ubuntu cloud image is provisioned at install time (needs Internet).
- Live VM snapshots (only disk clones of a stopped VM).
- Workspace disk quotas (usage is reported, not enforced).
- Screenshot masking for sensitive workspaces.
- GUI control of macOS itself (host agents use files, terminal and developer tools; graphical work runs in the VM).
- WhatsApp, phone calls, more than one host.
- Claude Code, Codex and Antigravity coding modes (not offered; the API only reports an installed CLI as
  unsupported), Claude and Gemini consumer subscriptions.
- Telegram private supergroup topic mode.
- Editing an operator's stored permissions in the dashboard (operators keep the default tasks, commands and
  screenshots).
- Filtering Internet destinations per agent (an allowlist proxy is on the [roadmap](roadmap.md)).
- A light theme for the desktop dashboard (the Mini App has one).
- Intel Macs, Linux or Windows hosts.

## By design

- **NEBULA runs after you log in.** The service is a per-user LaunchAgent, not a system daemon.
- **One shared VM.** All agents share one Linux kernel; isolation between agents is weaker than separate VMs. The
  Playwright Chromium binary may use unprivileged user namespaces (for its own sandbox), and agents can use them
  through it.
- **Internet egress is not filtered.** Agents and plugins in the VM can reach any Internet host. The guest firewall
  blocks only local-network destinations: your LAN, the Mac, other VMs, Tailscale (CGNAT), link-local and multicast
  addresses. An agent that needs a service on your LAN (a NAS, an intranet site, a package mirror) needs an exception
  in the VM's `/etc/nebula/firewall-lan-allow.nft`, see [configuration.md](configuration.md#vm-network-access).
  For IPv6 the firewall blocks only `fc00::/7`, `fe80::/10` and `ff00::/8`; if the VM gets IPv6 connectivity, LAN
  devices and the Mac are not blocked on their global IPv6 addresses. Approvals catch recognised uploads and messages
  only.
- **Approvals are pattern based.** They are advisory tripwires for ordinary commands, not a security boundary. Only
  the owner can resolve them, in every client and in every Telegram chat.
- **Some approvals cannot be decided in Telegram.** Vault, credential, host and system approvals and owner approvals
  of commands, packages and plugins need a fresh verification, so a chat button never decides them. Their card opens
  the main bot's Mini App (when the gateway has an HTTPS address) or points to the dashboard. See
  [telegram.md](telegram.md#approvals-in-the-chat).
- **ChatGPT sign-in and vault management happen on the Mac.** OpenAI allows only a loopback redirect, and vault
  management is local (or through an owner session with a fresh verification).
- **Password Vault:** no recovery without the passphrase. Agents can use only website credentials, only in the VM, and
  only for signing in. After a sign-in the session cookies live in the agent's browser and the agent can use that
  session. Sessions kept outside cookies cannot be handed over. Grants are not part of encrypted exports.
- **Smart sign-in** never bypasses CAPTCHAs, passkeys or MFA; those steps are handed to you in Live Desktop, and
  anything typed there is visible to the agent's environment. Embedded third-party logins and sign-up forms are not
  automated. At most five sign-ins run at a time, one per agent.
- **Host execution** runs commands as your macOS user inside a Seatbelt sandbox, with network access off unless you
  turn it on for a folder. With network on, Unix sockets (except name resolution) and every address of the Mac itself
  stay denied: measured on macOS 27.0.1 (Apple silicon), `127.0.0.1`, `::1`, the Mac's LAN IPv4 address and the VM
  bridge address `192.168.64.1` all fail with `EPERM`, so services on the Mac are not reachable. NEBULA does not block
  other destinations. NEBULA's file tools refuse files with more than one hard link inside an authorised folder.
  `allowed_tools` checks every program named in a command, and refuses commands it cannot check; it is a convenience
  filter, not the boundary: tools that can run other programs themselves (`sed`'s `e` command, a git alias that starts
  with `!`) get around it. `sandbox-exec` is
  deprecated by Apple; if it disappears, host commands are disabled. Some tool caches outside the project (for example
  Flutter's SDK cache) are read-only inside the sandbox.
- **No lockout for logins on the Mac itself.** Failed dashboard logins from other machines lock the account for a
  while; clients on the Mac (`127.0.0.1`, `::1`) are only rate-limited (20 failed attempts a minute), so a LAN device
  can never lock you out locally.
- **Approvals in an agent bot's Mini App.** An agent bot's Mini App shows only that agent's chats and tasks, even to
  the owner. Resolve approvals in the dashboard, in the main bot's Mini App, in the native app or, for ordinary
  approvals, with the buttons in the owner's Telegram chat.
- **What other Telegram accounts still see.** Operators and agent-bot users cannot list or decide approvals, but a
  task's details and the notification feed can still show them what a waiting task asks for. An operator's Mini App
  shows "Not available in the Mini App" where approvals would be. Agent-bot users can list and download their agent's
  workspace files in the bot chat (`/files`, `/get`), which their Mini App does not offer.
- **Local models run one at a time.** On 16 GB Macs a 7B model plus the VM is tight; NEBULA refuses to load a model
  that does not fit rather than swapping heavily.

## Operational notes

- Running a NEBULA CLI command from a newer checkout applies database migrations immediately. Back up first
  (**System → Backup DB**).
- After the runtime's Python interpreter changes (for example after an update), macOS may ask once per Keychain item
  whether NEBULA may read it. The service waits while the dialog is open; choose **Always Allow**.
- Telegram card edits are coalesced to one every 3 seconds; very fast tasks may show only the first and final state.
- Mini App sessions last up to 12 hours; launch data is single-use, so reopen the Mini App from Telegram after expiry.
  A session also ends as soon as its Telegram account is revoked or its bot is disabled or removed.
- Plain HTTP LAN access is unencrypted on Wi-Fi. IPv6-only LAN clients are not supported.
- A Cloudflare quick tunnel terminates TLS at Cloudflare: what you type in the Mini App passes Cloudflare's edge
  unencrypted. Tailscale Serve and Funnel terminate TLS on the Mac.
- Ubuntu kernel updates inside the guest are allowed (EFI boot) but are not tested across reboots.
- After forced stops of a frozen VM, a guest filesystem can be damaged; NEBULA checks and repairs the root filesystem
  on every boot, and you can reprovision with `nebula repair`. See [decisions.md](decisions.md) D26 and D31.
