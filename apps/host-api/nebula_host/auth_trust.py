"""Risk-based verification of sign-in pages and destinations (V3.3).

Every page the isolated broker reaches and every destination a sign-in wants to continue to gets one level:

* GREEN  — verified: the exact origin the agent asked for, or an exact host of a known identity provider that the
  requested service is known to use (built-in first-party relationships such as Teams -> login.microsoftonline.com,
  or a relationship the owner configured after a fresh verification). No warning, no extra question.
* YELLOW — not verified yet: the owner sees the exact hostname and confirms it.
* RED    — suspicious: a lookalike of a trusted host, a brand name on a foreign domain, plain HTTP on the internet,
  a public name that resolved to a private address (DNS rebinding), credentials leaving for another site. Credential
  submission is blocked; confirming in the sign-in dialog cannot override it. Lookalike/brand findings can only be
  cleared by the owner explicitly marking that exact origin as verified (fresh verification, audited); the
  transport findings never.

Matching is by exact hostname (and https) only — never by a substring such as "microsoft" in a domain.
"""

from __future__ import annotations

import re
import time
import unicodedata
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit

from nebula_host import db

GREEN, YELLOW, RED = "GREEN", "YELLOW", "RED"
LEVELS = (GREEN, YELLOW, RED)
HARD_REASONS = frozenset({"insecure_http", "private_address", "local_network", "credential_exfiltration",
                          "invalid_destination"})


@dataclass(frozen=True)
class Provider:
    id: str
    name: str
    auth_hosts: frozenset[str]  # the provider's sign-in service (exact hostnames)
    service_hosts: frozenset[str]  # the provider's own services that sign in there (exact hostnames)
    session_cookies: dict[str, tuple[str, ...]] = field(default_factory=dict)  # auth host -> sign-in cookie names
    first_party: bool = True  # same operator: the provider's sign-in session may be handed to the agent
    # sign-in hosts allowed from the start of a sign-in to this provider's services (V3.4): a flow that moves
    # between them (Microsoft: login.microsoftonline.com -> login.microsoft.com passkey bridge) must not be
    # blocked and resumed by a fresh GET — that restarted Microsoft's sign-in at the e-mail step (2026-11-22)
    preallow: tuple[str, ...] = ()

    @property
    def hosts(self) -> frozenset[str]:
        return self.auth_hosts | self.service_hosts


BUILTIN: tuple[Provider, ...] = (
    Provider("microsoft", "Microsoft",
             frozenset({"login.microsoftonline.com", "login.microsoft.com", "login.live.com", "login.windows.net",
                        "account.live.com"}),
             frozenset({"teams.microsoft.com", "teams.live.com", "teams.cloud.microsoft", "outlook.office.com",
                        "outlook.office365.com", "outlook.live.com", "www.office.com", "office.com",
                        "m365.cloud.microsoft", "www.microsoft365.com", "portal.office.com", "onedrive.live.com",
                        "admin.microsoft.com", "portal.azure.com", "dev.azure.com", "myaccount.microsoft.com",
                        "myapps.microsoft.com", "account.microsoft.com", "make.powerapps.com"}),
             {"login.microsoftonline.com": ("ESTSAUTH", "ESTSAUTHPERSISTENT"),
              "login.live.com": ("__Host-MSAAUTH", "MSPAuth")},
             preallow=("login.microsoftonline.com", "login.microsoft.com", "login.live.com")),
    Provider("google", "Google",
             frozenset({"accounts.google.com"}),
             frozenset({"mail.google.com", "drive.google.com", "docs.google.com", "calendar.google.com",
                        "meet.google.com", "chat.google.com", "contacts.google.com", "photos.google.com",
                        "myaccount.google.com", "admin.google.com", "workspace.google.com", "www.google.com",
                        "console.cloud.google.com", "www.youtube.com"}),
             # (__Host-GAPS is set before a sign-in already: never evidence)
             {"accounts.google.com": ("SID", "__Secure-1PSID", "LSID")}, preallow=("accounts.google.com",)),
    Provider("github", "GitHub", frozenset({"github.com"}), frozenset({"github.com", "gist.github.com"}),
             {"github.com": ("user_session", "__Host-user_session_same_site")}),
    Provider("apple", "Apple", frozenset({"idmsa.apple.com", "appleid.apple.com"}),
             frozenset({"www.icloud.com", "icloud.com", "appleid.apple.com", "account.apple.com",
                        "developer.apple.com", "appstoreconnect.apple.com"})),
)

# distinctive brand tokens (a whole label or a dash-separated part of one) -> official registrable domains
BRAND_TOKENS: dict[str, tuple[str, ...]] = {
    "microsoft": ("microsoft.com", "microsoftonline.com", "live.com", "office.com", "office365.com", "azure.com",
                  "microsoft365.com", "cloud.microsoft", "windows.net", "msftauth.net", "powerapps.com"),
    "microsoftonline": ("microsoftonline.com",), "msftauth": ("msftauth.net",), "office365": ("office365.com",),
    "google": ("google.com", "youtube.com", "gmail.com"), "gmail": ("gmail.com", "google.com"),
    "github": ("github.com",), "paypal": ("paypal.com",), "icloud": ("icloud.com", "apple.com"),
    "appleid": ("apple.com",),
}
# registrable-domain cores too generic to imply imitation on their own ("my-office.com", "windows-tips.com")
GENERIC_CORES = frozenset({"office", "windows", "live", "cloud", "account", "accounts", "login", "outlook", "teams"})
_CONFUSABLE = str.maketrans({
    "0": "o", "1": "l", "3": "e", "5": "s", "|": "l", "$": "s",
    # Cyrillic / Greek / IPA letters that render like Latin ones (the usual homograph set)
    "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "у": "y", "х": "x", "і": "i", "ј": "j", "ԁ": "d",
    "ѕ": "s", "һ": "h", "ӏ": "l", "ɡ": "g", "ο": "o", "α": "a", "ν": "v", "τ": "t", "κ": "k", "ι": "i",
    "ρ": "p", "υ": "u", "ɑ": "a", "ı": "i", "ⅼ": "l", "ｍ": "m"})


# ============================================================================ helpers
def host_of(origin: str | None) -> str:
    try:
        return (urlsplit(origin or "").hostname or "").lower().rstrip(".")
    except ValueError:
        return ""


def scheme_of(origin: str | None) -> str:
    try:
        return (urlsplit(origin or "").scheme or "").lower()
    except ValueError:
        return ""


def site_of(host: str) -> str:
    h = (host or "").lower().strip("[]").rstrip(".")
    if not h or re.match(r"^[\d.]+$", h) or ":" in h:
        return h
    parts = h.split(".")
    two = {"co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au", "co.jp", "co.nz", "com.br", "com.mx",
           "co.in", "co.za", "com.tr", "com.cn", "com.hk", "com.sg", "co.kr", "com.ar", "com.pl", "cloud.microsoft"}
    return ".".join(parts[-3:]) if len(parts) >= 3 and ".".join(parts[-2:]) in two else ".".join(parts[-2:])


def _skeleton(s: str) -> str:
    """Homoglyph-insensitive form: Unicode NFKD without marks, common digit/letter swaps, rn->m, vv->w."""
    try:
        s = s.encode("ascii").decode("idna") if "xn--" in s else s
    except (UnicodeError, ValueError):
        pass
    s = "".join(c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c)).lower()
    s = s.translate(_CONFUSABLE).replace("rn", "m").replace("vv", "w")
    return s


def _distance(a: str, b: str, cap: int = 3) -> int:
    if abs(len(a) - len(b)) > cap:
        return cap + 1
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i] + [0] * len(b)
        best = cur[0]
        for j, cb in enumerate(b, 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb))
            best = min(best, cur[j])
        if best > cap:
            return cap + 1
        prev = cur
    return prev[-1]


# ============================================================================ owner configuration
def settings() -> dict[str, Any]:
    s = db.get_setting("smart_auth_trust", {}) or {}
    return {"relationships": list(s.get("relationships") or []), "verified_sites": list(s.get("verified_sites") or [])}


def _https_origin(value: str) -> str:
    from nebula_host import vault as vaultmod

    try:
        o = vaultmod.canonical_origin(value)
    except vaultmod.VaultError as e:
        raise ValueError(str(e)) from None
    if not o.startswith("https://"):
        raise ValueError("only https origins can be trusted")
    return o


def add_relationship(service: str, idp: str, *, first_party: bool, actor: str) -> dict[str, Any]:
    from nebula_host.events import audit

    svc_o, idp_o = _https_origin(service), _https_origin(idp)
    if svc_o == idp_o:
        raise ValueError("the service and its sign-in provider must differ")
    for o in (svc_o, idp_o):
        lk = lookalike(host_of(o), ignore_owner=True)
        if lk:
            raise ValueError(f"{host_of(o)} imitates {lk}; it cannot be trusted")
    s = settings()
    rels = [r for r in s["relationships"] if not (r.get("service") == svc_o and r.get("idp") == idp_o)]
    rels.append({"service": svc_o, "idp": idp_o, "first_party": bool(first_party), "added_at": time.time(),
                 "added_by": actor})
    db.set_setting("smart_auth_trust", {**s, "relationships": rels[-50:]})
    audit(actor, "smart_auth.trust.relationship_added", None, {"service": svc_o, "idp": idp_o,
                                                               "first_party": bool(first_party)})
    return settings()


def remove_relationship(service: str, idp: str, *, actor: str) -> dict[str, Any]:
    from nebula_host.events import audit

    s = settings()
    rels = [r for r in s["relationships"] if not (r.get("service") == service and r.get("idp") == idp)]
    db.set_setting("smart_auth_trust", {**s, "relationships": rels})
    audit(actor, "smart_auth.trust.relationship_removed", None, {"service": service, "idp": idp})
    return settings()


def verify_site(origin: str, *, actor: str) -> dict[str, Any]:
    """The owner's explicit decision that this exact https origin is genuine (clears lookalike/brand findings for
    it — never transport findings)."""
    from nebula_host.events import audit

    o = _https_origin(origin)
    s = settings()
    sites = [x for x in s["verified_sites"] if x.get("origin") != o]
    sites.append({"origin": o, "added_at": time.time(), "added_by": actor})
    db.set_setting("smart_auth_trust", {**s, "verified_sites": sites[-100:]})
    audit(actor, "smart_auth.trust.site_verified", None, {"origin": o})
    return settings()


def unverify_site(origin: str, *, actor: str) -> dict[str, Any]:
    from nebula_host.events import audit

    s = settings()
    db.set_setting("smart_auth_trust", {**s, "verified_sites": [x for x in s["verified_sites"]
                                                                if x.get("origin") != origin]})
    audit(actor, "smart_auth.trust.site_unverified", None, {"origin": origin})
    return settings()


def _owner_verified(origin: str) -> bool:
    return any(x.get("origin") == origin for x in settings()["verified_sites"])


# ============================================================================ relationships
def provider_for(origin: str) -> Provider | None:
    if scheme_of(origin) != "https":
        return None
    h = host_of(origin)
    return next((p for p in BUILTIN if h in p.hosts), None)


def is_auth_host(origin: str) -> bool:
    """An identity provider's own sign-in host (exact, https)."""
    return scheme_of(origin) == "https" and any(host_of(origin) in p.auth_hosts for p in BUILTIN)


def relationship(requested_origin: str, other_origin: str) -> dict[str, Any] | None:
    """A verified link between the service the agent asked for and another origin of the same sign-in flow.
    Built-in: both exact hosts belong to the same provider — its sign-in hosts and its own services (V3.4 also
    service -> service, e.g. teams.microsoft.com -> teams.cloud.microsoft, which 2026-11-18 was shown as
    an unverified destination)."""
    if scheme_of(requested_origin) != "https" or scheme_of(other_origin) != "https":
        return None
    a, b = host_of(requested_origin), host_of(other_origin)
    if not a or not b:
        return None
    for p in BUILTIN:
        if a in p.hosts and b in p.hosts:
            return {"provider": p.id, "name": p.name, "source": "builtin", "first_party": p.first_party}
    for r in settings()["relationships"]:
        if {r.get("service"), r.get("idp")} == {requested_origin, other_origin}:
            return {"provider": "owner", "name": host_of(r.get("idp")), "source": "owner",
                    "first_party": bool(r.get("first_party"))}
    return None


def cookie_origins(requested_origin: str) -> list[str]:
    """Origins whose session may reach the agent besides the requested one: the auth hosts of a FIRST-PARTY
    provider relationship (Teams -> Microsoft sign-in). Third-party identity providers never."""
    out: list[str] = []
    p = provider_for(requested_origin)
    if p and p.first_party:
        out += [f"https://{h}" for h in sorted(p.auth_hosts) if f"https://{h}" != requested_origin]
    for r in settings()["relationships"]:
        if r.get("service") == requested_origin and r.get("first_party") and r.get("idp") not in out:
            out.append(r["idp"])
    return out[:4]


def preallowed(requested_origin: str) -> list[str]:
    """Exact sign-in hosts of the requested origin's built-in provider that a sign-in may reach without a stop
    (all of them are GREEN by the built-in relationship anyway)."""
    p = provider_for(requested_origin)
    if not p:
        return []
    return [f"https://{h}" for h in p.preallow if f"https://{h}" != requested_origin][:3]


def auth_origins(requested_origin: str) -> list[str]:
    """Every sign-in host of the requested origin's provider (built-in) or owner-made identity provider: pages there
    never count as a sign-in by generic evidence, only by the provider's own session cookie."""
    out: list[str] = []
    p = provider_for(requested_origin)
    if p:
        out += [f"https://{h}" for h in sorted(p.auth_hosts)]
    for r in settings()["relationships"]:
        if r.get("service") == requested_origin and r.get("idp") not in out:
            out.append(r["idp"])
    return out[:8]


def session_cookie_names(requested_origin: str) -> dict[str, list[str]]:
    p = provider_for(requested_origin)
    if not p:
        return {}
    return {f"https://{h}": list(v) for h, v in p.session_cookies.items()}


def _trusted_hosts(*, ignore_owner: bool = False) -> set[str]:
    hs: set[str] = set()
    for p in BUILTIN:
        hs |= p.hosts
    if not ignore_owner:
        s = settings()
        hs |= {host_of(r.get("idp")) for r in s["relationships"]} | {host_of(r.get("service"))
                                                                    for r in s["relationships"]}
    return {h for h in hs if h}


def lookalike(host: str, *, ignore_owner: bool = False) -> str | None:
    """The trusted host or brand this host imitates, if any (exact trusted hosts never match)."""
    h = (host or "").lower().rstrip(".")
    if not h:
        return None
    trusted = _trusted_hosts(ignore_owner=ignore_owner)
    if h in trusted:
        return None
    site = site_of(h)
    sk = _skeleton(h)
    for t in sorted(trusted):
        if site == site_of(t) and h.endswith("." + site_of(t)):
            continue  # another host of the same registrable domain is not a lookalike (it is just unverified)
        ts = _skeleton(t)
        if sk == ts or (len(t) >= 8 and _distance(sk, ts) <= 2):
            return t
        # the trusted name embedded in a foreign domain: login.microsoftonline.com.evil.io, login-microsoftonline.com
        flat, tflat = sk.replace("-", ".").replace("_", "."), ts.replace("-", ".")
        core = site_of(t).split(".")[0]
        embedded = tflat in flat and h != t and (core not in GENERIC_CORES or t.count(".") >= 2)
        if embedded or (len(core) >= 6 and core not in GENERIC_CORES and
                                          core in re.split(r"[.\-_]", sk) and site_of(h) != site_of(t)):
            return t
    tokens = set(re.split(r"[.\-_]", _skeleton(site)))
    for tok, official in BRAND_TOKENS.items():
        if tok in tokens and site not in official:
            return tok
    return None


# ============================================================================ classification
def _level(reasons: list[str]) -> str:
    if any(r in HARD_REASONS or r.startswith("lookalike") or r.startswith("brand_mismatch") for r in reasons):
        return RED
    return YELLOW if reasons else GREEN


def _result(reasons: list[str], rel: dict[str, Any] | None) -> dict[str, Any]:
    lvl = _level(reasons)
    return {"level": lvl, "reasons": sorted(set(reasons))[:8], "relationship": rel,
            "hard": any(r in HARD_REASONS for r in reasons)}


def classify_origin(requested_origin: str, origin: str, *, allow_local: bool,
                    transport: dict[str, Any] | None = None, owner_allowed: bool = False) -> dict[str, Any]:
    """Trust of an origin within one sign-in session (page or destination)."""
    from nebula_host.smart_auth import is_local_network_origin

    reasons: list[str] = []
    h = host_of(origin)
    if not h or scheme_of(origin) not in ("http", "https"):
        return _result(["invalid_destination"], None)
    local = is_local_network_origin(origin)
    if local and not allow_local:
        reasons.append("local_network")
    elif local:
        reasons.append("local_network_allowed")  # the owner allowed local-network sign-ins: still always reviewed
    if scheme_of(origin) == "http" and not local:
        reasons.append("insecure_http")
    if transport and not local and transport.get("ip") in ("private", "loopback"):
        reasons.append("private_address")  # a public name resolving into the local network: DNS rebinding
    if transport and scheme_of(origin) == "https" and transport.get("tls") is False:
        reasons.append("insecure_http")
    if not local and not _owner_verified(origin):
        lk = lookalike(h)
        if lk:
            reasons.append(f"lookalike:{lk}"[:40])
    if origin == requested_origin:
        return _result(reasons, None)
    rel = relationship(requested_origin, origin)
    if rel is None and not owner_allowed and not any(r in HARD_REASONS or r.startswith("lookalike")
                                                     for r in reasons):
        reasons.append("same_site_unverified" if site_of(h) == site_of(host_of(requested_origin))
                       else "unverified_destination")
    return _result(reasons, rel)


def classify_step(requested_origin: str, step: dict[str, Any], *, allow_local: bool,
                  owner_allowed: list[str]) -> dict[str, Any]:
    """Trust of the page the broker is on: its origin (relationship, transport), the detector's structural
    confidence (computed without origin flags) and the detector's suspicion flags."""
    from nebula_host.smart_auth import is_local_network_origin

    origin = step.get("page_origin") or ""
    owner_ok = origin in owner_allowed and origin != requested_origin
    base = classify_origin(requested_origin, origin, allow_local=allow_local, transport=step.get("transport"),
                           owner_allowed=owner_ok)
    reasons = list(base["reasons"])
    flags = set(step.get("flags") or [])
    for f in sorted(flags):
        if f.startswith("brand_mismatch") and not _owner_verified(origin):
            reasons.append(f[:40])
    if "plain_http" in flags and not is_local_network_origin(origin) and "insecure_http" not in reasons:
        reasons.append("insecure_http")
    action = step.get("action_origin")
    if flags & {"cross_site_form_action", "cross_origin_form_action"} and action and action != origin and \
            relationship(requested_origin, action) is None:
        reasons.append("credentials_to_other_site")
    if "third_party_frame" in flags:
        reasons.append("embedded_login")
    if "unexpected_recovery_code" in flags:
        reasons.append("unexpected_recovery_code")
    structure = step.get("structure") or step.get("confidence")
    if structure in ("LOW", "MEDIUM") or flags & {"multiple_password_forms", "ambiguous_identifier",
                                                   "hidden_password_field"}:
        reasons.append("unusual_form")
    if owner_ok and base["relationship"] is None:
        reasons.append("owner_confirmed_destination")
    return _result(reasons, base["relationship"])


def public_reason(reason: str) -> str:
    """Fixed owner-facing wording (never page text)."""
    if reason.startswith("lookalike:"):
        return f"The address imitates {reason.split(':', 1)[1]}"
    if reason.startswith("brand_mismatch:"):
        return f"The page claims to be {reason.split(':', 1)[1].title()}, but is not on its domain"
    return {"insecure_http": "The connection is not encrypted (http)",
            "private_address": "A public name points into your local network (possible DNS rebinding)",
            "local_network": "The address is in your local network",
            "local_network_allowed": "An address in your local network (allowed in Smart sign-in settings)",
            "credential_exfiltration": "The page tried to send your details to another site",
            "invalid_destination": "The destination address is invalid",
            "unverified_destination": "This site is not a verified sign-in provider for the service",
            "same_site_unverified": "Another address of the same website (not verified)",
            "credentials_to_other_site": "The form sends your details to another site",
            "embedded_login": "The sign-in is embedded from another site",
            "unusual_form": "The sign-in form looks unusual",
            "unexpected_recovery_code": "A recovery code is requested unexpectedly",
            "owner_confirmed_destination": "You allowed this address earlier in this sign-in"}.get(
        reason, reason.replace("_", " "))
