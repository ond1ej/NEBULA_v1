# ruff: noqa: F811 - the `host` fixture is imported from another test module and injected by pytest
"""Review 12, R12-1: the value of a wrapper option (`exec -a NAME`, `env -u NAME`, `xargs -I STR`, ...) is not the
program. The real program after it must still be checked against `allowed_tools`, also when the option and its value
are written joined (`-ugit`, `--unset=git`, `-n5`). An option the parser cannot classify fails closed."""

from __future__ import annotations

import pytest
from nebula_runtime.policy import allowed_tools_violation, shell_command_names

from tests.security.test_fixround_hostexec import host  # noqa: F401


@pytest.mark.parametrize("command,names", [
    ("exec -a git python3 -c 1", ["exec", "python3"]),
    ("exec -agit python3 -c 1", ["exec", "python3"]),
    ("env -u git python3 -c 1", ["env", "python3"]),
    ("env -ugit python3 -c 1", ["env", "python3"]),
    ("env --unset=git python3 -c 1", ["env", "python3"]),
    ("env --unset git python3 -c 1", ["env", "python3"]),
    ("env -C /tmp -P /usr/bin python3 -c 1", ["env", "python3"]),
    ("echo x | xargs -I git python3 -c 1", ["echo", "xargs", "python3"]),
    ("echo x | xargs -Igit python3 -c 1", ["echo", "xargs", "python3"]),
    ("echo x | xargs -n 5 -P 2 python3 -c 1", ["echo", "xargs", "python3"]),
    ("echo x | xargs -n5 python3 -c 1", ["echo", "xargs", "python3"]),
    ("echo x | xargs -0 -I {} python3 -c 1", ["echo", "xargs", "python3"]),
    ("arch -d git python3 -c 1", ["arch", "python3"]),
    ("arch -arch arm64 python3 -c 1", ["arch", "python3"]),
    ("arch -arm64 python3 -c 1", ["arch", "python3"]),
    ("timeout -s git 5 python3 -c 1", ["timeout", "python3"]),
    ("timeout -k 5 -s TERM 10 python3 -c 1", ["timeout", "python3"]),
    ("timeout --signal=KILL 10 python3 -c 1", ["timeout", "python3"]),
    ("caffeinate -t 5 python3 -c 1", ["caffeinate", "python3"]),
    ("caffeinate -w git python3 -c 1", ["caffeinate", "python3"]),
    ("stdbuf -o L python3 -c 1", ["stdbuf", "python3"]),
    ("stdbuf -oL python3 -c 1", ["stdbuf", "python3"]),
    ("nice -n 5 python3 -c 1", ["nice", "python3"]),
    ("nice -n git python3 -c 1", ["nice", "python3"]),
    ("nice -n5 python3 -c 1", ["nice", "python3"]),
    ("nice -10 python3 -c 1", ["nice", "python3"]),
    ("env -i nice -n 5 exec -a git python3 -c 1", ["env", "nice", "exec", "python3"]),
    ("env -- python3 -c 1", ["env", "python3"]),
    # ordinary lines are read as before
    ("nice -n 5 git status", ["nice", "git"]),
    ("env FOO=1 git log", ["env", "git"]),
    ("env -i FOO=1 git log", ["env", "git"]),
    ("timeout 10 git fetch", ["timeout", "git"]),
    ("timeout 1.5m git fetch", ["timeout", "git"]),
    ("xargs git add", ["xargs", "git"]),
    ("git ls-files | xargs -0 git add", ["git", "xargs", "git"]),
    ("exec git status", ["exec", "git"]),
    ("caffeinate -i git pull", ["caffeinate", "git"]),
])
def test_wrapper_option_values_are_not_the_program(command, names):
    assert shell_command_names(command) == names


@pytest.mark.parametrize("command", [
    "env -S 'python3 -c 1'",  # the value is a command line
    "env --split-string='python3 -c 1'",
    "env -z git python3 -c 1",  # an option nobody listed
    "env --bogus git python3 -c 1",
    "xargs -@ git python3",
    "nice -q git python3",
    "exec -z git python3",
    "nohup --weird git python3",
    "timeout - git python3",
])
def test_unknown_wrapper_options_fail_closed(command):
    assert shell_command_names(command) is None
    assert allowed_tools_violation(command, ["git"]) is not None


@pytest.mark.parametrize("command", [
    "exec -a git python3 -c 1",
    "exec -agit python3 -c 1",
    "env -u git python3 -c 1",
    "env -ugit python3 -c 1",
    "env --unset=git python3 -c 1",
    "echo x | xargs -I git python3 -c 1",
    "echo x | xargs -Igit python3 -c 1",
    "echo x | xargs -n5 python3 -c 1",
    "nice -n git python3 -c 1",
    "timeout -s git python3 -c 1",
])
def test_the_bypass_lines_name_python3_and_are_refused(command):
    reason = allowed_tools_violation(command, ["git"])
    assert reason is not None and "python3" in reason, reason


@pytest.mark.parametrize("command", [
    "nice -n 5 git status",
    "env FOO=1 git log",
    "timeout 10 git fetch",
    "git ls-files | xargs git add",
    "exec git status",
])
def test_ordinary_wrapper_lines_still_pass_with_git_allowed(command):
    assert allowed_tools_violation(command, ["git"]) is None


@pytest.mark.parametrize("command", [
    "exec -a git python3 -c 1",
    "env -u git python3 -c 1",
    "echo x | xargs -I git python3 -c 1",
    "env -ugit python3 -c 1",
    "echo x | xargs -n5 python3 -c 1",
])
@pytest.mark.parametrize("tool", ["shell.execute", "process.start"])
def test_host_refuses_the_bypass_lines_and_never_runs_them(host, command, tool):
    r = host["tool"](tool, {"command": command})
    assert r["ok"] is False and r["error"]["code"] == "tool_not_allowed", r
    assert "python3" in r["error"]["message"]
    assert not (host["proj"] / "pwned.txt").exists()
    assert host["ex"].procs == {}
