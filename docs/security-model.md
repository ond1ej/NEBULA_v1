# Security model

NEBULA runs AI agents that browse the web, run commands and act on your behalf. This page describes what NEBULA
protects, which boundaries are enforced by the operating system or by cryptography, which controls are only
advisory, and what is out of scope. It is meant to help you decide what to allow. NEBULA is not invulnerable, and no
part of this page claims otherwise.

To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## Assets

- Your Mac account and its files, Keychain and other applications.
- Secrets held by NEBULA: AI provider keys and ChatGPT tokens, Telegram bot tokens, the guest RPC key, the vault and
  its passwords, device keys of paired apps.
- What agents can reach: their workspaces, signed-in browser sessions, authorised Mac folders, outbound network.
- Your attention: approvals and sign-in requests are decisions you make, and they can be abused to trick you.

## Trust boundaries

```text
 Internet ─┬─ (only if you publish the gateway) ── remote gateway ─┐
           │                                                       ▼
 tailnet ──┴─ (Tailscale Serve, if enabled) ─────────────────► host API on 127.0.0.1 ◄── dashboard on this Mac
                                                                   │
 LAN ───────── (LAN access, if enabled) ───────────────────────────┘
                                                                   │ HMAC-signed vsock RPC
                                                                   ▼
                                                        Ubuntu VM (agents, one Linux user each)
                                                                   │ guest firewall: Internet yes,
                                                                   ▼ LAN, Mac, Tailscale, link-local no
```

The security boundaries are the **VM**, the **Seatbelt sandbox** for host commands, the vault's **sign-in broker**,
the rule that **only the owner resolves approvals** (in every client, the Telegram chat included), and the
authentication and authorization of the host API and the remote gateway. The approval policy that decides *when* to
ask you is advisory (see below).

| Boundary | Enforced by |
|---|---|
| Network to host API | Loopback bind (NEBULA refuses a non-loopback bind while `security.bind_local_only` is on); opt-in LAN listeners only on private addresses of physical interfaces with a source-subnet filter; the remote gateway is a separate listener with its own authentication |
| Browser to host API | Host header allowlist (DNS rebinding), Origin check and a session-bound CSRF header on every state-changing request and WebSocket, HttpOnly SameSite=Strict session cookie, Content-Security-Policy, Argon2id passwords, at most 20 failed logins a minute per address, and an account lockout after 5 failed logins for clients that are not on the Mac itself |
| First administrator | One-time setup token, readable only on the Mac (`0600`), accepted only until an administrator exists |
| Host to guest | Virtio-vsock with HMAC-SHA256 frames, timestamp and nonce (replay protection); no guest TCP service except SSH from the NAT gateway |
| Agent to agent (in the VM) | Separate Linux users without sudo, `0700` homes, per-user systemd units with `ProtectHome=tmpfs`, separate X displays on Unix sockets. Root connects to an agent's tool or VNC socket only after checking that the socket is owned by, and served by a process of, that agent's user; an agent's tool server and desktop refuse an X display served by another user. **All agents share one kernel**: see the limits below |
| VM to your network | The guest firewall (nftables, loaded by provisioning): agents keep Internet access but cannot reach private, CGNAT (Tailscale), link-local or multicast addresses, which covers your LAN, the Mac (`192.168.64.1`), other VMs on the bridge and your tailnet. For IPv6 it blocks only `fc00::/7`, `fe80::/10` and `ff00::/8`, so if the VM gets IPv6 connectivity, LAN devices (and the Mac) reachable on global IPv6 addresses are not blocked. DNS to a local-network address goes only to the VM's own resolver. Owner exceptions: [configuration.md](configuration.md#vm-network-access) |
| Agent to your Mac | The VM. Agents run on the Mac only if you authorise a folder for host execution; then a deny-default Seatbelt profile confines each command |
| Agent to secrets | Provider keys and tokens never enter the VM. Vault passwords are typed by a separate broker user, never by the agent or the model |
| Remote device to host | Mini App sessions from verified Telegram data; app sessions from Secure Enclave key signatures; both Bearer-only and valid only through the gateway. The host re-checks the identity behind a Mini App session at least every few seconds and refuses the session (`401`) once the account is revoked or its bot is disabled or removed |

## What is enforced and what is advisory

| Control | Kind | Notes |
|---|---|---|
| Loopback bind, LAN filter, gateway off by default | Enforced | Configuration is validated on load |
| Per-route authorization policy (`nebula_host/authz.py`) | Enforced | Every API route has exactly one policy; a test checks full coverage of the OpenAPI contract |
| Owner-only approvals | Enforced | Every remote caller except the owner is refused when it lists or resolves approvals, and in a Telegram chat (main bot or agent bot) only the owner's own account can decide one. From a remote session, vault, credential, host and system task approvals and owner approvals of commands, packages and plugins also need a fresh verification of the owner, so a Telegram chat button never decides them: their card opens the Mini App or points to the dashboard |
| Live Desktop read-only unless you hold the lease | Enforced on the server | The broker drops input messages without the lease; viewer tokens are single-use |
| Secrets in the Keychain, redaction of logs and diagnostics | Enforced | Values never enter the database; Bot API URLs and tokens are redacted from logs |
| Password Vault encryption | Cryptographic | Argon2id key derivation, AES-256-GCM; no recovery without the passphrase |
| Image and manifest verification | Cryptographic | Ed25519-signed manifest, pinned SHA-256, Ubuntu's GPG-signed `SHA256SUMS` when `gpg` is installed |
| Linux user separation in the VM | Enforced by the guest kernel | One shared kernel |
| Guest egress firewall | Enforced by the guest kernel | Blocks local-network destinations only (for IPv6: ULA, link-local and multicast, not global addresses); Internet egress is open |
| Seatbelt sandbox for host commands | Enforced by macOS | Uses `sandbox-exec`, which Apple marks as deprecated; NEBULA disables host commands if it disappears. Network access is off by default. With network on, Unix sockets (except name resolution) and every address of the Mac itself stay denied, because Seatbelt's `localhost` filter matches all of the Mac's interface addresses: measured on macOS 27.0.1 (Apple silicon), connections to `127.0.0.1`, `::1`, the Mac's LAN IPv4 address and the VM bridge address `192.168.64.1` fail with `EPERM`. NEBULA does not block other destinations |
| Host file tools | Enforced by NEBULA | Every path component is opened relative to its parent with `O_NOFOLLOW` (no symlinks, no swap races); files with more than one hard link are refused |
| Per-folder `allowed_tools` | Convenience filter | Checks every program named on the command line, not only the first; a command it cannot check (for example `bash -c` or `eval`) is refused. Tools that can run other programs themselves get around it, for example `sed`'s `e` command or a git alias that starts with `!`. The boundaries are the Seatbelt sandbox on the Mac and the VM, not this list |
| **Approval policy** (payments, sending, uploads, privileged commands, mass deletes, secret files) | **Advisory: tripwires, not a security boundary** | Commands, code and tool arguments are classified by fixed rules. Obvious cases are caught, including commands and code that name a `.env`, key or credentials file. A command can still read a secret file through a glob or a computed name, and send data out with a plain GET request, a raw socket or a DNS lookup |
| "Denied once, denied for the task" | Advisory | Applies to everything the classifier recognises as the same category |
| Memory quarantine of instruction-like text | Advisory | Heuristic; memory is always injected as data, never as instructions |
| Plugin risk categories | Advisory | Declared by the plugin author; plugin code is contained only by the agent's Linux user |
| Smart sign-in page detection and destination trust levels | Advisory with hard blocks | Lookalike domains, plain HTTP, DNS rebinding and value exfiltration are blocked; detection of unusual pages is heuristic |
| Telegram identity | Delegated to Telegram | Whoever controls an approved Telegram account can act within that account's role |

## Threats and responses

| Threat | What NEBULA does | What remains |
|---|---|---|
| Someone on the Internet scans for NEBULA | Nothing listens publicly by default. A published gateway answers `401`, `403`, `404` or `429` without a session, except the Mini App files, `/healthz` and `/api/app/hello` (server name, version and key fingerprint) | Publishing the gateway (Funnel, Cloudflare) exposes owner administration behind the gateway's authentication; a flaw there would be reachable from the Internet |
| A device on your LAN | LAN access is off by default; when on, the full dashboard requires login, and plain HTTP shows a warning | Plain HTTP on Wi-Fi exposes your password and session cookie to others on the network; use HTTPS with the local CA or Tailscale. `/api/v1/health` and the API reference (`/api/docs`, `/api/openapi.json`) answer without a session |
| A malicious web page or document prompt-injects an agent | Web content and attachments are marked as untrusted data; risky actions need approval; the agent never holds provider keys or vault passwords; the guest firewall keeps it off your LAN | A prompt-injected agent can still do anything its permission level and the approval classifier let through, including sending workspace data to the Internet |
| A malicious or compromised agent attacks other agents | Separate Linux users and homes; the root guest service checks that a per-agent socket is a real socket owned by that agent and verifies the peer's uid before it connects | Agents share one kernel and the VM's network. Treat all agents in one VM as one trust domain, and do not give an untrusted agent access next to agents that hold sensitive sessions |
| An agent attacks your Mac | Agents run in the VM; the VM has no shared folders and no forwarded ports, and its firewall drops traffic to the Mac's addresses except DNS to the VM's resolver | With host execution enabled, commands run as your macOS user inside Seatbelt, with network off by default. With network on, Unix sockets and every address of the Mac (loopback, LAN, VM bridge) stay denied, so services on the Mac are not reachable from host commands; NEBULA does not block other destinations. A sandbox escape or a flaw in NEBULA's own file tools would act with your user's rights. Enable host folders only for agents and projects you trust |
| Data leaves the VM | Approvals for recognised uploads and messages; no route to your LAN, the Mac or your tailnet | Internet egress is **not filtered**: agents and plugins can reach any Internet host, including public DNS resolvers, and DNS lookups can carry data out |
| A stolen database or backup | Secrets are in the Keychain, the vault is encrypted, device-wrapped vault keys are useless without the device secret | A weak vault passphrase can be guessed offline |
| A stolen phone | Device keys are in the Secure Enclave behind Face ID or the passcode | Revoke the device in the dashboard; until then, someone who can unlock the phone can use the app |
| A compromised Telegram account | Approvals are owner-only in the chat and in the Mini App, and approval cards reach only the owner's chat; task approval buttons carry HMAC tags bound to bot and chat; approvals and other actions that need a fresh verification are never decided by a chat button; vault plaintext needs the passphrase or a device confirmation; revoking the account or disabling its bot ends its Mini App sessions | Within the account's role, the attacker can give tasks; with the owner's account, also decide ordinary approvals with one tap and do everything else up to the point where a fresh verification is required |
| Malware running as your macOS user | Out of scope | It can read the Keychain items NEBULA uses (after a macOS prompt), the database and the unlocked vault in memory. A local process can also try dashboard passwords at 20 failed attempts a minute, because clients on the Mac are never locked out |
| A forged image or update | Signed manifest and hashes | Provisioning installs packages from Ubuntu's signed archive and Chromium from Playwright's download host over HTTPS |

## Remote access exposes administration

When you enable the remote gateway and a tunnel, every API route except the dashboard's own sign-in and a few
Mac-only operations becomes reachable through the gateway for an authenticated session. For the owner that includes
administration: agents, providers, Telegram settings, remote access, host folders and the vault (with step-up). This
is what makes the native apps and the Mini App useful, and it is why the recommended path is **Tailscale Serve**,
which keeps the gateway inside your tailnet. Tailscale Funnel and Cloudflare tunnels publish it to the Internet, are
meant only for the Telegram Mini App and need an explicit confirmation. Details: [remote-access.md](remote-access.md).

What else to know about the remote path:

- **TLS termination.** Tailscale Serve and Funnel terminate TLS on the Mac. A Cloudflare quick tunnel terminates TLS
  at Cloudflare, so passwords you type for a verification, vault passphrases and Smart sign-in answers pass
  Cloudflare's edge unencrypted. Use Serve, Funnel or your own proxy for vault work.
- **Tokens in URLs.** The Live Desktop WebSocket on the gateway authenticates with a `session_token` query parameter.
  NEBULA redacts it from its own logs; a proxy or tunnel in front of the gateway may log full URLs.
- **Headers.** The gateway never passes the caller's cookies, `Authorization`, `Origin`, CSRF or forwarding headers
  to the host API; it identifies the caller itself, and the host API checks the policy again for every request.

## Multiple users

NEBULA has one owner: the local dashboard user and one designated Telegram account. Other Telegram accounts you
approve get a limited role:

- **Operators** (other approved users of the main bot) get exactly the operational permissions stored for them, by
  default tasks, commands and screenshots, in the Mini App, the API and the bot chat alike: every chat command,
  button and voice command needs the permission of the API operation that does the same thing, and the rest is the
  owner's. They never get administration.
- **Agent-bot users** (approved users of one agent's own bot) get a small fixed permission set and a deny-by-default
  list of routes; every resource they reach must belong to that bot's agent. In the bot's chat they keep its commands,
  each limited to that agent (this includes listing and downloading its workspace files with `/files` and `/get`).
- **Approvals are owner-only** for every remote caller. Operators and agent-bot users cannot list or resolve them
  (`GET /approvals`, `/owner-approvals` and `/approval-center` answer `403`, for operators with `owner_only`), they
  never receive approval cards in Telegram, and an approval button they press is refused. A task's details and the
  notification feed can still show them what a waiting task asks for. The owner decides approvals in the dashboard,
  in the native app, in the main bot's Mini App and, for ordinary approvals, with the buttons in the owner's Telegram
  chat. Approvals that need a fresh verification are never decided in the chat; their card opens the Mini App or
  points to the dashboard ([telegram.md](telegram.md#approvals-in-the-chat)). An agent bot's Mini App shows no
  approvals, not even to the owner.

These roles are enforced on every request and in every chat, and a Mini App session fails closed: when its account is
revoked or its bot is disabled or removed, the session ends. Still, an operator who can give tasks to an agent can
make that agent do whatever its permission level and the approval policy allow, so only approve accounts of people
you would let use those agents.

## Known limits

- **Approvals are tripwires.** See the table above. Do not authorise a project folder that holds secrets you are not
  willing to expose to the agent, and keep network access off for folders that do not need it.
- **Internet egress is open.** Only local-network destinations are blocked in the VM. A per-agent Internet allowlist
  is on the [roadmap](roadmap.md).
- **IPv6 is filtered by range only.** The guest firewall blocks `fc00::/7`, `fe80::/10` and `ff00::/8`. If the VM
  gets IPv6 connectivity, devices on your LAN and the Mac are not blocked on their global IPv6 addresses. This was
  not tested on a VM with IPv6.
- **One shared kernel.** All agents run under one Linux kernel. Ubuntu 24.04 blocks unprivileged user namespaces;
  NEBULA allows them for the Playwright Chromium binary only, so Chromium can keep its own sandbox against hostile web
  pages. Because agents can start that binary with their own environment and flags, an agent can also use user
  namespaces through it. That restores the kernel attack surface every Ubuntu user had before 23.10; it grants no new
  privileges. Keep the VM's packages and kernel updated (`nebula repair` re-applies provisioning).
- **Host commands with network on** are kept away only from the Mac itself. Unix sockets (except name resolution)
  and every address of the Mac stay denied: measured with `sandbox-exec` on macOS 27.0.1 (Apple silicon), TCP
  connections to `127.0.0.1`, `::1`, the Mac's LAN IPv4 address and the VM bridge address `192.168.64.1` fail with
  `EPERM`, and so does a UDP send to the LAN address. NEBULA does not block other destinations, so treat other devices
  on your network and the Internet as reachable (that part was not measured).
- **`allowed_tools` is a convenience filter.** Tools that can run other programs (`sed`'s `e` command, a git alias
  that starts with `!`) get around it; the Seatbelt sandbox is the boundary.
- **Local logins are not locked out.** The account lockout protects the dashboard against guessing from other
  machines without letting a LAN device lock you out on the Mac; local clients get the per-address rate limit only.
- **Unauthenticated metadata.** `/api/v1/health`, `/api/docs` and `/api/openapi.json` on the Mac and LAN listeners,
  and `/healthz` and `/api/app/hello` on the gateway, answer without a session. They return no secrets.

## Recommendations

1. Keep the defaults: loopback only, gateway off, LAN off, no host folders.
2. For mobile access use Tailscale Serve and the native app. Publish the gateway only if you need the Telegram Mini
   App, and stop the tunnel when you do not.
3. Give agents the lowest permission level that works (`READ_ONLY` or `STANDARD`). `ADVANCED` means code execution.
4. Keep approvals on. Read what an approval asks for; deny what you did not expect.
5. Give vault grants per credential and per origin, keep the default "always ask", and revoke them when done.
6. Use host execution only with folders and agents you trust, and keep network access off per folder when possible.
7. Allow local-network addresses for the VM only one at a time, and only for services agents really need.
8. Keep macOS, Tailscale and NEBULA up to date, and use a long, unique vault passphrase.

## Related documents

- [features/host-execution.md](features/host-execution.md): host sandbox details
- [configuration.md](configuration.md#vm-network-access): the guest firewall and its exception file
- [security/VAULT_ARCHITECTURE.md](security/VAULT_ARCHITECTURE.md), [security/VAULT_THREAT_MODEL.md](security/VAULT_THREAT_MODEL.md),
  [security/VAULT_PERMISSION_MODEL.md](security/VAULT_PERMISSION_MODEL.md), [security/VAULT_SECURITY_TESTS.md](security/VAULT_SECURITY_TESTS.md)
- [security/SMART_AUTH_ARCHITECTURE.md](security/SMART_AUTH_ARCHITECTURE.md), [security/SMART_AUTH_THREAT_MODEL.md](security/SMART_AUTH_THREAT_MODEL.md),
  [security/SMART_AUTH_REMOTE_SUBMISSION.md](security/SMART_AUTH_REMOTE_SUBMISSION.md)
- [decisions.md](decisions.md): D4 (host-guest channel), D5 (VNC), D7 (agent isolation), D11 (approvals), D17 to D19
  (setup token, request guards, key material), D34 (LAN)
