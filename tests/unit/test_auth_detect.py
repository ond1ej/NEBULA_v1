"""Smart Authentication detection engine (V3.2.1 spec §5, §21.1): deterministic classification of sign-in steps from
the structural facts DETECT_JS collects (no input values). The same code runs in the isolated broker (trusted) and
for advisory hints in agents' browsers; the real in-browser collection is exercised by scripts/v321_smart_auth_e2e.py
in the VM."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "guest" / "guest-service"))

from nebula_guest import auth_detect as D  # noqa: E402

GH = "https://github.com"


def inp(i, type="text", name="", ac="", label="", visible=True, form=0, maxlength=None, im="", pattern="", elid=""):
    return {"id": f"f{i}", "type": type, "name": name, "elid": elid, "ac": ac, "im": im, "maxlength": maxlength,
            "pattern": pattern, "label": label, "visible": visible, "form": form, "disabled": False,
            "readonly": False}


def facts(inputs=(), url=GH + "/login", title="Sign in", headings=("Sign in",), forms=None, text="", buttons=(),
          frames=(), alerts=(), captcha_el=False, webauthn=False):
    return {"url": url, "origin": D.origin_of(url), "title": title, "headings": list(headings),
            "inputs": [dict(i) for i in inputs],
            "forms": forms if forms is not None else [{"i": 0, "action": "", "action_path": "/session",
                                                        "method": "post", "visible": True}],
            "frames": list(frames), "captcha_el": captcha_el, "webauthn": webauthn,
            "clickables": [{"t": b, "href": ""} for b in buttons], "alerts": list(alerts), "text": text}


def roles(c):
    return [f["role"] for f in c["fields"]]


# ---------------------------------------------------------------- 1-5 credentials
def test_01_email_and_password():
    c = D.classify(facts([inp(0, "email", "email", "username", "Email address"),
                          inp(1, "password", "password", "current-password", "Password")]), requested_origin=GH)
    assert c["step"] == "identifier_password" and roles(c) == ["email", "password"]
    assert c["confidence"] == "HIGH" and c["flags"] == [] and c["page_origin"] == GH
    assert [f["input"] for f in c["fields"]] == ["email", "password"]


def test_02_username_and_password():
    c = D.classify(facts([inp(0, "text", "login", "username", "Username or email address"),
                          inp(1, "password", "password", "current-password")]), requested_origin=GH)
    assert c["step"] == "identifier_password" and roles(c) == ["username_or_email", "password"]
    assert c["confidence"] == "HIGH"
    c = D.classify(facts([inp(0, "text", "user", "username", "Username"), inp(1, "password", "pw")]))
    assert roles(c) == ["username", "password"]


def test_03_phone_and_password():
    c = D.classify(facts([inp(0, "tel", "phone", "tel", "Phone number"), inp(1, "password", "password")]))
    assert c["step"] == "identifier_password" and roles(c) == ["phone", "password"]
    assert c["fields"][0]["input"] == "tel" and c["confidence"] == "HIGH"


def test_04_username_only_step_identifier_first():
    c = D.classify(facts([inp(0, "email", "identifier", "username webauthn", "Email or phone"),
                          inp(1, "password", "hiddenPassword", visible=False)], title="Sign in - Example"))
    assert c["step"] == "identifier" and roles(c) == ["email"] and c["confidence"] == "HIGH"
    assert c["login_context"] is True


def test_05_password_only_step():
    c = D.classify(facts([inp(0, "password", "Passwd", "current-password", "Enter your password")]),
                   previous={"step": "identifier"})
    assert c["step"] == "password" and roles(c) == ["password"] and c["confidence"] == "HIGH"


# ---------------------------------------------------------------- 6-9 one-time codes
def test_06_sms_otp_with_length_and_numeric_charset():
    c = D.classify(facts([inp(0, "text", "otp", "one-time-code", "Code", maxlength=6, im="numeric")],
                         text="We sent a 6-digit code to your phone number ending in 42."),
                   previous={"step": "identifier_password"})
    assert c["step"] == "otp" and c["otp"] == {"channel": "sms", "length": 6, "charset": "numeric"}
    assert c["fields"][0]["length"] == 6 and c["fields"][0]["charset"] == "numeric" and c["confidence"] == "HIGH"


def test_07_email_otp():
    c = D.classify(facts([inp(0, "text", "code", "one-time-code", "Verification code", maxlength=8)],
                         text="We emailed a verification code. Check your inbox."), previous={"step": "password"})
    assert c["step"] == "otp" and c["otp"]["channel"] == "email" and c["otp"]["length"] == 8
    assert c["otp"]["charset"] == "alphanumeric"


def test_08_authenticator_otp_without_autocomplete_is_medium():
    c = D.classify(facts([inp(0, "text", "app_otp", "", "Authentication code", pattern=r"\d{6}")],
                         text="Open your two-factor authenticator (TOTP) app to view your authentication code."),
                   previous={"step": "identifier_password"})
    assert c["step"] == "otp" and c["otp"] == {"channel": "totp", "length": 6, "charset": "numeric"}
    assert c["confidence"] == "MEDIUM"  # recognised from names/labels only


def test_09_multiple_single_character_boxes_are_one_code():
    boxes = [inp(i, "text", f"d{i}", "", f"Digit {i + 1}", maxlength=1, im="numeric") for i in range(6)]
    c = D.classify(facts(boxes, text="Enter the code we texted you"), previous={"step": "password"})
    assert c["step"] == "otp" and len(c["fields"]) == 1
    f = c["fields"][0]
    assert f["ids"] == [f"f{i}" for i in range(6)] and f["length"] == 6 and f["charset"] == "numeric"


# ---------------------------------------------------------------- 10-13 non-text steps
def test_10_device_approval():
    c = D.classify(facts([], text="Check your phone. We sent a push notification — tap Yes to approve the sign-in."),
                   previous={"step": "identifier_password"})
    assert c["step"] == "device_approval" and c["fields"] == [] and c["confidence"] == "HIGH"


def test_11_passkey():
    c = D.classify(facts([], text="Use your passkey to sign in. Use your fingerprint, face, or screen lock."),
                   previous={"step": "identifier"})
    assert c["step"] == "passkey"
    assert D.classify(facts([], text="", webauthn=True), previous={"step": "identifier"})["step"] == "passkey"


def test_12_captcha_widget_or_frame():
    pw = [inp(0, "email", "email", "username"), inp(1, "password", "password", "current-password")]
    assert D.classify(facts(pw, captcha_el=True))["step"] == "captcha"
    fr = [{"origin": "https://www.google.com", "visible": True, "captcha": True}]
    assert D.classify(facts([], frames=fr))["step"] == "captcha"
    assert "captcha" in D.MANUAL_STEPS


def test_13_already_authenticated_session():
    c = D.classify(facts([inp(0, "search", "q", "", "Search")], url=GH + "/dashboard", title="Dashboard",
                         headings=("Your repositories",), buttons=("New", "Sign out")))
    assert c["step"] == "authenticated" and c["fields"] == []


# ---------------------------------------------------------------- 14-15 suspicious forms
def test_14_lookalike_brand_page_is_low_confidence():
    c = D.classify(facts([inp(0, "email", "email", "username"), inp(1, "password", "password", "current-password")],
                         url="https://github-login.example/session", title="GitHub login required",
                         headings=("Sign in to GitHub",)), requested_origin="https://github-login.example")
    assert c["step"] == "identifier_password" and "brand_mismatch:github" in c["flags"]
    assert c["confidence"] == "LOW"
    ok = D.classify(facts([inp(0, "email", "email", "username"), inp(1, "password", "password", "current-password")],
                          title="Sign in to GitHub · GitHub"), requested_origin=GH)
    assert ok["confidence"] == "HIGH" and not ok["flags"]


def test_15_cross_origin_form_submission():
    pw = [inp(0, "email", "email", "username"), inp(1, "password", "password", "current-password")]
    evil = D.classify(facts(pw, forms=[{"i": 0, "action": "https://collect.evil.test", "action_path": "/c",
                                        "method": "post", "visible": True}]))
    assert "cross_site_form_action" in evil["flags"] and evil["confidence"] == "LOW"
    assert evil["action_origin"] == "https://collect.evil.test"
    same_site = D.classify(facts(pw, forms=[{"i": 0, "action": "https://auth.github.com", "action_path": "/s",
                                             "method": "post", "visible": True}]))
    assert "cross_origin_form_action" in same_site["flags"] and same_site["confidence"] == "MEDIUM"


# ---------------------------------------------------------------- more edge cases
def test_heuristic_only_fields_are_medium_and_search_boxes_are_ignored():
    c = D.classify(facts([inp(0, "text", "login_field", "", "Login"), inp(1, "password", "pw")]))
    assert c["step"] == "identifier_password" and c["confidence"] == "MEDIUM"
    c = D.classify(facts([inp(0, "search", "q", "", "Search")], title="Docs", headings=("Docs",)))
    assert c["step"] == "none"
    c = D.classify(facts([inp(0, "email", "newsletter", "email", "Your e-mail")], title="Blog", headings=("News",),
                         forms=[{"i": 0, "action": "", "action_path": "/subscribe", "method": "post",
                                 "visible": True}]))
    assert c["step"] == "none"  # a newsletter box is not a sign-in


def test_alphanumeric_and_variable_length_codes():
    c = D.classify(facts([inp(0, "text", "verification_code", "one-time-code", "Code")],
                         text="Enter the code from the e-mail we sent"), previous={"step": "password"})
    assert c["otp"]["length"] is None and c["otp"]["charset"] == "alphanumeric"
    assert "length" not in c["fields"][0] or c["fields"][0].get("length") is None


def test_recovery_code_unexpected_is_low_and_after_password_is_fine():
    f = [inp(0, "text", "recovery_code", "", "Recovery code")]
    assert D.classify(facts(f))["confidence"] == "LOW"
    c = D.classify(facts(f), previous={"step": "otp"})
    assert c["step"] == "recovery_code" and "unexpected_recovery_code" not in c["flags"]


def test_embedded_third_party_login_frame_and_new_password():
    c = D.classify(facts([], frames=[{"origin": "https://idp.other.test", "visible": True, "login": True}],
                         text="Sign in"))
    assert c["step"] == "embedded_login" and c["confidence"] == "LOW"
    c = D.classify(facts([inp(0, "password", "new", "new-password", "Create a password")], title="Create account",
                         headings=("Create your account",), text="Create your account"))
    assert c["step"] == "new_password"


def test_origin_changed_same_site_medium_other_site_low():
    pw = [inp(0, "email", "email", "username"), inp(1, "password", "password", "current-password")]
    c = D.classify(facts(pw, url="https://login.example.com/x"), requested_origin="https://example.com")
    assert "origin_changed" in c["flags"] and c["confidence"] == "MEDIUM"
    c = D.classify(facts(pw, url="https://idp.other.test/x"), requested_origin="https://example.com")
    assert "other_site" in c["flags"] and c["confidence"] == "LOW"


def test_error_banner_detected_and_hint_is_compact_without_field_ids():
    c = D.classify(facts([inp(0, "email", "email", "username"), inp(1, "password", "password", "current-password")],
                         alerts=["Incorrect username or password."]))
    assert c["error"] is True
    h = D.compact(c)
    assert set(h) == {"step", "confidence", "origin", "otp_channel", "passkey_prompt"} and "f0" not in str(h)


@pytest.mark.parametrize("host,site", [("github.com", "github.com"), ("api.github.com", "github.com"),
                                       ("www.bbc.co.uk", "bbc.co.uk"), ("10.0.0.5", "10.0.0.5"),
                                       ("localhost", "localhost")])
def test_site_of(host, site):
    assert D.site_of(host) == site


def test_detect_js_never_reads_values():
    js = D.DETECT_JS
    assert ".value" not in js.replace("b.value", "")  # only button captions (input[type=submit] value) are read
    assert "data-nebula-auth" in js and "innerText" in js


def test_plain_http_flag_only_for_public_hosts():
    pw = [inp(0, "email", "email", "username"), inp(1, "password", "password", "current-password")]
    c = D.classify(facts(pw, url="http://192.168.64.6:18000/a/login"), requested_origin="http://192.168.64.6:18000")
    assert "plain_http" not in c["flags"] and c["confidence"] == "HIGH"
    c = D.classify(facts(pw, url="http://intranet.local/login"))
    assert "plain_http" not in c["flags"]
    c = D.classify(facts(pw, url="http://example.com/login"))
    assert "plain_http" in c["flags"] and c["confidence"] == "LOW"


# ---------------------------------------------------------------- V3.3 state-aware detection
MSO = "https://login.microsoftonline.com"


def _clicks(*texts):
    return [{"id": f"c{i}", "t": t, "href": ""} for i, t in enumerate(texts)]


def test_microsoft_password_view_is_a_password_step_despite_the_hidden_username():
    """The password view keeps an off-screen, aria-hidden copy of the e-mail field for password managers: it is not
    visible, so the step is 'password' with one password field (never the e-mail form again)."""
    f = facts([inp(0, "email", name="loginfmt", ac="username", visible=False),
               inp(1, "password", name="passwd", ac="current-password", label="Enter the password")],
              url=MSO + "/common/login", title="Sign in to your account", headings=("Enter password",))
    c = D.classify(f, requested_origin=MSO, previous={"step": "identifier"})
    assert c["step"] == "password" and roles(c) == ["password"] and c["confidence"] == "HIGH"


def test_alternatives_are_detected_by_kind_only():
    f = facts([], url=MSO + "/common/fido/get", title="Sign in", headings=("Sign in with a passkey",),
              text="Use your face, fingerprint, PIN or security key to sign in.")
    f["clickables"] = _clicks("Other ways to sign in", "Use your password", "Back")
    c = D.classify(f, requested_origin=MSO, previous={"step": "identifier"})
    assert c["step"] == "passkey"
    assert {a["kind"] for a in c["alternatives"]} == {"more", "password"}
    assert all(set(a) == {"id", "kind"} for a in c["alternatives"])  # no page text reaches the owner


def test_method_choice_page():
    f = facts([], url=MSO + "/common/login", title="Verify your identity", headings=("Verify your identity",),
              text="Choose a way to verify")
    f["clickables"] = _clicks("Text +XX XXX XXX X42", "Use a verification code", "Approve a request on my Microsoft Authenticator app")
    f["clickables"][0]["t"] = "Send me a code"
    c = D.classify(f, requested_origin=MSO, previous={"step": "password"})
    assert c["step"] == "method_choice" and len(c["alternatives"]) >= 2


def test_stay_signed_in_is_an_interstitial_with_the_no_choice():
    f = facts([], url=MSO + "/kmsi", title="Stay signed in?", headings=("Stay signed in?",),
              text="Stay signed in? Do this to reduce the number of times you are asked to sign in.")
    f["clickables"] = _clicks("Yes", "No")
    c = D.classify(f, requested_origin=MSO, previous={"step": "password"})
    assert c["step"] == "interstitial" and c["interstitial"] == {"kind": "kmsi", "click": "c1"}


def test_aria_invalid_counts_as_an_error_and_structure_is_reported():
    i = inp(0, "email", ac="username", label="Email")
    i["invalid"] = True
    c = D.classify(facts([i], url=MSO + "/", headings=("Sign in",)), requested_origin=MSO)
    assert c["step"] == "identifier" and c["error"] is True and c["structure"] == "HIGH"
    other = D.classify(facts([inp(0, "email", ac="username")], url="https://teams.microsoft.com/"),
                       requested_origin=MSO)
    assert other["confidence"] == "LOW" and other["structure"] == "HIGH"  # the form is fine; the origin differs


def test_fingerprint_is_stable_and_value_free():
    f1 = facts([inp(0, "password", ac="current-password")], url=MSO + "/common/login?ctx=1")
    f2 = facts([inp(0, "password", ac="current-password")], url=MSO + "/common/login?ctx=2")
    a, b = D.classify(f1, requested_origin=MSO), D.classify(f2, requested_origin=MSO)
    assert a["fingerprint"] == b["fingerprint"] and len(a["fingerprint"]) == 16  # query (tokens) ignored
    c = D.classify(facts([inp(0, "email", ac="username")], url=MSO + "/common/login"), requested_origin=MSO)
    assert c["fingerprint"] != a["fingerprint"]


# ---------------------------------------------------------------- V3.4
MSO = "https://login.microsoftonline.com"


def test_pending_webauthn_is_a_passkey_or_a_security_key_by_its_hints():
    pk = facts(url=MSO + "/fido", title="Sign in", headings=("Sign in with a passkey",), text="Waiting for passkey")
    pk["wa_pending"] = {"op": "get", "transports": ["internal", "hybrid"], "discoverable": False}
    c = D.classify(pk, requested_origin=MSO, previous={"step": "identifier"})
    assert c["step"] == "passkey" and c["webauthn"] == {"kind": "passkey", "pending": True, "op": "get"}
    sk = facts(url=MSO + "/key", headings=("Insert your security key",))
    sk["wa_pending"] = {"op": "get", "transports": ["usb", "nfc"], "discoverable": False}
    assert D.classify(sk, requested_origin=MSO)["step"] == "security_key"
    words = facts(url=MSO + "/key", headings=("Use your security key",), text="Touch your security key")
    assert D.classify(words, requested_origin=MSO, previous={"step": "identifier"})["step"] == "security_key"
    # the passive passkey autofill on an e-mail field is never a passkey step (not recorded by the observer)
    email = facts([inp(0, "email", "loginfmt", "username webauthn", "Email")], url=MSO + "/")
    assert D.classify(email, requested_origin=MSO)["step"] == "identifier"


def test_observer_passes_capability_checks_and_autofill_through_untouched():
    js = D.OBSERVE_JS
    assert "isUserVerifyingPlatformAuthenticatorAvailable" not in js and "getClientCapabilities" not in js
    assert "mediation === 'conditional'" in js and "return Reflect.apply(target, self, args)" in js
    assert "Object.freeze" in js and "new Proxy(orig" in js  # the page cannot forge or replace the observer state
    assert "NotAllowedError" in js and "MutationObserver" in js


def test_number_matching_approval_shows_the_number():
    f = facts(url=MSO + "/approve", headings=("Approve sign in request",),
              text="Open your Authenticator app, and enter the number shown to sign in.")
    f["approval_number"] = "42"
    c = D.classify(f, requested_origin=MSO, previous={"step": "password"})
    assert c["step"] == "device_approval" and c["approval_number"] == "42"
    f["approval_number"] = "<b>42</b>"
    assert D.classify(f, requested_origin=MSO, previous={"step": "password"})["approval_number"] is None


def test_unrecognised_sign_in_page_after_a_step_is_unknown_not_success():
    f = facts([inp(0, "text", "pin_x", "", "Gizmo", visible=True)], url=GH + "/weird", title="Sign in",
              headings=("Sign in",))
    assert D.classify(f, requested_origin=GH, previous={"step": "password"})["step"] == "unknown"
    assert D.classify(f, requested_origin=GH)["step"] == "none"  # first page: no sign-in form here
    err = facts(url=GH + "/x", title="Oops", headings=("Something happened",), alerts=("Invalid request",))
    assert D.classify(err, requested_origin=GH, previous={"step": "password"})["step"] == "unknown"


def test_signout_link_or_czech_button_means_a_signed_in_page():
    f = facts(url=GH + "/app", title="Dashboard", headings=("Dashboard",))
    f["logout_link"] = True
    c = D.classify(f, requested_origin=GH, previous={"step": "password"})
    assert c["step"] == "authenticated" and c["signout"] == "hidden"
    f["logout_visible"] = True
    assert D.classify(f, requested_origin=GH, previous={"step": "password"})["signout"] == "visible"
    # review finding 2a: an error page or a page still asking to sign in is never "signed in", link or not
    bad = facts(url=GH + "/x", title="Sign in failed", headings=("Sign in",), alerts=("Incorrect password",))
    bad["logout_link"] = True
    assert D.classify(bad, requested_origin=GH, previous={"step": "password"})["step"] == "unknown"
    signed_cz = facts(url=GH + "/app", title="CTF", headings=("Přihlášen jako ond",), buttons=("Odhlásit",))
    assert D.classify(signed_cz, requested_origin=GH, previous={"step": "password"})["step"] == "authenticated"
    cz = facts(url=GH + "/app", title="CTF Writeup Studio", headings=("CTF Writeup Studio",), buttons=("Odhlásit",))
    assert D.classify(cz, requested_origin=GH, previous={"step": "password"})["step"] == "authenticated"


def test_czech_sign_in_wording_and_disabled_busy_form_keep_the_login_context():
    f = facts([inp(0, "text", "username", "username", "Uživatelské jméno"),
               inp(1, "password", "password", "current-password", "Heslo")], url=GH + "/ctf/",
              title="Přihlášení · CTF Writeup Studio", headings=("Přihlášení",))
    c = D.classify(f, requested_origin=GH)
    assert c["step"] == "identifier_password" and c["login_context"] is True
    for i in f["inputs"]:
        i["disabled"] = True  # the site disabled the form while it waits for its server
    busy = D.classify(f, requested_origin=GH, previous={"step": "identifier_password"})
    assert busy["step"] == "unknown"  # never "no form = signed in"


def test_diagnostics_are_structural_only():
    f = facts([inp(0, "email", "loginfmt", "username", "Email SECRET-LABEL")], url=MSO + "/?token=SECRET-Q",
              title="SECRET-TITLE", text="SECRET-TEXT")
    f.update(quiet_ms=420, mutations=7, observed=True, ready="complete", shadow_roots=1)
    c = D.classify(f, requested_origin=MSO)
    d = D.diagnostics(f, c)
    assert d["quiet_ms"] == 420 and d["roles"] == ["email"] and d["shadow_roots"] == 1 and d["observed"] is True
    assert "SECRET" not in str(d)


def test_identity_provider_hosts_are_exact():
    assert "login.microsoftonline.com" in D.IDP_HOSTS and "accounts.google.com" in D.IDP_HOSTS
    assert "teams.microsoft.com" not in D.IDP_HOSTS and "login.microsoftonline.com.evil.io" not in D.IDP_HOSTS


def test_observer_ignores_nebulas_own_markers():
    """Regression found by the V3.4 phase timings: marking fields (data-nebula-*) counted as page changes, so a
    page never looked settled right after NEBULA read it (e-mail -> password took ~2 s instead of ~1 s)."""
    assert "attributeName.startsWith('data-nebula')" in D.OBSERVE_JS
