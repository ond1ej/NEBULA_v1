# Password Vault

The Password Vault is a local, encrypted store for website credentials. It lets an agent sign in to a website without
the agent or the AI model ever seeing the password: a separate, isolated browser in the VM signs in and hands only the
signed-in session to the agent's browser, after your approval.

**Status: Stable** for the vault and agent sign-in with grants. [Smart sign-in](smart-sign-in.md), where the agent asks
for a sign-in you have not prepared, is Experimental.

## Cryptography in one paragraph

The vault passphrase is stretched with Argon2id into a key-encryption key that unwraps a random data key; entries are
encrypted with AES-256-GCM. The database holds only ciphertext and the wrapped data key. There is **no recovery**
without the passphrase: no escrow and no backdoor. Paired native apps can hold a device-bound wrap of the data key
(see [../apple-apps.md](../apple-apps.md#unified-owner-confirmation)); a database copy alone decrypts nothing. Details:
[../security/VAULT_ARCHITECTURE.md](../security/VAULT_ARCHITECTURE.md).

## First setup

1. Open **Password Vault** in the dashboard on the Mac (`http://127.0.0.1:3100/#/vault`).
2. **Create vault** with a dedicated passphrase of at least 12 characters that is not your NEBULA login password.
   Write it down somewhere safe.
3. **Add credential:** type (website, application or API token), display name, origin (`https://site.example`),
   optional sign-in page on the same origin, user name, password (or **Generate**), notes and tags.
4. The vault locks itself after 15 minutes without vault activity (5, 15, 30 or 60 in settings), when NEBULA restarts
   and when you press **Lock now**.

**Reveal** shows a password for 30 seconds and asks for the passphrase again if your last vault authentication is
older than 5 minutes. **Copy** copies only when you press it.

Vault management is local to the Mac, or through an owner session (native app or Mini App) with a fresh verification;
revealing or exporting additionally needs the passphrase or a device-bound confirmation. Over the LAN it works only on
the HTTPS listener and only if you enable it in vault settings.

## Letting an agent sign in

1. **Agents → agent → Security → Password Vault → Selected.** The default for every agent is **No vault access**.
2. **Add grant:** pick a credential; the origins default to the credential's origin. Approval policy: **Always ask**
   (default), ask once per task, or automatic (single origin only).
3. Give the agent a task on that site. It requests the sign-in, and you get an approval request (dashboard, Mini App,
   app, Telegram) showing the agent, credential, site, action, task and expiry. **Approve once** or **Deny** in the
   dashboard, the main bot's Mini App or the app; remotely this needs a fresh verification. The Telegram message
   cannot decide it: it opens the Mini App or points to the dashboard
   ([telegram.md](../telegram.md#approvals-in-the-chat)).
4. The isolated broker signs in and hands the session to the agent's browser. If the site asks for MFA or a CAPTCHA,
   the agent reports that it needs you: finish the step in Live Desktop.

After a vault sign-in, payments, sending or publishing, password, MFA or recovery changes, account deletion and data
exports still need your approval. Turn all agent sign-ins off in **Vault → Settings → Agent sign-in**. Revoke a grant
from the dashboard, the Mini App or the app.

## Backup and recovery

- **Vault → Settings → Encrypted export** with a separate export passphrase. Keep the file safe.
- **Import** adds the entries of an export to the current vault (needs the export passphrase and a confirmation).
- Normal database backups contain only encrypted vault data.
- **Change the vault passphrase** in settings (needs the current one).

## Limits

- Only **website** credentials can be used by agents, only for **signing in**, and only by agents working **in the
  VM**. Application credentials and API tokens are stored but never usable by agents.
- After a sign-in the session lives in the agent's browser and is usable by that agent, like any signed-in browser.
  Grant only what the agent needs, and revoke and sign out when done.
- Sessions kept outside cookies (for example tokens in `localStorage`) cannot be handed over.
- Grants for loopback origins are refused. Grants are not included in encrypted exports.
- Malware running as your macOS user while the vault is unlocked defeats it. Python cannot guarantee that key copies in
  memory are wiped.

More: [../security/VAULT_THREAT_MODEL.md](../security/VAULT_THREAT_MODEL.md),
[../security/VAULT_PERMISSION_MODEL.md](../security/VAULT_PERMISSION_MODEL.md),
[../security/VAULT_SECURITY_TESTS.md](../security/VAULT_SECURITY_TESTS.md).
