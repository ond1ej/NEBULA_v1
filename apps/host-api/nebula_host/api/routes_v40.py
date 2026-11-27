"""NEBULA 4.0 REST API: the owner's native apps (paired devices) and unified owner confirmation.

* GET    /devices                          paired NEBULA apps (pending + active), with vault-key status
* POST   /devices/pairing                  a 5-minute single-use pairing offer (QR code + link + one-time code)
* GET    /devices/pairing/{pairing_id}     offer status (open / claimed → the device waiting for approval)
* DELETE /devices/pairing/{pairing_id}     cancel an offer
* POST   /devices/{id}/approve | /reject   the owner compares the 6-digit code and approves (fresh owner)
* PATCH  /devices/{id}                     rename;   DELETE /devices/{id}  revoke (sessions + vault key removed)
* POST   /auth/confirm/challenge           single-use challenge for the app's Face ID / Touch ID confirmation
* POST   /auth/confirm                     ONE confirmation: step-up + (optionally) vault unlock / re-confirmation
* GET    /app/me, PUT /app/push            the calling app's own device record / APNs token

Device sign-in itself (claim, challenge, session) happens on the Mini App gateway (/api/app/*), the only place the
apps can reach. Every route is in the central policy table (nebula_host.authz). Responses are ``no-store``; secrets
are never echoed or logged.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from nebula_host import auth, authz, devices, miniapp
from nebula_host import remote as remotesvc
from nebula_host.api.routes_v32 import _body_limit, vok
from nebula_host.errors import ApiError

router = APIRouter(prefix="/api/v1", dependencies=[Depends(_body_limit)])
U = Depends(auth.require_session)


def _ctx(p: auth.Principal) -> authz.Ctx:
    ctx = authz.current()
    if ctx is not None:
        return ctx
    return authz.context_for(p, miniapp.session_info(p) if p.via else None)


def _err(e: devices.DeviceError) -> ApiError:
    return ApiError(e.status, e.code, e.message, details=e.details)


def _owner(p: auth.Principal) -> authz.Ctx:
    ctx = _ctx(p)
    if not ctx.owner:
        raise ApiError(403, "owner_only", "only the NEBULA owner can do this")
    return ctx


# ---------------------------------------------------------------- devices
@router.get("/devices")
async def list_devices(p: auth.Principal = U):
    _owner(p)
    return vok({"devices": devices.list_devices(), "gateway_url": remotesvc.public_base(),
                "server_fingerprint": devices.server_fingerprint()})


@router.post("/devices/pairing")
async def create_pairing(p: auth.Principal = U):
    _owner(p)
    try:
        return vok(devices.create_pairing(actor=p.actor, public_url=remotesvc.public_base()), 201)
    except devices.DeviceError as e:
        raise _err(e) from None


@router.get("/devices/pairing/{pairing_id}")
async def pairing_status(pairing_id: str, p: auth.Principal = U):
    _owner(p)
    try:
        return vok(devices.pairing_status(pairing_id))
    except devices.DeviceError as e:
        raise _err(e) from None


@router.delete("/devices/pairing/{pairing_id}")
async def cancel_pairing(pairing_id: str, p: auth.Principal = U):
    _owner(p)
    return vok(devices.cancel_pairing(pairing_id, actor=p.actor))


@router.post("/devices/{app_device_id}/approve")
async def approve_device(app_device_id: str, p: auth.Principal = U):
    _owner(p)
    try:
        return vok(devices.approve(app_device_id, actor=p.actor))
    except devices.DeviceError as e:
        raise _err(e) from None


@router.post("/devices/{app_device_id}/reject")
async def reject_device(app_device_id: str, p: auth.Principal = U):
    _owner(p)
    try:
        return vok(devices.revoke(app_device_id, actor=p.actor, reason="rejected"))
    except devices.DeviceError as e:
        raise _err(e) from None


class RenameBody(BaseModel):
    name: str = Field(min_length=1, max_length=60)


@router.patch("/devices/{app_device_id}")
async def rename_device(app_device_id: str, body: RenameBody, p: auth.Principal = U):
    _owner(p)
    try:
        return vok(devices.rename(app_device_id, body.name, actor=p.actor))
    except devices.DeviceError as e:
        raise _err(e) from None


@router.delete("/devices/{app_device_id}")
async def revoke_device(app_device_id: str, p: auth.Principal = U):
    _owner(p)
    try:
        return vok(devices.revoke(app_device_id, actor=p.actor))
    except devices.DeviceError as e:
        raise _err(e) from None


# ---------------------------------------------------------------- unified owner confirmation
class ConfirmChallengeBody(BaseModel):
    purpose: str = Field(default="stepup", max_length=24)


@router.post("/auth/confirm/challenge")
async def confirm_challenge(body: ConfirmChallengeBody, p: auth.Principal = U):
    try:
        return vok(devices.confirm_challenge(_owner(p), body.purpose))
    except devices.DeviceError as e:
        raise _err(e) from None


class ConfirmBody(BaseModel):
    method: str = Field(pattern="^(app_key|telegram_biometric|vault_passphrase|password)$")
    challenge_id: str | None = Field(default=None, max_length=64)
    signature: str | None = Field(default=None, max_length=200)
    vault_secret: str | None = Field(default=None, max_length=100)
    device_id: str | None = Field(default=None, max_length=24)
    token: str | None = Field(default=None, max_length=200)
    passphrase: str | None = Field(default=None, max_length=1024)
    password: str | None = Field(default=None, max_length=1024)
    unlock_vault: bool = False
    enroll_vault_key: bool = False


@router.post("/auth/confirm")
async def confirm(body: ConfirmBody, p: auth.Principal = U):
    ctx = _owner(p)
    data = body.model_dump()
    try:
        if ctx.interface == "local" and body.method not in ("vault_passphrase",):
            return vok({"fresh_until": None, "fresh": True, "vault": None})
        import asyncio

        # Argon2id (vault passphrase / login password) runs off the event loop
        return vok(await asyncio.to_thread(devices.confirm, ctx, p, data))
    except devices.DeviceError as e:
        raise _err(e) from None
    finally:
        for k in ("passphrase", "password", "token", "vault_secret", "signature"):
            data[k] = None
        body.passphrase = body.password = body.token = body.vault_secret = None


# ---------------------------------------------------------------- the calling app itself
@router.get("/app/me")
async def app_me(p: auth.Principal = U):
    ctx = _owner(p)
    if ctx.interface != "app":
        raise ApiError(403, "app_only", "for the NEBULA app only")
    from nebula_host.config import APP_VERSION

    return vok({"device": devices.get(ctx.device_id), "server_version": APP_VERSION,
                "server_fingerprint": devices.server_fingerprint(), "assurance": authz.assurance(ctx),
                "gateway_url": remotesvc.public_base()})


class PushBody(BaseModel):
    token: str | None = Field(default=None, max_length=200)
    env: str | None = Field(default=None, max_length=12)


@router.put("/app/push")
async def app_push(body: PushBody, p: auth.Principal = U):
    ctx = _owner(p)
    if ctx.interface != "app" or not ctx.device_id:
        raise ApiError(403, "app_only", "for the NEBULA app only")
    try:
        return vok(devices.set_push_token(ctx.device_id, body.token, body.env))
    except devices.DeviceError as e:
        raise _err(e) from None
