# ruff: noqa: F811 - the `client` fixture is imported from test_api and injected by pytest
"""CodeQL triage (v1.0.0): the fixed exception exposure, and the path checks the path-injection alerts rely on.

The path tests pin, with real requests, the containment checks that make those alerts false positives:
  * dashboard SPA route   app.py        `(dist / path).resolve()` + `dist.resolve() in f.parents`
  * Mini App gateway      remote.py     `(dist / "assets" / path).resolve()` + `... in f.parents`
  * attachment derived    routes_v3.py  `(src.parent / derived).resolve()` + `(src.parent / "derived").resolve() in f.parents`
Each is probed with `..`, an absolute path, an encoded separator and a symlink that points outside the root.
"""

from __future__ import annotations

from urllib.parse import quote

import pytest
from fastapi.testclient import TestClient

from tests.integration.test_api import _agent, _setup_admin, client  # noqa: F401

OUTSIDE = "OUTSIDE-THE-ROOT-SECRET"


@pytest.fixture()
def dist(tmp_path, monkeypatch):
    d = tmp_path / "dist"
    (d / "assets").mkdir(parents=True)
    (d / "index.html").write_text("<html>dashboard</html>")
    (d / "mini.html").write_text("<html>mini</html>")
    (d / "assets" / "app.js").write_text("console.log(1)")
    (tmp_path / "outside.txt").write_text(OUTSIDE)
    (d / "assets" / "leak.js").symlink_to(tmp_path / "outside.txt")
    monkeypatch.setenv("NEBULA_DASHBOARD_DIST", str(d))
    return d


def _escapes(outside) -> list[str]:
    return ["/..%2Foutside.txt", "/assets/..%2F..%2Foutside.txt", "/" + quote(str(outside), safe=""),
            "/assets/leak.js"]


def test_spa_route_never_serves_a_file_outside_the_dashboard_build(client, dist):
    assert client.get("/assets/app.js").text == "console.log(1)"  # control: an in-root file is served
    for url in _escapes(dist.parent / "outside.txt"):
        r = client.get(url)
        assert OUTSIDE not in r.text, url
        assert r.text == "<html>dashboard</html>", url  # falls back to the SPA shell
    r = client.get("/x%00y")  # a NUL byte makes Path.resolve() raise: still the app shell, never a 500
    assert r.status_code == 200 and r.text == "<html>dashboard</html>"


def test_gateway_assets_never_serve_a_file_outside_the_build(dist):
    from nebula_host.remote import build_gateway

    gw = build_gateway(3199, dist, listen_port=3198)
    with TestClient(gw, base_url="http://127.0.0.1:3198") as c:
        assert c.get("/assets/app.js").text == "console.log(1)"
        for url in _escapes(dist.parent / "outside.txt"):
            r = c.get(url if url.startswith("/assets/") else "/assets" + url)
            assert OUTSIDE not in r.text, url
            assert r.status_code == 404, url


def test_attachment_derived_files_stay_inside_their_derived_folder(client, tmp_path):
    from nebula_host import attachments as attsvc
    from nebula_host.state import svc

    h = _setup_admin(client)
    a = _agent(client, h)
    r = client.post(f"/api/v1/agents/{a['id']}/attachments", files={"file": ("n.txt", b"hello notes", "text/plain")},
                    headers=h)
    assert r.status_code == 201, r.text
    att = r.json()["data"]
    url = f"/api/v1/attachments/{att['id']}/content"
    ok_ = client.get(url, params={"derived": "derived/text.txt"})
    assert ok_.status_code == 200 and ok_.text == "hello notes"  # control

    outside = tmp_path / "outside.txt"
    outside.write_text(OUTSIDE)
    src = attsvc.path_of(svc.cfg, attsvc.get(att["id"]))
    (src.parent / "derived" / "link.txt").symlink_to(outside)
    for derived in ("../../../../../../../../outside.txt", "derived/../../" + att["id"] + "/" + src.name,
                    str(outside), "derived/link.txt", "derived%2F..%2F..%2Foutside.txt", "derived/a\x00b", ""):
        r = client.get(url, params={"derived": derived})
        assert OUTSIDE not in r.text, derived
        if derived:
            assert r.status_code == 404 and r.json()["error"]["code"] == "not_found", derived


def test_siwc_callback_never_echoes_an_internal_exception(client, monkeypatch, caplog):
    """CodeQL py/stack-trace-exposure (routes.py): only a ProviderError's message, written for the person signing in,
    reaches the page; any other exception text (paths, SQL, library internals) stays in the host log."""
    from nebula_host import providers_service as provs

    internal = "sqlite3.OperationalError: /Users/owner/Library/Application Support/NEBULA/nebula.db is locked"

    class Broken:
        async def complete(self, *_a, **_k):
            raise RuntimeError(internal)

    monkeypatch.setattr(provs, "siwc_session", lambda: Broken())
    with caplog.at_level("ERROR", logger="nebula"):
        r = client.get("/auth/callback?state=s&code=c")
    assert r.status_code == 500
    assert "Sign in with ChatGPT failed" in r.text and "internal error" in r.text
    assert internal not in r.text and "sqlite3" not in r.text and "RuntimeError" not in r.text
    assert any(internal in (rec.exc_text or "") or internal in str(rec.exc_info) for rec in caplog.records)


def test_siwc_callback_still_explains_an_oauth_failure(client):
    r = client.get("/auth/callback?state=forged&code=x")
    assert r.status_code == 400 and "unknown or expired OAuth state" in r.text
