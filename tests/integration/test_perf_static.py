# ruff: noqa: F811 - the `client` fixture is imported from test_api and injected by pytest
"""Perf audit 2026-11-16: precompressed, long-cached dashboard / Mini App assets (main port and Mini App gateway)."""

from __future__ import annotations

import gzip

import pytest
from fastapi.testclient import TestClient

from tests.integration.test_api import client  # noqa: F401

JS = b"console.log('nebula');" * 200


@pytest.fixture()
def dist(tmp_path, monkeypatch):
    d = tmp_path / "dist"
    (d / "assets").mkdir(parents=True)
    (d / "index.html").write_text("<html>dashboard</html>")
    (d / "mini.html").write_text("<html>mini</html>")
    (d / "assets" / "app-abc.js").write_bytes(JS)
    (d / "assets" / "app-abc.js.gz").write_bytes(gzip.compress(JS))
    (d / "assets" / "app-abc.js.br").write_bytes(b"BROTLI-PLACEHOLDER")  # content irrelevant: header selection test
    (d / "assets" / "plain-xyz.css").write_bytes(b"body{}")
    monkeypatch.setenv("NEBULA_DASHBOARD_DIST", str(d))
    return d


def test_accept_encoding_parsing():
    from nebula_host.static import accepted

    assert accepted("gzip, deflate, br") == {"gzip", "deflate", "br"}
    assert accepted("br;q=0, gzip;q=0.8") == {"gzip"}
    assert accepted(None) == set() and accepted("") == set()


def test_main_port_serves_precompressed_immutable_assets(client, dist):
    r = client.get("/assets/app-abc.js", headers={"Accept-Encoding": "br, gzip"})
    assert r.status_code == 200 and r.headers["content-encoding"] == "br"
    assert r.headers["cache-control"] == "public, max-age=31536000, immutable"
    assert r.headers["vary"] == "Accept-Encoding" and r.headers["content-type"].startswith("text/javascript")
    r = client.get("/assets/app-abc.js", headers={"Accept-Encoding": "gzip"})
    assert r.headers["content-encoding"] == "gzip" and r.content == JS  # client transparently decodes
    r = client.get("/assets/app-abc.js", headers={"Accept-Encoding": "identity"})
    assert "content-encoding" not in r.headers and r.content == JS
    r = client.get("/assets/plain-xyz.css", headers={"Accept-Encoding": "br, gzip"})
    assert "content-encoding" not in r.headers and r.content == b"body{}"  # no variant: original file
    # the compressed variants are never served under their own names, and HTML is never cached
    assert client.get("/assets/app-abc.js.br").text == "<html>dashboard</html>"
    page = client.get("/")
    assert page.headers["cache-control"] == "no-store" and page.text == "<html>dashboard</html>"
    assert client.get("/mini/").headers["cache-control"] == "no-store"


def test_gateway_serves_precompressed_assets(dist):
    from nebula_host.remote import build_gateway

    gw = build_gateway(3101, dist, listen_port=3102)
    with TestClient(gw, base_url="http://127.0.0.1:3102") as c:
        r = c.get("/assets/app-abc.js", headers={"Accept-Encoding": "gzip"})
        assert r.status_code == 200 and r.headers["content-encoding"] == "gzip" and r.content == JS
        assert r.headers["cache-control"] == "public, max-age=31536000, immutable"
        assert c.get("/assets/app-abc.js.gz").status_code == 404
        assert c.get("/assets/../index.html").status_code in (404, 400)


def test_gateway_relays_compressed_json_only_when_the_phone_accepts_it(client):
    """The gateway streams the upstream bytes as they are: Content-Encoding must travel with them, and upstream may
    only compress when the Mini App client accepts gzip (it used to drop the header — fatal once JSON is gzipped)."""
    import json as _json
    from pathlib import Path

    import httpx
    from nebula_host import remote

    from tests.integration.test_api import _setup_admin
    from tests.integration.test_v3_api import _pair_owner
    from tests.unit.test_v3_units import BOT_TOKEN, make_init_data

    _setup_admin(client)
    _pair_owner(7)
    seen = []
    payload = _json.dumps({"data": [{"id": i, "name": "agent" * 20} for i in range(200)]}).encode()

    def upstream(req: httpx.Request) -> httpx.Response:
        seen.append(req.headers.get("accept-encoding"))
        if req.headers.get("accept-encoding") == "gzip":
            return httpx.Response(200, stream=httpx.ByteStream(gzip.compress(payload)),
                                  headers={"content-type": "application/json", "content-encoding": "gzip"})
        return httpx.Response(200, stream=httpx.ByteStream(payload), headers={"content-type": "application/json"})

    gw = remote.build_gateway(3199, Path("/nonexistent"), forward_client=httpx.AsyncClient(
        transport=httpx.MockTransport(upstream), base_url="http://127.0.0.1:3199"), listen_port=3102)
    with TestClient(gw, base_url="http://127.0.0.1:3102") as g:
        tok = g.post("/api/mini/auth", json={"init_data": make_init_data(BOT_TOKEN)}).json()["data"]["token"]
        auth = {"authorization": f"Bearer {tok}"}
        r = g.get("/api/v1/agents", headers={**auth, "Accept-Encoding": "gzip, br"})
        assert r.status_code == 200 and r.headers["content-encoding"] == "gzip" and r.json()["data"][0]["id"] == 0
        r = g.get("/api/v1/agents", headers={**auth, "Accept-Encoding": "identity"})
        assert "content-encoding" not in r.headers and len(r.json()["data"]) == 200
    assert seen == ["gzip", "identity"]


def test_main_port_gzips_large_json_but_never_sse(client):
    from tests.integration.test_api import _setup_admin

    _setup_admin(client)
    r = client.get("/api/openapi.json", headers={"Accept-Encoding": "gzip"})
    assert r.headers.get("content-encoding") == "gzip" and r.json()["openapi"]
    small = client.get("/api/v1/auth/state", headers={"Accept-Encoding": "gzip"})
    assert "content-encoding" not in small.headers  # below the 2 KB threshold
    with client.stream("GET", "/api/v1/events", headers={"Accept-Encoding": "gzip"}) as s:
        assert s.headers["content-type"].startswith("text/event-stream")
        assert "content-encoding" not in s.headers
