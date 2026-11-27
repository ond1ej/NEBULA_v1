# Smart sign-in

**Status: Experimental.** Tested end to end on synthetic sign-in pages inside the VM. Real third-party sites with real
accounts and MFA were not part of the release test; their pages vary, and some end in a CAPTCHA or a hand-off to you.

Smart sign-in lets an agent continue a task through a website login that you did not prepare in advance. When the
agent reaches a login, it calls `request_sign_in`. NEBULA pauses the task, opens the page in an isolated browser in the
VM, works out what the page asks for, and asks **you** in a secure form. It then signs in and the agent continues. The
agent and the AI model never see what you type.

It is built on the [Password Vault](password-vault.md) and its isolated broker; it is not a second credential system.

## What you see

- **Dashboard on the Mac:** a notice at the top, **Approvals → Sign-ins**, cards in the agent's chat, and
  **Password Vault → Sign-in requests**.
- **Native app and Mini App:** a card in the agent's conversation and an entry in Activity.
- **Telegram:** a message in the owner's private chat with the main bot (no other account receives it) with **Open
  secure form** (opens the Mini App) and **Cancel sign-in**, which only the owner can press. The message never
  contains a field to type into. Never send passwords or codes to the bot.

All of these show the same request; answering in one place updates the others.

## The secure form

- The **verified destination** (for example `https://github.com`) is shown prominently: the page's real origin as
  checked by NEBULA, not its title.
- The fields match what the page asks for: email, user name, user name or email, phone number, password, verification
  code or recovery code. Labels are NEBULA's own; text from the website is never used for them.
- If the vault has an account for this exact origin, choose **Use saved account** or **Use another account**.
  Passwords are never displayed; on the phone only account names are shown.
- **Save options:** **Use once without saving** (default); **Save to NEBULA Vault** (saved only after a verified
  sign-in); **Allow this agent to request this credential in the future** (off by default; creates an "always ask"
  grant and needs the owner with a fresh verification).
- **Review warning:** when NEBULA is not fully sure (an unusual form, an unverified destination), you must tick "I
  checked that this is the right site". If in doubt, cancel.

### Codes and other steps

- **SMS, email or authenticator codes** are asked for right after the password, in the same form. A code is used once
  and never saved. After 3 rejected attempts NEBULA stops so your account is not locked.
- **Approve on your device** (push or app approval): NEBULA waits and continues only when the site confirms. If the
  site shows a number to match, NEBULA shows it to you.
- **CAPTCHA, passkey or security key:** NEBULA does not bypass them. For passkeys it presses the site's own "Cancel"
  and, by default, chooses the site's own "use your password" option; passkey-only accounts and CAPTCHAs are handed to
  you in **Live Desktop**, then you press **I'm done** and NEBULA checks that you are signed in. Anything you type in
  Live Desktop is visible to the agent's environment, so do only the step that is needed there.
- **"Stay signed in?"** prompts are answered with the choice that changes nothing.
- **Unconfirmed result:** if NEBULA sees no evidence of a sign-in, you check the page in Live Desktop; nothing is saved.

### From your phone

Typing credentials remotely, using a saved account the agent has no grant for, saving to the vault or entering a
recovery code needs a **fresh verification** of the owner: one Face ID confirmation in the native app, Telegram's
biometric confirmation, or your NEBULA password. If your session is not fresh, NEBULA asks for the optional **remote
sign-in PIN** instead, which you can set on the Mac (Password Vault → Settings → Smart sign-in; 6 to 64 characters,
locked out after 5 wrong attempts). One-time codes need neither.

## How a step is recognised

- The broker waits until the page has settled (loaded, not busy, the DOM quiet for 250 ms) and reads only structure:
  input types, `autocomplete`, labels, visibility, forms and their target origin, same-origin frames, open shadow
  roots, error markers, buttons and sign-out links. It never reads values or page text into what it reports.
- A value is typed only into a field of the matching type (a password only into a password field).
- An error shown by the site counts as a rejected attempt. The same step without an error is "no progress"; two in a
  row, or more than 16 steps, stop automatic submission and offer Retry, Live Desktop or Cancel.
- Each step has an increasing id; stale answers and answers for a page that changed are refused.
- **Success needs evidence:** the identity provider's own session cookie, a sign-out control after a password or
  code, or a new site cookie after a password or code with the form gone. Never after an identifier alone.

## Destination trust

| Level | When | What happens |
|---|---|---|
| Verified | The requested origin itself; an exact sign-in host of a built-in provider that the service uses (Microsoft, Google, GitHub, Apple); a relationship you configured | Continues without a warning |
| Review | An unverified destination, an unusual form, a local-network address you allowed | You confirm the exact host name |
| Blocked | Lookalike domains (edit distance, homoglyphs, punycode, trusted names inside foreign domains), a brand claimed on a foreign domain, plain HTTP on the Internet, DNS rebinding to a private address, a request carrying a typed value to another site | Credential submission is refused; lookalike and brand findings can be cleared only by marking that exact HTTPS origin as genuine, which needs a fresh verification and is audited |

Sign-ins on IP addresses and local-network names (routers, NAS, intranets) are refused by default; you can allow them on
the Mac, and they are then always reviewed. The VM's firewall also blocks local-network destinations for every agent,
so the device's address must additionally be listed in `/etc/nebula/firewall-lan-allow.nft` inside the VM, otherwise
the agent's browser cannot reach it at all. See [configuration.md](../configuration.md#vm-network-access).

## What the agent gets

Only "Authentication completed successfully." and a browser that is signed in. Password, MFA or recovery changes,
payments, account deletion and data exports still need your approval. If you cancel, the agent is told not to ask
again for that site in the same task. After two failed sign-ins for the same site in one task, a third request is
refused. Password and code fields in the agent's browser are cleared when a sign-in ends, and the agent's page
observation never returns their values.

## Limits

- One sign-in per agent at a time, five in total. A broker session uses one headless Chromium in the VM.
- A host or VM restart ends open sign-in requests; the agent can ask again. Nothing secret survives a restart.
- Embedded third-party logins (a password field in another site's frame) and sign-up or new-password forms are not
  automated.
- A saved account is never typed on another origin. A password typed on an identity provider's page is bound to that
  provider's origin.
- Detection is heuristic. Unusual pages may need review, or come back as "no login form"; the agent is then told to
  open the actual sign-in page.

Design and threat model: [../security/SMART_AUTH_ARCHITECTURE.md](../security/SMART_AUTH_ARCHITECTURE.md),
[../security/SMART_AUTH_THREAT_MODEL.md](../security/SMART_AUTH_THREAT_MODEL.md),
[../security/SMART_AUTH_REMOTE_SUBMISSION.md](../security/SMART_AUTH_REMOTE_SUBMISSION.md).
