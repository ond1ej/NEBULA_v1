# Release test results: NEBULA 1.0.0

What was run before the first public release, and what each run showed. Every row was observed; nothing is
assumed. `BLOCKED` means the test needs something the release machine could not provide, and the row says what.

**Machine:** Mac mini with Apple silicon, 16 GB RAM, macOS 27.0.1, Xcode 27.2. Another NEBULA install, an Android
emulator and other apps were running on the same Mac, so memory was tight (see the note on local models below).
**Instance:** a separate instance (`--instance demo`) with its own data directory, Keychain service, VM, ports and
synthetic data. **Date:** 2026-11-27.

## Automated suites

| Suite | Result |
|---|---|
| Python (`pytest`, unit, integration, security) | PASS: 1040 passed |
| Dashboard (`vitest`) | PASS: 540 passed; `tsc` type check passes |
| Lint (`ruff`, `bash -n` on every shell script) | PASS |
| Secret scan (`gitleaks`, working tree) | PASS: no leaks |
| Swift VM helper (`swift build`) | PASS (built by the installer) |
| iPhone and Mac apps | See the [NEBULA-iOS](https://github.com/ond1ej/NEBULA-iOS) repository: 149 Swift tests, iOS and Mac builds, and the UI tests below |

## Installation and lifecycle (real VM)

| Test | Result |
|---|---|
| Clean install, first attempt | FAIL, then fixed: the new guest firewall dropped the replies of the SSH session that provisions the VM, and the installer waited forever. Fixed by allowing sshd's replies to the Mac and adding SSH keepalives; a regression test covers it |
| Clean install from a fresh clone (`./install.sh --instance demo`) | PASS in 140 s: pinned Ubuntu 24.04 image downloaded and verified (SHA-256, signed manifest, Ubuntu's GPG key), VM booted, desktop, browser and guest service provisioned, health check (guest RPC about 2.5 ms, X server, screenshot) |
| Failed install | PASS: clear message naming the failed step, a report file, data kept |
| `nebula health`, `status`, `doctor`, `diagnostics` | PASS. The diagnostics bundle passes gitleaks and does not contain the setup token |
| `nebula autostart enable`, `restart`, `autostart disable` | PASS: LaunchAgent installed, restarted with a new process, removed again; the Mac's other NEBULA install kept running untouched |
| `./update.sh` to a newer commit | PASS in 20 s: database backup, build, deploy, previous runtime kept for rollback, agents kept |
| `./uninstall.sh` (keep data) | PASS: VM stopped, data kept |
| `./uninstall.sh --remove-data` | PASS: data directory and the instance's 16 Keychain items removed; the other install unchanged |
| `./install.sh --check` | PASS (four fresh home directories, nothing written) |

## First run and features (dashboard, real VM)

| Test | Result |
|---|---|
| First run: setup link, administrator account | PASS. The one-time setup token is deleted after use |
| Connect Ollama | PASS |
| Create three agents (own Linux user, desktop and browser each) | PASS |
| Agent tasks with a local model (`qwen2.5:3b`) | PASS for two multi-step browsing tasks where every step succeeded. Other runs FAILED because the small model sent empty tool arguments or claimed files it never wrote; NEBULA's result check marked those runs failed, which is the intended behaviour |
| Stop a task | PASS |
| Approval: the agent asks, the owner approves in the dashboard, the task continues | PASS |
| Live Desktop: connect, Take Control, release when the viewer leaves | PASS |
| Memory guard: refuses to load a model that does not fit; queues new work under memory pressure | PASS (observed on this Mac) |
| Guest firewall, from an agent's account | PASS: `https://example.com` 200; the Mac (`192.168.64.1`), `192.168.1.1`, `10.0.0.1`, `100.100.100.100` (Tailscale) and `169.254.169.254` time out |
| Agent isolation in the VM | PASS: an agent cannot list another agent's home directory; agent services run with `NoNewPrivileges`, `ProtectSystem`, memory and task limits |

**Note on local models:** on this 16 GB Mac, with another VM and an Android emulator running, NEBULA's memory guard
correctly refused to load a 7B model. A 3B model fits but is weak at tool use. On a Mac with free memory, use a 7B or
larger tool-capable model, or an API provider.

## Native apps (simulator)

| Test | Result |
|---|---|
| iPhone app UI test against the isolated test server (`scripts/test_instance.py`): pairing with Face ID, streamed chat, vault (first activation, Face ID unlock, reveal), Live Desktop take and give back control, settings | PASS (iPhone 17 simulator, 66 s) |
| iPhone app: an invalid pairing code is refused | PASS |
| iPhone app paired with the real demo instance through its gateway on loopback: owner approval of the device, chats, a conversation, Activity, Agents, an agent's Live Desktop | PASS (these are the README screenshots) |

## Blocked

| Test | Why |
|---|---|
| Tailscale Serve and Funnel end to end | BLOCKED: running them on the release machine would change its owner's tailnet. The scripts and docs were checked, and the gateway was tested on loopback |
| Telegram bots and the Mini App with real Telegram | BLOCKED: needs a bot token and Telegram accounts. Covered by integration tests with a fake Bot API |
| OpenAI, Anthropic and Gemini API keys; Sign in with ChatGPT | BLOCKED: needs your own keys or account. Covered by adapter tests with recorded responses |
| Apps on a physical iPhone or Mac with your own signing | BLOCKED: needs an Apple developer team. Simulator and unsigned builds pass |
