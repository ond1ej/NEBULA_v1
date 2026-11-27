# Installation

NEBULA installs from a git checkout with one command. The installer never uses `sudo`, never installs a tool without
asking, never deletes user data, and is safe to re-run.

## Requirements

| | Required | Notes |
|---|---|---|
| Mac | Apple silicon (`arm64`) with virtualization support | Intel Macs are refused |
| macOS | 13 or later | |
| Memory | 8 GB | 16 GB or more recommended. On Macs with 16 GB or less, the first install gives the VM 4096 MB |
| Free disk | 25 GB on the data directory's volume | 20 GB for the VM disk plus the build and the image download |
| Network | Internet access for the first install | Ubuntu image (about 600 MB), Ubuntu packages, Playwright's Chromium |
| Tools | Xcode Command Line Tools, `uv`, Node.js 20.19+ on Node 20, or 22.12+, `pnpm` | The installer offers to install what is missing. The dashboard build (Vite 7) needs `^20.19.0 \|\| >=22.12.0`, so Node 21 is refused; `uv` is also needed later for `nebula deploy` and updates |
| Recommended | Homebrew, `gnupg` | Homebrew is used to install missing tools if present; `gnupg` adds Ubuntu's own signature check on top of the pinned SHA-256 |

## Install

```bash
git clone https://github.com/ond1ej/NEBULA_v1.git
cd NEBULA_v1
./install.sh
```

To see what would happen without changing anything:

```bash
./install.sh --check
```

`--check` prints every check and the plan (which tools it would offer to install, which builds it would run) and exits
`0` if the Mac is ready or `1` if a hard requirement is not met. On a Mac where this instance is already installed it
says "already installed" and points you to `./update.sh` instead of planning a new install. When `pnpm` comes through
`corepack`, `--check` does not run it, so it downloads nothing: it shows the pnpm version only if corepack has already
downloaded it, and otherwise says that the build downloads pnpm first.

### What `install.sh` does

1. **Checks the Mac:** macOS version, Apple silicon, virtualization support (`kern.hv_support`), RAM and free disk.
   Hard failures stop the installer before it changes anything.
2. **Checks and offers tools**, each with a yes/no question: Xcode Command Line Tools (`xcode-select --install`), `uv`
   (Homebrew, or uv's official installer into `~/.local/bin`), Node.js 20.19+ on Node 20, or 22.12+ (Homebrew, or you
   install it from nodejs.org; an older Node.js or Node 21 is reported as unsupported), `pnpm` (through `corepack`),
   optionally `gnupg`.
3. **Builds NEBULA:** `uv sync --frozen` (Python 3.13 and the locked dependencies in `.venv`), `make helper` (builds the
   Swift VM helper and signs it ad hoc with the Virtualization entitlement), `pnpm install --frozen-lockfile` and
   `pnpm build` (dashboard and Mini App).
4. **Runs `nebula install`:**

   | State | What happens |
   |---|---|
   | `PREFLIGHT` | macOS and CPU, Virtualization entitlement (helper `doctor`), RAM, VM memory profile, disk, write access, network, AI endpoint reachability, port, firewall, sleep policy |
   | `DOWNLOAD` | Resumable HTTPS download of the pinned Ubuntu 24.04 ARM64 cloud image from `cloud-images.ubuntu.com` into `<data>/cache/images/` |
   | `VERIFY` | Ed25519 signature of `guest/image-builder/manifest.json`, the image's SHA-256, and Ubuntu's GPG-signed `SHA256SUMS` when `gpg` is installed; QCOW2 converted to a sparse raw disk |
   | `DISK_CREATE` | Per-install SSH keys and a pinned guest host key, a random guest RPC key in the Keychain, a cloud-init seed, the sparse VM disk (up to 32 GB) |
   | `VM_BOOT` | Starts the VM (EFI) and waits for SSH with the pinned host key |
   | `GUEST_PROVISION` | Hardening, swap and early OOM handling, XFCE, TigerVNC, Playwright Chromium, the NEBULA guest service (Python packages installed with pinned hashes), the guest firewall (nftables: Internet allowed, local-network destinations blocked, see [configuration.md](configuration.md#vm-network-access)); then a controlled reboot |
   | `HEALTHCHECK` | Host-to-guest RPC and latency, a temporary desktop: X server, headed browser, non-empty screenshot, no password logins |
   | `READY` | Copies the runtime to `<data>/app/<version>-<timestamp>/` (the `current` symlink points at it), optionally installs the LaunchAgent, starts the service and polls `GET /api/v1/health` |

5. **Prints the first-run link** `http://127.0.0.1:<port>/#/setup?token=...`. Open it on the Mac (see
   [getting-started.md](getting-started.md)).

Every step is printed as it runs and recorded in `<data>/install-report.json`. If the service does not pass its health
check after the install, the installer exits with code `3` and tells you to run `nebula diagnostics`; any other
failure exits non-zero with the failing state and leaves your data in place.

### Options

| Option | Meaning |
|---|---|
| `--check` | Report only; changes nothing |
| `--yes`, `-y` | Non-interactive: accept every offer (tool installs, autostart) |
| `--autostart yes\|no\|ask` | Install the LaunchAgent that starts NEBULA after you log in. Default `ask`; without a terminal and without `--yes`, `ask` means no. `--no-autostart` is the same as `--autostart no` |
| `--port N` | Dashboard and API port (default `3100`) |
| `--vm-ram-mb N` | VM memory in MB (default 6144; 4096 on Macs with 16 GB or less) |
| `--offline-image FILE` | Use a pre-downloaded Ubuntu image instead of downloading; it is verified against the same pinned hash. Provisioning still needs Ubuntu's package mirrors |
| `--instance ID` | Install a separate instance beside the default one (see [configuration.md](configuration.md#instances)) |
| `--reprovision` | Re-run guest provisioning even if the install is already `READY` |
| `--no-open` | Do not open the dashboard when done |

### Re-running

Re-running `./install.sh` skips finished work. An existing VM is reused and never overwritten. An install that is
already `READY` and healthy reports "already READY - nothing to do"; use `--reprovision` to re-apply guest
provisioning, and `./update.sh` to move to a newer release.

## Autostart

Autostart is a per-user LaunchAgent (`~/Library/LaunchAgents/dev.nebula.host.plist` for the default instance). It
starts NEBULA after you log in, restarts it if it crashes, and writes logs to `~/Library/Logs/NEBULA/host.log`.
NEBULA does not run before login.

```bash
.venv/bin/nebula autostart status
.venv/bin/nebula autostart enable     # installs the LaunchAgent and health-checks the service
.venv/bin/nebula autostart disable    # removes it; data is never touched
```

Without autostart, start NEBULA in the foreground when you need it:

```bash
.venv/bin/nebula serve
```

Every LaunchAgent operation first checks that the LaunchAgent belongs to the same data directory, and refuses to touch
one that belongs to another instance.

## Everyday commands

```bash
.venv/bin/nebula status        # installation, VM, LaunchAgent, dashboard and LAN URLs (JSON)
.venv/bin/nebula health        # GET /api/v1/health of the running service; exit 0 when healthy
.venv/bin/nebula doctor        # preflight plus a live VM health check; exit 1 on failure
.venv/bin/nebula restart       # restart the service and health-check it
.venv/bin/nebula diagnostics   # write a redacted support bundle (.tar.gz) to <data>/diagnostics/
.venv/bin/nebula vm stop       # graceful VM stop (agents' files persist); vm start, vm status
.venv/bin/nebula repair        # re-apply guest provisioning and verify, keeps all data
.venv/bin/nebula setup-url     # print the first-run link again (until an admin exists)
.venv/bin/nebula reset-password <user>   # local password recovery; signs out all sessions
```

All commands accept `--instance ID`. The dashboard's **System** page offers the same operations (Repair, Start/Stop VM,
Restart services, Backup DB, Export diagnostics, logs).

The diagnostics bundle contains version and instance metadata, the configuration, installation state, LaunchAgent, VM
and runtime status, a health probe and the tails of the host, VM helper and provisioning logs, all passed through the
secret redactor with your home directory replaced by `~`. It never contains the database, keys, Keychain values or
workspace files. Read it before you share it.

## Update

```bash
./update.sh                     # newest vX.Y.Z release tag
./update.sh --ref v1.0.1        # a specific tag, branch or commit
./update.sh --dry-run           # only report what would happen
./update.sh --instance test     # update another instance
```

`update.sh` is a thin wrapper around `nebula update`, which:

1. refuses a checkout with local changes, or a LaunchAgent that belongs to another data directory;
2. runs `git fetch --tags` and picks the newest `vX.Y.Z` tag (or your `--ref`);
3. **backs up the database** to `<data>/backups/` (an online SQLite backup, owner-only);
4. checks out the target and builds it (`uv sync --frozen`, the VM helper, the dashboard; skip with `--no-build`);
5. deploys a new runtime directory (**the previous one is kept**), installs its dependencies with
   `uv pip sync --require-hashes` from the locked `uv.lock` (so `uv` must be installed), runs the database migrations
   and restarts the service;
6. health-checks the new version.

If anything fails after the checkout, it **rolls back**: the service is stopped, the database backup is restored, the
previous runtime and VM helper are put back, the service is restarted and the checkout returns to where it was. User
data is never deleted. `--force` redeploys even if you are already at the target.

The VM is not recreated by an update. If a release changes guest provisioning, its release notes say so; apply it with
`.venv/bin/nebula repair`. Repair keeps your guest firewall exceptions in `/etc/nebula/firewall-lan-allow.nft`.

Developers who want to run the code of their current checkout without moving to a tag can use
`.venv/bin/nebula deploy`, which copies this checkout into a new runtime directory and restarts the service if a
LaunchAgent is installed (`--no-restart` deploys only), then health-checks it.

## Uninstall

```bash
./uninstall.sh                  # stop the VM, remove the LaunchAgent; KEEPS all data
./uninstall.sh --remove-data    # also delete this instance's VM, database, workspaces and Keychain items
```

The default uninstall keeps everything in the data directory, so a later `./install.sh` picks up where you left off.

`--remove-data` asks you to type `DELETE-ALL-NEBULA-DATA` (non-interactive: add `--confirm DELETE-ALL-NEBULA-DATA`).
It deletes the data directory and log directory of **this instance** and the Keychain items NEBULA recorded for it, and
nothing else: other instances, the checkout, Tailscale, Ollama and its models are not touched. It cannot be undone.
Export the Password Vault first if it holds anything you need.

What is left after `--remove-data`: the git checkout (delete the folder yourself), tools you installed (uv, Node.js,
pnpm, gnupg, Homebrew), and any Tailscale or Cloudflare configuration you created yourself.

## Files

| Path | Contents |
|---|---|
| `~/Library/Application Support/NEBULA/` | Data directory: `config.yaml`, `nebula.db`, `vm/`, `app/` (runtime), `artifacts/`, `attachments/`, `keys/`, `backups/`, `diagnostics/`, `install-report.json` |
| `~/Library/Logs/NEBULA/` | `host.log`, `vm-helper.log`, `guest-provision.log` |
| Login Keychain, service `dev.nebula.platform` | Secrets (provider keys, tokens, guest RPC key, device and push keys) |
| `~/Library/LaunchAgents/dev.nebula.host.plist` | LaunchAgent, only with autostart |

A non-default instance uses `NEBULA-<id>` for the data directory, keeps its logs in `<data>/logs`, and uses the Keychain
service `dev.nebula.platform.<id>` and the LaunchAgent `dev.nebula.host.<id>`. See
[configuration.md](configuration.md).

## Release archives

Tagged releases on GitHub include a source archive, a prebuilt dashboard bundle and a `SHA256SUMS` file. Verify a
download with:

```bash
shasum -a 256 -c SHA256SUMS --ignore-missing
```

The installer always builds from source; the dashboard bundle is provided for people who package NEBULA themselves.
NEBULA releases are unsigned developer builds: there is no notarized app.
