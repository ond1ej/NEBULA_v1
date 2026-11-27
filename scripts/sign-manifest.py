#!/usr/bin/env python3
"""Sign guest/image-builder/manifest.json with the NEBULA release Ed25519 key.

The private key lives OUTSIDE the repository (default ~/.nebula-release-keys/release-ed25519.pem).
`--init` creates a new key pair and writes the public key into the repo. Forks must use their own key.
"""
import argparse
import base64
import os
import sys
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "guest/image-builder/manifest.json"
PUB = ROOT / "guest/image-builder/keys/nebula-release-ed25519.pub"
DEFAULT_KEY = Path.home() / ".nebula-release-keys/release-ed25519.pem"

ap = argparse.ArgumentParser()
ap.add_argument("--key", type=Path, default=DEFAULT_KEY)
ap.add_argument("--init", action="store_true")
a = ap.parse_args()
if a.init:
    if a.key.exists():
        sys.exit(f"refusing to overwrite {a.key}")
    a.key.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    k = Ed25519PrivateKey.generate()
    pem = k.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
    fd = os.open(a.key, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.write(fd, pem)
    os.close(fd)
    raw = k.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    PUB.write_text(base64.b64encode(raw).decode() + "\n")
    print(f"new release key: {a.key}; public key written to {PUB}")
key = serialization.load_pem_private_key(a.key.read_bytes(), password=None)
sig = key.sign(MANIFEST.read_bytes())
(MANIFEST.parent / "manifest.json.sig").write_text(base64.b64encode(sig).decode() + "\n")
print("signed", MANIFEST)
