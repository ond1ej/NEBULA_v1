# Security policy

NEBULA runs AI agents with access to a browser, a terminal and, if you allow it, folders on your Mac. We take reports
about its security seriously and appreciate the time you spend on them.

## Supported versions

| Version | Supported |
|---|---|
| 1.0.x | Yes |
| Older development builds | No |

Security fixes are released as new patch versions. Update with `./update.sh` (see
[docs/installation.md](docs/installation.md#update)).

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Report it privately through GitHub's private vulnerability reporting:

1. Open the repository's **Security** tab.
2. Choose **Report a vulnerability**.
3. Describe the problem, the affected version or commit, how to reproduce it, and the impact you expect.

If private reporting is unavailable for some reason, open a public issue that says only that you have a security
report and asks for a private channel, without any details.

What to expect:

- an acknowledgement within 5 working days;
- an initial assessment (confirmed, needs more information, or not a vulnerability) within 14 days;
- a fix or a mitigation plan for confirmed issues, coordinated with you before public disclosure;
- credit in the release notes if you want it.

This is a small open-source project without a bug bounty. Please give us a reasonable time to fix a confirmed issue
before you publish details, and do not access data that is not yours or degrade other people's installations while
testing. Test against your own install or the isolated test server (`scripts/test_instance.py`).

## Scope

In scope: the host API and remote gateway, authentication and authorization, the installer, the VM helper and the
host-to-guest channel, isolation between agents and between agents and the Mac, the Password Vault and Smart sign-in,
Live Desktop, Telegram integration, the dashboard and Mini App, the native apps, and the supply chain of this
repository (dependencies, workflows, release artifacts).

Known limits that are documented as such are not vulnerabilities by themselves, but a practical way to break a
boundary we claim to enforce is. The boundaries are the VM, the Seatbelt sandbox for host commands, the vault's
sign-in broker, the rule that only the owner can resolve approvals (in every client, the Telegram chat included), the
role limits of other Telegram accounts, and the authentication and authorization of the host API and the remote
gateway. These are **documented limits** (details in
[docs/security-model.md](docs/security-model.md#known-limits)):

- The approval policy is a set of advisory tripwires, not a security boundary. It is pattern based and an agent that
  tries can evade it, for example by sending data out with a plain web request or by naming a file through a glob.
- Internet egress from the VM is not filtered. The guest firewall blocks only your LAN, the Mac, Tailscale (CGNAT),
  link-local and multicast destinations (with exceptions the owner lists in `/etc/nebula/firewall-lan-allow.nft`).
  DNS to a local-network address goes only to the VM's own resolver; DNS to public resolvers is ordinary Internet
  traffic, and lookups can carry data out. For IPv6 the firewall blocks only `fc00::/7`, `fe80::/10` and `ff00::/8`:
  if the VM gets IPv6 connectivity, LAN devices and the Mac are not blocked on their global IPv6 addresses.
- All agents share one Linux kernel. Ubuntu's block on unprivileged user namespaces is lifted for the Playwright
  Chromium binary only, so Chromium keeps its own sandbox; an agent can start that binary and use user namespaces
  through it. That is the kernel attack surface every Ubuntu release had before 23.10; it grants no new privileges.
- Host execution with network access turned on: Unix sockets (except name resolution) and every address of the Mac
  itself stay denied (measured on macOS 27.0.1, Apple silicon: `127.0.0.1`, `::1`, the Mac's LAN IPv4 address and the
  VM bridge address `192.168.64.1` all fail with `EPERM`), but NEBULA does not block any other destination.
- The per-folder `allowed_tools` list is a convenience filter. Tools that can run other programs themselves, such as
  `sed`'s `e` command or a git alias that starts with `!`, get around it; the Seatbelt sandbox is the boundary.
- An enabled remote gateway plus a public tunnel (Tailscale Funnel, Cloudflare) exposes owner administration behind
  the gateway's authentication.
- A Cloudflare quick tunnel terminates TLS at Cloudflare, so passwords typed for a verification, vault passphrases
  and sign-in answers pass Cloudflare's edge unencrypted. Tailscale Serve and Funnel terminate TLS on the Mac.
- The Live Desktop WebSocket on the gateway carries its session token in the URL query. NEBULA redacts it from its own
  logs; a proxy or tunnel in front of the gateway may log URLs.
- LAN access over plain HTTP sends the dashboard password and session cookie unencrypted; use the HTTPS listener.
- Unauthenticated endpoints: `/api/v1/health` (version and provider states) and the API reference at `/api/docs` and
  `/api/openapi.json` on the Mac and on LAN listeners, and `/api/app/hello` (server name, version, key fingerprint) on
  the gateway.
- Clients on the Mac itself are never locked out of the dashboard after failed logins; they are limited to 20 failed
  attempts a minute, so a local process can keep guessing at that rate.
- Whoever controls an approved Telegram account can act within that account's role. With the owner's account that
  includes deciding ordinary approvals with one tap in the chat; approvals that need a fresh verification are never
  decided in the chat.
- Operators and agent-bot users cannot list or decide approvals, but a task's details and the notification feed can
  still show them what a waiting task asks for. Agent-bot users can list and download their agent's workspace files
  in the bot chat (`/files`, `/get`), which their Mini App role does not include.

## Security model in brief

- **Local by default.** The dashboard and API bind to `127.0.0.1`. LAN access and the remote gateway are off until
  you enable them; NEBULA never opens router ports or creates external accounts.
- **Local authentication.** One-time setup token for the first administrator, Argon2id passwords, a per-address rate
  limit and an account lockout after failed logins (not for clients on the Mac itself), HttpOnly SameSite=Strict
  session cookie, CSRF and Origin checks on every state-changing request and WebSocket, Host allowlist against DNS
  rebinding, Content-Security-Policy.
- **Remote gateway.** A separate listener on loopback, reached through a tunnel you choose. Tailscale Serve (tailnet
  only) is recommended; Tailscale Funnel and Cloudflare quick tunnels are public, meant only for the Telegram Mini App,
  and need an explicit confirmation. Bearer sessions from verified Telegram launch data or from Secure Enclave device
  keys of paired apps; a Mini App session ends when its Telegram account is revoked or its bot is disabled or removed.
  One authorization policy for every API route; step-up verification for sensitive actions; rate limits.
- **Roles.** One owner. Approvals are owner-only for every remote caller and in every Telegram chat, and approval
  cards reach only the owner's chat; approvals that need a fresh verification (vault, credential, host and system
  approvals, and owner approvals of commands, packages and plugins) are never decided by a chat button and open the
  Mini App or point to the dashboard instead. Other Telegram accounts get only the permissions stored for them
  (operators: by default tasks, commands and screenshots), in the Mini App and in the bot chat, or a fixed set limited
  to one agent (agent-bot users).
- **Native app pairing.** Single-use QR offers with the server key fingerprint, Secure Enclave device keys, a 6-digit
  code approved on the Mac, challenge-signature sign-in, immediate revocation.
- **Secrets.** Provider keys, ChatGPT tokens, Telegram bot tokens and the guest RPC key are stored in the macOS
  Keychain, never in the database or in logs; diagnostics are redacted.
- **Password Vault.** Argon2id and AES-256-GCM, locked by default, no recovery without the passphrase. Agents never see
  passwords: an isolated broker signs in and hands over only the session, after your approval.
- **Agents.** Each agent is an unprivileged Linux user in one Ubuntu VM, without sudo, behind a guest firewall that
  blocks local-network destinations. Risky actions need the owner's approval. Host execution on the Mac is opt-in and
  runs in a Seatbelt sandbox with network access off by default; with network on, host commands still cannot reach
  the Mac's own addresses or its Unix sockets (except the one for name resolution).
- **Integrity.** The VM image is verified against an Ed25519-signed manifest, a pinned SHA-256 and Ubuntu's signed
  checksums. Dependencies are locked with hashes; CI actions are pinned to commit SHAs.

## Verifying the release key

The VM image manifest is signed with the NEBULA release key. Its public half is
`guest/image-builder/keys/nebula-release-ed25519.pub`, and the SHA-256 of that file is:

```text
cf46bee89be0fe0525515a868f9715c706d9a4c6f8e720b0f549d30d2ef77e3c
```

Check it with `shasum -a 256 guest/image-builder/keys/nebula-release-ed25519.pub` and compare it with the value in
the GitHub release notes. The signature protects against a tampered image mirror or URL, not against a tampered
checkout, because the key ships in the same repository. The private key never enters the repository or CI. Forks
sign with their own key, see [guest/image-builder/README.md](guest/image-builder/README.md).

NEBULA is not invulnerable. Read [docs/security-model.md](docs/security-model.md) for the threat model and what is
enforced versus advisory.
