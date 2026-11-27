"""On-demand Live Desktop broker (spec §8).

DISCONNECTED -> CONNECTING -> VIEWING -> DISCONNECTING -> DISCONNECTED (+ ERROR_RETRYABLE)

* POST connect creates a short-TTL viewer session (read-only) and returns a one-time token (never stored raw).
* Only when the browser opens the WebSocket with that token (+ the dashboard cookie) does the broker open the
  authenticated vsock VNC tunnel for exactly that agent. No viewer => no tunnel => no frames.
* Exclusive control lease per agent; input is filtered server-side (RFBClientFilter).
* L-04: a WebSocket that passed `authorize_ws` is registered as "opening" before its caller claims the session
  (CONNECTING -> VIEWING, `nebula_host.remote.claim_live_session`), and stays registered until the viewer exists, so
  the 5 s reaper never finalizes a session whose VNC tunnel is still being opened. A session that was disconnected
  in the meantime is never revived by the stream that was opening it.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import secrets
import time
import uuid
from typing import Any

from nebula_host import db, models
from nebula_host.events import audit, bus
from sqlalchemy import and_, exists, select, update

from nebula_live.rfb import RFBClientFilter

log = logging.getLogger("nebula.live")

# Longest time from a successful authorize_ws to the registered viewer (open_vnc takes up to ~15 s). After it, a
# claimed session without a viewer is treated as gone by the reaper.
OPEN_GRACE_S = 60.0


def _h(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


class ActiveViewer:
    def __init__(self, session_id: str, agent_id: str) -> None:
        self.session_id = session_id
        self.agent_id = agent_id
        self.filter = RFBClientFilter()
        self.close_event = asyncio.Event()
        self.bytes_out = 0
        self.started = time.time()


class LiveBroker:
    def __init__(self, cfg, guest, orchestrator) -> None:
        self.cfg = cfg
        self.guest = guest
        self.orch = orchestrator
        self.viewers: dict[str, ActiveViewer] = {}
        self._opening: dict[str, float] = {}  # session id -> deadline: authorised, VNC tunnel not open yet
        self._reaper: asyncio.Task | None = None

    async def start(self) -> None:
        with db.engine().begin() as c:  # after restart nothing is streaming
            c.execute(update(models.live_sessions).where(models.live_sessions.c.state != "DISCONNECTED")
                      .values(state="DISCONNECTED", ended_at=db.now(), control_lease=False))
        self._reaper = asyncio.create_task(self._reap_loop(), name="live-reaper")

    async def stop(self) -> None:
        if self._reaper:
            self._reaper.cancel()
        for v in list(self.viewers.values()):
            v.close_event.set()

    # ---------------------------------------------------------------- REST
    def connect(self, agent_id: str, viewer_session_id: str) -> dict[str, Any]:
        sid = str(uuid.uuid4())
        token = secrets.token_urlsafe(32)
        now = db.now()
        ttl = self.cfg.live.viewer_session_ttl_seconds
        with db.engine().begin() as c:
            c.execute(models.live_sessions.insert().values(
                id=sid, agent_id=agent_id, viewer_session_id=viewer_session_id, token_hash=_h(token),
                state="CONNECTING", control_lease=False, created_at=now, expires_at=now + ttl, last_seen_at=now))
        audit(f"session:{viewer_session_id}", "live.connect", agent_id, {"live_session_id": sid})
        return {"session_id": sid, "token": token, "state": "CONNECTING", "read_only": True,
                "ws_path": f"/api/v1/live/ws/{sid}", "expires_at": now + ttl, "ttl_seconds": ttl}

    def get(self, sid: str) -> dict[str, Any] | None:
        with db.engine().connect() as c:
            return db.row(c.execute(select(models.live_sessions).where(models.live_sessions.c.id == sid)).first())

    async def disconnect(self, sid: str, reason: str = "user") -> dict[str, Any]:
        s = self.get(sid)
        if s is None:
            return {"session_id": sid, "state": "DISCONNECTED"}
        self._set(sid, state="DISCONNECTING")
        v = self.viewers.get(sid)
        if v:
            v.close_event.set()
            for _ in range(50):
                if sid not in self.viewers:
                    break
                await asyncio.sleep(0.05)
        await self._finalize(sid, reason)
        return {"session_id": sid, "state": "DISCONNECTED", "active_stream": sid in self.viewers}

    async def control(self, sid: str, action: str) -> dict[str, Any]:
        s = self.get(sid)
        if s is None or s["state"] not in ("VIEWING", "CONNECTING"):
            raise LookupError("live session is not active")
        agent_id = s["agent_id"]
        if action == "acquire":
            # Claim the lease in ONE conditional UPDATE before awaiting anything (audit VM-14): a separate
            # "is it free?" check followed by a later set let two viewers both get input.
            # the claim must outlive the wait for the agent's in-flight GUI action (acquire_control: up to 60 s)
            if not self._claim_lease(sid, agent_id, time.time() + max(self.cfg.live.control_lease_seconds, 90)):
                raise PermissionError("another viewer holds the control lease")
            try:
                await self.orch.acquire_control(agent_id, sid)
            except BaseException:
                self._set(sid, control_lease=False, lease_expires_at=None)
                raise
            exp = time.time() + self.cfg.live.control_lease_seconds
            self._set(sid, control_lease=True, lease_expires_at=exp)
            v = self.viewers.get(sid)
            if v:
                v.filter.allow_input = True
            audit(f"session:{s['viewer_session_id']}", "live.control.acquire", agent_id)
            return {"session_id": sid, "control": True, "lease_expires_at": exp}
        if action == "renew":
            if not s["control_lease"]:
                raise PermissionError("no lease to renew")
            exp = time.time() + self.cfg.live.control_lease_seconds
            self._set(sid, lease_expires_at=exp)
            return {"session_id": sid, "control": True, "lease_expires_at": exp}
        if action == "release":
            self._release(sid, agent_id)
            return {"session_id": sid, "control": False}
        raise ValueError("action must be acquire|renew|release")

    def _claim_lease(self, sid: str, agent_id: str, exp: float) -> bool:
        """Atomically take the control lease for `sid` unless another live session of the agent holds an
        unexpired one. True when this call (or an earlier one) holds it."""
        ls = models.live_sessions
        other = ls.alias("other_lease")
        held_elsewhere = exists().where(and_(
            other.c.agent_id == agent_id, other.c.control_lease.is_(True), other.c.id != sid,
            other.c.lease_expires_at > time.time()))
        with db.engine().begin() as c:
            res = c.execute(update(ls).where(and_(ls.c.id == sid, ~held_elsewhere))
                            .values(control_lease=True, lease_expires_at=exp))
            return res.rowcount == 1

    def _release(self, sid: str, agent_id: str) -> None:
        self._set(sid, control_lease=False, lease_expires_at=None)
        v = self.viewers.get(sid)
        if v:
            v.filter.allow_input = False
        self.orch.release_control(agent_id)

    def _set(self, sid: str, **vals: Any) -> None:
        with db.engine().begin() as c:
            c.execute(update(models.live_sessions).where(models.live_sessions.c.id == sid).values(**vals))

    async def _finalize(self, sid: str, reason: str) -> None:
        s = self.get(sid)
        if s is None or s["state"] == "DISCONNECTED":
            return
        if s["control_lease"] and self.cfg.live.release_control_on_disconnect:
            self._release(sid, s["agent_id"])
        self._set(sid, state="DISCONNECTED", ended_at=db.now())
        bus.publish("live.viewer.left", {"live_session_id": sid, "reason": reason}, agent_id=s["agent_id"])

    # ---------------------------------------------------------------- WebSocket stream
    def authorize_ws(self, sid: str, token: str, viewer_session_id: str) -> dict[str, Any]:
        s = self.get(sid)
        if s is None:
            raise PermissionError("unknown live session")
        if s["viewer_session_id"] != viewer_session_id:
            raise PermissionError("session belongs to another login")
        if not secrets.compare_digest(s["token_hash"], _h(token or "")):
            raise PermissionError("bad token")
        if s["state"] != "CONNECTING":
            raise PermissionError(f"session is {s['state']} (tokens are single-use)")
        if s["expires_at"] < time.time():
            raise PermissionError("session expired")
        # L-04: registered BEFORE the caller's claim moves the session to VIEWING, so the reaper (which finalizes
        # "VIEWING without a viewer") cannot end it while the tunnel is being opened. The claim stays single-use.
        self._opening[sid] = time.time() + OPEN_GRACE_S
        return s

    def is_opening(self, sid: str, now: float | None = None) -> bool:
        """True while an authorised WebSocket of `sid` is still opening its VNC tunnel (within OPEN_GRACE_S)."""
        deadline = self._opening.get(sid)
        if deadline is None:
            return False
        if deadline < (time.time() if now is None else now):
            self._opening.pop(sid, None)
            return False
        return True

    def _mark_viewing(self, sid: str) -> bool:
        """CONNECTING/VIEWING -> VIEWING in one conditional UPDATE. False when the session was disconnected,
        expired or reaped while the tunnel was opening: such a session is never revived."""
        ls = models.live_sessions
        now = db.now()
        with db.engine().begin() as c:
            n = c.execute(update(ls).where(and_(ls.c.id == sid, ls.c.state.in_(["CONNECTING", "VIEWING"])))
                          .values(state="VIEWING", last_seen_at=now,
                                  expires_at=now + self.cfg.live.viewer_session_ttl_seconds)).rowcount
        return n == 1

    async def stream(self, ws, s: dict[str, Any]) -> None:
        """Pump bytes between the noVNC WebSocket and the guest VNC tunnel of exactly s['agent_id']."""
        sid, agent_id = s["id"], s["agent_id"]
        if sid in self.viewers:  # one stream per live session (the claim already makes the token single-use)
            self._opening.pop(sid, None)
            await ws.close(code=4403, reason="session already in use (tokens are single-use)")
            return
        self._opening[sid] = max(self._opening.get(sid, 0.0), time.time() + OPEN_GRACE_S)
        try:
            reader, writer = await self.guest.open_vnc(agent_id)
        except Exception as e:  # noqa: BLE001
            self._opening.pop(sid, None)
            self._set(sid, state="ERROR_RETRYABLE", ended_at=db.now())
            await ws.close(code=1011, reason=f"desktop unavailable: {str(e)[:80]}")
            return
        v = ActiveViewer(sid, agent_id)
        v.filter.allow_input = bool(s.get("control_lease"))
        self.viewers[sid] = v
        self._opening.pop(sid, None)
        if not self._mark_viewing(sid):  # disconnected (or reaped) while the tunnel was opening
            self.viewers.pop(sid, None)
            try:
                writer.close()
            except Exception:  # noqa: BLE001
                pass
            try:
                await ws.close(code=1000, reason="live session ended")
            except Exception:  # noqa: BLE001
                pass
            log.info("live session %s ended before its tunnel opened", sid)
            return
        bus.publish("live.viewer.joined", {"live_session_id": sid}, agent_id=agent_id)

        async def to_viewer() -> None:
            while True:
                data = await reader.read(65536)
                if not data:
                    break
                v.bytes_out += len(data)
                await ws.send_bytes(data)

        async def from_viewer() -> None:
            while True:
                msg = await ws.receive()
                if msg["type"] == "websocket.disconnect":
                    break
                data = msg.get("bytes") or (msg.get("text") or "").encode()
                fwd = v.filter.feed(data)
                if fwd:
                    writer.write(fwd)
                    await writer.drain()
                self._touch(sid)

        tasks = [asyncio.create_task(to_viewer()), asyncio.create_task(from_viewer()),
                 asyncio.create_task(v.close_event.wait())]
        try:
            await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for t in tasks:
                t.cancel()
            try:
                writer.close()
            except Exception:  # noqa: BLE001
                pass
            try:
                await ws.close()
            except Exception:  # noqa: BLE001
                pass
            self.viewers.pop(sid, None)
            self._set(sid, bytes_to_viewer=v.bytes_out)
            await self._finalize(sid, "stream_closed")
            log.info("live session %s closed after %.1fs, %d bytes, %d input msgs dropped", sid,
                     time.time() - v.started, v.bytes_out, v.filter.dropped)

    _last_touch: dict[str, float] = {}

    def _touch(self, sid: str) -> None:
        now = time.time()
        if now - self._last_touch.get(sid, 0) > 10:
            self._last_touch[sid] = now
            self._set(sid, last_seen_at=now, expires_at=now + self.cfg.live.viewer_session_ttl_seconds)

    def active_streams(self, agent_id: str | None = None) -> list[dict[str, Any]]:
        return [{"session_id": v.session_id, "agent_id": v.agent_id, "bytes_out": v.bytes_out,
                 "control": v.filter.allow_input} for v in self.viewers.values()
                if agent_id is None or v.agent_id == agent_id]

    async def _reap_loop(self) -> None:
        while True:
            await asyncio.sleep(5)
            try:
                await self.reap_once()
            except Exception:
                log.exception("live reaper failed")

    async def reap_once(self, now: float | None = None) -> None:
        """One reaper pass: end sessions never opened or whose viewer is gone, and release expired leases.
        A session that is still opening its tunnel (L-04) is left alone until OPEN_GRACE_S has passed."""
        now = time.time() if now is None else now
        for sid in [k for k, d in self._opening.items() if d < now]:
            self._opening.pop(sid, None)
        with db.engine().connect() as c:
            stale = db.rows(c.execute(select(models.live_sessions).where(
                models.live_sessions.c.state.in_(["CONNECTING", "VIEWING", "DISCONNECTING"]))))
        for s in stale:
            sid = s["id"]
            busy = sid in self.viewers or self.is_opening(sid, now)
            if s["state"] == "CONNECTING" and now - s["created_at"] > 30 and not busy:
                await self._finalize(sid, "never_opened")
            elif s["state"] in ("VIEWING", "DISCONNECTING") and not busy:
                await self._finalize(sid, "viewer_gone")
            elif s["control_lease"] and s["lease_expires_at"] and s["lease_expires_at"] < now:
                self._release(sid, s["agent_id"])
