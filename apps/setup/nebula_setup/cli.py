"""`nebula` command line: install / serve / status / health / restart / update / deploy / autostart / doctor /
diagnostics / vm / repair / uninstall / reset-password / setup-url.

Every command acts on one *instance* (default "default"): `nebula --instance <id> ...` or NEBULA_INSTANCE=<id>
selects another one with its own data dir, Keychain service, LaunchAgent and VM hostname.
"""

from __future__ import annotations

import argparse
import getpass
import json
import os
import socket
import sys
import webbrowser
from pathlib import Path

AUTOSTART_PROMPT = "Start NEBULA automatically after you log in (LaunchAgent)? [y/N] "


def _boot(cfg_overrides: dict | None = None):
    from nebula_host import db, secrets
    from nebula_host.config import get_config

    cfg = get_config()
    cfg.check_instance_isolation()
    cfg.ensure_dirs()
    secrets.init_store(cfg.secret_backend, secrets.service_name() if cfg.secret_backend == "keychain" else None)
    db.init_engine(cfg.db_path)
    return cfg


def _port_free(port: int) -> bool:
    s = socket.socket()
    try:
        s.bind(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def pick_free_port(start: int = 3110, step: int = 10, tries: int = 50, span: int = 3, is_free=_port_free) -> int:
    """First base port with `span` free ports (dashboard, +1, gateway = +2) for a non-default instance."""
    for i in range(tries):
        base = start + i * step
        if base + span - 1 <= 65535 and all(is_free(base + k) for k in range(span)):
            return base
    raise RuntimeError("no free port range found; pass --port")


def resolve_autostart(choice: str, interactive: bool, ask=input) -> bool:
    """yes/no as given; `ask` prompts on a terminal and means "no" when nobody can answer."""
    if choice == "yes":
        return True
    if choice == "no" or not interactive:
        return False
    try:
        return ask(AUTOSTART_PROMPT).strip().lower() in ("y", "yes")
    except EOFError:
        return False


def _serve_program(python: str) -> list[str]:
    return [python, "-m", "nebula_setup.cli", "serve"]


def _service_env(cfg) -> dict[str, str]:
    return {"NEBULA_DATA_DIR": str(cfg.data_dir), "NEBULA_INSTANCE": cfg.instance_id}


def _start_service(cfg, printer=print) -> dict:
    """Deploy the runtime and (re)install + start this instance's LaunchAgent."""
    from nebula_host.config import APP_VERSION

    from nebula_setup import launchd, runtime

    rt = runtime.deploy(cfg.data_dir, APP_VERSION, printer=printer)
    printer(f"  [READY] runtime deployed to {rt['target']}")
    launchd.install(_serve_program(rt["python"]), cfg.log_dir, env=_service_env(cfg), label=cfg.launchd_label,
                    data_dir=cfg.data_dir)
    printer(f"  [READY] LaunchAgent {cfg.launchd_label} installed (starts after login)")
    return rt


def _health_after_start(cfg, timeout: float, expect_version: str | None = None) -> bool:
    from nebula_setup import health

    if timeout <= 0:
        return True
    print(f"  [HEALTH] waiting for http://127.0.0.1:{cfg.instance.port}/api/v1/health (up to {timeout:.0f} s)")
    h = health.wait(cfg.instance.port, timeout, expect_version=expect_version)
    if h["ok"]:
        print(f"  [HEALTH] ok: API and database answer (version {h.get('version')}, VM {h.get('vm')}, "
              f"guest {h.get('guest')})")
        return True
    print(f"  [HEALTH] FAILED: {h.get('status')} {h.get('detail') or ''}; see {cfg.log_dir / 'host.log'}")
    return False


def cmd_install(a) -> int:
    from nebula_host.config import get_config, instance_https_port, save_config

    cfg0 = get_config()
    fresh_config = not cfg0.config_path.exists()
    cfg = _boot()
    from nebula_host import auth
    from nebula_host import providers_service as provs

    from nebula_setup import installer, launchd, runtime

    if a.port:
        cfg.instance.port = a.port
    elif fresh_config and not cfg.is_default_instance and not os.environ.get("NEBULA_PORT") \
            and cfg.instance.port == 3100:
        cfg.instance.port = pick_free_port()  # never collide with the default instance's 3100-3102
        print(f"  instance '{cfg.instance_id}' uses port {cfg.instance.port}")
    if not cfg.is_default_instance and fresh_config:
        cfg.lan.https_port = instance_https_port(cfg.instance.port)
    if a.vm_ram_mb:
        cfg.vm.ram_mb = a.vm_ram_mb
    save_config(cfg)  # persists the instance id with the data dir
    provs.ensure_catalog()
    print(f"NEBULA installer — instance: {cfg.instance_id}  data: {cfg.data_dir}")
    report = installer.install(cfg, offline_image=Path(a.offline_image) if a.offline_image else None,
                               printer=lambda s: print("  " + s, flush=True), reprovision=a.reprovision)
    out = cfg.data_dir / "install-report.json"
    out.write_text(json.dumps(report, indent=2, default=str))
    os.chmod(out, 0o600)
    if "error" in report:
        print(f"\nINSTALL FAILED at {report['error']['state']}: {report['error']['message']}\nreport: {out}")
        return 2
    choice = "no" if a.no_launch_agent else a.autostart
    autostart = resolve_autostart(choice, sys.stdin.isatty() and sys.stdout.isatty())
    st = launchd.status(cfg.launchd_label)
    healthy = True
    if autostart:
        # the LaunchAgent must not run code from TCC-protected folders (e.g. a checkout on ~/Desktop)
        if report.get("already_ready") and st["installed"] and runtime.current_target(cfg.data_dir) is not None:
            print(f"  [READY] LaunchAgent {cfg.launchd_label} already installed (`nebula deploy` updates the runtime)")
        else:
            _start_service(cfg)
        healthy = _health_after_start(cfg, a.health_timeout)
    elif st["installed"]:
        print(f"  [READY] LaunchAgent {cfg.launchd_label} left as it is (`nebula autostart disable` removes it)")
    else:
        print("  [READY] autostart: off. Start NEBULA in the foreground with `nebula serve`, "
              "or later with `nebula autostart enable`.")
    cfg.instance.autostart_after_login = bool(autostart or st["installed"])
    save_config(cfg)
    tok = auth.ensure_setup_token()
    url = f"http://127.0.0.1:{cfg.instance.port}/"
    if tok:
        url += f"#/setup?token={tok}"
    print(f"\nInstallation complete. Report: {out}")
    if not report.get("already_ready"):
        print(f"VM image: {report.get('image_version')}  disk: "
              f"{report.get('vm', {}).get('disk_allocated_bytes', 0) / 1e9:.1f} GB allocated  "
              f"RAM: {report.get('vm', {}).get('memory_mb')} MB")
    print(f"Open the Dashboard: {url}")
    if a.open and tok and (autostart or st["installed"]):
        webbrowser.open(url)
    return 0 if healthy else 3


def cmd_serve(a) -> int:
    import uvicorn
    from nebula_host.config import get_config

    cfg = get_config()
    cfg.check_instance_isolation()
    cfg.enforce_local_bind()
    cfg.ensure_dirs()
    import logging

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    from nebula_host.app import install_log_redaction

    install_log_redaction()
    uvicorn.run("nebula_host.app:app", host=cfg.instance.bind_host, port=cfg.instance.port, log_level="info",
                ws_ping_interval=10, ws_ping_timeout=20, proxy_headers=False, server_header=False,
                timeout_graceful_shutdown=5)  # open SSE streams must not block restarts (deploy, launchd)
    return 0


def _instance_info(cfg) -> dict:
    from nebula_host import secrets

    return {"id": cfg.instance_id, "data_dir": str(cfg.data_dir), "log_dir": str(cfg.log_dir),
            "keychain_service": secrets.service_name(), "launchd_label": cfg.launchd_label,
            "vm_hostname": cfg.vm_hostname, "port": cfg.instance.port}


def cmd_status(a) -> int:
    cfg = _boot()
    from nebula_host.lan import lan_interfaces
    from nebula_host.vm import VMManager

    from nebula_setup import installer, launchd, runtime

    lan = {"enabled": cfg.lan.enabled, "https": cfg.lan.https,
           "urls": [f"http://{i['ip']}:{cfg.instance.port}/" for i in lan_interfaces()] +
                   ([f"https://{i['ip']}:{cfg.lan.https_port}/" for i in lan_interfaces()] if cfg.lan.https else [])
           if cfg.lan.enabled else []}
    print(json.dumps({"instance": _instance_info(cfg), "installation": installer.get_installation(),
                      "vm": VMManager(cfg).status(), "launch_agent": launchd.status(cfg.launchd_label),
                      "runtime": {"current": str(runtime.current_target(cfg.data_dir)),
                                  "previous": str(runtime.previous_target(cfg.data_dir))},
                      "dashboard": f"http://127.0.0.1:{cfg.instance.port}/", "lan_access": lan},
                     indent=2, default=str))
    return 0


def cmd_health(a) -> int:
    from nebula_host.config import get_config

    from nebula_setup import health

    cfg = get_config()
    h = health.wait(cfg.instance.port, a.timeout)
    print(json.dumps(h, indent=2))
    return 0 if h["ok"] else 1


def cmd_restart(a) -> int:
    from nebula_host.config import get_config

    from nebula_setup import launchd

    cfg = get_config()
    cfg.check_instance_isolation()
    st = launchd.restart(cfg.launchd_label, cfg.data_dir)
    print(f"  [RESTART] {st['label']} restarted")
    return 0 if _health_after_start(cfg, a.health_timeout) else 3


def cmd_autostart(a) -> int:
    cfg = _boot()
    from nebula_host.config import save_config

    from nebula_setup import launchd

    if a.action == "status":
        print(json.dumps(launchd.status(cfg.launchd_label), indent=2))
        return 0
    if a.action == "enable":
        _start_service(cfg)
        cfg.instance.autostart_after_login = True
        save_config(cfg)
        return 0 if _health_after_start(cfg, a.health_timeout) else 3
    removed = launchd.uninstall(cfg.launchd_label, cfg.data_dir)
    cfg.instance.autostart_after_login = False
    save_config(cfg)
    print(f"  LaunchAgent {cfg.launchd_label} {'removed' if removed else 'was not installed'}; data kept")
    return 0


def cmd_doctor(a) -> int:
    cfg = _boot()
    from nebula_host.vm import VMManager

    from nebula_setup import installer
    from nebula_setup.preflight import run_preflight

    vm = VMManager(cfg)
    pf = run_preflight(cfg.data_dir, cfg.instance.port, cfg.helper_binary(), cfg.vm.ram_mb,
                       vm_running=vm.exists() and vm.is_running())
    out = {"preflight": pf, "vm": vm.status()}
    if vm.exists() and vm.is_running():
        try:
            out["health"] = installer.healthcheck(cfg)
        except Exception as e:  # noqa: BLE001
            out["health"] = {"ok": False, "error": str(e)}
    print(json.dumps(out, indent=2, default=str))
    return 0 if pf["status"] != "fail" and out.get("health", {}).get("ok", True) else 1


def cmd_diagnostics(a) -> int:
    cfg = _boot()
    from nebula_setup import diagnostics

    out = diagnostics.build_bundle(cfg, Path(a.out) if a.out else None)
    print(f"diagnostics bundle (redacted, no secrets or database): {out}")
    return 0


def cmd_vm(a) -> int:
    cfg = _boot()
    from nebula_host import db
    from nebula_host.vm import VMManager

    vm = VMManager(cfg)
    if a.action == "start":
        r = vm.start(60)
        db.set_setting("vm.desired_state", "running")
    elif a.action == "stop":
        r = vm.stop(force=a.force)
        db.set_setting("vm.desired_state", "stopped")
    else:
        r = vm.status()
    print(json.dumps(r, indent=2))
    return 0


def cmd_repair(a) -> int:
    cfg = _boot()
    from nebula_setup import installer

    r = installer.repair(cfg, printer=lambda s: print("  " + s, flush=True))
    print(json.dumps(r, indent=2, default=str))
    return 1 if "error" in r else 0


def cmd_uninstall(a) -> int:
    cfg = _boot()
    from nebula_setup import installer

    if a.remove_data and a.confirm != "DELETE-ALL-NEBULA-DATA":
        print(f"Refusing: --remove-data deletes instance '{cfg.instance_id}': its VM, every agent workspace, the "
              f"database ({cfg.data_dir}) and its Keychain items.\n"
              "Re-run with --confirm DELETE-ALL-NEBULA-DATA to proceed. Default uninstall keeps all data.")
        return 2
    installer.uninstall(cfg, remove_data=a.remove_data, confirm=a.confirm,
                        printer=lambda r: print(json.dumps(r, indent=2, default=str)))
    return 0


def cmd_reset_password(a) -> int:
    _boot()
    from nebula_host import auth

    pw = getpass.getpass("New password: ")
    if pw != getpass.getpass("Repeat: "):
        print("passwords differ")
        return 2
    auth.reset_password_local(a.username, pw)
    print("password reset; all sessions signed out")
    return 0


def cmd_deploy(a) -> int:
    """Update the installed runtime from this checkout and restart the LaunchAgent (no VM changes)."""
    cfg = _boot()
    from nebula_host.config import APP_VERSION

    from nebula_setup import launchd, runtime
    from nebula_setup.installer import install_helper

    launchd.check_owner(cfg.launchd_label, cfg.data_dir)
    install_helper(cfg)  # refresh the signed VM helper too (takes effect on next VM start)
    rt = runtime.deploy(cfg.data_dir, APP_VERSION)
    if a.no_restart:
        print(json.dumps(rt, indent=2))
        return 0
    if launchd.plist_path(cfg.launchd_label).exists():
        launchd.install(_serve_program(rt["python"]), cfg.log_dir, env=_service_env(cfg), label=cfg.launchd_label,
                        data_dir=cfg.data_dir)
    else:
        print("  LaunchAgent not installed: start with `nebula serve` or `nebula autostart enable`")
    print(json.dumps({**rt, "launch_agent": launchd.status(cfg.launchd_label)}, indent=2))
    if launchd.plist_path(cfg.launchd_label).exists():
        return 0 if _health_after_start(cfg, a.health_timeout, APP_VERSION) else 3
    return 0


def cmd_migrate(a) -> int:
    """Apply database migrations with this code (used by `nebula update` before restarting)."""
    from nebula_host import db
    from nebula_host.config import get_config

    cfg = get_config()
    cfg.check_instance_isolation()  # never migrate another instance's database
    cfg.ensure_dirs()
    head = db.run_migrations(cfg.db_path)
    print(f"database at revision {head}")
    return 0


def cmd_update(a) -> int:
    from nebula_host.config import get_config

    from nebula_setup import update
    from nebula_setup.runtime import ROOT

    cfg = get_config()
    cfg.check_instance_isolation()
    ops = update.Ops(cfg, ROOT, health_timeout=a.health_timeout)
    report = update.run_update(cfg, ops, ref=a.ref, build=not a.no_build, force=a.force, dry_run=a.dry_run)
    print(json.dumps(report, indent=2, default=str))
    return 1 if report.get("result") == "rolled_back" else 0


def cmd_setup_url(a) -> int:
    cfg = _boot()
    from nebula_host import auth

    tok = auth.ensure_setup_token()
    print(f"http://127.0.0.1:{cfg.instance.port}/" + (f"#/setup?token={tok}" if tok else ""))
    return 0


def _common() -> argparse.ArgumentParser:
    c = argparse.ArgumentParser(add_help=False)
    c.add_argument("--instance", default=argparse.SUPPRESS,
                   help="instance id (default: NEBULA_INSTANCE or 'default'); scopes data dir, Keychain, LaunchAgent")
    c.add_argument("--data-dir", default=argparse.SUPPRESS, help="data dir (default: derived from the instance)")
    return c


def build_parser() -> argparse.ArgumentParser:
    common = _common()
    ap = argparse.ArgumentParser(prog="nebula", description="NEBULA multi-agent platform", parents=[common])
    sp = ap.add_subparsers(dest="cmd", required=True)

    def sub(name: str, **kw) -> argparse.ArgumentParser:
        return sp.add_parser(name, parents=[common], **kw)

    p = sub("install", help="preflight, verified image, VM, guest provisioning, health-check, autostart")
    p.add_argument("--offline-image", help="import a verified image file instead of downloading")
    p.add_argument("--port", type=int)
    p.add_argument("--vm-ram-mb", type=int, help="VM RAM (default 6144; 4096 measured for 16 GB Macs running a local 7B model)")
    p.add_argument("--autostart", choices=["yes", "no", "ask"], default="ask",
                   help="install the LaunchAgent that starts NEBULA after login (ask: prompt on a terminal, "
                        "otherwise no)")
    p.add_argument("--no-launch-agent", action="store_true", help="same as --autostart no")
    p.add_argument("--reprovision", action="store_true", help="re-run guest provisioning even if already READY")
    p.add_argument("--health-timeout", type=float, default=90, help="seconds to wait for the API after start")
    p.add_argument("--open", action="store_true", help="open the dashboard when done")
    p.set_defaults(fn=cmd_install)
    sub("serve", help="run the host service in the foreground").set_defaults(fn=cmd_serve)
    sub("status").set_defaults(fn=cmd_status)
    p = sub("health", help="HTTP health check of the running service (GET /api/v1/health)")
    p.add_argument("--timeout", type=float, default=0, help="keep polling up to this many seconds")
    p.set_defaults(fn=cmd_health)
    p = sub("restart", help="restart the host service (LaunchAgent) and health-check it")
    p.add_argument("--health-timeout", type=float, default=60)
    p.set_defaults(fn=cmd_restart)
    p = sub("autostart", help="enable / disable / show the LaunchAgent (data is never touched)")
    p.add_argument("action", choices=["enable", "disable", "status"])
    p.add_argument("--health-timeout", type=float, default=60)
    p.set_defaults(fn=cmd_autostart)
    p = sub("update", help="update this git checkout to the newest release (or --ref), with DB backup and rollback")
    p.add_argument("--ref", help="tag, branch or commit to move to (default: newest vX.Y.Z tag)")
    p.add_argument("--no-build", action="store_true", help="skip uv sync / helper / dashboard builds")
    p.add_argument("--force", action="store_true", help="redeploy even if already at the target")
    p.add_argument("--dry-run", action="store_true", help="only report what would happen")
    p.add_argument("--health-timeout", type=float, default=90)
    p.set_defaults(fn=cmd_update)
    sub("doctor", help="preflight + live health-check").set_defaults(fn=cmd_doctor)
    p = sub("diagnostics", help="write a redacted diagnostics bundle (no secrets, no database)")
    p.add_argument("--out", help="output .tar.gz path (default: <data>/diagnostics/)")
    p.set_defaults(fn=cmd_diagnostics)
    p = sub("vm")
    p.add_argument("action", choices=["start", "stop", "status"])
    p.add_argument("--force", action="store_true")
    p.set_defaults(fn=cmd_vm)
    sub("repair", help="re-apply guest provisioning and verify").set_defaults(fn=cmd_repair)
    p = sub("uninstall", help="remove the LaunchAgent and stop the VM; --remove-data also deletes this instance")
    p.add_argument("--remove-data", action="store_true")
    p.add_argument("--confirm")
    p.set_defaults(fn=cmd_uninstall)
    p = sub("reset-password", help="local recovery of the dashboard admin password")
    p.add_argument("username")
    p.set_defaults(fn=cmd_reset_password)
    sub("setup-url", help="print the first-run dashboard URL").set_defaults(fn=cmd_setup_url)
    p = sub("deploy", help="update the installed runtime + LaunchAgent from this checkout")
    p.add_argument("--no-restart", action="store_true", help="deploy the runtime only")
    p.add_argument("--health-timeout", type=float, default=60)
    p.set_defaults(fn=cmd_deploy)
    sub("migrate", help=argparse.SUPPRESS).set_defaults(fn=cmd_migrate)
    return ap


def main(argv: list[str] | None = None) -> int:
    a = build_parser().parse_args(argv)
    from nebula_setup.launchd import LaunchdConflict
    from nebula_setup.runtime import DeployError
    from nebula_setup.update import UpdateError

    try:
        if getattr(a, "instance", None):
            from nebula_host.config import validate_instance_id

            os.environ["NEBULA_INSTANCE"] = validate_instance_id(a.instance)
        if getattr(a, "data_dir", None):
            os.environ["NEBULA_DATA_DIR"] = str(Path(a.data_dir).expanduser())
        os.umask(0o077)
        return a.fn(a)
    except (LaunchdConflict, DeployError, UpdateError, ValueError) as e:
        print(f"nebula: error: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
