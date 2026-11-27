#!/usr/bin/env python3
"""NEBULA 3.2.2 — real end-to-end agent creation through the Telegram Mini App gateway (max 2 AI requests).

1. A Mini App session is created exactly like on the phone: bot-signed initData -> gateway (127.0.0.1:3102).
2. Through the gateway: options, models of a connected provider, CREATE a temporary agent (real Linux user and
   desktop in the VM), retry with the same Idempotency-Key (same agent), settings read/edit, negative cases
   (unknown model, disconnected provider, terminal without Advanced, remote deletion refused).
3. The new agent receives a chat message through the gateway and must answer using the selected model
   (a harmless one-word task, max_model_calls=2).
4. Only the test-created agent is removed (local API); every other agent is compared before/after; the vault is
   checked to be unchanged.
Results: build/e2e/v322-agent.json
"""

from __future__ import annotations

import json
import secrets
import sqlite3
import sys
import time
import uuid
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "scripts"), str(ROOT / "apps/host-api"), str(ROOT / "apps/setup"),
                str(ROOT / "packages/contracts")]
import e2e  # noqa: E402
import e2e_common  # noqa: E402

OUT = ROOT / "build/e2e/v322-agent.json"
DB = e2e.DATA / "nebula.db"  # the instance under test (NEBULA_DATA_DIR / NEBULA_INSTANCE)
RES: dict = {"checks": [], "started": time.time(), "ai_requests": 0}
PREFERRED = ("openai-siwc", "ollama-local")


def check(name: str, ok: bool, **detail) -> bool:
    RES["checks"].append({"name": name, **detail, "status": "PASS" if ok else "FAIL"})
    print(("PASS " if ok else "FAIL ") + name, json.dumps(detail, default=str)[:300], flush=True)
    return ok


def snapshot() -> dict:
    c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    c.row_factory = sqlite3.Row
    agents = {r["id"]: {k: r[k] for k in ("name", "provider_id", "model_id", "permission_level", "config",
                                          "description", "linux_user")}
              for r in c.execute("select * from agents")}
    vault = {t: c.execute(f"select count(*) from {t}").fetchone()[0]  # noqa: S608 - fixed table names
             for t in ("vault_entries", "vault_agent_grants", "vault_agent_policies")}
    vault["meta"] = [tuple(r) for r in c.execute("select vault_id, wrapped_dek, failed_attempts from vault_metadata")]
    convs = c.execute("select count(*) from conversations").fetchone()[0]
    c.close()
    return {"agents": agents, "vault": vault, "conversations": convs}


def main() -> int:
    from nebula_host import secrets as sec

    api = e2e.Api(e2e.PORT)
    api.login_or_setup()
    sec.init_store("keychain")
    token = sec.store().get("nebula:telegram.bot_token")
    tg_user = api.get("/api/v1/telegram")["users"][0]["telegram_user_id"]
    before = snapshot()
    gw = httpx.Client(base_url=f"http://127.0.0.1:{e2e.GW_PORT}", timeout=240)
    r = gw.post("/api/mini/auth", json={"init_data": e2e_common.init_data(token, tg_user)})
    if not check("Mini App session from bot-signed initData (gateway)", r.status_code == 200, status=r.status_code):
        return finish()
    auth = {"authorization": f"Bearer {r.json()['data']['token']}"}
    check("owner session carries the 'agents' permission", "agents" in r.json()["data"]["permissions"])
    t0 = time.perf_counter()
    o = gw.get("/api/v1/miniapp/agent-options", headers=auth)
    opts = o.json()["data"]
    RES["options_ms"] = round((time.perf_counter() - t0) * 1000, 1)
    providers = {p["id"]: p for p in opts["providers"]}
    check("options via gateway: providers with live status, VM only, least-privilege defaults",
          o.status_code == 200 and any(p["connected"] for p in providers.values()) and
          [e["id"] for e in opts["environments"] if e["available"]] == ["vm"] and
          {c["id"]: c["default"] for c in opts["capabilities"]}["terminal"] is False,
          providers={k: v["state"] for k, v in providers.items()}, options_ms=RES["options_ms"])
    pid = next((p for p in PREFERRED if providers.get(p, {}).get("connected")), None)
    if not pid:
        check("a connected provider exists", False)
        return finish()
    t0 = time.perf_counter()
    ms = gw.get(f"/api/v1/miniapp/agent-options/models?provider_id={pid}", headers=auth).json()["data"]
    RES["models_ms"] = round((time.perf_counter() - t0) * 1000, 1)
    tool_models = [m for m in ms if m["supports_tools"]]
    existing_model = next((a["model_id"] for a in before["agents"].values() if a["provider_id"] == pid and
                           any(m["id"] == a["model_id"] for m in tool_models)), None)
    model = existing_model or (tool_models[0]["id"] if tool_models else None)
    check("models of the chosen provider via gateway", bool(model), provider=pid, models=len(ms), chosen=model,
          models_ms=RES["models_ms"])
    disconnected = next((p for p, v in providers.items() if not v["connected"]), None)
    name = "V322 Temp " + secrets.token_hex(3)
    body = {"name": name, "description": "Temporary end-to-end test agent (removed automatically)",
            "avatar": {"kind": "emoji", "value": "🧪"}, "provider_id": pid, "model_id": model,
            "instructions": "You are a test agent. When asked for a status word, reply with exactly that word and "
                            "nothing else. Do not use any tools.",
            "environment": "vm", "capabilities": {"browser": False, "web_research": False, "files": False,
                                                  "terminal": False, "desktop": False, "memory": False},
            "vault_access": "none"}
    # negative cases first (nothing may be created)
    neg = {
        "unknown model": gw.post("/api/v1/miniapp/agents", json={**body, "model_id": "invented-model-9"},
                                 headers={**auth, "Idempotency-Key": str(uuid.uuid4())}),
        "terminal without Advanced": gw.post("/api/v1/miniapp/agents", json={**body, "capabilities": {"terminal": True}},
                                             headers={**auth, "Idempotency-Key": str(uuid.uuid4())}),
        "host environment": gw.post("/api/v1/miniapp/agents", json={**body, "environment": "host"},
                                    headers={**auth, "Idempotency-Key": str(uuid.uuid4())}),
    }
    if disconnected:
        neg["disconnected provider"] = gw.post("/api/v1/miniapp/agents", json={**body, "provider_id": disconnected},
                                               headers={**auth, "Idempotency-Key": str(uuid.uuid4())})
    codes = {k: (v.status_code, (v.json().get("error") or {}).get("code")) for k, v in neg.items()}
    check("invalid requests refused server-side (nothing created)",
          all(s in (409, 422) for s, _ in codes.values()) and len(snapshot()["agents"]) == len(before["agents"]),
          results=codes)
    key = str(uuid.uuid4())
    t0 = time.perf_counter()
    cr = gw.post("/api/v1/miniapp/agents", json=body, headers={**auth, "Idempotency-Key": key})
    RES["create_s"] = round(time.perf_counter() - t0, 2)
    created = cr.json().get("data") or {}
    aid = (created.get("agent") or {}).get("id")
    try:
        check("agent created through the gateway: real VM workspace, READY", cr.status_code == 201 and
              created.get("ready") is True and created["agent"]["state"] == "READY" and
              bool(created["agent"].get("linux_user")) and bool(created["agent"].get("desktop_health") or {}),
              status=cr.status_code, create_s=RES["create_s"], error=cr.json().get("error"))
        if not aid:
            return finish()
        again = gw.post("/api/v1/miniapp/agents", json=body, headers={**auth, "Idempotency-Key": key})
        check("retry with the same Idempotency-Key returns the same agent (no duplicate)",
              again.status_code == 201 and again.json()["data"]["agent"]["id"] == aid and
              len(snapshot()["agents"]) == len(before["agents"]) + 1)
        lst = gw.get("/api/v1/agents", headers=auth).json()["data"]
        mine = next((a for a in lst if a["id"] == aid), {})
        check("agent listed in the Mini App with avatar, model and capabilities",
              mine.get("config", {}).get("avatar") == {"kind": "emoji", "value": "🧪"} and mine.get("model_id") == model
              and mine.get("provider_id") == pid)
        st = gw.get(f"/api/v1/miniapp/agents/{aid}/settings", headers=auth).json()["data"]
        check("settings readable via gateway (least privilege as chosen, vault none, no grants)",
              st["capabilities"] == {"browser": False, "web_research": False, "files": False, "terminal": False,
                                     "desktop": False, "memory": False} and st["vault_access"] == "none" and
              st["vault"]["grants"] == [] and st["environment"]["env"] == "vm")
        conv = gw.get(f"/api/v1/agents/{aid}/conversation", headers=auth).json()["data"]
        chats = gw.get("/api/v1/conversations", headers=auth).json()["data"]
        check("conversation exists and appears in Chats", any(c["id"] == conv["id"] for c in chats))
        m = gw.post(f"/api/v1/conversations/{conv['id']}/messages", headers={**auth, "Idempotency-Key": key[:30]},
                    json={"content": "Status check: reply with exactly the word READY.",
                          "client_id": uuid.uuid4().hex, "max_model_calls": 2})
        tid = m.json()["data"]["task"]["id"]
        end = time.time() + 240
        t = {}
        while time.time() < end:
            t = api.get(f"/api/v1/tasks/{tid}")
            if t["state"] in ("COMPLETED", "FAILED", "CANCELLED"):
                break
            time.sleep(1)
        res = t.get("result") or {}
        RES["ai_requests"] = int(res.get("model_calls") or (res.get("timings") or {}).get("model_turns") or 0)
        msgs = gw.get(f"/api/v1/conversations/{conv['id']}/messages", headers=auth).json()["data"]["items"]
        reply = next((x["content"] for x in reversed(msgs) if x["role"] == "assistant"), "")
        check("new agent answers a real AI task with the selected model", t.get("state") == "COMPLETED" and
              "READY" in reply.upper(), state=t.get("state"), reply=reply[:120], model=f"{pid}/{model}",
              model_requests=RES["ai_requests"],
              timings={k: (res.get("timings") or {}).get(k) for k in ("total_ms", "queue_ms", "model_ms")})
        ed = gw.patch(f"/api/v1/miniapp/agents/{aid}/settings", headers=auth,
                      json={"name": name + " edited", "instructions": "Edited instructions.",
                            "avatar": {"kind": "icon", "value": "robot"}})
        local = api.get(f"/api/v1/agents/{aid}")
        check("settings edited in the Mini App are what the dashboard sees", ed.status_code == 200 and
              local["name"] == name + " edited" and local["config"]["instructions"] == "Edited instructions." and
              local["config"]["avatar"] == {"kind": "icon", "value": "robot"})
        bad = gw.patch(f"/api/v1/miniapp/agents/{aid}/settings", headers=auth,
                       json={"provider_id": pid, "model_id": "invented-model-9"})
        dele = gw.delete(f"/api/v1/agents/{aid}?confirm=true", headers=auth)
        raw = gw.patch(f"/api/v1/agents/{aid}", headers=auth, json={"permission_level": "ADVANCED"})
        check("remote model change validated; deletion and raw agent edits refused by the gateway",
              bad.status_code == 422 and dele.status_code in (403, 404, 405) and raw.status_code in (403, 404, 405),
              results=[bad.status_code, dele.status_code, raw.status_code])
    finally:
        if aid:
            try:
                api.delete(f"/api/v1/agents/{aid}?confirm=true")
                RES["temp_agent_deleted"] = True
            except Exception as e:  # noqa: BLE001
                RES["temp_agent_deleted"] = f"failed: {e}"
    after = snapshot()
    changed = [k for k, v in before["agents"].items() if after["agents"].get(k) != v]
    check("owner's existing agents unchanged and the temporary agent removed",
          not changed and set(after["agents"]) == set(before["agents"]), changed=changed)
    check("Password Vault untouched", after["vault"] == before["vault"])
    return finish()


def finish() -> int:
    RES["finished"] = time.time()
    RES["summary"] = {s: sum(1 for c in RES["checks"] if c["status"] == s) for s in ("PASS", "FAIL")}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(RES, indent=2, default=str))
    print(json.dumps(RES["summary"]), "ai_requests", RES["ai_requests"])
    return 0 if RES["summary"]["FAIL"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
