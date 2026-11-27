"""NEBULA 4.0 — the owner's native apps (iPhone / Mac): pairing, device sessions and unified owner confirmation.

Pairing (the owner on the dashboard, or an already verified owner session)
  1. POST /devices/pairing creates a short-lived (5 min), single-use offer. The QR code / link carries the public
     gateway address, the offer id, a 128-bit one-time code and the fingerprint of NEBULA's server key — never a
     long-term secret.
  2. The app creates two P-256 keys that never leave the device (Secure Enclave where available): an IDENTITY key
     (signs session challenges, no user interaction) and a CONFIRM key (usable only after Face ID / Touch ID / the
     device passcode). It claims the offer with both PUBLIC keys and a proof-of-possession signature by each key.
     NEBULA answers with its server public key and a signature, so the app checks it is talking to the NEBULA whose
     fingerprint was on the owner's screen.
  3. The device is PENDING until the owner approves it, comparing a 6-digit verification code shown on both screens.

Sessions: the app signs a single-use server challenge with its identity key and receives a bearer session that is
accepted only through the Mini App gateway (same central policy, role "owner", never "local"). Revoking a device ends
its sessions and deletes its vault key immediately.

Unified owner confirmation (one Face ID / Touch ID / Telegram biometric prompt instead of "remote PIN / login
password, then vault passphrase"): see `confirm`. The vault data key can be wrapped for one device with a key derived
from a 256-bit secret that only that device holds; the server never stores the secret, so the vault at rest is
exactly as strong as before.

Never stored or logged: private keys (never leave the device), session tokens (hash only), device vault secrets,
passphrases, passwords.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import threading
import time
from typing import Any
from urllib.parse import quote

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from sqlalchemy import and_, delete, func, select, update

from nebula_host import auth, db, models
from nebula_host import secrets as sec
from nebula_host.events import audit, bus

PAIRING_TTL_S = 300
PAIRING_MAX_ATTEMPTS = 5
CHALLENGE_TTL_S = 60
SESSION_TTL_S = 3600  # sliding while the app is used …
MAX_LIFETIME_S = 12 * 3600  # … and a fresh device signature at least every 12 h
MAX_DEVICES = 10
UA_PREFIX = "nebula-app"
PLATFORMS = ("ios", "macos")
PROTECTIONS = ("secure_enclave", "keychain")
SERVER_KEY_REF = "nebula:app.server_key"
PURPOSES = ("stepup", "vault_unlock", "vault_reveal", "sign_in", "approve", "admin")


class DeviceError(Exception):
    def __init__(self, status: int, code: str, message: str, **details: Any) -> None:
        super().__init__(message)
        self.status, self.code, self.message, self.details = status, code, message, details


def _b64e(b: bytes) -> str:
    return base64.b64encode(b).decode()


def _b64d(s: str, *, limit: int = 4096) -> bytes:
    if not isinstance(s, str) or len(s) > limit:
        raise ValueError("bad base64")
    return base64.b64decode(s.encode(), validate=True)


def _sha(b: bytes | str) -> str:
    return hashlib.sha256(b.encode() if isinstance(b, str) else b).hexdigest()


# ============================================================================ keys
def load_public_key(b64: str) -> ec.EllipticCurvePublicKey:
    """A P-256 public key in X9.63 uncompressed form (65 bytes, 0x04 || X || Y) — what CryptoKit's
    `x963Representation` and SecKeyCopyExternalRepresentation produce."""
    try:
        raw = _b64d(b64, limit=200)
        if len(raw) != 65 or raw[0] != 4:
            raise ValueError("not an uncompressed P-256 point")
        return ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), raw)
    except ValueError as e:
        raise DeviceError(400, "invalid_key", "the device key is not a valid P-256 public key") from e


def verify_signature(public_b64: str, payload: bytes, signature_b64: str) -> bool:
    """ECDSA P-256 / SHA-256, DER signature (CryptoKit `derRepresentation`, Security `ecdsaSignatureMessageX962SHA256`)."""
    try:
        sig = _b64d(signature_b64 or "", limit=200)
        load_public_key(public_b64).verify(sig, payload, ec.ECDSA(hashes.SHA256()))
        return True
    except (InvalidSignature, ValueError, DeviceError):
        return False


_server_key_lock = threading.Lock()
_server_key_cache: dict[str, Any] = {}


def _server_key() -> ec.EllipticCurvePrivateKey:
    """NEBULA's server identity key (P-256). Created once, kept in the macOS Keychain (secrets store); the apps pin
    its fingerprint at pairing time and verify every challenge signature with it."""
    with _server_key_lock:
        store = sec.store()
        cached = _server_key_cache.get("key")
        if cached is not None and _server_key_cache.get("store") is store:
            return cached
        pem = store.get(SERVER_KEY_REF)
        if pem:
            key = serialization.load_pem_private_key(pem.encode(), password=None)
        else:
            key = ec.generate_private_key(ec.SECP256R1())
            store.set(SERVER_KEY_REF, key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                                        serialization.NoEncryption()).decode())
        assert isinstance(key, ec.EllipticCurvePrivateKey)
        _server_key_cache.update(key=key, store=store)
        return key


def server_public_key() -> str:
    pub = _server_key().public_key().public_bytes(serialization.Encoding.X962,
                                                  serialization.PublicFormat.UncompressedPoint)
    return _b64e(pub)


def server_fingerprint() -> str:
    """First 80 bits of SHA-256 over the X9.63 public key, hex — short enough for a QR code, long enough to pin."""
    return _sha(_b64d(server_public_key()))[:20]


def _server_sign(payload: bytes) -> str:
    return _b64e(_server_key().sign(payload, ec.ECDSA(hashes.SHA256())))


def _lines(*parts: str) -> bytes:
    return "\n".join(parts).encode()


# ============================================================================ pairing
_lock = threading.RLock()
_pairings: dict[str, dict[str, Any]] = {}
_challenges: dict[str, dict[str, Any]] = {}
_attempts: dict[str, list[float]] = {}


def _limit(key: str, n: int, per_s: float) -> None:
    from nebula_host.authz import _prune

    now = time.time()
    _prune(_attempts)  # L-02: client keys may be chosen by the caller; the table stays bounded
    hits = [t for t in _attempts.get(key, []) if now - t < per_s]
    if len(hits) >= n:
        raise DeviceError(429, "rate_limited", "too many attempts — try again later",
                          retry_after=int(per_s - (now - hits[0])) + 1)
    hits.append(now)
    _attempts[key] = hits


def _gc() -> None:
    now = time.time()
    for store in (_pairings, _challenges):
        for k in [k for k, v in store.items() if v["exp"] < now - 600]:
            store.pop(k, None)


def pairing_url(public_url: str, pairing_id: str, code: str) -> str:
    return (f"nebula://pair?v=1&u={quote(public_url, safe='')}&p={pairing_id}&c={quote(code, safe='')}"
            f"&f={server_fingerprint()}")


def create_pairing(*, actor: str, public_url: str | None) -> dict[str, Any]:
    if not public_url or not public_url.startswith("https://"):
        raise DeviceError(409, "gateway_not_configured",
                          "Turn on remote access first (Settings → Remote access): the apps connect to NEBULA through "
                          "its secure HTTPS gateway, at home and away.")
    with _lock:
        _gc()
        open_offers = [p for p in _pairings.values() if p["status"] == "open" and p["exp"] > time.time()]
        if len(open_offers) >= 3:
            raise DeviceError(429, "too_many_pairings", "close an open pairing code first")
        pid = "pr_" + secrets.token_hex(8)
        code = secrets.token_urlsafe(16)
        now = time.time()
        _pairings[pid] = {"id": pid, "code_hash": _sha(code), "created_at": now, "exp": now + PAIRING_TTL_S,
                          "status": "open", "actor": actor, "device_id": None, "fails": 0}
    url = pairing_url(public_url, pid, code)
    try:
        from nebula_host import qr

        qr_svg = qr.svg(url, ecc="M", title="NEBULA – pair a device")
    except Exception:  # noqa: BLE001 - the link and the code still work without the picture
        qr_svg = None
    audit(actor, "app.pairing.created", pid, {"expires_in_s": PAIRING_TTL_S})
    return {"pairing_id": pid, "code": code, "url": url, "qr_svg": qr_svg, "expires_at": now + PAIRING_TTL_S,
            "gateway_url": public_url, "server_fingerprint": server_fingerprint()}


def pairing_status(pairing_id: str) -> dict[str, Any]:
    with _lock:
        p = _pairings.get(pairing_id)
        if p is None:
            raise DeviceError(404, "not_found", "no such pairing")
        status = p["status"] if p["status"] != "open" or p["exp"] > time.time() else "expired"
        dev = get(p["device_id"]) if p["device_id"] else None
        return {"pairing_id": pairing_id, "status": status, "expires_at": p["exp"], "device": dev}


def cancel_pairing(pairing_id: str, *, actor: str) -> dict[str, Any]:
    with _lock:
        p = _pairings.get(pairing_id)
        if p and p["status"] == "open":
            p["status"] = "cancelled"
    audit(actor, "app.pairing.cancelled", pairing_id, {})
    return {"pairing_id": pairing_id, "status": "cancelled"}


def verification_code(digest: str) -> str:
    """6 digits both screens show, so the owner can compare them before approving (detects a photographed QR code
    claimed by someone else)."""
    return f"{int(digest[:12], 16) % 1_000_000:06d}"


def _clean_name(name: Any, default: str) -> str:
    s = "".join(ch for ch in str(name or "") if ch.isprintable()).strip()
    return s[:60] or default


def claim(body: dict[str, Any], *, client: str = "") -> dict[str, Any]:
    """The app claims a pairing offer (public, through the gateway; rate-limited)."""
    pid = str(body.get("pairing_id") or "")
    code = str(body.get("code") or "")
    _limit(f"claim:{client}", 10, 600)
    platform = str(body.get("platform") or "")
    protection = str(body.get("key_protection") or "")
    if platform not in PLATFORMS or protection not in PROTECTIONS:
        raise DeviceError(400, "invalid_device", "unknown platform or key protection")
    ik, ck = str(body.get("identity_key") or ""), str(body.get("confirm_key") or "")
    load_public_key(ik)
    load_public_key(ck)
    if ik == ck:
        raise DeviceError(400, "invalid_key", "identity and confirmation keys must differ")
    with _lock:
        p = _pairings.get(pid)
        if p is None or p["status"] != "open" or p["exp"] < time.time():
            raise DeviceError(410, "pairing_expired", "this pairing code expired or was already used — show a new one")
        if not hmac.compare_digest(p["code_hash"], _sha(code)):
            p["fails"] += 1
            if p["fails"] >= PAIRING_MAX_ATTEMPTS:
                p["status"] = "burned"
            raise DeviceError(401, "bad_code", "the pairing code is not valid")
        proof = _lines("nebula-app-pair/v1", pid, ik, ck)
        if not verify_signature(ik, proof, str(body.get("identity_signature") or "")) or \
                not verify_signature(ck, proof, str(body.get("confirm_signature") or "")):
            raise DeviceError(400, "bad_proof", "the device could not prove it holds its keys")
        with db.engine().connect() as c:
            n = c.execute(select(func.count()).select_from(models.app_devices).where(
                models.app_devices.c.status.in_(("pending", "active")))).scalar() or 0
        if n >= MAX_DEVICES:
            raise DeviceError(409, "too_many_devices", f"at most {MAX_DEVICES} devices; remove one first")
        p["status"] = "claimed"
        did = "adv_" + secrets.token_hex(8)
        p["device_id"] = did
    digest = _sha(_lines("nebula-app-pair-digest/v1", pid, code, ik, ck))
    now = time.time()
    name = _clean_name(body.get("name"), "iPhone" if platform == "ios" else "Mac")
    with db.engine().begin() as c:
        c.execute(models.app_devices.insert().values(
            id=did, name=name, platform=platform, model=_clean_name(body.get("model"), "")[:60] or None,
            app_version=str(body.get("app_version") or "")[:24] or None, identity_key=ik, confirm_key=ck,
            key_protection=protection, status="pending", pairing_digest=digest, created_at=now))
    audit(f"app:{did}", "app.device.claimed", did, {"platform": platform, "key_protection": protection})
    bus.publish("app.device.changed", {"device_id": did, "status": "pending", "name": name, "platform": platform})
    ack = _lines("nebula-app-pair-ack/v1", pid, did, _sha(ik))
    return {"device_id": did, "status": "pending", "verification_code": verification_code(digest),
            "server_key": server_public_key(), "server_fingerprint": server_fingerprint(),
            "server_signature": _server_sign(ack)}


# ============================================================================ devices
def _row(device_id: str) -> dict[str, Any] | None:
    with db.engine().connect() as c:
        return db.row(c.execute(select(models.app_devices).where(models.app_devices.c.id == device_id)).first())


def _public(r: dict[str, Any], vault_keys: set[str] | None = None) -> dict[str, Any]:
    out = {k: r.get(k) for k in ("id", "name", "platform", "model", "app_version", "key_protection", "status",
                                 "created_at", "approved_at", "last_seen_at", "revoked_at")}
    out["key_fingerprint"] = _sha(_b64d(r["identity_key"]))[:16]
    out["push"] = bool(r.get("push_token"))
    if r["status"] == "pending":
        out["verification_code"] = verification_code(r["pairing_digest"])
    if vault_keys is not None:
        out["vault_key"] = r["id"] in vault_keys
    return out


def _vault_key_ids(kind: str) -> set[str]:
    from nebula_host import vault as vaultmod

    vid = vaultmod.VAULT.vault_id()
    if not vid:
        return set()
    with db.engine().connect() as c:
        return {r[0] for r in c.execute(select(models.owner_vault_keys.c.device_id).where(and_(
            models.owner_vault_keys.c.device_kind == kind, models.owner_vault_keys.c.vault_id == vid)))}


def get(device_id: str | None) -> dict[str, Any] | None:
    r = _row(device_id) if device_id else None
    return _public(r, _vault_key_ids("app")) if r else None


def list_devices() -> list[dict[str, Any]]:
    with db.engine().connect() as c:
        rows = db.rows(c.execute(select(models.app_devices).where(models.app_devices.c.status.in_(
            ("pending", "active"))).order_by(models.app_devices.c.created_at)))
    keys = _vault_key_ids("app")
    return [_public(r, keys) for r in rows]


def approve(device_id: str, *, actor: str) -> dict[str, Any]:
    with db.engine().begin() as c:
        n = c.execute(update(models.app_devices).where(and_(models.app_devices.c.id == device_id,
                                                            models.app_devices.c.status == "pending"))
                      .values(status="active", approved_at=time.time(), approved_by=actor[:64])).rowcount
    if not n:
        raise DeviceError(404, "not_found", "no pending device with this id")
    audit(actor, "app.device.approved", device_id, {})
    bus.publish("app.device.changed", {"device_id": device_id, "status": "active"})
    return get(device_id) or {}


def _end_sessions(device_id: str) -> int:
    with db.engine().begin() as c:
        return c.execute(delete(models.sessions).where(
            models.sessions.c.user_agent.like(f"{UA_PREFIX} dev={device_id} %"))).rowcount


def revoke(device_id: str, *, actor: str, reason: str = "revoked") -> dict[str, Any]:
    status = "rejected" if reason == "rejected" else "revoked"
    with db.engine().begin() as c:
        n = c.execute(update(models.app_devices).where(and_(models.app_devices.c.id == device_id,
                                                            models.app_devices.c.status.in_(("pending", "active"))))
                      .values(status=status, revoked_at=time.time(), push_token=None)).rowcount
    if not n:
        raise DeviceError(404, "not_found", "no such device")
    ended = _end_sessions(device_id)
    from nebula_host import vault as vaultmod

    vaultmod.VAULT.remove_device_key("app", device_id)
    audit(actor, f"app.device.{status}", device_id, {"sessions_ended": ended})
    bus.publish("app.device.changed", {"device_id": device_id, "status": status})
    return {"device_id": device_id, "status": status, "sessions_ended": ended}


def rename(device_id: str, name: str, *, actor: str) -> dict[str, Any]:
    with db.engine().begin() as c:
        n = c.execute(update(models.app_devices).where(and_(models.app_devices.c.id == device_id,
                                                            models.app_devices.c.status == "active"))
                      .values(name=_clean_name(name, "Device"))).rowcount
    if not n:
        raise DeviceError(404, "not_found", "no such device")
    audit(actor, "app.device.renamed", device_id, {})
    return get(device_id) or {}


def set_push_token(device_id: str, token: str | None, env: str | None) -> dict[str, Any]:
    if token is not None and (not isinstance(token, str) or not 32 <= len(token) <= 200 or
                              any(ch not in "0123456789abcdefABCDEF" for ch in token)):
        raise DeviceError(400, "invalid_token", "an APNs device token is hex")
    if env not in (None, "development", "production"):
        raise DeviceError(400, "invalid_env", "env must be development or production")
    with db.engine().begin() as c:
        c.execute(update(models.app_devices).where(models.app_devices.c.id == device_id).values(
            push_token=token.lower() if token else None, push_env=env if token else None, push_updated_at=time.time()))
    return {"push": bool(token)}


# ============================================================================ device sessions
def session_challenge(device_id: str, *, client: str = "") -> dict[str, Any]:
    _limit(f"session-challenge:{device_id}", 30, 600)
    _limit(f"session-challenge-client:{client}", 60, 600)
    r = _row(str(device_id or ""))
    if r is None or r["status"] in ("revoked", "rejected"):
        raise DeviceError(403, "device_revoked", "this device is no longer paired with NEBULA — pair it again")
    if r["status"] == "pending":
        raise DeviceError(403, "pending_approval", "waiting for the owner to approve this device on the Mac",
                          verification_code=verification_code(r["pairing_digest"]))
    with _lock:
        _gc()
        cid = secrets.token_urlsafe(18)
        challenge = _b64e(secrets.token_bytes(32))
        now = time.time()
        _challenges[cid] = {"kind": "session", "device": r["id"], "challenge": challenge, "exp": now + CHALLENGE_TTL_S}
    return {"challenge_id": cid, "challenge": challenge, "expires_at": now + CHALLENGE_TTL_S,
            "server_signature": _server_sign(_lines("nebula-app-challenge/v1", r["id"], cid, challenge))}


def _take_challenge(cid: str, *, kind: str, device_id: str, session_id: str | None = None) -> dict[str, Any]:
    with _lock:
        ch = _challenges.pop(str(cid or ""), None)
    if not ch or ch["kind"] != kind or ch["device"] != device_id or ch["exp"] < time.time() or \
            (session_id is not None and ch.get("session") != session_id):
        raise DeviceError(401, "challenge_expired", "the request expired; try again")
    return ch


def sign_in(body: dict[str, Any], *, client: str = "") -> dict[str, Any]:
    device_id = str(body.get("device_id") or "")
    _limit(f"session:{device_id}", 20, 600)
    ch = _take_challenge(str(body.get("challenge_id") or ""), kind="session", device_id=device_id)
    r = _row(device_id)
    if r is None or r["status"] != "active":
        raise DeviceError(403, "device_revoked", "this device is no longer paired with NEBULA")
    payload = _lines("nebula-app-session/v1", device_id, str(body.get("challenge_id")), ch["challenge"])
    if not verify_signature(r["identity_key"], payload, str(body.get("signature") or "")):
        audit(f"app:{device_id}", "app.session.denied", device_id, {"reason": "bad_signature"})
        raise DeviceError(401, "bad_signature", "the device signature is not valid")
    with db.engine().connect() as c:
        admin = c.execute(select(models.users.c.id).where(models.users.c.role == "admin")
                          .order_by(models.users.c.created_at)).first()
    if admin is None:
        raise DeviceError(409, "not_initialized", "NEBULA has no owner account yet")
    token, csrf, sid, now = secrets.token_urlsafe(32), secrets.token_urlsafe(24), db.new_id(), time.time()
    version = str(body.get("app_version") or "")[:24] or r.get("app_version")
    with db.engine().begin() as c:
        c.execute(models.sessions.insert().values(
            id=sid, user_id=admin.id, token_hash=auth.sha256(token), csrf_token=csrf, created_at=now,
            expires_at=now + SESSION_TTL_S, last_seen_at=now,
            user_agent=f"{UA_PREFIX} dev={device_id} plat={r['platform']}"[:256]))
        c.execute(update(models.app_devices).where(models.app_devices.c.id == device_id)
                  .values(last_seen_at=now, app_version=version))
        # at most a few live sessions per device (an app that lost its token simply signs in again)
        old = [x[0] for x in c.execute(select(models.sessions.c.id).where(
            models.sessions.c.user_agent.like(f"{UA_PREFIX} dev={device_id} %"))
            .order_by(models.sessions.c.created_at.desc()))][4:]
        if old:
            c.execute(delete(models.sessions).where(models.sessions.c.id.in_(old)))
    audit(f"app:{device_id}", "app.session", device_id, {"session_id": sid, "client": client[:80]})
    return {"token": token, "csrf_token": csrf, "session_id": sid, "expires_at": now + SESSION_TTL_S,
            "max_expires_at": now + MAX_LIFETIME_S, "device": get(device_id)}


def session_info_from_ua(ua: str) -> dict[str, Any] | None:
    """Mini-App-compatible session info for an app session (None when the device is no longer active)."""
    parts = dict(x.split("=", 1) for x in ua.split()[1:] if "=" in x)
    did = parts.get("dev") or ""
    r = _row(did)
    if r is None or r["status"] != "active":
        return None
    from nebula_host import miniapp

    return {"kind": "app", "device_id": did, "platform": r["platform"], "telegram_user_id": 0, "bot": "main",
            "permissions": sorted(set(miniapp.DEFAULT_PERMISSIONS) | {"agents"})}


def logout(session_id: str, device_id: str) -> None:
    with db.engine().begin() as c:
        c.execute(delete(models.sessions).where(and_(models.sessions.c.id == session_id,
                                                     models.sessions.c.user_agent.like(f"{UA_PREFIX} dev={device_id} %"))))
    audit(f"app:{device_id}", "app.logout", device_id, {})


# ============================================================================ unified owner confirmation
def confirm_challenge(ctx, purpose: str) -> dict[str, Any]:
    """A single-use challenge for an owner confirmation on THIS app session (signed by the device's confirm key)."""
    if ctx.interface != "app" or not ctx.device_id:
        raise DeviceError(400, "app_only", "device confirmations come from the NEBULA app")
    if purpose not in PURPOSES:
        raise DeviceError(400, "invalid_purpose", "unknown purpose")
    _limit(f"confirm-challenge:{ctx.session_id}", 30, 600)
    with _lock:
        _gc()
        cid = secrets.token_urlsafe(18)
        challenge = _b64e(secrets.token_bytes(32))
        now = time.time()
        _challenges[cid] = {"kind": "confirm", "device": ctx.device_id, "session": ctx.session_id,
                            "challenge": challenge, "purpose": purpose, "exp": now + CHALLENGE_TTL_S}
    from nebula_host import vault as vaultmod

    return {"challenge_id": cid, "challenge": challenge, "expires_at": now + CHALLENGE_TTL_S, "purpose": purpose,
            "vault_key": vaultmod.VAULT.has_device_key("app", ctx.device_id)}


def confirm_payload(device_id: str, session_id: str, challenge_id: str, challenge: str, purpose: str,
                    secret_digest: str) -> bytes:
    return _lines("nebula-owner-confirm/v1", device_id, session_id, challenge_id, challenge, purpose, secret_digest)


def confirm(ctx, principal, body: dict[str, Any]) -> dict[str, Any]:
    """ONE owner confirmation that (a) re-verifies the owner on this session (step-up, 5 min) and, when asked,
    (b) unlocks the Password Vault / re-confirms it for reveal — instead of a PIN or login password followed by the
    vault passphrase.

    methods
      app_key             the NEBULA app: confirm-key signature over a single-use challenge of THIS session (the key is
                          usable only after Face ID / Touch ID / the device passcode). With `vault_secret` (released by
                          the same biometric prompt) the vault key wrapped for this device unlocks the vault.
      telegram_biometric  the Mini App: Telegram BiometricManager token (rotates; the vault wrap follows the rotation).
      vault_passphrase    the single fallback without biometrics: the vault passphrase both unlocks the vault and
                          re-verifies the owner (it is a dedicated secret at least as strong as the login password).
      password            the NEBULA login password (step-up only; the vault stays as it is).
    `enroll_vault_key` (app_key / telegram_biometric): after the vault is unlocked, wrap the vault key for this device
    so later confirmations need no passphrase.
    """
    from nebula_host import authz
    from nebula_host import vault as vaultmod

    if not ctx.owner:
        raise DeviceError(403, "owner_only", "only the NEBULA owner can confirm this")
    method = str(body.get("method") or "")
    unlock = bool(body.get("unlock_vault"))
    enroll = bool(body.get("enroll_vault_key"))
    V = vaultmod.VAULT
    out: dict[str, Any] = {}
    sid = ctx.session_id or principal.session_id
    actor = principal.actor
    secret: bytes | None = None
    kind = device = None
    if method == "app_key":
        if ctx.interface != "app" or not ctx.device_id:
            raise DeviceError(400, "app_only", "device confirmations come from the NEBULA app")
        _limit(f"confirm:{sid}", 10, 600)
        cid = str(body.get("challenge_id") or "")
        ch = _take_challenge(cid, kind="confirm", device_id=ctx.device_id, session_id=sid)
        raw_secret = body.get("vault_secret")
        if raw_secret:
            try:
                secret = _b64d(str(raw_secret), limit=100)
            except ValueError:
                secret = b""
            if len(secret) != 32:
                raise DeviceError(400, "invalid_secret", "the device vault secret must be 32 bytes")
        digest = _sha(secret) if secret else "-"
        r = _row(ctx.device_id)
        payload = confirm_payload(ctx.device_id, sid, cid, ch["challenge"], ch["purpose"], digest)
        if r is None or r["status"] != "active" or not verify_signature(r["confirm_key"], payload,
                                                                         str(body.get("signature") or "")):
            audit(actor, "auth.confirm", ctx.device_id, {"method": method, "outcome": "denied"})
            raise DeviceError(401, "bad_signature", "this device's confirmation is not valid")
        kind, device = "app", ctx.device_id
        out["fresh_until"] = authz.mark_fresh(sid, "device")
    elif method == "telegram_biometric":
        did = str(body.get("device_id") or "")
        token = str(body.get("token") or "")
        try:
            nxt = authz.verify_biometric(ctx, did, str(body.get("challenge_id") or ""), token, actor=actor)
        except authz.Denied as d:
            raise DeviceError(d.status, d.code, d.message, **d.details) from None
        kind, device, secret = "telegram", did, token.encode()
        out["fresh_until"] = authz.mark_fresh(sid, "biometric")
        out["next_token"] = nxt
    elif method == "vault_passphrase":
        p = str(body.get("passphrase") or "")
        # L-01: per session and per account, on top of the vault's own persisted lockout
        _limit(f"confirm-vault:{sid}", 5, 600)
        _limit(f"confirm-vault-user:{principal.user_id}", 10, 900)
        try:
            if V.locked:
                V.unlock(p, actor=actor, session_id=sid)
            else:
                V.reauth(p, actor=actor, session_id=sid)
        except vaultmod.VaultError as e:
            raise DeviceError(e.status, e.code, str(e), **(e.extra or {})) from None
        out["fresh_until"] = authz.mark_fresh(sid, "vault")
        audit(actor, "auth.stepup", None, {"method": "vault_passphrase", "outcome": "ok"})
    elif method == "password":
        try:
            r = authz.stepup_password(ctx, principal, str(body.get("password") or ""), actor=actor)
        except authz.Denied as d:
            raise DeviceError(d.status, d.code, d.message, **d.details) from None
        out["fresh_until"] = r["fresh_until"]
    else:
        raise DeviceError(400, "invalid_method", "method must be app_key, telegram_biometric, vault_passphrase or "
                                                  "password")

    # ---- the vault, with the same confirmation
    vault_note = None
    passphrase = body.get("passphrase") if method in ("app_key", "telegram_biometric") else None
    if kind and device and secret is not None:
        if kind == "telegram":
            # the token rotated: the vault wrap must follow it, or it would be useless next time
            vault_note = V.rotate_device_key(kind, device, secret, out["next_token"].encode(),
                                             unlock_session=sid if unlock else None, actor=actor)
            secret = out["next_token"].encode()
        elif V.has_device_key(kind, device):
            if V.locked and unlock:
                vault_note = V.unlock_with_device(kind, device, secret, actor=actor, session_id=sid)
            elif not V.locked:
                vault_note = V.confirm_device_key(kind, device, secret, actor=actor, session_id=sid)
        if passphrase and vault_note not in ("unlocked", "confirmed"):
            # first activation on this device: the passphrase once, together with the biometric confirmation
            try:
                if V.locked:
                    V.unlock(str(passphrase), actor=actor, session_id=sid)
                    vault_note = "unlocked_passphrase"
                else:
                    V.reauth(str(passphrase), actor=actor, session_id=sid)
                    vault_note = "confirmed_passphrase"
            except vaultmod.VaultError as e:
                raise DeviceError(e.status, e.code, str(e), **(e.extra or {}), fresh_until=out["fresh_until"],
                                  **({"next_token": out["next_token"]} if "next_token" in out else {})) from None
        if enroll and not V.locked and not V.has_device_key(kind, device):
            V.enroll_device_key(kind, device, secret, actor=actor)
            vault_note = f"{vault_note}+enrolled" if vault_note else "enrolled"
    secret = None
    st = V.status()
    out["vault"] = {"exists": st["exists"], "locked": st["locked"], "entry_count": st["entry_count"],
                    "result": vault_note, "reauth_until": V.reauth_until(sid),
                    "device_key": V.has_device_key(kind, device) if kind and device else False}
    out["vault_unlock_needed"] = bool(unlock and st["exists"] and st["locked"])
    return out

