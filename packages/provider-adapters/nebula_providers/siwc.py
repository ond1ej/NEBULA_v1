"""OpenAI "Sign in with ChatGPT" for open-source, locally hosted clients (token sharing).

Implements the documented flow (developers.openai.com/siwc/token-sharing-open-source, fetched 2026-11-15):
OIDC authorization code + PKCE (S256) with a 127.0.0.1 loopback redirect, dynamic client registration
(client_id=dynamic_agent_client on first sign-in, then the issued oaiapp_ id), ext_agent_host_id,
rotating refresh tokens (serialized), ID-token verification (JWKS, iss, aud, nonce), and Responses API
calls with store=false, stream=true. No passwords, cookies or ChatGPT backend-api endpoints are ever used.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import secrets
import time
from collections.abc import Callable
from typing import Any
from urllib.parse import urlencode

import httpx
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec, padding, rsa
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature

from nebula_providers.adapters import OpenAIResponsesAdapter
from nebula_providers.base import ProviderError

ISSUER = "https://auth.openai.com"
AUTHORIZE_URL = "https://auth.openai.com/api/accounts/authorize"
TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token"
DISCOVERY_URL = "https://auth.openai.com/.well-known/openid-configuration"
RESOURCE = "https://api.openai.com/v1"
SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"
DYNAMIC_CLIENT = "dynamic_agent_client"
ISSUED_CLIENT_RE = __import__("re").compile(r"^oaiapp_[A-Za-z0-9_-]{4,128}$")
TERMINAL_REFRESH_ERRORS = {"invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired",
                           "refresh_token_invalidated", "refresh_token_reused"}
USAGE_URL = "https://chatgpt.com/settings/usage"


def b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def b64url_decode(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def pkce_pair() -> tuple[str, str]:
    verifier = b64url(secrets.token_bytes(48))
    challenge = b64url(hashlib.sha256(verifier.encode()).digest())
    return verifier, challenge


def build_authorize_url(*, client_id: str, redirect_uri: str, state: str, nonce: str, challenge: str,
                        host_id: str, agent_name_hint: str | None, login_hint: str | None = None) -> str:
    params = {
        "response_type": "code", "client_id": client_id, "redirect_uri": redirect_uri, "scope": SCOPES,
        "state": state, "nonce": nonce, "code_challenge": challenge, "code_challenge_method": "S256",
        "resource": RESOURCE, "ext_agent_host_id": host_id,
    }
    if client_id == DYNAMIC_CLIENT and agent_name_hint:
        params["agent_name_hint"] = agent_name_hint
    if login_hint:
        params["login_hint"] = login_hint
    return f"{AUTHORIZE_URL}?{urlencode(params)}"


def _verify_jwt_signature(token: str, jwks: dict[str, Any]) -> dict[str, Any]:
    head_b64, payload_b64, sig_b64 = token.split(".")
    header = json.loads(b64url_decode(head_b64))
    signed = f"{head_b64}.{payload_b64}".encode()
    sig = b64url_decode(sig_b64)
    keys = [k for k in jwks.get("keys", []) if k.get("kid") == header.get("kid")] or jwks.get("keys", [])
    alg = header.get("alg")
    for k in keys:
        try:
            if alg == "RS256" and k.get("kty") == "RSA":
                pub = rsa.RSAPublicNumbers(int.from_bytes(b64url_decode(k["e"]), "big"),
                                           int.from_bytes(b64url_decode(k["n"]), "big")).public_key()
                pub.verify(sig, signed, padding.PKCS1v15(), hashes.SHA256())
                return json.loads(b64url_decode(payload_b64))
            if alg == "ES256" and k.get("kty") == "EC":
                pub = ec.EllipticCurvePublicNumbers(int.from_bytes(b64url_decode(k["x"]), "big"),
                                                    int.from_bytes(b64url_decode(k["y"]), "big"),
                                                    ec.SECP256R1()).public_key()
                r, s = int.from_bytes(sig[:32], "big"), int.from_bytes(sig[32:], "big")
                pub.verify(encode_dss_signature(r, s), signed, ec.ECDSA(hashes.SHA256()))
                return json.loads(b64url_decode(payload_b64))
        except Exception:  # noqa: BLE001 - try next key
            continue
    raise ProviderError("auth", "ID token signature verification failed")


async def verify_id_token(id_token: str, *, client_id: str, nonce: str, http: httpx.AsyncClient) -> dict[str, Any]:
    disc = (await http.get(DISCOVERY_URL)).json()
    jwks = (await http.get(disc["jwks_uri"])).json()
    claims = _verify_jwt_signature(id_token, jwks)
    aud = claims.get("aud")
    auds = aud if isinstance(aud, list) else [aud]
    if claims.get("iss") != ISSUER:
        raise ProviderError("auth", "ID token issuer mismatch")
    if client_id not in auds:
        raise ProviderError("auth", "ID token audience mismatch")
    if claims.get("nonce") != nonce:
        raise ProviderError("auth", "ID token nonce mismatch")
    if claims.get("exp", 0) < time.time() - 60:
        raise ProviderError("auth", "ID token expired")
    return claims


class SIWCSession:
    """Holds pending authorizations (state -> PKCE/nonce) and the stored credential, refresh-serialized."""

    def __init__(self, provider_id: str, load: Callable[[], dict | None], save: Callable[[dict | None], None],
                 host_id: str, redirect_uri: str, agent_name: str = "NEBULA") -> None:
        self.provider_id = provider_id
        self._load = load
        self._save = save
        self.host_id = host_id
        self.redirect_uri = redirect_uri
        self.agent_name = agent_name
        self._pending: dict[str, dict[str, Any]] = {}
        self._refresh_lock = asyncio.Lock()

    def credential(self) -> dict | None:
        return self._load()

    def start(self) -> dict[str, Any]:
        cred = self._load() or {}
        client_id = cred.get("client_id") or DYNAMIC_CLIENT
        verifier, challenge = pkce_pair()
        state, nonce = b64url(secrets.token_bytes(24)), b64url(secrets.token_bytes(24))
        self._pending = {k: v for k, v in self._pending.items() if v["created"] > time.time() - 600}
        self._pending[state] = {"verifier": verifier, "nonce": nonce, "client_id": client_id, "created": time.time()}
        url = build_authorize_url(client_id=client_id, redirect_uri=self.redirect_uri, state=state, nonce=nonce,
                                  challenge=challenge, host_id=self.host_id,
                                  agent_name_hint=self.agent_name if client_id == DYNAMIC_CLIENT else None)
        return {"authorize_url": url, "state": state, "redirect_uri": self.redirect_uri, "expires_in": 600}

    async def complete(self, state: str, code: str, callback_client_id: str | None = None, iss: str | None = None,
                       http: httpx.AsyncClient | None = None) -> dict[str, Any]:
        """Exchange the authorization code. On first sign-in OpenAI registers a client dynamically and returns the
        issued id (oaiapp_...) as `client_id` on the redirect; that id — never `dynamic_agent_client` — is used
        for the code exchange, persisted immediately and reused for later sign-ins and refreshes."""
        p = self._pending.pop(state, None)
        if not p or p["created"] < time.time() - 600:
            raise ProviderError("auth", "unknown or expired OAuth state (CSRF protection)")
        if iss is not None and iss != ISSUER:
            raise ProviderError("auth", f"unexpected authorization server {iss!r}")  # mix-up defence
        issued = callback_client_id or (p["client_id"] if p["client_id"] != DYNAMIC_CLIENT else None)
        if not issued or issued == DYNAMIC_CLIENT or not ISSUED_CLIENT_RE.match(issued):
            raise ProviderError("auth", "OpenAI did not return an issued client_id for this registration; "
                                        "start the sign-in again")
        if p["client_id"] != DYNAMIC_CLIENT and callback_client_id and callback_client_id != p["client_id"]:
            raise ProviderError("auth", "callback client_id does not match the registered client")
        prev = self._load() or {}
        if prev.get("client_id") != issued:
            # persist the registration before the exchange so a failed exchange does not register yet another client
            self._save({**prev, "client_id": issued})
        own = http is None
        http = http or httpx.AsyncClient(timeout=30)
        try:
            r = await http.post(TOKEN_URL, data={"grant_type": "authorization_code", "client_id": issued,
                                                 "code": code, "code_verifier": p["verifier"],
                                                 "redirect_uri": self.redirect_uri, "resource": RESOURCE})
            if r.status_code != 200:
                err = ""
                try:
                    err = r.json().get("error", "")
                except ValueError:
                    pass
                hint = " — the code was discarded; start the sign-in again" if err == "invalid_grant" else ""
                raise ProviderError("auth", f"token exchange failed: HTTP {r.status_code} {err or r.text[:200]}{hint}")
            tok = r.json()
            claims: dict[str, Any] = {}
            if tok.get("id_token"):
                claims = await verify_id_token(tok["id_token"], client_id=issued, nonce=p["nonce"], http=http)
        finally:
            if own:
                await http.aclose()
        scopes = set((tok.get("scope") or "").split())
        cred = {"client_id": issued, "access_token": tok["access_token"], "refresh_token": tok.get("refresh_token"),
                "expires_at": time.time() + int(tok.get("expires_in", 3600)), "scope": sorted(scopes),
                "earliest_refresh_at": tok.get("earliest_refresh_at"), "email": claims.get("email"),
                "can_use_plan": "chatgpt.tokens.use.direct" in scopes, "created_at": time.time(),
                "issuer": ISSUER, "host_id": self.host_id}
        self._save(cred)
        return {"email": cred["email"], "can_use_plan": cred["can_use_plan"], "scope": cred["scope"],
                "client_id": issued}

    async def access_token(self) -> str | None:
        cred = self._load()
        if not cred or not cred.get("access_token"):
            return None  # registered client but not (or no longer) signed in
        if not cred.get("can_use_plan"):
            raise ProviderError("unsupported", "grant lacks chatgpt.tokens.use.direct; use an OpenAI API key instead")
        if cred["expires_at"] - 120 > time.time():
            return cred["access_token"]
        async with self._refresh_lock:  # rotating refresh tokens: never race two refreshes
            cred = self._load() or cred
            if cred["expires_at"] - 120 > time.time():
                return cred["access_token"]
            async with httpx.AsyncClient(timeout=30) as http:
                r = await http.post(TOKEN_URL, data={"grant_type": "refresh_token", "client_id": cred["client_id"],
                                                     "refresh_token": cred["refresh_token"], "resource": RESOURCE})
            if r.status_code != 200:
                err = ""
                try:
                    err = r.json().get("error", "")
                except ValueError:
                    pass
                if err in TERMINAL_REFRESH_ERRORS or r.status_code in (400, 401):
                    cred["access_token"] = None
                    cred["reauth_required"] = True
                    self._save(cred)
                    raise ProviderError("auth", f"ChatGPT session expired ({err or r.status_code}); sign in again")
                raise ProviderError("unavailable", f"token refresh failed: HTTP {r.status_code}")
            tok = r.json()
            cred.update(access_token=tok["access_token"], refresh_token=tok.get("refresh_token", cred["refresh_token"]),
                        expires_at=time.time() + int(tok.get("expires_in", 3600)), reauth_required=False)
            self._save(cred)
            return cred["access_token"]

    async def revoke(self) -> None:
        cred = self._load()
        if cred and cred.get("refresh_token"):
            try:
                async with httpx.AsyncClient(timeout=20) as http:
                    disc = (await http.get(DISCOVERY_URL)).json()
                    if disc.get("revocation_endpoint"):
                        await http.post(disc["revocation_endpoint"], data={
                            "token": cred["refresh_token"], "token_type_hint": "refresh_token",
                            "client_id": cred["client_id"]})
            except httpx.HTTPError:
                pass
        if cred:  # keep the issued client_id for the next sign-in, drop tokens
            self._save({"client_id": cred.get("client_id"), "signed_out": True})


class SIWCAdapter(OpenAIResponsesAdapter):
    adapter_type = "openai_siwc"
    auth_modes = ["subscription"]
    subscription = True

    def __init__(self, provider_id: str, session: SIWCSession) -> None:
        super().__init__(provider_id, session.access_token)
        self.session = session

    async def test_connection(self):
        from nebula_providers.base import NOT_CONNECTED, REAUTH_REQUIRED, ProviderStatus

        cred = self.session.credential()
        if not cred or not cred.get("access_token"):
            state = REAUTH_REQUIRED if cred and cred.get("reauth_required") else NOT_CONNECTED
            return ProviderStatus(state, "Continue with ChatGPT to connect", billing="ChatGPT plan usage")
        st = await super().test_connection()
        st.account = {"email": cred.get("email"), "usage_url": USAGE_URL, "scope": cred.get("scope")}
        st.detail += f"; plan usage is shared with your other ChatGPT apps — see {USAGE_URL}"
        return st

    def estimate_cost_or_plan(self) -> dict[str, Any]:
        return {"billing": "subscription", "note": f"consumes your ChatGPT plan usage limits ({USAGE_URL}); "
                                                   "no reset time is inferred"}

    async def revoke(self, account_id: str = "") -> None:
        await self.session.revoke()
