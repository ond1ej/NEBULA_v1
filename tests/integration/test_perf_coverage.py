# ruff: noqa: F811 - the `client` fixture is imported from test_api and injected by pytest
"""Coverage added by the V3 test pass (2026-11-16) for areas without a test: company deletion with isolated data and
concurrent Live Desktop viewers / exclusive control ownership."""

from __future__ import annotations

from tests.integration.test_api import _agent, _setup_admin, client  # noqa: F401
from tests.integration.test_v3_api import _company


def test_company_delete_needs_confirmation_and_keeps_agents(client, fake_guest):
    from nebula_host import db, models
    from nebula_host.state import svc
    from sqlalchemy import func, select

    svc.companies.guest = fake_guest  # the shared `client` fixture does not wire the company service to the fake VM
    h = _setup_admin(client)
    dev, qa = _agent(client, h, "Dev"), _agent(client, h, "QA")
    co = _company(client, h, [{"agent_id": dev["id"], "role": "fullstack"}, {"agent_id": qa["id"], "role": "qa"}],
                  name="Throwaway Co")
    p = client.post(f"/api/v1/companies/{co['id']}/projects", json={"name": "Temp project", "objective": "x"}, headers=h)
    assert p.status_code == 201, p.text
    assert client.delete(f"/api/v1/companies/{co['id']}", headers=h).status_code == 400  # confirm required
    r = client.delete(f"/api/v1/companies/{co['id']}?confirm=true", headers=h)
    assert r.status_code == 200 and r.json()["data"]["deleted"] == co["id"]
    assert client.get(f"/api/v1/companies/{co['id']}").status_code == 404
    with db.engine().connect() as c:
        for t in (models.company_members, models.company_projects, models.company_roles):
            assert c.execute(select(func.count()).select_from(t).where(t.c.company_id == co["id"])).scalar() == 0
    names = {a["name"] for a in client.get("/api/v1/agents").json()["data"]}
    assert {"Dev", "QA"} <= names  # employees are agents of their own: never deleted with the company
    # the company's VM folder is detached (kept), not deleted, unless delete_files=true
    assert co["workspace_dir"] and ("shared.ensure", {"key": co["workspace_dir"], "agent_ids": []}) in fake_guest.calls


def test_concurrent_viewers_share_view_but_only_one_controls(client, fake_guest):
    h = _setup_admin(client)
    a = _agent(client, h)
    s1 = client.post(f"/api/v1/agents/{a['id']}/live/connect", headers=h).json()["data"]
    s2 = client.post(f"/api/v1/agents/{a['id']}/live/connect", headers=h).json()["data"]
    assert s1["session_id"] != s2["session_id"]
    ctl = lambda s, action: client.post(f"/api/v1/live/sessions/{s['session_id']}/control",  # noqa: E731
                                        json={"action": action}, headers=h)
    assert ctl(s1, "acquire").status_code == 200
    r = ctl(s2, "acquire")
    assert r.status_code == 409 and r.json()["error"]["code"] == "lease_conflict"
    assert ctl(s1, "release").status_code == 200
    assert ctl(s2, "acquire").status_code == 200  # ownership moves only after an explicit release
    assert client.delete(f"/api/v1/live/sessions/{s2['session_id']}", headers=h).status_code == 200
    assert client.delete(f"/api/v1/live/sessions/{s1['session_id']}", headers=h).status_code == 200
    from nebula_host.state import svc

    assert not svc.orch.control_held(a["id"])  # disconnect released the lease
