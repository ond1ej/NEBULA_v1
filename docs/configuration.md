# Configuration

Most settings are changed in the dashboard. This page describes what is stored where, the `config.yaml` file, the
environment variables and how to run more than one NEBULA instance on the same Mac.

## Where things live

| What | Default location | Notes |
|---|---|---|
| Data directory | `~/Library/Application Support/NEBULA/` | Mode `0700`. Override with `NEBULA_DATA_DIR`, or use a separate [instance](#instances). |
| Configuration | `<data>/config.yaml` | Written with mode `0600`. Editable by hand while NEBULA is stopped. |
| Database | `<data>/nebula.db` | SQLite in WAL mode, migrated by Alembic on start. Agents, tasks, steps, messages, memory, approvals, audit, events. |
| VM bundle | `<data>/vm/shared/` | `disk.img` (sparse), EFI variables, `config.json`, `console.log`. |
| Keys | `<data>/keys/` | SSH key for provisioning, pinned guest host key, LAN CA key (if enabled). Files are `0600`. |
| Artifacts | `<data>/artifacts/` | Step screenshots and evidence, 7-day retention by default. |
| Runtime | `<data>/app/` | Copies of the code that the background service runs from: one directory per deploy (`<version>-<timestamp>`), a `current` symlink to the active one and a `previous` symlink to the one kept for rollback, plus the virtual environment. |
| Logs | `~/Library/Logs/NEBULA/` | `host.log`, `vm-helper.log`, `guest-provision.log`. A non-default data directory keeps its logs in `<data>/logs/`. |
| Secrets | macOS login Keychain, service `dev.nebula.platform` | Provider keys, ChatGPT tokens, Telegram bot tokens, guest RPC key, device and push keys. The database holds only references such as `nebula:provider.<id>`. |
| Service | `~/Library/LaunchAgents/dev.nebula.host.plist` | Only when autostart is enabled. |

Nothing outside these locations is written, except the Tailscale or `cloudflared` state that those tools manage
themselves when you start a tunnel from **Remote Access**.

## `config.yaml`

The file is created by the installer. Every key is optional; missing keys take the defaults below. Restart the
service after editing it (**System → Restart services**, or stop and start it from the command line).

```yaml
instance:
  id: default            # instance id, see "Instances" below
  name: My NEBULA
  bind_host: 127.0.0.1   # must stay a loopback address while security.bind_local_only is true
  port: 3100             # dashboard and API port
vm:
  ram_mb: 6144           # VM memory; 4096 is a good value on 16 GB Macs that also run a local 7B model
  cpu_count: 4
  disk_gb_limit: 32      # the sparse VM disk grows up to this size
agents:
  default_active_limit: 2          # agents that may execute at the same time
  default_desktop: 1280x800
  resource_policy: sleep_lru       # or queue_when_full
  require_approval_for_sensitive_actions: true
  max_steps_per_task: 30           # also a hard cap on model requests per task
  screenshot_retention_days: 7
live:
  auto_connect: false
  default_read_only: true
  viewer_session_ttl_seconds: 90   # lifetime of a single-use viewer token
  release_control_on_disconnect: true
  control_lease_seconds: 300
telegram:
  enabled: false
  pairing_ttl_seconds: 300
  poll_timeout_seconds: 30
  max_attachment_mb: 20
  rate_limit_per_minute: 30
providers:
  allow_paid_fallback_without_consent: false
  ollama_base_url: http://127.0.0.1:11434
security:
  bind_local_only: true
  session_ttl_hours: 12
  login_max_attempts: 5
  login_lockout_seconds: 300
lan:
  enabled: false         # opt-in LAN listeners, see remote-access.md
  https: false           # extra HTTPS listener with the NEBULA local CA
  https_port: 3443
```

Values are validated on load (for example `vm.ram_mb` must be between 2048 and 65536, `instance.port` between 1024
and 65535). NEBULA refuses to start with a non-loopback `bind_host` while `security.bind_local_only` is `true`.

`security.login_max_attempts` and `security.login_lockout_seconds` lock an account after failed dashboard logins from
other machines (LAN clients). Clients on the Mac itself (`127.0.0.1`, `::1`) are never locked out, so nobody on the
network can lock you out of your own dashboard; like every client, they are limited to 20 failed logins a minute per
address.

Settings that are changed in the dashboard and stored in the database rather than in this file include the remote
gateway (enabled, port, public URL, tunnel, and `tailscale_https_port`, the Tailscale HTTPS port that Serve or
Funnel uses, default `443`, changeable with `PATCH /api/v1/remote`), the resource profile, per-agent settings,
Telegram pairing and owner, vault and Smart sign-in settings.

## Environment variables

| Variable | Purpose |
|---|---|
| `NEBULA_INSTANCE` | Instance id for this process (same as the `--instance` option of the CLI). |
| `NEBULA_DATA_DIR` | Data directory (same as the `--data-dir` option of the CLI). Prefer an instance id for a second install; see below. |
| `NEBULA_LOG_DIR` | Log directory. |
| `NEBULA_PORT` | Dashboard and API port, overrides `instance.port`. |
| `NEBULA_SECRET_BACKEND` | `keychain` (default) or `memory`. `memory` keeps secrets in process memory only and is meant for tests. |
| `NEBULA_KEYCHAIN_SERVICE` | Override the Keychain service name (advanced; normally derived from the instance id). |
| `NEBULA_VM_HELPER` | Path to a `nebula-vm` helper binary to use instead of the installed one. |
| `NEBULA_TELEGRAM_API_BASE` | Bot API base URL (tests point it at a fake Bot API). |
| `NEBULA_DEV_ORIGIN` | Extra allowed Origin for the Vite dev server, for example `http://127.0.0.1:5173`. |
| `NEBULA_API_TARGET` | Used by the dashboard dev server: the host API it proxies to (default `http://127.0.0.1:3100`). |
| `NEBULA_APNS_TOPIC` | APNs topic (your app's bundle id) when push is configured without a topic. There is no built-in topic. |
| `NEBULA_MANIFEST_PUBKEY` | Verify the VM image manifest with another Ed25519 public key (base64, or a path to a file holding it), for forks that sign with their own key. See [guest/image-builder/README.md](../guest/image-builder/README.md). |
| `NEBULA_TEST_API_PORT`, `NEBULA_TEST_GATEWAY_PORT`, `NEBULA_TEST_DATA_DIR` | Ports and data directory of the isolated test server `scripts/test_instance.py` (it refuses `3100` to `3102` and real data directories). |

[`.env.example`](../.env.example) lists the development overrides. NEBULA never reads secrets from environment
variables or `.env` files: keys belong in the Keychain, entered through the dashboard.

## Instances

An *instance* is one complete NEBULA install: data directory, Keychain service, LaunchAgent and VM. The normal install
is the instance `default`. A second install on the same Mac, for example to try a new version without touching your
working one, uses its own instance id:

```bash
.venv/bin/nebula --instance test install --port 3200
```

| Resource | `default` instance | Instance `<id>` |
|---|---|---|
| Data directory | `~/Library/Application Support/NEBULA` | `~/Library/Application Support/NEBULA-<id>` |
| Logs | `~/Library/Logs/NEBULA` | `<data>/logs` |
| Keychain service | `dev.nebula.platform` | `dev.nebula.platform.<id>` |
| LaunchAgent label | `dev.nebula.host` | `dev.nebula.host.<id>` |
| VM hostname | `nebula-vm` | `nebula-vm-<id>` |
| LAN HTTPS port | `3443` | dashboard port + 1000, unless set |

Rules that keep instances apart:

- An instance id is 1 to 32 characters `a-z`, `0-9` and `-`.
- A `config.yaml` remembers its instance id; NEBULA refuses to open it as another instance.
- A non-standard data directory with the Keychain backend must have its own instance id, otherwise NEBULA refuses to
  start, because it would share the default instance's Keychain items.
- Service operations (install, deploy, uninstall) check that a LaunchAgent belongs to the same data directory before
  touching it.
- Pick a different dashboard port for each instance. Each instance's remote gateway defaults to its own dashboard
  port plus 2.
- Use a separate Telegram bot per instance: one bot token can only be long-polled by one process.
- Two VMs need memory. On a 16 GB Mac give the second instance a small VM (`--vm-ram-mb 2048` to `4096`).

For automated tests that need no VM at all, use `scripts/test_instance.py` instead, see [testing.md](testing.md).

## Ports

| Port (default) | Listener | Reachable from |
|---|---|---|
| `127.0.0.1:3100` | Dashboard and API | This Mac only |
| `127.0.0.1:3102` | Remote gateway (dashboard port + 2), off by default | This Mac; your tunnel forwards to it |
| `<LAN IP>:3100`, `<LAN IP>:3443` | Optional LAN listeners | Devices in your local subnet, only when LAN access is enabled |
| `127.0.0.1:11434` | Ollama (not part of NEBULA) | This Mac |
| Tailscale HTTPS port (`443` by default) | `tailscale serve` or `tailscale funnel` for the gateway, run by `tailscaled` | Your tailnet (Serve) or the Internet (Funnel), only while that tunnel runs |

The VM has no port forwarded to the Mac. Host-to-guest traffic uses virtio-vsock through Unix sockets in the data
directory; the only IP service in the guest is SSH for provisioning, reachable only from the VM's NAT gateway (the
firewall lets sshd's replies on port 22 back to the Mac, and nothing else).

## VM network access

Agents in the VM keep **Internet** access. Provisioning installs a guest firewall (nftables) that drops their
traffic to local-network destinations:

- private IPv4 ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), which covers your LAN, the Mac itself
  (`192.168.64.1`, the VM's NAT gateway) and other VMs on the bridge;
- `100.64.0.0/10` (CGNAT, which includes Tailscale addresses), link-local (`169.254.0.0/16`, `fe80::/10`), IPv6 ULA
  (`fc00::/7`, which also holds Tailscale's IPv6 addresses), multicast (`ff00::/8`, and `224.0.0.0/3`, which also
  covers the reserved `240.0.0.0/4`) and a few other reserved ranges.

For IPv6 these are the only blocked ranges (`fc00::/7`, `fe80::/10`, `ff00::/8`). Your LAN devices and the Mac often
also have **global** IPv6 addresses, and those are not blocked: if the VM gets IPv6 connectivity, agents can reach
them like any Internet host. Whether the VM gets IPv6 depends on your network and macOS; NEBULA does not check it,
and this was not tested on a VM with IPv6.

DHCP keeps working, and DNS to a local-network address is allowed only to the resolvers the VM itself uses
(regenerated on every provisioning and repair). DNS to public resolvers is ordinary Internet traffic. Dropped packets
are counted; dropped IPv4 packets are also logged, rate-limited, with the prefix `nebula-egress-drop` in the guest's
kernel log.

**Allowing a local address.** If agents need a service on your network, such as a NAS, an intranet site, a router's
web interface for Smart sign-in, or an apt or pip mirror, list it in `/etc/nebula/firewall-lan-allow.nft` inside the
VM. The exception applies to every agent. The file is created once and kept by `nebula repair`.

1. Find the VM's address in the Mac's DHCP leases: the block named `nebula-vm` (`nebula-vm-<id>` for another
   instance) in `/var/db/dhcpd_leases`.
2. Open a shell in the VM with the per-install admin key (for another instance, use its data directory
   `NEBULA-<id>`):

   ```bash
   DATA="$HOME/Library/Application Support/NEBULA"
   ssh -i "$DATA/keys/guest_admin_ed25519" -o IdentitiesOnly=yes \
       -o UserKnownHostsFile="$DATA/keys/guest_known_hosts" -o StrictHostKeyChecking=yes nebula-admin@<VM address>
   ```

3. Add one line per address or range and reload the rules; the check (`nft -c`) runs before anything is loaded:

   ```bash
   echo 'add element inet filter lan_allow4 { 192.168.1.20 }' | sudo tee -a /etc/nebula/firewall-lan-allow.nft
   sudo nft -c -f /etc/nftables.conf && sudo nft -f /etc/nftables.conf
   ```

   IPv6 addresses go into `lan_allow6`. Remove the line and reload to take an exception back.

Allow single addresses rather than whole ranges, and only for services you are willing to expose to every agent. A
Smart sign-in on a local-network address also has to be allowed in the Smart sign-in settings
([features/smart-sign-in.md](features/smart-sign-in.md#destination-trust)).
