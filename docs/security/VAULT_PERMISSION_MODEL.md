# Password Vault: per-agent permission model

Deny by default. Every new agent starts with **NONE**. Nothing is inherited, copied or granted automatically
(there is no clone path that copies grants; grants live in their own table and are deleted with the agent).

## Agent modes (`PUT /agents/{id}/vault`, local only, vault unlocked)

| Mode | Meaning |
|------|---------|
| `NONE` (default) | No credential use. The `vault_sign_in` tool is not offered; direct calls are refused (`no_access`). Setting NONE disables all of the agent's grants (works while locked). |
| `SELECTED` (recommended) | The agent may *request* use of credentials that have an individual grant for it. |
| `MANAGED` | The agent may request credentials tagged with one of the owner-chosen collection tags, each only for that credential's own origin, `sign_in` only, and **always with an approval**. Still never "all secrets". |

## Grants (`POST /agents/{id}/vault/grants`, local only, vault unlocked)

| Field | Rules |
|-------|-------|
| credential | one vault entry of type `website` (application credentials and API tokens are stored but never usable by agents in V1) |
| `allowed_origins` | canonical `scheme://host[:port]`; defaults to the credential's origin; must include it; extra origins only when the owner adds them; loopback origins refused |
| `allowed_actions` | `["sign_in"]` (the only V1 action; no export, password change, recovery or MFA operations exist for agents) |
| `approval_policy` | `always_ask` (default) · `once_per_task` · `auto` (only for exactly one origin and `sign_in`) |
| `expires_at` | optional; expired grants are refused |
| `enabled` | revoke = disable (works while locked, also from the Mini App) |

Every grant and policy row carries an HMAC made with a key derived from the vault key. A row that was not written by
NEBULA while unlocked — or was edited later — authorises nothing (`grant_invalid`).

## Enforcement points (all server-side)

1. Tool exposure: `vault_broker.tool_for` (only with a usable grant, only in the VM).
2. `VAULT.authorize` (identity, task, policy HMAC, grant HMAC, enabled, expiry, action, exact origin, loopback,
   entry integrity) — before the approval **and again after it**.
3. Approval binding and single use (`consume_approval`), no re-asking after a denial in the same task.
4. The isolated login's own origin checks in the VM (login page, navigations, non-GET requests while filled).
5. The action-risk policy for the rest of the task.

Reason codes returned to the agent and written to the audit log: `no_vault`, `vault_locked`, `agent_disabled`,
`task_mismatch`, `no_access`, `no_grant`, `grant_invalid`, `grant_revoked`, `grant_expired`, `operation_not_allowed`,
`origin_not_allowed`, `invalid_origin`, `loopback_origin`, `entry_deleted`, `not_injectable`, `broker_disabled`,
`broker_unavailable`, `unsupported_environment`, `owner_denied`, `owner_denied_earlier`, `approval_expired`,
`approval_invalid`, `binding_changed`.

## Examples

**GitHub for the "Developer" agent, always ask**
1. Dashboard → Password Vault → unlock → add credential *GitHub (work)*, origin `https://github.com`, login URL
   `https://github.com/login`.
2. Agents → Developer → Security → Password Vault → mode *Selected* → *Add grant* → GitHub (work), origins
   `https://github.com`, policy *Always ask*.
3. Task: "Open my GitHub notifications". The agent calls `vault_sign_in(credential="vg_…", origin="https://github.com")`;
   you get "🔐 Password Vault — approval needed … Approve once / Deny" in the dashboard and the main bot's Mini App
   (remotely with a fresh verification); the Telegram message cannot decide it and opens the Mini App or points to the
   dashboard. After approval NEBULA signs in separately and the agent continues in its browser with the session.

**A site whose sign-in lives on another origin** (e.g. `https://app.example.com` → `https://login.example.com`):
add both origins to the grant explicitly. Without that, the broker reports `redirect_blocked`.

**Nightly automation with Ask once per task**: one approval per scheduled run, then repeated sign-ins of the same
credential in that run proceed. Use `auto` only for a low-risk, single-origin credential you are comfortable having
used without a prompt — even then every use is audited and high-risk actions still need you.

**Emergency**: Mini App → Settings → Password Vault → *Lock now* (expires pending approvals, stops all use), or
*Revoke* on a grant.
