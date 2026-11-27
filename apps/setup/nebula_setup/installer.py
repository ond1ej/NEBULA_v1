"""Transactional installer / repair / uninstall (spec §3.2-3.3). Shared by `nebula install` and the API.

States: NOT_INSTALLED -> PREFLIGHT -> DOWNLOAD -> VERIFY -> DISK_CREATE -> VM_BOOT -> GUEST_PROVISION
        -> HEALTHCHECK -> READY;  errors: FAILED_RECOVERABLE | FAILED_BLOCKED | ROLLBACK
"""

from __future__ import annotations

import fcntl
import os
import re
import shutil
import subprocess
import tempfile
import time
import uuid
from collections.abc import Callable
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from nebula_host import db, models, secrets
from nebula_host.config import APP_VERSION, NebulaConfig
from nebula_host.vm import VMError, VMManager
from sqlalchemy import select, update

from nebula_setup import image, seed
from nebula_setup.preflight import run_preflight

ROOT = Path(__file__).resolve().parents[3]
STATES = ["NOT_INSTALLED", "PREFLIGHT", "DOWNLOAD", "VERIFY", "DISK_CREATE", "VM_BOOT", "GUEST_PROVISION",
          "HEALTHCHECK", "READY"]
HEALTH_AGENT_ID = "00000000-0000-4000-8000-00000000c0de"
GUEST_KEY_REF = "nebula:guest_rpc_key"
GUEST_REQUIREMENTS = ROOT / "guest/image-builder/requirements-guest.txt"


class InstallError(Exception):
    def __init__(self, state: str, code: str, message: str, recoverable: bool = True):
        super().__init__(message)
        self.state = state
        self.code = code
        self.recoverable = recoverable


@contextmanager
def install_lock(cfg: NebulaConfig):
    cfg.run_dir.mkdir(parents=True, exist_ok=True)
    with open(cfg.run_dir / "install.lock", "a+") as fh:
        try:
            fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as e:
            raise InstallError("PREFLIGHT", "install_in_progress", "another install/repair is running") from e
        try:
            yield
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)


# ---------------------------------------------------------------- installation record
def get_installation() -> dict[str, Any] | None:
    with db.engine().connect() as c:
        return db.row(c.execute(select(models.host_installation).where(models.host_installation.c.id == 1)).first())


def set_installation(**values: Any) -> None:
    values["updated_at"] = db.now()
    with db.engine().begin() as c:
        if get_installation() is None:
            c.execute(models.host_installation.insert().values(
                id=1, installation_id=str(uuid.uuid4()), state="NOT_INSTALLED", app_version=APP_VERSION,
                updated_at=db.now()))
        c.execute(update(models.host_installation).where(models.host_installation.c.id == 1).values(**values))


def guest_key() -> bytes | None:
    v = secrets.store().get(GUEST_KEY_REF)
    return bytes.fromhex(v) if v else None


def ensure_guest_key() -> bytes:
    k = guest_key()
    if k is None:
        k = os.urandom(32)
        secrets.store().set(GUEST_KEY_REF, k.hex())
    return k


class Job:
    """Persists progress of an install/repair job and mirrors it to the event bus."""

    def __init__(self, kind: str, job_id: str | None = None, printer: Callable[[str], None] | None = None):
        self.id = job_id or str(uuid.uuid4())
        self.kind = kind
        self.steps: list[dict[str, Any]] = []
        self.printer = printer
        with db.engine().begin() as c:
            if c.execute(select(models.install_jobs.c.id).where(models.install_jobs.c.id == self.id)).first() is None:
                c.execute(models.install_jobs.insert().values(id=self.id, kind=kind, state="RUNNING", steps=[],
                                                              progress=0.0, created_at=db.now(), updated_at=db.now()))

    def step(self, state: str, detail: str = "", progress: float | None = None, status: str = "running") -> None:
        now = db.now()
        if self.steps and self.steps[-1]["state"] == state:
            self.steps[-1].update(detail=detail, status=status, updated_at=now)
        else:
            if self.steps and self.steps[-1]["status"] == "running":
                self.steps[-1]["status"] = "done"
            self.steps.append({"state": state, "detail": detail, "status": status, "started_at": now, "updated_at": now})
        if progress is None and state in STATES:
            progress = STATES.index(state) / (len(STATES) - 1)
        with db.engine().begin() as c:
            c.execute(update(models.install_jobs).where(models.install_jobs.c.id == self.id).values(
                current_step=state, steps=self.steps, updated_at=now,
                **({"progress": round(progress, 3)} if progress is not None else {})))
        if self.printer:
            self.printer(f"[{state}] {detail}")
        try:
            from nebula_host.events import bus

            bus.publish("install.progress", {"job_id": self.id, "kind": self.kind, "state": state, "detail": detail,
                                             "progress": progress})
        except Exception:  # noqa: BLE001 - CLI mode without loop is fine
            pass

    def finish(self, state: str, result: dict[str, Any] | None = None, error: str | None = None) -> None:
        if self.steps and self.steps[-1]["status"] == "running":
            self.steps[-1]["status"] = "done" if not error else "failed"
        with db.engine().begin() as c:
            vals = {"state": state, "steps": self.steps, "result": result, "error": error, "updated_at": db.now()}
            if state == "SUCCEEDED":
                vals["progress"] = 1.0
            c.execute(update(models.install_jobs).where(models.install_jobs.c.id == self.id).values(**vals))


# ---------------------------------------------------------------- helpers
def build_guest_bundle(out: Path) -> Path:
    p = subprocess.run([str(ROOT / "scripts/build-guest-bundle.sh"), str(out)], capture_output=True, text=True)
    if p.returncode != 0:
        raise InstallError("GUEST_PROVISION", "bundle_failed", p.stderr[-500:])
    return out


def install_helper(cfg: NebulaConfig) -> Path:
    """Copy the signed helper into the data dir so the service does not depend on the repo build dir."""
    src = ROOT / "apps/host-vm-helper/.build/release/nebula-vm"
    dst_dir = cfg.data_dir / "bin"
    dst_dir.mkdir(parents=True, exist_ok=True)
    dst = dst_dir / "nebula-vm"
    if src.exists():
        if not dst.exists() or src.read_bytes() != dst.read_bytes():
            tmp = dst.with_suffix(".new")
            shutil.copy2(src, tmp)
            subprocess.run(["codesign", "--force", "--sign", "-", "--entitlements",
                            str(ROOT / "apps/host-vm-helper/nebula-vm.entitlements"), str(tmp)],
                           check=True, capture_output=True)
            os.replace(tmp, dst)
    if not dst.exists():
        raise InstallError("PREFLIGHT", "helper_missing", "VM helper not built; run `make helper` first",
                           recoverable=True)
    return dst


_STAGE_RE = re.compile(r"/home/nebula-admin/\.nebula-stage\.[A-Za-z0-9]{6,12}")


def make_stage_dir(vm: VMManager, ip: str) -> str:
    """A fresh 0700 staging dir in nebula-admin's home (agents cannot enter it or pre-create files in it, unlike
    the shared /tmp)."""
    r = vm.ssh(ip, 'umask 077 && mktemp -d "$HOME/.nebula-stage.XXXXXX"', timeout=30)
    stage = (r.stdout or "").strip()
    if r.returncode != 0 or not _STAGE_RE.fullmatch(stage):
        raise InstallError("GUEST_PROVISION", "stage_failed", "could not create a private staging directory")
    return stage


def provision_guest(vm: VMManager, ip: str, job: Job, manifest: dict[str, Any]) -> None:
    stage = make_stage_dir(vm, ip)
    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)
        bundle = build_guest_bundle(tdp / "nebula-guest-bundle.tar.gz")
        keyf = tdp / "rpc.key"
        fd = os.open(keyf, os.O_WRONLY | os.O_CREAT, 0o600)
        os.write(fd, ensure_guest_key().hex().encode())
        os.close(fd)
        verf = tdp / "nebula-guest-version"
        verf.write_text(manifest.get("guest_version", "dev"))
        files = [bundle, keyf, verf, ROOT / "guest/scripts/provision.sh"]
        if GUEST_REQUIREMENTS.exists():
            files.append(GUEST_REQUIREMENTS)
        vm.scp(ip, files, dest=stage + "/")
    env = f"NEBULA_PLAYWRIGHT_VERSION={manifest.get('playwright_version', '1.65.2')}"
    if GUEST_REQUIREMENTS.exists():
        # hash-pinned guest Python packages (pip --require-hashes); see guest/image-builder/README.md
        env += f" NEBULA_GUEST_REQUIREMENTS={stage}/{GUEST_REQUIREMENTS.name}"
    cmd = (f"sudo {env} bash {stage}/provision.sh {stage}/nebula-guest-bundle.tar.gz {stage}/rpc.key; "
           f"rc=$?; rm -rf {stage}; exit $rc")
    proc = subprocess.Popen([*vm.ssh_base(ip), cmd], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    tail: list[str] = []
    assert proc.stdout is not None
    for line in proc.stdout:
        tail = (tail + [line.rstrip()])[-40:]
        if line.startswith("NEBULA_STEP "):
            job.step("GUEST_PROVISION", line.split(" ", 1)[1].strip())
    rc = proc.wait()
    vm.cfg.log_dir.mkdir(parents=True, exist_ok=True)
    (vm.cfg.log_dir / "guest-provision.log").write_text("\n".join(tail))
    if rc != 0 or not any("NEBULA_PROVISION_OK" in t for t in tail):
        raise InstallError("GUEST_PROVISION", "provision_failed", "guest provisioning failed:\n" + "\n".join(tail[-12:]))


def healthcheck(cfg: NebulaConfig, job: Job | None = None) -> dict[str, Any]:
    """guest RPC ping + latency, X server start, headed browser opens, screenshot non-empty (temp workspace)."""
    import asyncio

    from nebula_host.guest import GuestClient

    gc = GuestClient(VMManager(cfg).run_dir, guest_key)

    async def run() -> dict[str, Any]:
        out: dict[str, Any] = {}
        deadline = time.time() + 120
        while True:
            try:
                out["ping"] = await gc.ping()
                break
            except Exception as e:  # noqa: BLE001
                if time.time() > deadline:
                    raise InstallError("HEALTHCHECK", "guest_rpc_unreachable", f"guest RPC not reachable: {e}") from e
                await asyncio.sleep(2)
        lat = []
        for _ in range(10):
            t = time.perf_counter()
            await gc.ping()
            lat.append((time.perf_counter() - t) * 1000)
        out["rpc_latency_ms"] = {"min": round(min(lat), 2), "avg": round(sum(lat) / len(lat), 2), "max": round(max(lat), 2)}
        if job:
            job.step("HEALTHCHECK", f"guest RPC ok ({out['rpc_latency_ms']['avg']} ms); starting test desktop")
        ws = await gc.call("workspace.create", {"agent_id": HEALTH_AGENT_ID, "geometry": "1024x768"}, timeout=120)
        out["x_server"] = ws["desktop_health"]
        try:
            nav = await gc.tool(HEALTH_AGENT_ID, "browser.navigate", {"url": "about:blank"}, timeout=90)
            out["browser"] = nav.get("result") if nav.get("ok") else nav.get("error")
            await asyncio.sleep(1.5)
            shot = await gc.tool(HEALTH_AGENT_ID, "desktop.screenshot", {"scale": 0.5}, timeout=30)
            res = shot.get("result") or {}
            out["screenshot"] = {"non_empty": res.get("non_empty"), "width": res.get("width"),
                                 "height": res.get("height"), "bytes": res.get("bytes")}
        finally:
            await gc.call("workspace.delete", {"agent_id": HEALTH_AGENT_ID, "confirm": True}, timeout=60)
        ok = bool(nav.get("ok")) and bool(out["screenshot"]["non_empty"])
        out["ok"] = ok
        if not ok:
            raise InstallError("HEALTHCHECK", "desktop_unhealthy", f"health-check failed: {out}")
        return out

    return asyncio.run(run())


# ---------------------------------------------------------------- install
def is_ready(cfg: NebulaConfig) -> bool:
    """Installed and verified: installation record READY and the VM bundle exists."""
    try:
        inst = get_installation()
    except Exception:  # noqa: BLE001 - no DB yet
        return False
    return bool(inst and inst.get("state") == "READY" and VMManager(cfg).exists())


def install(cfg: NebulaConfig, *, job: Job | None = None, offline_image: Path | None = None,
            printer: Callable[[str], None] | None = None, reprovision: bool = False) -> dict[str, Any]:
    job = job or Job("install", printer=printer)
    vm = VMManager(cfg)
    report: dict[str, Any] = {"job_id": job.id, "app_version": APP_VERSION}
    state = "PREFLIGHT"
    if not reprovision and is_ready(cfg):
        # idempotent re-run: never re-provision or reboot a healthy VM unless asked to (--reprovision)
        inst = get_installation() or {}
        report.update(already_ready=True, image_version=inst.get("vm_image_version"),
                      guest_version=inst.get("guest_version"))
        job.step("READY", "already READY - nothing to do (use --reprovision to re-run guest provisioning)",
                 progress=1.0, status="done")
        job.finish("SUCCEEDED", report)
        return report
    try:
        with install_lock(cfg):
            set_installation(state="PREFLIGHT", state_detail=None)
            job.step("PREFLIGHT", "checking host")
            helper = install_helper(cfg)
            cfg.vm_helper_path = helper
            pf = run_preflight(cfg.data_dir, cfg.instance.port, helper, cfg.vm.ram_mb, offline=offline_image is not None,
                               vm_running=vm.exists() and vm.is_running())
            report["preflight"] = pf
            if pf["status"] == "fail":
                failed = [c for c in pf["checks"] if c["status"] == "fail"]
                raise InstallError("PREFLIGHT", "preflight_failed", f"preflight failed: {failed}", recoverable=False)

            manifest = image.load_manifest()
            report["image_version"] = manifest["image_version"]
            if vm.exists():
                job.step("VM_BOOT", "existing VM found — reusing it (never overwritten)")
                report["verification"] = db.get_setting("install.verification")
                report["resumed_existing_vm"] = True
            else:
                state = "DOWNLOAD"
                set_installation(state="DOWNLOAD")
                job.step("DOWNLOAD", f"{manifest['url']}")
                last = [0.0]

                def prog(stage: str, done: int, total: int) -> None:
                    if time.time() - last[0] > 2 or done == total:
                        last[0] = time.time()
                        pct = f"{done * 100 // total}%" if total else ""
                        job.step(stage, f"{stage.lower()} {pct}")

                acquired = image.acquire(cfg.cache_dir, manifest, offline_image, prog)
                state = "VERIFY"
                job.step("VERIFY", f"sha256 ok; manifest signature ok; upstream gpg: {acquired['gpg']}")
                report["verification"] = {"sha256": acquired["sha256"], "manifest_signature": "valid",
                                          "upstream_gpg": acquired["gpg"], "verified_at": db.now()}
                db.set_setting("install.verification", report["verification"])
                state = "DISK_CREATE"
                set_installation(state="DISK_CREATE")
                job.step("DISK_CREATE", "generating per-install keys and cloud-init seed")
                inst = get_installation()
                keys = seed.ensure_ssh_keys(cfg.keys_dir)
                seed.write_known_hosts(keys, vm.known_hosts)
                ensure_guest_key()
                seed_iso = seed.build_seed_iso(cfg.data_dir / "vm" / "seed.iso", inst["installation_id"], keys,
                                               hostname=cfg.vm_hostname)
                created = vm.create(Path(acquired["raw"]), seed_iso)
                seed_iso.unlink(missing_ok=True)  # copied into the bundle
                job.step("DISK_CREATE", f"sparse disk created ({cfg.vm.disk_gb_limit} GB limit)")
                report["disk"] = created
                now = db.now()
                with db.engine().begin() as c:
                    c.execute(models.vm_instances.insert().values(
                        id=str(uuid.uuid4()), status="CREATED", bundle_path=str(vm.bundle),
                        disk_path=str(vm.bundle / "disk.img"), memory_mb=cfg.vm.ram_mb, cpu_count=cfg.vm.cpu_count,
                        disk_gb=cfg.vm.disk_gb_limit, image_version=manifest["image_version"],
                        mac_address=created.get("mac_address"), created_at=now, updated_at=now))
            state = "VM_BOOT"
            set_installation(state="VM_BOOT", vm_image_version=manifest["image_version"])
            job.step("VM_BOOT", "starting VM")
            vm.start(wait=60)
            ip = vm.wait_for_ssh(timeout=600)
            job.step("VM_BOOT", f"guest reachable at {ip} (pinned host key)")
            state = "GUEST_PROVISION"
            set_installation(state="GUEST_PROVISION")
            job.step("GUEST_PROVISION", "installing desktop, browser and guest service")
            provision_guest(vm, ip, job, manifest)
            vm.set_resources(remove_seed=True)  # seed holds the SSH host private key; drop it
            # controlled reboot: activates console=hvc0 + fsck-on-boot and proves the VM restarts cleanly
            job.step("GUEST_PROVISION", "rebooting the VM to activate kernel settings")
            vm.stop(force=False, wait=120)
            vm.start(wait=60)
            ip = vm.wait_for_ssh(timeout=300)
            state = "HEALTHCHECK"
            set_installation(state="HEALTHCHECK")
            job.step("HEALTHCHECK", "guest RPC, X server, headed browser, screenshot")
            report["health"] = healthcheck(cfg, job)
            sec = vm.ssh(ip, "sudo sshd -T | grep -Ei '^(passwordauthentication|permitrootlogin) '; "
                             "sudo awk -F: '($2 != \"!\" && $2 != \"*\" && $2 !~ /^!/) {print $1}' /etc/shadow; "
                             "sudo nft list ruleset | grep -c 'policy drop'", timeout=30)
            report["security_finalization"] = sec.stdout.strip().splitlines()
            st = vm.status()
            report["vm"] = {k: st.get(k) for k in ("state", "cpu_count", "memory_mb", "disk_size_gb",
                                                   "disk_allocated_bytes")}
            report["guest_version"] = manifest.get("guest_version")
            db.set_setting("vm.desired_state", "running")
            set_installation(state="READY", state_detail=None, guest_version=manifest.get("guest_version"),
                             last_health=report["health"])
            job.step("READY", "installation complete", progress=1.0, status="done")
            job.finish("SUCCEEDED", report)
            return report
    except (InstallError, VMError, image.ImageError, subprocess.SubprocessError, OSError) as e:
        code = getattr(e, "code", type(e).__name__)
        recoverable = getattr(e, "recoverable", True)
        st = "FAILED_RECOVERABLE" if recoverable else "FAILED_BLOCKED"
        set_installation(state=st, state_detail=f"{state}: {code}: {str(e)[:900]}")
        job.step(st, f"{state}: {e}", status="failed")
        report["error"] = {"state": getattr(e, "state", state), "code": code, "message": str(e)}
        job.finish("FAILED", report, error=str(e))
        return report


def repair(cfg: NebulaConfig, *, job: Job | None = None, printer=None) -> dict[str, Any]:
    """Re-run the idempotent guest provisioning + health-check on the existing VM (no data loss)."""
    job = job or Job("repair", printer=printer)
    vm = VMManager(cfg)
    report: dict[str, Any] = {"job_id": job.id}
    try:
        with install_lock(cfg):
            if not vm.exists():
                raise InstallError("PREFLIGHT", "vm_missing", "no VM to repair; run install", recoverable=False)
            cfg.vm_helper_path = install_helper(cfg)
            job.step("VM_BOOT", "ensuring VM is running")
            vm.start(wait=60)
            ip = vm.wait_for_ssh(timeout=300)
            job.step("GUEST_PROVISION", "re-applying guest provisioning")
            provision_guest(vm, ip, job, image.load_manifest())
            job.step("HEALTHCHECK", "verifying")
            report["health"] = healthcheck(cfg, job)
            set_installation(state="READY", state_detail=None, last_health=report["health"])
            job.finish("SUCCEEDED", report)
    except Exception as e:  # noqa: BLE001
        report["error"] = str(e)
        job.step("FAILED_RECOVERABLE", str(e), status="failed")
        job.finish("FAILED", report, error=str(e))
    return report


STATIC_SECRET_REFS = ("nebula:guest_rpc_key", "nebula:app.server_key", "nebula:apns.key",
                      "nebula:telegram.callback_key", "nebula:telegram.bot_token", "nebula:provider.openai-siwc",
                      "nebula:github.token")


def instance_secret_refs() -> list[str]:
    """Every Keychain reference this instance may hold: the store's own index, every ref recorded in the DB
    (providers, Telegram main bot, per-agent bots), the fixed refs and one per catalogue provider."""
    refs: set[str] = set(STATIC_SECRET_REFS) | {secrets.INDEX_REF}
    lister = getattr(secrets.store(), "refs", None)
    if lister:
        refs.update(lister())
    try:
        with db.engine().connect() as c:
            for table in (models.providers, models.telegram_config, models.telegram_bots):
                refs.update(r.keychain_ref for r in c.execute(select(table.c.keychain_ref)) if r.keychain_ref)
            refs.update(f"nebula:provider.{r.id}" for r in c.execute(select(models.providers.c.id)))
    except Exception:  # noqa: BLE001 - DB missing/corrupt: the index and fixed refs still apply
        pass
    return sorted(r for r in refs if isinstance(r, str) and r.startswith("nebula:"))


def remove_instance_secrets(cfg: NebulaConfig) -> dict[str, Any]:
    """Delete all of this instance's Keychain items, and only those (the store is bound to this instance's
    service; refuse if it is not)."""
    st = secrets.store()
    expected = (secrets.service_name() if os.environ.get("NEBULA_KEYCHAIN_SERVICE")
                else secrets.service_name(cfg.instance_id))
    service = getattr(st, "service", None)
    if cfg.secret_backend == "keychain" and service != expected:
        raise InstallError("ROLLBACK", "keychain_service_mismatch",
                           f"secret store is bound to {service!r}, not this instance's {expected!r}; refusing",
                           recoverable=False)
    refs = instance_secret_refs()
    for ref in refs:
        st.delete(ref)
    return {"service": service, "count": len(refs)}


def uninstall(cfg: NebulaConfig, *, remove_data: bool, confirm: str | None, printer=print) -> dict[str, Any]:
    """keep data (default): stop VM + remove LaunchAgent. remove_data: also delete VM, DB and Keychain secrets.
    Requires confirm == 'DELETE-ALL-NEBULA-DATA' for the destructive option. Only this instance's LaunchAgent,
    data dir and Keychain service are touched."""
    from nebula_setup import launchd

    out: dict[str, Any] = {"remove_data": remove_data, "instance": cfg.instance_id}
    if remove_data and confirm != "DELETE-ALL-NEBULA-DATA":
        raise InstallError("ROLLBACK", "confirmation_required",
                           "destructive uninstall requires --confirm DELETE-ALL-NEBULA-DATA", recoverable=False)
    try:
        out["launch_agent_removed"] = launchd.uninstall(cfg.launchd_label, cfg.data_dir)
    except launchd.LaunchdConflict as e:
        out["launch_agent_removed"] = False
        out["launch_agent_kept"] = str(e)
    vm = VMManager(cfg)
    if vm.exists():
        try:
            out["vm_stop"] = vm.stop()
        except VMError as e:
            out["vm_stop"] = {"error": str(e)}
    # orphan check: no helper or VZ process left for our bundle
    ps = subprocess.run(["/bin/ps", "-axo", "pid=,command="], capture_output=True, text=True).stdout
    out["orphans"] = [ln.strip() for ln in ps.splitlines() if "nebula-vm start" in ln and str(vm.bundle) in ln]
    if remove_data:
        removed = remove_instance_secrets(cfg)
        out["secrets_removed"] = removed["count"]
        out["keychain_service"] = removed["service"]
        for p in (cfg.data_dir, cfg.log_dir):
            if p.exists() and "NEBULA" in str(p):
                shutil.rmtree(p)
        out["data_removed"] = [str(cfg.data_dir), str(cfg.log_dir)]
    else:
        out["data_kept"] = str(cfg.data_dir)
    printer(out)
    return out
