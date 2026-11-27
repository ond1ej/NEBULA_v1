"""Verified VM image acquisition: signed manifest -> resumable download -> SHA-256 -> (optional) upstream GPG -> raw."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from nebula_setup import qcow2

ROOT = Path(__file__).resolve().parents[3]
MANIFEST_DIR = ROOT / "guest/image-builder"


class ImageError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def release_pubkey(manifest_dir: Path = MANIFEST_DIR) -> tuple[str, str]:
    """(base64 Ed25519 public key, source). NEBULA_MANIFEST_PUBKEY (base64 key, or a path to a file holding it)
    overrides the committed key, so a fork can sign its own manifest without editing the repo."""
    env = os.environ.get("NEBULA_MANIFEST_PUBKEY", "").strip()
    if env:
        p = Path(env).expanduser()
        if p.is_file():
            return p.read_text().strip(), f"NEBULA_MANIFEST_PUBKEY file {p}"
        return env, "NEBULA_MANIFEST_PUBKEY"
    return (manifest_dir / "keys/nebula-release-ed25519.pub").read_text().strip(), "committed release key"


def load_manifest(manifest_dir: Path = MANIFEST_DIR, pubkey_b64: str | None = None) -> dict[str, Any]:
    """Verify the Ed25519 signature of manifest.json against the pinned release public key."""
    raw = (manifest_dir / "manifest.json").read_bytes()
    try:
        sig = base64.b64decode((manifest_dir / "manifest.json.sig").read_text().strip())
    except FileNotFoundError as e:
        raise ImageError("manifest_unsigned", "manifest signature missing") from e
    pub_b64 = pubkey_b64 or release_pubkey(manifest_dir)[0]
    try:
        key_bytes = base64.b64decode(pub_b64, validate=True)
        pub = Ed25519PublicKey.from_public_bytes(key_bytes)
    except ValueError as e:
        raise ImageError("manifest_bad_key", "release public key is not a base64 Ed25519 key") from e
    try:
        pub.verify(sig, raw)
    except InvalidSignature as e:
        raise ImageError("manifest_bad_signature", "manifest signature does not verify — refusing image") from e
    m = json.loads(raw)
    for k in ("url", "sha256", "image_version", "format"):
        if k not in m:
            raise ImageError("manifest_invalid", f"manifest missing {k}")
    if not m["url"].startswith("https://"):
        raise ImageError("manifest_invalid", "image URL must be https")
    return m


def sha256_file(path: Path, chunk: int = 4 << 20) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while b := f.read(chunk):
            h.update(b)
    return h.hexdigest()


def download(url: str, dest: Path, expected_size: int | None = None,
             progress: Callable[[int, int], None] | None = None) -> Path:
    """Resumable HTTPS download to dest (via dest.part with HTTP Range)."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_suffix(dest.suffix + ".part")
    have = part.stat().st_size if part.exists() else 0
    headers = {"Range": f"bytes={have}-"} if have else {}
    with httpx.Client(follow_redirects=True, timeout=httpx.Timeout(30, read=120)) as client:
        with client.stream("GET", url, headers=headers) as r:
            if r.status_code == 416:  # already complete
                part.rename(dest)
                return dest
            if r.status_code not in (200, 206):
                raise ImageError("download_failed", f"HTTP {r.status_code} for {url}")
            mode = "ab" if r.status_code == 206 else "wb"
            if r.status_code == 200:
                have = 0
            total = int(r.headers.get("content-length", 0)) + have
            with open(part, mode) as f:
                for chunk in r.iter_bytes(1 << 20):
                    f.write(chunk)
                    have += len(chunk)
                    if progress:
                        progress(have, total or expected_size or 0)
    part.rename(dest)
    return dest


def verify_upstream_gpg(manifest: dict[str, Any], keyring_asc: Path) -> dict[str, Any]:
    """Defense in depth: verify Ubuntu's signed SHA256SUMS lists the same hash (needs gpg; optional)."""
    gpg = shutil.which("gpg") or shutil.which("/opt/homebrew/bin/gpg")
    if not gpg:
        return {"checked": False, "reason": "gpg not installed (manifest signature + sha256 still enforced)"}
    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)
        home = tdp / "gnupg"
        home.mkdir(mode=0o700)
        with httpx.Client(follow_redirects=True, timeout=30) as c:
            sums = c.get(manifest["upstream_checksums_url"]).content
            sig = c.get(manifest["upstream_signature_url"]).content
        (tdp / "SHA256SUMS").write_bytes(sums)
        (tdp / "SHA256SUMS.gpg").write_bytes(sig)
        subprocess.run([gpg, "--homedir", str(home), "--batch", "--import", str(keyring_asc)],
                       capture_output=True, check=True)
        p = subprocess.run([gpg, "--homedir", str(home), "--batch", "--status-fd", "1", "--verify",
                            str(tdp / "SHA256SUMS.gpg"), str(tdp / "SHA256SUMS")], capture_output=True, text=True)
        fpr = manifest["upstream_signing_key_fingerprint"]
        if p.returncode != 0 or f"VALIDSIG {fpr}" not in p.stdout:
            raise ImageError("upstream_signature_invalid", "Ubuntu SHA256SUMS signature did not verify")
        name = manifest["url"].rsplit("/", 1)[-1]
        listed = {ln.split()[1].lstrip("*"): ln.split()[0] for ln in sums.decode().splitlines() if len(ln.split()) == 2}
        if listed.get(name) != manifest["sha256"]:
            raise ImageError("upstream_hash_mismatch", "pinned hash differs from Ubuntu's signed SHA256SUMS")
    return {"checked": True, "fingerprint": fpr}


def acquire(cache_dir: Path, manifest: dict[str, Any], offline_image: Path | None = None,
            progress: Callable[[str, int, int], None] | None = None) -> dict[str, Any]:
    """Returns {"qcow2": path, "raw": path, "sha256": ..., "gpg": {...}}. Idempotent (cache keyed by hash)."""
    images = cache_dir / "images"
    images.mkdir(parents=True, exist_ok=True)
    fname = manifest["url"].rsplit("/", 1)[-1]
    src = images / fname
    if offline_image:
        shutil.copyfile(offline_image, src)
    if not src.exists() or src.stat().st_size != manifest.get("size_bytes", src.stat().st_size):
        download(manifest["url"], src, manifest.get("size_bytes"),
                 (lambda d, t: progress("DOWNLOAD", d, t)) if progress else None)
    if progress:
        progress("VERIFY", 0, 1)
    digest = sha256_file(src)
    if digest != manifest["sha256"]:
        bad = src.with_suffix(".rejected")
        src.rename(bad)
        raise ImageError("hash_mismatch", f"image hash {digest} != pinned {manifest['sha256']}; quarantined {bad}")
    gpg = {"checked": False, "reason": "offline import"} if offline_image else \
        verify_upstream_gpg(manifest, MANIFEST_DIR / "keys/ubuntu-cloudimg-keyring.asc")
    raw = images / f"{manifest['sha256'][:16]}.raw"
    if not raw.exists():
        if progress:
            progress("CONVERT", 0, 1)
        if manifest["format"] == "qcow2":
            qcow2.convert(str(src), str(raw), (lambda d, t: progress("CONVERT", d, t)) if progress else None)
        else:
            shutil.copyfile(src, raw)
    return {"qcow2": str(src), "raw": str(raw), "sha256": digest, "gpg": gpg,
            "image_version": manifest["image_version"]}
