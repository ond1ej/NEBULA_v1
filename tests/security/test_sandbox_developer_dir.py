"""The Seatbelt profile follows the active Xcode (`xcode-select -s`), read-only, and nothing else.

On a Mac whose active developer directory is not /Applications/Xcode.app (Xcode_16.4.app, Xcode-beta.app, the
GitHub macos-15 runner), the /usr/bin git / python3 shims load libxcrun from that bundle; without read access every
shim failed inside the sandbox with "file system sandbox blocked open()"."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest


def _bundle(base: Path, name: str) -> Path:
    lib = base / name / "Contents" / "Developer" / "usr" / "lib"
    lib.mkdir(parents=True)
    (lib / "libxcrun.txt").write_text("xcrun-probe")
    return base / name


def _link(tmp_path: Path, target: Path, name: str = "xcode_select_link") -> str:
    link = tmp_path / f"{name}.link"
    link.symlink_to(target)
    return str(link)


def test_active_developer_bundle_resolves_only_app_bundles(tmp_path, monkeypatch):
    from nebula_host import hostexec

    def resolve(target: Path, name: str) -> Path | None:
        return hostexec.active_developer_bundle(_link(tmp_path, target, name))

    b = _bundle(tmp_path, "Xcode_16.4.app")
    assert resolve(b / "Contents" / "Developer", "a") == b.resolve()
    clt = tmp_path / "CommandLineTools"
    clt.mkdir()
    assert resolve(clt, "b") is None  # not a bundle (/Library/Developer is readable through a fixed rule)
    assert resolve(tmp_path / "Gone.app" / "Contents" / "Developer", "c") is None  # dangling link
    assert resolve(b, "d") is None  # the bundle itself, not <bundle>/Contents/Developer
    assert hostexec.active_developer_bundle(str(tmp_path / "no-link")) is None
    # a bundle inside the user's home is accepted only under ~/Applications
    fake_home = tmp_path / "home"
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: fake_home))
    lib = _bundle(fake_home / "Library", "Xcode.app")
    apps = _bundle(fake_home / "Applications", "Xcode-beta.app")
    assert resolve(lib / "Contents" / "Developer", "e") is None
    assert resolve(apps / "Contents" / "Developer", "f") == apps.resolve()


def test_profile_grants_the_active_bundle_read_only_and_quoted(tmp_path, monkeypatch):
    from nebula_host import hostexec

    b = _bundle(tmp_path, 'Xcode "beta".app').resolve()
    monkeypatch.setattr(hostexec, "XCODE_SELECT_LINK", _link(tmp_path, b / "Contents" / "Developer"))
    p = hostexec.sandbox_profile(tmp_path / "proj", tmp_path / "home", read_only=False, network=False)
    rule = f"(subpath {hostexec._sb_str(b)})"
    assert '\\"beta\\"' in rule
    read_rule = next(ln for ln in p.splitlines() if ln.startswith("(allow file-read* (literal"))
    write_rule = next(ln for ln in p.splitlines() if ln.startswith("(allow file-write*"))
    assert rule in read_rule and str(b) not in write_rule and p.count(str(b)) == 0  # only the escaped form appears
    monkeypatch.setattr(hostexec, "XCODE_SELECT_LINK", str(tmp_path / "no-link"))
    assert rule not in hostexec.sandbox_profile(tmp_path / "proj", tmp_path / "home", read_only=False, network=False)


def test_profile_names_this_macs_active_bundle():
    """On the Mac running the tests: the profile grants the bundle xcode-select points at (or a fixed rule covers it)."""
    from nebula_host import hostexec

    bundle = hostexec.active_developer_bundle()
    p = hostexec.sandbox_profile(Path("/nonexistent/proj"), Path("/nonexistent/home"), read_only=False, network=False)
    if bundle is not None:
        assert f"(subpath {hostexec._sb_str(bundle)})" in p
        return
    target = os.path.realpath(hostexec.XCODE_SELECT_LINK)
    assert not os.path.isdir(target) or target.startswith(("/Applications/Xcode.app/", "/Library/Developer/")), target


@pytest.mark.skipif(sys.platform != "darwin" or not os.path.exists("/usr/bin/sandbox-exec"), reason="macOS Seatbelt")
def test_seatbelt_reads_the_active_bundle_but_cannot_write_it(tmp_path, monkeypatch):
    """End to end under sandbox-exec: with the link on the bundle a sandboxed process reads it but cannot write into
    it, and with the link elsewhere the same read is denied (so the new rule is what grants it)."""
    from nebula_host import hostexec

    root, home = (tmp_path / "proj").resolve(), (tmp_path / "home").resolve()
    root.mkdir()
    home.mkdir()
    b = _bundle(tmp_path, "Xcode_16.4.app").resolve()
    probe = b / "Contents" / "Developer" / "usr" / "lib" / "libxcrun.txt"

    def run(argv: list[str]) -> subprocess.CompletedProcess:
        prof = hostexec.sandbox_profile(root, home, read_only=False, network=False)
        return subprocess.run([hostexec.SANDBOX_EXEC, "-p", prof, *argv], capture_output=True, text=True, timeout=30,
                              cwd=str(root), env={"PATH": "/usr/bin:/bin", "HOME": str(home)})

    monkeypatch.setattr(hostexec, "XCODE_SELECT_LINK", _link(tmp_path, b / "Contents" / "Developer"))
    r = run(["/bin/cat", str(probe)])
    assert r.returncode == 0 and r.stdout == "xcrun-probe", r.stderr
    w = run(["/bin/sh", "-c", f"echo x > '{b}/Contents/planted'"])
    assert w.returncode != 0 and not (b / "Contents" / "planted").exists()
    monkeypatch.setattr(hostexec, "XCODE_SELECT_LINK", str(tmp_path / "no-link"))
    d = run(["/bin/cat", str(probe)])
    assert d.returncode != 0 and "Operation not permitted" in d.stderr, (d.returncode, d.stderr)
