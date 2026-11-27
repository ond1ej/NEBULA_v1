"""Process-wide service container (initialised in the app lifespan)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass
class Services:
    cfg: Any = None
    guest: Any = None
    vm: Any = None
    orch: Any = None
    live: Any = None
    telegram: Any = None
    lan: Any = None
    teams: Any = None
    schedules: Any = None
    workflows: Any = None
    files: Any = None
    resources: Any = None
    host: Any = None  # V3: native macOS execution
    companies: Any = None  # V3: AI Company Mode 2.0
    bots: Any = None  # V3: per-agent Telegram bots
    remote: Any = None  # V3: Mini App gateway / tunnels
    started_at: float = 0.0


svc = Services()
