"""Deterministic action policy (spec §5.3).

Every tool call is classified into risk categories. Categories requiring approval pause the task until the
owner decides. Once a category is DENIED within a task, every later action in that category — through ANY
tool — is auto-denied, so the agent cannot route around a refusal (e.g. shell `curl -d` after a denied
browser "Send" click).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from nebula_runtime.tools import LEVELS, Tool

APPROVAL_CATEGORIES = {"privileged", "mass_delete", "external_share", "payment", "credential_entry",
                       "outbound_message", "system_change", "system_install", "host_delete", "sensitive_file",
                       "account_security", "data_export"}
# V3.2 action-risk policy: account takeover-grade actions ALWAYS need the owner, even with relaxed approvals, and
# after a Password Vault sign-in every sensitive category does (a login is not a licence for everything after it).
ALWAYS_APPROVE_CATEGORIES = {"account_security"}
VAULT_SESSION_APPROVE = {"payment", "outbound_message", "external_share", "credential_entry", "account_security",
                         "data_export", "mass_delete"}
FORBIDDEN_CATEGORIES = {"secret_access", "cross_agent"}

SHELL_RULES: list[tuple[str, re.Pattern[str]]] = [
    ("privileged", re.compile(r"(^|[;&|`(\s])(sudo|su|doas|pkexec)(\s|$)")),
    ("system_install", re.compile(r"\b(apt|apt-get|dpkg|snap)\s+(install|remove|purge)\b|\bpip3?\s+install\b(?!.*(--user|venv|-t\s))")),
    ("mass_delete", re.compile(r"\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\b|\bfind\b.*\s-delete\b|\bshred\b|\btruncate\s+-s\s*0")),
    ("external_share", re.compile(r"\b(scp|sftp|rsync|ssh|nc|ncat|socat|ftp)\s|\bgit\s+push\b|\bcurl\b.*(\s-d\s|--data|-F\s|--form|-T\s|--upload-file|-X\s*(POST|PUT|PATCH))|\bwget\b.*--post")),
    ("outbound_message", re.compile(r"\b(mail|mailx|sendmail|mutt|swaks)\b")),
    ("system_change", re.compile(r"\b(shutdown|reboot|poweroff|halt|mkfs\S*|fdisk|parted|crontab|systemctl|init)\b|\bdd\s+if=|:\(\)\s*\{")),
    ("privileged", re.compile(r"\bchmod\s+[0-7]*[4-7][0-7]{3}\b|\bchown\b")),
    ("external_share", re.compile(r"\|\s*(ba|z|da)?sh\b")),  # curl ... | sh
]
# Native macOS execution (V3): extra rules on top of SHELL_RULES. The Seatbelt sandbox already blocks files outside
# the project, Keychain and other apps; these rules make the owner approve what remains high-impact.
HOST_SHELL_RULES: list[tuple[str, re.Pattern[str]]] = [
    ("system_change", re.compile(r"\b(osascript|launchctl|defaults\s+(write|delete)|networksetup|scutil|systemsetup|"
                                 r"pmset|csrutil|spctl|tccutil|diskutil|kextload|profiles|dscl|sysadminctl|killall)\b")),
    ("system_change", re.compile(r"(^|[;&|`(\s])open\s")),
    ("secret_access", re.compile(r"\bsecurity\s+(find|dump|export|unlock)|Library/Keychains|\.ssh/|\.gnupg|\.aws/|"
                                 r"Library/Application Support/NEBULA")),
    ("system_install", re.compile(r"\bbrew\s+(install|uninstall|reinstall|upgrade|tap|link)\b|"
                                  r"\b(npm|pnpm|yarn)\s+(i|install|add|remove|uninstall)\b.*(-g\b|--global)|"
                                  r"\bgem\s+install\b|\bsoftwareupdate\b|\bxcode-select\s+-(s|r|switch|install)")),
    ("mass_delete", re.compile(r"\bgit\s+(clean\s+-[a-z]*[fdx]|reset\s+--hard|push\s+.*(--force|-f\b))")),
]
HOST_SECRET_FILE = re.compile(r"(^|/)(\.env(\.[\w.-]+)?|id_(rsa|dsa|ecdsa|ed25519)|[^/\s]*\.(pem|key|p12|pfx|keystore|"
                              r"jks)|\.npmrc|\.pypirc|\.netrc|\.git-credentials|credentials(\.json)?|"
                              r"secrets?\.(json|ya?ml|toml))$", re.I)
# Command text is split into word-like pieces on shell and code punctuation so `cat .env`, `base64 < ./.env`,
# `"$(cat config/credentials.json)"` and open('.env') all expose the file name to HOST_SECRET_FILE. This is a
# tripwire for the obvious cases, not a boundary: globbing (`.en?`), variables and computed names are not seen.
_CMD_PIECES = re.compile(r"[\s'\"`;&|<>(){}\[\]=,:$\\]+")
_CODE_STRINGS = re.compile(r"(['\"`])((?:\\.|(?!\1).){1,400})\1", re.S)


def secret_file_refs(text: str, *, code: bool = False) -> list[str]:
    """File names in shell (or, with code=True, string literals in Python/JS) that match HOST_SECRET_FILE."""
    if code:
        chunks = [m.group(2) for m in _CODE_STRINGS.finditer(text or "")]
    else:
        chunks = [text or ""]
    found = []
    for chunk in chunks:
        for piece in _CMD_PIECES.split(chunk):
            piece = piece.strip().rstrip(".")
            if piece and HOST_SECRET_FILE.search(piece):
                found.append(piece)
    return found


_SHELL_SEPARATORS = {";", "&", "&&", "|", "||", "|&", "(", ")", "((", "))", "{", "}", "!", "`", "<(", ">(",
                     "then", "do", "else", "elif", "if", "while", "until", "fi", "done", "esac", "time"}
# Programs that run the NEXT word as a program: both are reported; their own options/numbers are skipped.
_SHELL_WRAPPERS = {"env", "exec", "command", "builtin", "nohup", "nice", "timeout", "xargs", "sudo", "doas",
                   "caffeinate", "arch", "stdbuf", "chronic", "time"}
# Run code from a string or a file: what they execute cannot be read from the command line.
_SHELL_OPAQUE = {"eval", "source", ".", "bash", "sh", "zsh", "dash", "ksh", "fish", "csh", "tcsh", "osascript",
                 "for", "case", "select", "function", "coproc", "trap"}
# Bash control and redirection operators, longest first. The lexer hands over a run of operator characters as one
# token (`&>>(`, `;>(`, `>&>(`), so it is split the way bash reads it, one operator at a time (audit NEW-4).
_SHELL_OPERATORS = (";;&", "&>>", "<<<", ";;", ";&", "&&", "||", "|&", "&>", "<<", "<>", "<&", "<(", ">>", ">&", ">|",
                    ">(", ";", "&", "|", "(", ")", "<", ">", "`")
_SHELL_OPERATOR_CHARS = frozenset(";&|()<>`")
# Operators whose next word is a file name, an fd or a here-document delimiter, not a program.
_SHELL_REDIRECTS = {"<", ">", ">>", "<<", "<<<", "<>", "<&", ">&", ">|", "&>", "&>>"}
_ASSIGN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*\+?=")
_WRAPPER_NUMBER = re.compile(r"^\d+(\.\d+)?[smhd]?$")  # `timeout 5 git x`, `nice 10 git x`
# Options of each wrapper, so the VALUE of an option that takes one is not taken for the program (`exec -a git python3`,
# `env -u git python3`, `xargs -I git python3`; review R12-1). "val": short option letters (and whole `-word` options)
# that take a value, joined (`-ugit`) or as the next word; "flag": short letters without one; "long_val" / "long_flag":
# `--name` options (a joined `--name=value` is fine for both); "unsafe": options whose value is itself a command
# line, which this parser cannot read. Anything not listed fails closed: the whole line is "cannot be checked".
_WRAPPER_OPTIONS: dict[str, dict[str, Any]] = {
    "env": {"val": "uPC", "flag": "i0v", "long_val": {"unset", "chdir", "argv0"},
            "long_flag": {"ignore-environment", "null", "debug"}, "unsafe": {"S", "split-string"}},
    "exec": {"val": "a", "flag": "cl"},
    "command": {"flag": "pvV"},
    "builtin": {},
    "nohup": {},
    "nice": {"val": "n", "flag": "0123456789", "long_val": {"adjustment"}},
    "timeout": {"val": "sk", "flag": "fpv", "long_val": {"signal", "kill-after"},
                "long_flag": {"foreground", "preserve-status", "verbose"}},
    "xargs": {"val": "IJELnPRsSda", "flag": "0optrvxiel",
              "long_val": {"max-args", "max-procs", "max-lines", "max-chars", "delimiter", "arg-file",
                           "process-slot-var", "replace", "eof"},
              "long_flag": {"null", "no-run-if-empty", "verbose", "interactive", "open-tty", "exit", "show-limits"}},
    "sudo": {"val": "ugphCDRTUrt", "flag": "AbEeHiKklnPSsvVBN"},
    "doas": {"val": "uC", "flag": "nsL"},
    "caffeinate": {"val": "tw", "flag": "dimsu"},
    "arch": {"val": "de", "flag": "c", "words": {"-arch": True, "-x86_64": False, "-x86_64h": False, "-arm64": False,
                                                 "-arm64e": False, "-i386": False}},
    "stdbuf": {"val": "ioe", "long_val": {"input", "output", "error"}},
    "chronic": {"flag": "evn"},
}


def _wrapper_option(wrapper: str, tok: str) -> str:
    """How wrapper `wrapper` reads the option word `tok`: "flag" (nothing follows), "value" (the next word is its
    value) or "unknown" (cannot be classified: the caller refuses the whole line)."""
    spec = _WRAPPER_OPTIONS.get(wrapper, {})
    if tok in spec.get("words", {}):
        return "value" if spec["words"][tok] else "flag"
    if tok.startswith("--"):
        name, eq, _ = tok[2:].partition("=")
        if name in spec.get("unsafe", ()):
            return "unknown"
        if name in spec.get("long_val", ()):
            return "flag" if eq else "value"
        if name in spec.get("long_flag", ()) and not eq:
            return "flag"
        return "unknown"
    letters = tok[1:]
    if not letters:
        return "unknown"  # a lone `-`
    for i, ch in enumerate(letters):
        if ch in spec.get("unsafe", ()):
            return "unknown"
        if ch in spec.get("val", ""):
            return "flag" if letters[i + 1:] else "value"  # `-ugit` carries its value, `-u git` does not
        if ch not in spec.get("flag", ""):
            return "unknown"
    return "flag"


# Shell builtins and plain text utilities that do not start other programs: always allowed next to the project's
# allowed tools (`make && echo ok`, `git log | head`). awk, find, xargs, sed -e with GNU `e` etc. are NOT here.
SHELL_BASIC = {"cd", "echo", "printf", "pwd", "true", "false", ":", "export", "unset", "set", "read", "exit",
               "return", "shift", "wait", "sleep", "test", "cat", "head", "tail", "wc", "grep", "egrep", "fgrep",
               "sort", "uniq", "cut", "tr", "ls", "tee", "diff", "cmp", "basename", "dirname", "mkdir", "touch",
               "date", "which", "file", "stat", "realpath", "sed", "column", "nl", "rev", "fold", "expand"}


def _shell_operators(tok: str) -> list[str]:
    """`&>>(` -> ["&>>", "("], `>&>(` -> [">&", ">("], `2>&1`'s `>&` -> [">&"] (longest match, left to right)."""
    ops: list[str] = []
    i = 0
    while i < len(tok):
        op = next(o for o in _SHELL_OPERATORS if tok.startswith(o, i))  # every single operator char is listed
        ops.append(op)
        i += len(op)
    return ops


def shell_command_names(command: str) -> list[str] | None:
    """Basenames of every program a shell command line would start, e.g. `git status; python3 -c x | wc` ->
    ["git", "python3", "wc"]. Wrappers (env, xargs, timeout, ...) report both themselves and what they run.

    Returns None when the line cannot be analysed reliably: unbalanced quotes, a program name built from a
    variable, glob or substitution, a substitution inside quotes, or anything that runs code from a string or a file
    (eval, source, bash/sh/zsh, for/case, ...). An allow-list check must refuse None. Used by the host
    `allowed_tools` filter (audit VM-08); the Seatbelt sandbox, not this parser, is the security boundary."""
    import shlex

    text = command.replace("\\\r\n", " ").replace("\\\n", " ").replace("\r", "\n").replace("\n", " ; ")
    lex = shlex.shlex(text.replace("`", " ` "), posix=True, punctuation_chars=";&|()<>")
    lex.whitespace_split = True
    lex.commenters = ""
    try:
        tokens = list(lex)
    except ValueError:
        return None
    names: list[str] = []
    expect_cmd = True
    after_wrapper = False
    wrapper = ""  # the wrapper whose options are being read (only while after_wrapper)
    wrapper_value = False  # the previous word was a wrapper option that takes this word as its value
    wrapper_options = True  # false after `--`
    skip_redirect_target = False
    for tok in tokens:
        if "$(" in tok or "`" in tok.strip("`"):
            return None  # a substitution inside a quoted word (also as a redirect target): not visible here
        if tok and set(tok) <= _SHELL_OPERATOR_CHARS:
            for op in _shell_operators(tok):
                if op in _SHELL_REDIRECTS:
                    skip_redirect_target = True  # `> out.txt`, `2>&1`: the next word is a file or fd
                else:
                    # a separator, a subshell, a backtick or a process substitution: a command follows, also in the
                    # redirect-target position (`> >(cmd)`, `< <(cmd)`, `&>>(cmd)`, `> \`cmd\``) (audit NEW-4)
                    expect_cmd, after_wrapper, skip_redirect_target = True, False, False
                    wrapper_value = False
            continue
        if skip_redirect_target:
            skip_redirect_target = False
            continue  # a plain word after a redirect: a file name, an fd or a here-document delimiter
        if tok in _SHELL_SEPARATORS:
            expect_cmd, after_wrapper, wrapper_value = True, False, False
            continue
        if not expect_cmd:
            continue
        if after_wrapper and wrapper_value:  # the value of `exec -a NAME` / `env -u NAME` / `xargs -I STR`: no program
            wrapper_value = False
            continue
        if _ASSIGN.match(tok):  # FOO=bar cmd
            continue
        if after_wrapper and wrapper_options and tok == "--":
            wrapper_options = False
            continue
        if after_wrapper and wrapper_options and tok.startswith("-"):  # nice -n 10 / env -i / timeout -s KILL 5
            kind = _wrapper_option(wrapper, tok)
            if kind == "unknown":
                return None  # an option this parser cannot classify: what follows may or may not be the program
            wrapper_value = kind == "value"
            continue
        if after_wrapper and _WRAPPER_NUMBER.match(tok):  # timeout 5
            continue
        if not tok or any(c in tok for c in "$`*?[]{}~\\"):
            return None  # the program name is only known after the shell expands it
        name = tok.rsplit("/", 1)[-1]
        if not name or name in _SHELL_OPAQUE:
            return None
        names.append(name)
        after_wrapper = expect_cmd = name in _SHELL_WRAPPERS
        wrapper, wrapper_value, wrapper_options = name, False, True
    return names


def allowed_tools_violation(command: str, allowed: list[str] | set[str] | tuple[str, ...]) -> str | None:
    """The host per-project allow-list applied to the WHOLE command line (audit VM-08), not just its first word.
    Returns None when every program is an allowed tool or a SHELL_BASIC utility, else the reason to refuse.
    An empty allow-list means "no restriction"."""
    if not allowed:
        return None
    names = shell_command_names(command)
    if names is None:
        return ("this command cannot be checked against the project's allowed tools (shell scripts, eval, "
                "variables or substitutions as program names); run an allowed tool directly")
    ok = set(allowed) | SHELL_BASIC | (_SHELL_WRAPPERS - {"sudo", "doas"})
    bad = sorted({n for n in names if n not in ok})
    if bad:
        return f"{', '.join(bad)} not in this project's allowed tools ({', '.join(sorted(allowed))})"
    return None


SECRET_PATHS = re.compile(r"/etc/(shadow|gshadow|sudoers|nebula)|/opt/nebula/guest|rpc\.key|\.ssh/|/root\b")
OTHER_HOME = re.compile(r"/home/(?!{self})[A-Za-z0-9_.-]+")
PAY_WORDS = re.compile(r"\b(buy|pay|purchase|checkout|place order|order now|subscribe|donate|zaplatit|koupit|objednat|"
                       r"platba|pay now|confirm payment)\b", re.I)
SEND_WORDS = re.compile(r"\b(send|odeslat|publish|post|tweet|submit message|reply all|share)\b", re.I)
LOGIN_WORDS = re.compile(r"\b(sign in|log in|login|přihlásit|authorize|allow access)\b", re.I)
ACCOUNT_SECURITY = re.compile(
    r"(change|reset|update|new|set|změnit|nové)[\s_-]*(password|passphrase|heslo)|"
    r"(disable|turn off|remove|deactivate|vypnout)[\s_-]*(2fa|mfa|two[\s-]factor|authenticator|security key|passkey)|"
    r"(two[\s-]factor|2fa|mfa)[\s_-]*(settings|disable|off)|"
    r"recovery[\s_-]*(email|e-mail|phone|code|codes)|backup[\s_-]*codes|"
    r"(delete|close|deactivate|smazat|zrušit)[\s_-]*(my[\s_-]*)?(account|účet)|"
    r"/settings/(security|password|auth|two_factor|2fa)|/account/(security|password|delete)|"
    r"security[\s_-]*(settings|questions)|(add|change)[\s_-]*(email|phone)[\s_-]*address", re.I)
DATA_EXPORT = re.compile(r"(export|download)[\s_-]*(my[\s_-]*|all[\s_-]*|your[\s_-]*)?(data|archive|account data|"
                         r"personal data)|takeout|gdpr[\s_-]*(request|export)", re.I)
CARD_RE = re.compile(r"\b(?:\d[ -]?){13,19}\b")
CODE_NET_WRITE = re.compile(r"\b(requests|httpx|aiohttp|session)\.(post|put|patch|delete)\b|urlopen\([^)]*data=|"
                            r"\bsmtplib\b|method\s*:\s*['\"](POST|PUT|PATCH|DELETE)|\bsubprocess\b.*\bsudo\b", re.I)
CODE_SHELL_OUT = re.compile(r"\b(os\.system|subprocess\.|child_process|execSync|spawnSync)\b")

# Human-readable "when does this need approval" for the permission matrix shown in the dashboard.
TOOL_RISKS = {
    "shell_execute": "sudo/su, package installs, recursive deletes, uploads/curl POST, ssh/scp, mail, system changes",
    "process_start": "same rules as shell_execute",
    "python_run": "network writes (POST/PUT, SMTP), shell-outs matching shell rules, card numbers",
    "node_run": "network writes (POST/PUT), shell-outs matching shell rules, card numbers",
    "git_run": "git push (external share)",
    "github_api": "any non-GET request (external share)",
    "files_delete": "recursive=true (mass delete)",
    "packages_install": "always",
    "browser_click": "payment / send / publish buttons, sign-in with a password field on the page",
    "browser_type": "password fields, card numbers, submitting payment forms",
    "desktop_type": "card numbers",
    "files_write": "card numbers in content",
}
HOST_RISKS = {
    "files_delete": "always (host_delete)", "files_move": "overwrite=true", "files_copy": "overwrite=true",
    "files_read": ".env / keys / credentials files", "shell_execute": "osascript, open, launchctl, defaults write, "
    "brew/npm -g installs, git clean/reset --hard, sudo, rm -r, uploads, .env / keys / credentials files named in "
    "the command; Keychain/~/.ssh access is forbidden",
    "git_run": "push, clean, reset --hard", "python_run": "network writes, shell-outs matching shell rules, "
    ".env / keys / credentials file names in the code",
}


def luhn_ok(digits: str) -> bool:
    d = [int(c) for c in digits if c.isdigit()]
    if not 13 <= len(d) <= 19:
        return False
    s = 0
    for i, n in enumerate(reversed(d)):
        if i % 2 == 1:
            n *= 2
            if n > 9:
                n -= 9
        s += n
    return s % 10 == 0


def has_card_number(text: str) -> bool:
    return any(luhn_ok(m.group(0)) for m in CARD_RE.finditer(text or ""))


@dataclass
class Decision:
    action: str  # allow | approve | deny
    categories: list[str] = field(default_factory=list)
    reason: str = ""


@dataclass
class TaskPolicyState:
    denied_categories: set[str] = field(default_factory=set)
    approved_categories: set[str] = field(default_factory=set)  # approval is per action; kept for audit
    vault_session: bool = False  # the task signed in through the Password Vault broker
    last_observe_elements: list[dict[str, Any]] = field(default_factory=list)


def classify_host(tool: Tool, args: dict[str, Any]) -> set[str]:
    cats: set[str] = set()
    text = " ".join(str(v) for v in args.values() if isinstance(v, (str, int))) + " " + \
        " ".join(str(a) for a in (args.get("args") or []))
    if tool.wire in ("shell_execute", "process_start") or (tool.wire in ("python_run", "node_run")
                                                           and CODE_SHELL_OUT.search(str(args.get("code", "")))):
        for cat, rx in HOST_SHELL_RULES:
            if rx.search(text):
                cats.add(cat)
    if tool.wire == "files_delete":
        cats.add("host_delete")  # deleting anything in a real project on the Mac needs the owner
    if tool.wire in ("files_move", "files_copy") and args.get("overwrite"):
        cats.add("host_delete")
    if tool.wire in ("files_read", "files_copy", "files_move", "pdf_text", "files_write", "files_edit"):
        for k in ("path", "src", "dst"):
            if HOST_SECRET_FILE.search(str(args.get(k) or "").strip()):
                cats.add("sensitive_file")
    # the same secret-file rule for files a command or a code snippet names (audit VM-04): a tripwire for
    # `cat .env`, `curl ...$(base64 < .env)`, open(".env"); not a boundary (globs or computed names pass)
    if tool.wire in ("shell_execute", "process_start") and secret_file_refs(str(args.get("command", ""))):
        cats.add("sensitive_file")
    if tool.wire in ("python_run", "node_run") and (
            secret_file_refs(str(args.get("code", "")), code=True)
            or secret_file_refs(" ".join(str(a) for a in (args.get("args") or [])))):
        cats.add("sensitive_file")
    if tool.wire == "git_run":
        argv = [str(a) for a in (args.get("args") or [])]
        if argv[:1] == ["clean"] or argv[:2] == ["reset", "--hard"] or (argv[:1] == ["push"] and
                                                                         any(a in ("-f", "--force") for a in argv)):
            cats.add("mass_delete")
    return cats


def classify(tool: Tool, args: dict[str, Any], linux_user: str, st: TaskPolicyState, env: str = "vm") -> list[str]:
    cats: set[str] = set()
    if env == "host":
        cats |= classify_host(tool, args)
    blob = " ".join(str(v) for v in args.values())
    if SECRET_PATHS.search(blob):
        cats.add("secret_access")
    for m in re.finditer(r"/home/([A-Za-z0-9_.-]+)", blob):
        if m.group(1) != linux_user and env != "host":
            cats.add("cross_agent")
    if tool.wire == "shell_execute":
        cmd = str(args.get("command", ""))
        for cat, rx in SHELL_RULES:
            if rx.search(cmd):
                cats.add(cat)
        if has_card_number(cmd):
            cats.add("payment")
    elif tool.wire in ("browser_type", "desktop_type"):
        text = str(args.get("text", ""))
        if has_card_number(text):
            cats.add("payment")
        if ACCOUNT_SECURITY.search(str(args.get("selector", ""))):
            cats.add("account_security")
        sel = str(args.get("selector", ""))
        el = next((e for e in st.last_observe_elements if e.get("ref") == sel), None)
        if (el and el.get("type") == "password") or re.search(r"type=['\"]?password|password", sel, re.I):
            cats.add("credential_entry")
        if args.get("submit") and el and PAY_WORDS.search(el.get("text", "")):
            cats.add("payment")
    elif tool.wire == "browser_click":
        sel = str(args.get("selector", ""))
        el = next((e for e in st.last_observe_elements if e.get("ref") == sel), None)
        label = (el or {}).get("text", "") + " " + sel
        if ACCOUNT_SECURITY.search(label):
            cats.add("account_security")
        if DATA_EXPORT.search(label):
            cats.add("data_export")
        if PAY_WORDS.search(label):
            cats.add("payment")
        if SEND_WORDS.search(label):
            cats.add("outbound_message")
        if LOGIN_WORDS.search(label) and any(e.get("type") == "password" for e in st.last_observe_elements):
            cats.add("credential_entry")
    elif tool.wire == "browser_navigate":
        url = str(args.get("url", ""))
        if ACCOUNT_SECURITY.search(url):
            cats.add("account_security")
        if DATA_EXPORT.search(url):
            cats.add("data_export")
    elif tool.wire in ("files_write", "files_edit"):
        if has_card_number(str(args.get("content", "")) + " " + str(args.get("replace", ""))):
            cats.add("payment")
    elif tool.wire == "process_start":
        cmd = str(args.get("command", ""))
        for cat, rx in SHELL_RULES:
            if rx.search(cmd):
                cats.add(cat)
    elif tool.wire in ("python_run", "node_run"):
        code = str(args.get("code", ""))
        if CODE_NET_WRITE.search(code):
            cats.add("external_share")
        if CODE_SHELL_OUT.search(code):
            for cat, rx in SHELL_RULES:
                if rx.search(code):
                    cats.add(cat)
        if has_card_number(code):
            cats.add("payment")
    elif tool.wire == "files_delete":
        if args.get("recursive"):
            cats.add("mass_delete")
    elif tool.wire == "git_run":
        argv = args.get("args") or []
        if argv and argv[0] == "push":
            cats.add("external_share")
    elif tool.wire == "github_api":
        if str(args.get("method", "GET")).upper() != "GET":
            cats.add("external_share")
    elif tool.wire == "packages_install":
        cats.add("system_install")
    elif tool.wire.startswith("plug_"):
        cats.update(c for c in getattr(tool, "plugin_risks", ()) if c in APPROVAL_CATEGORIES)
    return sorted(cats)


def decide(tool: Tool, args: dict[str, Any], *, level: str, linux_user: str, st: TaskPolicyState,
           require_approval: bool, env: str = "vm") -> Decision:
    if LEVELS.index(tool.min_level) > LEVELS.index(level if level in LEVELS else "READ_ONLY"):
        return Decision("deny", [], f"tool {tool.wire} needs permission level {tool.min_level} (agent has {level})")
    cats = classify(tool, args, linux_user, st, env)
    forbidden = [c for c in cats if c in FORBIDDEN_CATEGORIES]
    if forbidden:
        return Decision("deny", cats, f"forbidden: {', '.join(forbidden)} (other agents' data and NEBULA secrets "
                                      "are never accessible)")
    previously_denied = [c for c in cats if c in st.denied_categories]
    if previously_denied:
        return Decision("deny", cats, f"the owner already denied {', '.join(previously_denied)} in this task; "
                                      "equivalent actions through any tool are blocked")
    needs = [c for c in cats if c in APPROVAL_CATEGORIES]
    always = [c for c in needs if c in ALWAYS_APPROVE_CATEGORIES or (st.vault_session and c in VAULT_SESSION_APPROVE)]
    if always:
        return Decision("approve", cats, f"high-risk account action needs the owner's approval: {', '.join(always)}")
    if env == "host" and needs:  # native Mac execution: high-impact actions ALWAYS need the owner
        return Decision("approve", cats, f"host action needs the owner's approval: {', '.join(needs)}")
    if tool.always_approve and needs:
        return Decision("approve", cats, f"always requires the owner's approval: {', '.join(needs)}")
    if needs and require_approval:
        return Decision("approve", cats, f"sensitive action: {', '.join(needs)}")
    return Decision("allow", cats)


def sanitize_args(args: dict[str, Any]) -> dict[str, Any]:
    """For logs/audit: mask card numbers and long payloads; never store typed passwords."""
    out: dict[str, Any] = {}
    for k, v in args.items():
        if isinstance(v, str):
            s = CARD_RE.sub(lambda m: "[CARD]" if luhn_ok(m.group(0)) else m.group(0), v)
            if k == "text" and "password" in str(args.get("selector", "")).lower():
                s = "[REDACTED]"
            out[k] = s if len(s) <= 2000 else s[:2000] + f"…(+{len(s) - 2000})"
        else:
            out[k] = v
    return out
