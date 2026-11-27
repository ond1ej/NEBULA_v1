# iPhone, iPad and Mac apps

The NEBULA apps for iPhone, iPad and Mac let you chat with your agents, follow and approve their tasks, use the
Password Vault and Smart sign-in requests, check the Mac and the VM, and watch or take over an agent's Live Desktop
with touch (iPhone) or mouse and keyboard (Mac). They are clients of your own NEBULA server; they have no server of
their own and no NEBULA account.

**Status: Experimental.** The apps are tested on the iOS Simulator and on real devices, but you build them yourself.

## Where to get them

The apps are published in their own repository: **[ond1ej/NEBULA-iOS](https://github.com/ond1ej/NEBULA-iOS)**. Its
README and [build guide](https://github.com/ond1ej/NEBULA-iOS/blob/main/docs/building.md) cover downloading the
source, Xcode, your own signing and installing on an iPhone, iPad or Mac. This repository holds only the server side of
pairing, see [apple-apps.md](apple-apps.md).

There is **no App Store or TestFlight version**. To build and install the apps you need:

- a Mac with **Xcode 26 or later** (the apps need the iOS 26 and macOS 26 SDKs to compile);
- an **Apple ID** signed in to Xcode (a free Apple ID works, see the limits below);
- an iPhone or iPad with **iOS 18 or later** (or a Mac with **macOS 15 or later**), with Developer Mode turned on
  for the iPhone and iPad;
- your NEBULA server reachable over HTTPS, normally through Tailscale Serve.

### Limits of a free Apple ID

With a free Apple ID, Xcode signs the app with a "Personal Team":

- the installed app stops launching after **7 days**; build and install it again from Xcode to renew it;
- you can have only a few such apps installed at a time;
- **push notifications are not available**: they need a paid Apple Developer Program membership and your own APNs key.

Everything else in the app works with a free Apple ID.

## Connect the app to your Mac

1. **Make the gateway reachable.** Set up Tailscale Serve as described in [remote-access.md](remote-access.md): the
   Mac and the iPhone in the same tailnet, MagicDNS and HTTPS certificates enabled, the gateway enabled and Serve
   started in **Dashboard → Remote Access**. The app only talks to an `https://` gateway address. (Debug builds
   also accept plain `http://` on loopback, for the local test server only.)
2. **Start pairing on the Mac.** **Dashboard → Devices → Pair an iPhone or Mac** shows a QR code that is valid for 5
   minutes and can be used once. It contains the gateway URL, a pairing id, a one-time code and the fingerprint of
   the server's public key. It contains no long-term secret.
3. **Scan or paste it in the app.** On first launch the app shows "Connect to NEBULA". Tap **Scan QR code**, or paste
   the pairing link (the text that starts with `nebula://pair`) into the text field and tap **Pair**. Tapping or
   opening the link on the phone does **not** pair the app; only the QR code scan or the pasted link does. The app
   calls the gateway's `/api/app/hello` and refuses to continue if the server fingerprint differs from the one in the
   QR code.
4. **Face ID.** The app creates two keys in the Secure Enclave (an identity key and a confirmation key that requires
   Face ID or the passcode) and a random device secret for the vault, then proves to the server that it holds them.
5. **Approve on the Mac.** The app and the dashboard both show the same 6-digit code. If they match, press **Approve**
   in the dashboard. Until then the device has no access.

After pairing, the app signs in by signing a single-use server challenge with its identity key. Sessions slide for
an hour and last at most 12 hours, then the app signs in again silently.

## Using the app

| Tab or screen | What you can do |
|---|---|
| Chats | Conversations with agents, streamed answers, Markdown and code, photos, files and voice notes |
| Agents | List, create and edit agents, see and control their tasks (pause, resume, stop) |
| Activity | Approvals, running and finished tasks, Smart sign-in requests |
| Live Desktop | Watch an agent's desktop, take and release control with touch, keyboard and zoom |
| Vault | Password Vault and sign-in requests; sensitive steps are confirmed with Face ID |
| System | Mac mini and VM status, start or stop the VM, restart services, backups, diagnostics, paired devices |

**One confirmation for sensitive actions.** Actions that need a fresh verification, such as revealing a vault password
or administrative changes, are confirmed with one Face ID prompt. The first time you use the vault on a device, you
enter the vault passphrase once; NEBULA then stores a copy of the vault key wrapped with a key derived from the
device's secret. The server never stores that secret, so a copy of the database alone cannot unlock the vault.

## Removing a device

**Dashboard → Devices → Revoke** ends the device's sessions at once and deletes its vault key wrap and push token.
Do this if you lose the phone. Deleting the app from the phone removes its keys from the phone; revoke it on the Mac
as well.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Server not reachable" | Tailscale connected on the phone? Same tailnet? Open `https://<your-mac>.<your-tailnet>.ts.net/healthz` in Safari on the phone. |
| "Fingerprint does not match" | The QR code is not from the server the app reached. Create a new pairing on the right Mac. Never approve a code you did not start. |
| Pairing code expired | Codes are valid for 5 minutes and single-use; create a new one. |
| The app stopped launching after a week | Free Apple ID builds expire after 7 days; build and install again from Xcode. |
| No push notifications | Expected with a free Apple ID or without an APNs key on the server; see [apple-apps.md](apple-apps.md#push-notifications). The app still shows notifications while it runs. |
