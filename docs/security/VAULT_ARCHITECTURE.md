# Password Vault: architecture

> **Scope note.** This document records the original design of the vault, when management was possible only on the
> Mac. Since then the owner can also manage the vault through the remote gateway with a fresh verification (`admin!`
> routes) and, for plaintext, the vault passphrase or a device-bound confirmation from a paired app. The per-route
> policy table in `apps/host-api/nebula_host/authz.py` is authoritative. User guide:
> [../features/password-vault.md](../features/password-vault.md).

Status: implemented and tested; a new install starts with no vault. The vault is created only by the owner.
Agent credential use is implemented; it works only after the owner creates the vault, unlocks it and grants a
specific credential to a specific agent (deny by default).

Code: `apps/host-api/nebula_host/vault.py` (crypto, storage, lifecycle, grants, authorisation),
`apps/host-api/nebula_host/vault_broker.py` (credential-use broker), `apps/host-api/nebula_host/api/routes_v32.py`
(API), `guest/guest-service/nebula_guest/vaultops.py` + `vault_login.py` (isolated login in the VM),
`guest/guest-service/nebula_guest/agent_tools.py` (`browser.import_cookies`), migration `0006_v32.py`.

## 1. Components

```
 Owner on this Mac (http://127.0.0.1:3100)            Owner's phone (Telegram Mini App via the gateway :3102)
   create / unlock / add / edit / reveal /               status, credential names, grants, audit,
   grants / rotate / export / import                     Lock now, Revoke grant   (no unlock, no secrets)
             |                                                     |
             v                                                     v
 +---------------------------- NEBULA host service (macOS user) ----------------------------+
 |  routes_v32  --local-only guard-->  Vault (vault.py)                                       |
 |                                     KEK = Argon2id(passphrase, salt) -> unwraps DEK          |
 |                                     DEK only in process memory while UNLOCKED               |
 |  Orchestrator / TaskRunner  --vault_sign_in tool-->  vault_broker.py                       |
 |                                     authorise (agent+task from context, HMAC'd grant,       |
 |                                     origin, expiry) -> owner approval (single use) ->        |
 |                                     decrypt -> guest RPC                                    |
 +------------------------------------------------|-----------------------------------------+
                                                  | HMAC-authenticated RPC over virtio-vsock
                                                  v (local IPC, never a network)
 +---------------------------------- Ubuntu VM ------------------------------------------------+
 |  nebula-guest (root) vaultops.sign_in --stdin--> systemd-run --uid=nebula-vault (sandbox)   |
 |                                                   vault_login.py: headless Chromium, empty  |
 |                                                   temp profile, exact-origin checks, submit |
 |                       <-- session cookies only ---                                          |
 |  -> agent tool server (agent's Linux user): browser.import_cookies -> agent's own browser   |
 +----------------------------------------------------------------------------------------------+
```

Why a separate Linux user: in the VM, an agent's browser, shell, Python/Node tools and tool server all run as the
same unprivileged account. A password typed into that browser (or sent to that tool server) would be readable by the
agent through the DOM, its own socket, the profile on disk or process memory. The broker therefore types the
password only into a browser owned by `nebula-vault` — a system account that is not an agent, has no login shell,
no supplementary groups and a private (0700) home — and hands over only the resulting session cookies.

## 2. Cryptography

| Item | Choice |
|------|--------|
| Libraries | `cryptography` (AES-GCM, OpenSSL), `argon2-cffi` (Argon2id). No custom primitives. |
| KEK | Argon2id(passphrase NFKC/UTF-8, 16-byte random salt), 32 bytes. Parameters calibrated at creation/rotation on this Mac: **128 MiB, parallelism 2, time cost ≈ 13 → ≈ 340 ms** (target 250–500 ms). Stored with the vault (`vault_metadata.kdf`). |
| DEK | 32 random bytes (`os.urandom`), created once; stored only wrapped: `nonce(12) ‖ AES-256-GCM(KEK, DEK, AAD="nebula-vault/dek/v1/<vault_id>")`. |
| Records | `AES-256-GCM(DEK, JSON{username, password, notes, login_url}, AAD)` with a fresh random 96-bit nonce per encryption (every add/update). AAD = canonical JSON of `{version, vault id, entry id, record version, type, origin, display name, app name, tags}` — editing any of these columns in the database makes decryption fail (`integrity_error`). |
| Grants / policies | `HMAC-SHA256(K_mac, canonical grant)`, `K_mac = HMAC-SHA256(DEK, "nebula-vault/mac/v1")`. Rows created or edited outside NEBULA (or while locked) never authorise anything. |
| Export | Separate export passphrase → Argon2id (own salt/params) → AES-256-GCM over all entries, header (format, version, KDF, entry count) as AAD. Integrity is validated on import; wrong passphrase or any modification is rejected. |
| Random | `os.urandom` for salts, keys and nonces. |

The vault passphrase is never stored. Keys are never derived from Telegram ids, bot tokens, the NEBULA login
password (creating a vault with the login password is refused) or device identifiers.

## 3. Lifecycle

* **LOCKED** after service start / Mac reboot (keys exist only in process memory), after `Lock now` (dashboard or
  Mini App), after the inactivity timeout (5/15/30/60 min, default 15; checked on every access and every 15 s), and
  when the service stops.
* **Unlock** needs the vault passphrase on the local management interface. Failed attempts are counted in the
  database: after 5 failures a lockout starts (60 s, doubling, max 1 h) and survives restarts.
* **On lock**: key bytearrays are overwritten (best effort — Python and the OS cannot guarantee zeroisation of every
  copy), pending credential-use approvals are expired, new secret operations are refused (`vault_locked`, HTTP 423).
* **Re-authentication**: revealing a value or exporting needs a vault authentication in the last 5 minutes
  (`POST /vault/reauth`).
* **Rotation**: `POST /vault/passphrase` verifies the current passphrase, recalibrates Argon2id with a new salt and
  re-wraps the same DEK. Records are untouched; the old passphrase stops working immediately.

## 4. Storage (migration 0006, additive)

`vault_metadata` (KDF, wrapped DEK, auto-lock, failed attempts, lockout), `vault_entries` (list metadata:
display name, app name, canonical origin, type, tags; ciphertext; nonce; record version; tombstone `deleted_at` —
the ciphertext is destroyed on delete), `vault_agent_policies` (mode, managed tags, HMAC),
`vault_agent_grants` (entry, agent, actions, origins, approval policy, enabled, expiry, HMAC, last use),
`vault_access_audit` (redacted log), `approvals.consumed_at` (single-use approvals). Foreign keys cascade: deleting
an agent or a credential removes its grants. No column ever holds a plaintext secret (verified by scanning the
database file and WAL for canaries in the tests).

## 5. API surface

| Class | Endpoints | Where |
|-------|-----------|-------|
| Metadata | `GET /vault/status`, `/vault/entries`, `/vault/grants`, `/vault/audit`, `/agents/{id}/vault` | dashboard + Mini App gateway |
| Protective | `POST /vault/lock`, `POST /vault/grants/{id}/revoke` | dashboard + Mini App gateway |
| Management | `POST /vault`, `/vault/unlock`, `/vault/reauth`, `/vault/passphrase`, `/vault/export`, `/vault/import`, `PUT /vault/settings`, `GET/PATCH/DELETE /vault/entries/{id}`, `POST /vault/entries`, `POST /vault/entries/{id}/reveal`, `PUT /agents/{id}/vault`, `POST /agents/{id}/vault/grants`, `PATCH/DELETE /vault/grants/{id}` | **this Mac only** |

"This Mac only" = owner session (cookie + CSRF), loopback client and loopback `Host`, no Mini App session, and no
forwarding headers (`X-Forwarded-For`, `Forwarded`, `Tailscale-User-*`, `X-Nebula-Gateway`, …). LAN management over
the NEBULA HTTPS listener is possible only if the owner enables it locally (off by default; plain-HTTP LAN is never
accepted). The Mini App gateway's allow-list contains only the metadata and protective routes and rejects any path
with `..`, `//`, dot segments, a trailing slash or characters outside `[A-Za-z0-9_-./]` before matching.
All vault responses: `Cache-Control: no-store`; bodies ≤ 256 KB (imports ≤ 8 MB); validation errors never echo
input; request bodies are never logged.

## 6. Credential use by agents (broker)

1. The model sees a `vault_sign_in(credential, origin)` tool **only** if the agent has an enabled grant
   (`SELECTED`) or a managed collection (`MANAGED`), and only for agents working in the VM. The tool description
   lists opaque references (`vg_…`) with the owner's display names and allowed origins — never usernames or secrets.
2. `VAULT.authorize` takes the agent and task from the runner (never from model output) and checks: vault exists
   and is unlocked; agent exists and is not paused/disabled/deleting; the task belongs to this agent and is running;
   the agent policy HMAC; the grant belongs to this agent, its HMAC, enabled, not expired, action allowed; the
   requested origin canonicalises to exactly an allowed origin (scheme, host, effective port — no substring, no
   subdomain, no http↔https); loopback origins are never usable; the entry still exists and decrypts with intact AAD.
3. Approval (policy per grant): **Always ask** (default) — a task approval with agent, credential name,
   destination origin, action, task, expiry (10 min), shown in the dashboard, Mini App and the owner's Telegram chat
   ("✅ Approve once / ⛔ Deny"; decided in the dashboard, the app or the main bot's Mini App, remotely only with a
   fresh verification, never by a Telegram chat button); **Ask once per task** — one approval covers later sign-ins
   of the same grant/origin in the same task while the vault stays unlocked; **Automatic** — only for one origin and
   `sign_in`. Approvals are single use: consumed atomically and only if bound to exactly this agent, task, credential, origin
   and operation. A denial in a task is final for that task (no re-asking). Locking the vault expires pending ones.
4. Re-authorisation after the approval wait (lock, revocation, expiry, task state may have changed), decryption,
   then the guest RPC `vault.sign_in` with the credential in the RPC body; the host drops its references after the
   call.
5. In the VM, `vaultops.sign_in` (root) validates the parameters, re-runs the isolation self-test and starts
   `vault_login.py` with `systemd-run --uid=nebula-vault --pipe` (PrivateTmp, ProtectHome, ProtectSystem=strict,
   NoNewPrivileges, MemoryMax 1.2 GB, RuntimeMaxSec, LimitCORE=0, ProtectProc=invisible, PrivateIPC, UMask 077),
   passing the credential on **stdin only** (never argv, environment, files or logs; stderr is discarded).
6. `vault_login.py` (run with `python -I`, no NEBULA imports): headless Chromium (Chromium sandbox on) with an
   empty temporary context, no extensions/sync/password saving, service workers blocked; loads the login URL (must
   be on an allowed origin), aborts any top-level navigation to a non-allowed origin, fills the form only on an
   allowed origin, blocks every non-GET request to a non-allowed origin while the form is filled, submits, then
   classifies: `signed_in`, `login_failed`, `needs_owner` (MFA/CAPTCHA), `no_session`, `redirect_blocked`,
   `no_login_form`, `timeout`, `error` (errors by type only). No screenshots are taken.
7. Only the cookies applying to the allowed origins go to the agent's own browser (`browser.import_cookies`). The
   model receives `{status, origin, page (no query/fragment), cookies_imported}`.
8. Audit: `vault_access_audit` row + `vault.access` event (operation, outcome, reason code, origin, ids — never a
   secret); the grant's `last_used_at`.

After a vault sign-in the task is marked as a vault session: payments, outbound messages, external sharing,
credential entry, data export, mass deletion and account-security actions (password/MFA/recovery changes, account
deletion) need the owner's approval even if global approvals are relaxed. Account-security actions always need it.

## 7. Backups and recovery

* Encrypted export (`POST /vault/export`, recent re-authentication, separate export passphrase ≥ 12 characters) →
  versioned JSON (`nebula-vault-export` v1). Import validates format, version, integrity and entry count, needs the
  vault unlocked, a recent re-authentication and `confirm=true`, and re-encrypts entries under the target vault's
  DEK (grants are not exported: they reference local agents).
* General NEBULA backups (the SQLite file) contain only ciphertext and the wrapped DEK.
* **There is no recovery without the passphrase.** No hidden recovery key, escrow or backdoor exists. A lost vault
  passphrase means the vault cannot be decrypted; an encrypted export can be imported only with its export
  passphrase.

## 8. Schema

The vault tables were added by migration 0006 and are additive. Downgrading the schema below 0006 drops them: export the
vault first if it holds anything.
