"""Server-side RFB (VNC) client->server message filter.

The proxy, not the browser, enforces read-only: while a viewer does not hold the exclusive control lease,
KeyEvent / PointerEvent / ClientCutText / SetDesktopSize and QEMU input messages are dropped before they
reach Xvnc. Parses RFB 3.8 handshake (version, security type None, ClientInit) then framed messages; any other
protocol version or security type closes the connection (it would desynchronise the parser).
"""

from __future__ import annotations

import struct

INPUT_TYPES = {4, 5, 6, 251, 255}  # Key, Pointer, CutText, SetDesktopSize, QEMU (ext key events)
RFB_VERSION = b"RFB 003.008\n"
SECURITY_NONE = 1


class NeedMore(Exception):
    pass


class RFBClientFilter:
    def __init__(self) -> None:
        self.buf = bytearray()
        self.stage = "version"  # version -> security -> init -> messages
        self.allow_input = False
        self.dropped = 0

    def feed(self, data: bytes) -> bytes:
        self.buf += data
        out = bytearray()
        while True:
            try:
                n, forward = self._next()
            except NeedMore:
                break
            chunk = bytes(self.buf[:n])
            del self.buf[:n]
            if forward:
                out += chunk
            else:
                self.dropped += 1
        return bytes(out)

    def _need(self, n: int) -> None:
        if len(self.buf) < n:
            raise NeedMore

    def _next(self) -> tuple[int, bool]:
        b = self.buf
        if self.stage == "version":
            # Only RFB 3.8 is accepted (noVNC and the native apps answer Xvnc's 3.8 with 3.8). Under 3.3/3.7 the
            # client sends no security-type byte (3.3) or a different handshake, the byte offsets below would be
            # wrong and a read-only viewer could smuggle input past the filter (audit VM-13): refuse instead.
            self._need(12)
            if bytes(b[:12]) != RFB_VERSION:
                raise ValueError(f"unsupported RFB client version {bytes(b[:12])!r}; only RFB 003.008 is accepted")
            self.stage = "security"
            return 12, True
        if self.stage == "security":
            self._need(1)
            if b[0] != SECURITY_NONE:  # the guest Xvnc offers only "None"; anything else desynchronises the filter
                raise ValueError(f"unsupported RFB security type {b[0]}")
            self.stage = "init"
            return 1, True
        if self.stage == "init":
            self._need(1)
            self.stage = "messages"
            return 1, True
        self._need(1)
        t = b[0]
        if t == 0:  # SetPixelFormat
            self._need(20)
            return 20, True
        if t == 2:  # SetEncodings
            self._need(4)
            (count,) = struct.unpack(">H", b[2:4])
            self._need(4 + 4 * count)
            return 4 + 4 * count, True
        if t == 3:  # FramebufferUpdateRequest
            self._need(10)
            return 10, True
        if t == 4:  # KeyEvent
            self._need(8)
            return 8, self.allow_input
        if t == 5:  # PointerEvent
            self._need(6)
            return 6, self.allow_input
        if t == 6:  # ClientCutText
            self._need(8)
            (length,) = struct.unpack(">i", b[4:8])
            n = 8 + abs(length)
            self._need(n)
            return n, self.allow_input
        if t == 150:  # EnableContinuousUpdates
            self._need(10)
            return 10, True
        if t == 248:  # ClientFence
            self._need(9)
            n = 9 + b[8]
            self._need(n)
            return n, True
        if t == 250:  # xvp
            self._need(4)
            return 4, False
        if t == 251:  # SetDesktopSize
            self._need(8)
            n = 8 + 16 * b[6]
            self._need(n)
            return n, self.allow_input
        if t == 255:  # QEMU client message: subtype 0 = extended key event (12 bytes)
            self._need(2)
            if b[1] == 0:
                self._need(12)
                return 12, self.allow_input
            if b[1] == 1:  # audio
                self._need(4)
                return 4, False
            raise ValueError("unsupported QEMU submessage")
        raise ValueError(f"unknown RFB client message type {t}")
