"""NEBULA Smart Authentication — deterministic sign-in step detection (V3.2.1, state-aware since V3.3).

Standalone on purpose (standard library only): the isolated login broker (`vault_auth.py`, run as the
`nebula-vault` user with `python -I`) loads this file by path after checking that it is root-owned, and the agent's
tool server imports it for *advisory* hints. Nothing here reads input values: `DETECT_JS` collects structural facts
(input types, names, autocomplete tokens, labels, form action origins, iframes, short visible texts) and `classify`
turns them into a sign-in step description.

Trust model
-----------
* Page text is untrusted. It is used only to choose between non-secret step kinds (e.g. "SMS code" vs "authenticator
  code", "approve on your device") and to raise suspicion flags — never as a label shown to the owner as fact and
  never as a service identity. The owner UI shows fixed, role-based labels and the verified origin.
* The trusted classification is the one computed by the broker in its OWN isolated browser. A hint computed in an
  agent's browser is advisory only (the agent controls that browser).
* Confidence: HIGH = standard form with explicit types/autocomplete on the verified origin; MEDIUM = recognised by
  heuristics (names/labels) or a partly unusual layout; LOW = suspicious (brand on the wrong domain, credentials sent
  to another site, embedded third-party login, unexpected recovery-code request). MEDIUM/LOW need owner review.
"""

from __future__ import annotations

import hashlib
import math
import re
from typing import Any
from urllib.parse import urlsplit

# ------------------------------------------------------------------ in-page collector (structure only, no values)
DETECT_JS = r"""
(mark) => {
  const txt = (s, n) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const visible = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none') return false;
    if (r.bottom < -20 || r.right < -20 || r.left > innerWidth + 20 || r.top > innerHeight * 4) return false;
    if (el.closest && el.closest('[aria-hidden="true"],[hidden],[inert]')) return false;
    // effective opacity: a view fading in/out (single-page sign-in transitions) is not yet / no longer the step
    let op = 1, n = el;
    for (let k = 0; n && n.nodeType === 1 && k < 12; k++, n = n.parentElement) {
      op *= parseFloat(getComputedStyle(n).opacity || '1');
      if (op < 0.1) return false;
    }
    return true;
  };
  const labelOf = (el) => {
    let t = el.getAttribute('aria-label') || '';
    if (!t && el.labels && el.labels.length) t = el.labels[0].innerText || '';
    if (!t) {
      const root = el.getRootNode && el.getRootNode().getElementById ? el.getRootNode() : document;
      const lb = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean).slice(0, 3);
      t = lb.map(id => { const l = root.getElementById(id); return l ? (l.innerText || '') : ''; }).join(' ');
    }
    if (!t) t = el.getAttribute('placeholder') || el.getAttribute('title') || '';
    return txt(t, 80);
  };
  const originOf = (u) => { try { return new URL(u, location.href).origin; } catch (e) { return ''; } };
  // open shadow roots (web-component sign-in forms): read like the document itself; closed roots stay unreadable
  const roots = [document];
  for (let r = 0; r < roots.length && roots.length < 30; r++) {
    for (const h of roots[r].querySelectorAll('*')) {
      if (h.shadowRoot && roots.length < 30) roots.push(h.shadowRoot);
    }
  }
  const deep = (sel) => roots.flatMap(r => Array.from(r.querySelectorAll(sel)));
  if (mark) {  // markers of an earlier reading never point at elements of this one
    for (const e of deep('[data-nebula-auth]')) e.removeAttribute('data-nebula-auth');
    for (const e of deep('[data-nebula-click]')) e.removeAttribute('data-nebula-click');
  }
  const forms = deep('form').slice(0, 25);
  const inputs = [];
  let i = 0;
  const SKIP = ['hidden', 'submit', 'button', 'image', 'reset', 'file', 'checkbox', 'radio', 'range', 'color'];
  for (const el of deep('input, textarea')) {
    if (inputs.length >= 80) break;
    const type = ((el.getAttribute('type') || (el.tagName === 'INPUT' ? 'text' : 'textarea')) + '').toLowerCase();
    if (SKIP.includes(type)) continue;
    const id = 'f' + (i++);
    if (mark) el.setAttribute('data-nebula-auth', id);
    inputs.push({id, type, name: txt(el.getAttribute('name'), 60), elid: txt(el.id, 60),
      ac: txt(el.getAttribute('autocomplete'), 80).toLowerCase(), im: txt(el.getAttribute('inputmode'), 20).toLowerCase(),
      maxlength: (el.maxLength > 0 && el.maxLength < 1000) ? el.maxLength : null,
      pattern: txt(el.getAttribute('pattern'), 40), label: labelOf(el), visible: visible(el),
      form: el.form ? forms.indexOf(el.form) : -1, disabled: !!el.disabled, readonly: !!el.readOnly,
      invalid: el.getAttribute('aria-invalid') === 'true',
      group: el.parentElement && el.parentElement.parentElement ? (el.parentElement.parentElement.childElementCount || 0) : 0});
  }
  const fs = forms.map((f, k) => ({i: k, action: f.getAttribute('action') ? originOf(f.action) : '',
    action_path: (() => { try { return new URL(f.action, location.href).pathname.slice(0, 80); } catch (e) { return ''; } })(),
    method: (f.getAttribute('method') || 'get').toLowerCase(), visible: visible(f)}));
  const frames = Array.from(document.querySelectorAll('iframe')).slice(0, 20).map(f => ({
    origin: f.getAttribute('src') ? originOf(f.src) : '', visible: visible(f),
    captcha: /recaptcha|hcaptcha|challenges\.cloudflare\.com|turnstile|arkoselabs|funcaptcha|geetest/i.test(f.getAttribute('src') || '')}));
  const captchaEl = Array.from(document.querySelectorAll(
    '.g-recaptcha,.h-captcha,#cf-turnstile,.cf-turnstile,[data-sitekey],[data-hcaptcha-widget-id]')).some(visible);
  const heads = deep('h1,h2,legend,[role=heading]').filter(visible).slice(0, 4)
    .map(h => txt(h.innerText, 120));
  let ci = 0;
  const clickables = deep('button,a,input[type=submit],input[type=button],[role=button],[role=link]')
    .filter(visible).slice(0, 60).map(b => {
      const id = 'c' + (ci++);
      if (mark) b.setAttribute('data-nebula-click', id);
      return {id, t: txt(b.innerText || b.value || b.getAttribute('aria-label') || '', 60),
        href: b.tagName === 'A' && b.getAttribute('href') ? originOf(b.href) : '',
        submit: (b.tagName === 'BUTTON' && (!b.getAttribute('type') || b.getAttribute('type') === 'submit')) ||
          (b.tagName === 'INPUT' && b.type === 'submit')};
    });
  const alerts = deep(
    '[role=alert],[aria-live],.error,.errors,.flash-error,.alert,.alert-danger,[class*="error" i],[class*="invalid" i]')
    .filter(visible).slice(0, 12).map(a => txt(a.innerText, 160)).filter(Boolean);
  // a same-origin sign-out link/form anywhere (menus are often closed): evidence of a signed-in page
  const outRx = /\/(log-?out|sign-?out|logoff|odhlasit)(\/|\.|$|\?)/i;
  const sameOut = (u) => { try { const x = new URL(u, location.href); return x.origin === location.origin && outRx.test(x.pathname); } catch (e) { return false; } };
  const logoutLink = deep('a[href]').slice(0, 400).some(a => sameOut(a.getAttribute('href'))) ||
    deep('form[action]').some(f => sameOut(f.getAttribute('action')));
  // number-matching approval ("enter 42 in your app"): a large stand-alone 2-3 digit number
  const approval = deep('div,span,p,strong,b,h1,h2,h3,[role=heading]').slice(0, 1500).filter(e =>
    e.childElementCount === 0 && /^\d{2,3}$/.test((e.textContent || '').trim()) && visible(e) &&
    parseFloat(getComputedStyle(e).fontSize || '0') >= 20).slice(0, 2).map(e => e.textContent.trim());
  const api = window.__nebulaObs;
  const ob = api && typeof api.snap === 'function' ? api.snap() : null;
  const wa = ob && ob.wa ? {op: ob.wa.op, transports: (ob.wa.transports || []).slice(0, 6),
    discoverable: !!ob.wa.discoverable, attachment: ob.wa.attachment || null,
    age_ms: Math.round(performance.now() - ob.wa.at)} : null;
  return {url: location.href, origin: location.origin, title: txt(document.title, 120), headings: heads,
    inputs, forms: fs, frames, captcha_el: captchaEl, clickables, alerts, logout_link: logoutLink,
    approval_number: approval.length === 1 ? approval[0] : null, shadow_roots: roots.length - 1,
    logout_visible: deep('a[href]').slice(0, 400).some(a => sameOut(a.getAttribute('href')) && visible(a)),
    observed: !!ob, quiet_ms: ob ? Math.round(performance.now() - ob.t) : null, mutations: ob ? ob.m : null,
    wa_pending: wa,
    webauthn: !!document.querySelector('input[autocomplete*="webauthn" i]'),
    animating: document.getAnimations ? document.getAnimations().filter(a => a.playState === 'running' &&
      !(a.effect && a.effect.getTiming && a.effect.getTiming().iterations === Infinity)).length : 0,
    busy: !!Array.from(document.querySelectorAll('[aria-busy="true"],[role=progressbar]')).some(visible),
    ready: document.readyState,
    text: txt(document.body ? document.body.innerText : '', 4000)};
}
"""

# ------------------------------------------------------------------ page observer (V3.4, installed before page scripts)
# Two facts no single DOM read can give:
# * when the page last changed (MutationObserver): a step is read only after the DOM has been quiet for a moment, so a
#   view that is still being swapped (e-mail -> password without a navigation) is never taken as the current step;
# * whether the page is waiting for a passkey / security key (a modal WebAuthn request). The native API is NOT
#   replaced, hidden or answered: requests go to the browser unchanged, so the site learns the browser's real
#   capabilities (this isolated browser has no platform authenticator, no USB/NFC key and no Bluetooth). The only
#   added ability is the user's own "Cancel" — rejecting the pending request with NotAllowedError, exactly what the
#   browser reports when a person closes the passkey dialog — which a headless browser cannot otherwise show.
OBSERVE_JS = r"""
(() => {
  const NAME = '__nebulaObs';
  if (Object.prototype.hasOwnProperty.call(window, NAME)) return;
  // all state lives in this closure; the page sees only a frozen read API (it cannot forge a pending request,
  // replace the cancel function or poison the timings)
  let m = 0, t = performance.now(), wa = null, cancel = null;
  const api = Object.freeze({
    snap: () => Object.freeze({m, t, wa: wa ? Object.freeze(Object.assign({}, wa)) : null}),
    cancel: () => { if (cancel) { cancel(); return true; } return false; },
  });
  Object.defineProperty(window, NAME, {value: api, enumerable: false, configurable: false, writable: false});
  try {
    // NEBULA's own field/button markers (data-nebula-*) are not changes of the page
    new MutationObserver((list) => {
      let k = 0;
      for (const r of list) {
        if (!(r.type === 'attributes' && r.attributeName && r.attributeName.startsWith('data-nebula'))) k++;
      }
      if (k) { m += k; t = performance.now(); }
    })
      .observe(document, {subtree: true, childList: true, attributes: true, characterData: true});
  } catch (e) {}
  const C = navigator.credentials;
  if (!C || typeof C.get !== 'function') return;
  const wrap = (orig, op) => new Proxy(orig, {apply(target, self, args) {
    const o = args[0] || {};
    const pk = o.publicKey;
    if (!pk || o.mediation === 'conditional') return Reflect.apply(target, self, args);
    const ac = new AbortController();
    if (o.signal) {
      if (o.signal.aborted) ac.abort(o.signal.reason);
      else o.signal.addEventListener('abort', () => ac.abort(o.signal.reason), {once: true});
    }
    const creds = Array.isArray(pk.allowCredentials) ? pk.allowCredentials : [];
    const transports = [...new Set(creds.flatMap(c => Array.isArray(c.transports) ? c.transports : []))];
    const mine = {op, at: performance.now(), transports: transports.map(String).slice(0, 6),
      discoverable: creds.length === 0,
      attachment: (pk.authenticatorSelection && String(pk.authenticatorSelection.authenticatorAttachment || '')) || null};
    wa = mine;
    cancel = () => ac.abort(new DOMException('The operation either timed out or was not allowed.', 'NotAllowedError'));
    const done = () => { if (wa === mine) { wa = null; cancel = null; } t = performance.now(); };
    const p = Reflect.apply(target, self, [Object.assign({}, o, {signal: ac.signal})]);
    p.then(done, done);
    return p;
  }});
  try {
    C.get = wrap(C.get, 'get');
    if (typeof C.create === 'function') C.create = wrap(C.create, 'create');
  } catch (e) {}
})();
"""

# ------------------------------------------------------------------ vocabulary (EN + CS; untrusted text, hints only)
_I = re.IGNORECASE
LOGIN_WORDS = re.compile(r"sign[ -]?in|log[ -]?in|login|log on|p[řr]ihl[aá][sš]|anmelden|connexion|"
                         r"iniciar sesi[oó]n|authenticat|continue with (e-?mail|password)", _I)
OTP_HINT = re.compile(r"\botp\b|totp|one[- ]?time|verification[ _-]?code|verify[ _-]?code|security[ _-]?code|"
                      r"auth(entication)?[ _-]?code|2fa|mfa|two[- ]?(factor|step)|sms[ _-]?code|\bcode\b|\bpin\b|"
                      r"ov[eě][řr]ovac|jednor[aá]zov|k[oó]d", _I)
RECOVERY_HINT = re.compile(r"recovery[ _-]?code|backup[ _-]?code|z[aá]lo[žz]n[ií] k[oó]d|obnovovac", _I)
EMAIL_HINT = re.compile(r"e-?mail", _I)
PHONE_HINT = re.compile(r"phone|mobile|\btel\b|telefon|msisdn", _I)
USER_HINT = re.compile(r"user|login|account|identifier|\bid\b|u[žz]ivatel|jm[eé]no|signin", _I)
SEARCH_HINT = re.compile(r"search|query|hledat|vyhled", _I)
SMS_WORDS = re.compile(r"\bsms\b|text message|texted|sent to (your )?(phone|mobile|number)|phone number ending|"
                       r"ending in \d|zasl[aá]n.{0,20}(telefon|mobil)|k[oó]d z sms", _I)
EMAIL_WORDS = re.compile(r"(sent|emailed|mailed).{0,40}(e-?mail|inbox)|check your (e-?mail|inbox)|"
                         r"in your (e-?mail|inbox)|e-?mail(em)? (jsme )?(poslali|odeslali)|zkontrolujte (e-?mail|schr)", _I)
TOTP_WORDS = re.compile(r"authenticator|authentication app|auth app|totp|google authenticator|"
                        r"aplikac[ei] (pro )?(ov[eě][řr]|autentiz)", _I)
DEVICE_WORDS = re.compile(r"approve (the |this |your )?(sign[- ]?in|request|login)|check your (phone|device)|"
                          r"we sent a (notification|push|prompt)|push notification|open the .{0,30} app|"
                          r"confirm (it'?s|it is) you|tap (yes|approve)|waiting for (approval|confirmation)|"
                          r"potvr[dď]te (p[řr]ihl[aá][sš]en[ií]|v aplikaci)|schvalte", _I)
PASSKEY_WORDS = re.compile(r"passkey|security key|use your (fingerprint|face|screen lock)|webauthn|"
                           r"face, fingerprint, pin|p[řr][ií]stupov[ýy] kl[ií][čc]|bezpe[čc]nostn[ií] kl[ií][čc]", _I)
SECURITY_KEY_WORDS = re.compile(r"security key|usb key|fido2? key|hardware key|yubikey|bezpe[čc]nostn[ií] kl[ií][čc]", _I)
PASSKEY_ONLY_WORDS = re.compile(r"passkey|fingerprint|face id|windows hello|screen lock|p[řr][ií]stupov[ýy] kl[ií][čc]",
                                _I)
KEY_TRANSPORTS = frozenset({"usb", "nfc", "ble", "smart-card"})
CAPTCHA_WORDS = re.compile(r"captcha|i'?m not a robot|verify (that )?(you are|you're) (a )?human|nejsem robot", _I)
ERROR_WORDS = re.compile(r"incorrect|invalid|wrong|didn'?t match|does not match|try again|not recognized|"
                         r"expired|nespr[aá]vn|neplatn|chybn|vypr[sš]el", _I)
SIGNED_IN_AS = re.compile(r"(signed|logged) in as|p[řr]ihl[aá][sš]en[aáoýi]? (jako|u[žz]ivatel)", _I)
LOGOUT_WORDS = re.compile(r"^(sign out|sign-out|log out|logout|log off|odhl[aá]sit( se)?|odhl[aá][sš]en[ií])$", _I)
SIGNIN_LINK = re.compile(r"^(sign in|log in|login|p[řr]ihl[aá]sit( se)?|p[řr]ihl[aá][sš]en[ií])$", _I)
ACTION_LOGIN = re.compile(r"login|signin|sign_in|session|auth|logon", _I)
# other ways to finish the current step (page text is untrusted: only the KIND reaches the owner, as a fixed label)
ALT_PASSWORD = re.compile(r"^(use|enter|sign in with|try) (your |a |my )?password( instead)?$|^use (my |your )?password$|"
                          r"^(použ[ií]t|zadat) heslo$", _I)
ALT_CODE = re.compile(r"(send|text|email|get|use|enter) (me )?(a |an )?(verification |security |one[- ]time |sms )?code|"
                      r"^text me$|^send (an )?sms$|^i have a code$|ov[eě][řr]ovac[ií] k[oó]d|"
                      r"^(text|call|sms) \+?[\dx*•· ()-]{4,}$", _I)
ALT_APP = re.compile(r"^(approve|use) .{0,50}(authenticator|app)( instead)?$|^send (a )?(notification|push)", _I)
ALT_MORE = re.compile(r"^(other ways to sign in|sign[- ]in options|sign in another way|try another way|more options|"
                      r"use another (method|option|way)|i can'?t use .{0,40}|choose (a |another )?(different )?"
                      r"(method|way)|jin[ýy] zp[ůu]sob.{0,20})$", _I)
# interstitials NEBULA may answer itself, always with the choice that changes nothing (no persistence, no new
# security method, nothing enrolled)
KMSI_WORDS = re.compile(r"stay signed in\??|keep me signed in|remember (me|this (device|browser))|z[ůu]stat p[řr]ihl[aá][sš]en", _I)
NAG_WORDS = re.compile(r"(set up|add|create|register) .{0,30}(authenticator|security info|passkey|recovery|backup)|"
                       r"keep your account secure|protect your account|more information required|"
                       r"(save|use) (a )?passkey", _I)
DECLINE_BUTTON = re.compile(r"^(no|not now|skip( for now)?|ask (me )?later|remind me later|maybe later|"
                            r"ne|te[ďd] ne|p[řr]esko[čc]it|pozd[eě]ji)$", _I)

# brands whose name on a page is checked against the page's registrable domain (lookalike / phishing pages)
BRANDS: dict[str, tuple[str, ...]] = {
    "github": ("github.com",), "gitlab": ("gitlab.com",), "google": ("google.com", "youtube.com", "gmail.com"),
    "gmail": ("google.com", "gmail.com"), "microsoft": ("microsoft.com", "live.com", "microsoftonline.com",
                                                          "office.com", "outlook.com", "xbox.com"),
    "outlook": ("live.com", "outlook.com", "microsoft.com", "office.com"), "apple": ("apple.com", "icloud.com"),
    "icloud": ("apple.com", "icloud.com"), "facebook": ("facebook.com", "fb.com", "meta.com"),
    "instagram": ("instagram.com",), "paypal": ("paypal.com",), "amazon": ("amazon.com", "amazon.de", "amazon.co.uk",
                                                                             "amazon.fr", "amazon.it", "amazon.es"),
    "netflix": ("netflix.com",), "linkedin": ("linkedin.com",), "dropbox": ("dropbox.com",), "slack": ("slack.com",),
    "atlassian": ("atlassian.com", "atlassian.net"), "coinbase": ("coinbase.com",), "binance": ("binance.com",),
    "revolut": ("revolut.com",), "seznam": ("seznam.cz",), "openai": ("openai.com", "chatgpt.com"),
    "anthropic": ("anthropic.com", "claude.ai"),
}
_DIGITS_PATTERN = re.compile(r"(\\d|\[0-9\])([*+]|\{\d{1,2}(,\d{0,2})?\})?")
_BRAND_RE = re.compile(r"\b(" + "|".join(BRANDS) + r")\b", _I)
_MULTI_SUFFIX = {"co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au", "co.jp", "co.nz", "com.br",
                 "com.mx", "co.in", "co.za", "com.tr", "com.cn", "com.hk", "com.sg", "co.kr", "com.ar", "com.pl"}

IDENTIFIER_ROLES = ("email", "phone", "username", "username_or_email")
SECRET_ROLES = ("password", "otp", "recovery_code")
STEP_KINDS = ("identifier", "identifier_password", "password", "otp", "recovery_code", "device_approval", "passkey",
              "security_key", "captcha", "embedded_login", "new_password", "method_choice", "interstitial", "unknown",
              "authenticated", "none")
ALT_KINDS = ("password", "code", "app", "more")
MANUAL_STEPS = ("captcha", "passkey", "security_key", "embedded_login", "new_password")


def webauthn_kind(wa: dict[str, Any] | None, text: str = "") -> str:
    """passkey vs physical security key, from the pending request's hints (transports, attachment) and, failing
    that, the page's wording."""
    if wa:
        tr = {str(t) for t in wa.get("transports") or []}
        if tr and tr <= KEY_TRANSPORTS:
            return "security_key"
        if not tr and wa.get("attachment") == "cross-platform" and not PASSKEY_ONLY_WORDS.search(text):
            return "security_key"
        if not tr and SECURITY_KEY_WORDS.search(text) and not PASSKEY_ONLY_WORDS.search(text):
            return "security_key"
        return "passkey"
    return "security_key" if SECURITY_KEY_WORDS.search(text) and not PASSKEY_ONLY_WORDS.search(text) else "passkey"


def site_of(host: str) -> str:
    """Registrable-domain approximation (no public-suffix download): last two labels, three for known 2-level
    suffixes. IP addresses and single labels are returned as they are."""
    h = (host or "").lower().strip("[]").rstrip(".")
    if not h or re.match(r"^[\d.]+$", h) or ":" in h:
        return h
    parts = h.split(".")
    if len(parts) >= 3 and ".".join(parts[-2:]) in _MULTI_SUFFIX:
        return ".".join(parts[-3:])
    return ".".join(parts[-2:])


_PRIVATE_SUFFIXES = (".local", ".test", ".internal", ".lan", ".home.arpa", ".localhost")


def _private_host(host: str) -> bool:
    import ipaddress

    h = (host or "").strip("[]")
    if h == "localhost" or h.endswith(_PRIVATE_SUFFIXES):
        return True
    try:
        ip = ipaddress.ip_address(h)
    except ValueError:
        return False
    return ip.is_private or ip.is_loopback or ip.is_link_local


def origin_of(url: str) -> str:
    try:
        p = urlsplit(url or "")
        port = p.port
    except ValueError:
        return ""
    scheme = (p.scheme or "").lower()
    host = (p.hostname or "").lower().rstrip(".")
    if scheme not in ("http", "https") or not host:
        return ""
    default = 443 if scheme == "https" else 80
    hostpart = f"[{host}]" if ":" in host else host
    return f"{scheme}://{hostpart}" + (f":{port}" if port and port != default else "")


def host_of(origin: str) -> str:
    return (urlsplit(origin or "").hostname or "").lower()


# ------------------------------------------------------------------ classification
def _hint(inp: dict[str, Any]) -> str:
    return " ".join(str(inp.get(k) or "") for k in ("name", "elid", "label"))


def field_role(inp: dict[str, Any]) -> tuple[str, bool]:
    """(role, explicit) — explicit means typed by `type`/`autocomplete`, not guessed from names/labels."""
    t = (inp.get("type") or "text").lower()
    ac = set((inp.get("ac") or "").replace(",", " ").split())
    hint = _hint(inp)
    if t == "password":
        return ("new_password", True) if "new-password" in ac else ("password", True)
    if "one-time-code" in ac:
        return "otp", True
    if RECOVERY_HINT.search(hint):
        return "recovery_code", False
    if t in ("search",) or (SEARCH_HINT.search(hint) and not (ac & {"username", "email"})):
        return "search", True
    if t == "email" or "email" in ac:
        if USER_HINT.search(inp.get("label") or "") and EMAIL_HINT.search(inp.get("label") or ""):
            return "username_or_email", True
        return "email", True
    if t == "tel" or any(a.startswith("tel") for a in ac):
        if OTP_HINT.search(hint) and not PHONE_HINT.search(hint):
            return "otp", False
        return "phone", True
    if "username" in ac:
        return ("username_or_email", True) if EMAIL_HINT.search(hint) else ("username", True)
    if t in ("text", "number", "textarea", "") and OTP_HINT.search(hint) and not USER_HINT.search(hint) and \
            not EMAIL_HINT.search(hint):
        return "otp", False
    if EMAIL_HINT.search(hint) and USER_HINT.search(hint):
        return "username_or_email", False
    if EMAIL_HINT.search(hint):
        return "email", False
    if PHONE_HINT.search(hint):
        return "phone", False
    if USER_HINT.search(hint):
        return "username", False
    return "other", False


def _usable(inp: dict[str, Any]) -> bool:
    return bool(inp.get("visible")) and not inp.get("disabled") and not inp.get("readonly")


def alternatives(clickables: list[dict[str, Any]]) -> list[dict[str, str]]:
    """Other ways to finish the step offered by the page (one per kind; the id is the broker's own marking)."""
    out: dict[str, str] = {}
    for c in clickables or []:
        t = (c.get("t") or "").strip()
        cid = str(c.get("id") or "")
        if not t or not re.fullmatch(r"c\d{1,3}", cid) or (c.get("href") and c.get("href") != c.get("_page")):
            continue
        for kind, rx in (("password", ALT_PASSWORD), ("code", ALT_CODE), ("app", ALT_APP), ("more", ALT_MORE)):
            if kind not in out and rx.search(t):
                out[kind] = cid
                break
    return [{"id": v, "kind": k} for k, v in out.items()]


def fingerprint(step: dict[str, Any], facts: dict[str, Any]) -> str:
    """Stable identity of 'the same step on the same page' (loop detection, stale dialogs); no values, no text."""
    try:
        path = urlsplit(facts.get("url") or "").path
    except ValueError:
        path = ""
    key = "|".join([step.get("step") or "", step.get("page_origin") or "", path[:120],
                    ",".join(f.get("role") or "" for f in step.get("fields") or []),
                    ",".join(sorted(a["kind"] for a in step.get("alternatives") or [])),
                    (step.get("interstitial") or {}).get("kind") or ""])
    return hashlib.sha256(key.encode()).hexdigest()[:16]


def _otp_meta(inputs: list[dict[str, Any]], text: str) -> dict[str, Any]:
    if TOTP_WORDS.search(text):
        channel = "totp"
    elif SMS_WORDS.search(text):
        channel = "sms"
    elif EMAIL_WORDS.search(text):
        channel = "email"
    else:
        channel = "unknown"
    numeric = all(i.get("im") == "numeric" or i.get("type") in ("tel", "number") or
                  bool(_DIGITS_PATTERN.fullmatch(i.get("pattern") or "")) for i in inputs)
    if len(inputs) > 1:
        length: int | None = len(inputs)
    else:
        i = inputs[0]
        m = re.search(r"\{(\d{1,2})\}", i.get("pattern") or "")
        length = int(m.group(1)) if m else (i.get("maxlength") if i.get("maxlength") and i["maxlength"] <= 12 else None)
    return {"channel": channel, "length": length, "charset": "numeric" if numeric else "alphanumeric"}


def _otp_boxes(cands: list[dict[str, Any]]) -> list[dict[str, Any]] | None:
    """4-8 visible single-character inputs in one form/container = one verification code split over boxes."""
    singles = [i for i in cands if i.get("maxlength") == 1 and (i.get("type") in ("text", "tel", "number", "password")
                                                                 or i.get("im") == "numeric")]
    if not 4 <= len(singles) <= 8:
        return None
    if len({i.get("form") for i in singles}) != 1:
        return None
    return singles


def classify(facts: dict[str, Any], *, requested_origin: str | None = None,
             previous: dict[str, Any] | None = None) -> dict[str, Any]:
    """Facts from DETECT_JS -> {step, confidence, flags, fields, otp, page_origin, action_origin, error}."""
    page_origin = origin_of(facts.get("url") or "") or (facts.get("origin") or "")
    text = " ".join([facts.get("title") or "", *(facts.get("headings") or []), facts.get("text") or ""])[:6000]
    buttons = [c.get("t") or "" for c in (facts.get("clickables") or [])]
    flags: list[str] = []
    out: dict[str, Any] = {"step": "none", "confidence": "HIGH", "flags": flags, "fields": [], "otp": None,
                           "page_origin": page_origin, "action_origin": None, "error": False, "login_context": False,
                           "alternatives": [], "interstitial": None, "webauthn": None, "approval_number": None,
                           "signout": None}
    wa = facts.get("wa_pending") if isinstance(facts.get("wa_pending"), dict) else None
    inputs = [i for i in (facts.get("inputs") or []) if isinstance(i, dict)]
    for i in inputs:
        i["role"], i["explicit"] = field_role(i)
    usable = [i for i in inputs if _usable(i)]
    forms = {f.get("i"): f for f in (facts.get("forms") or []) if isinstance(f, dict)}
    login_ctx = bool(LOGIN_WORDS.search(SIGNED_IN_AS.sub(" ", " ".join([facts.get("title") or "",
                                                                       *(facts.get("headings") or []),
                                                                       *buttons[:20]])))) or \
        any(ACTION_LOGIN.search(f.get("action_path") or "") for f in forms.values()) or \
        any(i["role"] in ("password", "username") and i["explicit"] for i in usable) or bool(facts.get("webauthn")) or \
        any(i["role"] == "password" and i.get("visible") for i in inputs)  # e.g. disabled while the site is busy
    out["login_context"] = login_ctx
    # sign-in wording on the page itself (title, headings, buttons) or a visible password field — unlike
    # login_context this ignores form action paths (a signed-in app may well post to /session/…)
    wording = bool(LOGIN_WORDS.search(SIGNED_IN_AS.sub(" ", " ".join([facts.get("title") or "",
                                                                     *(facts.get("headings") or []),
                                                                     *buttons[:20]])))) or \
        any(i["role"] == "password" and i.get("visible") for i in inputs)
    out["login_wording"] = wording
    prev_step = (previous or {}).get("step")
    alerts = " ".join(facts.get("alerts") or [])
    out["error"] = bool(ERROR_WORDS.search(alerts))
    clicks = [{**c, "_page": page_origin} for c in (facts.get("clickables") or []) if isinstance(c, dict)]
    alts = alternatives(clicks)

    # suspicion that does not depend on the step
    page_host = host_of(page_origin)
    page_site = site_of(page_host)
    claim = " ".join([facts.get("title") or "", *(facts.get("headings") or [])])
    for m in {x.lower() for x in _BRAND_RE.findall(claim)}:
        if page_site not in BRANDS[m]:
            flags.append(f"brand_mismatch:{m}")
    if requested_origin and page_origin and page_origin != requested_origin:
        flags.append("origin_changed" if site_of(host_of(requested_origin)) == page_site else "other_site")
    if page_origin.startswith("http://") and not _private_host(page_host):
        flags.append("plain_http")  # (NEBULA allows http only for local/private hosts anyway)

    captcha = bool(facts.get("captcha_el")) or any(f.get("captcha") and f.get("visible")
                                                   for f in facts.get("frames") or [])
    pw = [i for i in usable if i["role"] == "password"]
    newpw = [i for i in usable if i["role"] == "new_password"]
    otp = [i for i in usable if i["role"] == "otp"]
    boxes = _otp_boxes(usable) if not pw else None
    rec = [i for i in usable if i["role"] == "recovery_code"]
    ident = [i for i in usable if i["role"] in IDENTIFIER_ROLES]
    hidden_pw = [i for i in inputs if i["role"] == "password" and not _usable(i)]

    def field(i: dict[str, Any]) -> dict[str, Any]:
        role = i["role"]
        inp = {"email": "email", "phone": "tel", "password": "password", "otp": "code", "recovery_code": "code"}.get(
            role, "text")
        return {"id": i["id"], "role": role, "input": inp}

    def form_of(i: dict[str, Any]) -> dict[str, Any] | None:
        return forms.get(i.get("form")) if i.get("form", -1) >= 0 else None

    chosen: list[dict[str, Any]] = []
    if captcha:
        out["step"] = "captcha"
    elif wa:
        # the page is waiting for a passkey / security key right now (a real browser would show its native dialog)
        out["step"] = webauthn_kind(wa, text)
        out["webauthn"] = {"kind": out["step"], "pending": True, "op": wa.get("op")}
    elif pw:
        p0 = pw[0]
        same = [i for i in ident if i.get("form") == p0.get("form")] or ([] if p0.get("form", -1) >= 0 else ident)
        chosen = ([same[0]] if same else []) + [p0]
        out["step"] = "identifier_password" if same else "password"
        if len({i.get("form") for i in pw}) > 1:
            flags.append("multiple_password_forms")
    elif boxes:
        out["step"] = "otp"
        out["fields"] = [{"id": boxes[0]["id"], "role": "otp", "input": "code", "ids": [b["id"] for b in boxes]}]
        out["otp"] = _otp_meta(boxes, text)
        chosen = boxes
    elif otp:
        out["step"] = "otp"
        chosen = [otp[0]]
        out["otp"] = _otp_meta([otp[0]], text)
    elif rec:
        out["step"] = "recovery_code"
        chosen = [rec[0]]
        if prev_step not in ("password", "identifier_password", "otp", "device_approval", "passkey"):
            flags.append("unexpected_recovery_code")
    elif newpw and not LOGIN_WORDS.search(text[:400]):
        out["step"] = "new_password"
    elif ident and (login_ctx or prev_step == "identifier"):
        chosen = [ident[0]]
        out["step"] = "identifier"
        if len({i["role"] for i in ident}) > 1:
            flags.append("ambiguous_identifier")
        if hidden_pw and not login_ctx:
            flags.append("hidden_password_field")
    elif PASSKEY_WORDS.search(text) or (facts.get("webauthn") and not ident):
        out["step"] = webauthn_kind(None, text)
        out["webauthn"] = {"kind": out["step"], "pending": False, "op": None}
    elif DEVICE_WORDS.search(text):
        out["step"] = "device_approval"
        n = facts.get("approval_number")
        if isinstance(n, str) and re.fullmatch(r"\d{2,3}", n):
            out["approval_number"] = n
    elif (KMSI_WORDS.search(text[:600]) or NAG_WORDS.search(text[:600])) and not usable and \
            any(DECLINE_BUTTON.match((c.get("t") or "").strip()) for c in clicks):
        out["step"] = "interstitial"
        dec = next(c for c in clicks if DECLINE_BUTTON.match((c.get("t") or "").strip()))
        out["interstitial"] = {"kind": "kmsi" if KMSI_WORDS.search(text[:600]) else "nag", "click": dec["id"]}
    elif len(alts) >= 2 and not usable:
        out["step"] = "method_choice"
    elif any(f.get("login") for f in facts.get("frames") or []):
        out["step"] = "embedded_login"
        flags.append("third_party_frame")
    elif (any(LOGOUT_WORDS.match(b.strip()) for b in buttons) or facts.get("logout_link") is True) and \
            not out["error"] and not (prev_step is not None and wording):
        # a sign-out control: visible (button/link text or a visible sign-out link) or only a hidden link (menus);
        # never on a page that shows an error or still uses sign-in wording
        out["step"] = "authenticated"
        out["signout"] = "visible" if (any(LOGOUT_WORDS.match(b.strip()) for b in buttons) or
                                       facts.get("logout_visible") is True) else "hidden"
    elif CAPTCHA_WORDS.search(text[:1500]):
        out["step"] = "captcha"
    elif prev_step is not None and (login_ctx or ERROR_WORDS.search(alerts)):
        # still a sign-in page after a step, but nothing NEBULA can recognise: never taken as success
        out["step"] = "unknown"

    if out["step"] in ("otp",) and not out["fields"]:
        out["fields"] = [field(chosen[0])]
    elif chosen and not out["fields"]:
        out["fields"] = [field(i) for i in chosen]
    if out["fields"] and out["step"] == "otp" and out["otp"] and out["otp"].get("length"):
        out["fields"][0]["length"] = out["otp"]["length"]
        out["fields"][0]["charset"] = out["otp"]["charset"]
    if out["step"] == "recovery_code":
        out["fields"][0]["charset"] = "alphanumeric"
    if out["step"] in ("otp", "device_approval", "passkey", "security_key", "method_choice", "password", "identifier",
                       "unknown"):
        out["alternatives"] = [a for a in alts if not (a["kind"] == "password" and out["step"] == "password")]
    # an error shown next to the field we would fill (aria-invalid) counts like an error banner
    if any(i.get("invalid") for i in chosen):
        out["error"] = True

    # credentials sent to another site?
    if chosen:
        f = form_of(chosen[-1])
        if f and f.get("action"):
            out["action_origin"] = f["action"]
            if f["action"] != page_origin:
                flags.append("cross_site_form_action" if site_of(host_of(f["action"])) != page_site
                             else "cross_origin_form_action")

    # confidence
    level = 2  # HIGH
    if out["step"] in ("identifier", "identifier_password", "password", "otp", "recovery_code"):
        if not all(i.get("explicit") for i in chosen):
            level = min(level, 1)
    if out["step"] in ("otp", "device_approval", "passkey", "security_key", "recovery_code") and prev_step is None:
        level = min(level, 1)  # verification step without a preceding credential step in this session
    out["structure"] = ("LOW", "MEDIUM", "HIGH")[level]  # the form itself, before origin/suspicion flags
    medium = {"origin_changed", "cross_origin_form_action", "multiple_password_forms", "ambiguous_identifier",
              "hidden_password_field"}
    low = {"other_site", "cross_site_form_action", "third_party_frame", "unexpected_recovery_code", "plain_http"}
    for fl in flags:
        if fl in low or fl.startswith("brand_mismatch"):
            level = 0
        elif fl in medium:
            level = min(level, 1)
    if out["step"] in ("none", "authenticated"):
        level = 2 if not any(f in low or f.startswith("brand_mismatch") for f in flags) else 0
    out["confidence"] = ("LOW", "MEDIUM", "HIGH")[level]
    out["fingerprint"] = fingerprint(out, facts)
    return out


def diagnostics(facts: dict[str, Any], out: dict[str, Any]) -> dict[str, Any]:
    """Safe, structural facts about one detection (V3.4 diagnostics): counts, kinds and timings only — never page
    text, field names, values, URLs with query strings or cookies."""
    inputs = [i for i in facts.get("inputs") or [] if isinstance(i, dict)]
    wa = out.get("webauthn") or {}

    def num(v: Any, cap: int = 10**9) -> int | None:
        if not isinstance(v, (int, float)) or isinstance(v, bool) or not math.isfinite(v):
            return None
        return max(0, min(int(v), cap))

    return {"step": out.get("step"), "confidence": out.get("confidence"), "structure": out.get("structure"),
            "roles": [f.get("role") for f in out.get("fields") or []][:4],
            "inputs_visible": sum(1 for i in inputs if i.get("visible")), "inputs": len(inputs),
            "forms": len(facts.get("forms") or []), "frames": len(facts.get("frames") or []),
            "shadow_roots": num(facts.get("shadow_roots"), 30), "observed": bool(facts.get("observed")),
            "quiet_ms": num(facts.get("quiet_ms"), 600000), "mutations": num(facts.get("mutations")),
            "ready": facts.get("ready") if facts.get("ready") in ("loading", "interactive", "complete") else None,
            "animating": num(facts.get("animating"), 1000), "busy": bool(facts.get("busy")),
            "webauthn": wa.get("kind"), "webauthn_pending": bool(wa.get("pending")),
            "alternatives": sorted(a.get("kind") for a in out.get("alternatives") or [] if a.get("kind")),
            "error": bool(out.get("error")), "login_context": bool(out.get("login_context")),
            "logout_link": facts.get("logout_link") is True,
            "flags": [f for f in out.get("flags") or [] if isinstance(f, str)][:8]}


def compact(c: dict[str, Any]) -> dict[str, Any]:
    """Advisory hint for an agent's browser result (no field ids — the agent never fills secrets)."""
    wa = c.get("webauthn") or {}
    return {"step": c.get("step"), "confidence": c.get("confidence"), "origin": c.get("page_origin"),
            "otp_channel": (c.get("otp") or {}).get("channel"), "passkey_prompt": bool(wa.get("pending"))}


# identity-provider sign-in hosts (exact): a sign-in reached in the agent's browser on one of these is in the middle
# of another service's flow — NEBULA's isolated browser starts it again from that service (V3.4)
IDP_HOSTS = frozenset({"login.microsoftonline.com", "login.microsoft.com", "login.live.com", "login.windows.net",
                       "account.live.com", "accounts.google.com", "idmsa.apple.com", "appleid.apple.com"})
