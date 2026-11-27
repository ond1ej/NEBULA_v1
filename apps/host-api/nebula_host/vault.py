"""NEBULA Password Vault V1 — local, encrypted, deny-by-default (V3.2).

Cryptography (only well-reviewed primitives, no custom algorithms)
* KEK = Argon2id(passphrase, random 16-byte per-vault salt), parameters calibrated on this Mac (~250-500 ms) and
  stored with the vault (argon2-cffi, the same library NEBULA uses for login passwords).
* DEK = 256 random bits (os.urandom). Stored only wrapped: AES-256-GCM(KEK, DEK) with a random 96-bit nonce and the
  vault id as AAD. Passphrase rotation re-wraps the DEK; records are untouched.
* Every record: AES-256-GCM(DEK, JSON{username, password, notes, login_url}) with its own random 96-bit nonce. The
  list metadata (id, type, origin, name, app, tags, record version) is bound to the ciphertext as AAD, so editing a
  metadata column in the database makes decryption fail instead of silently redirecting a credential.
* Grants and agent policies carry an HMAC-SHA256 tag keyed from the DEK: a row inserted or edited outside NEBULA (or
  while the vault is locked) never authorises anything.

Lifecycle: LOCKED at startup (keys live only in process memory), unlocked with the dedicated vault passphrase, locked
again explicitly, after N minutes without vault activity (5/15/30/60, default 15), or on service stop. Locking drops
the key material (best effort: bytearrays are overwritten; Python and the OS cannot guarantee zeroisation) and expires
outstanding credential-use approvals. Unlock attempts are rate-limited and persisted (lockout survives restarts).

Never: plaintext secrets in columns, logs, events, audit metadata, API list responses, Telegram, model prompts or tool
results. The only plaintext paths out of this module are ``reveal`` (owner, local, recent re-authentication) and
``credential_for_broker`` (the trusted login broker, after authorisation and owner approval).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import ipaddress
import json
import logging
import os
import threading
import time
import unicodedata
import uuid
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

from argon2.low_level import Type, hash_secret_raw
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy import and_, delete, func, select, update

from nebula_host import db, models
from nebula_host.events import bus

log = logging.getLogger("nebula.vault")

FORMAT_VERSION = 1
EXPORT_FORMAT = "nebula-vault-export"
MIN_PASSPHRASE = 12
MAX_PASSPHRASE = 1024
AUTO_LOCK_CHOICES = (5, 15, 30, 60)
DEFAULT_AUTO_LOCK = 15
FREE_ATTEMPTS = 5  # failed unlocks before the lockout starts
LOCKOUT_BASE_S = 60  # doubles with every further failure, capped at 1 h
REAUTH_WINDOW_S = 300  # reveal / export need a vault authentication within the last 5 minutes
APPROVAL_TTL_S = 600  # credential-use approvals are short-lived
CREDENTIAL_TYPES = ("website", "application", "api_token")
ACTIONS = ("sign_in",)  # V1: the broker only signs in; no export, password change, recovery or MFA operations
POLICIES = ("always_ask", "once_per_task", "auto")
MODES = ("NONE", "SELECTED", "MANAGED")
DISABLED_AGENT_STATES = ("PAUSED", "ERROR", "DELETING", "CREATING", "DISABLED")
KDF_TARGET_MS = (250, 500)
KDF_MEMORY_KIB = 128 * 1024  # 128 MiB for ~0.3 s during unlock only: strong, but no burden on the 16 GB host
KDF_PARALLELISM = 2
_PRIVATE_SUFFIXES = (".local", ".test", ".internal", ".lan", ".home.arpa", ".localhost")


class VaultError(Exception):
    def __init__(self, code: str, message: str, status: int = 400, **extra: Any) -> None:
        super().__init__(message)
        self.code, self.status, self.extra = code, status, extra


class VaultDenied(VaultError):
    """Credential use refused; ``code`` is a stable reason code for the audit log and the agent."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(code, message, 403)


def b64e(b: bytes) -> str:
    return base64.b64encode(b).decode("ascii")


def b64d(s: str) -> bytes:
    return base64.b64decode(s.encode("ascii"), validate=True)


def _canon(obj: Any) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def _norm_pass(p: str) -> bytes:
    return unicodedata.normalize("NFKC", p).encode("utf-8")


# ============================================================================ origins
def _host_allows_http(host: str) -> bool:
    if host in ("localhost",) or host.endswith(_PRIVATE_SUFFIXES):
        return True
    try:
        ip = ipaddress.ip_address(host.strip("[]"))
        return ip.is_loopback or ip.is_private or ip.is_link_local
    except ValueError:
        return False


def canonical_origin(value: str) -> str:
    """'HTTPS://GitHub.com:443/login?x' -> 'https://github.com'. Exact scheme, host and effective port; no userinfo;
    plain http only for local/private hosts (a password would otherwise cross the Internet unencrypted)."""
    raw = (value or "").strip()
    if not raw or len(raw) > 2000 or any(ch in raw for ch in "\\\r\n\t "):
        raise VaultError("invalid_origin", "enter a full URL such as https://github.com")
    parts = urlsplit(raw)
    scheme = (parts.scheme or "").lower()
    if scheme not in ("https", "http") or not parts.hostname:
        raise VaultError("invalid_origin", "the origin must start with https://")
    if parts.username is not None or parts.password is not None or "@" in parts.netloc:
        raise VaultError("invalid_origin", "user names or passwords inside the URL are not allowed")
    try:
        host = parts.hostname.encode("idna").decode("ascii").lower().rstrip(".")
    except UnicodeError as e:
        raise VaultError("invalid_origin", "invalid host name") from e
    if not host or any(c not in "abcdefghijklmnopqrstuvwxyz0123456789.-:[]" for c in host):
        raise VaultError("invalid_origin", "invalid host name")
    try:
        port = parts.port
    except ValueError as e:
        raise VaultError("invalid_origin", "invalid port") from e
    if scheme == "http" and not _host_allows_http(host):
        raise VaultError("insecure_origin", "plain http is only allowed for local/private hosts; use https://")
    default = 443 if scheme == "https" else 80
    hostpart = f"[{host}]" if ":" in host and not host.startswith("[") else host
    return f"{scheme}://{hostpart}" + (f":{port}" if port and port != default else "")


def is_loopback_origin(origin: str) -> bool:
    host = (urlsplit(origin).hostname or "").strip("[]")
    if host == "localhost" or host.endswith(".localhost"):
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _check_grant_origins(origins: list[str]) -> None:
    """Inside the VM, loopback is shared by every agent: any agent could serve 127.0.0.1:<port> itself and harvest a
    password typed there. Agents therefore never get credentials for loopback origins (owner-only override for tests)."""
    allow = bool((db.get_setting("vault", {}) or {}).get("allow_loopback_origins"))
    bad = [o for o in origins if is_loopback_origin(o)]
    if bad and not allow:
        raise VaultError("loopback_origin", "credentials for localhost/127.0.0.1 cannot be granted to agents: inside "
                                            "the VM any agent could serve that address")


def same_origin(url: str, origin: str) -> bool:
    try:
        return canonical_origin(url) == origin
    except VaultError:
        return False


# ============================================================================ KDF
def derive_key(passphrase: str, kdf: dict[str, Any]) -> bytes:
    if kdf.get("alg") != "argon2id":
        raise VaultError("unsupported_kdf", "unsupported key derivation")
    return hash_secret_raw(secret=_norm_pass(passphrase), salt=b64d(kdf["salt"]), time_cost=int(kdf["time_cost"]),
                           memory_cost=int(kdf["memory_kib"]), parallelism=int(kdf["parallelism"]), hash_len=32,
                           type=Type.ID)


def calibrate_kdf(target_ms: tuple[int, int] = KDF_TARGET_MS, memory_kib: int = KDF_MEMORY_KIB) -> dict[str, Any]:
    """Pick the Argon2id time cost so one derivation takes ~250-500 ms on this machine (at least 2 passes)."""
    salt = os.urandom(16)
    probe = {"alg": "argon2id", "salt": b64e(salt), "time_cost": 1, "memory_kib": memory_kib,
             "parallelism": KDF_PARALLELISM}
    t0 = time.perf_counter()
    derive_key("calibration-only", probe)
    one = max((time.perf_counter() - t0) * 1000, 1.0)
    want = (target_ms[0] + target_ms[1]) / 2
    t = max(2, min(64, round(want / one)))
    probe["time_cost"] = t
    t0 = time.perf_counter()
    derive_key("calibration-only", probe)
    ms = (time.perf_counter() - t0) * 1000
    while ms > target_ms[1] and t > 2:
        t -= 1
        ms = ms * t / (t + 1)
    probe.update(time_cost=t, salt=b64e(os.urandom(16)), calibrated_ms=round(ms))
    return probe


def _wrap(key: bytes, plaintext: bytes, aad: bytes) -> str:
    nonce = os.urandom(12)
    return b64e(nonce + AESGCM(key).encrypt(nonce, plaintext, aad))


def _unwrap(key: bytes, blob: str, aad: bytes) -> bytes:
    raw = b64d(blob)
    if len(raw) < 12 + 16:
        raise InvalidTag()
    return AESGCM(key).decrypt(raw[:12], raw[12:], aad)


def _dek_aad(vault_id: str) -> bytes:
    return b"nebula-vault/dek/v1/" + vault_id.encode()


def _entry_aad(vault_id: str, row: dict[str, Any]) -> bytes:
    return _canon({"v": FORMAT_VERSION, "vault": vault_id, "id": row["id"], "rv": int(row["record_version"]),
                   "type": row["credential_type"], "origin": row.get("origin") or "",
                   "name": row["display_name"], "app": row.get("app_name") or "",
                   "tags": sorted(row.get("tags") or [])})


def _clean_tags(tags: list[str] | None) -> list[str]:
    out: list[str] = []
    for t in tags or []:
        t = str(t).strip().lower()[:32]
        if t and all(ch.isalnum() or ch in "-_." for ch in t) and t not in out:
            out.append(t)
    return out[:10]


@dataclass
class _Keys:
    vault_id: str
    dek: bytearray
    mac: bytearray


def _zero(b: bytearray | None) -> None:
    if b is not None:
        for i in range(len(b)):
            b[i] = 0


# ============================================================================ the vault
class Vault:
    """One local vault per NEBULA installation. All methods are thread-safe; KDF work should run in a thread."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._keys: _Keys | None = None
        self.unlocked_at: float | None = None
        self.last_activity: float | None = None
        self.reauth_at: float | None = None
        # V3.3: passphrase re-confirmation per API session (the Mac's confirmation never unlocks reveal on the phone)
        self._reauth_sessions: dict[str, float] = {}

    # ------------------------------------------------------------ state
    def _meta(self, c=None) -> dict[str, Any] | None:
        q = select(models.vault_metadata).order_by(models.vault_metadata.c.created_at).limit(1)
        if c is not None:
            return db.row(c.execute(q).first())
        with db.engine().connect() as cc:
            return db.row(cc.execute(q).first())

    @property
    def locked(self) -> bool:
        return self._keys is None

    def auto_lock_minutes(self, meta: dict[str, Any] | None = None) -> int:
        meta = meta if meta is not None else self._meta()
        return int((meta or {}).get("auto_lock_minutes") or DEFAULT_AUTO_LOCK)

    def status(self) -> dict[str, Any]:
        self.check_auto_lock()
        meta = self._meta()
        with db.engine().connect() as c:
            n = c.execute(select(func.count()).select_from(models.vault_entries)
                          .where(models.vault_entries.c.deleted_at.is_(None))).scalar() or 0
        minutes = self.auto_lock_minutes(meta)
        lockout = (meta or {}).get("lockout_until")
        return {"exists": meta is not None, "locked": self.locked, "entry_count": int(n),
                "auto_lock_minutes": minutes, "unlocked_at": self.unlocked_at if not self.locked else None,
                "lock_at": (self.last_activity + minutes * 60) if not self.locked and self.last_activity else None,
                "lockout_until": lockout if lockout and lockout > time.time() else None,
                "kdf": {k: (meta or {}).get("kdf", {}).get(k) for k in ("alg", "time_cost", "memory_kib",
                                                                      "parallelism", "calibrated_ms")}
                if meta else None}

    def touch(self) -> None:
        if not self.locked:
            self.last_activity = time.time()

    def check_auto_lock(self) -> bool:
        if self.locked or self.last_activity is None:
            return False
        if time.time() - self.last_activity > self.auto_lock_minutes() * 60:
            self.lock("auto_lock", actor="system:auto_lock")
            return True
        return False

    def _require_unlocked(self) -> _Keys:
        self.check_auto_lock()
        k = self._keys
        if k is None:
            raise VaultError("vault_locked", "the vault is locked — unlock it in the local NEBULA Dashboard", 423)
        self.touch()
        return k

    def _set_keys(self, vault_id: str, dek: bytes, session_id: str | None = None) -> None:
        mac = hmac.new(dek, b"nebula-vault/mac/v1", hashlib.sha256).digest()
        old = self._keys
        self._keys = _Keys(vault_id, bytearray(dek), bytearray(mac))
        if old:
            _zero(old.dek)
            _zero(old.mac)
        now = time.time()
        self.unlocked_at = self.last_activity = self.reauth_at = now
        if session_id:
            self._reauth_sessions[session_id] = now

    # ------------------------------------------------------------ create / unlock / lock
    def create(self, passphrase: str, *, actor: str, login_password_check=None,
               session_id: str | None = None) -> dict[str, Any]:
        _check_passphrase(passphrase)
        if login_password_check and login_password_check(passphrase):
            raise VaultError("passphrase_reused", "use a dedicated vault passphrase, not your NEBULA login password")
        with self._lock:
            if self._meta() is not None:
                raise VaultError("vault_exists", "the vault already exists", 409)
            kdf = calibrate_kdf()
            kek = derive_key(passphrase, kdf)
            dek = os.urandom(32)
            vid = str(uuid.uuid4())
            now = time.time()
            with db.engine().begin() as c:
                c.execute(models.vault_metadata.insert().values(
                    vault_id=vid, version=FORMAT_VERSION, kdf=kdf, wrapped_dek=_wrap(kek, dek, _dek_aad(vid)),
                    auto_lock_minutes=DEFAULT_AUTO_LOCK, failed_attempts=0, created_at=now, updated_at=now,
                    passphrase_changed_at=now))
            self._set_keys(vid, dek, session_id)
            del kek, dek
        record(actor, "create", outcome="ok")
        self._announce()
        return self.status()

    def unlock(self, passphrase: str, *, actor: str, session_id: str | None = None) -> dict[str, Any]:
        if not isinstance(passphrase, str) or not passphrase or len(passphrase) > MAX_PASSPHRASE:
            raise VaultError("wrong_passphrase", "wrong vault passphrase", 401)
        with self._lock:
            meta = self._meta()
            if meta is None:
                raise VaultError("no_vault", "create the vault first", 404)
            now = time.time()
            if meta.get("lockout_until") and meta["lockout_until"] > now:
                wait = int(meta["lockout_until"] - now) + 1
                record(actor, "unlock", outcome="denied", reason="rate_limited")
                raise VaultError("rate_limited", f"too many wrong passphrases — try again in {wait} s", 429,
                                 retry_after=wait)
            try:
                kek = derive_key(passphrase, meta["kdf"])
                dek = _unwrap(kek, meta["wrapped_dek"], _dek_aad(meta["vault_id"]))
            except (InvalidTag, ValueError):
                left = self._count_failure(meta)
                record(actor, "unlock", outcome="denied", reason="wrong_passphrase")
                raise VaultError("wrong_passphrase", "wrong vault passphrase", 401, attempts_left=left) from None
            with db.engine().begin() as c:
                c.execute(update(models.vault_metadata).where(models.vault_metadata.c.vault_id == meta["vault_id"])
                          .values(failed_attempts=0, lockout_until=None, updated_at=now))
            self._set_keys(meta["vault_id"], dek, session_id)
            del kek, dek
        record(actor, "unlock", outcome="ok")
        self._announce()
        return self.status()

    def _check_lockout(self, meta: dict[str, Any], op: str, actor: str) -> None:
        now = time.time()
        if meta.get("lockout_until") and meta["lockout_until"] > now:
            wait = int(meta["lockout_until"] - now) + 1
            record(actor, op, outcome="denied", reason="rate_limited")
            raise VaultError("rate_limited", f"too many wrong passphrases — try again in {wait} s", 429,
                             retry_after=wait)

    def _count_failure(self, meta: dict[str, Any]) -> int:
        """Persist one more wrong passphrase (shared by unlock, re-confirmation and rotation: L-01). Returns the
        number of attempts left before the (doubling) lockout. The counter is incremented in the database by one
        UPDATE (failed_attempts = failed_attempts + 1), which also takes the write lock, so concurrent wrong guesses
        from different paths or threads are never undercounted; the lockout is derived from the new value in the same
        transaction."""
        now = time.time()
        vm = models.vault_metadata
        with db.engine().begin() as c:
            c.execute(update(vm).where(vm.c.vault_id == meta["vault_id"])
                      .values(failed_attempts=func.coalesce(vm.c.failed_attempts, 0) + 1, updated_at=now))
            fails = int(c.execute(select(vm.c.failed_attempts).where(vm.c.vault_id == meta["vault_id"])).scalar() or 0)
            if fails >= FREE_ATTEMPTS:
                until = now + min(3600, LOCKOUT_BASE_S * 2 ** (fails - FREE_ATTEMPTS))
                c.execute(update(vm).where(vm.c.vault_id == meta["vault_id"]).values(lockout_until=until))
        return max(0, FREE_ATTEMPTS - fails)

    def _clear_failures(self, meta: dict[str, Any]) -> None:
        if meta.get("failed_attempts") or meta.get("lockout_until"):
            with db.engine().begin() as c:
                c.execute(update(models.vault_metadata).where(models.vault_metadata.c.vault_id == meta["vault_id"])
                          .values(failed_attempts=0, lockout_until=None, updated_at=time.time()))

    def reauth(self, passphrase: str, *, actor: str, session_id: str | None = None) -> dict[str, Any]:
        """Re-confirm the passphrase while unlocked (needed for reveal/export after 5 minutes). Wrong passphrases
        count towards the same persisted lockout as unlock (L-01)."""
        self._require_unlocked()
        meta = self._meta()
        self._check_lockout(meta, "reauth", actor)
        try:
            kek = derive_key(passphrase or "", meta["kdf"])
            _unwrap(kek, meta["wrapped_dek"], _dek_aad(meta["vault_id"]))
        except (InvalidTag, ValueError, TypeError):
            left = self._count_failure(meta)
            record(actor, "reauth", outcome="denied", reason="wrong_passphrase")
            raise VaultError("wrong_passphrase", "wrong vault passphrase", 401, attempts_left=left) from None
        self._clear_failures(meta)
        self.reauth_at = time.time()
        if session_id:
            self._reauth_sessions[session_id] = self.reauth_at
        record(actor, "reauth", outcome="ok")
        return {"reauth_until": self.reauth_at + REAUTH_WINDOW_S}

    def _require_recent_auth(self, session_id: str | None = None) -> None:
        at = self._reauth_sessions.get(session_id) if session_id else self.reauth_at
        if not at or time.time() - at > REAUTH_WINDOW_S:
            raise VaultError("reauth_required", "confirm the vault passphrase again to continue", 403)

    def lock(self, reason: str = "owner", *, actor: str = "system") -> dict[str, Any]:
        with self._lock:
            was_unlocked = self._keys is not None
            k, self._keys = self._keys, None
            if k:
                _zero(k.dek)
                _zero(k.mac)
            self.unlocked_at = self.last_activity = self.reauth_at = None
            self._reauth_sessions.clear()
        try:
            expired = expire_pending_approvals(reason)
        except RuntimeError:  # database not initialised (CLI/tests): nothing can be pending
            expired = 0
        if was_unlocked:
            record(actor, "lock", outcome="ok", reason=reason)
            self._announce()
        return {"locked": True, "expired_approvals": expired}

    def set_auto_lock(self, minutes: int, *, actor: str) -> dict[str, Any]:
        if minutes not in AUTO_LOCK_CHOICES:
            raise VaultError("invalid_timeout", f"auto-lock must be one of {AUTO_LOCK_CHOICES} minutes")
        meta = self._meta()
        if meta is None:
            raise VaultError("no_vault", "create the vault first", 404)
        with db.engine().begin() as c:
            c.execute(update(models.vault_metadata).where(models.vault_metadata.c.vault_id == meta["vault_id"])
                      .values(auto_lock_minutes=minutes, updated_at=time.time()))
        record(actor, "settings", outcome="ok", reason=f"auto_lock_{minutes}m")
        return self.status()

    def rotate(self, old: str, new: str, *, actor: str, login_password_check=None,
               session_id: str | None = None) -> dict[str, Any]:
        _check_passphrase(new)
        if login_password_check and login_password_check(new):
            raise VaultError("passphrase_reused", "use a dedicated vault passphrase, not your NEBULA login password")
        with self._lock:
            meta = self._meta()
            if meta is None:
                raise VaultError("no_vault", "create the vault first", 404)
            self._check_lockout(meta, "rotate_passphrase", actor)
            try:
                dek = _unwrap(derive_key(old or "", meta["kdf"]), meta["wrapped_dek"], _dek_aad(meta["vault_id"]))
            except (InvalidTag, ValueError):
                left = self._count_failure(meta)
                record(actor, "rotate_passphrase", outcome="denied", reason="wrong_passphrase")
                raise VaultError("wrong_passphrase", "the current vault passphrase is wrong", 401,
                                 attempts_left=left) from None
            kdf = calibrate_kdf()
            wrapped = _wrap(derive_key(new, kdf), dek, _dek_aad(meta["vault_id"]))
            now = time.time()
            with db.engine().begin() as c:
                c.execute(update(models.vault_metadata).where(models.vault_metadata.c.vault_id == meta["vault_id"])
                          .values(kdf=kdf, wrapped_dek=wrapped, updated_at=now, passphrase_changed_at=now,
                                  failed_attempts=0, lockout_until=None))
            self._set_keys(meta["vault_id"], dek, session_id)
            del dek
        record(actor, "rotate_passphrase", outcome="ok")
        self._announce()
        return self.status()

    # ------------------------------------------------------------ V4.0: device-wrapped vault key (unified owner auth)
    def vault_id(self) -> str | None:
        k = self._keys
        if k is not None:
            return k.vault_id
        meta = self._meta()
        return meta["vault_id"] if meta else None

    @staticmethod
    def _device_kek(secret: bytes, salt: bytes, vault_id: str, kind: str, device_id: str) -> bytes:
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.kdf.hkdf import HKDF

        info = f"nebula-vault/device-kek/v1/{vault_id}/{kind}/{device_id}".encode()
        return HKDF(algorithm=hashes.SHA256(), length=32, salt=salt, info=info).derive(secret)

    @staticmethod
    def _device_aad(vault_id: str, kind: str, device_id: str) -> bytes:
        return f"nebula-vault/device-dek/v1/{vault_id}/{kind}/{device_id}".encode()

    def _device_row(self, kind: str, device_id: str) -> dict[str, Any] | None:
        vid = self.vault_id()
        if not vid or not kind or not device_id:
            return None
        with db.engine().connect() as c:
            return db.row(c.execute(select(models.owner_vault_keys).where(and_(
                models.owner_vault_keys.c.device_kind == kind, models.owner_vault_keys.c.device_id == device_id,
                models.owner_vault_keys.c.vault_id == vid))).first())

    def has_device_key(self, kind: str | None, device_id: str | None) -> bool:
        try:
            return self._device_row(kind or "", device_id or "") is not None
        except RuntimeError:  # database not initialised
            return False

    def _store_device_wrap(self, kind: str, device_id: str, secret: bytes, dek: bytes, vault_id: str) -> None:
        if not isinstance(secret, (bytes, bytearray)) or len(secret) < 32:
            raise VaultError("invalid_secret", "the device secret is too short")
        salt = os.urandom(16)
        wrapped = _wrap(self._device_kek(bytes(secret), salt, vault_id, kind, device_id), dek,
                        self._device_aad(vault_id, kind, device_id))
        now = time.time()
        with db.engine().begin() as c:
            c.execute(delete(models.owner_vault_keys).where(and_(models.owner_vault_keys.c.device_kind == kind,
                                                                 models.owner_vault_keys.c.device_id == device_id)))
            c.execute(models.owner_vault_keys.insert().values(
                id="ovk_" + uuid.uuid4().hex[:16], device_kind=kind, device_id=device_id, vault_id=vault_id,
                salt=b64e(salt), wrapped_dek=wrapped, created_at=now, last_used_at=now))

    def _open_device_wrap(self, kind: str, device_id: str, secret: bytes, *, actor: str) -> tuple[bytes, str] | None:
        r = self._device_row(kind, device_id)
        if r is None:
            return None
        try:
            dek = _unwrap(self._device_kek(bytes(secret), b64d(r["salt"]), r["vault_id"], kind, device_id),
                          r["wrapped_dek"], self._device_aad(r["vault_id"], kind, device_id))
        except (InvalidTag, ValueError, TypeError):
            # a 256-bit device secret cannot be guessed: a mismatch means a reinstalled app / reset token / tampering.
            # The stale wrap is removed; the owner unlocks once with the passphrase and enrols the device again.
            self.remove_device_key(kind, device_id)
            record(actor, "unlock.device", outcome="denied", reason="device_key_invalid")
            return None
        with db.engine().begin() as c:
            c.execute(update(models.owner_vault_keys).where(models.owner_vault_keys.c.id == r["id"])
                      .values(last_used_at=time.time()))
        return dek, r["vault_id"]

    def enroll_device_key(self, kind: str, device_id: str, secret: bytes, *, actor: str) -> None:
        """Wrap the (unlocked) vault key for one owner device. Requires the vault to be unlocked right now."""
        k = self._require_unlocked()
        self._store_device_wrap(kind, device_id, secret, bytes(k.dek), k.vault_id)
        record(actor, "device_key.enrolled", outcome="ok", reason=kind)

    def unlock_with_device(self, kind: str, device_id: str, secret: bytes, *, actor: str,
                           session_id: str | None = None) -> str | None:
        with self._lock:
            got = self._open_device_wrap(kind, device_id, secret, actor=actor)
            if got is None:
                return "device_key_invalid" if not self.has_device_key(kind, device_id) else None
            dek, vid = got
            meta = self._meta()
            if meta is None or meta["vault_id"] != vid:
                return None
            self._set_keys(vid, dek, session_id)
            del dek
        record(actor, "unlock", outcome="ok", reason=f"device_{kind}")
        self._announce()
        return "unlocked"

    def confirm_device_key(self, kind: str, device_id: str, secret: bytes, *, actor: str,
                           session_id: str | None = None) -> str | None:
        """While unlocked: the device proved it holds its vault key → counts as the vault re-confirmation on this
        session (reveal / export window)."""
        k = self._require_unlocked()
        got = self._open_device_wrap(kind, device_id, secret, actor=actor)
        if got is None or not hmac.compare_digest(got[0], bytes(k.dek)):
            return "device_key_invalid"
        self.reauth_at = time.time()
        if session_id:
            self._reauth_sessions[session_id] = self.reauth_at
        record(actor, "reauth", outcome="ok", reason=f"device_{kind}")
        return "confirmed"

    def rotate_device_key(self, kind: str, device_id: str, old_secret: bytes, new_secret: bytes, *, actor: str,
                          unlock_session: str | None = None) -> str | None:
        """Telegram biometric tokens rotate on every use: move this device's wrap to the new token (and unlock the
        vault with it when `unlock_session` is set and the vault is locked)."""
        if not self.has_device_key(kind, device_id):
            return None
        with self._lock:
            got = self._open_device_wrap(kind, device_id, old_secret, actor=actor)
            if got is None:
                return "device_key_invalid"
            dek, vid = got
            self._store_device_wrap(kind, device_id, new_secret, dek, vid)
            note = "rewrapped"
            meta = self._meta()
            if meta is not None and meta["vault_id"] == vid:
                if self.locked and unlock_session:
                    self._set_keys(vid, dek, unlock_session)
                    note = "unlocked"
                elif not self.locked and unlock_session and hmac.compare_digest(dek, bytes(self._keys.dek)):
                    self.reauth_at = time.time()
                    self._reauth_sessions[unlock_session] = self.reauth_at
                    note = "confirmed"
            del dek
        if note == "unlocked":
            record(actor, "unlock", outcome="ok", reason=f"device_{kind}")
            self._announce()
        elif note == "confirmed":
            record(actor, "reauth", outcome="ok", reason=f"device_{kind}")
        return note

    def remove_device_key(self, kind: str, device_id: str) -> None:
        try:
            with db.engine().begin() as c:
                c.execute(delete(models.owner_vault_keys).where(and_(
                    models.owner_vault_keys.c.device_kind == kind, models.owner_vault_keys.c.device_id == device_id)))
        except RuntimeError:
            pass

    def reauth_until(self, session_id: str | None) -> float | None:
        at = self._reauth_sessions.get(session_id) if session_id else self.reauth_at
        return at + REAUTH_WINDOW_S if at and not self.locked else None

    def _announce(self) -> None:
        s = self.status()
        bus.publish("vault.status.changed", {"exists": s["exists"], "locked": s["locked"],
                                             "entry_count": s["entry_count"]})

    # ------------------------------------------------------------ entries
    def _entry_row(self, entry_id: str, c=None) -> dict[str, Any]:
        q = select(models.vault_entries).where(and_(models.vault_entries.c.id == entry_id,
                                                    models.vault_entries.c.deleted_at.is_(None)))
        if c is not None:
            r = db.row(c.execute(q).first())
        else:
            with db.engine().connect() as cc:
                r = db.row(cc.execute(q).first())
        if not r:
            raise VaultError("entry_not_found", "no such credential", 404)
        return r

    def _encrypt(self, k: _Keys, row: dict[str, Any], secret: dict[str, Any]) -> tuple[str, str]:
        nonce = os.urandom(12)
        ct = AESGCM(bytes(k.dek)).encrypt(nonce, _canon(secret), _entry_aad(k.vault_id, row))
        return b64e(ct), b64e(nonce)

    def _decrypt(self, k: _Keys, row: dict[str, Any]) -> dict[str, Any]:
        try:
            pt = AESGCM(bytes(k.dek)).decrypt(b64d(row["nonce"]), b64d(row["encrypted_payload"]),
                                              _entry_aad(k.vault_id, row))
        except (InvalidTag, ValueError) as e:
            raise VaultError("integrity_error", "this credential failed its integrity check (tampered or corrupt)",
                             500) from e
        return json.loads(pt)

    def _validate_fields(self, f: dict[str, Any], *, partial: bool = False) -> dict[str, Any]:
        out: dict[str, Any] = {}
        if "credential_type" in f or not partial:
            t = f.get("credential_type") or "website"
            if t not in CREDENTIAL_TYPES:
                raise VaultError("invalid_type", f"credential_type must be one of {CREDENTIAL_TYPES}")
            out["credential_type"] = t
        if "display_name" in f or not partial:
            name = str(f.get("display_name") or "").strip()
            if not name or len(name) > 200:
                raise VaultError("invalid_name", "a display name (1-200 characters) is required")
            out["display_name"] = name
        if "app_name" in f:
            out["app_name"] = str(f.get("app_name") or "").strip()[:200]
        if "origin" in f or not partial:
            o = f.get("origin")
            out["origin"] = canonical_origin(o) if o else None
        if "tags" in f:
            out["tags"] = _clean_tags(f.get("tags"))
        for key, limit in (("username", 512), ("password", 4096), ("notes", 4000), ("login_url", 2000)):
            if key in f and f[key] is not None:
                v = str(f[key])
                if len(v) > limit:
                    raise VaultError("too_long", f"{key} is too long (max {limit})")
                out[key] = v
        return out

    def add_entry(self, fields: dict[str, Any], *, actor: str) -> dict[str, Any]:
        k = self._require_unlocked()
        v = self._validate_fields(fields)
        if v["credential_type"] == "website" and not v.get("origin"):
            raise VaultError("origin_required", "website credentials need the site's origin (https://…)")
        if v.get("login_url") and v.get("origin") and not same_origin(v["login_url"], v["origin"]):
            raise VaultError("login_url_origin", "the sign-in page must be on the credential's origin")
        now = time.time()
        row = {"id": str(uuid.uuid4()), "vault_id": k.vault_id, "display_name": v["display_name"],
               "app_name": v.get("app_name", ""), "origin": v.get("origin"), "credential_type": v["credential_type"],
               "tags": v.get("tags", []), "record_version": 1, "created_at": now, "updated_at": now}
        secret = {"username": v.get("username", ""), "password": v.get("password", ""), "notes": v.get("notes", ""),
                  "login_url": v.get("login_url", "")}
        row["encrypted_payload"], row["nonce"] = self._encrypt(k, row, secret)
        del secret
        with db.engine().begin() as c:
            c.execute(models.vault_entries.insert().values(**row))
        record(actor, "entry.create", entry_id=row["id"], outcome="ok")
        self._announce()
        return self.public_entry(row)

    def update_entry(self, entry_id: str, fields: dict[str, Any], *, actor: str) -> dict[str, Any]:
        k = self._require_unlocked()
        with self._lock:
            row = self._entry_row(entry_id)
            secret = self._decrypt(k, row)
            v = self._validate_fields(fields, partial=True)
            for key in ("display_name", "app_name", "origin", "credential_type", "tags"):
                if key in v:
                    row[key] = v[key]
            if row["credential_type"] == "website" and not row.get("origin"):
                raise VaultError("origin_required", "website credentials need the site's origin (https://…)")
            for key in ("username", "password", "notes", "login_url"):
                if key in v:
                    secret[key] = v[key]
            if secret.get("login_url") and row.get("origin") and not same_origin(secret["login_url"], row["origin"]):
                raise VaultError("login_url_origin", "the sign-in page must be on the credential's origin")
            row["record_version"] = int(row["record_version"]) + 1
            row["updated_at"] = time.time()
            row["encrypted_payload"], row["nonce"] = self._encrypt(k, row, secret)
            del secret
            with db.engine().begin() as c:
                c.execute(update(models.vault_entries).where(models.vault_entries.c.id == entry_id).values(
                    **{x: row[x] for x in ("display_name", "app_name", "origin", "credential_type", "tags",
                                           "record_version", "updated_at", "encrypted_payload", "nonce")}))
                if "origin" in v:  # grants pinned to the old origin must be re-confirmed by the owner
                    for g in c.execute(select(models.vault_agent_grants).where(
                            models.vault_agent_grants.c.vault_entry_id == entry_id)):
                        if row.get("origin") not in (g.allowed_origins or []):
                            c.execute(update(models.vault_agent_grants).where(models.vault_agent_grants.c.id == g.id)
                                      .values(enabled=False, mac=None, updated_at=time.time()))
        record(actor, "entry.update", entry_id=entry_id, outcome="ok")
        self._announce()
        return self.public_entry(row)

    def match_entry(self, origin: str, username: str) -> str | None:
        """The id of a website credential for exactly this origin and username, or None.
        In-process comparison only (vault unlocked); nothing is revealed or returned besides the id (V3.4: a second
        save of the same account updates it instead of creating a duplicate; other usernames stay separate)."""
        k = self._require_unlocked()
        if not username:
            return None  # without a username nothing identifies "the same account": a new credential is added
        with db.engine().connect() as c:
            rows = db.rows(c.execute(select(models.vault_entries).where(and_(
                models.vault_entries.c.deleted_at.is_(None), models.vault_entries.c.origin == origin,
                models.vault_entries.c.credential_type == "website"))))
        for row in rows:
            try:
                sec = self._decrypt(k, row)
            except Exception:  # noqa: BLE001 - a damaged row is never matched
                continue
            try:
                if (sec.get("username") or "") == (username or ""):
                    return row["id"]
            finally:
                sec.clear()
        return None

    def delete_entry(self, entry_id: str, *, actor: str) -> dict[str, Any]:
        self._entry_row(entry_id)
        now = time.time()
        with db.engine().begin() as c:
            n = c.execute(delete(models.vault_agent_grants).where(
                models.vault_agent_grants.c.vault_entry_id == entry_id)).rowcount
            # the ciphertext is destroyed, the row stays as a tombstone for the audit trail
            c.execute(update(models.vault_entries).where(models.vault_entries.c.id == entry_id)
                      .values(deleted_at=now, updated_at=now, encrypted_payload="", nonce=""))
        record(actor, "entry.delete", entry_id=entry_id, outcome="ok", reason=f"grants_revoked_{n}")
        self._announce()
        return {"deleted": True, "grants_revoked": n}

    def public_entry(self, row: dict[str, Any], grant_count: int | None = None) -> dict[str, Any]:
        out = {k: row.get(k) for k in ("id", "display_name", "app_name", "origin", "credential_type", "created_at",
                                       "updated_at")}
        out["tags"] = list(row.get("tags") or [])
        if grant_count is not None:
            out["grant_count"] = grant_count
        return out

    def list_entries(self, q: str | None = None) -> list[dict[str, Any]]:
        """Metadata only (works while locked)."""
        with db.engine().connect() as c:
            rows = db.rows(c.execute(select(models.vault_entries).where(models.vault_entries.c.deleted_at.is_(None))
                                     .order_by(func.lower(models.vault_entries.c.display_name))))
            counts = dict(c.execute(select(models.vault_agent_grants.c.vault_entry_id, func.count())
                                    .group_by(models.vault_agent_grants.c.vault_entry_id)).all())
        if q:
            ql = q.strip().lower()
            rows = [r for r in rows if ql in r["display_name"].lower() or ql in (r.get("app_name") or "").lower() or
                    ql in (r.get("origin") or "") or any(ql in t for t in (r.get("tags") or []))]
        return [self.public_entry(r, int(counts.get(r["id"], 0))) for r in rows]

    def entry_detail(self, entry_id: str) -> dict[str, Any]:
        """Owner view: metadata + username (never the password) while unlocked."""
        k = self._require_unlocked()
        row = self._entry_row(entry_id)
        s = self._decrypt(k, row)
        out = self.public_entry(row)
        out.update(username=s.get("username", ""), has_password=bool(s.get("password")),
                   has_notes=bool(s.get("notes")), login_url=s.get("login_url", ""))
        return out

    def reveal(self, entry_id: str, *, actor: str, field: str = "password",
               session_id: str | None = None) -> dict[str, Any]:
        if field not in ("password", "notes", "username"):
            raise VaultError("invalid_field", "field must be password, username or notes")
        k = self._require_unlocked()
        self._require_recent_auth(session_id)
        row = self._entry_row(entry_id)
        s = self._decrypt(k, row)
        record(actor, f"reveal.{field}", entry_id=entry_id, outcome="ok")
        return {"id": entry_id, "field": field, "value": s.get(field, "")}

    # ------------------------------------------------------------ export / import
    def export(self, export_passphrase: str, *, actor: str, session_id: str | None = None) -> dict[str, Any]:
        _check_passphrase(export_passphrase)
        k = self._require_unlocked()
        self._require_recent_auth(session_id)
        with db.engine().connect() as c:
            rows = db.rows(c.execute(select(models.vault_entries).where(models.vault_entries.c.deleted_at.is_(None))))
        entries = []
        for r in rows:
            meta = self.public_entry(r)
            meta.pop("id")
            entries.append({**meta, "secret": self._decrypt(k, r)})
        kdf = calibrate_kdf()
        header = {"format": EXPORT_FORMAT, "version": FORMAT_VERSION, "created_at": time.time(), "kdf": kdf,
                  "entry_count": len(entries)}
        key = derive_key(export_passphrase, kdf)
        nonce = os.urandom(12)
        ct = AESGCM(key).encrypt(nonce, _canon({"entries": entries}), _canon(header))
        del entries, key
        record(actor, "export", outcome="ok", reason=f"entries_{header['entry_count']}")
        return {"header": header, "nonce": b64e(nonce), "ciphertext": b64e(ct)}

    @staticmethod
    def inspect_export(blob: dict[str, Any], export_passphrase: str) -> list[dict[str, Any]]:
        """Validate format + integrity and return the entries (plaintext stays inside the backend)."""
        try:
            header = blob["header"]
            if header.get("format") != EXPORT_FORMAT or int(header.get("version", 0)) != FORMAT_VERSION:
                raise VaultError("bad_export", "not a NEBULA vault export (or an unsupported version)")
            key = derive_key(export_passphrase or "", header["kdf"])
            pt = AESGCM(key).decrypt(b64d(blob["nonce"]), b64d(blob["ciphertext"]), _canon(header))
        except VaultError:
            raise
        except (InvalidTag, KeyError, ValueError, TypeError) as e:
            raise VaultError("bad_export", "wrong export passphrase or the file was modified", 400) from e
        data = json.loads(pt)
        if len(data.get("entries", [])) != int(header.get("entry_count", -1)):
            raise VaultError("bad_export", "entry count mismatch")
        return data["entries"]

    def import_(self, blob: dict[str, Any], export_passphrase: str, *, actor: str, confirm: bool) -> dict[str, Any]:
        if not confirm:
            raise VaultError("confirm_required", "importing adds credentials to this vault; confirm=true required")
        self._require_unlocked()
        self._require_recent_auth()
        entries = self.inspect_export(blob, export_passphrase)
        n = 0
        for e in entries:
            s = e.get("secret") or {}
            self.add_entry({"display_name": e.get("display_name"), "app_name": e.get("app_name"),
                            "origin": e.get("origin"), "credential_type": e.get("credential_type"),
                            "tags": e.get("tags"), **{x: s.get(x) for x in ("username", "password", "notes",
                                                                             "login_url")}}, actor=actor)
            n += 1
        del entries
        record(actor, "import", outcome="ok", reason=f"entries_{n}")
        return {"imported": n}

    # ------------------------------------------------------------ grants (deny by default)
    def _mac(self, k: _Keys, obj: dict[str, Any]) -> str:
        return hmac.new(bytes(k.mac), _canon(obj), hashlib.sha256).hexdigest()

    @staticmethod
    def _grant_fields(g: dict[str, Any]) -> dict[str, Any]:
        return {"id": g["id"], "entry": g["vault_entry_id"], "agent": g["agent_id"],
                "actions": sorted(g["allowed_actions"] or []), "origins": sorted(g["allowed_origins"] or []),
                "policy": g["approval_policy"], "enabled": bool(g["enabled"]), "expires_at": g.get("expires_at")}

    @staticmethod
    def _policy_fields(p: dict[str, Any]) -> dict[str, Any]:
        return {"agent": p["agent_id"], "mode": p["mode"], "tags": sorted(p.get("managed_tags") or [])}

    def agent_policy(self, agent_id: str) -> dict[str, Any]:
        with db.engine().connect() as c:
            p = db.row(c.execute(select(models.vault_agent_policies)
                                 .where(models.vault_agent_policies.c.agent_id == agent_id)).first())
        return p or {"agent_id": agent_id, "mode": "NONE", "managed_tags": [], "mac": None, "updated_at": None}

    def set_agent_mode(self, agent_id: str, mode: str, managed_tags: list[str] | None, *, actor: str) -> dict[str, Any]:
        if mode not in MODES:
            raise VaultError("invalid_mode", f"mode must be one of {MODES}")
        tags = _clean_tags(managed_tags) if mode == "MANAGED" else []
        if mode == "MANAGED" and not tags:
            raise VaultError("tags_required", "managed access needs at least one collection tag")
        now = time.time()
        if mode == "NONE":  # revoking never needs the key
            with db.engine().begin() as c:
                c.execute(delete(models.vault_agent_policies).where(models.vault_agent_policies.c.agent_id == agent_id))
                c.execute(update(models.vault_agent_grants).where(models.vault_agent_grants.c.agent_id == agent_id)
                          .values(enabled=False, mac=None, updated_at=now))
            record(actor, "agent.mode", agent_id=agent_id, outcome="ok", reason="NONE")
            return self.agent_view(agent_id)
        k = self._require_unlocked()
        with db.engine().connect() as c:
            if not c.execute(select(models.agents.c.id).where(models.agents.c.id == agent_id)).first():
                raise VaultError("agent_not_found", "no such agent", 404)
        row = {"agent_id": agent_id, "mode": mode, "managed_tags": tags, "updated_at": now}
        row["mac"] = self._mac(k, self._policy_fields(row))
        with db.engine().begin() as c:
            c.execute(delete(models.vault_agent_policies).where(models.vault_agent_policies.c.agent_id == agent_id))
            c.execute(models.vault_agent_policies.insert().values(**row))
        record(actor, "agent.mode", agent_id=agent_id, outcome="ok", reason=mode)
        return self.agent_view(agent_id)

    def create_grant(self, agent_id: str, entry_id: str, *, origins: list[str] | None, actions: list[str] | None,
                     policy: str = "always_ask", expires_at: float | None = None, actor: str) -> dict[str, Any]:
        k = self._require_unlocked()
        pol = self.agent_policy(agent_id)
        if pol["mode"] == "NONE":
            raise VaultError("agent_vault_disabled", "enable vault access for this agent first", 409)
        entry = self._entry_row(entry_id)
        if entry["credential_type"] != "website":
            raise VaultError("not_injectable", "only website credentials can be used by agents (sign-in) in this "
                                               "version")
        acts = sorted(set(actions or ["sign_in"]))
        if not acts or any(a not in ACTIONS for a in acts):
            raise VaultError("invalid_action", f"allowed actions: {ACTIONS}")
        orgs = sorted({canonical_origin(o) for o in (origins or [entry["origin"]])})
        if entry["origin"] not in orgs:
            raise VaultError("origin_mismatch", "a grant must include the credential's own origin")
        _check_grant_origins(orgs)
        if policy not in POLICIES:
            raise VaultError("invalid_policy", f"approval policy must be one of {POLICIES}")
        if policy == "auto" and (acts != ["sign_in"] or len(orgs) != 1):
            raise VaultError("auto_too_broad", "automatic use is only possible for sign-in to exactly one origin")
        if expires_at is not None and expires_at <= time.time():
            raise VaultError("invalid_expiry", "the expiry must be in the future")
        now = time.time()
        g = {"id": "vg_" + uuid.uuid4().hex[:24], "vault_entry_id": entry_id, "agent_id": agent_id,
             "allowed_actions": acts, "allowed_origins": orgs, "approval_policy": policy, "enabled": True,
             "expires_at": expires_at, "created_by": actor[:64], "created_at": now, "updated_at": now}
        g["mac"] = self._mac(k, self._grant_fields(g))
        with db.engine().begin() as c:
            c.execute(models.vault_agent_grants.insert().values(**g))
        record(actor, "grant.create", agent_id=agent_id, entry_id=entry_id, outcome="ok", reason=policy)
        return self.public_grant(g, entry)

    def update_grant(self, grant_id: str, *, actor: str, **changes: Any) -> dict[str, Any]:
        k = self._require_unlocked()
        g = self._grant_row(grant_id)
        entry = self._entry_row(g["vault_entry_id"])
        if "origins" in changes and changes["origins"] is not None:
            g["allowed_origins"] = sorted({canonical_origin(o) for o in changes["origins"]})
            if entry["origin"] not in g["allowed_origins"]:
                raise VaultError("origin_mismatch", "a grant must include the credential's own origin")
            _check_grant_origins(g["allowed_origins"])
        if changes.get("policy") is not None:
            if changes["policy"] not in POLICIES:
                raise VaultError("invalid_policy", f"approval policy must be one of {POLICIES}")
            g["approval_policy"] = changes["policy"]
        if "expires_at" in changes:
            if changes["expires_at"] is not None and changes["expires_at"] <= time.time():
                raise VaultError("invalid_expiry", "the expiry must be in the future")
            g["expires_at"] = changes["expires_at"]
        if changes.get("enabled") is not None:
            g["enabled"] = bool(changes["enabled"])
        if g["approval_policy"] == "auto" and (sorted(g["allowed_actions"]) != ["sign_in"] or
                                               len(g["allowed_origins"]) != 1):
            raise VaultError("auto_too_broad", "automatic use is only possible for sign-in to exactly one origin")
        g["updated_at"] = time.time()
        g["mac"] = self._mac(k, self._grant_fields(g))
        with db.engine().begin() as c:
            c.execute(update(models.vault_agent_grants).where(models.vault_agent_grants.c.id == grant_id).values(
                **{x: g[x] for x in ("allowed_origins", "approval_policy", "expires_at", "enabled", "updated_at",
                                     "mac")}))
        record(actor, "grant.update", agent_id=g["agent_id"], entry_id=g["vault_entry_id"], outcome="ok")
        return self.public_grant(g, entry)

    def revoke_grant(self, grant_id: str, *, actor: str) -> dict[str, Any]:
        """Protective: works while locked (the row loses its MAC, so it can never authorise again)."""
        g = self._grant_row(grant_id)
        with db.engine().begin() as c:
            c.execute(update(models.vault_agent_grants).where(models.vault_agent_grants.c.id == grant_id)
                      .values(enabled=False, mac=None, updated_at=time.time()))
        record(actor, "grant.revoke", agent_id=g["agent_id"], entry_id=g["vault_entry_id"], outcome="ok")
        g.update(enabled=False)
        return self.public_grant(g)

    def delete_grant(self, grant_id: str, *, actor: str) -> dict[str, Any]:
        g = self._grant_row(grant_id)
        with db.engine().begin() as c:
            c.execute(delete(models.vault_agent_grants).where(models.vault_agent_grants.c.id == grant_id))
        record(actor, "grant.delete", agent_id=g["agent_id"], entry_id=g["vault_entry_id"], outcome="ok")
        return {"deleted": True}

    def _grant_row(self, grant_id: str) -> dict[str, Any]:
        with db.engine().connect() as c:
            g = db.row(c.execute(select(models.vault_agent_grants)
                                 .where(models.vault_agent_grants.c.id == grant_id)).first())
        if not g:
            raise VaultError("grant_not_found", "no such grant", 404)
        return g

    def public_grant(self, g: dict[str, Any], entry: dict[str, Any] | None = None) -> dict[str, Any]:
        if entry is None:
            with db.engine().connect() as c:
                entry = db.row(c.execute(select(models.vault_entries)
                                         .where(models.vault_entries.c.id == g["vault_entry_id"])).first()) or {}
        return {"id": g["id"], "entry_id": g["vault_entry_id"], "entry_name": entry.get("display_name"),
                "credential_type": entry.get("credential_type"), "agent_id": g["agent_id"],
                "allowed_origins": list(g["allowed_origins"] or []), "allowed_actions": list(g["allowed_actions"] or []),
                "approval_policy": g["approval_policy"], "enabled": bool(g["enabled"]),
                "expires_at": g.get("expires_at"), "created_at": g["created_at"], "last_used_at": g.get("last_used_at")}

    def grants(self, agent_id: str | None = None) -> list[dict[str, Any]]:
        q = select(models.vault_agent_grants)
        if agent_id:
            q = q.where(models.vault_agent_grants.c.agent_id == agent_id)
        with db.engine().connect() as c:
            rows = db.rows(c.execute(q.order_by(models.vault_agent_grants.c.created_at)))
            entries = {e["id"]: e for e in db.rows(c.execute(select(models.vault_entries)))}
        return [self.public_grant(g, entries.get(g["vault_entry_id"], {})) for g in rows]

    def agent_view(self, agent_id: str) -> dict[str, Any]:
        p = self.agent_policy(agent_id)
        return {"agent_id": agent_id, "mode": p["mode"], "managed_tags": list(p.get("managed_tags") or []),
                "grants": self.grants(agent_id), "recent": audit_rows(limit=20, agent_id=agent_id)}

    # ------------------------------------------------------------ authorisation for agent credential use
    def usable_for_agent(self, agent_id: str) -> list[dict[str, Any]]:
        """What an agent may *request* (opaque refs + names/origins, never secrets). Empty when NONE."""
        p = self.agent_policy(agent_id)
        if p["mode"] == "NONE":
            return []
        now = time.time()
        out = []
        for g in self.grants(agent_id):
            if g["enabled"] and (g["expires_at"] is None or g["expires_at"] > now) and "sign_in" in g["allowed_actions"]:
                out.append({"ref": g["id"], "name": g["entry_name"], "origins": g["allowed_origins"]})
        if p["mode"] == "MANAGED":
            tags = set(p.get("managed_tags") or [])
            with db.engine().connect() as c:
                for e in db.rows(c.execute(select(models.vault_entries).where(and_(
                        models.vault_entries.c.deleted_at.is_(None),
                        models.vault_entries.c.credential_type == "website")))):
                    if tags & set(e.get("tags") or []):
                        out.append({"ref": f"ve_{e['id']}", "name": e["display_name"], "origins": [e["origin"]]})
        return out

    def authorize(self, *, agent_id: str, ref: str, origin: str, operation: str, task_id: str) -> dict[str, Any]:
        """Server-side checks for one credential use. ``agent_id``/``task_id`` come from the execution context —
        never from model output. Raises VaultDenied with a reason code; returns the binding (no secret)."""
        if operation not in ACTIONS:
            raise VaultDenied("operation_not_allowed", "this operation is not supported for agents")
        try:
            want = canonical_origin(origin)
        except VaultError as e:
            raise VaultDenied("invalid_origin", str(e)) from e
        if self._meta() is None:
            raise VaultDenied("no_vault", "the owner has not set up the Password Vault")
        k = self._keys
        self.check_auto_lock()
        k = self._keys
        if k is None:
            raise VaultDenied("vault_locked", "the vault is locked; the owner must unlock it in the local Dashboard")
        with db.engine().connect() as c:
            agent = c.execute(select(models.agents.c.id, models.agents.c.status, models.agents.c.name)
                              .where(models.agents.c.id == agent_id)).first()
            task = c.execute(select(models.tasks.c.id, models.tasks.c.agent_id, models.tasks.c.state)
                             .where(models.tasks.c.id == task_id)).first()
        if not agent or agent.status in DISABLED_AGENT_STATES:
            raise VaultDenied("agent_disabled", "this agent may not use credentials now")
        if not task or task.agent_id != agent_id or task.state in ("COMPLETED", "FAILED", "CANCELLED"):
            raise VaultDenied("task_mismatch", "credential use must belong to this agent's running task")
        p = self.agent_policy(agent_id)
        if p["mode"] == "NONE" or not p.get("mac") or not hmac.compare_digest(p["mac"],
                                                                           self._mac(k, self._policy_fields(p))):
            raise VaultDenied("no_access", "this agent has no Password Vault access")
        now = time.time()
        if ref.startswith("ve_") and p["mode"] == "MANAGED":
            entry = self._entry_row_or_deny(ref[3:])
            if not (set(p.get("managed_tags") or []) & set(entry.get("tags") or [])):
                raise VaultDenied("no_grant", "this credential is not in the agent's managed collection")
            if entry["credential_type"] != "website" or entry.get("origin") != want:
                raise VaultDenied("origin_not_allowed", "this credential is not allowed for that origin")
            binding = {"grant_id": None, "entry_id": entry["id"], "policy": "always_ask", "origin": want,
                       "allowed_origins": [entry["origin"]], "entry_name": entry["display_name"]}
        else:
            with db.engine().connect() as c:
                g = db.row(c.execute(select(models.vault_agent_grants).where(and_(
                    models.vault_agent_grants.c.id == ref, models.vault_agent_grants.c.agent_id == agent_id))).first())
            if not g:
                raise VaultDenied("no_grant", "no such credential grant for this agent")
            if not g.get("mac") or not hmac.compare_digest(g["mac"], self._mac(k, self._grant_fields(g))):
                raise VaultDenied("grant_invalid", "this grant is revoked or was not created by the owner")
            if not g["enabled"]:
                raise VaultDenied("grant_revoked", "this grant is revoked")
            if g.get("expires_at") is not None and g["expires_at"] <= now:
                raise VaultDenied("grant_expired", "this grant has expired")
            if operation not in (g["allowed_actions"] or []):
                raise VaultDenied("operation_not_allowed", "this operation is not allowed by the grant")
            if want not in (g["allowed_origins"] or []):
                raise VaultDenied("origin_not_allowed", "this credential is not allowed for that origin")
            try:
                _check_grant_origins([want])
            except VaultError:
                raise VaultDenied("loopback_origin", "credentials are never used on loopback origins") from None
            entry = self._entry_row_or_deny(g["vault_entry_id"])
            if entry["credential_type"] != "website":
                raise VaultDenied("not_injectable", "only website credentials can be used by agents")
            binding = {"grant_id": g["id"], "entry_id": entry["id"], "policy": g["approval_policy"], "origin": want,
                       "allowed_origins": list(g["allowed_origins"]), "entry_name": entry["display_name"]}
        binding.update(agent_id=agent_id, agent_name=agent.name, task_id=task_id, operation=operation)
        return binding

    def _entry_row_or_deny(self, entry_id: str) -> dict[str, Any]:
        try:
            return self._entry_row(entry_id)
        except VaultError:
            raise VaultDenied("entry_deleted", "the credential no longer exists") from None

    def credential_for_broker(self, binding: dict[str, Any]) -> dict[str, str]:
        """Decrypt for the trusted login broker only (after authorize + approval). Never returned to callers that
        talk to a model, the UI or a log."""
        k = self._keys
        if k is None:
            raise VaultDenied("vault_locked", "the vault was locked")
        row = self._entry_row_or_deny(binding["entry_id"])
        if row.get("origin") not in binding["allowed_origins"]:
            raise VaultDenied("origin_not_allowed", "credential origin changed")
        s = self._decrypt(k, row)
        self.touch()
        login = s.get("login_url") or ""
        if login and not same_origin(login, row["origin"]):
            login = ""
        return {"username": s.get("username", ""), "password": s.get("password", ""),
                "login_url": login or binding["origin"] + "/"}

    def mark_used(self, binding: dict[str, Any]) -> None:
        if binding.get("grant_id"):
            with db.engine().begin() as c:
                c.execute(update(models.vault_agent_grants).where(models.vault_agent_grants.c.id == binding["grant_id"])
                          .values(last_used_at=time.time()))


def _check_passphrase(p: str) -> None:
    if not isinstance(p, str) or len(p) < MIN_PASSPHRASE:
        raise VaultError("weak_passphrase", f"the vault passphrase needs at least {MIN_PASSPHRASE} characters")
    if len(p) > MAX_PASSPHRASE:
        raise VaultError("weak_passphrase", "the vault passphrase is too long")
    if len(set(p)) < 5:
        raise VaultError("weak_passphrase", "the vault passphrase is too repetitive")


# ============================================================================ audit (redacted by construction)
def record(actor: str, operation: str, *, outcome: str, agent_id: str | None = None, entry_id: str | None = None,
           task_id: str | None = None, origin: str | None = None, approval_id: str | None = None,
           reason: str | None = None) -> None:
    actor_type = "agent" if actor.startswith("agent:") else "system" if actor.startswith("system") else "owner"
    row = {"id": str(uuid.uuid4()), "ts": time.time(), "actor_type": actor_type, "actor_id": actor[:96],
           "agent_id": agent_id, "entry_id": entry_id, "task_id": task_id, "operation": operation[:32],
           "destination_origin": origin, "approval_id": approval_id, "outcome": outcome,
           "reason_code": (reason or None) and str(reason)[:64]}
    try:
        with db.engine().begin() as c:
            c.execute(models.vault_access_audit.insert().values(**row))
    except Exception:  # noqa: BLE001 - the audit write must never leak or crash the caller
        log.exception("vault audit write failed")
        return
    bus.publish("vault.access", {k: row[k] for k in ("operation", "outcome", "reason_code", "destination_origin",
                                                      "entry_id", "actor_type")}, agent_id=agent_id, task_id=task_id)


def audit_rows(limit: int = 50, agent_id: str | None = None) -> list[dict[str, Any]]:
    q = select(models.vault_access_audit)
    if agent_id:
        q = q.where(models.vault_access_audit.c.agent_id == agent_id)
    with db.engine().connect() as c:
        rows = db.rows(c.execute(q.order_by(models.vault_access_audit.c.ts.desc()).limit(max(1, min(limit, 500)))))
        names = {a.id: a.name for a in c.execute(select(models.agents.c.id, models.agents.c.name))}
        entries = {e.id: e.display_name for e in c.execute(select(models.vault_entries.c.id,
                                                                  models.vault_entries.c.display_name))}
    for r in rows:
        r["agent_name"] = names.get(r["agent_id"]) if r["agent_id"] else None
        r["entry_name"] = entries.get(r["entry_id"]) if r["entry_id"] else None
    return rows


def expire_pending_approvals(reason: str) -> int:
    """Deny every open credential-use approval (vault locked / broker disabled)."""
    with db.engine().begin() as c:
        ids = [r.id for r in c.execute(select(models.approvals.c.id).where(and_(
            models.approvals.c.tool == "vault_sign_in", models.approvals.c.decision.is_(None))))]
        if ids:
            c.execute(update(models.approvals).where(models.approvals.c.id.in_(ids))
                      .where(models.approvals.c.decision.is_(None))
                      .values(decision="expired", resolved_by=f"system:{reason}"[:64], resolved_at=time.time()))
    if ids:
        try:
            from nebula_host.state import svc

            events = getattr(getattr(svc, "orch", None), "approval_events", {}) or {}
        except Exception:  # noqa: BLE001 - no orchestrator (tests, CLI)
            events = {}
        for aid in ids:
            ev = events.get(aid)
            if ev:
                ev.set()  # the waiting runner re-reads the decision ("expired")
    return len(ids)


VAULT = Vault()
