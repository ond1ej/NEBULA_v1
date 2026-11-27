# Password Vault: security test evidence

All automated tests use synthetic canaries (`CANARY-PW-…`, `canary-user-…@example.test`); no real credential was
used anywhere. The live VM check uses a random canary per run and a fixture site that only knows its SHA-256.

## Automated (pytest)

| Spec | Test file :: test | What is proven |
|------|-------------------|----------------|
| 20.2.1–3 | `tests/unit/test_vault_crypto.py::test_create_lock_unlock_and_wrong_passphrase` | create, lock, unlock, wrong passphrase 401; DB file + WAL contain neither canary nor passphrase nor username |
| 20.2 | `::test_vault_starts_locked_in_a_new_process_instance` | a new process (= restart/reboot) starts LOCKED |
| 20.2.5–6 | `::test_tampered_ciphertext_and_metadata_are_rejected` | flipped ciphertext bit, moved origin (AAD), tampered wrapped DEK — all rejected |
| 20.2.7 | `::test_nonces_are_unique_per_encryption` | 26 encryptions → 26 distinct 96-bit nonces |
| 20.2.8–10 | `::test_passphrase_rotation` | rotation needs the current passphrase; old one stops working; data intact |
| 20.2.11 | `::test_encrypted_export_import_into_test_vault` | export contains no canary; wrong passphrase / modified header rejected; import into a separate test vault (own DB) with explicit confirmation |
| 20.2.12 | `::test_locked_vault_rejects_secret_operations` | reveal/detail/export/update → `vault_locked`; metadata still listable |
| 20.2.13 | `::test_auto_lock_after_inactivity` | auto-lock after the timeout; only 5/15/30/60 accepted |
| 20.2.14 | `::test_unlock_rate_limit_persists` | lockout after 5 failures, even the correct passphrase refused, survives restart |
| — | `::test_reveal_requires_recent_authentication`, `::test_weak_or_reused_passphrase_rejected`, `::test_lock_clears_key_material`, `::test_canonical_origins`, `::test_kdf_calibration_targets_250_500ms` | re-auth window, passphrase policy (incl. not the login password), key bytes overwritten on lock, exact origin canonicalisation, Argon2id timing |
| 20.3.1 | `tests/security/test_vault_security.py::test_agent_without_grant_has_no_tool_and_direct_calls_are_denied` | tool not offered; guessed ref refused; broker never called |
| 20.3.2 | `::test_selected_grant_with_owner_approval_signs_in_without_exposing_the_secret` | approval preview (agent, credential, origin, action, task, expiry); secret reaches only the broker channel; model result has no secret, no query string; canary absent from DB, WAL, logs, model requests, API responses |
| 20.3.3–9 | `::test_grant_checks_other_agent_expired_revoked_origin_forged_ids` | other agent's grant, forged task id, wrong/lookalike/downgraded origin, unsupported operation, paused agent, expired grant, DB-edited grant (HMAC), forged grant row, locked vault, revoke while locked, credential deletion |
| 20.3.14 | `::test_agent_deletion_revokes_grants` | grants and policy removed with the agent |
| 20.3 | `::test_new_agents_get_no_vault_access_and_auto_policy_is_narrow` | new agent = NONE; no grant without enabling; `auto` only single-origin; only `sign_in`; origin must include the credential's |
| 20.3.10–12 | `::test_owner_denial_and_replayed_approval` | denial respected and final for the task; consumed approval cannot be replayed; approval bound to origin and task |
| 8.3 | `::test_locking_the_vault_expires_pending_approvals` | Lock now expires a pending approval; the agent gets `approval_expired` |
| 11.3 | `::test_once_per_task_and_auto_policies` | one approval per task; `auto` without prompt |
| 23 | `::test_broker_disabled_when_isolation_self_test_fails` | broker refuses to run when the VM self-test fails; status shows the reason |
| 20.5 | `::test_prompt_injection_cannot_extract_redirect_or_escalate` | page text orders reveal/exfiltration/impersonation/approval bypass/memory storage; the (scripted) model obeys; other origin and other agent's grant denied, forged `agent_id` argument ignored, nothing secret anywhere |
| 12 | `::test_login_is_not_a_licence_for_account_takeover_actions` | account-security URLs/buttons always need approval; after a vault sign-in also payments and data export |
| 14/15 | `::test_mini_app_gateway_never_reaches_vault_management` | metadata via gateway has no secrets and `no-store`; 22 management/path-trick requests refused (403/404/405); local API refuses Mini App sessions; lock/revoke work remotely |
| 14 | `::test_local_management_guard_refuses_lan_http_and_proxies` | loopback allowed; LAN http, LAN https (default), tunnel Host, X-Forwarded-For, Tailscale headers, gateway marker refused |
| 20.4 | `::test_no_secret_in_failure_paths_errors_and_validation` | failed login, wrong passphrase, oversized field — no canary in responses, DB, logs, model requests |
| 9.1 | `::test_reveal_is_local_reauthenticated_and_not_cached` | lists/details never contain the password; reveal needs re-auth; `no-store`; login password refused as passphrase |
| 11.3 | `::test_telegram_vault_approval_message_has_metadata_only` | Telegram text shows agent, credential name, origin, action, task, expiry; without a Mini App address the buttons are "Approve once" / "Deny", which only say where to decide (a vault approval is never decided in the chat: `tests/security/test_fixround2_telegram.py`) |
| 11.2 | `::test_canonical_origin_exact_matching_in_api`, `::test_loopback_origins_are_never_granted_to_agents` | insecure/userinfo/javascript origins and off-origin login URLs refused; loopback grants refused |
| 20.6 | `tests/unit/test_vault_guest.py` (7 tests) | guest/host origin canonicalisation agree; guest parameter validation; cookie fields only; the isolated login reports errors by type only (canary never on stdout/stderr); off-origin login URL refused before a browser starts; self-test failure; `browser.import_cookies` accepts cookie fields only |

## Live, on the Mac mini + VM (`scripts/v32_vault_e2e.py`, no AI requests)

| Check | Result |
|-------|--------|
| Guest isolation self-test (`nebula-vault`: nologin shell, not root, private 0700 home, distinct from all agent uids, no shared groups, root-owned script, Chromium, systemd-run) | PASS |
| Isolated sign-in to the fixture site, session cookie handed to the agent's browser (~1.9 s) | PASS |
| Agent's own browser opens the protected page signed in | PASS |
| Password not visible in the agent's browser tool output | PASS |
| Wrong password → `login_failed`, no session | PASS |
| Login page redirecting to another origin → `redirect_blocked` | PASS |
| Form posting the filled credentials to another origin → blocked; the other origin received no request | PASS |
| Canary absent from the agent's home (Chromium profile included), `/tmp`, `/dev/shm` | PASS |
| Agent cannot read `/var/lib/nebula-vault` | PASS |

Result file: `build/e2e/v32-vault.json` (9 PASS / 0 FAIL).

## Not tested live (and why)

* A real AI model using `vault_sign_in` end to end: needs the owner's own vault (NEBULA never creates or unlocks the
  owner's vault) — **BLOCKED (owner action)**. The full host path is covered by the scripted-model tests above and
  the VM path by the live check.
* Real third-party sites with MFA/CAPTCHA: not automated by design (`needs_owner`).
