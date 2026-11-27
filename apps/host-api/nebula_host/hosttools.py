"""Tools that execute on the host (not inside the VM): team delegation, GitHub REST API, approved package installs.

Policy (approvals, levels, denied-category memory) has already run in the orchestrator before these are called.
"""

from __future__ import annotations

import json
import re
from typing import Any

from nebula_host.events import audit
from nebula_host.state import svc

GITHUB_PATH = re.compile(r"^/(repos|users|orgs|search|gists|rate_limit|licenses|emojis)(/[\w.\-~%/]*)?(\?[\w.\-~%=&+,:]*)?$")
MAX_BODY = 64 * 1024
GITHUB_TOKEN_REF = "nebula:github.token"  # Keychain refs must match nebula:<name> (secrets._REF_RE)


async def run(runner, name: str, args: dict[str, Any], agent: dict[str, Any]) -> dict[str, Any]:
    try:
        if name == "team_delegate":
            r = await svc.teams.delegate(runner.task_id, str(args.get("role", "")), str(args.get("title", "")),
                                         str(args.get("prompt", "")))
            return {"status": "ok", **r, "note": "the subtask runs on its own; finish your part with task_complete"}
        if name == "github_api":
            return await github(args)
        if name == "company_plan":
            r = await svc.companies.submit_plan(runner.task_id, args)
            return {"status": "ok", **r, "note": "plan accepted; finish your planning task with task_complete"}
        if name == "packages_install":
            names = [str(n) for n in (args.get("names") or [])]
            r = await svc.guest.call("packages.install", {"names": names}, timeout=1500)
            audit(f"agent:{agent['id']}", "packages.install", ",".join(names), {"exit_code": r.get("exit_code")})
            return {"status": "ok" if r.get("exit_code") == 0 else "error", **r}
    except (ValueError, KeyError) as e:
        return {"status": "error", "error": str(e)}
    except Exception as e:  # noqa: BLE001 - reported to the model, never crash the task
        return {"status": "error", "error": f"{type(e).__name__}: {e}"}
    return {"status": "error", "error": f"unknown host tool {name}"}


async def github(args: dict[str, Any]) -> dict[str, Any]:
    import httpx

    from nebula_host import secrets as sec

    path = str(args.get("path", ""))
    method = str(args.get("method", "GET")).upper()
    if not GITHUB_PATH.match(path):
        return {"status": "error", "error": "path must be a GitHub REST path like /repos/owner/name/issues"}
    token = sec.store().get(GITHUB_TOKEN_REF)
    if method != "GET" and not token:
        return {"status": "error", "error": "writes need a GitHub token in the Keychain (Skills → GitHub → token)",
                "blocked_by": "credentials"}
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "NEBULA-agent",
               "X-GitHub-Api-Version": "2022-11-28"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    body = None
    if args.get("body"):
        try:
            body = json.loads(str(args["body"]))
        except json.JSONDecodeError:
            return {"status": "error", "error": "body must be JSON"}
    async with httpx.AsyncClient(base_url="https://api.github.com", timeout=30, follow_redirects=False) as c:
        r = await c.request(method, path, headers=headers, json=body)
    text = r.text[:MAX_BODY]
    try:
        data: Any = json.loads(text) if len(r.text) <= MAX_BODY else None
    except json.JSONDecodeError:
        data = None
    return {"status": "ok" if r.status_code < 400 else "error", "http_status": r.status_code,
            "rate_remaining": r.headers.get("x-ratelimit-remaining"), "data": data,
            "text": None if data is not None else text, "truncated": len(r.text) > MAX_BODY}
