# Smart sign-in: threat model

> **Scope note.** Written for the first version of Smart sign-in. Later changes are described in
> [../features/smart-sign-in.md](../features/smart-sign-in.md): destination trust levels (verified, review, blocked),
> evidence-based success detection, and a fresh owner verification that replaces the remote PIN when available.

Assets: website passwords, one-time codes, recovery codes, the owner's remote PIN, submission tokens, session
cookies, the vault's contents, and the owner's attention (approval fatigue / phishing).

| # | Threat | Mitigation | Verified by |
|---|---|---|---|
| T1 | A prompt-injected agent asks for the password, or makes the owner type it into chat | The agent has no way to receive values; the tool description forbids asking; the owner UI never accepts secrets in chat; Telegram messages contain no input fields | `test_detect_pause_owner_submit…`, `test_telegram_notification_has_button_but_no_secret_field` |
| T2 | A malicious page impersonates a trusted login (lookalike brand, other site) | The verified origin is shown prominently; page titles/labels are never trusted text; brand-on-wrong-domain, other-site, cross-site form action and third-party frame → LOW + mandatory review | `test_14_lookalike…`, `test_15_cross_origin…`, VM test H |
| T3 | Redirect to an unapproved origin during sign-in | Main-frame navigation outside the allowed origins is aborted in the broker; the owner must explicitly allow the destination (LOW/MEDIUM review) | `test_destination_review_redirect_to_other_site`, VM test G |
| T4 | A form (or script) sends typed values to another origin | While values are in the page: non-GET requests to other origins are blocked, and any request to another origin whose URL/body contains a value is blocked; the owner must allow the form target (remotely with the PIN) before the same values are sent again once | `test_unapproved_origin_change_and_blocked_form_target_need_owner`, `test_egress_filter…`, VM test X |
| T5 | The agent reads the secret from its own environment | Typing happens only in the `nebula-vault` user's headless browser; the agent receives cookies only; the agent cannot read the broker's home; canary scan of the agent's home/profile//tmp//dev/shm | VM checks (canary scan, permission denied) |
| T6 | Agent-generated form schema escalates (asks for card numbers, SSN) | The form is built from the broker's own detection, validated by the host (role whitelist, field-id pattern, page on an allowed origin); model arguments other than `url` are ignored | `test_model_generated_schema_cannot_escalate` |
| T7 | One agent consumes another agent's session | Agent identity comes from the execution context; guest sessions are bound to the agent id and refuse other agents; cookies go only to that agent's browser | `test_concurrent_sessions_are_isolated_per_agent`, `test_step_values_are_validated_cleared_and_bound_to_the_agent` |
| T8 | Replay / forged submissions | Server-generated opaque ids; a fresh single-use token for every submit (sha256 stored, burned atomically on every attempt, 2 min validity, bound to the open request); answered/superseded requests refuse | `test_duplicate_and_replayed_submissions_are_rejected`, `test_forged_sessions…` |
| T9 | A compromised Telegram account submits credentials remotely | Remote secret entry (typed credentials, ungranted saved accounts, saving, future grants, recovery codes, re-sending values to a new form target) needs the owner's PIN, which is set only on the Mac, stored as Argon2id and locked out after 5 failures (persisted, doubling, max 1 h); a stolen Telegram session can still answer a one-time code or approve a *granted* saved account (as in 3.2), but cannot unlock, reveal, export or manage the vault | `test_remote_submission_needs_pin…`, `test_pin_lockout_is_persisted`, `test_saved_credential_remote_rules` |
| T10 | Public exposure of vault management | Gateway allow-list adds only session read/token/submit/cancel; settings, PIN and all vault management stay local-only (loopback, no proxy headers, no Mini App session) | `test_remote_submission…` (route list) |
| T11 | Secrets leak into logs, DB, events, prompts, memory, checkpoints, screenshots | No secret columns; request bodies never logged; validation errors never echo values; events carry whitelisted metadata; the tool result is sanitized; values cleared from dicts after use; the broker takes no screenshots; checkpoints store only the URL path | `test_no_secret_anywhere…`, `test_no_secret_on_failure_paths…`, `test_sse_and_event_payloads…` |
| T12 | One-time codes persisted | Codes go straight to the broker; never in DB/vault/memory/history/checkpoints; a code not delivered within its validity is dropped; codes are never re-sent automatically | `test_expired_otp_submission_is_discarded`, `test_incorrect_otp_retry_and_never_resubmitted` |
| T13 | Account lockout through repeated attempts | Max 3 credential and 3 code attempts per session, max 2 automatic retries only for transient broker errors (never with a value), no brute force | `test_failed_login_allows_safe_retry_then_stops_before_lockout` |
| T14 | Login authorises unrelated risky actions | `vault_session` policy keeps payments, password/MFA changes, account deletion and exports behind approval after a smart sign-in too | `test_high_risk_actions_after_smart_sign_in_still_need_approval` |
| T15 | CAPTCHA / MFA bypass | Not attempted: CAPTCHA, passkeys and embedded logins are handed to the owner (Live Desktop); device approval is waited for, never assumed | `test_manual_handoff…`, `test_device_approval…`, VM device/CAPTCHA tests |
| T16 | Restart leaves secrets or stuck tasks | Secrets are memory-only; restart expires open sessions; the broker sweep closes leftover processes; expiry releases paused tasks | `test_restart_invalidates_open_sessions…`, `test_expiration_releases_task_and_broker` |
| T18 | A saved credential is typed on another origin after an SSO hop, or an identity provider's session leaks to the agent | Saved values are filled only when the page's verified origin equals the entry's origin. Only the requested site's cookies are exported. A password typed on another site cannot be saved for the requested site | `test_saved_account_is_never_typed_on_another_origin` |
| T19 | An error or "account locked" page is taken for a successful sign-in, or a wrong password is saved | Success needs positive evidence; otherwise the result is `unconfirmed`, checked by the owner, and nothing is saved | `test_unconfirmed_result_goes_to_owner_and_is_never_saved` |
| T20 | An agent serves its own fake sign-in page on a VM or LAN address | IP literals and local/special-use names are refused unless the owner allowed them on the Mac; even then the request is MEDIUM and needs review | `test_local_network_origins_refused_by_default…` |
| T21 | A remote session reads vault user names or grants future access | Remote: names only, no decrypted user names; future grants and agent-mode changes only on the Mac; an empty PIN never counts as a failed attempt | `test_remote_sees_no_usernames…` |
| T22 | The owner types a secret into the agent's own browser in Live Desktop | Embedded logins and password-creation forms are not handed off; only CAPTCHA, passkey and unconfirmed results are | `test_credential_bearing_manual_steps_are_not_handed_off` |
| T17 | Swapping the detector to change the broker's behaviour | The broker loads `auth_detect.py` only if the file and its directory are root-owned and not group/world-writable | `test_broker_process_refuses_an_untrusted_detector_file` |

## Residual risks (accepted, documented)

* **Egress guard is defence in depth.** It cannot stop a page from encoding a value in a way it does not check,
  for example through custom JavaScript transforms. The isolation is the actual guarantee: the browser runs as a
  separate user, only cookies leave it, and only for the requested site.
* **Session cookies.** After a sign-in, the agent's browser holds the session. Like any signed-in browser, that
  agent can use the account within the session's rights. Credential secrecy is not account security.
* **Live Desktop.** Anything the owner types in Live Desktop (manual steps) is visible to the agent's environment.
  The UI warns about this.
* **Compromised host.** Malware running as the macOS user or as root while values are in memory defeats the design,
  and Python cannot guarantee that memory is wiped.
* **Compromised Telegram account.** The owner's account can answer one-time codes and approve granted saved accounts
  (see T9); other accounts never receive sign-in requests and cannot answer them. Set a strong PIN, and revoke grants
  you do not need.
* **Weak detection.** Unusual or obfuscated sign-in pages may be classified MEDIUM/LOW or not at all; the owner then
  reviews the page or uses Live Desktop.
* **Approximate site comparison.** "Same site" uses a built-in list of two-level suffixes, not the full Public
  Suffix List. It only influences whether a request is MEDIUM or LOW, and never auto-allows anything.
