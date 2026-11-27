"""Shared fixtures: isolated data dir, in-memory secret store, app client, fake guest and fake provider."""

from __future__ import annotations

import asyncio
import base64
import io
import json
import os
from typing import Any

import pytest

os.environ["NEBULA_TESTING"] = "1"
os.environ["NEBULA_SECRET_BACKEND"] = "memory"


@pytest.fixture()
def data_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("NEBULA_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("NEBULA_LOG_DIR", str(tmp_path / "logs"))
    monkeypatch.setenv("NEBULA_PORT", "3199")
    from nebula_host.config import get_config

    get_config.cache_clear()
    yield tmp_path / "data"
    get_config.cache_clear()


@pytest.fixture()
def dbinit(data_dir):
    from nebula_host import db, providers_service, secrets
    from nebula_host.config import get_config

    cfg = get_config()
    cfg.ensure_dirs()
    secrets.init_store("memory")
    db.init_engine(cfg.db_path)
    providers_service._siwc_session = None
    providers_service.ensure_catalog()
    return cfg


def png_b64(color=(40, 80, 160), size=(64, 40), flat=False) -> str:
    from PIL import Image, ImageDraw

    img = Image.new("RGB", size, color)
    if not flat:
        ImageDraw.Draw(img).rectangle([5, 5, 20, 20], fill=(250, 250, 250))
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return base64.b64encode(buf.getvalue()).decode()


class FakeGuest:
    """In-process stand-in for the guest service: records calls, simulates per-agent workspaces."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []
        self.workspaces: dict[str, dict] = {}
        self.files: dict[tuple[str, str], str] = {}
        self.url: dict[str, str] = {}
        self.tool_delay = 0.0
        self.block: asyncio.Event | None = None
        self.fail_tools: set[str] = set()
        self.display = 21
        self.fs_base = None  # tmp dir: V2 fs.op runs the REAL guest fsop module against it
        self.shared: dict[str, list[str]] = {}
        self.plugins: dict[str, dict] = {}

    async def call(self, method: str, params: dict | None = None, timeout: float = 60) -> Any:
        params = params or {}
        self.calls.append((method, params))
        if method == "ping":
            return {"pong": True, "uptime_s": 10, "mem": {"MemAvailable": 4 << 30, "MemTotal": 6 << 30}}
        if method == "workspace.create":
            aid = params["agent_id"]
            ws = self.workspaces.get(aid)
            if not ws:
                from nebula_contracts.rpc import linux_user_for

                ws = {"linux_user": linux_user_for(aid), "display": self.display, "state": "ACTIVE"}
                self.display += 1
                self.workspaces[aid] = ws
            return {"workspace_id": f"ws-{ws['linux_user']}", "agent_id": aid, "linux_user": ws["linux_user"],
                    "display_id": f"display-{ws['display']}", "display": ws["display"],
                    "workspace_path": f"/home/{ws['linux_user']}/workspace",
                    "desktop_health": {"x_running": True, "screenshot_non_empty": True}, "created": True,
                    "capabilities": ["desktop", "browser", "shell", "files", "screenshot", "vnc"]}
        if method == "workspace.list":
            return [{"agent_id": k, **v} for k, v in self.workspaces.items()]
        if method in ("workspace.stop", "workspace.start", "workspace.kill_tools", "workspace.restart_desktop"):
            if params["agent_id"] in self.workspaces:
                self.workspaces[params["agent_id"]]["state"] = "STOPPED" if method == "workspace.stop" else "ACTIVE"
            return {"agent_id": params["agent_id"], "desktop_health": {"screenshot_non_empty": True}}
        if method == "workspace.delete":
            self.workspaces.pop(params["agent_id"], None)
            return {"deleted": True, "orphan_processes": []}
        if method == "tool.call":
            return await self._tool(params["agent_id"], params["tool"], params.get("args") or {})
        # ---- V2
        if method == "shared.ensure":
            self.shared[params["key"]] = list(params.get("agent_ids") or [])
            return {"path": f"/srv/nebula/shared/{params['key']}", "members": params.get("agent_ids") or []}
        if method == "shared.delete":
            self.shared.pop(params["key"], None)
            return {"deleted": params["key"]}
        if method == "fs.op":
            return self._fs(params)
        if method == "guest.capabilities":
            return {"pdftotext": True, "git": True, "node": True, "python3": True, "mousepad": True,
                    "shared_root": True, "plugins": sorted(self.plugins)}
        if method == "resources.agents":
            return {"agents": {aid: {"memory_bytes": 300 << 20, "units": {"desktop": "active", "tools": "active"}}
                               for aid in self.workspaces}}
        if method == "plugins.install":
            self.plugins[params["plugin_id"]] = params
            return {"installed": params["plugin_id"], "version": params["version"]}
        if method == "plugins.remove":
            self.plugins.pop(params["plugin_id"], None)
            return {"removed": params["plugin_id"]}
        if method == "packages.install":
            return {"names": params["names"], "exit_code": 0, "stdout": "ok", "stderr": ""}
        raise AssertionError(f"unexpected guest call {method}")

    def _fs(self, params: dict) -> dict:
        import pathlib

        from nebula_guest import fsop

        root = params["root"]
        base = pathlib.Path(self.fs_base or "/nonexistent")
        d = base / (f"agent-{root['agent_id']}" if root["type"] == "agent" else f"shared-{root['key']}")
        d.mkdir(parents=True, exist_ok=True)
        req = {k: v for k, v in params.items() if k != "root"}
        req["root"] = str(d)
        try:
            return {"ok": True, "result": fsop.run(req)}
        except fsop.FsError as e:
            return {"ok": False, "error": {"code": e.code, "message": str(e)}}
        except (OSError, ValueError, KeyError) as e:
            return {"ok": False, "error": {"code": type(e).__name__, "message": str(e)}}

    async def tool(self, agent_id: str, tool: str, args: dict, timeout: float = 120) -> dict:
        return await self.call("tool.call", {"agent_id": agent_id, "tool": tool, "args": args})

    async def ping(self, timeout: float = 5) -> dict:
        return await self.call("ping")

    async def _tool(self, aid: str, tool: str, args: dict) -> dict:
        if self.block is not None:
            await self.block.wait()
        if self.tool_delay:
            await asyncio.sleep(self.tool_delay)
        if tool in self.fail_tools:
            return {"ok": False, "error": {"code": "boom", "message": "simulated failure"}}
        if tool == "desktop.screenshot":
            return {"ok": True, "result": {"png_b64": png_b64(), "width": 1280, "height": 800, "non_empty": True,
                                           "display": ":21", "captured_at": 1.0, "bytes": 100}}
        if tool == "browser.navigate":
            self.url[aid] = args["url"]
            return {"ok": True, "result": {"url": args["url"], "title": "Example", "status": 200}}
        if tool == "browser.observe":
            return {"ok": True, "result": {"url": self.url.get(aid, "about:blank"), "title": "Example", "text": "hello",
                                           "elements": [{"ref": '[data-nebula-ref="n0"]', "tag": "button",
                                                         "text": "Pay now"},
                                                        {"ref": '[data-nebula-ref="n1"]', "tag": "input",
                                                         "type": "password", "text": ""}]}}
        if tool == "files.write":
            self.files[(aid, args["path"])] = args.get("content", "")
            return {"ok": True, "result": {"path": args["path"], "bytes_written": len(args.get("content", ""))}}
        if tool == "files.read":
            if (aid, args["path"]) not in self.files:
                return {"ok": False, "error": {"code": "not_a_file", "message": args["path"]}}
            c = self.files[(aid, args["path"])]
            return {"ok": True, "result": {"path": args["path"], "content": c, "size": len(c), "truncated": False}}
        if tool == "shell.execute":
            return {"ok": True, "result": {"exit_code": 0, "stdout": "ok\n", "stderr": "", "timed_out": False}}
        return {"ok": True, "result": {"tool": tool}}

    async def open_vnc(self, agent_id: str):
        raise AssertionError("not used")


class ScriptedProvider:
    """Provider adapter replaying a scripted list of turns: each turn is a list of ModelEvents."""

    adapter_type = "scripted"
    auth_modes = ["test"]

    def __init__(self, turns: list[list[Any]], *, error=None, block: asyncio.Event | None = None) -> None:
        self.id = "scripted"
        self.turns = list(turns)
        self.requests: list[Any] = []
        self.error = error
        self.block = block

    async def list_models(self, account_id: str = ""):
        from nebula_providers.base import ModelInfo

        return [ModelInfo("m", "m", supports_images=False)]

    async def stream_turn(self, req):
        from nebula_providers.base import ModelEvent

        self.requests.append(req)
        if self.block is not None:
            await self.block.wait()
        if self.error:
            raise self.error
        events = self.turns.pop(0) if self.turns else [ModelEvent("text_delta", text="done"), ModelEvent("done")]
        for e in events:
            yield e

    def estimate_cost_or_plan(self):
        return {"billing": "test"}


def call(name: str, args: dict, cid: str | None = None):
    from nebula_providers.base import ModelEvent, ToolCall

    return ModelEvent("tool_call", tool_call=ToolCall(cid or f"c_{name}_{json.dumps(args, sort_keys=True)[:20]}", name, args))


def done():
    from nebula_providers.base import ModelEvent

    return ModelEvent("done", usage={"input_tokens": 10, "output_tokens": 5})


@pytest.fixture()
def fake_guest(tmp_path):
    g = FakeGuest()
    g.fs_base = tmp_path / "guestfs"
    return g


@pytest.fixture(autouse=True)
def _stable_host_resources(monkeypatch):
    """Scheduler tests must not depend on the real Mac's memory pressure."""
    import nebula_host.vm as vm

    monkeypatch.setattr(vm, "host_resources", lambda data_dir: {
        "memory_total_bytes": 16 << 30, "memory_available_bytes": 8 << 30, "memory_free_percent": 50,
        "memory_pressure": "normal", "load_avg": [0.1, 0.1, 0.1], "cpu_count": 10, "disk_total_bytes": 1 << 40,
        "disk_free_bytes": 1 << 39, "vm_resident_bytes": 0})
    monkeypatch.setattr(vm, "memory_status", lambda: {
        "memory_pressure": "normal", "memory_free_percent": 50, "swap_used_mb": 0.0, "swap_total_mb": 0.0,
        "memory_total_bytes": 16 << 30, "ts": __import__("time").time()})
