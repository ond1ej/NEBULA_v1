"""Release docs and CI hygiene (fix round "docs").

* Every relative link, image and #anchor in the repository's Markdown resolves (GitHub slug rules), the README
  screenshots included.
* The gitleaks allowlist hides exactly one synthetic fixture value in one file, nothing else.
* `make lint` and the CI lint step syntax-check every tracked shell script one by one (`bash -n a b` checks only `a`).
* The release workflow refuses a tag whose version differs from the package versions.
* Statements the docs must no longer make, and facts they must keep in sync with the code.
"""

from __future__ import annotations

import glob
import hashlib
import json
import os
import re
import shutil
import subprocess
import tomllib
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import unquote

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]

# README screenshots: made in a later phase with exactly these names (docs/images/*.png).
PENDING_SCREENSHOTS: set[str] = set()  # every README screenshot is in docs/images now; nothing may be missing
SKIP_DIRS = {".git", ".venv", "node_modules", "build", "dist", ".build", "__pycache__", ".pytest_cache", ".ruff_cache",
             "DerivedData", ".swiftpm"}


def _markdown_files() -> list[Path]:
    out = []
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        out += [Path(dirpath) / f for f in filenames if f.endswith(".md")]
    return sorted(out)


_FENCE = re.compile(r"^\s*(```|~~~)")


def _strip_code(text: str) -> list[str]:
    """Lines outside fenced code blocks, with inline code spans removed."""
    lines, fenced = [], False
    for line in text.splitlines():
        if _FENCE.match(line):
            fenced = not fenced
            lines.append("")
            continue
        lines.append("" if fenced else re.sub(r"`[^`]*`", "", line))
    return lines


def _slug(heading: str) -> str:
    t = re.sub(r"<[^>]+>", "", heading.strip().lower())
    t = re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", t)
    t = re.sub(r"[^\w\- ]", "", t.replace("`", ""))
    return t.replace(" ", "-")


def _anchors(md: Path) -> set[str]:
    seen: dict[str, int] = {}
    out = set()
    fenced = False
    for line in md.read_text(encoding="utf-8").splitlines():
        if _FENCE.match(line):
            fenced = not fenced
            continue
        if fenced:
            continue
        m = re.match(r"^#{1,6}\s+(.*?)\s*#*\s*$", line)
        if m:
            base = _slug(m.group(1))
            n = seen.get(base, 0)
            seen[base] = n + 1
            out.add(base if n == 0 else f"{base}-{n}")
        out.update(re.findall(r"""<a\s+(?:name|id)=["']([^"']+)["']""", line))
    return out


_LINK = re.compile(r"\]\(\s*<?([^)\s>]+)>?(?:\s+\"[^\"]*\")?\s*\)")
_HTML = re.compile(r"""<(?:img|a)\s[^>]*?(?:src|href)=["']([^"']+)["']""")
_REFDEF = re.compile(r"^\s*\[[^\]]+\]:\s*(\S+)")


def _targets(md: Path) -> list[tuple[int, str]]:
    out = []
    for i, line in enumerate(_strip_code(md.read_text(encoding="utf-8")), 1):
        for rx in (_LINK, _HTML, _REFDEF):
            out += [(i, m) for m in rx.findall(line)]
    return out


def _broken_links() -> list[str]:
    broken = []
    for md in _markdown_files():
        for line, target in _targets(md):
            if re.match(r"^[a-z][a-z0-9+.-]*:", target, re.I):  # http:, https:, mailto:, ...
                continue
            path, _, anchor = target.partition("#")
            dest = md if not path else (md.parent / unquote(path)).resolve()
            rel = os.path.relpath(dest, ROOT)
            if not dest.exists():
                if rel not in PENDING_SCREENSHOTS:
                    broken.append(f"{md.relative_to(ROOT)}:{line}: {target} (missing)")
                continue
            if anchor and dest.suffix == ".md" and unquote(anchor).lower() not in _anchors(dest):
                broken.append(f"{md.relative_to(ROOT)}:{line}: {target} (no such anchor)")
    return broken


def test_markdown_links_and_anchors_resolve():
    assert _broken_links() == []


def test_slug_rules_match_github():
    assert _slug("`config.yaml`") == "configyaml"
    assert _slug("3. Start the gateway with Tailscale Serve") == "3-start-the-gateway-with-tailscale-serve"
    assert _slug("Telegram Mini App: Tailscale Funnel and other public tunnels") == \
        "telegram-mini-app-tailscale-funnel-and-other-public-tunnels"
    assert _slug("What `install.sh` does") == "what-installsh-does"


README_SCREENSHOTS = {f"docs/images/{n}" for n in (
    "banner.png", "agent-run.gif", "dashboard.png", "agents.png", "create-agent.png", "agent-detail.png",
    "task-running.png", "live-desktop.png", "take-control.png", "providers.png", "onboarding.png", "ios-app.png",
    "remote-access.png", "approvals.png")}


def _png_chunks(data: bytes) -> list[bytes]:
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    out, i = [], 8
    while i + 8 <= len(data):
        n = int.from_bytes(data[i:i + 4], "big")
        out.append(data[i + 4:i + 8])
        i += 12 + n
    return out


def test_readme_images_are_the_release_screenshots_plus_a_real_architecture_diagram():
    refs = {t for _, t in _targets(ROOT / "README.md") if t.startswith("docs/images/")}
    assert refs == README_SCREENSHOTS | {"docs/images/architecture.svg"}
    for rel in README_SCREENSHOTS:
        data = (ROOT / rel).read_bytes()
        if rel.endswith(".png"):
            # screenshots carry no text, EXIF or time metadata (nothing about the machine they were taken on)
            chunks = set(_png_chunks(data))
            assert not chunks & {b"tEXt", b"iTXt", b"zTXt", b"eXIf", b"tIME"}, rel
    svg = ET.parse(ROOT / "docs/images/architecture.svg").getroot()
    assert svg.tag == "{http://www.w3.org/2000/svg}svg"
    text = " ".join(t.text or "" for t in svg.iter("{http://www.w3.org/2000/svg}text"))
    for part in ("Host API", "Remote gateway", "Web dashboard", "Mini App", "nebula-vm helper", "virtio-vsock",
                 "nebula-guest service", "Xvnc", "Live broker", "Keychain", "AI providers", "Guest firewall"):
        assert part in text, part


# ------------------------------------------------------------------------------------------------ gitleaks
FIXTURE_FILE = "tests/unit/test_lifecycle_cli.py"
FIXTURE_VALUE = "abcdefgh12345"


def test_gitleaks_allowlists_are_narrow():
    cfg = tomllib.loads((ROOT / ".gitleaks.toml").read_text())
    lists = cfg["allowlists"]
    for al in lists:
        assert al.get("targetRules"), "every allowlist must name the rules it applies to"
        for p in al.get("paths", []):
            assert not p.rstrip("$").endswith((".*", "/", "/**")), f"allowlist paths must be single files: {p}"
    fixture = [al for al in lists if any("test_lifecycle_cli" in p for p in al.get("paths", []))]
    assert len(fixture) == 1
    al = fixture[0]
    assert al["condition"] == "AND" and al["regexTarget"] == "secret"
    assert al["regexes"] == [f"^{FIXTURE_VALUE}$"]
    assert FIXTURE_VALUE in (ROOT / FIXTURE_FILE).read_text()  # the allowlisted value is the test's own fixture


@pytest.mark.skipif(shutil.which("gitleaks") is None, reason="gitleaks is not installed")
def test_gitleaks_allowlist_hides_only_the_fixture(tmp_path):
    line = next(x for x in (ROOT / FIXTURE_FILE).read_text().splitlines()
                if FIXTURE_VALUE in x and "write_text" in x)
    other = line.replace(FIXTURE_VALUE, "qwertyuiop98765")
    scan = tmp_path / "scan"
    (scan / "tests/unit").mkdir(parents=True)
    (scan / FIXTURE_FILE).write_text(f"{line}\n{other}\n")  # same file: the other value must still be reported
    (scan / "tests/unit/test_other.py").write_text(f"{line}\n")  # same value elsewhere: must still be reported
    report = tmp_path / "report.json"
    subprocess.run(["gitleaks", "dir", ".", "--config", str(ROOT / ".gitleaks.toml"), "--redact", "--no-banner",
                    "--exit-code", "0", "--report-format", "json", "--report-path", str(report)],
                   cwd=scan, check=True, capture_output=True)
    found = sorted((f["File"], f["StartLine"]) for f in json.loads(report.read_text()))
    assert found == [(FIXTURE_FILE, 2), ("tests/unit/test_other.py", 1)]


# ------------------------------------------------------------------------------------------------ shell lint
def _tracked_shell_scripts() -> set[str]:
    r = subprocess.run(["git", "ls-files"], cwd=ROOT, capture_output=True, text=True)
    if r.returncode != 0:
        pytest.skip("not a git checkout")
    out = set()
    for f in r.stdout.splitlines():
        p = ROOT / f
        if not p.is_file():
            continue
        if f.endswith(".sh"):
            out.add(f)
            continue
        with p.open("rb") as fh:
            first = fh.readline(80)
        if re.match(rb"#!\s*\S*/(env\s+)?(ba)?sh\b", first):
            out.add(f)
    return out


def _expand(words: list[str]) -> set[str]:
    out = set()
    for w in words:
        w = re.sub(r"^\$\(wildcard (.*)\)$", r"\1", w)
        out.update(os.path.relpath(p, ROOT) for p in glob.glob(str(ROOT / w)))
    return out


def test_make_lint_checks_every_shell_script_one_by_one():
    mk = (ROOT / "Makefile").read_text()
    m = re.search(r"^SHELL_SCRIPTS :=((?:.*\\\n)*.*)$", mk, re.M)
    assert m, "Makefile must define SHELL_SCRIPTS"
    words = re.findall(r"\$\(wildcard [^)]+\)|[^\s\\]+", m.group(1))
    assert _tracked_shell_scripts() <= _expand(words)
    assert re.search(r'for f in \$\(SHELL_SCRIPTS\); do bash -n "\$\$f" \|\| exit 1; done', mk)


def test_ci_lint_checks_every_shell_script_one_by_one():
    wf = yaml.safe_load((ROOT / ".github/workflows/ci.yml").read_text())
    run = next(s["run"] for s in wf["jobs"]["python"]["steps"] if s.get("name") == "Lint")
    m = re.search(r"for f in (.*?); do\s*\n\s*bash -n \"\$f\"", run.replace("\\\n", " "), re.S)
    assert m, "the CI lint step must run bash -n once per file"
    assert _tracked_shell_scripts() <= _expand(m.group(1).split())
    loop = run[run.index("for f in"):]
    r = subprocess.run(["bash", "-e", "-c", loop], cwd=ROOT, capture_output=True, text=True)
    assert r.returncode == 0, r.stderr


# ------------------------------------------------------------------------------------------------ release
@pytest.mark.skipif(shutil.which("node") is None, reason="the release version check reads package.json with node")
def test_release_refuses_a_tag_that_differs_from_the_package_versions(tmp_path):
    wf = yaml.safe_load((ROOT / ".github/workflows/release.yml").read_text())
    script = next(s["run"] for s in wf["jobs"]["build"]["steps"] if s.get("name") == "Check tag and versions")
    for rel in ("pyproject.toml", "apps/host-api/nebula_host/config.py", "apps/dashboard/package.json", "CHANGELOG.md"):
        (tmp_path / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(ROOT / rel, tmp_path / rel)
    version = re.search(r'^version = "(.*)"$', (ROOT / "pyproject.toml").read_text(), re.M).group(1)
    out = tmp_path / "github-output"
    env = {**os.environ, "INPUT_TAG": f"v{version}", "GITHUB_REF_NAME": "", "GITHUB_OUTPUT": str(out)}

    def run():
        return subprocess.run(["bash", "-e", "-c", script], cwd=tmp_path, env=env, capture_output=True, text=True)

    ok = run()
    assert ok.returncode == 0, ok.stderr
    assert f"version={version}" in out.read_text()
    env["INPUT_TAG"] = "v9.9.9"
    bad = run()
    assert bad.returncode != 0 and "version mismatch" in bad.stderr
    assert "apple" not in script.lower() and "MARKETING_VERSION" not in script


def test_release_notes_carry_the_release_key_hash():
    wf = (ROOT / ".github/workflows/release.yml").read_text()
    assert "sha256sum guest/image-builder/keys/nebula-release-ed25519.pub" in wf


# ------------------------------------------------------------------------------------------------ docs vs code
PUBLIC_DOCS = [p for p in _markdown_files() if not str(p.relative_to(ROOT)).startswith("apps/dashboard/")]
STALE = {
    r"no egress filtering": "the VM blocks local-network egress (provision.sh firewall)",
    r"dashboard is never (exposed|published)": "an owner session reaches administration through the gateway",
    r"Node\.js 20\+|Node\.js 20 or later": "the dashboard build needs Node.js 20.19+ or 22.12+",
    r"port 53 to any": "DNS to local addresses goes only to the VM's resolvers",
    r"Xcode 16": "the Apple apps need Xcode 26 or later (iOS 26 and macOS 26 SDKs)",
    r"or open the pairing link": "opening or tapping the pairing link does not pair the app; only the QR scan or pasting it does",
    r"its Unix\s+sockets(?! \(except)": "the mDNSResponder socket stays allowed: say 'Unix sockets (except name resolution)'",
}


@pytest.mark.parametrize("pattern", sorted(STALE))
def test_docs_do_not_make_stale_claims(pattern):
    hits = [f"{p.relative_to(ROOT)}" for p in PUBLIC_DOCS if re.search(pattern, p.read_text(), re.I)]
    assert hits == [], STALE[pattern]


def test_security_md_publishes_the_current_release_key_hash():
    key = ROOT / "guest/image-builder/keys/nebula-release-ed25519.pub"
    assert hashlib.sha256(key.read_bytes()).hexdigest() in (ROOT / "SECURITY.md").read_text()


def test_lan_allow_file_in_the_docs_is_the_one_provisioning_creates():
    path = "/etc/nebula/firewall-lan-allow.nft"
    assert path in (ROOT / "guest/scripts/provision.sh").read_text()
    for doc in ("docs/configuration.md", "docs/security-model.md", "README.md", "SECURITY.md", "docs/limitations.md"):
        text = (ROOT / doc).read_text()
        assert path in text or "configuration.md#vm-network-access" in text, doc
    assert "## VM network access" in (ROOT / "docs/configuration.md").read_text()


def test_documented_node_minimum_matches_the_dashboard_engines():
    engines = json.loads((ROOT / "apps/dashboard/package.json").read_text())["engines"]["node"]
    assert "20.19" in engines
    for doc in ("README.md", "docs/installation.md", "CONTRIBUTING.md"):
        assert "20.19" in (ROOT / doc).read_text(), doc


def test_perf_test_writes_into_tmp_path_not_the_checkout():
    src = (ROOT / "tests/integration/test_perf_telegram.py").read_text()
    assert "build/perf" not in src and "tmp_path" in src
