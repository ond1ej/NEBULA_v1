"""Provider registry: DB rows + Keychain refs -> live adapters; connect/test/disconnect; token caps."""

from __future__ import annotations

import datetime as dt
import json
import uuid
from typing import Any

from nebula_providers.adapters import (
    AnthropicAdapter,
    CLIModeDetector,
    GeminiAdapter,
    OllamaAdapter,
    OpenAICompatibleAdapter,
    OpenAIResponsesAdapter,
    validate_byo_endpoint,
)
from nebula_providers.base import ProviderError
from nebula_providers.siwc import SIWCAdapter, SIWCSession
from sqlalchemy import select, update

from nebula_host import db, models, secrets
from nebula_host.config import get_config
from nebula_host.errors import ApiError
from nebula_host.events import audit, bus

CATALOG: list[dict[str, Any]] = [
    {"id": "ollama-local", "adapter_type": "ollama", "display_name": "Ollama (local)", "auth_mode": "local"},
    {"id": "openai-siwc", "adapter_type": "openai_siwc", "display_name": "OpenAI — Continue with ChatGPT",
     "auth_mode": "subscription"},
    {"id": "openai-api", "adapter_type": "openai_api", "display_name": "OpenAI API key", "auth_mode": "api_key"},
    {"id": "anthropic-api", "adapter_type": "anthropic_api", "display_name": "Claude API Key (Anthropic)",
     "auth_mode": "api_key"},
    {"id": "gemini-api", "adapter_type": "gemini_api", "display_name": "Google Gemini API key", "auth_mode": "api_key"},
    {"id": "openai-compatible", "adapter_type": "openai_compatible", "display_name": "Other OpenAI-compatible endpoint",
     "auth_mode": "api_key"},
    {"id": "claude-code-cli", "adapter_type": "cli_mode", "display_name": "Use installed Claude Code (coding mode)",
     "auth_mode": "cli"},
    {"id": "codex-cli", "adapter_type": "cli_mode", "display_name": "OpenAI Codex CLI (coding mode)", "auth_mode": "cli"},
    {"id": "google-antigravity", "adapter_type": "cli_mode", "display_name": "Google Antigravity CLI",
     "auth_mode": "cli"},
]
CLI_REASONS = {
    "claude-code-cli": ("claude", "Claude Code coding mode is detection-only in this version: running the official, "
                                  "unmodified CLI on the user's behalf needs a legal and technical review before it "
                                  "can be turned on. NEBULA never offers a Claude.ai subscription login."),
    "codex-cli": ("codex", "Codex CLI coding mode is detection-only in this version pending license review; it does "
                           "not replace the OpenAI provider."),
    "google-antigravity": ("antigravity", "No verified Antigravity CLI/SDK integration in this version. The retired "
                                          "consumer Gemini CLI login is intentionally not implemented; use a Gemini "
                                          "API key."),
}

_siwc_session: SIWCSession | None = None
_models_cache: dict[str, tuple[float, list]] = {}
MODELS_TTL = 3600.0


async def list_models_cached(pid: str, refresh: bool = False) -> list:
    """Model lists change rarely; caching avoids repeated GET /models calls against subscription endpoints."""
    import time as _time

    hit = _models_cache.get(pid)
    if hit and not refresh and _time.time() - hit[0] < MODELS_TTL:
        return hit[1]
    models = await adapter_for(pid).list_models("")
    _models_cache[pid] = (_time.time(), models)
    return models


def ensure_catalog() -> None:
    now = db.now()
    with db.engine().begin() as c:
        existing = {r.id for r in c.execute(select(models.providers.c.id))}
        for p in CATALOG:
            if p["id"] not in existing:
                c.execute(models.providers.insert().values(**p, state="Not Connected", capabilities=[], config={},
                                                           created_at=now, updated_at=now))


def get_row(pid: str) -> dict[str, Any]:
    with db.engine().connect() as c:
        r = db.row(c.execute(select(models.providers).where(models.providers.c.id == pid)).first())
    if r is None:
        raise ApiError(404, "provider_not_found", f"unknown provider {pid}")
    return r


def _key_getter(ref: str | None):
    return lambda: secrets.store().get(ref) if ref else None


def host_id() -> str:
    hid = db.get_setting("siwc.host_id")
    if not hid:
        hid = f"urn:uuid:{uuid.uuid4()}"
        db.set_setting("siwc.host_id", hid)
    return hid


def siwc_session() -> SIWCSession:
    global _siwc_session
    if _siwc_session is None:
        ref = secrets.make_ref("provider.openai-siwc")

        def load() -> dict | None:
            v = secrets.store().get(ref)
            return json.loads(v) if v else None

        def save(cred: dict | None) -> None:
            if cred is None:
                secrets.store().delete(ref)
            else:
                secrets.store().set(ref, json.dumps(cred))
            with db.engine().begin() as c:
                c.execute(update(models.providers).where(models.providers.c.id == "openai-siwc")
                          .values(keychain_ref=ref, updated_at=db.now()))

        cfg = get_config()
        _siwc_session = SIWCSession("openai-siwc", load, save, host_id(),
                                    redirect_uri=f"http://127.0.0.1:{cfg.instance.port}/auth/callback")
    return _siwc_session


def adapter_for(pid: str):
    row = get_row(pid)
    t = row["adapter_type"]
    ref = row.get("keychain_ref")
    cfg = get_config()
    if t == "ollama":
        return OllamaAdapter(pid, row["config"].get("base_url") or cfg.providers.ollama_base_url)
    if t == "anthropic_api":
        return AnthropicAdapter(pid, _key_getter(ref))
    if t == "openai_api":
        return OpenAIResponsesAdapter(pid, _key_getter(ref))
    if t == "openai_siwc":
        return SIWCAdapter(pid, siwc_session())
    if t == "gemini_api":
        return GeminiAdapter(pid, _key_getter(ref))
    if t == "openai_compatible":
        base = row["config"].get("base_url")
        if not base:
            raise ApiError(409, "not_configured", "set base_url first")
        return OpenAICompatibleAdapter(pid, base, _key_getter(ref), row["config"].get("billing_note", ""))
    if t == "cli_mode":
        binary, reason = CLI_REASONS[pid]
        return CLIModeDetector(pid, binary, row["display_name"], reason)
    raise ApiError(400, "unknown_adapter", t)


def _set_state(pid: str, state: str, detail: str | None = None, capabilities: list | None = None) -> None:
    vals: dict[str, Any] = {"state": state, "last_checked_at": db.now(), "updated_at": db.now(), "last_error": detail}
    if capabilities is not None:
        vals["capabilities"] = capabilities
    with db.engine().begin() as c:
        prev = c.execute(select(models.providers.c.state).where(models.providers.c.id == pid)).scalar()
        c.execute(update(models.providers).where(models.providers.c.id == pid).values(**vals))
    if prev != state:
        bus.publish("provider.state.changed", {"provider_id": pid, "state": state, "detail": detail})
        if state == "Quota Reached":
            bus.publish("provider.quota", {"provider_id": pid, "detail": detail})


async def test(pid: str) -> dict[str, Any]:
    ad = adapter_for(pid)
    st = await ad.test_connection()
    _set_state(pid, st.state, st.detail, st.capabilities)
    return {"provider_id": pid, **st.as_dict(), "plan": ad.estimate_cost_or_plan()}


async def connect(pid: str, body: dict[str, Any], actor: str) -> dict[str, Any]:
    row = get_row(pid)
    t = row["adapter_type"]
    if t in ("anthropic_api", "openai_api", "gemini_api", "openai_compatible"):
        cfg_vals = dict(row["config"])
        if t == "openai_compatible":
            base = body.get("base_url", "")
            try:
                cfg_vals["base_url"] = validate_byo_endpoint(base)
            except ProviderError as e:
                raise ApiError(422, "invalid_endpoint", str(e)) from e
            cfg_vals["billing_note"] = str(body.get("billing_note") or "")[:200]
            if not cfg_vals["billing_note"]:
                raise ApiError(422, "billing_required", "declare the billing mode of this endpoint")
        key = (body.get("api_key") or "").strip()
        if not key and t != "openai_compatible":
            raise ApiError(422, "api_key_required", "api_key is required")
        if "password" in body or "cookie" in body:
            raise ApiError(400, "forbidden_credential", "NEBULA never accepts third-party passwords or cookies")
        ref = secrets.make_ref(f"provider.{pid}")
        if key:
            secrets.store().set(ref, key)
        with db.engine().begin() as c:
            c.execute(update(models.providers).where(models.providers.c.id == pid)
                      .values(keychain_ref=ref if key else None, config=cfg_vals, updated_at=db.now()))
        audit(actor, "provider.connect", pid, {"adapter": t})
        return await test(pid)
    if t == "ollama":
        if body.get("base_url"):
            try:
                OllamaAdapter(pid, body["base_url"])
            except ProviderError as e:
                raise ApiError(422, "invalid_endpoint", str(e)) from e
            with db.engine().begin() as c:
                c.execute(update(models.providers).where(models.providers.c.id == pid)
                          .values(config={**row["config"], "base_url": body["base_url"]}, updated_at=db.now()))
        audit(actor, "provider.connect", pid, {"adapter": t})
        return await test(pid)
    if t == "openai_siwc":
        start = siwc_session().start()
        audit(actor, "provider.siwc.start", pid)
        return {"provider_id": pid, "state": "Connect", "next": "open_authorize_url",
                "authorize_url": start["authorize_url"], "oauth_state": start["state"],
                "redirect_uri": start["redirect_uri"], "expires_in": start["expires_in"]}
    if t == "cli_mode":
        return await test(pid)
    raise ApiError(400, "unsupported", t)


async def disconnect(pid: str, actor: str) -> dict[str, Any]:
    row = get_row(pid)
    ad = adapter_for(pid)
    try:
        await ad.revoke("")
    except Exception:  # noqa: BLE001
        pass
    if row.get("keychain_ref") and row["adapter_type"] != "openai_siwc":
        secrets.store().delete(row["keychain_ref"])
        with db.engine().begin() as c:
            c.execute(update(models.providers).where(models.providers.c.id == pid).values(keychain_ref=None))
    _set_state(pid, "Not Connected", None)
    audit(actor, "provider.disconnect", pid)
    return {"provider_id": pid, "state": "Not Connected"}


def list_rows() -> list[dict[str, Any]]:
    with db.engine().connect() as c:
        rs = db.rows(c.execute(select(models.providers).order_by(models.providers.c.created_at)))
    for r in rs:
        r.pop("keychain_ref", None)
        r["has_credentials"] = bool(get_row(r["id"]).get("keychain_ref"))
        r["usage_today"] = usage_today(r["id"])
        r["daily_token_cap"] = r["config"].get("daily_token_cap")
    return rs


# ---------------------------------------------------------------- usage caps
def _usage_key(pid: str) -> str:
    return f"usage:{pid}:{dt.date.today().isoformat()}"


def usage_today(pid: str) -> dict[str, int]:
    return db.get_setting(_usage_key(pid), {"input_tokens": 0, "output_tokens": 0, "requests": 0})


def record_usage(pid: str, usage: dict[str, int]) -> None:
    u = usage_today(pid)
    u["input_tokens"] += int(usage.get("input_tokens", 0) or 0)
    u["output_tokens"] += int(usage.get("output_tokens", 0) or 0)
    u["requests"] += 1
    db.set_setting(_usage_key(pid), u)


def check_cap(pid: str) -> None:
    row = get_row(pid)
    cap = row["config"].get("daily_token_cap")
    if cap:
        u = usage_today(pid)
        if u["input_tokens"] + u["output_tokens"] >= int(cap):
            _set_state(pid, "Quota Reached", f"NEBULA daily token cap {cap} reached")
            raise ProviderError("quota", f"daily token cap of {cap} reached for {pid}")


def set_cap(pid: str, cap: int | None) -> None:
    row = get_row(pid)
    cfg = dict(row["config"])
    cfg["daily_token_cap"] = cap
    with db.engine().begin() as c:
        c.execute(update(models.providers).where(models.providers.c.id == pid).values(config=cfg, updated_at=db.now()))


def record_failure(pid: str, detail: str) -> None:
    _set_state(pid, "Error", detail[:1000])


def mark_error(pid: str, err: ProviderError) -> None:
    state = {"quota": "Quota Reached", "auth": "Re-auth Required", "unsupported": "Unsupported on this version"}.get(err.kind)
    if state:
        _set_state(pid, state, str(err))
