"""Secret storage. Production: macOS Keychain (login keychain of the logged-in user) via `keyring`.
Only opaque references ("nebula:<name>") are stored in SQLite; values never touch the DB or logs.

Every NEBULA instance on a Mac has its own Keychain *service* (see `service_name`), so two installs never read,
overwrite or delete each other's items. Each store also keeps an index of the references it has written (names
only, never values) so `nebula uninstall --remove-data` can delete all of this instance's items, and only those.
"""

from __future__ import annotations

import json
import os
import re
import threading
from typing import Protocol

DEFAULT_SERVICE = "dev.nebula.platform"
SERVICE = DEFAULT_SERVICE  # backwards-compatible name: the default instance's service
INDEX_REF = "nebula:index.refs"  # JSON list of the refs this service holds (names only)
_REF_RE = re.compile(r"^nebula:[a-z0-9_.:-]{1,100}$")
_SERVICE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$")


def service_name(instance_id: str | None = None) -> str:
    """The Keychain service for an instance: `dev.nebula.platform` for "default", `dev.nebula.platform.<id>`
    otherwise. Without an argument it is this process's instance, and NEBULA_KEYCHAIN_SERVICE overrides it."""
    if instance_id is None:
        env = os.environ.get("NEBULA_KEYCHAIN_SERVICE")
        if env:
            if not _SERVICE_RE.match(env):
                raise ValueError("NEBULA_KEYCHAIN_SERVICE is not a valid service name")
            return env
        from nebula_host.config import get_config

        instance_id = get_config().instance_id
    from nebula_host.config import DEFAULT_INSTANCE, validate_instance_id

    iid = validate_instance_id(instance_id)
    return DEFAULT_SERVICE if iid == DEFAULT_INSTANCE else f"{DEFAULT_SERVICE}.{iid}"


class SecretStore(Protocol):
    def set(self, ref: str, value: str) -> None: ...
    def get(self, ref: str) -> str | None: ...
    def delete(self, ref: str) -> None: ...


def make_ref(name: str) -> str:
    ref = f"nebula:{name}"
    if not _REF_RE.match(ref):
        raise ValueError("invalid secret reference")
    return ref


class KeychainStore:
    def __init__(self, service: str | None = None) -> None:
        import keyring  # imported lazily: tests use MemoryStore

        self._kr = keyring
        self._service = service or service_name()
        self._lock = threading.Lock()

    @property
    def service(self) -> str:
        return self._service

    def _index(self) -> list[str]:
        try:
            raw = self._kr.get_password(self._service, INDEX_REF)
            refs = json.loads(raw) if raw else []
            return [r for r in refs if isinstance(r, str) and _REF_RE.match(r)]
        except Exception:  # noqa: BLE001 - the index is best-effort bookkeeping
            return []

    def _update_index(self, add: str | None = None, remove: str | None = None) -> None:
        try:
            with self._lock:
                refs = self._index()
                new = [r for r in refs if r != remove]
                if add and add not in new:
                    new.append(add)
                if new != refs:
                    self._kr.set_password(self._service, INDEX_REF, json.dumps(sorted(new)))
        except Exception:  # noqa: BLE001 - never fail a secret write because of the index
            pass

    def set(self, ref: str, value: str) -> None:
        if not _REF_RE.match(ref):
            raise ValueError("invalid secret reference")
        self._kr.set_password(self._service, ref, value)
        if ref != INDEX_REF:
            self._update_index(add=ref)

    def get(self, ref: str) -> str | None:
        if not ref or not _REF_RE.match(ref):
            return None
        return self._kr.get_password(self._service, ref)

    def delete(self, ref: str) -> None:
        try:
            self._kr.delete_password(self._service, ref)
        except Exception:  # noqa: BLE001 - absent is fine
            pass
        if ref != INDEX_REF:
            self._update_index(remove=ref)

    def refs(self) -> list[str]:
        """References this store has written (from its index)."""
        return self._index()


class MemoryStore:
    """Process-local store for tests (never used by the installed service)."""

    def __init__(self, service: str = "memory") -> None:
        self._d: dict[str, str] = {}
        self._lock = threading.Lock()
        self.service = service

    def set(self, ref: str, value: str) -> None:
        with self._lock:
            self._d[ref] = value

    def get(self, ref: str) -> str | None:
        with self._lock:
            return self._d.get(ref)

    def delete(self, ref: str) -> None:
        with self._lock:
            self._d.pop(ref, None)

    def refs(self) -> list[str]:
        with self._lock:
            return sorted(r for r in self._d if r != INDEX_REF)


_store: SecretStore | None = None


def init_store(backend: str, service: str | None = None) -> SecretStore:
    global _store
    _store = KeychainStore(service) if backend == "keychain" else MemoryStore(service or "memory")
    return _store


def store() -> SecretStore:
    if _store is None:
        raise RuntimeError("secret store not initialised")
    return _store


_REDACT_PATTERNS = [
    re.compile(r"\b\d{6,12}:[A-Za-z0-9_-]{30,}\b"),  # telegram bot token
    re.compile(r"\bsk-[A-Za-z0-9_-]{16,}\b"),  # openai-style keys
    re.compile(r"\bsk-ant-[A-Za-z0-9_-]{16,}\b"),
    re.compile(r"\bAIza[0-9A-Za-z_-]{20,}\b"),  # google api key
    re.compile(r"(?i)\b(bearer)\s+[A-Za-z0-9._~+/=-]{16,}"),
    re.compile(r"(?i)(\"?(?:api[_-]?key|token|password|secret|authorization)\"?\s*[:=]\s*\"?)[^\s\",]{6,}"),
]


def redact(text: str) -> str:
    if not isinstance(text, str):
        return text
    out = text
    for p in _REDACT_PATTERNS:
        out = p.sub(lambda m: (m.group(1) if m.groups() and m.group(1) else "") + "[REDACTED]", out)
    return out


SENSITIVE_KEYS = {"password", "token", "api_key", "apikey", "secret", "authorization", "bot_token", "code",
                  "refresh_token", "access_token", "id_token", "cookie", "new_key_hex"}


def redact_obj(obj):
    if isinstance(obj, dict):
        return {k: ("[REDACTED]" if k.lower() in SENSITIVE_KEYS else redact_obj(v)) for k, v in obj.items()}
    if isinstance(obj, list):
        return [redact_obj(v) for v in obj]
    if isinstance(obj, str):
        return redact(obj)
    return obj
