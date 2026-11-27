"""Migration 0007 (V3.2.1): Smart Authentication tables are additive; down/up round trip keeps every other row and
no column can hold a secret value."""

from __future__ import annotations

import sqlite3

from tests.integration.test_v32_migration import _cfg, _counts


def test_0007_additive_round_trip(tmp_path):
    from alembic import command

    db = tmp_path / "m.db"
    cfg = _cfg(db)
    command.upgrade(cfg, "0006")
    before = _counts(db)
    command.upgrade(cfg, "head")
    c = sqlite3.connect(db)
    tables = {r[0] for r in c.execute("select name from sqlite_master where type='table'")}
    assert {"auth_sessions", "auth_requests", "auth_events"} <= tables
    cols = {t: [r[1] for r in c.execute(f"pragma table_info({t})")] for t in ("auth_sessions", "auth_requests",
                                                                             "auth_events")}
    flat = " ".join(" ".join(v) for v in cols.values())
    for word in ("password", "secret", "cookie", "otp_value", "code_value", "token\b"):
        assert word not in flat.replace("token_hash", "").replace("token_expires_at", "")
    c.close()
    command.downgrade(cfg, "0006")
    c = sqlite3.connect(db)
    assert not {"auth_sessions", "auth_requests", "auth_events"} & {
        r[0] for r in c.execute("select name from sqlite_master where type='table'")}
    c.close()
    command.upgrade(cfg, "head")
    assert _counts(db) == before
