# ruff: noqa: F811 - fixtures are imported from other test modules and injected by pytest
"""NEBULA 4.0: native app pairing, device sessions and unified owner confirmation, through the real gateway.

The "app" here is a Python stand-in that does exactly what the Swift client does: two P-256 keys (identity +
confirm), DER ECDSA signatures over the documented payloads, a 32-byte device vault secret.
"""

from __future__ import annotations

import base64
import hashlib
import os
import time
import uuid

import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec

from tests.integration.test_api import _setup_admin, client  # noqa: F401
from tests.integration.test_v3_api import _pair_owner, gateway  # noqa: F401
from tests.unit.test_v3_units import BOT_TOKEN, make_init_data

PASS = "app vault passphrase 4711"
LOGIN = "correct horse battery"
CANARY = "CANARY-APP-PW-77c1"
PUBLIC = "https://nebula-test.example.ts.net"


@pytest.fixture(autouse=True)
def _fast_kdf(monkeypatch):
    from nebula_host import devices
    from nebula_host import vault as v

    monkeypatch.setattr(v, "calibrate_kdf", lambda *a, **k: {"alg": "argon2id", "salt": v.b64e(os.urandom(16)),
                                                              "time_cost": 2, "memory_kib": 8192, "parallelism": 1})
    v.VAULT._keys = None
    v.VAULT._reauth_sessions.clear()
    devices._pairings.clear()
    devices._challenges.clear()
    devices._attempts.clear()
    devices._server_key_cache.clear()
    yield
    v.VAULT._keys = None


def b64(b: bytes) -> str:
    return base64.b64encode(b).decode()


class FakeApp:
    """What the iPhone / Mac app does (keys in the Secure Enclave there)."""

    def __init__(self, platform: str = "ios") -> None:
        self.identity = ec.generate_private_key(ec.SECP256R1())
        self.confirm = ec.generate_private_key(ec.SECP256R1())
        self.secret = os.urandom(32)
        self.platform = platform
        self.device_id: str | None = None
        self.token: str | None = None

    @staticmethod
    def pub(k) -> str:
        return b64(k.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint))

    @staticmethod
    def sign(k, payload: bytes) -> str:
        return b64(k.sign(payload, ec.ECDSA(hashes.SHA256())))

    def claim(self, gw, pairing_id: str, code: str):
        proof = "\n".join(["nebula-app-pair/v1", pairing_id, self.pub(self.identity), self.pub(self.confirm)]).encode()
        return gw.post("/api/app/pair/claim", json={
            "pairing_id": pairing_id, "code": code, "name": "Testovací iPhone", "platform": self.platform,
            "model": "iPhone16,1", "app_version": "1.0.0", "identity_key": self.pub(self.identity),
            "confirm_key": self.pub(self.confirm), "key_protection": "secure_enclave",
            "identity_signature": self.sign(self.identity, proof), "confirm_signature": self.sign(self.confirm, proof)})

    def sign_in(self, gw):
        ch = gw.post("/api/app/session/challenge", json={"device_id": self.device_id})
        if ch.status_code != 200:
            return ch
        c = ch.json()["data"]
        payload = "\n".join(["nebula-app-session/v1", self.device_id, c["challenge_id"], c["challenge"]]).encode()
        r = gw.post("/api/app/session", json={"device_id": self.device_id, "challenge_id": c["challenge_id"],
                                              "signature": self.sign(self.identity, payload)})
        if r.status_code == 201:
            self.token = r.json()["data"]["token"]
        return r

    @property
    def auth(self) -> dict:
        return {"authorization": f"Bearer {self.token}"}

    def confirm_body(self, gw, purpose="vault_unlock", with_secret=True, key=None, **extra) -> dict:
        ch = gw.post("/api/v1/auth/confirm/challenge", json={"purpose": purpose}, headers=self.auth)
        assert ch.status_code == 200, ch.text
        c = ch.json()["data"]
        me = gw.get("/api/v1/miniapp/me", headers=self.auth).json()["data"]
        digest = hashlib.sha256(self.secret).hexdigest() if with_secret else "-"
        payload = "\n".join(["nebula-owner-confirm/v1", self.device_id, me["session_id"], c["challenge_id"],
                             c["challenge"], purpose, digest]).encode()
        body = {"method": "app_key", "challenge_id": c["challenge_id"],
                "signature": self.sign(key or self.confirm, payload), **extra}
        if with_secret:
            body["vault_secret"] = b64(self.secret)
        return body


def _enable_gateway() -> None:
    from nebula_host import db

    db.set_setting("remote", {"enabled": True, "port": 3102, "public_url": PUBLIC, "tunnel": "custom"})


def _paired(client, gw, h, app: FakeApp | None = None) -> FakeApp:
    _enable_gateway()
    app = app or FakeApp()
    offer = client.post("/api/v1/devices/pairing", headers=h).json()["data"]
    r = app.claim(gw, offer["pairing_id"], offer["code"])
    assert r.status_code == 201, r.text
    app.device_id = r.json()["data"]["device_id"]
    assert client.post(f"/api/v1/devices/{app.device_id}/approve", headers=h).status_code == 200
    assert app.sign_in(gw).status_code == 201
    return app


def test_pairing_offer_needs_the_gateway_and_carries_no_long_term_secret(client, gateway):
    h = _setup_admin(client)
    r = client.post("/api/v1/devices/pairing", headers=h)
    assert r.status_code == 409 and r.json()["error"]["code"] == "gateway_not_configured"
    _enable_gateway()
    offer = client.post("/api/v1/devices/pairing", headers=h).json()["data"]
    assert offer["url"].startswith("nebula://pair?v=1&u=https%3A%2F%2Fnebula-test.example.ts.net&p=pr_")
    assert offer["code"] in offer["url"] or offer["code"].replace("-", "%2D") in offer["url"]
    assert offer["expires_at"] - time.time() <= 300
    assert len(offer["server_fingerprint"]) == 20
    hello = gateway.get("/api/app/hello").json()["data"]
    assert hello["server_fingerprint"] == offer["server_fingerprint"] and hello["api"] == 4


def test_claim_approve_sign_in_and_server_verification(client, gateway):
    from nebula_host import devices

    h = _setup_admin(client)
    _enable_gateway()
    app = FakeApp()
    offer = client.post("/api/v1/devices/pairing", headers=h).json()["data"]
    bad = app.claim(gateway, offer["pairing_id"], "wrong-code-0000000000")
    assert bad.status_code == 401 and bad.json()["error"]["code"] == "bad_code"
    r = app.claim(gateway, offer["pairing_id"], offer["code"])
    assert r.status_code == 201, r.text
    d = r.json()["data"]
    app.device_id = d["device_id"]
    # the app checks it talks to the NEBULA whose fingerprint was on the owner's screen
    server_pub = base64.b64decode(d["server_key"])
    assert hashlib.sha256(server_pub).hexdigest()[:20] == offer["server_fingerprint"]
    ack = "\n".join(["nebula-app-pair-ack/v1", offer["pairing_id"], app.device_id,
                     hashlib.sha256(FakeApp.pub(app.identity).encode()).hexdigest()]).encode()
    ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), server_pub).verify(
        base64.b64decode(d["server_signature"]), ack, ec.ECDSA(hashes.SHA256()))
    # single use
    assert app.claim(gateway, offer["pairing_id"], offer["code"]).json()["error"]["code"] == "pairing_expired"
    # pending until the owner approves, with the same 6-digit code on both screens
    listed = client.get("/api/v1/devices", headers=h).json()["data"]["devices"]
    assert [x["status"] for x in listed] == ["pending"] and listed[0]["verification_code"] == d["verification_code"]
    assert "identity_key" not in listed[0] and "confirm_key" not in listed[0]
    pend = app.sign_in(gateway)
    assert pend.status_code == 403 and pend.json()["error"]["code"] == "pending_approval"
    assert client.get(f"/api/v1/devices/pairing/{offer['pairing_id']}", headers=h).json()["data"]["status"] == "claimed"
    assert client.post(f"/api/v1/devices/{app.device_id}/approve", headers=h).status_code == 200
    ch = gateway.post("/api/app/session/challenge", json={"device_id": app.device_id}).json()["data"]
    srv = "\n".join(["nebula-app-challenge/v1", app.device_id, ch["challenge_id"], ch["challenge"]]).encode()
    ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), server_pub).verify(
        base64.b64decode(ch["server_signature"]), srv, ec.ECDSA(hashes.SHA256()))
    # a signature by the wrong key / a replayed challenge is refused
    payload = "\n".join(["nebula-app-session/v1", app.device_id, ch["challenge_id"], ch["challenge"]]).encode()
    wrong = gateway.post("/api/app/session", json={"device_id": app.device_id, "challenge_id": ch["challenge_id"],
                                                   "signature": app.sign(app.confirm, payload)})
    assert wrong.status_code == 401
    replay = gateway.post("/api/app/session", json={"device_id": app.device_id, "challenge_id": ch["challenge_id"],
                                                    "signature": app.sign(app.identity, payload)})
    assert replay.status_code == 401 and replay.json()["error"]["code"] == "challenge_expired"
    assert app.sign_in(gateway).status_code == 201
    me = gateway.get("/api/v1/app/me", headers=app.auth).json()["data"]
    assert me["device"]["id"] == app.device_id and me["device"]["status"] == "active"
    mm = gateway.get("/api/v1/miniapp/me", headers=app.auth).json()["data"]
    assert mm["kind"] == "app" and mm["role"] == "owner" and mm["admin"] is True
    assert devices.server_fingerprint() == offer["server_fingerprint"]


def test_app_session_only_through_the_gateway_and_owner_policy(client, gateway):
    h = _setup_admin(client)
    app = _paired(client, gateway, h)
    # the bearer token as a dashboard cookie on the local API is refused (gateway only)
    from nebula_host import auth

    client.cookies.set(auth.COOKIE, app.token)
    assert client.get("/api/v1/agents").status_code == 401
    client.cookies.clear()
    assert gateway.get("/api/v1/agents", headers=app.auth).status_code == 200
    # sensitive owner operations need a fresh confirmation; the app offers Face ID ("device") and the vault passphrase
    r = gateway.post("/api/v1/devices/pairing", headers=app.auth)
    assert r.status_code == 403 and r.json()["error"]["code"] == "stepup_required"
    assert "device" in r.json()["error"]["details"]["methods"]
    a = gateway.get("/api/v1/auth/assurance", headers=app.auth).json()["data"]
    assert a["interface"] == "app" and a["methods"]["device"]["device_id"] == app.device_id
    # local-only routes stay local
    assert gateway.post("/api/v1/auth/logout", headers=app.auth).status_code == 403


def test_one_face_id_confirmation_unlocks_the_vault_and_allows_reveal(client, gateway):
    h = _setup_admin(client)
    app = _paired(client, gateway, h)
    assert client.post("/api/v1/vault", json={"passphrase": PASS}, headers=h).status_code == 201
    e = client.post("/api/v1/vault/entries", json={"display_name": "Mail", "origin": "https://mail.example.com",
                                                    "username": "me", "password": CANARY}, headers=h).json()["data"]
    client.post("/api/v1/vault/lock", headers=h)
    # first activation: Face ID + the passphrase ONCE → unlocked + the vault key wrapped for this device
    first = gateway.post("/api/v1/auth/confirm", json=app.confirm_body(
        gateway, unlock_vault=True, enroll_vault_key=True, passphrase=PASS), headers=app.auth)
    assert first.status_code == 200, first.text
    d = first.json()["data"]
    assert d["vault"]["locked"] is False and d["vault"]["device_key"] is True and d["fresh_until"] > time.time()
    assert CANARY not in first.text and PASS not in first.text
    gateway.post("/api/v1/vault/lock", headers=app.auth)
    # from now on: ONE confirmation (Face ID) → owner verified + vault unlocked + reveal allowed, no passphrase
    app.sign_in(gateway)  # a new session (e.g. the next day)
    r = gateway.post("/api/v1/auth/confirm", json=app.confirm_body(gateway, unlock_vault=True), headers=app.auth)
    assert r.status_code == 200, r.text
    assert r.json()["data"]["vault"]["locked"] is False and r.json()["data"]["vault"]["result"] == "unlocked"
    rv = gateway.post(f"/api/v1/vault/entries/{e['id']}/reveal", json={"field": "password"}, headers=app.auth)
    assert rv.status_code == 200 and rv.json()["data"]["value"] == CANARY
    # while unlocked, the device key also re-confirms the vault for reveal on another session
    app.sign_in(gateway)
    assert gateway.post(f"/api/v1/vault/entries/{e['id']}/reveal", json={"field": "password"},
                        headers=app.auth).json()["error"]["code"] in ("stepup_required", "reauth_required")
    ok = gateway.post("/api/v1/auth/confirm", json=app.confirm_body(gateway, purpose="vault_reveal"), headers=app.auth)
    assert ok.json()["data"]["vault"]["result"] == "confirmed"
    assert gateway.post(f"/api/v1/vault/entries/{e['id']}/reveal", json={"field": "password"},
                        headers=app.auth).status_code == 200
    # audit: device unlock is recorded, never the secret
    from nebula_host import db, models

    with db.engine().connect() as c:
        rows = db.rows(c.execute(models.vault_access_audit.select()))
    assert any(r["operation"] == "unlock" and (r.get("reason_code") or "") == "device_app" for r in rows)
    assert b64(app.secret) not in str(rows)


def test_confirmation_rejects_replay_wrong_key_wrong_secret_and_other_sessions(client, gateway):
    h = _setup_admin(client)
    app = _paired(client, gateway, h)
    assert client.post("/api/v1/vault", json={"passphrase": PASS}, headers=h).status_code == 201
    body = app.confirm_body(gateway, enroll_vault_key=True)
    assert gateway.post("/api/v1/auth/confirm", json=body, headers=app.auth).status_code == 200
    assert gateway.post("/api/v1/auth/confirm", json=body, headers=app.auth).json()["error"]["code"] == \
        "challenge_expired"  # single use
    wrong_key = app.confirm_body(gateway, key=app.identity)
    assert gateway.post("/api/v1/auth/confirm", json=wrong_key, headers=app.auth).status_code == 401
    # a challenge of another session of the same device is refused
    other = FakeApp()
    other.identity, other.confirm, other.secret, other.device_id = app.identity, app.confirm, app.secret, app.device_id
    other.sign_in(gateway)
    stolen = app.confirm_body(gateway)
    assert gateway.post("/api/v1/auth/confirm", json=stolen, headers=other.auth).status_code == 401
    # a different 32-byte secret (signed correctly) never opens the vault and removes the stale wrap
    client.post("/api/v1/vault/lock", headers=h)
    real = app.secret
    app.secret = os.urandom(32)
    r = gateway.post("/api/v1/auth/confirm", json=app.confirm_body(gateway, unlock_vault=True), headers=app.auth)
    assert r.status_code == 200 and r.json()["data"]["vault"]["locked"] is True
    assert r.json()["data"]["vault_unlock_needed"] is True and r.json()["data"]["vault"]["device_key"] is False
    app.secret = real


def test_revoking_a_device_ends_sessions_and_deletes_its_vault_key(client, gateway):
    h = _setup_admin(client)
    app = _paired(client, gateway, h)
    assert client.post("/api/v1/vault", json={"passphrase": PASS}, headers=h).status_code == 201
    assert gateway.post("/api/v1/auth/confirm", json=app.confirm_body(gateway, enroll_vault_key=True),
                        headers=app.auth).json()["data"]["vault"]["device_key"] is True
    assert client.delete(f"/api/v1/devices/{app.device_id}", headers=h).status_code == 200
    assert gateway.get("/api/v1/agents", headers=app.auth).status_code == 401
    r = app.sign_in(gateway)
    assert r.status_code == 403 and r.json()["error"]["code"] == "device_revoked"
    from nebula_host import db, models

    with db.engine().connect() as c:
        assert c.execute(models.owner_vault_keys.select()).first() is None
    assert client.get("/api/v1/devices", headers=h).json()["data"]["devices"] == []


def _mini(gateway, user_id=7):
    r = gateway.post("/api/mini/auth", json={"init_data": make_init_data(
        BOT_TOKEN, user_id=user_id, extra={"query_id": uuid.uuid4().hex})})
    assert r.status_code == 200, r.text
    return {"authorization": f"Bearer {r.json()['data']['token']}"}


def _bio(gateway, auth, device_id, token, **extra):
    ch = gateway.post("/api/v1/auth/stepup/challenge", json={"device_id": device_id}, headers=auth).json()["data"]
    return gateway.post("/api/v1/auth/confirm", json={"method": "telegram_biometric", "device_id": device_id,
                                                      "challenge_id": ch["challenge_id"], "token": token, **extra},
                        headers=auth)


def test_telegram_one_biometric_prompt_unlocks_the_vault_and_follows_token_rotation(client, gateway):
    h = _setup_admin(client)
    _pair_owner(7)
    assert client.post("/api/v1/vault", json={"passphrase": PASS}, headers=h).status_code == 201
    client.post("/api/v1/vault/lock", headers=h)
    auth = _mini(gateway)
    gateway.post("/api/v1/auth/stepup", json={"method": "password", "password": LOGIN}, headers=auth)
    dev = gateway.post("/api/v1/auth/devices", json={"name": "iPhone"}, headers=auth).json()["data"]
    # first time: biometric + the vault passphrase once → unlocked, vault key wrapped for this Telegram device
    r = _bio(gateway, auth, dev["device_id"], dev["token"], unlock_vault=True, enroll_vault_key=True, passphrase=PASS)
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert d["vault"]["locked"] is False and d["vault"]["device_key"] is True and d["next_token"] != dev["token"]
    token = d["next_token"]
    client.post("/api/v1/vault/lock", headers=h)
    auth = _mini(gateway)  # a new Mini App opening
    r = _bio(gateway, auth, dev["device_id"], token, unlock_vault=True)
    assert r.status_code == 200 and r.json()["data"]["vault"]["locked"] is False, r.text
    assert r.json()["data"]["vault"]["result"] == "unlocked"
    token2 = r.json()["data"]["next_token"]
    # the old token is dead (rotation), the V3.3 step-up endpoint keeps the wrap in sync with the rotation
    assert _bio(gateway, auth, dev["device_id"], token).status_code == 401
    client.post("/api/v1/vault/lock", headers=h)
    ch = gateway.post("/api/v1/auth/stepup/challenge", json={"device_id": dev["device_id"]}, headers=auth).json()["data"]
    s = gateway.post("/api/v1/auth/stepup", json={"method": "biometric", "device_id": dev["device_id"],
                                                  "challenge_id": ch["challenge_id"], "token": token2}, headers=auth)
    token3 = s.json()["data"]["next_token"]
    r = _bio(gateway, auth, dev["device_id"], token3, unlock_vault=True)
    assert r.json()["data"]["vault"]["result"] == "unlocked"
    a = gateway.get("/api/v1/auth/assurance", headers=auth).json()["data"]
    assert a["methods"]["biometric"]["devices"][0]["vault_key"] is True and a["methods"]["vault_passphrase"] is True
    # removing the biometric device removes its vault key
    gateway.post("/api/v1/auth/stepup", json={"method": "password", "password": LOGIN}, headers=auth)
    assert gateway.delete(f"/api/v1/auth/devices/{dev['device_id']}", headers=auth).status_code == 200
    from nebula_host import db, models

    with db.engine().connect() as c:
        assert c.execute(models.owner_vault_keys.select()).first() is None


def test_vault_passphrase_alone_is_the_single_fallback(client, gateway):
    h = _setup_admin(client)
    _pair_owner(7)
    assert client.post("/api/v1/vault", json={"passphrase": PASS}, headers=h).status_code == 201
    client.post("/api/v1/vault/lock", headers=h)
    auth = _mini(gateway)
    r = gateway.post("/api/v1/auth/confirm", json={"method": "vault_passphrase", "passphrase": "wrong one 1234",
                                                   "unlock_vault": True}, headers=auth)
    assert r.status_code == 401 and r.json()["error"]["code"] == "wrong_passphrase"
    r = gateway.post("/api/v1/auth/confirm", json={"method": "vault_passphrase", "passphrase": PASS,
                                                   "unlock_vault": True}, headers=auth)
    assert r.status_code == 200 and r.json()["data"]["vault"]["locked"] is False
    # the same single confirmation made the session fresh: a fresh-only action works without another password
    assert gateway.get("/api/v1/miniapp/me", headers=auth).json()["data"]["assurance"]["fresh"] is True
    e = gateway.post("/api/v1/vault/entries", json={"display_name": "x", "origin": "https://x.example.com",
                                                    "password": CANARY}, headers=auth)
    assert e.status_code == 201
    rv = gateway.post(f"/api/v1/vault/entries/{e.json()['data']['id']}/reveal", json={"field": "password"},
                      headers=auth)
    assert rv.status_code == 200


def test_operator_cannot_confirm_or_pair(client, gateway):
    h = _setup_admin(client)
    _pair_owner(7)
    _pair_owner(8)  # a second approved Telegram user = operator
    auth = _mini(gateway, user_id=8)
    r = gateway.post("/api/v1/auth/confirm", json={"method": "password", "password": LOGIN}, headers=auth)
    assert r.status_code == 403
    assert gateway.get("/api/v1/devices", headers=auth).status_code == 403
    assert client.get("/api/v1/devices", headers=h).status_code == 200


def test_live_model_text_is_streamed_but_never_stored():
    from nebula_host import db, models
    from nebula_host.events import bus

    with pytest.raises(ValueError):
        bus.publish_ephemeral("task.completed", {})
    try:
        db.engine()
    except RuntimeError:
        return
    with db.engine().connect() as c:
        before = c.execute(models.events.select()).fetchall()
    bus.publish_ephemeral("task.output.delta", {"turn": 0, "offset": 0, "delta": "Ahoj", "done": False})
    with db.engine().connect() as c:
        assert len(c.execute(models.events.select()).fetchall()) == len(before)


def test_push_is_off_until_configured_and_payloads_carry_no_content(client, gateway):
    import asyncio

    from cryptography.hazmat.primitives import serialization
    from nebula_host import push

    h = _setup_admin(client)
    app = _paired(client, gateway, h)
    assert gateway.put("/api/v1/app/push", json={"token": "ab" * 32, "env": "development"},
                       headers=app.auth).status_code == 200
    assert gateway.put("/api/v1/app/push", json={"token": "not-hex!"}, headers=app.auth).status_code == 400
    st = push.status()
    assert st["ready"] is False and "apns_key" in st["missing"]
    assert asyncio.run(push.deliver({"type": "task.completed", "payload": {"agent_name": "Jarvis"}})) == 0
    m = push.message_for({"type": "auth.request", "payload": {"agent_name": "Jarvis", "site": "x", "summary": CANARY}})
    assert m == {"title": "Sign-in needed", "body": "Jarvis needs to sign in."}
    assert push.message_for({"type": "task.completed", "payload": {"summary": CANARY}})["body"] == \
        "Agent finished a task."
    # the provider token is a valid ES256 JWT (verifiable with the key's public half)
    key = ec.generate_private_key(ec.SECP256R1())
    pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                            serialization.NoEncryption()).decode()
    tok = push.provider_token(pem, "KEY1234567", "ABCDE12345", now=1_800_000_000)
    head, claims, sig = tok.split(".")
    from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature

    raw = base64.urlsafe_b64decode(sig + "==")
    der = encode_dss_signature(int.from_bytes(raw[:32], "big"), int.from_bytes(raw[32:], "big"))
    key.public_key().verify(der, f"{head}.{claims}".encode(), ec.ECDSA(hashes.SHA256()))
    # revoking the device clears its push token
    client.delete(f"/api/v1/devices/{app.device_id}", headers=h)
    assert push.targets() == []
