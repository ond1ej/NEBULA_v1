"""V2 security: every new endpoint requires a session, every mutation a CSRF token; cross-agent memory/file access,
secret refusal and plugin isolation through the API."""

from __future__ import annotations

import re

import pytest

from tests.integration.test_api import ORIGIN, _agent, _setup_admin, client  # noqa: F401

PUBLIC = {"/api/v1/health", "/api/v1/auth/state", "/api/v1/auth/setup", "/api/v1/auth/login"}


def _v2_routes():
    from nebula_host.api import routes_v2

    for r in routes_v2.router.routes:
        for m in r.methods:
            yield m, r.path


def _concrete(path: str) -> str:
    return re.sub(r"\{[^}]+\}", "00000000-0000-0000-0000-000000000000", path)


def test_every_v2_endpoint_requires_a_session(client):  # noqa: F811
    seen = 0
    for method, path in _v2_routes():
        if path in PUBLIC:
            continue
        r = client.request(method, _concrete(path), headers=ORIGIN, json={})
        assert r.status_code == 401, (method, path, r.status_code)
        seen += 1
    assert seen > 50


def test_every_v2_mutation_requires_csrf(client):  # noqa: F811
    _setup_admin(client)  # logged in, but requests below carry no CSRF header
    for method, path in _v2_routes():
        if method in ("GET", "HEAD"):
            continue
        r = client.request(method, _concrete(path), headers=ORIGIN, json={})
        assert r.status_code == 403 and r.json()["error"]["code"] == "csrf_failed", (method, path, r.status_code)


def test_v2_mutation_from_foreign_origin_rejected(client):  # noqa: F811
    h = _setup_admin(client)
    r = client.post("/api/v1/teams", json={"name": "x"}, headers={**h, "origin": "https://evil.example"})
    assert r.status_code == 403 and r.json()["error"]["code"] == "bad_origin"


def test_memory_api_cannot_reach_other_agents_and_refuses_secrets(client):  # noqa: F811
    h = _setup_admin(client)
    a, b = _agent(client, h, "SecA"), _agent(client, h, "SecB")
    m = client.post(f"/api/v1/agents/{a['id']}/memory", headers=h, json={"key": "k", "value": "alpha only"}).json()["data"]
    assert client.get(f"/api/v1/agents/{b['id']}/memory").json()["data"] == []
    assert client.patch(f"/api/v1/agents/{b['id']}/memory/{m['id']}", json={"value": "x"}, headers=h).status_code == 404
    for secret in ("token: ghp_" + "x" * 36, "my card 4111 1111 1111 1111", "sk-ant-" + "y" * 30):
        r = client.post(f"/api/v1/agents/{a['id']}/memory", headers=h, json={"key": "s", "value": secret})
        assert r.status_code == 400, secret
    r = client.post(f"/api/v1/agents/{a['id']}/memory", headers=h,
                    json={"key": "pref", "value": "x", "kind": "preference"})
    assert r.status_code == 201  # owner-written preferences are allowed (owner trust)


@pytest.mark.parametrize("root", ["exchange", "agent:{a}"])
def test_file_api_confinement(client, fake_guest, root):  # noqa: F811
    h = _setup_admin(client)
    a = _agent(client, h)
    root = root.format(a=a["id"])
    for path in ("../../etc/passwd", "a/../../../x", "\x00evil"):
        r = client.get("/api/v1/files/list", params={"root": root, "path": path})
        assert r.status_code in (400, 404), (root, path, r.status_code)
    assert client.delete("/api/v1/files", params={"root": root, "path": "."}, headers=h).status_code == 400
    r = client.delete("/api/v1/files", params={"root": root, "path": ".", "confirm": True}, headers=h)
    assert r.status_code == 400  # the root itself can never be deleted


def test_plugin_install_rejects_traversal_and_shadowing(client, fake_guest):  # noqa: F811
    import io
    import json
    import zipfile

    h = _setup_admin(client)
    for manifest_id, extra in (("terminal", {}), ("ok-plugin", {"../../../etc/cron.d/x": "boom"})):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            z.writestr("nebula-plugin.json", json.dumps({"schema_version": 1, "id": manifest_id, "name": "n",
                                                         "version": "1.0.0", "description": "d", "entrypoint": "m.py",
                                                         "tools": [{"name": "t"}]}))
            z.writestr("m.py", "")
            for k, v in extra.items():
                z.writestr(k, v)
        r = client.post("/api/v1/skills/plugins", content=buf.getvalue(), headers=h)
        assert r.status_code == 400, manifest_id
    assert fake_guest.plugins == {}  # nothing reached the VM
