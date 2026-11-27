"""Async client for the guest service over the Swift helper's vsock<->unix bridge (HMAC framed)."""

from __future__ import annotations

import asyncio
import uuid
from pathlib import Path
from typing import Any

from nebula_contracts import rpc


class GuestUnavailable(Exception):
    pass


class GuestError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class GuestClient:
    def __init__(self, run_dir: Path, key_provider) -> None:
        self.run_dir = run_dir
        self._key_provider = key_provider

    @property
    def rpc_socket(self) -> Path:
        return self.run_dir / "vsock-7000.sock"

    @property
    def vnc_socket(self) -> Path:
        return self.run_dir / "vsock-7001.sock"

    def _key(self) -> bytes:
        k = self._key_provider()
        if not k:
            raise GuestUnavailable("guest RPC key not provisioned")
        return k

    async def _open(self, path: Path, timeout: float):
        if not path.exists():
            raise GuestUnavailable("VM is not running (no vsock bridge)")
        try:
            return await asyncio.wait_for(asyncio.open_unix_connection(str(path), limit=rpc.MAX_FRAME_BYTES), timeout)
        except (OSError, TimeoutError) as e:
            raise GuestUnavailable(f"cannot reach guest: {e}") from e

    async def call(self, method: str, params: dict[str, Any] | None = None, timeout: float = 60) -> Any:
        key = self._key()
        reader, writer = await self._open(self.rpc_socket, 5)
        req_id = str(uuid.uuid4())
        try:
            writer.write(rpc.encode_frame(rpc.sign(key, {"id": req_id, "method": method, "params": params or {}})))
            await writer.drain()
            line = await asyncio.wait_for(reader.readline(), timeout)
        except TimeoutError as e:
            raise GuestUnavailable(f"guest call {method} timed out after {timeout}s") from e
        except (ConnectionError, OSError) as e:
            raise GuestUnavailable(f"guest connection failed: {e}") from e
        finally:
            writer.close()
        if not line:
            raise GuestUnavailable("guest closed the connection (is the guest service running?)")
        body = rpc.verify(key, rpc.decode_frame(line))
        if body.get("id") not in (req_id, None):
            raise GuestError("protocol_error", "response id mismatch")
        if not body.get("ok"):
            err = body.get("error") or {}
            raise GuestError(err.get("code", "guest_error"), err.get("message", "guest error"))
        return body.get("result")

    async def tool(self, agent_id: str, tool: str, args: dict[str, Any], timeout: float = 120) -> dict[str, Any]:
        """Returns {"ok": bool, "result"|"error"} from the agent's tool server."""
        return await self.call("tool.call", {"agent_id": agent_id, "tool": tool, "args": args, "timeout": timeout},
                               timeout=timeout + 15)

    async def ping(self, timeout: float = 5) -> dict[str, Any]:
        return await self.call("ping", timeout=timeout)

    async def open_vnc(self, agent_id: str) -> tuple[asyncio.StreamReader, asyncio.StreamWriter]:
        key = self._key()
        reader, writer = await self._open(self.vnc_socket, 5)
        writer.write(rpc.encode_frame(rpc.sign(key, {"method": "vnc.tunnel", "params": {"agent_id": agent_id}})))
        await writer.drain()
        line = await asyncio.wait_for(reader.readline(), 10)
        body = rpc.verify(key, rpc.decode_frame(line))
        if not body.get("ok"):
            writer.close()
            raise GuestError("vnc_unavailable", str(body.get("error")))
        return reader, writer
