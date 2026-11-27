"""Migration 0006 (V3.2): existing messages/tasks move into one default conversation per agent; downgrade/upgrade
round trip keeps every row; vault tables start empty (the vault is never created automatically)."""

from __future__ import annotations

import sqlite3
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def _cfg(db: Path):
    from alembic.config import Config

    cfg = Config(str(ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(ROOT / "migrations"))
    cfg.set_main_option("sqlalchemy.url", f"sqlite:///{db}")
    return cfg


def _counts(db: Path) -> dict:
    c = sqlite3.connect(db)
    out = {t: c.execute(f"select count(*) from {t}").fetchone()[0] for t in ("agents", "tasks", "messages")}
    out["integrity"] = c.execute("pragma integrity_check").fetchone()[0]
    out["fk_violations"] = len(c.execute("pragma foreign_key_check").fetchall())
    return out


def test_0006_upgrade_links_history_and_round_trips(tmp_path):
    from alembic import command

    db = tmp_path / "m.db"
    cfg = _cfg(db)
    command.upgrade(cfg, "0005")
    c = sqlite3.connect(db)
    now = time.time()
    c.execute("insert into users (id, username, password_hash, role, recovery_policy, failed_attempts, created_at) "
              "values ('u1','owner','x','admin','local_reset_cli',0,?)", (now,))
    agents = []
    for i in range(3):
        aid = str(uuid.uuid4())
        agents.append(aid)
        c.execute("insert into agents (id, name, description, status, task_type, permission_level, permissions, "
                  "capabilities, resource_mode, linux_user, desktop_resolution, created_at, updated_at) "
                  "values (?,?,'',?,'general',?,'[]','[]','balanced',?,?,?,?)",
                  (aid, f"Agent {i}", "READY", "STANDARD", f"nebula_a{i}", "1280x800", now, now))
    for aid in agents[:2]:  # agent 3 has no history -> no conversation created by the migration
        for j in range(4):
            tid = str(uuid.uuid4())
            c.execute("insert into tasks (id, agent_id, prompt, state, current_step, retry_count, tool_calls_done, "
                      "max_steps, requires_approval, source_channel, created_at, updated_at) "
                      "values (?,?,?,?,0,0,0,30,0,'web',?,?)", (tid, aid, f"p{j}", "COMPLETED", now + j, now + j))
            c.execute("insert into messages (id, agent_id, task_id, role, channel, content, attachments, created_at) "
                      "values (?,?,?,?,?,?,?,?)", (str(uuid.uuid4()), aid, tid, "user", "web", f"m{j}", "[]", now + j))
    c.commit()
    before = _counts(db)
    command.upgrade(cfg, "head")
    after = _counts(db)
    assert {k: after[k] for k in before} == before
    c = sqlite3.connect(db)
    convs = c.execute("select agent_id, is_default, title, last_message_at, last_read_at from conversations").fetchall()
    assert len(convs) == 2 and all(r[1] == 1 for r in convs) and {r[0] for r in convs} == set(agents[:2])
    assert c.execute("select count(*) from messages where conversation_id is null").fetchone()[0] == 0
    assert c.execute("select count(*) from tasks where conversation_id is null").fetchone()[0] == 0
    assert all(r[4] >= r[3] for r in convs)  # history is marked read
    assert c.execute("select count(*) from vault_metadata").fetchone()[0] == 0  # never created automatically
    assert c.execute("select count(*) from vault_agent_grants").fetchone()[0] == 0  # deny by default
    command.downgrade(cfg, "0005")
    assert _counts(db) == before
    command.upgrade(cfg, "head")
    assert _counts(db) == after
    assert after["integrity"] == "ok" and after["fk_violations"] == 0
