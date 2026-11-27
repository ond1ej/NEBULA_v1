"""Provider adapter contract (spec §6.2) and provider-neutral turn/event types."""

from __future__ import annotations

import ipaddress
import json
import os
import socket
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol
from urllib.parse import urlparse

# UI states (spec §6.1)
NOT_CONNECTED = "Not Connected"
CONNECTED_SUBSCRIPTION = "Connected (Subscription)"
CONNECTED_API = "Connected (API Billing)"
CONNECTED_LOCAL = "Connected (Local)"
QUOTA_REACHED = "Quota Reached"
REAUTH_REQUIRED = "Re-auth Required"
UNSUPPORTED = "Unsupported on this version"
ERROR = "Error"


class ProviderError(Exception):
    """kind: auth | quota | rate_limit | unavailable | bad_request | unsupported"""

    def __init__(self, kind: str, message: str, *, retry_after: float | None = None, status: int | None = None):
        super().__init__(message)
        self.kind = kind
        self.retry_after = retry_after
        self.status = status


@dataclass
class ProviderStatus:
    state: str
    detail: str = ""
    billing: str = ""  # "local (no token billing)" | "API billing (per token)" | "ChatGPT plan usage"
    capabilities: list[str] = field(default_factory=list)
    account: dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {"state": self.state, "detail": self.detail, "billing": self.billing,
                "capabilities": self.capabilities, "account": self.account}


@dataclass
class ModelInfo:
    id: str
    display_name: str
    supports_tools: bool = True
    supports_images: bool = False
    context_tokens: int | None = None
    extra: dict[str, Any] = field(default_factory=dict)  # provider metadata (scalars only), shown in the dashboard

    def as_dict(self) -> dict[str, Any]:
        return self.__dict__.copy()


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: dict[str, Any]


@dataclass
class Message:
    role: Literal["user", "assistant", "tool"]
    content: str = ""
    tool_calls: list[ToolCall] = field(default_factory=list)
    tool_call_id: str | None = None
    tool_name: str | None = None
    images_b64: list[str] = field(default_factory=list)  # PNG, only sent to vision-capable models

    def to_json(self) -> dict[str, Any]:
        return {"role": self.role, "content": self.content,
                "tool_calls": [tc.__dict__ for tc in self.tool_calls], "tool_call_id": self.tool_call_id,
                "tool_name": self.tool_name, "images_b64": self.images_b64}

    @staticmethod
    def from_json(d: dict[str, Any]) -> Message:
        return Message(role=d["role"], content=d.get("content", ""),
                       tool_calls=[ToolCall(**tc) for tc in d.get("tool_calls", [])],
                       tool_call_id=d.get("tool_call_id"), tool_name=d.get("tool_name"),
                       images_b64=d.get("images_b64", []))


@dataclass
class ToolSpec:
    name: str  # wire-safe: ^[a-zA-Z0-9_-]+$
    description: str
    parameters: dict[str, Any]


@dataclass
class AgentTurn:
    model: str
    system: str
    messages: list[Message]
    tools: list[ToolSpec]
    max_tokens: int = 2048
    send_images: bool = False


@dataclass
class ModelEvent:
    type: Literal["text_delta", "tool_call", "done", "usage"]
    text: str = ""
    tool_call: ToolCall | None = None
    stop_reason: str = ""
    usage: dict[str, int] = field(default_factory=dict)


class ProviderAdapter(Protocol):
    id: str
    adapter_type: str
    auth_modes: list[str]

    async def connection_status(self, account_id: str) -> ProviderStatus: ...
    async def list_models(self, account_id: str) -> list[ModelInfo]: ...
    def stream_turn(self, request: AgentTurn) -> AsyncIterator[ModelEvent]: ...
    async def revoke(self, account_id: str) -> None: ...
    async def test_connection(self) -> ProviderStatus: ...
    def estimate_cost_or_plan(self) -> dict[str, Any]: ...


def parse_args(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    if not raw:
        return {}
    try:
        v = json.loads(raw)
        return v if isinstance(v, dict) else {"value": v}
    except (json.JSONDecodeError, TypeError):
        return {"_unparsed": str(raw)[:2000]}


def http_error(status: int, body: str, provider: str) -> ProviderError:
    lower = body.lower()
    if status in (401, 403):
        if "not_eligible" in lower:
            return ProviderError("unsupported", f"{provider}: account not eligible ({body[:200]})", status=status)
        return ProviderError("auth", f"{provider}: authentication failed ({status})", status=status)
    if status == 429:
        if "quota" in lower or "usage_limit" in lower or "insufficient_quota" in lower or "billing" in lower:
            return ProviderError("quota", f"{provider}: quota/usage limit reached", status=status)
        return ProviderError("rate_limit", f"{provider}: rate limited", status=status)
    if status in (402,):
        return ProviderError("quota", f"{provider}: payment/quota required", status=status)
    if status >= 500 or status == 503:
        return ProviderError("unavailable", f"{provider}: service unavailable ({status})", status=status)
    return ProviderError("bad_request", f"{provider}: HTTP {status}: {body[:300]}", status=status)


def diagnose_connect(url: str, exc: BaseException | None = None) -> str:
    """Explain WHY a provider endpoint is unreachable from this Mac (DNS sinkhole, /etc/hosts, proxy, IPv6)."""
    host = urlparse(url).hostname or url
    parts: list[str] = []
    try:
        infos = socket.getaddrinfo(host, 443, proto=socket.IPPROTO_TCP)
        addrs = sorted({i[4][0] for i in infos})
    except socket.gaierror as e:
        return f"{host}: DNS lookup failed ({e})"
    blocked = [a for a in addrs if _sinkhole(a)]
    hosts_lines = []
    try:
        for n, line in enumerate(open("/etc/hosts", encoding="utf-8", errors="replace"), 1):
            fields = line.split("#", 1)[0].split()
            if len(fields) >= 2 and host in fields[1:]:
                hosts_lines.append(f"line {n}: {' '.join(fields)}")
    except OSError:
        pass
    if blocked or hosts_lines:
        where = f"/etc/hosts {', '.join(hosts_lines)}" if hosts_lines else "a local DNS filter"
        parts.append(f"{host} is blocked on this Mac: it resolves to {', '.join(blocked or addrs)} via {where}. "
                     "Remove that entry (admin rights) to allow NEBULA to reach it")
    else:
        parts.append(f"cannot connect to {host} ({', '.join(addrs[:4])})")
    v6 = [a for a in addrs if ":" in a and not _sinkhole(a)]
    if v6 and not _has_global_ipv6():
        parts.append("IPv6 addresses exist but this Mac has no global IPv6 route")
    proxies = {k: v for k, v in os.environ.items() if k.lower() in ("https_proxy", "http_proxy", "all_proxy")}
    if proxies:
        parts.append(f"proxy environment set: {', '.join(sorted(proxies))}")
    if exc is not None:
        parts.append(f"error: {type(exc).__name__}: {exc}")
    return "; ".join(parts)


def _sinkhole(addr: str) -> bool:
    try:
        ip = ipaddress.ip_address(addr.split("%", 1)[0])
    except ValueError:
        return False
    return ip.is_unspecified or ip.is_loopback


def _has_global_ipv6() -> bool:
    s = socket.socket(socket.AF_INET6, socket.SOCK_DGRAM)
    try:
        s.connect(("2001:4860:4860::8888", 53))  # no packets sent for UDP connect; only a route lookup
        return True
    except OSError:
        return False
    finally:
        s.close()
