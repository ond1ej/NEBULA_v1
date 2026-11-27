"""Remote push notifications for the owner's paired iPhone / Mac apps (Apple Push Notification service).

Off until the owner configures it (it needs things only the owner can create):
  * an APNs auth key (.p8) from developer.apple.com — stored ONLY in the macOS Keychain (secrets store, ref
    ``nebula:apns.key``), never in the database, the repository or logs;
  * settings ``push`` = {"enabled": true, "key_id": "…", "team_id": "<your Team ID>", "topic": "<your app's
    bundle ID>"}. There is no default topic; NEBULA_APNS_TOPIC is used when the setting has none;
  * HTTP/2 support for httpx (the ``h2`` package) — APNs speaks HTTP/2 only.

Payloads are generic, English and metadata-only ("Agent needs your approval.") — never message text, passwords,
codes, tokens or page content. Tokens of revoked devices are cleared; APNs "Unregistered"/"BadDeviceToken" answers
clear them too.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import time
from typing import Any

from sqlalchemy import and_, select, update

from nebula_host import db, models
from nebula_host import secrets as sec

log = logging.getLogger("nebula.push")
KEY_REF = "nebula:apns.key"
EVENTS = {"task.completed", "task.failed", "task.approval.requested", "owner.approval.requested", "auth.request"}
HOSTS = {"development": "https://api.sandbox.push.apple.com", "production": "https://api.push.apple.com"}


def settings() -> dict[str, Any]:
    """Push settings. There is no built-in APNs topic: it is the bundle ID of *your* build of the app, set in the
    ``push`` setting or (as a fallback) the NEBULA_APNS_TOPIC environment variable."""
    s = {"enabled": False, "key_id": None, "team_id": None, "topic": None, **(db.get_setting("push", {}) or {})}
    if not s.get("topic"):
        s["topic"] = os.environ.get("NEBULA_APNS_TOPIC") or None
    return s


def http2_available() -> bool:
    try:
        import h2  # noqa: F401
    except ImportError:
        return False
    return True


def status() -> dict[str, Any]:
    s = settings()
    key = False
    try:
        key = bool(sec.store().get(KEY_REF))
    except Exception:  # noqa: BLE001 - keychain unavailable
        key = False
    ready = bool(s["enabled"] and s["key_id"] and s["team_id"] and s["topic"] and key and http2_available())
    missing = [m for m, ok in (("apns_key", key), ("key_id", s["key_id"]), ("team_id", s["team_id"]),
                               ("topic", s["topic"]),
                               ("http2", http2_available()), ("enabled", s["enabled"])) if not ok]
    return {"ready": ready, "missing": missing, "topic": s["topic"]}


def message_for(ev: dict[str, Any]) -> dict[str, str] | None:
    """The alert for an event — fixed wording, agent name only."""
    t = ev.get("type")
    pl = ev.get("payload") or {}
    agent = str(pl.get("agent_name") or "Agent")[:60]
    if t == "task.completed":
        return {"title": "Task completed", "body": f"{agent} finished a task."}
    if t == "task.failed":
        return {"title": "Task failed", "body": f"{agent} ran into an error."}
    if t in ("task.approval.requested", "owner.approval.requested"):
        return {"title": "Approval needed", "body": f"{agent} needs your approval."}
    if t == "auth.request":
        return {"title": "Sign-in needed", "body": f"{agent} needs to sign in."}
    return None


def _b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


_jwt_cache: dict[str, Any] = {}


def provider_token(key_pem: str, key_id: str, team_id: str, now: float | None = None) -> str:
    """ES256 JWT for APNs token authentication (reused up to 50 minutes, as Apple recommends)."""
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

    now = now or time.time()
    c = _jwt_cache
    if c.get("kid") == key_id and c.get("iss") == team_id and now - c.get("iat", 0) < 3000:
        return c["token"]
    header = _b64url(json.dumps({"alg": "ES256", "kid": key_id}, separators=(",", ":")).encode())
    claims = _b64url(json.dumps({"iss": team_id, "iat": int(now)}, separators=(",", ":")).encode())
    key = serialization.load_pem_private_key(key_pem.encode(), password=None)
    assert isinstance(key, ec.EllipticCurvePrivateKey)
    r, s = decode_dss_signature(key.sign(f"{header}.{claims}".encode(), ec.ECDSA(hashes.SHA256())))
    sig = _b64url(r.to_bytes(32, "big") + s.to_bytes(32, "big"))
    token = f"{header}.{claims}.{sig}"
    c.update(kid=key_id, iss=team_id, iat=int(now), token=token)
    return token


def targets() -> list[dict[str, Any]]:
    with db.engine().connect() as c:
        return db.rows(c.execute(select(models.app_devices.c.id, models.app_devices.c.push_token,
                                        models.app_devices.c.push_env).where(and_(
            models.app_devices.c.status == "active", models.app_devices.c.push_token.is_not(None)))))


async def deliver(ev: dict[str, Any]) -> int:
    """Send the event's alert to every active app device with a push token. Returns the number accepted."""
    if ev.get("type") not in EVENTS:
        return 0
    st = status()
    if not st["ready"]:
        return 0
    alert = message_for(ev)
    if alert is None:
        return 0
    s = settings()
    import httpx

    token = provider_token(sec.store().get(KEY_REF) or "", s["key_id"], s["team_id"])
    body = {"aps": {"alert": alert, "sound": "default", "thread-id": str(ev.get("agent_id") or "nebula"),
                    "interruption-level": "time-sensitive" if "approval" in ev["type"] or ev["type"] == "auth.request"
                    else "active"}}
    if ev["type"] == "auth.request" and (ev.get("payload") or {}).get("session_id"):
        body["sign_in"] = str(ev["payload"]["session_id"])[:40]
    sent = 0
    async with httpx.AsyncClient(http2=True, timeout=10) as client:
        for t in targets():
            url = f"{HOSTS.get(t['push_env'] or 'production', HOSTS['production'])}/3/device/{t['push_token']}"
            try:
                r = await client.post(url, json=body, headers={
                    "authorization": f"bearer {token}", "apns-topic": s["topic"], "apns-push-type": "alert",
                    "apns-priority": "10", "apns-expiration": str(int(time.time()) + 3600)})
            except httpx.HTTPError as e:
                log.warning("apns delivery failed: %s", type(e).__name__)
                continue
            if r.status_code == 200:
                sent += 1
            elif r.status_code in (400, 410) and (r.json() or {}).get("reason") in ("BadDeviceToken", "Unregistered"):
                with db.engine().begin() as c:
                    c.execute(update(models.app_devices).where(models.app_devices.c.id == t["id"])
                              .values(push_token=None))
            else:
                log.warning("apns answered %s", r.status_code)
    return sent


def listener(ev: dict[str, Any]):
    """Event-bus listener (registered at start-up). Cheap no-op unless push is configured."""
    if ev.get("type") in EVENTS and settings().get("enabled"):
        return deliver(ev)
    return None
