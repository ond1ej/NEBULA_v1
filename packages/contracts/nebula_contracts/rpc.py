"""Authenticated host<->guest RPC framing (stdlib only; shared by host and guest).

Transport: one JSON object per line over a stream socket (virtio-vsock bridged by the
Swift helper to a host unix socket). Every request and response carries an HMAC-SHA256
over a canonical encoding, a timestamp and a nonce. The guest rejects stale timestamps
and replayed nonces, so a captured frame cannot be re-sent.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import threading
import time
from collections import OrderedDict
from typing import Any

PROTOCOL_VERSION = 1
MAX_SKEW_SECONDS = 120
MAX_FRAME_BYTES = 64 * 1024 * 1024  # screenshots travel base64 inside frames


class RPCAuthError(Exception):
    pass


def canonical(obj: dict[str, Any]) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def _mac(key: bytes, body: dict[str, Any]) -> str:
    return hmac.new(key, canonical(body), hashlib.sha256).hexdigest()


def sign(key: bytes, body: dict[str, Any]) -> dict[str, Any]:
    body = dict(body)
    body.setdefault("v", PROTOCOL_VERSION)
    body.setdefault("ts", int(time.time()))
    body.setdefault("nonce", secrets.token_hex(16))
    body.pop("mac", None)
    body["mac"] = _mac(key, body)
    return body


class NonceCache:
    """Bounded replay cache (nonce -> seen time)."""

    def __init__(self, max_items: int = 50000) -> None:
        self._seen: OrderedDict[str, float] = OrderedDict()
        self._lock = threading.Lock()
        self._max = max_items

    def check_and_add(self, nonce: str, now: float) -> bool:
        with self._lock:
            cutoff = now - 2 * MAX_SKEW_SECONDS
            while self._seen:
                k, t = next(iter(self._seen.items()))
                if t >= cutoff and len(self._seen) < self._max:
                    break
                self._seen.popitem(last=False)
            if nonce in self._seen:
                return False
            self._seen[nonce] = now
            return True


def verify(key: bytes, frame: dict[str, Any], nonces: NonceCache | None = None, now: float | None = None) -> dict[str, Any]:
    if not isinstance(frame, dict):
        raise RPCAuthError("frame must be an object")
    mac = frame.get("mac")
    if not isinstance(mac, str):
        raise RPCAuthError("missing mac")
    body = {k: v for k, v in frame.items() if k != "mac"}
    if not hmac.compare_digest(mac, _mac(key, body)):
        raise RPCAuthError("bad mac")
    now = time.time() if now is None else now
    ts = body.get("ts")
    if not isinstance(ts, int) or abs(now - ts) > MAX_SKEW_SECONDS:
        raise RPCAuthError("stale or missing timestamp")
    nonce = body.get("nonce")
    if not isinstance(nonce, str) or len(nonce) < 16:
        raise RPCAuthError("missing nonce")
    if nonces is not None and not nonces.check_and_add(nonce, now):
        raise RPCAuthError("replayed nonce")
    return body


def encode_frame(frame: dict[str, Any]) -> bytes:
    data = json.dumps(frame, separators=(",", ":"), ensure_ascii=False).encode() + b"\n"
    if len(data) > MAX_FRAME_BYTES:
        raise ValueError("frame too large")
    return data


def decode_frame(line: bytes) -> dict[str, Any]:
    if len(line) > MAX_FRAME_BYTES:
        raise ValueError("frame too large")
    obj = json.loads(line)
    if not isinstance(obj, dict):
        raise ValueError("frame must be an object")
    return obj


def new_key() -> bytes:
    return os.urandom(32)


# Validation shared by host and guest: guest Linux user names are never derived from raw user input.
LINUX_USER_PREFIX = "nebula_"


def linux_user_for(agent_id: str) -> str:
    short = agent_id.replace("-", "").lower()[:8]
    if len(short) != 8 or any(c not in "0123456789abcdef" for c in short):
        raise ValueError("agent_id must be a UUID")
    return LINUX_USER_PREFIX + short


def is_valid_linux_user(name: str) -> bool:
    if not name.startswith(LINUX_USER_PREFIX):
        return False
    short = name[len(LINUX_USER_PREFIX):]
    return len(short) == 8 and all(c in "0123456789abcdef" for c in short)
