"""Per-installation keys and cloud-init NoCloud seed ISO (no default credentials anywhere)."""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import yaml


def _write_private(path: Path, data: str) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(data)


def ensure_ssh_keys(keys_dir: Path) -> dict[str, Path]:
    """Admin client key (host -> guest) and the guest's SSH host key, both generated per installation.
    The guest host key is injected through cloud-init so the host can pin it (no trust-on-first-use)."""
    keys_dir.mkdir(parents=True, exist_ok=True)
    os.chmod(keys_dir, 0o700)
    client = keys_dir / "guest_admin_ed25519"
    hostkey = keys_dir / "guest_host_ed25519"
    for p, comment in ((client, "nebula-host-admin"), (hostkey, "nebula-guest-host")):
        if not p.exists():
            subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", comment, "-f", str(p)], check=True)
        os.chmod(p, 0o600)
    return {"client": client, "client_pub": client.with_suffix(".pub"), "host": hostkey,
            "host_pub": hostkey.with_suffix(".pub")}


def write_known_hosts(keys: dict[str, Path], known_hosts: Path, ip_pattern: str = "192.168.64.*") -> None:
    pub = keys["host_pub"].read_text().split()
    _write_private(known_hosts, f"{ip_pattern} {pub[0]} {pub[1]}\n")


def build_seed_iso(out: Path, installation_id: str, keys: dict[str, Path], hostname: str = "nebula-vm") -> Path:
    user_data = {
        "hostname": hostname,
        "preserve_hostname": False,
        "ssh_pwauth": False,
        "disable_root": True,
        "ssh_deletekeys": True,
        "ssh_genkeytypes": [],
        "ssh_keys": {
            "ed25519_private": keys["host"].read_text(),
            "ed25519_public": keys["host_pub"].read_text().strip(),
        },
        "users": [{
            "name": "nebula-admin",
            "gecos": "NEBULA provisioning (key-only)",
            "lock_passwd": True,
            "shell": "/bin/bash",
            "sudo": "ALL=(ALL) NOPASSWD:ALL",
            "ssh_authorized_keys": [keys["client_pub"].read_text().strip()],
        }],
        "growpart": {"mode": "auto", "devices": ["/"]},
        "resize_rootfs": True,
        "write_files": [{
            "path": "/etc/ssh/sshd_config.d/90-nebula.conf",
            "permissions": "0644",
            "content": "PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\n"
                       "PermitEmptyPasswords no\nAllowUsers nebula-admin\nX11Forwarding no\n",
        }],
        "runcmd": [
            ["modprobe", "vmw_vsock_virtio_transport"],
            ["sh", "-c", "echo NEBULA_CLOUDINIT_DONE > /dev/hvc0 || true"],
        ],
    }
    meta = {"instance-id": f"nebula-{installation_id}", "local-hostname": hostname}
    with tempfile.TemporaryDirectory() as td:
        d = Path(td) / "seed"
        d.mkdir(mode=0o700)
        _write_private(d / "user-data", "#cloud-config\n" + yaml.safe_dump(user_data, sort_keys=False))
        _write_private(d / "meta-data", yaml.safe_dump(meta))
        if out.exists():
            out.unlink()
        hdiutil = shutil.which("hdiutil") or "/usr/bin/hdiutil"
        subprocess.run([hdiutil, "makehybrid", "-quiet", "-o", str(out), str(d), "-iso", "-joliet",
                        "-default-volume-name", "cidata"], check=True)
    os.chmod(out, 0o600)
    return out
