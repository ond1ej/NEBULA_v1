# Host execution (native work on the Mac)

**Status: Experimental, opt-in.** This is the most sensitive feature in NEBULA. Read this page and the
[security model](../security-model.md) before you enable it.

By default agents work only inside the VM. With host execution, an agent can work directly in project folders on your
Mac: it runs real macOS processes (git, Node.js, Python, Swift, Xcode tools and so on) in a folder you authorised.
Nothing is mounted into the VM; the commands run on the host, confined as described below.

## Authorising folders

**Dashboard → Host Access → Add folder**, or `POST /api/v1/host/roots` (owner with a fresh verification).

- Folders must be inside your home folder or on `/Volumes`.
- Refused: `/`, your home folder itself, `/Users`, `~/Library`, `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.kube`,
  `~/.docker`, `~/.config/gcloud`, the NEBULA data folder, system folders, and any folder that contains one of them.
- Per folder: read-write or read-only, network access (off by default), an optional list of allowed tools
  (`allowed_tools`), enabled or disabled. Turn network on only if the agent really needs it. Revoking access never
  deletes the folder.
- **Allowed tools** is a convenience filter. When the list is set, NEBULA checks every program named on the command
  line, not only the first word: `npm test && curl ...` needs both `npm` and `curl` on the list. Shell builtins and
  plain text tools (`cd`, `echo`, `cat`, `grep`, `sed` and similar) are always allowed next to the listed tools.
  Programs started through `$(...)`, backticks or a process substitution are checked too, also right after a
  redirect (`echo hi > >(cmd)`). Commands it cannot check, such as `bash script.sh`, `sh -c`, `eval`, `source`,
  loops, a substitution inside quotes, or a variable or glob used as the program name, are refused. An empty list
  means no restriction. The list only sees the command line, so a tool that can run other programs itself gets around
  it: `sed`'s `e` command (`sed '1e python3 x.py' file`) or a git alias that starts with `!` (set with
  `git -c alias.x=...` in a shell command or in the project's `.git/config`) runs a program that is not on the list.
  The Seatbelt sandbox, not this list, is the security boundary.
- **Run self-test** executes fixed probes (git, python3, node, working directory, writes to the agent's home) and
  checks that the sandbox blocks `~/Library`, `~/.ssh`, the NEBULA data folder, the Keychain and writes outside.

Then choose **Agent → Environment → Host computer → folder → Switch**. Switching is refused while the agent has active
or paused tasks; its memory, history and skills stay as they are.

## What a host agent can do

File tools (list, read, stat, search, write, edit, mkdir, move, copy, delete), `shell_execute`, background processes
(at most 3 per agent, at most 2 hours), `git_run`, `python_run`, `node_run`, PDF text, memory tools, approvals and
`task_complete` (file artifacts are verified on disk; `http://127.0.0.1:<port>` URLs are checked). NEBULA detects the
developer tools present on the Mac and installs nothing globally.

## What it cannot do

- No GUI control of macOS: no mouse, keyboard or screen. Graphical work stays on the VM desktop.
- No Live Desktop (there is no desktop to show).
- No plugins and no package installation.
- No Password Vault sign-ins (those run only in the VM).

## How it is confined

1. **File tools** run inside the NEBULA process. They open the folder (or the agent's private home,
   `<data>/hosthome/<agent>`) and then every path component relative to its parent's directory descriptor with
   `O_NOFOLLOW`, so symlinks are rejected and a directory swapped for a symlink during the operation cannot redirect
   it. A regular file with more than one hard link is refused, because a hard link inside the folder could point at a
   file outside it. Read-only folders reject changes.
2. **Every command runs in a Seatbelt sandbox** (`/usr/bin/sandbox-exec`, deny by default): reads are limited to
   system and tool locations, the folder and the agent's home; writes to the folder (unless read-only) and the agent's
   home. Tool locations include `/Applications/Xcode.app` and, read-only, the Xcode bundle that `xcode-select` made
   active when that is another one (for example `Xcode-beta.app`; inside your home folder only under
   `~/Applications`), because `/usr/bin/git`, `python3` and `clang` load their libraries from it. The Keychain,
   pasteboard, WindowServer, LaunchServices and privacy (TCC) services are blocked. Network access
   follows the folder setting (off by default). Even when it is on, Unix sockets stay denied (except the one for name
   resolution), so commands cannot reach sockets such as the Docker daemon's or the VM helper's. Every address of the
   Mac itself is denied too, because Seatbelt's `localhost` filter matches all of the Mac's interface addresses, not
   only `127.0.0.1`. Measured with `sandbox-exec` on macOS 27.0.1 (Apple silicon) against listeners on all
   addresses, TCP connections to `127.0.0.1`, `::1`, the Mac's LAN IPv4 address and the VM bridge address
   `192.168.64.1` fail with `EPERM`, and so does a UDP send to the LAN address; without that filter all of them
   connect. So services on the Mac (NEBULA's API and gateway, Ollama, dev servers) are not reachable from host
   commands, through any of its addresses. NEBULA does not block other destinations; other devices on your network
   and the Internet were not part of that measurement, so treat them as reachable.
3. **A clean environment:** only `PATH`, `HOME` (the agent's home), `TMPDIR`, locale and `NEBULA_PROJECT_ROOT`; no
   inherited secrets. Timeouts (at most 900 seconds), a CPU limit, a 1 GiB file size limit, no core dumps, and the
   whole process group is killed at the end.
4. **Approvals.** NEBULA classifies every action with fixed rules and asks you, the owner, before high-impact ones:
   deletes, overwriting moves and copies, `osascript`, `open`, `launchctl`, `defaults write`, global installs (`brew`,
   `npm -g`, `gem`), `git push`, `git clean`, `git reset --hard`, `sudo`, recursive `rm`, uploads with obvious tools
   (`curl -d`, `scp`, ...), and any file tool, shell command or code snippet that names a `.env`, key or credentials
   file. Only the owner can resolve these approvals, and from a remote session they need a fresh verification, so a
   Telegram chat button never decides them: decide them in the dashboard, the main bot's Mini App or the native app
   ([telegram.md](../telegram.md#approvals-in-the-chat)). Keychain and `~/.ssh` access is refused outright. The
   `git_run` tool rejects git global options such as `-c`, `-C`, `--exec-path`, `--git-dir` and `--upload-pack`.
5. **Audit.** Every command and file change is recorded with status, exit code and duration, visible in Host Access.

## What this does not protect against

- **Commands run as your macOS user.** The sandbox, not a separate account, is the boundary. A flaw in the sandbox
  profile or in NEBULA's own file tools would act with your user's rights.
- **Approval rules are tripwires for the obvious cases, not a security boundary.** A command can still read a secret
  file through a glob or a computed name, and can still send data out with a plain GET request, a raw socket or a DNS
  lookup, without asking. The boundaries are the macOS sandbox (only the project folder and the agent's own home are
  readable; network only if you allow it for the folder) and, in the VM, the separate Linux user per agent and the
  guest firewall. Do not authorise a project folder that holds secrets you are not willing to expose to the agent.
- **With network access on**, NEBULA blocks only the Mac itself (all of its addresses) and its Unix sockets (except
  name resolution). Treat the Internet and other devices on your network as reachable: the profile does not restrict
  them, and that part was not measured. Keep network off for folders that do not need it and for folders that hold secrets.
- **`allowed_tools` is not a boundary.** A tool with its own way to start programs (`sed`'s `e` command, a git alias
  that starts with `!`) runs programs the list does not name.
- `sandbox-exec` is deprecated by Apple. If it is removed in a future macOS, NEBULA disables host commands rather than
  running them unconfined.
- Some caches outside the folder are read-only inside the sandbox; for example run `flutter precache` yourself first.

Use host execution only with folders and agents you trust, and keep sensitive files out of authorised folders.
