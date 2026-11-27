"""Concrete provider adapters: Ollama (local), Anthropic API, OpenAI API (Responses), Gemini API,
generic OpenAI-compatible endpoint, and CLI-mode detectors (Claude Code / Codex / Antigravity).

ChatGPT sign-in (SIWC) lives in siwc.py and reuses the Responses streaming here.
"""

from __future__ import annotations

import ipaddress
import json
import shutil
import subprocess
import uuid
from collections.abc import AsyncIterator, Callable
from typing import Any
from urllib.parse import urlparse

import httpx

from nebula_providers.base import (
    CONNECTED_API,
    CONNECTED_LOCAL,
    ERROR,
    NOT_CONNECTED,
    QUOTA_REACHED,
    REAUTH_REQUIRED,
    UNSUPPORTED,
    AgentTurn,
    ModelEvent,
    ModelInfo,
    ProviderError,
    ProviderStatus,
    ToolCall,
    diagnose_connect,
    http_error,
    parse_args,
)

TIMEOUT = httpx.Timeout(20.0, read=300.0)
_SHARED: dict[tuple[int, int], tuple[Any, httpx.AsyncClient]] = {}


def _stream_client() -> httpx.AsyncClient:
    """One keep-alive HTTP client per event loop for model turns. A fresh client per turn paid DNS + TCP + TLS and
    an SSL-context build every time (~26 ms p50 to api.openai.com measured on this Mac; 100+ ms on slow paths)."""
    import asyncio
    import weakref

    loop = asyncio.get_running_loop()
    factory = httpx.AsyncClient  # looked up at call time (tests swap it for a mock transport)
    key = (id(loop), id(factory))
    hit = _SHARED.get(key)
    if hit and hit[0]() is loop and not hit[1].is_closed:
        return hit[1]
    for k in [k for k, (ref, _) in _SHARED.items() if ref() is None or ref().is_closed()]:
        _SHARED.pop(k, None)
    c = factory(timeout=TIMEOUT, limits=httpx.Limits(max_connections=20, max_keepalive_connections=8,
                                                     keepalive_expiry=90))
    _SHARED[key] = (weakref.ref(loop), c)
    return c


async def sse_lines(resp: httpx.Response) -> AsyncIterator[tuple[str, str]]:
    """Yield (event, data) pairs from a text/event-stream response."""
    event, data = "", []
    async for line in resp.aiter_lines():
        if line == "":
            if data:
                yield event, "\n".join(data)
            event, data = "", []
        elif line.startswith("event:"):
            event = line[6:].strip()
        elif line.startswith("data:"):
            data.append(line[5:].lstrip())
    if data:
        yield event, "\n".join(data)


# ======================================================================= Ollama
class OllamaAdapter:
    adapter_type = "ollama"
    auth_modes = ["local"]

    # Measured on a 16 GB Mac mini M4: a 7B model at 16k context (5.5 GB wired) + a 6 GB VM pushed the host into
    # heavy swap and starved the guest. 8k context keeps the KV cache small; see docs/decisions.md D24.
    num_ctx = 8192

    def __init__(self, provider_id: str, base_url: str = "http://127.0.0.1:11434") -> None:
        self.id = provider_id
        self.base_url = base_url.rstrip("/")
        host = urlparse(self.base_url).hostname or ""
        if host not in ("127.0.0.1", "localhost", "::1"):
            raise ProviderError("bad_request", "Ollama base URL must be local")

    async def test_connection(self) -> ProviderStatus:
        try:
            async with httpx.AsyncClient(timeout=5) as c:
                v = (await c.get(f"{self.base_url}/api/version")).json()
                tags = (await c.get(f"{self.base_url}/api/tags")).json()
        except (httpx.HTTPError, ValueError) as e:
            return ProviderStatus(NOT_CONNECTED, f"Ollama not reachable at {self.base_url}: {e}",
                                  billing="local (no token billing)")
        n = len(tags.get("models", []))
        return ProviderStatus(CONNECTED_LOCAL, f"Ollama {v.get('version')} with {n} installed model(s)",
                              billing="local (no token billing; uses host RAM/CPU)",
                              capabilities=["chat", "tools", "stream"], account={"version": v.get("version")})

    async def connection_status(self, account_id: str = "") -> ProviderStatus:
        return await self.test_connection()

    async def list_models(self, account_id: str = "") -> list[ModelInfo]:
        async with httpx.AsyncClient(timeout=10) as c:
            tags = (await c.get(f"{self.base_url}/api/tags")).json()
            out = []
            for m in tags.get("models", []):
                caps: list[str] = []
                try:
                    show = (await c.post(f"{self.base_url}/api/show", json={"model": m["name"]})).json()
                    caps = show.get("capabilities", []) or []
                except (httpx.HTTPError, ValueError):
                    pass
                out.append(ModelInfo(id=m["name"], display_name=f"{m['name']} ({m.get('size', 0) / 1e9:.1f} GB)",
                                     supports_tools="tools" in caps, supports_images="vision" in caps))
        return out

    def estimate_cost_or_plan(self) -> dict[str, Any]:
        return {"billing": "local", "note": "no per-token billing; RAM/CPU of this Mac (7B model ~5 GB RAM)"}

    async def _memory_preflight(self, model: str) -> None:
        """Refuse to LOAD a local model that cannot fit in reclaimable host RAM (it would swap out the VM).
        Already-loaded models are fine. Switching to a cloud provider is never automatic (needs consent)."""
        try:
            async with httpx.AsyncClient(timeout=5) as c:
                ps = (await c.get(f"{self.base_url}/api/ps")).json()
                if any(m.get("name") == model or m.get("model") == model for m in ps.get("models", [])):
                    return
                tags = (await c.get(f"{self.base_url}/api/tags")).json()
            size = next((m.get("size", 0) for m in tags.get("models", []) if m.get("name") == model), 0)
            avail, pressure = host_memory_available()
        except Exception:  # noqa: BLE001 - never block on a failed probe
            return
        if pressure in ("warning", "critical") or (size and avail and avail < size * 1.05):
            raise ProviderError("resources", f"not enough free RAM to load {model} ({size / 1e9:.1f} GB needed, "
                                             f"{avail / 1e9:.1f} GB reclaimable, pressure {pressure}); close apps, "
                                             "sleep idle agents, pick a smaller model or switch provider")

    async def revoke(self, account_id: str = "") -> None:
        return None

    def _messages(self, req: AgentTurn) -> list[dict[str, Any]]:
        msgs: list[dict[str, Any]] = [{"role": "system", "content": req.system}]
        for m in req.messages:
            if m.role == "tool":
                msgs.append({"role": "tool", "content": m.content, "tool_name": m.tool_name or ""})
            elif m.role == "assistant":
                d: dict[str, Any] = {"role": "assistant", "content": m.content}
                if m.tool_calls:
                    d["tool_calls"] = [{"function": {"name": tc.name, "arguments": tc.arguments}} for tc in m.tool_calls]
                msgs.append(d)
            else:
                d = {"role": "user", "content": m.content}
                if req.send_images and m.images_b64:
                    d["images"] = m.images_b64
                msgs.append(d)
        return msgs

    async def stream_turn(self, req: AgentTurn) -> AsyncIterator[ModelEvent]:
        body = {"model": req.model, "messages": self._messages(req), "stream": True,
                "tools": [{"type": "function", "function": {"name": t.name, "description": t.description,
                                                            "parameters": t.parameters}} for t in req.tools],
                "options": {"num_ctx": self.num_ctx}}
        await self._memory_preflight(req.model)
        try:
            async with _stream_client().stream("POST", f"{self.base_url}/api/chat", json=body) as r:
                if r.status_code != 200:
                    raise http_error(r.status_code, (await r.aread()).decode(errors="replace"), "ollama")
                usage: dict[str, int] = {}
                async for line in r.aiter_lines():
                    if not line.strip():
                        continue
                    chunk = json.loads(line)
                    if chunk.get("error"):
                        raise ProviderError("unavailable", f"ollama: {chunk['error']}")
                    msg = chunk.get("message") or {}
                    if msg.get("content"):
                        yield ModelEvent("text_delta", text=msg["content"])
                    for tc in msg.get("tool_calls") or []:
                        fn = tc.get("function", {})
                        yield ModelEvent("tool_call", tool_call=ToolCall(id=tc.get("id") or f"call_{uuid.uuid4().hex[:12]}",
                                                                          name=fn.get("name", ""),
                                                                          arguments=parse_args(fn.get("arguments"))))
                    if chunk.get("done"):
                        usage = {"input_tokens": chunk.get("prompt_eval_count", 0),
                                 "output_tokens": chunk.get("eval_count", 0)}
                        yield ModelEvent("done", stop_reason=chunk.get("done_reason", "stop"), usage=usage)
        except httpx.ConnectError as e:
            raise ProviderError("unavailable", f"ollama not reachable: {e}") from e


def host_memory_available() -> tuple[int, str]:
    """(reclaimable bytes, pressure) on macOS from vm_stat/sysctl; (0, 'unknown') elsewhere."""
    import re as _re

    try:
        out = subprocess.run(["/usr/bin/vm_stat"], capture_output=True, text=True, timeout=5).stdout
        page = int(_re.search(r"page size of (\d+)", out).group(1))  # type: ignore[union-attr]
        vals = {k.strip(): int(v.strip().rstrip(".")) for k, v in (ln.split(":", 1) for ln in out.splitlines()[1:] if ":" in ln)
                if v.strip().rstrip(".").isdigit()}
        avail = sum(vals.get(k, 0) for k in ("Pages free", "Pages inactive", "Pages speculative", "Pages purgeable")) * page
        lvl = subprocess.run(["/usr/sbin/sysctl", "-n", "kern.memorystatus_vm_pressure_level"], capture_output=True,
                             text=True, timeout=5).stdout.strip()
        return avail, {"1": "normal", "2": "warning", "4": "critical"}.get(lvl, "unknown")
    except Exception:  # noqa: BLE001
        return 0, "unknown"


# ======================================================================= Anthropic API
class AnthropicAdapter:
    """Anthropic API key (API billing). Never a Claude.ai subscription login (spec §6)."""

    adapter_type = "anthropic_api"
    auth_modes = ["api_key"]
    base_url = "https://api.anthropic.com"

    def __init__(self, provider_id: str, key_getter: Callable[[], str | None]) -> None:
        self.id = provider_id
        self._key = key_getter

    def _headers(self) -> dict[str, str]:
        k = self._key()
        if not k:
            raise ProviderError("auth", "Anthropic API key not configured")
        return {"x-api-key": k, "anthropic-version": "2023-06-01", "content-type": "application/json"}

    async def test_connection(self) -> ProviderStatus:
        if not self._key():
            return ProviderStatus(NOT_CONNECTED, "no API key", billing="API billing (per token)")
        try:
            models = await self.list_models()
        except ProviderError as e:
            state = REAUTH_REQUIRED if e.kind == "auth" else QUOTA_REACHED if e.kind == "quota" else ERROR
            return ProviderStatus(state, str(e), billing="API billing (per token)")
        return ProviderStatus(CONNECTED_API, f"{len(models)} models available", billing="API billing (per token)",
                              capabilities=["chat", "tools", "stream", "vision"])

    connection_status = lambda self, account_id="": self.test_connection()  # noqa: E731

    async def list_models(self, account_id: str = "") -> list[ModelInfo]:
        try:
            async with httpx.AsyncClient(timeout=20) as c:
                r = await c.get(f"{self.base_url}/v1/models", headers=self._headers(), params={"limit": 100})
        except httpx.TransportError as e:
            raise ProviderError("unavailable", diagnose_connect(self.base_url, e)) from e
        if r.status_code != 200:
            raise http_error(r.status_code, r.text, "anthropic")
        return [ModelInfo(id=m["id"], display_name=m.get("display_name", m["id"]), supports_images=True)
                for m in r.json().get("data", [])]

    def estimate_cost_or_plan(self) -> dict[str, Any]:
        return {"billing": "api", "note": "billed per token by Anthropic to your API account; NEBULA enforces token caps"}

    async def revoke(self, account_id: str = "") -> None:
        return None

    def _messages(self, req: AgentTurn) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for m in req.messages:
            if m.role == "assistant":
                blocks: list[dict[str, Any]] = []
                if m.content:
                    blocks.append({"type": "text", "text": m.content})
                blocks += [{"type": "tool_use", "id": tc.id, "name": tc.name, "input": tc.arguments} for tc in m.tool_calls]
                out.append({"role": "assistant", "content": blocks or [{"type": "text", "text": "(no output)"}]})
            elif m.role == "tool":
                content: list[dict[str, Any]] = [{"type": "text", "text": m.content or "(empty)"}]
                if req.send_images:
                    content += [{"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": i}}
                                for i in m.images_b64]
                block = {"type": "tool_result", "tool_use_id": m.tool_call_id, "content": content}
                if out and out[-1]["role"] == "user" and isinstance(out[-1]["content"], list) \
                        and out[-1]["content"] and out[-1]["content"][0].get("type") == "tool_result":
                    out[-1]["content"].append(block)
                else:
                    out.append({"role": "user", "content": [block]})
            else:
                content = [{"type": "text", "text": m.content}]
                if req.send_images:
                    content += [{"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": i}}
                                for i in m.images_b64]
                out.append({"role": "user", "content": content})
        return out

    async def stream_turn(self, req: AgentTurn) -> AsyncIterator[ModelEvent]:
        body = {"model": req.model, "max_tokens": req.max_tokens, "system": req.system, "stream": True,
                "messages": self._messages(req),
                "tools": [{"name": t.name, "description": t.description, "input_schema": t.parameters} for t in req.tools]}
        blocks: dict[int, dict[str, Any]] = {}
        usage: dict[str, int] = {}
        async with _stream_client().stream("POST", f"{self.base_url}/v1/messages", headers=self._headers(),
                                           json=body) as r:
            if r.status_code != 200:
                raise http_error(r.status_code, (await r.aread()).decode(errors="replace"), "anthropic")
            stop = ""
            async for ev, data in sse_lines(r):
                d = json.loads(data)
                t = d.get("type", ev)
                if t == "content_block_start":
                    blocks[d["index"]] = {**d["content_block"], "_json": ""}
                elif t == "content_block_delta":
                    delta = d["delta"]
                    if delta.get("type") == "text_delta":
                        yield ModelEvent("text_delta", text=delta["text"])
                    elif delta.get("type") == "input_json_delta":
                        blocks[d["index"]]["_json"] += delta.get("partial_json", "")
                elif t == "content_block_stop":
                    b = blocks.get(d["index"], {})
                    if b.get("type") == "tool_use":
                        yield ModelEvent("tool_call", tool_call=ToolCall(b["id"], b["name"], parse_args(b["_json"] or "{}")))
                elif t == "message_start":
                    usage["input_tokens"] = d["message"].get("usage", {}).get("input_tokens", 0)
                elif t == "message_delta":
                    stop = d.get("delta", {}).get("stop_reason") or stop
                    usage["output_tokens"] = d.get("usage", {}).get("output_tokens", 0)
                elif t == "error":
                    err = d.get("error", {})
                    kind = "rate_limit" if err.get("type") == "rate_limit_error" else \
                        "unavailable" if err.get("type") == "overloaded_error" else "bad_request"
                    raise ProviderError(kind, f"anthropic: {err.get('message')}")
            yield ModelEvent("done", stop_reason=stop, usage=usage)


# ======================================================================= OpenAI Responses (API key)
class OpenAIResponsesAdapter:
    adapter_type = "openai_api"
    auth_modes = ["api_key"]
    base_url = "https://api.openai.com/v1"
    subscription = False

    def __init__(self, provider_id: str, token_getter) -> None:
        self.id = provider_id
        self._token = token_getter  # may be async (SIWC refresh) or sync

    async def _auth(self) -> dict[str, str]:
        tok = self._token()
        if hasattr(tok, "__await__"):
            tok = await tok
        if not tok:
            raise ProviderError("auth", "OpenAI credentials not configured")
        return {"Authorization": f"Bearer {tok}"}

    async def test_connection(self) -> ProviderStatus:
        billing = "ChatGPT plan usage" if self.subscription else "API billing (per token)"
        try:
            models = await self.list_models()
        except ProviderError as e:
            state = REAUTH_REQUIRED if e.kind == "auth" else QUOTA_REACHED if e.kind == "quota" else \
                UNSUPPORTED if e.kind == "unsupported" else ERROR
            return ProviderStatus(state, str(e), billing=billing)
        return ProviderStatus("Connected (Subscription)" if self.subscription else CONNECTED_API,
                              f"{len(models)} models available", billing=billing,
                              capabilities=["chat", "tools", "stream", "vision"])

    async def connection_status(self, account_id: str = "") -> ProviderStatus:
        return await self.test_connection()

    async def list_models(self, account_id: str = "") -> list[ModelInfo]:
        headers = await self._auth()
        try:
            async with httpx.AsyncClient(timeout=20) as c:
                r = await c.get(f"{self.base_url}/models", headers=headers)
        except httpx.TransportError as e:
            raise ProviderError("unavailable", diagnose_connect(self.base_url, e)) from e
        if r.status_code != 200:
            raise http_error(r.status_code, r.text, "openai")
        j = r.json()
        if "models" in j:  # SIWC shape: .models[] with slug/display_name/visibility
            return [ModelInfo(id=m["slug"], display_name=m.get("display_name", m["slug"]), supports_images=True,
                              extra={k: v for k, v in m.items() if k not in ("slug", "display_name")
                                     and isinstance(v, (str, int, float, bool)) and len(str(v)) <= 300})
                    for m in j["models"] if m.get("visibility", "list") == "list"]
        ids = sorted(m["id"] for m in j.get("data", []))
        keep = [i for i in ids if i.startswith(("gpt-", "o")) and not any(x in i for x in
                                                                         ("audio", "realtime", "tts", "transcribe",
                                                                          "image", "embedding", "moderation", "search"))]
        return [ModelInfo(id=i, display_name=i, supports_images=True) for i in keep]

    def estimate_cost_or_plan(self) -> dict[str, Any]:
        return {"billing": "api", "note": "billed per token to your OpenAI API account; NEBULA enforces token caps"}

    async def revoke(self, account_id: str = "") -> None:
        return None

    def _input(self, req: AgentTurn) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        for m in req.messages:
            if m.role == "user":
                content: list[dict[str, Any]] = [{"type": "input_text", "text": m.content}]
                if req.send_images:
                    content += [{"type": "input_image", "image_url": f"data:image/png;base64,{i}"} for i in m.images_b64]
                items.append({"role": "user", "content": content})
            elif m.role == "assistant":
                if m.content:
                    items.append({"role": "assistant", "content": [{"type": "output_text", "text": m.content}]})
                for tc in m.tool_calls:
                    items.append({"type": "function_call", "call_id": tc.id, "name": tc.name,
                                  "arguments": json.dumps(tc.arguments)})
            else:
                items.append({"type": "function_call_output", "call_id": m.tool_call_id, "output": m.content})
                if req.send_images and m.images_b64:
                    items.append({"role": "user", "content": [
                        {"type": "input_text", "text": "Screenshot attached to the previous tool result."},
                        *[{"type": "input_image", "image_url": f"data:image/png;base64,{i}"} for i in m.images_b64]]})
        return items

    def _body(self, req: AgentTurn) -> dict[str, Any]:
        body: dict[str, Any] = {"model": req.model, "instructions": req.system, "input": self._input(req),
                                "stream": True, "store": False,
                                "tools": [{"type": "function", "name": t.name, "description": t.description,
                                           "parameters": t.parameters} for t in req.tools]}
        if not self.subscription:
            body["max_output_tokens"] = req.max_tokens
        return body

    async def stream_turn(self, req: AgentTurn) -> AsyncIterator[ModelEvent]:
        try:
            async for ev in self._stream_turn(req):
                yield ev
        except httpx.TransportError as e:
            raise ProviderError("unavailable", diagnose_connect(self.base_url, e)) from e

    async def _stream_turn(self, req: AgentTurn) -> AsyncIterator[ModelEvent]:
        async with _stream_client().stream("POST", f"{self.base_url}/responses", headers=await self._auth(),
                                           json=self._body(req)) as r:
            if r.status_code != 200:
                raise http_error(r.status_code, (await r.aread()).decode(errors="replace"), "openai")
            completed = False
            async for ev, data in sse_lines(r):
                if data == "[DONE]":
                    break
                d = json.loads(data)
                t = d.get("type", ev)
                if t == "response.output_text.delta":
                    yield ModelEvent("text_delta", text=d.get("delta", ""))
                elif t == "response.output_item.done":
                    item = d.get("item", {})
                    if item.get("type") == "function_call":
                        yield ModelEvent("tool_call", tool_call=ToolCall(item.get("call_id") or item.get("id"),
                                                                          item["name"], parse_args(item.get("arguments"))))
                elif t == "response.completed":
                    completed = True
                    u = d.get("response", {}).get("usage") or {}
                    yield ModelEvent("done", stop_reason="completed",
                                     usage={"input_tokens": u.get("input_tokens", 0), "output_tokens": u.get("output_tokens", 0)})
                elif t in ("response.failed", "error", "response.incomplete"):
                    err = d.get("response", {}).get("error") or d.get("error") or d
                    code = str(err.get("code", ""))
                    msg = str(err.get("message", code))
                    if "usage_limit" in code or "quota" in code:
                        raise ProviderError("quota", f"openai: {msg}")
                    if "usage_unavailable" in code:
                        raise ProviderError("unavailable", f"openai: {msg}")
                    if "not_eligible" in code:
                        raise ProviderError("unsupported", f"openai: {msg}")
                    raise ProviderError("bad_request", f"openai: {msg}")
            if not completed:
                raise ProviderError("unavailable", "openai: stream ended before response.completed")


# ======================================================================= Gemini API (API key)
class GeminiAdapter:
    adapter_type = "gemini_api"
    auth_modes = ["api_key"]
    base_url = "https://generativelanguage.googleapis.com/v1beta"

    def __init__(self, provider_id: str, key_getter: Callable[[], str | None]) -> None:
        self.id = provider_id
        self._key = key_getter

    def _headers(self) -> dict[str, str]:
        k = self._key()
        if not k:
            raise ProviderError("auth", "Gemini API key not configured")
        return {"x-goog-api-key": k}

    async def test_connection(self) -> ProviderStatus:
        if not self._key():
            return ProviderStatus(NOT_CONNECTED, "no API key", billing="API billing (per token)")
        try:
            models = await self.list_models()
        except ProviderError as e:
            return ProviderStatus(REAUTH_REQUIRED if e.kind == "auth" else ERROR, str(e), billing="API billing (per token)")
        return ProviderStatus(CONNECTED_API, f"{len(models)} models available", billing="API billing (per token)",
                              capabilities=["chat", "tools", "stream", "vision"])

    async def connection_status(self, account_id: str = "") -> ProviderStatus:
        return await self.test_connection()

    async def list_models(self, account_id: str = "") -> list[ModelInfo]:
        try:
            async with httpx.AsyncClient(timeout=20) as c:
                r = await c.get(f"{self.base_url}/models", headers=self._headers(), params={"pageSize": 200})
        except httpx.TransportError as e:
            raise ProviderError("unavailable", diagnose_connect(self.base_url, e)) from e
        if r.status_code != 200:
            raise http_error(r.status_code, r.text, "gemini")
        return [ModelInfo(id=m["name"].split("/", 1)[-1], display_name=m.get("displayName", m["name"]), supports_images=True)
                for m in r.json().get("models", []) if "generateContent" in m.get("supportedGenerationMethods", [])]

    def estimate_cost_or_plan(self) -> dict[str, Any]:
        return {"billing": "api", "note": "Gemini API key billing/free tier per Google terms"}

    async def revoke(self, account_id: str = "") -> None:
        return None

    def _contents(self, req: AgentTurn) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for m in req.messages:
            if m.role == "user":
                parts: list[dict[str, Any]] = [{"text": m.content}]
                if req.send_images:
                    parts += [{"inlineData": {"mimeType": "image/png", "data": i}} for i in m.images_b64]
                out.append({"role": "user", "parts": parts})
            elif m.role == "assistant":
                parts = ([{"text": m.content}] if m.content else []) + \
                        [{"functionCall": {"name": tc.name, "args": tc.arguments}} for tc in m.tool_calls]
                out.append({"role": "model", "parts": parts or [{"text": ""}]})
            else:
                part = {"functionResponse": {"name": m.tool_name or "tool", "response": {"result": m.content}}}
                if out and out[-1]["role"] == "user" and "functionResponse" in out[-1]["parts"][0]:
                    out[-1]["parts"].append(part)
                else:
                    out.append({"role": "user", "parts": [part]})
        return out

    async def stream_turn(self, req: AgentTurn) -> AsyncIterator[ModelEvent]:
        body = {"systemInstruction": {"parts": [{"text": req.system}]}, "contents": self._contents(req),
                "tools": [{"functionDeclarations": [{"name": t.name, "description": t.description,
                                                     "parameters": t.parameters} for t in req.tools]}],
                "generationConfig": {"maxOutputTokens": req.max_tokens}}
        url = f"{self.base_url}/models/{req.model}:streamGenerateContent"
        async with _stream_client().stream("POST", url, params={"alt": "sse"}, headers=self._headers(), json=body) as r:
            if r.status_code != 200:
                raise http_error(r.status_code, (await r.aread()).decode(errors="replace"), "gemini")
            usage: dict[str, int] = {}
            stop = ""
            async for _ev, data in sse_lines(r):
                d = json.loads(data)
                for cand in d.get("candidates", []):
                    for p in cand.get("content", {}).get("parts", []):
                        if "text" in p and p["text"]:
                            yield ModelEvent("text_delta", text=p["text"])
                        if "functionCall" in p:
                            fc = p["functionCall"]
                            yield ModelEvent("tool_call", tool_call=ToolCall(f"call_{uuid.uuid4().hex[:12]}", fc["name"],
                                                                              fc.get("args") or {}))
                    stop = cand.get("finishReason", stop)
                um = d.get("usageMetadata")
                if um:
                    usage = {"input_tokens": um.get("promptTokenCount", 0), "output_tokens": um.get("candidatesTokenCount", 0)}
            yield ModelEvent("done", stop_reason=stop, usage=usage)


# ======================================================================= OpenAI-compatible (BYO endpoint)
def resolve_host(host: str) -> list[str]:
    """Every address a host name resolves to (injectable in tests)."""
    import socket

    return sorted({i[4][0] for i in socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)})


# Shared address space (RFC 6598): carrier-grade NAT and Tailscale tailnet addresses. Python does not count it as
# is_private, but it is not the public Internet either (L-07): treat it exactly like RFC1918.
_SHARED_ADDRESS_SPACE = ipaddress.ip_network("100.64.0.0/10")


def _non_public(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return (ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast
            or ip.is_unspecified or (isinstance(ip, ipaddress.IPv4Address) and ip in _SHARED_ADDRESS_SPACE))


def nebula_ports() -> set[int]:
    """This NEBULA's own listening ports (dashboard/API, Mini App gateway, LAN HTTPS): never a model endpoint."""
    try:
        from nebula_host import remote
        from nebula_host.config import get_config

        cfg = get_config()
        ports = {int(cfg.instance.port), int(cfg.lan.https_port)}
        try:
            ports.add(int(remote.settings()["port"]))
        except Exception:  # noqa: BLE001 - database not initialised: the default gateway port
            ports.add(int(cfg.instance.port) + 2)
        return ports
    except Exception:  # noqa: BLE001 - outside a NEBULA host (unit context): the default ports
        return {3100, 3102, 3443}


def validate_byo_endpoint(url: str, *, resolve: bool = True) -> str:
    """L-07: https:// endpoints must be public — literal addresses AND, with `resolve`, every address the host name
    resolves to (no RFC1918, loopback, link-local, ...); http:// only on this Mac's loopback, never on NEBULA's own
    ports. The stored API key is sent to this endpoint, so it must not be pointed at internal services."""
    u = urlparse(url)
    host = (u.hostname or "").strip("[]")
    if u.scheme == "https" and host:
        try:
            ip = ipaddress.ip_address(host)
        except ValueError:
            ip = None
        if ip is not None:
            if _non_public(ip):
                raise ProviderError("bad_request", "private IP endpoints must use http://127.0.0.1")
            return url.rstrip("/")
        if host.lower() == "localhost" or host.lower().endswith((".localhost", ".local", ".internal")):
            raise ProviderError("bad_request", "local host names must use http://127.0.0.1")
        if resolve:
            try:
                addrs = resolve_host(host)
            except OSError:
                raise ProviderError("bad_request", f"cannot resolve {host}") from None
            if not addrs or any(_non_public(ipaddress.ip_address(a.split("%", 1)[0])) for a in addrs):
                raise ProviderError("bad_request", f"{host} resolves to a private, CGNAT/Tailscale, loopback or "
                                                   "link-local address; local servers must use "
                                                   "http://127.0.0.1:<port>")
        return url.rstrip("/")
    if u.scheme == "http" and host in ("127.0.0.1", "localhost", "::1"):
        try:
            port = u.port or 80
        except ValueError:
            raise ProviderError("bad_request", "invalid port") from None
        if port in nebula_ports():
            raise ProviderError("bad_request", "NEBULA's own ports cannot be a model endpoint")
        return url.rstrip("/")
    raise ProviderError("bad_request", "endpoint must be https:// or http://127.0.0.1 (allowlist)")


class OpenAICompatibleAdapter:
    adapter_type = "openai_compatible"
    auth_modes = ["api_key"]

    def __init__(self, provider_id: str, base_url: str, key_getter: Callable[[], str | None], billing_note: str) -> None:
        self.id = provider_id
        self.base_url = validate_byo_endpoint(base_url, resolve=False)  # no DNS at construction; see _guard
        self._key = key_getter
        self.billing_note = billing_note or "billing mode declared by user: unknown"
        self._checked_at = 0.0

    async def _guard(self) -> None:
        """Re-check where the host name points before the key is sent (at most once a minute): a name that was
        public when it was configured may later resolve to an internal address (L-07)."""
        import asyncio
        import time

        if time.time() - self._checked_at < 60:
            return
        await asyncio.to_thread(validate_byo_endpoint, self.base_url, resolve=True)
        self._checked_at = time.time()

    def _headers(self) -> dict[str, str]:
        k = self._key()
        return {"Authorization": f"Bearer {k}"} if k else {}

    async def test_connection(self) -> ProviderStatus:
        try:
            models = await self.list_models()
        except (ProviderError, httpx.HTTPError) as e:
            return ProviderStatus(ERROR, str(e), billing=self.billing_note)
        return ProviderStatus(CONNECTED_API, f"{len(models)} models", billing=self.billing_note,
                              capabilities=["chat", "tools", "stream"])

    async def connection_status(self, account_id: str = "") -> ProviderStatus:
        return await self.test_connection()

    async def list_models(self, account_id: str = "") -> list[ModelInfo]:
        await self._guard()
        async with httpx.AsyncClient(timeout=20, verify=True) as c:
            r = await c.get(f"{self.base_url}/models", headers=self._headers())
        if r.status_code != 200:
            raise http_error(r.status_code, r.text, "openai-compatible")
        return [ModelInfo(id=m["id"], display_name=m["id"]) for m in r.json().get("data", [])]

    def estimate_cost_or_plan(self) -> dict[str, Any]:
        return {"billing": "byo", "note": self.billing_note}

    async def revoke(self, account_id: str = "") -> None:
        return None

    async def stream_turn(self, req: AgentTurn) -> AsyncIterator[ModelEvent]:
        msgs: list[dict[str, Any]] = [{"role": "system", "content": req.system}]
        for m in req.messages:
            if m.role == "assistant":
                d: dict[str, Any] = {"role": "assistant", "content": m.content or None}
                if m.tool_calls:
                    d["tool_calls"] = [{"id": tc.id, "type": "function",
                                        "function": {"name": tc.name, "arguments": json.dumps(tc.arguments)}}
                                       for tc in m.tool_calls]
                msgs.append(d)
            elif m.role == "tool":
                msgs.append({"role": "tool", "tool_call_id": m.tool_call_id, "content": m.content})
            else:
                msgs.append({"role": "user", "content": m.content})
        body = {"model": req.model, "messages": msgs, "stream": True, "max_tokens": req.max_tokens,
                "tools": [{"type": "function", "function": {"name": t.name, "description": t.description,
                                                            "parameters": t.parameters}} for t in req.tools]}
        calls: dict[int, dict[str, Any]] = {}
        await self._guard()
        async with _stream_client().stream("POST", f"{self.base_url}/chat/completions", headers=self._headers(),
                                           json=body) as r:
            if r.status_code != 200:
                raise http_error(r.status_code, (await r.aread()).decode(errors="replace"), "openai-compatible")
            stop = ""
            async for _ev, data in sse_lines(r):
                if data.strip() == "[DONE]":
                    break
                d = json.loads(data)
                for ch in d.get("choices", []):
                    delta = ch.get("delta", {})
                    if delta.get("content"):
                        yield ModelEvent("text_delta", text=delta["content"])
                    for tc in delta.get("tool_calls") or []:
                        slot = calls.setdefault(tc.get("index", 0), {"id": "", "name": "", "args": ""})
                        slot["id"] = tc.get("id") or slot["id"]
                        fn = tc.get("function", {})
                        slot["name"] = fn.get("name") or slot["name"]
                        slot["args"] += fn.get("arguments", "")
                    stop = ch.get("finish_reason") or stop
            for slot in calls.values():
                yield ModelEvent("tool_call", tool_call=ToolCall(slot["id"] or f"call_{uuid.uuid4().hex[:12]}",
                                                                  slot["name"], parse_args(slot["args"])))
            yield ModelEvent("done", stop_reason=stop)


# ======================================================================= CLI detectors (not activated in V1)
class CLIModeDetector:
    """Claude Code / Codex / Antigravity coding modes. V1 only DETECTS an installed official CLI.
    Activation is disabled until the legal/technical review required by spec §6 is done (docs/decisions.md)."""

    adapter_type = "cli_mode"
    auth_modes = ["cli"]

    def __init__(self, provider_id: str, binary: str, label: str, reason: str) -> None:
        self.id = provider_id
        self.binary = binary
        self.label = label
        self.reason = reason

    def detect(self) -> dict[str, Any]:
        path = shutil.which(self.binary)
        version = None
        if path:
            try:
                version = subprocess.run([path, "--version"], capture_output=True, text=True, timeout=10).stdout.strip()[:100]
            except (OSError, subprocess.TimeoutExpired):
                version = "unknown"
        return {"installed": bool(path), "path": path, "version": version}

    async def test_connection(self) -> ProviderStatus:
        det = self.detect()
        return ProviderStatus(UNSUPPORTED, self.reason + (f" Detected: {det['version']}." if det["installed"]
                                                          else f" `{self.binary}` not found."),
                              billing="per the vendor's own CLI terms", account=det)

    async def connection_status(self, account_id: str = "") -> ProviderStatus:
        return await self.test_connection()

    async def list_models(self, account_id: str = "") -> list[ModelInfo]:
        return []

    def estimate_cost_or_plan(self) -> dict[str, Any]:
        return {"billing": "vendor_cli", "note": self.reason}

    async def revoke(self, account_id: str = "") -> None:
        return None

    async def stream_turn(self, req: AgentTurn) -> AsyncIterator[ModelEvent]:
        raise ProviderError("unsupported", self.reason)
        yield  # pragma: no cover
