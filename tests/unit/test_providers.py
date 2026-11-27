"""Provider adapter contract tests with mocked HTTP (no real credentials, nothing stored in snapshots)."""

from __future__ import annotations

import json

import httpx
import pytest
from nebula_providers import adapters
from nebula_providers.base import AgentTurn, Message, ProviderError, ToolCall, ToolSpec


def patch_client(monkeypatch, handler):
    real = httpx.AsyncClient

    def factory(*a, **kw):
        kw.pop("verify", None)
        return real(*a, transport=httpx.MockTransport(handler), **kw)

    monkeypatch.setattr(adapters.httpx, "AsyncClient", factory)


TURN = AgentTurn(model="m", system="sys", messages=[
    Message("user", "go"),
    Message("assistant", "", tool_calls=[ToolCall("c1", "browser_navigate", {"url": "https://e.com"})]),
    Message("tool", '{"status":"ok"}', tool_call_id="c1", tool_name="browser_navigate"),
], tools=[ToolSpec("browser_navigate", "nav", {"type": "object", "properties": {"url": {"type": "string"}}})])


async def collect(ad, turn=TURN):
    return [e async for e in ad.stream_turn(turn)]


def sse(*events):
    return "".join(f"event: {e}\ndata: {json.dumps(d)}\n\n" for e, d in events).encode()


async def test_ollama_stream_tool_call(monkeypatch):
    seen = {}

    def h(req):
        seen["body"] = json.loads(req.content)
        lines = [{"message": {"content": "ok "}},
                 {"message": {"tool_calls": [{"function": {"name": "files_list", "arguments": {"path": "."}}}]}},
                 {"done": True, "done_reason": "stop", "prompt_eval_count": 3, "eval_count": 2}]
        return httpx.Response(200, content="\n".join(json.dumps(x) for x in lines).encode())

    patch_client(monkeypatch, h)
    evs = await collect(adapters.OllamaAdapter("o"))
    assert [e.type for e in evs] == ["text_delta", "tool_call", "done"]
    assert evs[1].tool_call.name == "files_list" and evs[1].tool_call.arguments == {"path": "."}
    assert seen["body"]["messages"][0]["role"] == "system"
    assert seen["body"]["messages"][-1] == {"role": "tool", "content": '{"status":"ok"}', "tool_name": "browser_navigate"}


def test_ollama_must_be_local():
    with pytest.raises(ProviderError):
        adapters.OllamaAdapter("o", "http://10.0.0.5:11434")


async def test_anthropic_stream_and_tool_result_shape(monkeypatch):
    seen = {}

    def h(req):
        seen["headers"] = req.headers
        seen["body"] = json.loads(req.content)
        return httpx.Response(200, content=sse(
            ("message_start", {"type": "message_start", "message": {"usage": {"input_tokens": 9}}}),
            ("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
            ("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "hi"}}),
            ("content_block_stop", {"type": "content_block_stop", "index": 0}),
            ("content_block_start", {"type": "content_block_start", "index": 1,
                                     "content_block": {"type": "tool_use", "id": "t1", "name": "files_list", "input": {}}}),
            ("content_block_delta", {"type": "content_block_delta", "index": 1,
                                     "delta": {"type": "input_json_delta", "partial_json": "{\"path\":"}}),
            ("content_block_delta", {"type": "content_block_delta", "index": 1,
                                     "delta": {"type": "input_json_delta", "partial_json": "\".\"}"}}),
            ("content_block_stop", {"type": "content_block_stop", "index": 1}),
            ("message_delta", {"type": "message_delta", "delta": {"stop_reason": "tool_use"}, "usage": {"output_tokens": 4}}),
            ("message_stop", {"type": "message_stop"})))

    patch_client(monkeypatch, h)
    evs = await collect(adapters.AnthropicAdapter("a", lambda: "sk-ant-x"))
    tc = [e for e in evs if e.type == "tool_call"][0].tool_call
    assert tc.id == "t1" and tc.arguments == {"path": "."}
    assert evs[-1].usage == {"input_tokens": 9, "output_tokens": 4}
    assert seen["headers"]["x-api-key"] == "sk-ant-x" and seen["headers"]["anthropic-version"]
    tr = seen["body"]["messages"][2]
    assert tr["role"] == "user" and tr["content"][0]["type"] == "tool_result" and tr["content"][0]["tool_use_id"] == "c1"


@pytest.mark.parametrize("status,body,kind", [
    (401, "{}", "auth"), (429, '{"error":{"type":"rate_limit_error"}}', "rate_limit"),
    (429, '{"error":{"message":"insufficient_quota"}}', "quota"), (529, "overloaded", "unavailable")])
async def test_http_errors_map_to_kinds(monkeypatch, status, body, kind):
    patch_client(monkeypatch, lambda req: httpx.Response(status, content=body.encode()))
    with pytest.raises(ProviderError) as ei:
        await collect(adapters.AnthropicAdapter("a", lambda: "k"))
    assert ei.value.kind == kind


async def test_openai_responses_stream_and_items(monkeypatch):
    seen = {}

    def h(req):
        seen["body"] = json.loads(req.content)
        return httpx.Response(200, content=sse(
            ("response.output_text.delta", {"type": "response.output_text.delta", "delta": "x"}),
            ("response.output_item.done", {"type": "response.output_item.done", "item": {
                "type": "function_call", "call_id": "k1", "name": "files_list", "arguments": "{\"path\":\"a\"}"}}),
            ("response.completed", {"type": "response.completed", "response": {"usage": {"input_tokens": 1, "output_tokens": 2}}})))

    patch_client(monkeypatch, h)
    evs = await collect(adapters.OpenAIResponsesAdapter("o", lambda: "sk-test"))
    assert [e.type for e in evs] == ["text_delta", "tool_call", "done"]
    b = seen["body"]
    assert b["store"] is False and b["stream"] is True
    kinds = [i.get("type", i.get("role")) for i in b["input"]]
    assert kinds == ["user", "function_call", "function_call_output"]


async def test_openai_failed_usage_limit_is_quota(monkeypatch):
    patch_client(monkeypatch, lambda req: httpx.Response(200, content=sse(
        ("response.failed", {"type": "response.failed", "response": {"error": {
            "code": "subscription_sharing_usage_limit_exceeded", "message": "limit"}}}))))
    with pytest.raises(ProviderError) as ei:
        await collect(adapters.OpenAIResponsesAdapter("o", lambda: "t"))
    assert ei.value.kind == "quota"


async def test_siwc_never_sends_unsupported_params(monkeypatch):
    from nebula_providers.siwc import SIWCAdapter, SIWCSession

    store = {"cred": {"client_id": "oaiapp_1", "access_token": "at", "refresh_token": "rt",
                      "expires_at": 9e12, "can_use_plan": True}}
    sess = SIWCSession("openai-siwc", lambda: store["cred"], lambda c: store.update(cred=c), "urn:uuid:x",
                       "http://127.0.0.1:3100/auth/callback")
    seen = {}

    def h(req):
        seen["auth"] = req.headers["authorization"]
        seen["body"] = json.loads(req.content)
        return httpx.Response(200, content=sse(("response.completed", {"type": "response.completed", "response": {}})))

    patch_client(monkeypatch, h)
    await collect(SIWCAdapter("openai-siwc", sess))
    assert seen["auth"] == "Bearer at"
    assert "max_output_tokens" not in seen["body"] and "temperature" not in seen["body"]
    assert seen["body"]["store"] is False and seen["body"]["stream"] is True


async def test_siwc_refresh_rotation_and_terminal_error(monkeypatch):
    from nebula_providers import siwc

    store = {"cred": {"client_id": "oaiapp_1", "access_token": "old", "refresh_token": "r1", "expires_at": 0,
                      "can_use_plan": True}}
    sess = siwc.SIWCSession("p", lambda: store["cred"], lambda c: store.update(cred=c), "urn:uuid:x", "http://127.0.0.1:1/cb")
    calls = []
    real = httpx.AsyncClient

    def ok(req):
        calls.append(dict(httpx.QueryParams(req.content.decode())))
        return httpx.Response(200, json={"access_token": "new", "refresh_token": "r2", "expires_in": 3600})

    monkeypatch.setattr(siwc.httpx, "AsyncClient", lambda *a, **kw: real(transport=httpx.MockTransport(ok)))
    assert await sess.access_token() == "new"
    assert store["cred"]["refresh_token"] == "r2" and calls[0]["client_id"] == "oaiapp_1"
    assert "scope" not in calls[0] and calls[0]["resource"] == "https://api.openai.com/v1"
    store["cred"]["expires_at"] = 0
    monkeypatch.setattr(siwc.httpx, "AsyncClient", lambda *a, **kw: real(transport=httpx.MockTransport(
        lambda req: httpx.Response(400, json={"error": "refresh_token_reused"}))))
    with pytest.raises(ProviderError) as ei:
        await sess.access_token()
    assert ei.value.kind == "auth" and store["cred"]["reauth_required"] is True


async def test_siwc_without_direct_scope_refuses_inference():
    from nebula_providers.siwc import SIWCSession

    s = SIWCSession("p", lambda: {"access_token": "a", "expires_at": 9e12, "can_use_plan": False}, lambda c: None,
                    "urn:uuid:x", "http://127.0.0.1:1/cb")
    with pytest.raises(ProviderError) as ei:
        await s.access_token()
    assert ei.value.kind == "unsupported"


def test_siwc_pkce_and_state():
    import base64
    import hashlib

    from nebula_providers import siwc

    v, c = siwc.pkce_pair()
    assert base64.urlsafe_b64encode(hashlib.sha256(v.encode()).digest()).rstrip(b"=").decode() == c
    s = siwc.SIWCSession("p", lambda: None, lambda c: None, "urn:uuid:x", "http://127.0.0.1:9/auth/callback")
    st = s.start()
    assert "agent_name_hint=NEBULA" in st["authorize_url"] and st["state"] in s._pending


async def test_gemini_function_call(monkeypatch):
    def h(req):
        assert req.headers["x-goog-api-key"] == "AIzaX"
        return httpx.Response(200, content=b"data: " + json.dumps({"candidates": [{"content": {"parts": [
            {"functionCall": {"name": "files_list", "args": {"path": "."}}}]}, "finishReason": "STOP"}],
            "usageMetadata": {"promptTokenCount": 3, "candidatesTokenCount": 1}}).encode() + b"\n\n")

    patch_client(monkeypatch, h)
    evs = await collect(adapters.GeminiAdapter("g", lambda: "AIzaX"))
    assert evs[0].tool_call.name == "files_list" and evs[-1].usage["input_tokens"] == 3


async def test_byo_endpoint_allowlist(monkeypatch):
    dns = {"api.example.com": ["93.184.216.34"], "intranet.example.com": ["10.0.0.7"],
           "mixed.example.com": ["93.184.216.34", "192.168.1.5"], "meta.example.com": ["169.254.169.254"],
           "v6local.example.com": ["fd00::1"]}

    def fake_resolve(host):  # no real DNS in tests
        if host not in dns:
            raise OSError("unknown host")
        return dns[host]

    monkeypatch.setattr(adapters, "resolve_host", fake_resolve)
    monkeypatch.setattr(adapters, "nebula_ports", lambda: {3100, 3102, 3443})
    assert adapters.validate_byo_endpoint("https://api.example.com/v1") == "https://api.example.com/v1"
    assert adapters.validate_byo_endpoint("http://127.0.0.1:8000/v1")
    for bad in ("http://example.com/v1", "https://192.168.1.10/v1", "ftp://x", "http://169.254.169.254/",
                # L-07: host names are resolved before the private-address check
                "https://intranet.example.com/v1", "https://mixed.example.com/v1", "https://meta.example.com/",
                "https://v6local.example.com/v1", "https://unresolvable.example.com/v1", "https://localhost/v1",
                "https://[::1]/v1", "https://127.0.0.1/v1",
                # ... and NEBULA's own ports are never a model endpoint
                "http://127.0.0.1:3100/v1", "http://127.0.0.1:3102/v1", "http://localhost:3443/"):
        with pytest.raises(ProviderError):
            adapters.validate_byo_endpoint(bad)
    # construction never resolves; the adapter re-checks before the key is sent
    a = adapters.OpenAICompatibleAdapter("x", "https://intranet.example.com/v1", lambda: "k", "byo")
    with pytest.raises(ProviderError):
        await a.list_models()


def test_byo_endpoint_refuses_this_instances_ports(dbinit):
    cfg = dbinit  # NEBULA_PORT=3199 in tests: dashboard 3199, gateway 3201 (port + 2), LAN HTTPS
    for port in (cfg.instance.port, cfg.instance.port + 2, cfg.lan.https_port):
        with pytest.raises(ProviderError):
            adapters.validate_byo_endpoint(f"http://127.0.0.1:{port}/v1")
    assert adapters.validate_byo_endpoint("http://127.0.0.1:11434/v1")  # e.g. a local model server


def _rsa_jwk_and_signer():
    import base64

    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import padding, rsa

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    nums = key.public_key().public_numbers()

    def b64(n: int) -> str:
        return base64.urlsafe_b64encode(n.to_bytes((n.bit_length() + 7) // 8, "big")).rstrip(b"=").decode()

    jwk = {"kty": "RSA", "kid": "k1", "alg": "RS256", "n": b64(nums.n), "e": b64(nums.e)}

    def sign(claims: dict) -> str:
        enc = lambda d: base64.urlsafe_b64encode(json.dumps(d).encode()).rstrip(b"=").decode()  # noqa: E731
        head = enc({"alg": "RS256", "kid": "k1", "typ": "JWT"})
        body = enc(claims)
        sig = key.sign(f"{head}.{body}".encode(), padding.PKCS1v15(), hashes.SHA256())
        return f"{head}.{body}." + base64.urlsafe_b64encode(sig).rstrip(b"=").decode()

    return jwk, sign


async def test_siwc_code_exchange_uses_issued_client_id_from_callback():
    """Regression for HTTP 400 invalid_client: the exchange must use the oaiapp_ id returned on the redirect."""
    import time as _t
    from urllib.parse import parse_qs

    from nebula_providers import siwc

    jwk, sign = _rsa_jwk_and_signer()
    store: dict = {}
    sess = siwc.SIWCSession("p", lambda: store.get("cred"), lambda c: store.update(cred=c), "urn:uuid:h",
                            "http://127.0.0.1:3101/auth/callback")
    st = sess.start()
    nonce = sess._pending[st["state"]]["nonce"]
    seen: dict = {}

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path.endswith("openid-configuration"):
            return httpx.Response(200, json={"jwks_uri": "https://auth.openai.com/.well-known/jwks.json"})
        if req.url.path.endswith("jwks.json"):
            return httpx.Response(200, json={"keys": [jwk]})
        form = {k: v[0] for k, v in parse_qs(req.content.decode()).items()}
        seen.update(form)
        if form["client_id"] != "oaiapp_ISSUED1":
            return httpx.Response(400, json={"error": "invalid_client"})
        idt = sign({"iss": "https://auth.openai.com", "aud": "oaiapp_ISSUED1", "nonce": nonce,
                    "exp": _t.time() + 600, "email": "owner@example.com"})
        return httpx.Response(200, json={"access_token": "at", "refresh_token": "rt", "id_token": idt,
                                         "expires_in": 3600, "scope": siwc.SCOPES})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        info = await sess.complete(st["state"], "CODE", callback_client_id="oaiapp_ISSUED1",
                                   iss="https://auth.openai.com", http=http)
    assert seen["client_id"] == "oaiapp_ISSUED1" and seen["resource"] == "https://api.openai.com/v1"
    assert seen["redirect_uri"] == "http://127.0.0.1:3101/auth/callback" and "scope" not in seen
    assert info["can_use_plan"] and store["cred"]["client_id"] == "oaiapp_ISSUED1"
    # the next sign-in reuses the issued id (no new dynamic registration)
    assert "client_id=oaiapp_ISSUED1" in sess.start()["authorize_url"]


async def test_siwc_rejects_missing_issued_id_and_wrong_issuer():
    from nebula_providers import siwc

    sess = siwc.SIWCSession("p", lambda: None, lambda c: None, "urn:uuid:h", "http://127.0.0.1:1/auth/callback")
    st = sess.start()
    with pytest.raises(ProviderError, match="issued client_id"):
        await sess.complete(st["state"], "C", callback_client_id=None)
    st = sess.start()
    with pytest.raises(ProviderError, match="authorization server"):
        await sess.complete(st["state"], "C", callback_client_id="oaiapp_X1234", iss="https://evil.example")


async def test_model_turns_reuse_one_http_client_per_loop(monkeypatch):
    """Perf audit 2026-11-16: consecutive model turns share a keep-alive client (no new TCP/TLS per turn)."""
    real = httpx.AsyncClient
    made = []

    def h(req):
        lines = [{"message": {"content": "ok"}}, {"done": True, "done_reason": "stop"}]
        return httpx.Response(200, content="\n".join(json.dumps(x) for x in lines).encode())

    def factory(*a, **kw):
        kw.pop("verify", None)
        made.append(kw)
        return real(*a, transport=httpx.MockTransport(h), **kw)

    monkeypatch.setattr(adapters.httpx, "AsyncClient", factory)
    monkeypatch.setattr(adapters.OllamaAdapter, "_memory_preflight", lambda self, model: _noop())
    for _ in range(3):
        evs = await collect(adapters.OllamaAdapter("o"))
        assert evs[-1].type == "done"
    assert len(made) == 1 and made[0]["limits"].max_keepalive_connections >= 1


async def _noop():
    return None
