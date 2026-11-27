"""SQLite (WAL, foreign keys ON) engine + Alembic-driven schema upgrades."""

from __future__ import annotations

import time
import uuid
from pathlib import Path
from typing import Any

from sqlalchemy import Engine, create_engine, event, text
from sqlalchemy.engine import Connection

from nebula_host import models

_engine: Engine | None = None


def now() -> float:
    return time.time()


def new_id() -> str:
    return str(uuid.uuid4())


def make_engine(db_path: Path) -> Engine:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    eng = create_engine(f"sqlite:///{db_path}", connect_args={"check_same_thread": False, "timeout": 30},
                        pool_pre_ping=True)

    @event.listens_for(eng, "connect")
    def _pragmas(dbapi_conn, _rec):  # pragma: no cover - trivial
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA journal_mode=WAL")
        cur.execute("PRAGMA foreign_keys=ON")
        cur.execute("PRAGMA synchronous=NORMAL")
        cur.execute("PRAGMA busy_timeout=30000")
        cur.close()

    return eng


def repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def run_migrations(db_path: Path) -> str:
    """Upgrade the DB to head using the Alembic scripts in /migrations. Returns head revision."""
    from alembic import command
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    cfg = Config()
    cfg.set_main_option("script_location", str(repo_root() / "migrations"))
    cfg.set_main_option("sqlalchemy.url", f"sqlite:///{db_path}")
    command.upgrade(cfg, "head")
    return ScriptDirectory.from_config(cfg).get_current_head() or ""


def init_engine(db_path: Path, migrate: bool = True) -> Engine:
    global _engine
    if migrate:
        run_migrations(db_path)
    _engine = make_engine(db_path)
    with _engine.begin() as c:
        _ensure_fts(c)
    return _engine


def _ensure_fts(c: Connection) -> None:
    # FTS5 index for agent memory search (spec §5.4); maintained by triggers.
    c.execute(text("CREATE VIRTUAL TABLE IF NOT EXISTS agent_memory_fts USING fts5("
                   "key, value, tags, content='agent_memory', content_rowid='rowid')"))
    c.execute(text("CREATE TRIGGER IF NOT EXISTS agent_memory_ai AFTER INSERT ON agent_memory BEGIN "
                   "INSERT INTO agent_memory_fts(rowid, key, value, tags) VALUES (new.rowid, new.key, new.value, new.tags); END"))
    c.execute(text("CREATE TRIGGER IF NOT EXISTS agent_memory_ad AFTER DELETE ON agent_memory BEGIN "
                   "INSERT INTO agent_memory_fts(agent_memory_fts, rowid, key, value, tags) "
                   "VALUES('delete', old.rowid, old.key, old.value, old.tags); END"))
    c.execute(text("CREATE TRIGGER IF NOT EXISTS agent_memory_au AFTER UPDATE ON agent_memory BEGIN "
                   "INSERT INTO agent_memory_fts(agent_memory_fts, rowid, key, value, tags) "
                   "VALUES('delete', old.rowid, old.key, old.value, old.tags); "
                   "INSERT INTO agent_memory_fts(rowid, key, value, tags) VALUES (new.rowid, new.key, new.value, new.tags); END"))


def engine() -> Engine:
    if _engine is None:
        raise RuntimeError("database not initialised")
    return _engine


def row(r: Any) -> dict[str, Any] | None:
    return dict(r._mapping) if r is not None else None


def rows(rs: Any) -> list[dict[str, Any]]:
    return [dict(r._mapping) for r in rs]


def get_setting(key: str, default: Any = None) -> Any:
    with engine().connect() as c:
        r = c.execute(models.settings.select().where(models.settings.c.key == key)).first()
    return r.value if r else default


def set_setting(key: str, value: Any) -> None:
    from sqlalchemy.dialects.sqlite import insert

    stmt = insert(models.settings).values(key=key, value=value, updated_at=now())
    stmt = stmt.on_conflict_do_update(index_elements=["key"], set_={"value": value, "updated_at": now()})
    with engine().begin() as c:
        c.execute(stmt)
