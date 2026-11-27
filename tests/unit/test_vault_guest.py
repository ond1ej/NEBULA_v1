"""Guest side of the Password Vault broker: parameter validation, cookie hand-off, error hygiene of the isolated
login process (no Playwright needed here; the real login runs in the VM — scripts/v32_vault_e2e.py)."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "guest/guest-service/nebula_guest/vault_login.py"
CANARY = "CANARY-PW-guest-91b2"


def test_origin_of_matches_host_canonicalisation():
    from nebula_guest.vault_login import origin_of
    from nebula_host.vault import canonical_origin

    for url in ("https://GitHub.com:443/login", "https://github.com:8443/x", "http://127.0.0.1:8099/a?b",
                "https://[::1]:9443/"):
        assert origin_of(url) == canonical_origin(url), url
    assert origin_of("chrome-error://chromewebdata/") == "" and origin_of("about:blank") == ""
    assert origin_of("https://github.com.attacker.example/") != "https://github.com"


def test_param_validation_rejects_bad_input():
    from nebula_guest import vaultops
    from nebula_guest.workspace import WorkspaceError

    ok = {"origin": "https://a.example", "allowed_origins": ["https://a.example"], "login_url": "https://a.example/l",
          "username": "u", "password": "p"}
    assert vaultops._valid_params(dict(ok))[0] == "https://a.example"
    for patch in ({"origin": "https://a.example/path"}, {"allowed_origins": ["https://b.example"]},
                  {"allowed_origins": []}, {"login_url": "javascript:alert(1)"}, {"password": 5},
                  {"password": "x" * 5000}, {"origin": "file:///etc/passwd"}):
        with pytest.raises(WorkspaceError):
            vaultops._valid_params({**ok, **patch})


def test_cookie_cleaning_keeps_only_cookie_fields():
    from nebula_guest import vaultops

    got = vaultops._clean_cookies([{"name": "s", "value": "v", "domain": "a.example", "path": "/", "evil": 1},
                                   {"name": "x"}, "junk", {"name": "n", "value": "v"}] + [
        {"name": f"c{i}", "value": "v", "domain": "a.example"} for i in range(300)])
    assert got[0] == {"name": "s", "value": "v", "domain": "a.example", "path": "/"} and len(got) == 200


def test_login_process_reports_errors_by_type_only():
    """Even a crash (here: no Playwright on the Mac) must never echo the credential on stdout/stderr."""
    req = json.dumps({"origin": "https://a.example", "allowed_origins": ["https://a.example"],
                      "login_url": "https://a.example/login", "username": CANARY, "password": CANARY,
                      "timeout_s": 5}) + "\n"
    r = subprocess.run([sys.executable, "-I", str(SCRIPT)], input=req.encode(), capture_output=True, timeout=60)
    out = r.stdout.decode()
    res = json.loads(out.strip().splitlines()[-1])
    assert res["status"] in ("error", "timeout", "origin_mismatch") and CANARY not in out
    assert CANARY not in r.stderr.decode()


def test_login_process_refuses_login_url_outside_allowed_origins(monkeypatch):
    import asyncio

    from nebula_guest import vault_login

    res = asyncio.run(vault_login.run({"origin": "https://a.example", "allowed_origins": ["https://a.example"],
                                       "login_url": "https://evil.example/login", "username": "u", "password": "p"}))
    assert res == {"status": "origin_mismatch"}


def test_self_test_reports_missing_user(monkeypatch):
    from nebula_guest import vaultops

    def missing(name):
        raise KeyError(name)

    monkeypatch.setattr(vaultops.pwd, "getpwnam", missing)
    st = vaultops.self_test()
    assert st["installed"] is False and st["isolated"] is False and "nebula-vault" in st["reason"]


def test_import_cookies_tool_only_takes_cookie_fields(monkeypatch):
    import asyncio

    from nebula_guest import agent_tools

    added = []

    class Ctx:
        async def add_cookies(self, cookies):
            added.extend(cookies)

    async def page():
        return None

    monkeypatch.setattr(agent_tools.BROWSER, "_ctx", Ctx())
    monkeypatch.setattr(agent_tools.BROWSER, "page", page)
    r = asyncio.run(agent_tools.browser_import_cookies({"cookies": [
        {"name": "s", "value": "v", "domain": "a.example", "httpOnly": True, "password": "nope"}, {"bad": 1}]}))
    assert r == {"imported": 1} and added == [{"name": "s", "value": "v", "domain": "a.example", "httpOnly": True}]
    with pytest.raises(agent_tools.ToolError):
        asyncio.run(agent_tools.browser_import_cookies({"cookies": "x"}))
    assert "browser.import_cookies" in agent_tools.TOOLS
