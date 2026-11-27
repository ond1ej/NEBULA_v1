"""NEBULA-side Telegram processing latency (update in -> Bot API call out), measured against the fake Bot API, so only
NEBULA's own work is timed (no Telegram network). Guards against regressions with generous bounds. The measurements
are written to telegram-inprocess.json in the test's own temporary directory, never into the checkout, and a failing
bound reports them in the assertion message."""

from __future__ import annotations

import json
import statistics
import time

from tests.integration.test_telegram import _bind, _pair, msg, tg  # noqa: F401

REPORT_NAME = "telegram-inprocess.json"


def _p(xs):
    xs = sorted(xs)
    return {"n": len(xs), "p50_ms": round(statistics.median(xs), 2),
            "p95_ms": round(xs[min(len(xs) - 1, int(0.95 * (len(xs) - 1)))], 2), "max_ms": round(xs[-1], 2)}


async def test_command_processing_latency(tg, fake_guest, tmp_path):  # noqa: F811
    g, fake, orch, _ = tg
    await _bind()
    from nebula_host import agents_service

    a = await agents_service.create(fake_guest, {"name": "Dev", "provider_id": "ollama-local", "model_id": "m"}, "t")
    p = await _pair(g, fake)
    await g.approve(p["pairing_id"], "owner")
    thread = next(t for t in g.public_status()["topics"] if t["agent_id"] == a["id"])["message_thread_id"]
    res = {}
    for name, text, th in (("status", "/status", None), ("agents", "/agents", None), ("help", "/help", None),
                           ("task_submit", "open the docs", thread)):
        xs = []
        for i in range(15):
            fake.sent.clear()
            t = time.perf_counter()
            await g._process(msg(7, 7, text if name != "task_submit" else f"{text} {i}", thread=th))
            xs.append((time.perf_counter() - t) * 1000)
            assert any(m in ("sendMessage", "editMessageText") for m, _ in fake.sent), name  # it answered
        res[name] = _p(xs[2:])
    (tmp_path / REPORT_NAME).write_text(json.dumps(res, indent=1))
    for name, st in res.items():
        assert st["p95_ms"] < 250, (name, st, res)  # NEBULA's own processing; Telegram's network adds its RTT
