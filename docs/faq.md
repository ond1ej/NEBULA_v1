# FAQ

### Does NEBULA need a Mac mini?
No. It needs an Apple-silicon Mac (M1 or later) with macOS 13 or later. A Mac mini is a good fit because it can stay
on all the time; agents pause while the Mac sleeps.

### Does anything go to a NEBULA cloud?
No. There is no NEBULA cloud service. Your data stays on your Mac. What leaves it is what you connect: requests to the
AI providers you choose, Telegram messages if you set up a bot, and whatever your agents do on the web.

### Can I run it completely offline?
After installation, with a local model in Ollama, agents can work without any cloud AI provider. The first install
needs Internet access to download and verify the Ubuntu image and packages, and agents that browse the web need it
too.

### Which AI models work best?
Large cloud models are much more reliable at multi-step tool use than small local models. A local 7B model works for
simple tasks and is free, but it is slower and fails more often. See [providers.md](providers.md).

### Can I use my Claude or Gemini subscription?
No. NEBULA supports Claude and Gemini only with API keys. It uses consumer subscriptions only where the vendor offers
an official, documented flow for local open-source clients, which today means Sign in with ChatGPT.

### How much RAM do I need?
8 GB is the minimum, 16 GB is recommended. The VM takes 6 GB by default (4 GB is a good value on a 16 GB Mac that also
runs a local model), and each active agent desktop with Chromium needs several hundred megabytes inside the VM.

### How many agents can work at the same time?
Two by default (`agents.default_active_limit`). You can create more; extra tasks queue. The resource profile
(ECO, BALANCED, PERFORMANCE) and the free memory in the VM decide how many desktops run.

### Are agents isolated from my Mac?
Yes by default: they work inside the VM, which has no shared folders and no forwarded ports. If you authorise Mac
folders for host execution, agents assigned to them run commands on the Mac inside a sandbox. Read
[security-model.md](security-model.md) first.

### Are agents isolated from each other?
Each agent is a separate Linux user with its own home, desktop and browser profile. They share one kernel, so treat
all agents in one VM as one trust domain.

### Is it safe to expose NEBULA to the Internet?
Nothing is exposed by default: the dashboard and API listen on `127.0.0.1`. The remote gateway can be published
through Tailscale Funnel or a Cloudflare tunnel, which are meant only for the Telegram Mini App and need an explicit
confirmation. The gateway does not serve the web dashboard, but an authenticated owner session can administer NEBULA
through it, so publishing it makes owner administration reachable from the Internet behind the gateway's
authentication. For your own devices use Tailscale Serve instead; it keeps everything inside your tailnet. See
[remote-access.md](remote-access.md).

### Can agents reach other devices on my network?
Not from the VM: its firewall blocks your LAN, the Mac, Tailscale addresses, link-local and multicast destinations,
while agents keep Internet access. For IPv6 it blocks only local ranges, so if the VM gets IPv6 connectivity, devices
on global IPv6 addresses are not blocked. You can allow single addresses, see
[configuration.md](configuration.md#vm-network-access). Host execution on the Mac is different: with network access
on for a folder, commands still cannot reach the Mac itself, but NEBULA does not block other devices on your network.

### Do I need Tailscale?
Only for remote access. Locally on the Mac, NEBULA needs nothing else. Tailscale is the recommended way to reach it
from your phone; LAN access works at home without it.

### Why is there no App Store version of the iPhone app?
Because the app connects to your own server and is built by you with your own signing. You need Xcode 26 or later and
an Apple ID. The apps are in the [NEBULA-iOS](https://github.com/ond1ej/NEBULA-iOS) repository; see
[ios-app.md](ios-app.md).

### Can agents see my passwords?
Not the ones in the Password Vault: a separate broker in the VM types them, and the agent only receives the signed-in
session. Anything you type into an agent's desktop in Live Desktop, however, is visible to that agent's environment.

### What happens if NEBULA or the Mac restarts during a task?
Tasks resume from their last checkpoint. A side effect that was in progress at the moment of the crash is marked as
unknown and never replayed automatically; the agent is told to look first.

### How do I update?
See [installation.md](installation.md#update). Back up the database first (**System → Backup DB**).

### How do I remove NEBULA completely?
`.venv/bin/nebula uninstall --remove-data --confirm DELETE-ALL-NEBULA-DATA` removes the service, the VM, the database,
the logs and this instance's Keychain items. Without `--remove-data`, uninstall keeps all data. See
[installation.md](installation.md#uninstall).

### Where do I report a security problem?
Privately, through GitHub's private vulnerability reporting. See [SECURITY.md](../SECURITY.md).

### Is NEBULA affiliated with Apple, OpenAI, Anthropic, Google, Telegram, Tailscale or Ollama?
No. NEBULA is an independent open-source project.
