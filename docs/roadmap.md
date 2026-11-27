# Roadmap

This is a list of directions, not promises. Nothing here has a date. Priorities follow what users report, what makes
NEBULA safer, and what makes the first hour easier. If you want to work on one of these, open an issue first so we can
agree on the approach.

## Security

- **Internet egress control for agents**: per-agent outbound rules or an allowlist proxy in the VM. Local-network
  destinations (your LAN, the Mac, Tailscale, link-local and multicast addresses) are already blocked by the guest
  firewall, with owner exceptions in `/etc/nebula/firewall-lan-allow.nft`; Internet destinations are not filtered
  yet, and for IPv6 only local ranges are blocked (not global addresses of LAN devices).
- **Destination filtering for host commands with network access**: today Unix sockets and every address of the Mac
  itself are denied, and nothing else is.
- **Stronger isolation between agents**: root-owned socket directories for every per-agent channel, and options for
  separate VMs per trust domain.
- **Finer per-user permissions**: editing an operator's permissions in the UI, and per-agent scopes for operators.
- Policy hooks for agent actions that are harder to evade than pattern matching.

## Installation and operations

- Updates from signed release archives (today `nebula update` moves a git checkout to a release tag, with a database
  backup, migration and rollback).
- A signed and notarized Mac app and installer (needs an Apple Developer ID).
- A prebuilt, signed VM image to shorten the first install and make it work offline.
- Live VM snapshots and workspace disk quotas.

## Product

- Verified support for cloud API providers against their live APIs, and more OpenAI-compatible presets.
- Screenshot masking for sensitive workspaces.
- More languages in the dashboard and the apps (English is the default; Czech exists for parts of the UI).
- Better reliability with small local models.

## Not planned

- A hosted or cloud edition of NEBULA.
- Support for Intel Macs, Linux or Windows hosts.
- Using consumer AI subscriptions through anything other than a vendor's official, documented flow.
