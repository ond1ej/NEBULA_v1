# Design decisions

Each entry records what was decided, why, and how it relates to the original design brief ("spec"). The numbering is
historical: entries are referred to by number from code comments. Later entries record lessons from hardware testing
during development (November 2026).

## D1 — Default port 3100, configurable
The default `127.0.0.1:3100` is kept in code/config. If the port is taken by another local application, run
`nebula install --port <free port>`, which writes
`instance.port` to `config.yaml`; preflight reports a busy port as a warning. All ports are configurable.

## D2 — Base image: pinned Ubuntu 24.04 LTS cloud image + idempotent provisioning (not a pre-baked golden image)
* Image: `ubuntu-24.04-server-cloudimg-arm64.img` from the dated release directory `release-20261017`, pinned by
  SHA-256 in `guest/image-builder/manifest.json`. The manifest is signed with an Ed25519 release key
  (`manifest.json.sig`, public key in `guest/image-builder/keys/`; the private key is kept outside the repo).
  The installer refuses an unsigned/tampered manifest or a hash mismatch, and additionally verifies Ubuntu's own
  GPG-signed `SHA256SUMS` (key `D2EB44626FDDC30B513D5BB71A5D6C4C7DB87C81`) when `gpg` is available.
* Ubuntu publishes the full GPT/EFI disk only as QCOW2; Virtualization.framework needs raw. We ship a small
  dependency-free QCOW2→sparse-raw converter (`apps/setup/nebula_setup/qcow2.py`, zlib clusters) instead of
  requiring `qemu-img`.
* The desktop stack (XFCE, TigerVNC, Playwright Chromium, guest service, firewall) is installed by
  `guest/scripts/provision.sh` over SSH at first boot. The spec prefers a golden image but explicitly allows
  idempotent provision scripts; the same script is the **Repair** path. A distributable golden image (provisioned
  disk + new manifest entry) is future work because it requires hosting a multi-GB artifact.
* 24.04 instead of 26.04: Playwright's supported-OS matrix for `install-deps` covers 24.04; 26.04 was not verified.

## D3 — EFI boot of the unmodified cloud disk
`VZEFIBootLoader` + EFI variable store boots Ubuntu's own GRUB, so in-guest kernel updates keep working
(a `VZLinuxBootLoader` with an external kernel would freeze the kernel version).

## D4 — Host↔guest channel: virtio-vsock + HMAC frames (no guest TCP ports)
Spec §2.2 prefers VirtIO socket. The Swift helper owns the `VZVirtioSocketDevice` and bridges host unix sockets
(`run/vm/vsock-7000.sock` RPC, `vsock-7001.sock` VNC tunnel, mode 0600) to guest vsock ports. Every frame carries
HMAC-SHA256 + timestamp + nonce (replay cache) — the "MAC/nonce handshake" of spec §12.3 — instead of mTLS.
The key (32 random bytes per install) lives in the macOS Keychain and in `/etc/nebula/rpc.key` (root, 0600);
`guest.rotate_key` exists for revocation. The only IP service in the guest is SSH (key-only, `AllowUsers
nebula-admin`, nftables allows it only from the host NAT gateway `192.168.64.1`), used for provisioning/repair.
The guest's SSH host key is generated on the host and injected via cloud-init, so it is pinned (no TOFU).

## D5 — VNC without passwords
Each agent's `Xvnc` listens only on a unix socket (`-rfbport -1 -rfbunixpath /run/nebula-vnc/<user>/vnc.sock`,
mode 0600, `SecurityTypes None`). No VNC password exists anywhere (nothing to leak). Only the root guest service
can reach the socket, and only after an authenticated tunnel request naming the agent. Read-only is enforced on
the host proxy by parsing client RFB messages (`packages/live-broker/nebula_live/rfb.py`) and dropping
Key/Pointer/CutText/SetDesktopSize unless the viewer holds the exclusive control lease.

## D6 — Browser: Playwright Chromium (headed) instead of Firefox
Playwright cannot drive stock Firefox, and Ubuntu ships Firefox/Chromium as snaps. We use Playwright's Chromium
build in headed mode on the agent's own `DISPLAY` with a per-agent persistent profile. Ubuntu 24.04 restricts
unprivileged user namespaces, so an AppArmor profile grants `userns` **only** to that Chromium binary; the
Chromium sandbox stays enabled (no `--no-sandbox`).

## D7 — Agent isolation inside one VM
Linux user `nebula_<first 8 hex of agent UUID>` (validated pattern; never derived from user input), home 0700,
own X11 cookie, own D-Bus session, own runtime dirs, systemd units `nebula-desktop@` / `nebula-tools@` with
`NoNewPrivileges`, `ProtectSystem=full`, `ProtectHome=tmpfs` + bind of the agent's own home (other homes are
invisible), memory/CPU/task limits. No sudo. Shared kernel ⇒ weaker than VM isolation (stated in the UI/docs).

## D8 — Screenshots via Pillow's XCB grabber
`mss` failed against Xvnc's visual ("drawable's visual not found"); `PIL.ImageGrab.grab(xdisplay=...)` works and is
used for `desktop.screenshot` and the health-check (non-empty = more than one luminance value).

## D9 — Tool names on the wire use underscores
OpenAI/Anthropic/Gemini require `^[a-zA-Z0-9_-]+$`; `browser.navigate` is exposed as `browser_navigate` and mapped
back to the guest name.

## D10 — Task completion requires verification
`task_complete` must list artifacts (workspace files / open URL) which the runtime re-checks in the guest. If the
agent changed anything but proves nothing, the task does not become `COMPLETED` (two retries, then `FAILED`).
Pure question answering without side effects completes as `answer_only`.

## D11 — Approvals and anti-circumvention
Actions are classified into categories (privileged, mass_delete, external_share, payment, credential_entry,
outbound_message, system_change, system_install). Approval-requiring categories pause the task
(`WAITING_APPROVAL`, TTL 15 min, audit). After a denial, every later action in the same category through **any**
tool is auto-denied for the task. Access to other agents' homes and NEBULA secrets is always denied.

## D12 — Crash safety for side effects
Side-effecting tool calls are written to the checkpoint as `in_flight` before execution. After a crash/restart an
`in_flight` entry becomes `outcome_unknown`; it is never replayed automatically, and the model is told to observe
first. Smart Pause stops at tool boundaries; Immediate Pause cancels model streaming/waits but never a running
guest action (reported as `in_flight`).

## D13 — OpenAI "Sign in with ChatGPT"
Implemented from the official OSS token-sharing docs fetched 2026-11-15: OIDC code + PKCE S256, loopback redirect
`http://127.0.0.1:<port>/auth/callback` (only the port may vary — we reuse the dashboard port), dynamic client
registration (`dynamic_agent_client` → stored `oaiapp_` id), `ext_agent_host_id = urn:uuid:<per install>`, ID token
verified via JWKS (iss/aud/nonce/exp), serialized rotating refresh, terminal refresh errors → `Re-auth Required`,
Responses API with `store:false`, `stream:true`, no unsupported parameters, usage-limit errors → `Quota Reached`
with a link to `chatgpt.com/settings/usage` (no inferred reset time). Credentials in Keychain. The live OAuth
round-trip needs a real ChatGPT account, so the hardware harness reports it as `BLOCKED` unless one is available.

## D14 — Claude Code / Codex / Antigravity coding modes are detection-only
Spec §6 requires a legal/technical review before running vendor CLIs on the user's behalf. NEBULA detects installed
CLIs and reports `Unsupported on this version` with the reason. There is no Claude.ai subscription login anywhere;
Anthropic is supported via API key. The retired consumer Gemini CLI login is not implemented; Gemini uses an API key.

## D15 — Spend control via token caps
Prices change and are not hard-coded. Each provider can have a `daily_token_cap`; reaching it sets
`Quota Reached` and parks tasks in `WAITING_PROVIDER` (no retry loop). Automatic fallback to another provider
happens only if the agent has an explicit `fallback_provider_id` (per-agent consent); global default is off.

## D16 — Telegram
Long polling only, single leader (DB lease), durable offset + `update_id` primary-key dedup. Topics: private-chat
topics (Bot API 9.3/9.4: `has_topics_enabled`, `createForumTopic` in private chats) when the bot has topic mode
enabled in BotFather; otherwise `/use` + inline keyboard fallback. The private-supergroup variant is not
implemented (documented limitation). Approvals can be answered with inline buttons only by the designated owner's
own Telegram account, and approval cards go only to the owner's chat; approvals that need a fresh owner over the API
(vault, credential, host and system approvals; owner approvals of commands, packages and plugins) are never decided
by a chat button and open the Mini App or point to the dashboard instead. Operators' chat commands and buttons need
the same stored permission as the matching API route (`nebula_telegram/access.py`).
Voice was added later with local whisper.cpp and an optional, consented cloud fallback (see `docs/features/voice.md`).

## D17 — First admin requires a setup token
To stop another local process or a web page from racing to create the first admin, `/auth/setup` requires a
one-time token stored in `run/setup-token` (0600) and printed by `nebula install` as part of the dashboard URL.

## D18 — Request guards
Host header allowlist (DNS-rebinding defence), Origin required and checked on every state-changing request and
WebSocket, CSRF header bound to the session, HttpOnly SameSite=Strict cookie, CSP, Argon2id, lockout after 5
failures, per-IP rate limit. Session cookies are not `Secure` because the dashboard is plain-HTTP loopback.

## D19 — Key material on disk
Provider tokens, the Telegram bot token, SIWC credentials and the guest RPC key are in the Keychain. The SSH
admin key and the injected guest host key are files (0600) in `keys/` because `ssh` needs files; they only grant
access to the private NAT VM.

## D20 — Packaging
`nebula install` (CLI) is the installer backend; the dashboard drives the same backend via `/setup/*`. No `.dmg`
or notarization (no Apple Developer ID available) — `scripts/build-release.sh` produces an explicitly
**unsigned developer build**. The VM helper is ad-hoc signed with `com.apple.security.virtualization`, which is
sufficient on the user's own Mac. Autostart is a per-user LaunchAgent (`dev.nebula.host`), not `SMAppService`
(that needs a signed app bundle). As specified, NEBULA runs after login, not before.

## D21 — Snapshots
`nebula-vm snapshot` only clones the disk (APFS clonefile) of a **stopped** VM; live snapshots return
`unsupported`.

## D22 — Repository layout
One Python distribution with packages mapped onto the spec's directories (`apps/host-api/nebula_host`,
`packages/agent-runtime/nebula_runtime`, …) via Hatch; guest code is bundled from `guest/` + `packages/contracts`.

## D23 — Memory search
SQLite FTS5 over `agent_memory` (spec §5.4). Optional local embeddings through Ollama were added later and are off by
default; full-text search always works.

## D24 — Measured VM/RAM profile on a 16 GB Mac mini
The brief asks to start at 6 GiB / 4 vCPU and measure. Measurement on a Mac mini M4 16 GB (with other desktop
apps running): 6 GiB VM + local `qwen2.5:7b` at 16k context (5.5 GB wired GPU memory) drove macOS swap to
5.5 GB, the VM's memory was paged out and the guest wedged at 400 % CPU (no RPC, no ping) until a forced VM
restart. Changes: the measured host runs the VM at **4096 MiB / 4 vCPU** (`vm.ram_mb: 4096`), Ollama uses an 8k
context (5.0 GB), and the Ollama adapter refuses to *load* a model that does not fit in reclaimable RAM
(`WAITING_PROVIDER`, no automatic cloud fallback). The installer default stays 6144 MiB for hosts that use cloud
providers; with a local 7B model on 16 GB use 4096 MiB. Two agent desktops + Chromium fit in 4 GiB (see the
E2E report for measured guest memory).

## D25 — `task_complete` carries an explicit `success` flag
Found during hardware E2E: after transient guest errors a model called `task_complete` saying it could not
proceed, and the task ended `COMPLETED (answer_only)`. Now `success:false` ends the task as `FAILED` with the
agent's explanation, and if any tool call failed, completion requires verified artifacts.

## D26 — Guest freeze + ext4 corruption incident and the resulting safeguards
Observed during hardware E2E (2026-11-15): twice the guest stopped answering (no RPC, no ping, 4 vCPUs at 100 %)
while a local 7B model (≈ 5 GB wired) ran next to the VM on the 16 GB host with other desktop apps open; host swap
was ≈ 5 GB. The second time the VM also had 3 Chromium desktops in 4 GiB without swap. Two forced stops later the
guest root filesystem reported `EXT4-fs error … checksum invalid` and remounted read-only. Safeguards now in place:
* VM disk attachment caching/sync mode changed (final choice in D31).
* Guest kernel cmdline `fsck.mode=force fsck.repair=yes`: the root filesystem is checked/repaired on every boot.
* Guest: 2 GB swapfile, `vm.min_free_kbytes`, `earlyoom` (kills Chromium renderers first, never Xvnc/session/
  guest service), tighter per-agent cgroup limits (desktop 650 MB, tools+browser 1250 MB + 512 MB swap).
* Scheduler: every task start requires guest `MemAvailable` ≥ 700 MB (1200 MB to wake a desktop); with the default
  `resource_policy: sleep_lru` the least-recently-used idle desktop is put to SLEEP first; host memory pressure
  `warning`/`critical` queues tasks; the Ollama adapter refuses to load a model under pressure.
* A guest monitor publishes `vm.state.changed {state: unresponsive}` after ~90 s without RPC; NEBULA never
  force-stops the VM on its own (that is the owner's decision, System → Stop VM).
The corrupted test VM was discarded with the destructive uninstall (E2E-15) and reinstalled from scratch (E2E-01).

## D27 — Runtime is deployed outside TCC-protected folders
A LaunchAgent cannot read `~/Desktop` (where this checkout lives) without a macOS privacy prompt; the service
blocked in `open()` of `.venv/pyvenv.cfg`. `nebula install` / `nebula deploy` therefore copy the runtime (same
layout) to `~/Library/Application Support/NEBULA/app/<version>` with its own venv, and the LaunchAgent runs from
there. Updating from a checkout: `nebula deploy`.

## D28 — API field names vs spec §10.2 example
Agents expose `display_id` and the spec's `desktop_id` (alias); tasks expose `state` and the spec's `status`
(alias). Timestamps are Unix epoch seconds (float) everywhere for consistency with the event stream; the spec's
"ISO-8601" example is not followed. `DELETE /agents/{id}` is synchronous (returns after the guest confirmed the
account removal) rather than a background job; it is idempotent via `Idempotency-Key`.

## D29 — SIGPIPE in the VM helper (found by hardware E2E-07)
Disconnecting a Live Desktop viewer while frame data was in flight made the helper write to a closed unix socket;
the default SIGPIPE action terminated `nebula-vm` and with it the whole VM (no crash report). The helper now ignores
SIGPIPE process-wide and sets `SO_NOSIGPIPE` on every bridged socket; `testBridgeSurvivesPeerCloseMidStream`
reproduces the crash without the fix. Additionally the host service restarts a VM that stopped without the owner
asking (`vm.desired_state == running`), at most 3 times per hour, and reports `vm.state.changed`.

## D30 — No virtio memory balloon (guest kernel panics)
With `VZVirtioTraditionalMemoryBalloonDeviceConfiguration` attached, the guest kernel panicked twice under load
(`Kernel panic - not syncing: corrupted stack end detected inside scheduler`, e.g. in `systemd-udevd` →
`epoll_wait`), which also explains the earlier "guest frozen at 400 % CPU" observations (a panicked kernel spins its
vCPUs). NEBULA never resizes guest RAM, so the balloon device was removed. After the change the complete hardware E2E
matrix plus additional streaming of > 2 GB of frames ran with **0 kernel panics** (console log is now appended
across boots so any future panic is preserved). Root cause inside Virtualization.framework/Linux balloon free-page
reporting is not proven; the device stays off until it is.

## D31 — Disk attachment: `cachingMode: .cached` + `synchronizationMode: .fsync`
History on the test Mac: `.automatic/.full` (initial) survived three provisionings but the guest filesystem was
corrupted after forced stops of a panicking guest; `.uncached/.full` then froze the guest during provisioning I/O
(no ARP, ~300 % CPU, no host memory pressure). The final setting is `.cached` + `.fsync`, a combination used by
Virtualization.framework-based tools after ext4 corruption reports. Together with the removed
balloon (D30), fsck on every boot, and a controlled reboot after provisioning (so `console=hvc0` captures any
kernel message from the first agent session on), this is the configuration verified by the final
hardware E2E run. The underlying platform bug is not proven; if corruption reappears, the console log and
the `root_fs_writable` health flag will show it.

## D32 — Sign in with ChatGPT: issued client id, and sign-in vs. API reachability
* The code exchange (and every refresh) uses the issued `client_id` (`oaiapp_…`) returned on the redirect,
  never `dynamic_agent_client` (official docs: it "is the first-time registration entrypoint, not the client ID to
  save or use for token exchange"). The id is persisted before the exchange and reused for later sign-ins.
  This fixed `HTTP 400 invalid_client`.
* After a successful exchange the credential is stored; reachability of `api.openai.com` is tested separately. A
  network failure is shown as provider state `Error` with a diagnosis (DNS sinkhole, `/etc/hosts` line, IPv6
  route, proxy) instead of "Sign in with ChatGPT failed". Preflight warns about blocked AI endpoints.
* If a hosts-file entry or DNS sinkhole blocks `api.openai.com` or another AI endpoint, NEBULA reports it and does not
  modify system settings or bypass the block; the owner decides whether to remove the entry.

## D33 — `max_steps` is also a hard cap on model requests
Each model request (including provider retries) is counted in the task checkpoint *before* it is sent, and a task
stops as `FAILED` when either tool calls or model requests reach `max_steps`. This makes a per-task spend limit
exact even when a model answers without tool calls. Model lists are cached for 1 h per provider
(`GET /providers/{id}/models?refresh=true` forces a reload) so subscription endpoints are not polled per task.

## D34 — Opt-in LAN access to the dashboard
Spec §12.1 binds to loopback and defers network access to a "future secure gateway"; NEBULA now
has an opt-in LAN mode (Settings → LAN Access, default off, persisted in `config.yaml` `lan:`):
* The loopback listener `127.0.0.1:<port>` is unchanged. LAN listeners are extra uvicorn servers in the same
  process that bind **only** to RFC1918 IPv4 addresses of physical `en*` interfaces — never the VM bridge
  (`bridge100`, so agents in the VM cannot reach it), VPN tunnels (`utun*`) or `0.0.0.0`. They follow IP changes
  and come back after restarts/login.
* Every request/WebSocket is also filtered by source address (loopback or a LAN-interface subnet). Host and
  Origin allowlists grow by the LAN IPs and the mDNS name only while LAN access is on (DNS rebinding and CSRF
  protections stay). CSP `connect-src` is derived from the validated Host.
* HTTP on the LAN sends the password/session unencrypted on Wi-Fi; the UI says so. Optional HTTPS listener
  (default port 3443) with a NEBULA local CA: EC P-256, **critical Name Constraints** (private IPv4 ranges and
  `.local` only, so a leaked CA key cannot impersonate public sites), server cert ≤ 397 days, re-issued on IP
  change; cookies are `Secure` and HSTS is sent on HTTPS. The CA private key is a 0600 file in `keys/`.
* "Continue with ChatGPT" can only be started on the Mac itself (OpenAI allows a 127.0.0.1 callback only); the
  stored connection is then usable from every device.
* No port forwarding, UPnP or public binding is ever performed.
