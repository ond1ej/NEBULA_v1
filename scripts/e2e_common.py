"""Shared helpers for the optional hardware E2E scripts (Mini App sign-in data, health wait, RFB probe)."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import struct
import time
import uuid
from urllib.parse import urlencode

import httpx


def init_data(token: str, user_id: int) -> str:
    """Telegram WebApp ``initData`` signed with a bot token (what the Mini App gateway verifies)."""
    fields = {"auth_date": str(int(time.time())), "query_id": "E2E" + uuid.uuid4().hex[:12],
              "user": json.dumps({"id": user_id, "first_name": "Owner"}, separators=(",", ":"))}
    dcs = "\n".join(f"{k}={v}" for k, v in sorted(fields.items()))
    secret = hmac.new(b"WebAppData", token.encode(), hashlib.sha256).digest()
    fields["hash"] = hmac.new(secret, dcs.encode(), hashlib.sha256).hexdigest()
    return urlencode(fields)


def wait_health(api, timeout=150) -> dict:
    end = time.time() + timeout
    while time.time() < end:
        try:
            h = httpx.get(f"{api.base}/api/v1/health", timeout=5).json()["data"]
            if h["status"] == "ok":
                return h
        except Exception:  # noqa: BLE001
            pass
        time.sleep(2)
    raise RuntimeError("service not healthy")


async def rfb_session(ws, *, control: bool, api_ctl=None) -> dict:
    """Minimal RFB 3.8 client over the NEBULA WebSocket: handshake, framebuffer update, optional pointer input."""
    ver = await ws.recv()
    out = {"server_version": ver[:12].decode(errors="replace")}
    await ws.send(b"RFB 003.008\n")
    n = (await ws.recv())
    types = list(n[1:1 + n[0]]) if n and n[0] else []
    out["security_types"] = types
    if 1 not in types:
        return out
    await ws.send(bytes([1]))
    res = await ws.recv()
    out["security_result"] = struct.unpack(">I", res[:4])[0]
    await ws.send(bytes([1]))  # shared
    init = await ws.recv()
    w, h = struct.unpack(">HH", init[:4])
    out["framebuffer"] = [w, h]
    await ws.send(struct.pack(">BBHHHH", 3, 0, 0, 0, w, h))  # FramebufferUpdateRequest (full)
    got = 0
    end = time.time() + 15
    while got < 4096 and time.time() < end:
        try:
            msg = await asyncio.wait_for(ws.recv(), 5)
        except TimeoutError:
            break
        got += len(msg)
    out["frame_bytes"] = got
    if control:
        await ws.send(struct.pack(">BBHH", 5, 0, w // 2, h // 2))  # PointerEvent: move
        await ws.send(struct.pack(">BBxxI", 4, 1, 0xffe1))  # KeyEvent Shift down / up
        await ws.send(struct.pack(">BBxxI", 4, 0, 0xffe1))
        out["input_sent"] = True
    return out
