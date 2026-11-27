# The Apple apps and your server

The native NEBULA apps for iPhone, iPad and Mac are **not built from this repository**. They live in their own
repository, **[ond1ej/NEBULA-iOS](https://github.com/ond1ej/NEBULA-iOS)**, which has the source, the build and signing
instructions and the apps' own tests. This page describes what the **server** does for them: the pairing protocol, the
unified owner confirmation and push notifications. For using the apps, see [ios-app.md](ios-app.md).

Both apps are clients of your NEBULA server's remote gateway. There is no second backend and no second database. To
build and install them you need a Mac with Xcode 26 or later (the iOS 26 and macOS 26 SDKs); the devices need iOS 18 or
later and macOS 15 or later. The details are in the
[NEBULA-iOS build guide](https://github.com/ond1ej/NEBULA-iOS/blob/main/docs/building.md).

## Pairing protocol

1. The owner creates a pairing offer (`POST /api/v1/devices/pairing`), valid for 5 minutes and single use. The QR
   code encodes `nebula://pair?v=1&u=<gateway URL>&p=<pairing id>&c=<128-bit one-time code>&f=<server key fingerprint>`.
   The app takes this link only from the QR code scanner or from the text field where you paste it. Opening or
   tapping the link on the phone does not pair the app.
2. The app calls `GET /api/app/hello` and checks the server fingerprint. It creates two P-256 keys in the Secure
   Enclave (identity; confirmation with user presence) and a 32-byte device secret in the Keychain
   (`WhenPasscodeSetThisDeviceOnly`, user presence), then sends `POST /api/app/pair/claim` with both public keys and a
   proof-of-possession signature from each.
3. The server answers with a signature over the pairing that the app verifies against the fingerprint, so a
   substituted server is refused. The device is `pending` until the owner approves it on the Mac after comparing the
   6-digit code.
4. Sessions: `POST /api/app/session/challenge` returns a server-signed, single-use challenge (60 seconds); the app
   signs it with its identity key and receives a Bearer session from `POST /api/app/session` (sliding 1 hour, at most
   12 hours). Revoking the device ends its sessions immediately.

Signatures are ECDSA P-256 with SHA-256 over newline-joined, domain-separated payloads (for example
`nebula-app-pair/v1`, `nebula-app-challenge/v1`, `nebula-owner-confirm/v1`). CryptoKit and Python `cryptography`
produce and verify the same test vectors in the NEBULA-iOS repository (`NEBULAAuthTests`) and in
`tests/unit/test_v40_crypto_vectors.py` here.

## Unified owner confirmation

`POST /api/v1/auth/confirm` gives one confirmation for both a fresh verification and vault access:

- `app_key`: a confirmation-key signature over a single-use challenge bound to this session, plus the device secret
  released by the same Face ID prompt;
- `telegram_biometric`: a token from Telegram's BiometricManager that rotates on every use;
- `vault_passphrase`: the fallback without biometrics;
- `password`: the NEBULA login password, for non-vault administrative actions.

For each owner device the vault data key is wrapped with AES-256-GCM under a key derived (HKDF-SHA256) from the
device secret. The server stores only the wrap. A copy of the database without a device secret or the passphrase
decrypts nothing. The first activation on a device asks for the vault passphrase once.

## Push notifications

The server sends APNs pushes only after you configure them: your own APNs authentication key (`.p8`, stored in the
Keychain), key id, team id, topic (your app's bundle id; or the `NEBULA_APNS_TOPIC` environment variable) and the `h2` Python
package (APNs speaks HTTP/2 only). Alerts contain the agent name
only, never task content. The app registers its push token when the push entitlement is enabled; how to enable it in
the app is described in the
[NEBULA-iOS build guide](https://github.com/ond1ej/NEBULA-iOS/blob/main/docs/building.md#push-notifications). Without
this setup the app shows notifications only while it runs.

## Limitations

- No App Store, TestFlight or notarized build is provided.
- Push requires a paid Apple Developer Program membership.
- Free Apple ID builds expire after 7 days on the device.
