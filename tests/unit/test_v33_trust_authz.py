"""V3.3 central authorization table and risk-based trust rules (pure functions, no network)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture()
def no_owner_config(monkeypatch):
    from nebula_host import auth_trust

    monkeypatch.setattr(auth_trust, "settings", lambda: {"relationships": [], "verified_sites": []})
    return auth_trust


def test_every_api_route_has_exactly_one_policy_and_no_policy_is_stale():
    """One authorization model: a route without a policy could never be reached remotely by accident, and a policy
    without a route would hide a typo."""
    from nebula_host import authz

    spec = json.loads((ROOT / "packages/contracts/openapi.json").read_text())
    routes = {f"{m.upper()} {p.replace('/api/v1', '', 1)}" for p, ops in spec["paths"].items() for m in ops
              if m.upper() in ("GET", "POST", "PUT", "PATCH", "DELETE")}
    assert routes - set(authz.POLICY) == set()
    assert set(authz.POLICY) - routes == set()
    assert set(authz.POLICY.values()) <= {"public", "local", "read", "admin", "admin!"} | \
        {v for v in authz.POLICY.values() if v.startswith("op:")}


@pytest.mark.parametrize("method,path,policy", [
    ("GET", "/files/roots", "op:files"), ("DELETE", "/agents/abc-1", "admin!"), ("POST", "/vault/unlock", "admin!"),
    ("POST", "/vault/entries/e1/reveal", "admin!"), ("POST", "/smart-auth/sessions/as_" + "a" * 24 + "/submit",
                                                       "admin"),  # M-04: owner only
    ("POST", "/auth/login", "public"), ("POST", "/setup/install", "local"), ("GET", "/artifacts/a/b/c.png", "read"),
])
def test_policy_lookup(method, path, policy):
    from nebula_host import authz

    assert authz.match(method, path)[0] == policy


def test_gateway_never_forwards_public_local_or_malformed_paths():
    from nebula_host import remote

    assert remote.allowed("POST", "/auth/login")[0] is False
    assert remote.allowed("POST", "/setup/install")[0] is False
    assert remote.allowed("POST", "/smart-auth/sessions/as_123/submit")[0] is False  # strict id shape
    for p in ("/vault//unlock", "/vault/unlock/", "/vault/./unlock", "/agents/x/../../vault/entries/1", "/VAULT/unlock"):
        assert remote.allowed("POST", p)[0] is False, p
    assert remote.allowed("GET", "/settings") == (True, "admin")


def test_roles_and_assurance():
    from nebula_host import authz

    owner_stale = authz.Ctx("miniapp", "owner", frozenset(), None, "s", 7)
    owner_fresh = authz.Ctx("miniapp", "owner", frozenset(), 9e12, "s", 7)
    operator = authz.Ctx("miniapp", "operator", frozenset({"tasks"}), 9e12, "s", 8)
    agent_bot = authz.Ctx("miniapp", "agent_bot", frozenset({"tasks", "desktop", "agents"}), 9e12, "s", 7)
    local = authz.Ctx("local", "owner", frozenset(), None)
    authz.evaluate(owner_stale, "admin")
    with pytest.raises(authz.Denied) as e:
        authz.evaluate(owner_stale, "admin!")
    assert e.value.code == "stepup_required" and e.value.details["level"] == "fresh"
    authz.evaluate(owner_fresh, "admin!")
    authz.evaluate(local, "admin!")  # the dashboard on this Mac counts as fresh
    authz.evaluate(operator, "op:tasks")
    for ctx, pol in ((operator, "op:desktop"), (operator, "admin"), (agent_bot, "admin"), (agent_bot, "admin!"),
                     (owner_fresh, "local")):
        with pytest.raises(authz.Denied):
            authz.evaluate(ctx, pol)


@pytest.mark.parametrize("host,imitates", [
    ("login-microsoftonline.com", "login.microsoftonline.com"),
    ("login.microsoftonline.com.secure-check.io", "login.microsoftonline.com"),
    ("xn--micrsoft-qbh.com", "account.microsoft.com"),  # Cyrillic 'о'
    ("g00gle.com", "accounts.google.com"), ("accounts-google.com", "accounts.google.com"),
    ("githhub.com", "github.com"), ("paypal-secure.net", "paypal"),
])
def test_lookalikes_are_found(no_owner_config, host, imitates):
    assert no_owner_config.lookalike(host) == imitates


@pytest.mark.parametrize("host", ["login.microsoftonline.com", "teams.microsoft.com", "accounts.google.com",
                                  "my-office.com", "officedepot.com", "windows-tips.com", "example.com",
                                  "sso.mycompany.com", "xn--lgin-55d.microsoftonline.com"])
def test_genuine_or_unrelated_hosts_are_not_lookalikes(no_owner_config, host):
    assert no_owner_config.lookalike(host) is None


def test_relationships_are_exact_and_https_only(no_owner_config):
    t = no_owner_config
    assert t.relationship("https://teams.microsoft.com", "https://login.microsoftonline.com")["provider"] == "microsoft"
    assert t.relationship("https://login.microsoftonline.com", "https://teams.microsoft.com")["provider"] == "microsoft"
    assert t.relationship("http://teams.microsoft.com", "https://login.microsoftonline.com") is None
    assert t.relationship("https://teams.microsoft.com", "https://login.microsoftonline.com.evil.io") is None
    assert t.relationship("https://example.com", "https://accounts.google.com") is None  # third party: unverified
    # V3.4: two exact hosts of the same provider (Teams -> its new address teams.cloud.microsoft) are verified too
    assert t.relationship("https://teams.microsoft.com", "https://teams.cloud.microsoft")["provider"] == "microsoft"
    assert t.relationship("https://teams.microsoft.com", "https://teams.cloud.microsoft.evil.io") is None
    assert t.relationship("https://teams.microsoft.com", "https://mail.google.com") is None  # other provider
    assert "https://login.microsoftonline.com" in t.cookie_origins("https://teams.microsoft.com")
    assert t.cookie_origins("https://example.com") == []  # never a third-party IdP's session


def test_destination_levels(no_owner_config):
    t = no_owner_config
    green = t.classify_origin("https://teams.microsoft.com", "https://login.microsoftonline.com", allow_local=False)
    assert green["level"] == "GREEN" and green["relationship"]["name"] == "Microsoft"
    yellow = t.classify_origin("https://app.example.com", "https://sso.other-company.net", allow_local=False)
    assert yellow["level"] == "YELLOW" and "unverified_destination" in yellow["reasons"]
    red = t.classify_origin("https://login.microsoftonline.com", "https://login-microsoftonline.com", allow_local=False)
    assert red["level"] == "RED" and not red["hard"]
    http = t.classify_origin("https://app.example.com", "http://sso.example.net", allow_local=False)
    assert http["level"] == "RED" and http["hard"]
    rebinding = t.classify_origin("https://app.example.com", "https://app.example.com", allow_local=False,
                                  transport={"ip": "private", "tls": True})
    assert rebinding["level"] == "RED" and "private_address" in rebinding["reasons"]
    local = t.classify_origin("http://192.168.1.5:8080", "http://192.168.1.5:8080", allow_local=False)
    assert local["level"] == "RED" and "local_network" in local["reasons"]
    allowed_local = t.classify_origin("http://192.168.1.5:8080", "http://192.168.1.5:8080", allow_local=True)
    assert allowed_local["level"] == "YELLOW"  # allowed by the owner, still always reviewed


def test_step_levels_use_structure_flags_and_relationships(no_owner_config):
    t = no_owner_config
    base = {"step": "password", "page_origin": "https://login.microsoftonline.com", "confidence": "LOW",
            "structure": "HIGH", "flags": ["other_site"], "transport": {"ip": "public", "tls": True}}
    assert t.classify_step("https://teams.microsoft.com", base, allow_local=False, owner_allowed=[])["level"] == "GREEN"
    phish = {**base, "page_origin": "https://acct-portal.net", "flags": ["brand_mismatch:microsoft"]}
    assert t.classify_step("https://acct-portal.net", phish, allow_local=False, owner_allowed=[])["level"] == "RED"
    odd = {**base, "page_origin": "https://teams.microsoft.com", "structure": "MEDIUM", "flags": []}
    assert t.classify_step("https://teams.microsoft.com", odd, allow_local=False, owner_allowed=[])["level"] == "YELLOW"
    assert t.public_reason("lookalike:login.microsoftonline.com").startswith("The address imitates")
