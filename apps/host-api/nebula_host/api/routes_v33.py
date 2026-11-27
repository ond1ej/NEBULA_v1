"""NEBULA 3.3 REST API: owner assurance (step-up) and Smart sign-in trust configuration.

* GET  /auth/assurance                 who am I (interface, role) and how fresh my verification is
* POST /auth/stepup/challenge          single-use challenge for a biometric confirmation (Mini App)
* POST /auth/stepup                    re-verify: NEBULA login password, or an enrolled device's biometric token
* GET/POST /auth/devices, DELETE /auth/devices/{id}   phones enrolled for Face ID / fingerprint confirmations
* GET /smart-auth/trust, POST/DELETE /smart-auth/trust/relationships, POST/DELETE /smart-auth/trust/sites
                                       verified identity-provider relationships and owner-verified sites

The same central policy (nebula_host.authz) protects these routes for the dashboard and the Mini App. Responses are
``Cache-Control: no-store``; passwords and tokens are never logged or echoed.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from nebula_host import auth, auth_trust, authz, miniapp
from nebula_host.api.routes_v32 import _body_limit, vok
from nebula_host.errors import ApiError

router = APIRouter(prefix="/api/v1", dependencies=[Depends(_body_limit)])
U = Depends(auth.require_session)


def _ctx(p: auth.Principal) -> authz.Ctx:
    ctx = authz.current()
    if ctx is not None:
        return ctx
    return authz.context_for(p, miniapp.session_info(p) if p.via else None)


def _denied(d: authz.Denied) -> ApiError:
    return ApiError(d.status, d.code, d.message, details=d.details)


@router.get("/auth/assurance")
async def assurance(p: auth.Principal = U):
    return vok(authz.assurance(_ctx(p)))


class ChallengeBody(BaseModel):
    device_id: str = Field(min_length=4, max_length=24)


@router.post("/auth/stepup/challenge")
async def stepup_challenge(body: ChallengeBody, p: auth.Principal = U):
    try:
        return vok(authz.challenge(_ctx(p), body.device_id))
    except authz.Denied as d:
        raise _denied(d) from None


class StepUpBody(BaseModel):
    method: str = Field(pattern="^(password|biometric)$")
    password: str | None = Field(default=None, max_length=1024)
    device_id: str | None = Field(default=None, max_length=24)
    challenge_id: str | None = Field(default=None, max_length=64)
    token: str | None = Field(default=None, max_length=200)


@router.post("/auth/stepup")
async def stepup(body: StepUpBody, p: auth.Principal = U):
    ctx = _ctx(p)
    try:
        if ctx.interface == "local":
            return vok({"fresh_until": None, "fresh": True})  # the dashboard on this Mac is already fresh
        if body.method == "password":
            return vok(authz.stepup_password(ctx, p, body.password or "", actor=p.actor))
        return vok(authz.stepup_biometric(ctx, body.device_id or "", body.challenge_id or "", body.token or "",
                                          actor=p.actor))
    except authz.Denied as d:
        raise _denied(d) from None
    finally:
        body.password = None
        body.token = None


@router.get("/auth/devices")
async def list_devices(p: auth.Principal = U):
    ctx = _ctx(p)
    return vok(authz.devices(ctx.telegram_user_id) if ctx.telegram_user_id else [])


class DeviceBody(BaseModel):
    name: str = Field(default="Phone", max_length=60)


@router.post("/auth/devices")
async def enroll_device(body: DeviceBody, p: auth.Principal = U):
    try:
        return vok(authz.enroll_device(_ctx(p), body.name, actor=p.actor), 201)
    except authz.Denied as d:
        raise _denied(d) from None


@router.delete("/auth/devices/{device_id}")
async def remove_device(device_id: str, p: auth.Principal = U):
    try:
        return vok(authz.remove_device(_ctx(p), device_id, actor=p.actor))
    except authz.Denied as d:
        raise _denied(d) from None


# ---------------------------------------------------------------- Smart sign-in trust
def _trust_view() -> dict:
    s = auth_trust.settings()
    return {"builtin": [{"id": pr.id, "name": pr.name, "sign_in_hosts": sorted(pr.auth_hosts),
                         "services": sorted(pr.service_hosts)} for pr in auth_trust.BUILTIN],
            "relationships": s["relationships"], "verified_sites": s["verified_sites"]}


@router.get("/smart-auth/trust")
async def trust(p: auth.Principal = U):
    return vok(_trust_view())


class RelationshipBody(BaseModel):
    service: str = Field(min_length=8, max_length=300)
    idp: str = Field(min_length=8, max_length=300)
    first_party: bool = False


@router.post("/smart-auth/trust/relationships")
async def add_relationship(body: RelationshipBody, p: auth.Principal = U):
    try:
        auth_trust.add_relationship(body.service, body.idp, first_party=body.first_party, actor=p.actor)
    except ValueError as e:
        raise ApiError(400, "invalid_relationship", str(e)) from None
    return vok(_trust_view(), 201)


@router.delete("/smart-auth/trust/relationships")
async def remove_relationship(service: str, idp: str, p: auth.Principal = U):
    auth_trust.remove_relationship(service, idp, actor=p.actor)
    return vok(_trust_view())


class SiteBody(BaseModel):
    origin: str = Field(min_length=8, max_length=300)


@router.post("/smart-auth/trust/sites")
async def verify_site(body: SiteBody, p: auth.Principal = U):
    try:
        auth_trust.verify_site(body.origin, actor=p.actor)
    except ValueError as e:
        raise ApiError(400, "invalid_site", str(e)) from None
    return vok(_trust_view(), 201)


@router.delete("/smart-auth/trust/sites")
async def unverify_site(origin: str, p: auth.Principal = U):
    auth_trust.unverify_site(origin, actor=p.actor)
    return vok(_trust_view())
