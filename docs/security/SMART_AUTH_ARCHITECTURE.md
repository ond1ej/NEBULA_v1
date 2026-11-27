# Smart sign-in: architecture

> **Scope note.** This document records the original architecture. Later refinements (a persistent step state
> machine, settle-before-read page detection, verified / review / blocked destinations, evidence-based success,
> passkey fallback and memory limits of the broker) are summarised in
> [../features/smart-sign-in.md](../features/smart-sign-in.md); the code in `apps/host-api/nebula_host/smart_auth.py`,
> `auth_trust.py` and `guest/guest-service/nebula_guest/auth_detect.py` is authoritative.

Smart sign-in lets an agent's task continue through a website login without the owner preparing credentials in
advance. It extends the Password Vault and its isolated login broker. It is not a second credential system.

## Components and trust boundaries

```
 owner (Mini App via gateway / local dashboard)            NEBULA host (Mac)                      VM (Ubuntu)
 ─────────────────────────────────────────────            ─────────────────                      ───────────
 sees: verified origin, step, fixed role-based    ⇄  smart_auth.py (state machine, DB rows    ⇄  guest service (root)
 fields, saved-account names; types values            without secrets, single-use tokens,        vaultops: one session per
 into a secure form; single-use token per            remote PIN, vault integration)              agent, per-agent binding,
 submit; remote secret entry also needs the PIN      orchestrator: request_sign_in tool,         cookies only to that agent
                                                     pauses the task, resumes it                       │ stdin/stdout
 agent + AI model                                                                                ▼
 ─────────────────                                                                      nebula-vault user (nologin)
 calls request_sign_in(url); receives only                                               vault_auth.py: headless
 "authenticated / cancelled / expired / failed"                                          Chromium, throw-away profile,
 + the origin; never a value, token or cookie                                            own DOM detection, fills and
                                                                                         submits, egress guard
 agent's own browser (agent Linux user) ◀── session cookies only (browser.import_cookies) ──┘
```

* **Origins**: IP addresses and local or special-use host names (`.local`, `.internal`, `.lan`, `.home.arpa`,
  `.test`, single-label names) are refused by default, because an agent in the VM could serve a fake sign-in page
  there. The owner can allow them on the Mac; such requests are then always MEDIUM and need review.
* **Agent / model**: untrusted. Their only input is `request_sign_in(url)`. The tool takes no session id, agent id,
  field list or origin claim. Agent, task and conversation come from the execution context.
* **Website**: untrusted. Page text is never used as trusted UI text: the owner form uses fixed labels by field role
  (Email, Username, Phone number, Password, Verification code, Recovery code) and shows the verified origin.
* **Host** (`apps/host-api/nebula_host/smart_auth.py`): trusted. It holds typed values only in process memory, and
  only for as long as one broker call takes. A value the owner chose to save to the vault is kept until the sign-in
  succeeds and then encrypted.
* **Isolated broker** (`guest/guest-service/nebula_guest/vault_auth.py`): trusted. It runs as `nebula-vault` in
  a `systemd-run` sandbox (private /tmp, no /home, no new privileges, memory/runtime limits) with `python -I`. It
  loads only the root-owned `auth_detect.py` next to it and refuses to start otherwise.
* **Guest service** (`vaultops.py`, root): starts and stops broker processes, validates every parameter, and
  returns only whitelisted event fields. It imports cookies into the browser of the session's own agent only.

## Detection engine (`auth_detect.py`)

`DETECT_JS` reads the structure of the page and never input values. It collects input types, names, ids,
`autocomplete` tokens, `inputmode`, `maxlength`/`pattern`, labels, form action origins, iframes, CAPTCHA widgets,
`webauthn` hints, visible headings/buttons and alert texts. `classify()` turns these facts into a step:

| Step | Recognised by |
|---|---|
| identifier_password / identifier / password | `type=password`, `autocomplete=username/email/tel/current-password`, names/labels (EN+CS) |
| otp | `autocomplete=one-time-code`, OTP names/labels, 4–8 single-character boxes; channel sms/email/totp from untrusted text, length from `maxlength`/`pattern`/box count, numeric vs alphanumeric |
| recovery_code | recovery/backup code fields |
| device_approval | "approve on your phone / push" texts without inputs |
| passkey | passkey/security-key texts, `autocomplete=webauthn` |
| captcha | reCAPTCHA/hCaptcha/Turnstile/Arkose/GeeTest frames or widgets |
| embedded_login | password field inside a child frame (never filled) |
| new_password | sign-up / reset forms (not automated) |
| authenticated | "Sign out / Log out / Odhlásit" visible, no login form |

Confidence:

* **HIGH**: explicit types or autocomplete tokens on the requested origin.
* **MEDIUM**: the step was recognised from names/labels only, or the page moved to another origin of the same site,
  or the form posts to another origin of the same site, or the identifier is ambiguous, or there are several
  password forms.
* **LOW**: the page names a brand that is not its own domain (e.g. "GitHub" on `github-login.example`), or the
  page is on another site, or the form posts to another site, or the login sits in a third-party frame, or a
  recovery code is requested unexpectedly, or the page uses plain http on a public host.

MEDIUM and LOW requests carry `review_required`: the owner must tick "I checked that ⟨origin⟩ is the right site".
The same code runs in the agent's browser for *advisory* hints. A hint only adds a note to the agent's tool result
suggesting `request_sign_in`; it never creates a form.

## Session state machine

`DETECTED → WAITING_FOR_OWNER / WAITING_FOR_MFA / WAITING_FOR_DEVICE_APPROVAL / WAITING_FOR_MANUAL →
OWNER_SUBMITTED → VALIDATING → SUBMITTING → WAITING_FOR_NEXT_STEP → … → AUTHENTICATED | FAILED | CANCELLED | EXPIRED`.
Transitions are checked against a table, and each one is an atomic compare-and-set on the row's current state.
Terminal states are final.

Tables (migration 0007, additive):

* `auth_sessions`: agent, task, conversation, requested and verified origin, allowed origins, method, step, state,
  confidence, flags, counters, expiry, and the vault entry used or created.
* `auth_requests`: one owner-facing request per step, with field roles, lengths, flags and a status. It stores the
  sha256 of the current submission token, never the token itself.
* `auth_events`: a redacted lifecycle log.

There are no columns for passwords, codes, tokens or cookies.

## Flows

1. **Detect.** `request_sign_in(url)` checks the environment (VM only), settings, origin rules (no loopback, no
   http on public hosts), "owner cancelled this site earlier in this task", and the limits (1 per agent, 5 global).
   It then checks the isolated broker's self-test. If the agent's browser already shows a signed-in page on that
   origin, it returns `already_signed_in` and the owner is not asked.
2. **Broker start.** The broker opens the URL in its own browser. A redirect to a non-allowed origin is aborted and
   becomes a `confirm_destination` request. If there is no form, the broker follows one same-origin "Sign in" link.
   It detects the step itself.
3. **Owner request.** The session moves to the matching waiting state and the task stays in `WAITING_APPROVAL`
   with the stage "waiting for sign-in". One request object appears in the conversation card, Activity/approval
   center, the dashboard notice and a Telegram message with a Mini App button (sent only to the owner's chat with the
   main bot).
4. **Submit.** The owner answers with a fresh single-use token. The host validates the values against the trusted
   schema (role rules, OTP length/charset, no extra fields) and passes them to the broker.
5. **Fill and submit in the broker.**
   * The broker re-detects the page first and fills only if it is still the same step.
   * It types the values into the fields it detected and presses Enter, or clicks the form's own submit button.
   * While values are in the page, requests to non-allowed origins are blocked unless they are plain GETs. Any
     request whose URL or body contains a submitted value outside the allowed origins is blocked as well.
   * After the first fill, the egress guard stays on for the whole session and also covers WebSockets. It checks
     raw, URL-encoded, form-encoded and base64 forms of each value. This is defence in depth, not a guarantee.
   * The outcome is one of: the next step; the same step marked `rejected`; `blocked` (a form submission or a
     value-carrying request went to another origin); `redirect` (a GET navigation); or a result.
   * `authenticated` needs **positive evidence**: either a visible sign-out control, or no error shown, the page
     moved away from the form that was filled, and the site set or changed a cookie. Without such evidence the
     result is `unconfirmed`: the owner checks the page in Live Desktop and nothing is saved to the vault.
   * A blocked form POST is never replayed as a GET. After the owner allows the target, the same values are filled
     once more, mapped by field role onto the same kind of step.
   * Only the **requested site's** cookies are handed over. Cookies of an identity provider or of any other
     allowed origin never reach the agent.
6. **Multi-step.** Identifier → password → code → device approval are steps of one session. An owner-chosen saved
   account answers later credential steps automatically. Codes always come from the owner.
7. **Resume.** On `AUTHENTICATED` the guest has already imported the cookies into the agent's browser. The host
   navigates that browser to the post-login page, and the model receives "Authentication completed successfully."
   with the origin. Account-security, payment, export and other high-risk actions keep needing approval
   (`vault_session` policy).

## Vault integration

* **Saved accounts.** Website entries whose origin equals the requested origin are offered by name, plus the user
  name while the vault is unlocked. Passwords are never shown.
* **Remote vs local.** The Mini App sees saved-account names only; decrypted user names are shown only on the
  Mac. A remote saved-account answer needs the PIN unless the agent already has a grant that covers every origin of
  the session. Allowing future use (a grant plus switching the agent from NONE to SELECTED) is offered only on the
  Mac.
* **Using a saved account.**
  * The owner's choice in the form is the authorisation for that one use, and it is audited
    (`use.smart_sign_in`).
  * A saved credential is typed only where the page's verified origin equals the entry's origin. After an
    SSO / identity-provider hop, NEBULA asks the owner again.
  * An agent grant with the `auto` policy for exactly this origin is used without a form, as in 3.2. The grant is
    verified through `VAULT.authorize`, which checks the HMAC, the agent and the task.
* **Saving new credentials.**
  * Saving is an explicit owner choice; the default is "use once".
  * The credential is encrypted only after the sign-in succeeds with positive evidence. Only details typed on the
    requested site itself can be saved; a password typed on another site's page cannot.
  * It is stored with the requested origin and only the user name, password and login URL.
  * "Allow this agent to request this credential in the future" defaults to off. It creates an `always_ask` grant
    and switches the agent from NONE to SELECTED.
* **Locked vault.** Names are still shown. Using or saving is refused with "Unlock it locally on your Mac". The
  vault is never unlocked automatically and there is no remote unlock.

## Manual steps (CAPTCHA, passkey, unconfirmed result)

Only steps where the owner types no secret are handed over: CAPTCHA, passkey (the phone confirms) and the check of
an unconfirmed result. Embedded third-party logins and password-creation forms are refused instead (`unsupported_…`),
because they would make the owner type a secret into the agent's own browser.

For a hand-off, the broker passes the requested site's cookies and the current page to the agent's browser, and
the owner finishes the step in Live Desktop. "I'm done" is verified in the agent's browser (no sign-in step visible on an allowed origin) before the
task resumes. NEBULA never solves CAPTCHAs and never touches passkey material.

## Lifecycle, limits, recovery

Defaults are configurable locally in Password Vault → Settings → Smart sign-in:

| Setting | Default |
|---|---|
| Owner request expiry | 10 min |
| One-time-code validity | 120 s |
| Submission token | 2 min |
| Automatic broker retries (transient errors only, never re-sending a value) | 2 |
| Credential attempts per session | 3 |
| Code attempts per session | 3 |
| Sessions per agent | 1 |
| Sessions in total | 5 |
| Session hard limit | 30 min |

* A housekeeping loop expires due sessions every 10 s. Expiry releases the paused task and closes the broker.
* While NEBULA is processing an answer, only the session's hard limit applies, so a request cannot expire in the
  middle of a fill.
* Cancelling marks the guest session cancelled, so a late result never hands cookies to the agent, and the
  transient `systemd` unit is stopped.
* On host start, every open session becomes EXPIRED (`service_restarted`), because no secret survives a restart.
  The host also sweeps leftover broker processes in the VM once, keeping any session it already knows.
* A dead broker (VM restart) fails the session with `broker_lost`. The value is not re-sent.

## Performance

* Detection is event-driven: one bounded `evaluate` after `browser_navigate` / `browser_click` (≤ 2.5 s cap,
  normally a few ms) and in the broker after each step. There is no tab scanning, no screenshots and no AI
  classification.
* Idle cost is one 10 s housekeeping query.
* A broker session costs one headless Chromium in the VM (≤ 900 MB cap) while it runs.
