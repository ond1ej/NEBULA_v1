# Troubleshooting

## Start here

```bash
.venv/bin/nebula doctor     # every preflight check plus a live health check, as JSON; exit code 1 on failure
.venv/bin/nebula status     # installation record, VM state, LaunchAgent, dashboard and LAN URLs
```

Each check in the `doctor` output has an `id`, a `status` (`pass`, `warn` or `fail`) and a `detail`. The sections
below are named after those ids and after the error codes the installer prints (`INSTALL FAILED at <STATE>: ...`).
The full install record is in `<data>/install-report.json`.

For a bug report, use **System → Export diagnostics** in the dashboard. The bundle is redacted (no keys, tokens or
passwords), but read it before you attach it to a public issue.

Logs: `~/Library/Logs/NEBULA/host.log`, `vm-helper.log`, `guest-provision.log` (a non-default instance keeps them in
`<data>/logs/`). The VM's console log is `<data>/vm/shared/console.log`.

## Preflight checks

### `macos_version`
NEBULA needs macOS 13 or later. Update macOS in System Settings → General → Software Update.

### `cpu_arch`
NEBULA runs only on Apple silicon (`arm64`). Intel Macs are not supported, and running the installer under Rosetta
reports `x86_64`: use a native arm64 terminal and Python.

### `virtualization`
The VM helper is missing, not signed with the Virtualization entitlement, or the Mac cannot run VMs (for example inside
another VM without nested virtualization). Rebuild and sign it:

```bash
make helper
apps/host-vm-helper/.build/release/nebula-vm doctor
```

### `memory`
`warn` below 16 GB, `fail` below 8 GB of RAM. With 8 to 16 GB, use a smaller VM (`--vm-ram-mb 4096`) and avoid large
local models next to it.

### `vm_profile`
The configured VM RAM would leave less than 4 GB for macOS. Lower `vm.ram_mb` in `config.yaml` or install with
`--vm-ram-mb`.

### `disk_free`
Less than 20 GB free on the data directory's volume. Free space; the VM disk is sparse but grows up to 32 GB.

### `data_dir_writable`
NEBULA cannot write to its data directory. Check ownership and permissions of
`~/Library/Application Support/NEBULA` (it should belong to you, mode `0700`).

### `internet`
`cloud-images.ubuntu.com` is not reachable. The first install needs Internet access; check proxy, DNS and firewall
settings. With a pre-downloaded image you can use `--offline-image <file>` (it is verified against the same pinned
hash), but provisioning still needs Ubuntu's package mirrors.

### `provider_endpoints`
A cloud AI endpoint resolves to a blocked address (for example an `/etc/hosts` entry or a DNS sinkhole). This affects
only the matching provider; Ollama keeps working. NEBULA reports the cause and never changes system settings: remove
the block yourself if you want that provider.

### `port`
The dashboard port is in use. That is fine if NEBULA itself is running; otherwise pick another port with
`--port <n>` or `instance.port` in `config.yaml`.

### `macos_firewall`
Informational. NEBULA binds to `127.0.0.1` and needs no inbound firewall rule.

### `sleep_policy`
`warn` when system sleep is enabled: agents pause while the Mac sleeps. Prevent automatic sleep in System Settings →
Energy (or Battery → Options on a laptop).

### `vm_state`
Informational: the NEBULA VM is already running.

## Installer errors

### `install_in_progress`
Another install or repair holds the lock. Wait for it to finish; if none is running, a stale lock clears itself when
the process that held it is gone.

### `helper_missing`
The VM helper is not built yet. Run `make helper` (the installer normally does this for you).

### `preflight_failed`
At least one preflight check failed. The message lists them; see the sections above.

### `vm_missing`
`repair` was asked to fix a VM that does not exist. Run the installer instead.

### Image verification: `manifest_unsigned`, `manifest_bad_key`, `manifest_bad_signature`, `manifest_invalid`
The image manifest in `guest/image-builder/` does not verify against the release key. Do not work around this: your
checkout is incomplete or modified. Check out a clean copy of a release tag.

### Image verification: `hash_mismatch`, `upstream_hash_mismatch`, `upstream_signature_invalid`
The downloaded image does not match the pinned SHA-256, or Ubuntu's signed checksum list disagrees. The file is
quarantined and no VM is created. Retry; if it persists, report it. Never edit the manifest to make it pass.

### `download_failed`
The image server returned an error. Retry later; the download resumes.

### `bundle_failed`, `provision_failed`
Building the guest bundle or provisioning the VM failed. The message shows the last lines of the provisioning output;
the full log is `guest-provision.log`. Common causes are a network interruption while Ubuntu packages download, or too
little memory. Run `.venv/bin/nebula repair` to re-apply provisioning; it keeps all data.

### `guest_rpc_unreachable`
The host cannot reach the guest service over vsock. Check that the VM runs (`.venv/bin/nebula vm status`), look at
`console.log`, and check memory pressure (see "Guest unreachable" below). Then `.venv/bin/nebula repair`.

### `desktop_unhealthy`
The test desktop did not produce a screenshot (X server, browser or screenshot failed). Run `.venv/bin/nebula repair`.
If it persists, attach `guest-provision.log` and the doctor output to a bug report.

### `confirmation_required`
`uninstall --remove-data` deletes everything and needs `--confirm DELETE-ALL-NEBULA-DATA`. Without it, nothing is
removed.

### `keychain_service_mismatch`
The secret store of this process is bound to another instance's Keychain service, so NEBULA refuses to delete
anything. Run the command with the right `--instance` (see [configuration.md](configuration.md#instances)).

## Running NEBULA

| Symptom | Check and fix |
|---|---|
| Install stuck at `VM_BOOT` | `tail "$HOME/Library/Application Support/NEBULA/vm/shared/console.log"`; cloud-init writes `NEBULA_CLOUDINIT_DONE` when it is done. |
| `Host key verification failed` | The guest host key is pinned in `keys/guest_known_hosts`. If you replaced the VM, run the installer again; never edit the key by hand. |
| Guest unreachable, VM at 300 to 400 % CPU, no ping | The Mac is swapping (`sysctl vm.swapusage`). Stop large local models (`ollama stop <model>`), lower `vm.ram_mb`, then `.venv/bin/nebula vm stop --force` and `.venv/bin/nebula vm start`. See [decisions.md](decisions.md) D24 and D26. |
| Agent in `ERROR: workspace missing in guest` | System → Repair. If the VM was recreated, delete and recreate the agent. |
| Live Desktop shows "desktop unavailable" | The agent sleeps (wake it), or its desktop crashed: agent → Settings → Restart desktop. |
| Task waits in `WAITING_PROVIDER` | Provider quota, sign-in or memory. The task shows the reason; fix it and press Resume. |
| Task waits in `WAITING_APPROVAL` | Approve or deny in the chat, Approvals, the main bot's Mini App, the native app or your Telegram chat, as the owner (other Telegram accounts never get the card, and agent bots' Mini Apps show no approvals). Approvals expire after 15 minutes and then count as denied. |
| The Telegram card says it "cannot be decided in the chat" | Expected for vault, credential, host and system approvals and for owner approvals of commands, packages and plugins: they need a fresh verification. Press **Open in NEBULA to decide** (main bot, when the gateway has an HTTPS address) or decide in Dashboard → Approvals. See [telegram.md](telegram.md#approvals-in-the-chat). |
| Telegram answers "Only the NEBULA owner can decide this." or "You don't have the … permission for this." | Approvals and owner-only commands belong to the designated owner's Telegram account; operators get only their stored permissions. See [telegram.md](telegram.md#who-can-do-what-in-the-chat). |
| An agent cannot reach a device on your network (NAS, router, intranet, package mirror) | The VM's firewall blocks local-network destinations. Allow that address in `/etc/nebula/firewall-lan-allow.nft`, see [configuration.md](configuration.md#vm-network-access). `nebula-egress-drop` lines in the guest's kernel log (`sudo journalctl -k`) show what was dropped. |
| A host command cannot reach `127.0.0.1`, the Mac's LAN or bridge address, or a Unix socket | Expected: host commands never reach the Mac itself (any of its addresses) or its Unix sockets (except name resolution), even with network access on. See [features/host-execution.md](features/host-execution.md). |
| `hardlink_rejected` from a host file tool | The file has more than one hard link, which NEBULA refuses inside authorised folders. Copy it to a normal file. |
| `tool_not_allowed` from a host command | The folder has an `allowed_tools` list and the command names a program that is not on it, or cannot be checked (`sh -c`, `eval`, a script). Run an allowed tool directly or extend the list. |
| Login answers `429` | Too many failed logins: 20 a minute per address, or the account is locked after repeated failures from another device. Logins on the Mac are never locked out; wait a minute. |
| macOS asks whether Python may access a Keychain item | The NEBULA service reads its own secrets. Choose **Always Allow** for the NEBULA runtime. A new runtime interpreter (after an update) can ask again once per item. While such a dialog is open, the service waits. |
| The dashboard does not load after login | `.venv/bin/nebula status`; then check `host.log`. Restart the service (System → Restart services). |
| Telegram is silent | Telegram page shows the last error. `409` means another poller or a webhook uses the token; `401` means the token was revoked. |
| Remote access problems | See [remote-access.md](remote-access.md#troubleshooting). |
| iPhone app problems | See [ios-app.md](ios-app.md#troubleshooting). |

## Low-level helpers

```bash
D="$HOME/Library/Application Support/NEBULA"
"$D/bin/nebula-vm" status --bundle "$D/vm/shared"   # the helper's view of the VM
.venv/bin/nebula vm stop                            # graceful stop; agents' files persist
.venv/bin/nebula vm start
.venv/bin/nebula repair                             # re-apply guest provisioning and verify
scripts/smoke-test.sh                               # HTTP checks against a running instance
```

If none of this helps, open an issue with the doctor output, the diagnostics bundle and what you did. Report security
problems privately instead (see [SECURITY.md](../SECURITY.md)).
