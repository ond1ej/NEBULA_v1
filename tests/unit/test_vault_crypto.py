"""Password Vault cryptography and lifecycle (spec V3.2 §20.2). Synthetic canary secrets only."""

from __future__ import annotations

import base64
import json
import sqlite3
import time

import pytest

PASS = "correct horse battery staple 42"
CANARY = "CANARY-PW-7f3a9c1e-never-leak"


@pytest.fixture()
def vault(dbinit, monkeypatch):
    from nebula_host import vault as v

    # fast KDF for tests (the real calibration is covered by test_kdf_calibration_targets_250_500ms)
    monkeypatch.setattr(v, "calibrate_kdf", lambda *a, **k: {"alg": "argon2id", "salt": v.b64e(__import__("os").urandom(16)),
                                                              "time_cost": 2, "memory_kib": 8192, "parallelism": 1})
    vv = v.Vault()
    yield vv
    vv.lock("test", actor="test")


def _add(vault, **kw):
    return vault.add_entry({"display_name": kw.get("name", "GitHub"), "origin": kw.get("origin", "https://github.com"),
                            "username": "octo", "password": kw.get("password", CANARY), "notes": "n"}, actor="user:o")


def _db_bytes(dbinit) -> bytes:
    return open(dbinit.db_path, "rb").read() + (open(str(dbinit.db_path) + "-wal", "rb").read()
                                                 if __import__("os").path.exists(str(dbinit.db_path) + "-wal") else b"")


def test_create_lock_unlock_and_wrong_passphrase(vault, dbinit):
    from nebula_host import vault as v

    s = vault.create(PASS, actor="user:o")
    assert s["exists"] and not s["locked"]
    e = _add(vault)
    vault.lock(actor="user:o")
    assert vault.status()["locked"]
    with pytest.raises(v.VaultError) as ei:
        vault.add_entry({"display_name": "x", "origin": "https://x.example"}, actor="user:o")
    assert ei.value.code == "vault_locked"
    with pytest.raises(v.VaultError) as ei:
        vault.unlock("wrong passphrase 1234", actor="user:o")
    assert ei.value.code == "wrong_passphrase" and ei.value.status == 401
    vault.unlock(PASS, actor="user:o")
    assert vault.entry_detail(e["id"])["username"] == "octo"
    # nothing secret in the database file
    raw = _db_bytes(dbinit)
    assert CANARY.encode() not in raw and PASS.encode() not in raw and b"octo" not in raw


def test_vault_starts_locked_in_a_new_process_instance(vault):
    from nebula_host import vault as v

    vault.create(PASS, actor="user:o")
    fresh = v.Vault()  # = service restart / host reboot: keys exist only in process memory
    assert fresh.status()["exists"] and fresh.status()["locked"]


def test_tampered_ciphertext_and_metadata_are_rejected(vault, dbinit):
    from nebula_host import vault as v

    vault.create(PASS, actor="user:o")
    e = _add(vault)
    c = sqlite3.connect(dbinit.db_path)
    ct, = c.execute("select encrypted_payload from vault_entries where id=?", (e["id"],)).fetchone()
    raw = bytearray(base64.b64decode(ct))
    raw[5] ^= 0x01
    c.execute("update vault_entries set encrypted_payload=? where id=?", (base64.b64encode(bytes(raw)).decode(), e["id"]))
    c.commit()
    with pytest.raises(v.VaultError) as ei:
        vault.entry_detail(e["id"])
    assert ei.value.code == "integrity_error"
    # authenticated metadata: moving a credential to another origin in the DB breaks decryption
    e2 = _add(vault, name="Mail", origin="https://mail.example.com")
    c.execute("update vault_entries set origin='https://attacker.example' where id=?", (e2["id"],))
    c.commit()
    with pytest.raises(v.VaultError) as ei:
        vault.entry_detail(e2["id"])
    assert ei.value.code == "integrity_error"
    # tampered wrapped DEK -> unlock fails, nothing decrypts
    vault.lock(actor="user:o")
    w, = c.execute("select wrapped_dek from vault_metadata").fetchone()
    raw = bytearray(base64.b64decode(w))
    raw[-1] ^= 0x80
    c.execute("update vault_metadata set wrapped_dek=?", (base64.b64encode(bytes(raw)).decode(),))
    c.commit()
    with pytest.raises(v.VaultError) as ei:
        vault.unlock(PASS, actor="user:o")
    assert ei.value.code == "wrong_passphrase"


def test_nonces_are_unique_per_encryption(vault, dbinit):
    vault.create(PASS, actor="user:o")
    ids = [_add(vault, name=f"n{i}")["id"] for i in range(25)]
    for i in ids[:10]:
        vault.update_entry(i, {"password": CANARY + "x"}, actor="user:o")
    c = sqlite3.connect(dbinit.db_path)
    nonces = [r[0] for r in c.execute("select nonce from vault_entries")]
    wrapped = c.execute("select wrapped_dek from vault_metadata").fetchone()[0]
    nonces.append(base64.b64encode(base64.b64decode(wrapped)[:12]).decode())
    assert len(nonces) == len(set(nonces)) == 26
    assert all(len(base64.b64decode(n)) == 12 for n in nonces)


def test_passphrase_rotation(vault):
    from nebula_host import vault as v

    vault.create(PASS, actor="user:o")
    e = _add(vault)
    new = "a completely different passphrase 9"
    with pytest.raises(v.VaultError):
        vault.rotate("not the passphrase 123", new, actor="user:o")
    vault.rotate(PASS, new, actor="user:o")
    vault.lock(actor="user:o")
    with pytest.raises(v.VaultError):
        vault.unlock(PASS, actor="user:o")  # old passphrase no longer works
    vault.unlock(new, actor="user:o")
    vault.reauth(new, actor="user:o")
    assert vault.reveal(e["id"], actor="user:o")["value"] == CANARY  # data survived rotation


def test_encrypted_export_import_into_test_vault(vault, dbinit, tmp_path, monkeypatch):
    from nebula_host import db
    from nebula_host import vault as v

    vault.create(PASS, actor="user:o")
    _add(vault, name="A")
    _add(vault, name="B", origin="https://b.example")
    with pytest.raises(v.VaultError):
        vault.export("short", actor="user:o")
    blob = vault.export("export passphrase 77!", actor="user:o")
    text = json.dumps(blob)
    assert CANARY not in text and "octo" not in text  # encrypted export
    with pytest.raises(v.VaultError) as ei:
        v.Vault.inspect_export(blob, "wrong export pass 00")
    assert ei.value.code == "bad_export"
    bad = json.loads(text)
    bad["header"]["entry_count"] = 5  # header is authenticated
    with pytest.raises(v.VaultError):
        v.Vault.inspect_export(bad, "export passphrase 77!")
    # import into a fresh, separate test vault (own database)
    db.init_engine(tmp_path / "second.db")
    other = v.Vault()
    other.create("second vault passphrase!", actor="user:o")
    with pytest.raises(v.VaultError):
        other.import_(blob, "export passphrase 77!", actor="user:o", confirm=False)
    assert other.import_(blob, "export passphrase 77!", actor="user:o", confirm=True) == {"imported": 2}
    names = sorted(e["display_name"] for e in other.list_entries())
    assert names == ["A", "B"]
    other.lock(actor="t")


def test_locked_vault_rejects_secret_operations(vault):
    from nebula_host import vault as v

    vault.create(PASS, actor="user:o")
    e = _add(vault)
    vault.lock(actor="user:o")
    for fn in (lambda: vault.reveal(e["id"], actor="u"), lambda: vault.entry_detail(e["id"]),
               lambda: vault.export("export passphrase 77!", actor="u"),
               lambda: vault.update_entry(e["id"], {"password": "x"}, actor="u")):
        with pytest.raises(v.VaultError) as ei:
            fn()
        assert ei.value.code == "vault_locked"
    assert vault.list_entries()[0]["display_name"] == "GitHub"  # metadata stays listable


def test_auto_lock_after_inactivity(vault):
    vault.create(PASS, actor="user:o")
    vault.set_auto_lock(5, actor="user:o")
    vault.last_activity = time.time() - 5 * 60 - 1
    assert vault.status()["locked"] is True
    from nebula_host import vault as v

    with pytest.raises(v.VaultError):
        vault.set_auto_lock(7, actor="user:o")


def test_unlock_rate_limit_persists(vault):
    from nebula_host import vault as v

    vault.create(PASS, actor="user:o")
    vault.lock(actor="user:o")
    for _ in range(v.FREE_ATTEMPTS):
        with pytest.raises(v.VaultError):
            vault.unlock("wrong passphrase xyz", actor="user:o")
    with pytest.raises(v.VaultError) as ei:
        vault.unlock(PASS, actor="user:o")  # even the right one is refused during the lockout
    assert ei.value.code == "rate_limited" and ei.value.status == 429
    assert v.Vault().status()["lockout_until"]  # survives a restart


def test_reveal_requires_recent_authentication(vault):
    from nebula_host import vault as v

    vault.create(PASS, actor="user:o")
    e = _add(vault)
    vault.reauth_at = time.time() - v.REAUTH_WINDOW_S - 1
    with pytest.raises(v.VaultError) as ei:
        vault.reveal(e["id"], actor="u")
    assert ei.value.code == "reauth_required"
    vault.reauth(PASS, actor="u")
    assert vault.reveal(e["id"], actor="u")["value"] == CANARY


def test_weak_or_reused_passphrase_rejected(vault):
    from nebula_host import vault as v

    with pytest.raises(v.VaultError):
        vault.create("short", actor="u")
    with pytest.raises(v.VaultError):
        vault.create("aaaaaaaaaaaaaaaa", actor="u")
    with pytest.raises(v.VaultError) as ei:
        vault.create("my nebula login pw", actor="u", login_password_check=lambda p: p == "my nebula login pw")
    assert ei.value.code == "passphrase_reused"


def test_lock_clears_key_material(vault):
    vault.create(PASS, actor="user:o")
    keys = vault._keys
    vault.lock(actor="u")
    assert vault._keys is None
    assert set(keys.dek) == {0} and set(keys.mac) == {0}  # best-effort overwrite of the held key bytes


def test_canonical_origins():
    from nebula_host.vault import VaultError, canonical_origin

    assert canonical_origin("HTTPS://GitHub.com:443/login?x=1") == "https://github.com"
    assert canonical_origin("https://github.com:8443") == "https://github.com:8443"
    assert canonical_origin("http://127.0.0.1:8099/x") == "http://127.0.0.1:8099"
    for bad in ("http://github.com", "https://user:pw@github.com", "javascript:alert(1)", "github.com",
                "https://github.com\\@evil.example", "ftp://github.com"):
        with pytest.raises(VaultError):
            canonical_origin(bad)
    o = canonical_origin("https://github.com")
    for other in ("https://github.com.attacker.example", "https://github-login.example", "https://api.github.com",
                  "https://github.com:444"):
        assert canonical_origin(other) != o


def test_kdf_calibration_targets_250_500ms():
    from nebula_host import vault as v

    kdf = v.calibrate_kdf()
    assert kdf["alg"] == "argon2id" and kdf["memory_kib"] == 131072 and kdf["time_cost"] >= 2
    t0 = time.perf_counter()
    v.derive_key("x" * 20, kdf)
    ms = (time.perf_counter() - t0) * 1000
    assert 150 <= ms <= 900, ms  # target 250-500 ms on the Mac mini; generous bounds for a busy machine
