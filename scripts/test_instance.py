#!/usr/bin/env python3
"""A temporary, isolated NEBULA TEST instance for end-to-end tests of the native iPhone / Mac apps (no VM).

Nothing here touches a real NEBULA install, its data, vault, VM, Telegram, AI quota, its ports or its gateway:
* its own data dir (a temporary one, deleted at exit, unless --data-dir / NEBULA_TEST_DATA_DIR names one), the
  in-memory secret store (never the Keychain), its own instance id ("e2e-test") and its own TEST owner account;
* the real host code: API on 127.0.0.1:3197 and the real Mini App gateway code on 127.0.0.1:3196 by default (the
  apps' only address; DEBUG builds of the apps accept plain http for loopback only). Override with --api-port /
  --gateway-port or NEBULA_TEST_API_PORT / NEBULA_TEST_GATEWAY_PORT; the default instance's 3100-3102 are refused;
* a scripted model that STREAMS a Markdown answer word by word (exercises live text streaming) — no AI;
* a fake agent desktop: an in-process RFB 3.8 server (640x400, moving content) behind NEBULA's real live broker,
  which logs every input event it receives (proves take/release control end to end);
* a synthetic vault (test passphrase) with test entries; a test agent "E2E Agent"; a pending Smart sign-in can be
  created on demand.

Writes <out>/state.json (ports, pairing link, ids, vault passphrase for the test vault) — the out dir is 0700.
Usage:  .venv/bin/python scripts/test_instance.py --out <dir> [--auto-approve] [--api-port N] [--gateway-port N]
                                                   [--data-dir DIR]
        then touch <out>/cmd-<name> to trigger: cmd-signin (a Smart sign-in request), cmd-task (a streamed task),
        cmd-pair (a fresh pairing offer), cmd-stop.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import shutil
import struct
import sys
import tempfile
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / "apps/host-api"), str(ROOT / "apps/setup"), str(ROOT / "packages/contracts"),
                str(ROOT / "packages/agent-runtime"), str(ROOT / "packages/provider-adapters"),
                str(ROOT / "packages/telegram-gateway"), str(ROOT / "packages/live-broker")]

API_PORT, GW_PORT = 3197, 3196  # defaults; see resolve_settings()
RESERVED_PORTS = range(3100, 3103)  # the default instance's dashboard, API and gateway ports
TEST_INSTANCE = "e2e-test"
ANSWER = ("Sure, here is a **status overview**:\n\n## Summary\n\n1. The NEBULA server is running on the Mac mini.\n"
          "2. The agent works in an isolated environment.\n3. Response streaming works *smoothly*.\n\n"
          "```python\nfor step in range(3):\n    print(f\"step {step}\")\n```\n\n> Done – I changed nothing.\n")
# Fixture texts the iOS / macOS UI tests look for (shared contract: they match "E2E conversation",
# "Long conversation" and "I changed nothing" only). Everything here is English.
CONVERSATION_TITLE = "E2E conversation"
LONG_CONVERSATION_TITLE = "Long conversation"
TASK_PROMPT = "Summarize the status (test)"


def seed_message(i: int, user: bool) -> str:
    """Message i of the seeded long conversation (alternating user question and Markdown assistant answer)."""
    if user:
        return f"Question {i}: summarize step {i // 2}"
    return (f"Answer **{i}**\n\n- point A\n- point B\n\n```python\nprint({i})\n```\n"
            + "Paragraph text. " * (i % 7 + 1))


def resolve_settings(args, env=os.environ) -> dict:
    """Ports and data dir from flags, then NEBULA_TEST_* env vars, then defaults. Refuses anything that could reach
    a real install (its ports or its data dir)."""
    from nebula_host.config import standard_data_dir

    api = int(args.api_port or env.get("NEBULA_TEST_API_PORT") or API_PORT)
    gw = int(args.gateway_port or env.get("NEBULA_TEST_GATEWAY_PORT") or GW_PORT)
    for name, port in (("api", api), ("gateway", gw)):
        if port in RESERVED_PORTS or not 1024 <= port <= 65535:
            raise SystemExit(f"refusing {name} port {port}: use a free port outside 3100-3102")
    if api == gw:
        raise SystemExit("api and gateway ports must differ")
    data = args.data_dir or env.get("NEBULA_TEST_DATA_DIR")
    keep = bool(data)
    if data:
        data_dir = Path(data).expanduser().resolve()
        std = standard_data_dir().resolve()
        if data_dir == std or std in data_dir.parents or (data_dir.name.startswith("NEBULA")
                                                           and data_dir.parent == std.parent):
            raise SystemExit(f"refusing data dir {data_dir}: that is (or belongs to) a real NEBULA instance")
    else:
        data_dir = Path(tempfile.mkdtemp(prefix="nebula-test-instance-"))
    return {"api_port": api, "gateway_port": gw, "base": data_dir, "keep": keep}


# ------------------------------------------------------------------ fake agent desktop (RFB 3.8, security None)
class FakeDesktop:
    W, H = 640, 400

    def __init__(self) -> None:
        self.inputs: list[dict] = []
        self.frames = 0
        self.port = 0

    async def start(self) -> None:
        srv = await asyncio.start_server(self.handle, "127.0.0.1", 0)
        self.port = srv.sockets[0].getsockname()[1]
        self.server = srv

    def frame(self) -> bytes:
        t = self.frames
        self.frames += 1
        row = bytearray()
        for x in range(self.W):
            row += bytes(((x + t * 8) % 256, (x // 3) % 256, 160, 0))  # BGRX gradient that moves
        out = bytearray()
        for y in range(self.H):
            if 150 <= y < 250:
                out += bytes((40, 40, 40, 0)) * 100 + row[400:]
                continue
            out += row
        return bytes(out)

    async def handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            writer.write(b"RFB 003.008\n")
            await reader.readexactly(12)
            writer.write(bytes([1, 1]))  # one security type: None
            await reader.readexactly(1)
            writer.write(struct.pack(">I", 0))
            await reader.readexactly(1)  # ClientInit
            name = b"NEBULA E2E desktop"
            writer.write(struct.pack(">HHBBBBHHHBBBxxxI", self.W, self.H, 32, 24, 0, 1, 255, 255, 255, 16, 8, 0,
                                     len(name)) + name)
            await writer.drain()
            while True:
                t = (await reader.readexactly(1))[0]
                if t == 0:
                    await reader.readexactly(19)  # SetPixelFormat (we always send BGRX 32-bit)
                elif t == 2:
                    (n,) = struct.unpack(">xH", await reader.readexactly(3))
                    await reader.readexactly(4 * n)
                elif t == 3:
                    await reader.readexactly(9)
                    await asyncio.sleep(1 / 15)
                    hdr = struct.pack(">BxH", 0, 1) + struct.pack(">HHHHi", 0, 0, self.W, self.H, 0)
                    writer.write(hdr + self.frame())
                    await writer.drain()
                elif t == 4:
                    down, key = struct.unpack(">BxxI", await reader.readexactly(7))
                    self.inputs.append({"type": "key", "down": bool(down), "keysym": key, "at": time.time()})
                elif t == 5:
                    mask, x, y = struct.unpack(">BHH", await reader.readexactly(5))
                    self.inputs.append({"type": "pointer", "mask": mask, "x": x, "y": y, "at": time.time()})
                elif t == 6:
                    (n,) = struct.unpack(">xxxI", await reader.readexactly(7))
                    await reader.readexactly(n)
                else:
                    return
        except (asyncio.IncompleteReadError, ConnectionError):
            return
        finally:
            writer.close()


def make_guest(desktop: FakeDesktop, base: Path):
    """The test suite's FakeGuest (workspaces, tools, files) with a working Live Desktop."""
    from tests.conftest import FakeGuest

    class E2EGuest(FakeGuest):
        async def open_vnc(self, agent_id: str):
            return await asyncio.open_connection("127.0.0.1", desktop.port)

    g = E2EGuest()
    g.fs_base = base / "guestfs"
    return g


class StreamingModel:
    """Streams ANSWER in small chunks (like a real model) and finishes without tools."""

    adapter_type = "scripted"
    auth_modes = ["test"]
    id = "scripted"

    async def list_models(self, account_id: str = ""):
        from nebula_providers.base import ModelInfo

        return [ModelInfo("m", "m", supports_images=False)]

    async def stream_turn(self, req):
        from nebula_providers.base import ModelEvent

        words = ANSWER.split(" ")
        for i, w in enumerate(words):
            await asyncio.sleep(0.045)
            yield ModelEvent("text_delta", text=w + (" " if i < len(words) - 1 else ""))
        yield ModelEvent("done", usage={"input_tokens": 10, "output_tokens": 60})

    def estimate_cost_or_plan(self):
        return {"billing": "test"}


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--auto-approve", action="store_true")
    ap.add_argument("--api-port", type=int, help="API port (default: NEBULA_TEST_API_PORT or 3197)")
    ap.add_argument("--gateway-port", type=int, help="gateway port (default: NEBULA_TEST_GATEWAY_PORT or 3196)")
    ap.add_argument("--data-dir", help="base dir for data + logs, kept at exit (default: NEBULA_TEST_DATA_DIR or a "
                                       "temporary dir deleted at exit)")
    args = ap.parse_args()
    global API_PORT, GW_PORT
    settings = resolve_settings(args)
    API_PORT, GW_PORT = settings["api_port"], settings["gateway_port"]
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    os.chmod(out, 0o700)
    tmp = settings["base"]
    tmp.mkdir(parents=True, exist_ok=True)
    os.chmod(tmp, 0o700)
    os.environ.update(NEBULA_TESTING="1", NEBULA_SECRET_BACKEND="memory", NEBULA_DATA_DIR=str(tmp / "data"),  # noqa: S106
                      NEBULA_LOG_DIR=str(tmp / "logs"), NEBULA_PORT=str(API_PORT), NEBULA_INSTANCE=TEST_INSTANCE)
    os.environ.pop("NEBULA_KEYCHAIN_SERVICE", None)
    import httpx
    import uvicorn
    from nebula_host import auth, db, devices, models, providers_service, remote
    from nebula_host import secrets as sec
    from nebula_host import vault as vaultmod
    from nebula_host.app import create_app
    from nebula_host.config import get_config
    from nebula_host.state import svc

    get_config.cache_clear()
    vaultmod.calibrate_kdf = lambda *a, **k: {"alg": "argon2id", "salt": vaultmod.b64e(os.urandom(16)),
                                              "time_cost": 2, "memory_kib": 8192, "parallelism": 1}
    # this TEST instance runs a scripted model, not a local LLM: admission must not depend on the Mac's real memory
    import nebula_host.vm as vmmod

    vmmod.host_resources = lambda data_dir: {
        "memory_total_bytes": 16 << 30, "memory_available_bytes": 8 << 30, "memory_free_percent": 50,
        "memory_pressure": "normal", "load_avg": [0.1, 0.1, 0.1], "cpu_count": 10, "disk_total_bytes": 1 << 40,
        "disk_free_bytes": 1 << 39, "vm_resident_bytes": 0}
    vmmod.memory_status = lambda: {"memory_pressure": "normal", "memory_free_percent": 50, "swap_used_mb": 0.0,
                                   "swap_total_mb": 0.0, "memory_total_bytes": 16 << 30, "ts": time.time()}
    model = StreamingModel()
    providers_service.adapter_for = lambda pid: model
    desktop = FakeDesktop()
    await desktop.start()
    guest = make_guest(desktop, tmp)

    app = create_app()
    api = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=API_PORT, log_level="warning", lifespan="on"))
    api_task = asyncio.create_task(api.serve())
    while not api.started:
        await asyncio.sleep(0.05)
    assert isinstance(sec.store(), sec.MemoryStore), "never the owner's keychain"
    svc.guest = guest
    for obj in (svc.orch, svc.live, svc.telegram, svc.teams, svc.files, svc.resources):
        obj.guest = guest

    origin = {"Origin": f"http://127.0.0.1:{API_PORT}"}
    owner_pw = "e2e test owner " + uuid.uuid4().hex
    vault_pass = "e2e test vault passphrase " + uuid.uuid4().hex[:6]
    async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{API_PORT}", headers=origin, timeout=30) as c:
        r = await c.post("/api/v1/auth/setup", json={"username": "owner", "password": owner_pw,
                                                     "setup_token": auth.ensure_setup_token()})
        h = {"x-csrf-token": r.json()["data"]["csrf_token"]}
        ra = await c.post("/api/v1/agents", json={"name": "E2E Agent", "provider_id": "ollama-local", "model_id": "m",
                                                   "permission_level": "STANDARD"},
                          headers={**h, "Idempotency-Key": str(uuid.uuid4())})
        assert ra.status_code == 201, ra.text
        a = ra.json()["data"]
        with db.engine().begin() as conn:
            conn.execute(models.agents.update().where(models.agents.c.id == a["id"]).values(status="READY"))
        conv = (await c.post("/api/v1/conversations", json={"agent_id": a["id"], "title": CONVERSATION_TITLE},
                             headers=h)).json()["data"]
        assert (await c.post("/api/v1/vault", json={"passphrase": vault_pass}, headers=h)).status_code == 201
        for name, origin_, user in (("E2E Mail", "https://mail.example.com", "e2e@example.com"),
                                    ("E2E Teams", "https://teams.microsoft.com", "e2e@contoso.example")):
            await c.post("/api/v1/vault/entries", json={"display_name": name, "origin": origin_, "username": user,
                                                        "password": "e2e-synthetic-" + uuid.uuid4().hex[:8]},
                         headers=h)
        await c.post("/api/v1/vault/lock", headers=h)

        # the gateway: the REAL gateway code, on its own loopback port
        db.set_setting("remote", {"enabled": True, "port": GW_PORT, "public_url": "https://nebula-e2e.invalid",
                                  "tunnel": "custom", "rate_limit_per_min": 2000})
        gw_app = remote.build_gateway(API_PORT, Path("/nonexistent"))
        gw = uvicorn.Server(uvicorn.Config(gw_app, host="127.0.0.1", port=GW_PORT, log_level="warning", lifespan="off"))
        gw_task = asyncio.create_task(gw.serve())
        while not gw.started:
            await asyncio.sleep(0.05)

        def pairing() -> dict:
            o = devices.create_pairing(actor="user:owner", public_url="https://nebula-e2e.invalid")
            o["app_link"] = o["url"].replace("u=https%3A%2F%2Fnebula-e2e.invalid", f"u=http%3A%2F%2F127.0.0.1%3A{GW_PORT}")
            return o

        offer = pairing()
        state = {"api": f"http://127.0.0.1:{API_PORT}", "gateway": f"http://127.0.0.1:{GW_PORT}",
                 "pairing_link": offer["app_link"], "agent_id": a["id"], "conversation_id": conv["id"],
                 "vault_passphrase": vault_pass, "started_at": time.time(), "devices": [], "desktop_inputs": 0}

        def save() -> None:
            state["desktop_inputs"] = len(desktop.inputs)
            state["desktop_input_kinds"] = sorted({i["type"] for i in desktop.inputs})
            state["desktop_frames"] = desktop.frames
            state["devices"] = devices.list_devices()
            p = out / "state.json"
            p.write_text(json.dumps(state, indent=2, default=str))
            os.chmod(p, 0o600)

        save()
        print(json.dumps({"ready": True, "gateway": state["gateway"], "state": str(out / "state.json")}), flush=True)
        try:
            while True:
                await asyncio.sleep(0.5)
                if args.auto_approve:
                    for d in devices.list_devices():
                        if d["status"] == "pending":
                            devices.approve(d["id"], actor="user:owner")
                for cmd in sorted(out.glob("cmd-*")):
                    name = cmd.name[4:]
                    cmd.unlink()
                    if name == "stop":
                        raise KeyboardInterrupt
                    if name == "pair":
                        state["pairing_link"] = pairing()["app_link"]
                    if name == "task":
                        r = await c.post(f"/api/v1/conversations/{conv['id']}/messages",
                                         json={"content": TASK_PROMPT, "client_id": "srv-" + uuid.uuid4().hex},
                                         headers=h)
                        state["last_task"] = (r.json()["data"].get("task") or {}).get("id")
                    if name == "seed":  # a long conversation for scroll / memory measurements
                        lc = (await c.post("/api/v1/conversations", json={"agent_id": a["id"],
                                                                          "title": LONG_CONVERSATION_TITLE},
                                           headers=h)).json()["data"]
                        now = time.time() - 600 * 30
                        with db.engine().begin() as conn:
                            for i in range(600):
                                user = i % 2 == 0
                                body = seed_message(i, user)
                                conn.execute(models.messages.insert().values(
                                    id=str(uuid.uuid4()), agent_id=a["id"], task_id=None,
                                    role="user" if user else "assistant", channel="web", content=body,
                                    attachments=[], created_at=now + i * 30, conversation_id=lc["id"]))
                            conn.execute(models.conversations.update().where(models.conversations.c.id == lc["id"])
                                         .values(last_message_at=now + 600 * 30, updated_at=now + 600 * 30))
                        state["long_conversation_id"] = lc["id"]
                    if name == "approve":
                        for d in devices.list_devices():
                            if d["status"] == "pending":
                                devices.approve(d["id"], actor="user:owner")
                save()
        except (KeyboardInterrupt, asyncio.CancelledError):
            pass
        finally:
            save()
            gw.should_exit = True
            api.should_exit = True
            await asyncio.gather(gw_task, api_task, return_exceptions=True)
            if not settings["keep"]:
                shutil.rmtree(tmp, ignore_errors=True)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except KeyboardInterrupt:
        sys.exit(0)
