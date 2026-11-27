# Guest image inputs

| File | What it is |
|---|---|
| `manifest.json` | The pinned Ubuntu 24.04 ARM64 cloud image (URL, SHA-256, size), Ubuntu's signed checksum URLs and signing-key fingerprint, the guest version and the Playwright version. |
| `manifest.json.sig` | Ed25519 signature of `manifest.json` by the NEBULA release key. |
| `keys/nebula-release-ed25519.pub` | The release **public** key the installer verifies the signature with. |
| `keys/ubuntu-cloudimg-keyring.asc` | Ubuntu's public cloud-image signing keyring (used when `gpg` is installed). |
| `requirements-guest.in` / `requirements-guest.txt` | The guest VM's Python packages; the `.txt` is locked with exact versions and SHA-256 hashes. |

## How an image is trusted

1. `nebula install` checks `manifest.json.sig` against the release public key and refuses a manifest that does not verify.
2. The downloaded image must match the pinned SHA-256 (a mismatch is quarantined, never used).
3. With `gpg` installed, Ubuntu's own signed `SHA256SUMS` must list the same hash.

The signature protects against a tampered mirror or URL. It does not protect against a tampered checkout: the key
ships in the same repository. Verify the release public key out of band (for example against the key published
in the GitHub release notes) before you trust a clone.

## Forks: use your own key

```bash
python scripts/sign-manifest.py --init --key ~/.my-nebula-keys/release-ed25519.pem  # new key; writes the .pub
python scripts/sign-manifest.py --key ~/.my-nebula-keys/release-ed25519.pem         # re-sign after edits
```

Keep the private key outside the repository. To verify against a different public key without editing the
checkout, set `NEBULA_MANIFEST_PUBKEY` to the base64 key or to a file that contains it.

## Guest Python packages

The guest installs `requirements-guest.txt` with `pip install --require-hashes -r` (every file hash pinned). To change a
version, edit `requirements-guest.in` (Playwright must equal `manifest.json` `playwright_version`) and run
`scripts/lock-guest-requirements.sh`, then re-sign the manifest if you changed it. Playwright downloads its
Chromium build from the Playwright CDN over HTTPS; the build is fixed by the pinned Playwright version.
