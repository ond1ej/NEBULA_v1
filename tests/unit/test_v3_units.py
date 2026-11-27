"""V3 unit tests: Mini App initData verification, media sniffing/ZIP safety, voice intents, host policy, sandbox
profile, task-card rendering/levels, environment resolution helpers."""

from __future__ import annotations

import hashlib
import hmac
import io
import json
import time
import zipfile
from pathlib import Path
from urllib.parse import urlencode

import pytest

BOT_TOKEN = "123456789:" + "A" * 35  # obviously fake


def make_init_data(token: str, user_id: int = 7, auth_date: int | None = None, extra: dict | None = None) -> str:
    fields = {"auth_date": str(auth_date or int(time.time())), "query_id": "AAHdF6IQAAAAAN0XohDhrOrc",
              "user": json.dumps({"id": user_id, "first_name": "Zed", "username": "zed", "language_code": "cs"},
                                 separators=(",", ":")), **(extra or {})}
    dcs = "\n".join(f"{k}={v}" for k, v in sorted(fields.items()))
    secret = hmac.new(b"WebAppData", token.encode(), hashlib.sha256).digest()
    fields["hash"] = hmac.new(secret, dcs.encode(), hashlib.sha256).hexdigest()
    return urlencode(fields)


# ------------------------------------------------------------------------------------------- MINI-01..03 (crypto)
def test_mini_initdata_signature_valid_tampered_and_wrong_token():
    from nebula_host import miniapp

    good = make_init_data(BOT_TOKEN, extra={"signature": "sig-included-in-dcs"})
    f = miniapp.check_signature(good, BOT_TOKEN)
    assert f is not None and json.loads(f["user"])["id"] == 7 and "hash" not in f
    assert miniapp.check_signature(good, "999:other-token-xxxxxxxxxxxxxxxxxxxxxxxxx") is None
    tampered = good.replace("%22id%22%3A7", "%22id%22%3A8")
    assert tampered != good and miniapp.check_signature(tampered, BOT_TOKEN) is None
    dup = good + "&auth_date=1"
    assert miniapp.check_signature(dup, BOT_TOKEN) is None  # duplicate keys are never produced by Telegram
    assert miniapp.check_signature("user=x", BOT_TOKEN) is None  # no hash at all


def test_mini_verify_freshness(dbinit):
    from nebula_host import miniapp
    from nebula_host import secrets as sec

    sec.store().set("nebula:telegram.bot_token", BOT_TOKEN)
    v = miniapp.verify(make_init_data(BOT_TOKEN))
    assert v["user"]["id"] == 7 and v["bot_key"] == "main"
    with pytest.raises(miniapp.MiniAuthError) as e:
        miniapp.verify(make_init_data(BOT_TOKEN, auth_date=int(time.time()) - 3600))
    assert e.value.code == "expired"
    with pytest.raises(miniapp.MiniAuthError) as e:
        miniapp.verify(make_init_data(BOT_TOKEN, auth_date=int(time.time()) + 600))
    assert e.value.code == "clock_skew"
    with pytest.raises(miniapp.MiniAuthError) as e:
        miniapp.verify(make_init_data("111:not-the-configured-token-xxxxxxxxxxxxxx"))
    assert e.value.code == "bad_signature"


# ------------------------------------------------------------------------------------------- media / MM-08
def _zip(entries: dict[str, bytes], compress=zipfile.ZIP_DEFLATED) -> bytes:
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w", compress) as z:
        for n, d in entries.items():
            z.writestr(n, d)
    return b.getvalue()


def test_sniff_by_content_not_declared_type():
    from nebula_host import media

    assert media.sniff(b"\x89PNG\r\n\x1a\n" + b"0" * 20, "x.txt", "text/plain") == ("image", "image/png")
    assert media.sniff(b"%PDF-1.4 ...", "a.bin")[0] == "pdf"
    assert media.sniff(b"OggS" + b"\0" * 30)[0] == "audio"
    assert media.sniff(b"\0\0\0\x18ftypmp42" + b"\0" * 20)[0] == "video"
    assert media.sniff(b'{"a": 1}', "data.json")[0] == "json"
    assert media.sniff(b"a,b\n1,2\n", "t.csv")[0] == "csv"
    assert media.sniff(b"print(1)\n", "x.py")[0] == "code"
    docx = _zip({"[Content_Types].xml": b"<x/>", "word/document.xml": b"<w/>"})
    assert media.sniff(docx, "doc.docx")[0] == "docx"
    for bad, name in ((b"MZ\x90\x00" + b"\0" * 40, "x.bin"), (b"\x7fELF" + b"\0" * 40, "x"), (b"hello", "setup.exe"),
                      (b"\x00\x01\x02\x03" * 100, "blob.dat")):
        with pytest.raises(media.MediaError):
            media.sniff(bad, name)


def test_zip_inspect_traversal_symlink_and_bomb():
    from nebula_host import media

    info = media.zip_inspect(_zip({"src/a.py": b"print(1)", "../../etc/passwd": b"x", "/abs.txt": b"y"}))
    assert info["entries"] == 1 and set(info["unsafe_entries"]) == {"../../etc/passwd", "/abs.txt"}
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w") as z:
        zi = zipfile.ZipInfo("link")
        zi.external_attr = (0o120777 << 16)
        z.writestr(zi, "/etc/passwd")
    assert media.zip_inspect(b.getvalue())["unsafe_entries"] == ["link"]
    bomb = _zip({"zeros.bin": b"\0" * (30 * 1024 * 1024)})
    with pytest.raises(media.MediaError) as e:
        media.zip_inspect(bomb)
    assert e.value.code == "zip_bomb"


def test_docx_text_and_dtd_rejected():
    from nebula_host import media

    ns = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
    xml = f'<w:document {ns}><w:body><w:p><w:r><w:t>Specifikace</w:t></w:r></w:p><w:p><w:r><w:t>Login page</w:t>' \
          '</w:r></w:p></w:body></w:document>'
    assert media.docx_text(_zip({"word/document.xml": xml.encode()})) == "Specifikace\nLogin page"
    evil = '<!DOCTYPE x [<!ENTITY a "aaaa">]><w:document ' + ns + '><w:body/></w:document>'
    with pytest.raises(media.MediaError):
        media.docx_text(_zip({"word/document.xml": evil.encode()}))


def test_safe_name():
    from nebula_host import media

    assert media.safe_name("../../evil name?.txt") == "evil name_.txt"
    assert media.safe_name("....") == "file"


# ------------------------------------------------------------------------------------------- voice intents
AGENTS = [{"id": "a-dev", "name": "Developer"}, {"id": "a-res", "name": "Researcher"}, {"id": "a-nov", "name": "Novák"}]


@pytest.mark.parametrize("text,intent,agent,rest", [
    ("Developere, jak pokračuje ten projekt?", "status", "a-dev", "jak pokračuje ten projekt?"),
    ("Developer, finish the backend and send me the result", "task", "a-dev",
     "finish the backend and send me the result"),
    ("Tak dokonči backend a pak mi pošli výsledek.", "task", "a-sel", "Tak dokonči backend a pak mi pošli výsledek."),
    ("Researchere: pozastav to", "pause", "a-res", "pozastav to"),
    ("pokračuj", "resume", "a-sel", "pokračuj"),
    ("Zastav", "stop", "a-sel", "Zastav"),
    ("ukaž mi obrazovku", "screenshot", "a-sel", "ukaž mi obrazovku"),
    ("Jaký je stav týmu?", "team_status", "a-sel", "Jaký je stav týmu?"),
    ("What's the company status?", "company_status", "a-sel", "What's the company status?"),
    ("Nováku, what is the status", "status", "a-nov", "what is the status"),
])
def test_voice_intents(text, intent, agent, rest):
    from nebula_host import voice

    r = voice.parse(text, AGENTS, "a-sel")
    assert (r["intent"], r["agent_id"], r["text"]) == (intent, agent, rest)


def test_voice_reply_modes_and_language():
    from nebula_host import voice

    assert voice.should_speak("auto", True) == (True, True) and voice.should_speak("auto", False) == (True, False)
    assert voice.should_speak("voice", False) == (False, True) and voice.should_speak("text", True) == (True, False)
    assert voice.detect_language("Udělej to prosím") == "cs" and voice.detect_language("Please do it") == "en"


# ------------------------------------------------------------------------------------------- host policy & sandbox
def test_host_policy_rules():
    from nebula_runtime import policy
    from nebula_runtime.tools import BY_WIRE

    st = policy.TaskPolicyState()

    def d(tool, args):
        return policy.decide(BY_WIRE[tool], args, level="ADVANCED", linux_user="x", st=st, require_approval=True,
                             env="host")

    assert d("shell_execute", {"command": "npm test"}).action == "allow"
    assert d("git_run", {"args": ["status"]}).action == "allow"
    for cmd in ("osascript -e 'beep'", "open -a Safari", "defaults write com.apple.dock x", "brew install wget",
                "npm install -g typescript", "git reset --hard HEAD~1", "rm -rf build", "sudo ls", "curl -d x http://a"):
        assert d("shell_execute", {"command": cmd}).action == "approve", cmd
    for cmd in ("security find-generic-password -w -s x", "cat ~/.ssh/id_rsa", "ls ~/Library/Keychains"):
        assert d("shell_execute", {"command": cmd}).action == "deny", cmd
    assert d("files_delete", {"path": "a.txt"}).action == "approve"
    assert d("files_read", {"path": "config/.env"}).action == "approve"
    assert d("files_read", {"path": "src/env.ts"}).action == "allow"
    assert d("git_run", {"args": ["push", "origin", "main"]}).action == "approve"
    # the same command in the VM is not affected by host-only rules
    assert policy.decide(BY_WIRE["shell_execute"], {"command": "open file.txt"}, level="ADVANCED", linux_user="x",
                         st=st, require_approval=True).action == "allow"


def test_host_tool_catalogue_has_no_gui_tools():
    from nebula_runtime.tools import allowed_tools

    host = {t.wire for t in allowed_tools("ADVANCED", None, env="host")}
    vm = {t.wire for t in allowed_tools("ADVANCED", None)}
    assert {"shell_execute", "git_run", "files_write", "task_complete", "memory_search"} <= host
    assert not {w for w in host if w.startswith(("desktop_", "browser_", "web_"))}
    assert "packages_install" not in host and "packages_install" in vm and "desktop_click" in vm
    assert "company_plan" not in vm and "company_plan" in {t.wire for t in allowed_tools(
        "READ_ONLY", None, contexts={"company_plan"})}


def test_sandbox_profile_scopes(tmp_path):
    from nebula_host import hostexec

    root, home = tmp_path / "proj", tmp_path / "home"
    p = hostexec.sandbox_profile(root, home, read_only=False, network=True)
    assert "(deny default)" in p and f'(subpath "{root}")' in p and "(allow network*)" in p
    assert '"com.apple.SecurityServer"' in p and '"com.apple.pasteboard.1"' in p
    ro = hostexec.sandbox_profile(root, home, read_only=True, network=False)
    write_rule = next(ln for ln in ro.splitlines() if ln.startswith("(allow file-write*"))
    assert str(root) not in write_rule and "(allow network*)" not in ro


def test_root_validation_rejects_broad_and_protected(dbinit, monkeypatch, tmp_path):
    from nebula_host import hostexec

    monkeypatch.delenv("NEBULA_TESTING")
    home = Path.home().resolve()
    for bad, code in ((str(home), "too_broad"), ("/etc", "forbidden_location"), (str(home / "Library"), "forbidden_location"),
                      ("/", "too_broad"), ("relative/path", "invalid_path"), (str(home / "no-such-dir-xyz"), "not_found")):
        with pytest.raises(hostexec.HostExecError) as e:
            hostexec.validate_root_path(dbinit, bad)
        assert e.value.code == code, bad


# ------------------------------------------------------------------------------------------- cards & levels
def test_card_lifecycle_and_levels():
    from nebula_telegram import cards

    assert cards.lifecycle({"state": "PLANNING", "current_step": 0}) == "PREPARING"
    assert cards.lifecycle({"state": "EXECUTING", "current_step": 2}) == "RUNNING"
    assert cards.lifecycle({"state": "WAITING_APPROVAL"}) == "WAITING_FOR_APPROVAL"
    assert cards.lifecycle({"state": "RECEIVED"}) == "QUEUED"
    assert cards.wants("important", "completion") and not cards.wants("important", "progress")
    assert cards.wants("errors", "failure") and not cards.wants("errors", "completion")
    assert not cards.wants("silent", "failure") and cards.wants("silent", "approval")
    assert cards.wants("all", "progress")


def test_callback_tag_binds_approval_bot_and_chat(dbinit):
    from nebula_telegram import cards

    t = cards.tag("ap1", "y", "main", 7)
    assert cards.check_tag(t, "ap1", "y", "main", 7)
    assert not cards.check_tag(t, "ap1", "n", "main", 7) and not cards.check_tag(t, "ap1", "y", "main", 8)
    assert not cards.check_tag(t, "ap2", "y", "main", 7) and not cards.check_tag(t, "ap1", "y", "bot-x", 7)
    btns = cards.approval_buttons("ap1", "main", 7)
    assert all(len(b["callback_data"]) <= 64 for b in btns)
