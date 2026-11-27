# Remote access

Out of the box NEBULA is reachable only from the Mac it runs on. This guide explains the options for reaching it
from other devices, what each option exposes, and how to set up the recommended one: **Tailscale Serve**.

> Placeholders: `<your-mac>` is the Mac's machine name in Tailscale and `<your-tailnet>` is your tailnet's DNS name,
> so the full address looks like `https://<your-mac>.<your-tailnet>.ts.net`. Replace them with your own values.

## Options at a glance

| Option | Who can reach NEBULA | What is reachable | Default | Use it for |
|---|---|---|---|---|
| Local only | This Mac | Full dashboard on `127.0.0.1` | **On** | Using NEBULA on the Mac itself |
| LAN access | Devices in your local subnet | Full dashboard on the Mac's LAN address | Off | A laptop or tablet at home |
| Gateway + **Tailscale Serve** | Devices signed in to your tailnet | The remote gateway (native apps, Mini App UI, authenticated API) | Off | **Recommended** for your iPhone and laptops anywhere |
| Gateway + Tailscale Funnel | **Anyone on the Internet** | The remote gateway | Off, needs explicit confirmation | Only the Telegram Mini App, which requires a public HTTPS origin |
| Gateway + Cloudflare quick tunnel | **Anyone on the Internet** who knows the random URL | The remote gateway | Off, needs explicit confirmation | A temporary public Mini App without Tailscale |
| Gateway + your own reverse proxy | Whatever your proxy allows | The remote gateway | Off | Existing HTTPS infrastructure |

NEBULA never opens ports on your router, never uses UPnP, never binds the dashboard to a public address and never
creates accounts with Tailscale, Cloudflare or anyone else. It only runs the `tailscale` or `cloudflared` command you
installed, when you press Start. Keep in mind that once the gateway is on and reachable, an authenticated owner
session can reach owner administration through it (see below).

## The remote gateway

All remote options except LAN go through the **remote gateway**, a second, separate web server in the NEBULA process:

- It listens on `127.0.0.1` only, by default on the **dashboard port plus 2** (`3102` when the dashboard uses `3100`).
  A tunnel or proxy on the same Mac forwards HTTPS traffic to it.
- It is **off by default**. Turn it on in **Dashboard → Remote Access**.
- It does not serve the web dashboard or its password sign-in, and accepts no dashboard cookies. Callers
  authenticate with short-lived Bearer sessions, created either from verified Telegram Mini App data or by a paired
  native app's device key. It never passes the caller's cookies, `Authorization`, `Origin`, CSRF or forwarding
  headers on to the host API.

### What the gateway exposes

| Path | Authentication | Purpose |
|---|---|---|
| `GET /healthz` | none | Returns `{"ok": true}` |
| `GET /`, `GET /mini/...` | none | The Mini App page (static files) |
| `GET /assets/...` | none | Static JavaScript and CSS of the Mini App |
| `POST /api/mini/auth` | Telegram `initData` | Exchanges verified Mini App launch data for a session |
| `POST /api/mini/logout` | Mini App session | Ends the session |
| `GET /api/app/hello` | none | Server name, version and public key fingerprint, so an app can check it before pairing |
| `POST /api/app/pair/claim` | one-time pairing code from the QR | Starts pairing of a native app; the owner must approve it on the Mac |
| `POST /api/app/session/challenge`, `POST /api/app/session` | paired device key signature | Signs in a paired native app |
| `POST /api/app/logout` | app session | Ends the session |
| `/api/v1/...` | Mini App or app session | Forwarded to the host API **per route policy**, see below |
| `WS /api/v1/live/ws/{id}` | session + single-use viewer token + `desktop` permission | Live Desktop stream |
| anything else | n/a | `404` |

**Forwarded API routes.** Every host API route has exactly one policy in `nebula_host/authz.py`. The gateway forwards
every route except `public` ones (the dashboard's own sign-in and setup) and `local` ones (VM installation, the LAN CA
download and similar Mac-only operations). The host then checks the caller's role and permission on every request:

| Policy | Allowed for |
|---|---|
| `read` | any signed-in session |
| `op:<permission>` | the owner, or a session that holds that permission |
| `admin` | the owner |
| `admin!` | the owner with a fresh verification (password, Face ID through the app or Telegram, within 5 minutes) |

This means: **when the gateway is reachable, an authenticated owner can administer NEBULA through it**, including
agents, providers, Telegram, remote access settings, host folders and the Password Vault (vault plaintext additionally
needs the vault passphrase or a device-bound confirmation). That is by design, so you can run NEBULA from your phone.
It is also why the gateway should be reachable only from devices you control, which is what Tailscale Serve gives you.

**Roles.** Listing and resolving approvals is owner-only for every remote caller (`GET /api/v1/approvals`,
`/owner-approvals` and `/approval-center` answer `403` to everyone else; operators get `owner_only`). Vault,
credential, host and system task approvals and owner approvals of commands, packages and plugins also need a fresh
verification, so they are decided in the main bot's Mini App, the native app or the dashboard, never with a Telegram
chat button; ordinary approvals also take one tap in the owner's Telegram chat
([telegram.md](telegram.md#approvals-in-the-chat)).
Operators (other approved accounts of the main bot) get only the permissions stored for them, by default tasks,
commands and screenshots, in the Mini App and in the bot chat. Agent-bot users reach only their agent's chats and
tasks. The owner using an agent bot's Mini App sees no approvals there either: use the main bot's Mini App, the
native app or the dashboard.

**Sessions fail closed.** The host re-checks the Telegram identity behind a Mini App session at least every few
seconds. When you revoke the account, or disable or remove the bot it came from, its sessions end and further
requests answer `401`.

**Controls on every request.** Host header check (`421` for an unknown host), Origin check for cross-origin requests
(`403`), rate limits per client and per session (240 requests per minute by default), request bodies up to 60 MB,
strict response headers (`nosniff`, `no-referrer`, HSTS, a Content-Security-Policy that allows scripts only from the
gateway itself and `telegram.org`, framing only by Telegram Web).

## Recommended: Tailscale Serve

Tailscale Serve makes the gateway available over HTTPS **only to devices in your tailnet**. Nothing is published to
the Internet.

### 1. Install Tailscale

- **Mac:** install Tailscale from [tailscale.com/download](https://tailscale.com/download) and sign in. NEBULA needs
  the `tailscale` command-line tool: check that `tailscale version` works in Terminal. If it does not, enable the
  command-line integration in the Tailscale app's settings.
- **iPhone, iPad, other Macs:** install Tailscale and sign in **to the same tailnet** (the same account or
  organization). Devices only see each other inside one tailnet.

### 2. Enable MagicDNS and HTTPS certificates

In the Tailscale admin console, **DNS** page:

1. Enable **MagicDNS**, so the Mac is reachable as `<your-mac>.<your-tailnet>.ts.net`.
2. Enable **HTTPS Certificates**, so Tailscale can issue a real TLS certificate for that name.

Tailscale publishes HTTPS certificate names in its public certificate transparency logs. The machine name and
tailnet name become visible there; choose names that reveal nothing you want to keep private.

### 3. Start the gateway with Tailscale Serve

1. **Dashboard → Remote Access** → enable the gateway. Keep the suggested port unless it is taken.
2. Choose **Tailscale Serve** and press **Start**.
3. NEBULA runs `tailscale serve --bg --https=<port> http://127.0.0.1:<gateway port>`, so it uses one Tailscale
   HTTPS port only: the setting `tailscale_https_port`, default `443`. If that HTTPS port of the Mac's Tailscale node already
   serves something else, NEBULA refuses to start instead of replacing it. It reads the node's DNS name from
   `tailscale status` and fills in the URL, `https://<your-mac>.<your-tailnet>.ts.net` (with `:<port>` when the HTTPS
   port is not `443`).
4. From a device in your tailnet, open `https://<your-mac>.<your-tailnet>.ts.net/healthz`; it should answer
   `{"ok": true}`. Requests without a session to anything under `/api/v1/` answer `401`.

Stopping it in Remote Access turns off only this instance's mapping (`tailscale serve --https=<port> off`), and only
while that port still points at NEBULA's gateway. NEBULA never resets the node's Serve or Funnel configuration, so
other services you publish with Tailscale and other NEBULA instances keep running. Give a second instance its own
`tailscale_https_port` (change it with `PATCH /api/v1/remote`).

Tailscale Serve terminates TLS on the Mac, in `tailscaled`.

Optionally restrict which tailnet users and devices may reach the Mac with Tailscale's access control policy. By
default every device in your tailnet can reach it.

### 4. Connect the iPhone app

1. Install Tailscale on the iPhone and connect it to the same tailnet.
2. Build and install the NEBULA app (see [ios-app.md](ios-app.md)).
3. **Dashboard → Devices → Pair an iPhone or Mac** shows a QR code. It contains the gateway URL, a pairing id, a
   128-bit one-time code (valid for 5 minutes) and the server key fingerprint; no long-term secret.
4. Scan it in the app. The app checks the server fingerprint, registers its Secure Enclave keys and shows a 6-digit
   code. Compare it with the code on the Mac and press **Approve** in the dashboard.

## Telegram Mini App: Tailscale Funnel and other public tunnels

Telegram opens Mini Apps only from a **public** HTTPS origin, so the Mini App cannot use Tailscale Serve. If you want
the Mini App, you have to publish the gateway:

- **Tailscale Funnel**: requires the Funnel attribute for the Mac in your tailnet policy. After you confirm the
  exposure, NEBULA runs `tailscale funnel --bg --https=<port>` for this instance's HTTPS port only, with the same
  scoping as Serve. Funnel accepts only the HTTPS ports `443`, `8443` and `10000`. TLS terminates on the Mac.
- **Cloudflare quick tunnel**: install `cloudflared`; after you confirm, NEBULA starts
  `cloudflared tunnel --no-autoupdate --url http://127.0.0.1:<port>` and reads the random `trycloudflare.com` URL
  from its output.
  Cloudflare terminates TLS at its edge, so everything you send through the Mini App, including passwords for a
  fresh verification, vault passphrases and Smart sign-in answers, is decrypted at Cloudflare before it reaches your
  Mac. Prefer Funnel or your own proxy if you use the vault from the Mini App.
- **Your own HTTPS reverse proxy**: enter its `https://` origin; NEBULA only uses it to build links.

Use a public tunnel only for the Telegram Mini App; the native apps work over Tailscale Serve.

Then press **Apply bot menu buttons** so the bot's menu opens the Mini App. See [telegram.md](telegram.md).

### Security requirements of the public surface

Before you publish the gateway, understand what protects it:

- **Telegram launch data is verified server-side** exactly as Telegram documents it: an HMAC-SHA256 over the
  `initData` keyed with your bot token. It must be at most 10 minutes old, is accepted only once (replay table) and
  must belong to a Telegram account you paired **and approved** for that bot.
- **Sessions are short:** 1 hour, sliding while in use, at most 12 hours after sign-in. You can revoke one or all
  sessions in Remote Access. Sessions are Bearer tokens, valid only through the gateway; they are useless on the
  dashboard port. The reverse holds too: the host answers `401` to a dashboard session that arrives with the
  gateway's header, because the gateway only forwards remote sessions.
- **Sensitive actions need a fresh verification** (`admin!` routes), and vault plaintext needs the vault passphrase
  or the device-bound confirmation of a paired app.
- **Sessions end with access:** revoking an account, or disabling or removing its bot, ends its sessions.
- **Rate limits, Host and Origin checks and strict headers** apply as described above.
- **Live Desktop** needs a single-use viewer token (valid 90 seconds), the session and the `desktop` permission. The
  WebSocket carries the session token as a `session_token` URL parameter; NEBULA redacts it in its own logs, but a
  proxy in front of the gateway may log URLs.

What it does **not** protect against:

- Anyone who controls a Telegram account you approved can use NEBULA within that account's role. A compromised
  Telegram account of the owner can decide ordinary approvals with one tap and administer NEBULA up to the point
  where a fresh verification is required.
- Other approved accounts are limited: operators get only the permissions stored for them (by default tasks,
  commands, screenshots), in the Mini App and in the bot chat, and never list or decide approvals; agent-bot users
  reach only their agent. They can still give tasks to agents, so approve only people you would let use those agents.
- A public URL is found by scanners. Expect unauthenticated probes; they get `401`, `403`, `404` or `429`. The Mini
  App files, `/healthz` and `/api/app/hello` (server name, version and key fingerprint) answer without a session.
- Once the gateway is public, an owner session from anywhere can administer NEBULA. If you only need the native apps,
  stop Funnel and use Serve.

Funnel and Cloudflare tunnels are started only when you press Start and confirm. Stopping the tunnel in Remote Access
stops what NEBULA started and nothing else.

## LAN access

**Settings → LAN Access → Enable** adds extra listeners for the full dashboard on the Mac's private IPv4 addresses of
physical network interfaces (`en*`). It never binds to the VM bridge, VPN interfaces such as Tailscale's `utun*` or
`0.0.0.0`, and it filters every request by source subnet. Optional HTTPS (default port `3443`) uses a NEBULA local CA
with name constraints limited to private addresses and `.local` names; you install the CA certificate on each device
once. Plain HTTP on Wi-Fi sends your password and session cookie unencrypted; prefer HTTPS or Tailscale.
"Continue with ChatGPT" and the Password Vault management still have to be done on the Mac.

Failed logins from LAN devices count towards the account lockout (`security.login_max_attempts`); logins on the Mac
itself are only rate-limited, so a device on the network cannot lock you out locally. See
[configuration.md](configuration.md#configyaml).

## Troubleshooting

| Symptom | What to check |
|---|---|
| Remote Access says `tailscale` is not installed | `tailscale version` in Terminal. Enable the command-line integration in the Tailscale app, or install the standalone package. |
| Start fails with a Serve or Funnel error | The message from `tailscale` is shown. Common causes: not signed in (`tailscale status`), HTTPS certificates not enabled, Funnel not allowed for this node in the tailnet policy. |
| The iPhone cannot open `https://<your-mac>.<your-tailnet>.ts.net` | Tailscale is connected on the phone, both devices are in the same tailnet, MagicDNS is enabled, the gateway is enabled in Remote Access. |
| `421 bad_host` | The URL you use does not match the gateway's public URL. Stop and start the tunnel so NEBULA records the current name. |
| `403 not_available_remotely` | That action is Mac-only (for example VM installation). Do it in the dashboard on the Mac. |
| `401 unauthenticated` | Expected without a session. In the app, sign in again; in the Mini App, reopen it from Telegram (launch data is single-use). |
| `429 rate_limited` | Too many requests from one client or session; wait a minute. |
| Pairing says the gateway URL must be HTTPS | Start Tailscale Serve (or another tunnel) first; pairing needs an `https://` gateway URL. |
| Port reserved | The gateway cannot use the dashboard port or the LAN ports; choose another one. |
| "HTTPS port … already serves …" | That Tailscale HTTPS port of the Mac is used by another service or another NEBULA instance. NEBULA never replaces it: set another `tailscale_https_port` (`PATCH /api/v1/remote`) and start again. |
| `403 owner_only`, "Not available in the Mini App" or no approvals in the Mini App | Listing and deciding approvals is owner-only, and an agent bot's Mini App never shows them, not even to the owner. As the owner, use the main bot's Mini App, the native app, the dashboard or, for ordinary approvals, the buttons in your Telegram chat. |
| `401` right after you disabled a bot or revoked an account | Expected: its Mini App sessions ended. |
| An agent cannot reach a device on your LAN | The VM's firewall blocks local-network destinations. Add an exception, see [configuration.md](configuration.md#vm-network-access). |
