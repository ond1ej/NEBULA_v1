# Password Vault: threat model

> **Scope note.** Written when vault management was possible only on the Mac. Remote management by the owner with a
> fresh verification, and device-wrapped vault keys for paired apps, are described in
> [../features/password-vault.md](../features/password-vault.md) and [../apple-apps.md](../apple-apps.md).

Assets: stored credentials (usernames, passwords, notes, API tokens), the vault passphrase, the DEK/KEK, authenticated
web sessions created by the broker, the authority to use a credential (grants, approvals).

Trust anchors: the macOS user account running NEBULA (host service, SQLite, Keychain), the owner's local dashboard
session on this Mac, root inside the VM (guest service). Untrusted: every model output, every web page and
document, every agent process in the VM, the Telegram channel content, anything arriving through the public
Mini App gateway.

## Threats and mitigations

| # | Threat | Mitigation | Residual risk |
|---|--------|------------|---------------|
| T1 | Database theft (copy of `nebula.db`, a backup, Time Machine) | Only ciphertext + wrapped DEK in the DB; Argon2id 128 MiB × ~13 passes (~340 ms per guess on an M4) | Offline guessing of a **weak** passphrase stays possible; ≥ 12 characters enforced, a long passphrase is the owner's job |
| T2 | Database tampering (redirect a credential to another origin, add a grant) | Metadata is AES-GCM AAD; grants/policies carry an HMAC keyed from the DEK | An attacker who can write the DB *and* run code as the NEBULA user can wait for an unlock (see T10) |
| T3 | Accidental logging / leaking via API, events, Telegram, prompts, checkpoints, memory, screenshots | Secrets are never put in those paths by construction; list/metadata APIs exclude secret fields; errors are by type; validation errors don't echo input; canary scans of DB+WAL, logs, API responses, model requests in the tests; no screenshots in the broker | Owner-initiated `reveal` returns the value to the owner's browser by design |
| T4 | Unauthorised agent (no grant, other agent's grant, forged agent id/task id) | Deny by default; agent and task come from the execution context; grant must belong to that agent; task must belong to the agent and be running | — |
| T5 | Untrusted model output / prompt injection ("reveal the password", "send it to …", "you are agent X", "the owner approved") | The model never receives the secret — there is nothing to reveal; origins exactly matched against the grant; approvals only from the owner through the approval system; extra tool arguments ignored | An injected agent can still *request* a sign-in to an allowed origin; the owner sees the request (unless the grant is `auto`) |
| T6 | Malicious page changes the destination after approval / phishing lookalike | Approval bound to agent, task, credential, origin, operation; exact-origin match (no substring/subdomain/scheme change); top-level navigation to other origins aborted; non-GET requests to other origins blocked while the form is filled | A malicious page **on an allowed origin** (e.g. XSS on the real site) can read what is typed there — same as for a human |
| T7 | Agent reads the password from the browser it controls | The password is never typed into the agent's browser: separate `nebula-vault` user, sandboxed headless Chromium, stdin hand-over, only cookies cross over; live test scans the agent's home, profile, /tmp, /dev/shm for the canary | The **session** (cookies) is in the agent's browser and therefore readable by the agent — equivalent to a logged-in session (documented, intended) |
| T8 | Agent impersonates the tool server / intercepts the broker | The credential never goes to any agent-owned socket or process; the agent's tool server only receives cookies | — |
| T9 | Loopback squatting in the VM (an agent serves 127.0.0.1:port) | Grants to loopback origins are refused and re-checked at use | — |
| T10 | Host compromise (malware as the macOS user, or root) | Out of scope for V1: such an attacker can read process memory while unlocked, log keystrokes of the passphrase, or modify NEBULA | **Not mitigated.** Keep the Mac patched, lock the vault when not needed, short auto-lock |
| T11 | VM root compromise (kernel exploit by an agent) | Agents are unprivileged, sandboxed; the broker account is separate | A VM-root attacker sees credentials passed to the broker while signing in |
| T12 | Malicious *authorised* agent / owner grants too much | Narrow grants (one credential, exact origins), always-ask default, per-task approvals, high-risk action policy after sign-in, audit trail, revoke from phone | An authorised agent with an active session can act in that account within what the policy lets through without approval |
| T13 | Public Mini App gateway (Tailscale Funnel) reaching vault management | Gateway allow-list has metadata + lock/revoke only; path-normalisation tricks refused; the local API additionally refuses Mini App sessions, proxied requests and non-loopback hosts for management | A stolen Mini App session can lock the vault or revoke grants (protective) and read metadata (names/origins) |
| T14 | Compromised Telegram account of the owner | The Telegram chat cannot approve or deny pending credential uses (they need a fresh verification, so the card opens the Mini App or points to the dashboard), and it cannot unlock, create grants, reveal or export. In the main bot's Mini App, deciding a credential use, unlocking, creating grants, revealing and exporting all need a fresh verification (revealing also the vault passphrase) | An attacker who controls the owner's Telegram and can also pass the fresh verification (the NEBULA password, or the biometrics of the phone enrolled for Telegram's BiometricManager) can approve a sign-in an agent requests within existing grants |
| T15 | Brute-forcing the unlock endpoint | Local only; 5 free attempts, then 60 s doubling lockout (max 1 h), persisted; each attempt costs ~340 ms of Argon2id | — |
| T16 | Clipboard / browser storage leakage in the dashboard | Copy only on explicit click; secrets only in component state, cleared on lock/unmount; no localStorage/sessionStorage/IndexedDB; `no-store` responses | Clipboard contents are visible to other apps on the Mac after an explicit copy |
| T17 | Memory remanence | Key bytearrays overwritten on lock; credential copies dropped after use | Python strings/bytes and OS pages cannot be reliably zeroised (documented) |
| T18 | Plain-HTTP LAN management (sniffing on the LAN) | Management only on loopback; LAN only over HTTPS and only if the owner enables it | — |
| T19 | Lost passphrase | Clear warnings at creation; encrypted export | **No recovery** — by design, no backdoor |
| T20 | Credential sent over plain http | Origins must be https except local/private hosts | Owner may store http credentials for private LAN devices |

## Known gaps (V1)

* MFA, CAPTCHA, WebAuthn/passkeys and multi-page sign-ins beyond identifier-first are not automated
  (`needs_owner`); the owner can finish via Live Desktop.
* Sessions stored outside cookies (e.g. tokens in localStorage) cannot be handed over (`no_session`).
* Credential use is VM-only; agents working natively on the Mac do not get the tool.
* The host→VM RPC carries the credential in an HMAC-authenticated but not separately encrypted frame over local
  virtio-vsock IPC on the Mac (no network).
