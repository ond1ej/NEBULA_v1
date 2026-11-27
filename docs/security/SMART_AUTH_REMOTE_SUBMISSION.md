# Smart sign-in: remote submission (from the phone)

> **Scope note.** This document records the original design of the remote answer path for sign-in requests, when
> vault management was local-only and the remote PIN was the only extra factor. Since then the owner can also manage
> the vault through the gateway with a fresh verification, and a fresh session (Face ID in a paired app, Telegram's
> biometric confirmation or the NEBULA password) replaces the PIN for remote secret entry; the PIN remains the
> fallback for sessions that are not fresh. The per-route policy table in `apps/host-api/nebula_host/authz.py` is
> authoritative. User guide: [../features/smart-sign-in.md](../features/smart-sign-in.md).

This path answers exactly one pending sign-in request from the phone.

## What the Mini App gateway forwards (and nothing else)

| Method | Path (under `/api/v1`) | Permission | Purpose |
|---|---|---|---|
| GET | `/smart-auth/sessions` | – | list sign-in requests (metadata) |
| GET | `/smart-auth/sessions/as_<24 hex>` | – | one request: verified origin, step, field roles, saved-account names |
| POST | `/smart-auth/sessions/as_<24 hex>/token` | approvals | fresh single-use submission token |
| POST | `/smart-auth/sessions/as_<24 hex>/submit` | approvals | ONE answer to the current request |
| POST | `/smart-auth/sessions/as_<24 hex>/cancel` | approvals | cancel |

Never forwarded: `/smart-auth/settings` and `/smart-auth/pin`. Those, and every vault create, unlock, reveal,
export, import, entry, grant and passphrase route, are refused by the local API for Mini App sessions and proxied
requests anyway. The path normalisation guard from 3.2 also applies: `..`, `//`, encoded separators and dot
segments are refused.

## Controls on a remote submission

1. **HTTPS and Telegram identity.** The request goes through HTTPS (Tailscale Funnel) to the gateway. The gateway
   verifies Telegram `initData` server-side, checks that the account is a paired owner, and issues a short-lived
   Bearer session. There are no cookies, so there is no CSRF surface. The gateway also applies rate limits, Host
   and Origin checks, and strict headers.
2. **Single-use token.** The form asks for a fresh token immediately before every submit. Only the token's SHA-256
   is stored, bound to the currently open request, with a 2-minute validity. It is burned atomically on every
   attempt, whether the attempt succeeds or fails.
3. **Strict body validation.**
   * The body may contain exactly the requested field ids.
   * Values are checked by role rules: OTP length and charset, phone characters, no control characters, length
     limits.
   * Errors never echo values.
   * Request bodies are limited to 256 KB and never logged.
   * Every response is `Cache-Control: no-store`.
4. **Remote sign-in PIN, an extra owner factor that is separate from Telegram.** It is required when, from the
   phone, the owner:
   * types credentials (user name, password, phone number);
   * uses a saved account that this agent has no grant for (a grant must cover every origin of the session);
   * saves to the vault;
   * enters a recovery code;
   * re-sends already-typed values to a form target they just allowed.

   One-time codes and granted saved accounts need no PIN. The first is bound to the request and the token. The
   second is the 3.2 "Approve once" semantics.

   Never allowed remotely, even with the PIN: allowing an agent to use a credential in future (a grant, and switching
   the agent from NONE to SELECTED) and seeing decrypted user names. Both are available only on the Mac. An empty
   PIN is reported as "PIN required" and never counts as a failed attempt.

   The PIN:
   * is set only on the Mac (Password Vault → Settings → Smart sign-in, or `PUT /smart-auth/pin` from loopback);
   * is 6–64 characters, trivial sequences are refused, and changing it needs the current PIN;
   * is stored as Argon2id (64 MiB, t=3);
   * allows 5 free attempts, then a persisted lockout of 5 min that doubles each time up to 1 h. The right PIN does
     not bypass an active lockout.

   It is never the vault passphrase. **Without a configured PIN, remote password entry is disabled.**
5. **Rate limits.** At most 12 submissions per session per 10 minutes, 30 per owner session per minute, and 30
   tokens per minute.
6. **Replay and binding.** A request that was already answered, replaced or expired refuses everything. The
   session's agent, task and origins are fixed on the server side.
7. **Secret-free logging.** No secrets appear in audit rows, events or `auth_events`. Typed values exist only in
   host memory until the broker call returns. Nothing is stored in browser storage, URLs or Telegram messages.

## Turning it off

In Password Vault → Settings → Smart sign-in, turn off "Allow remote submission". Remote sessions can then only
view and cancel requests. Alternatively, remove the PIN; remote password entry is then refused, while codes still
work.
