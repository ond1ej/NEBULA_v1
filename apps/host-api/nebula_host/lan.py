"""Opt-in LAN access to the dashboard (owner-enabled, local network only).

* Listeners bind ONLY to RFC1918 IPv4 addresses of physical interfaces (en*). The VM bridge (bridge*/vmnet), VPN
  tunnels (utun*, e.g. Tailscale) and loopback-only aliases are never bound, so agents inside the VM and remote
  VPN peers cannot reach the dashboard.
* Every request is additionally filtered by source address: loopback or the subnet of a LAN interface.
* Optional HTTPS listener with a NEBULA local CA whose certificate carries critical Name Constraints (private
  IP ranges and .local names only), so even a leaked CA key cannot mint certificates for public sites.
* The listeners run as extra uvicorn servers inside the main process (lifespan off) and follow IP changes.
"""

from __future__ import annotations

import asyncio
import contextlib
import datetime as dt
import ipaddress
import logging
import os
import re
import socket
import ssl
import subprocess
import time
from pathlib import Path
from typing import Any

log = logging.getLogger("nebula.lan")
PRIVATE_NETS = [ipaddress.ip_network(n) for n in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")]
_iface_cache: tuple[float, list[dict[str, Any]]] = (0.0, [])


def _parse_ifconfig(text: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    iface = ""
    flags_up = False
    for line in text.splitlines():
        m = re.match(r"^([a-zA-Z0-9]+): flags=\d+<([^>]*)>", line)
        if m:
            iface, flags_up = m.group(1), "UP" in m.group(2).split(",")
            continue
        m = re.match(r"^\s+inet (\d+\.\d+\.\d+\.\d+) netmask (0x[0-9a-f]+)", line)
        if m and iface:
            out.append({"iface": iface, "ip": m.group(1), "prefix": bin(int(m.group(2), 16)).count("1"), "up": flags_up})
    return out


def lan_interfaces(force: bool = False) -> list[dict[str, Any]]:
    """Physical (en*) interfaces with a private IPv4 address — the only places LAN listeners may bind."""
    global _iface_cache
    if not force and time.time() - _iface_cache[0] < 10:
        return _iface_cache[1]
    try:
        text = subprocess.run(["/sbin/ifconfig"], capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.TimeoutExpired):
        text = ""
    res = []
    for e in _parse_ifconfig(text):
        if not e["up"] or not re.match(r"^en\d+$", e["iface"]):
            continue
        ip = ipaddress.ip_address(e["ip"])
        if any(ip in n for n in PRIVATE_NETS) and not ip.is_link_local:
            net = ipaddress.ip_network(f"{e['ip']}/{e['prefix']}", strict=False)
            res.append({**e, "network": str(net)})
    _iface_cache = (time.time(), res)
    return res


_mdns_cache: tuple[float, str | None] = (0.0, None)
MDNS_TTL_S = 60


def mdns_name(force: bool = False) -> str | None:
    """The Mac's Bonjour name. Cached: the request guard asks for it on every HTTP request, and spawning `scutil`
    each time blocked the event loop for ~10 ms per request (perf audit 2026-11-16)."""
    global _mdns_cache
    if not force and time.time() - _mdns_cache[0] < MDNS_TTL_S:
        return _mdns_cache[1]
    try:
        name = subprocess.run(["/usr/sbin/scutil", "--get", "LocalHostName"], capture_output=True, text=True,
                              timeout=5).stdout.strip()
        val = f"{name}.local" if name else None
    except (OSError, subprocess.TimeoutExpired):
        val = None
    _mdns_cache = (time.time(), val)
    return val


def client_allowed(addr: str | None, enabled: bool) -> bool:
    """Loopback always; LAN clients only while LAN access is enabled and only from a LAN interface subnet."""
    if not addr:
        return False
    try:
        ip = ipaddress.ip_address(addr.split("%", 1)[0])
    except ValueError:
        return False
    if ip.is_loopback:
        return True
    if not enabled or ip.version != 4:
        return False
    return any(ip in ipaddress.ip_network(i["network"]) for i in lan_interfaces())


def lan_hosts(port: int, https_port: int | None) -> set[str]:
    hosts: set[str] = set()
    names = [i["ip"] for i in lan_interfaces()]
    if (m := mdns_name()):
        names.append(m)
    for n in names:
        hosts.add(f"{n}:{port}")
        if https_port:
            hosts.add(f"{n}:{https_port}")
    return hosts


def lan_origins(port: int, https_port: int | None) -> set[str]:
    out: set[str] = set()
    names = [i["ip"] for i in lan_interfaces()]
    if (m := mdns_name()):
        names.append(m)
    for n in names:
        out.add(f"http://{n}:{port}")
        if https_port:
            out.add(f"https://{n}:{https_port}")
    return out


# --------------------------------------------------------------------------------------------- local CA
def ensure_tls(keys_dir: Path, ips: list[str], name: str | None) -> dict[str, Any]:
    """Create (once) a name-constrained local CA and (re)issue the server certificate for the current LAN names."""
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

    keys_dir.mkdir(parents=True, exist_ok=True)
    ca_key_p, ca_crt_p = keys_dir / "lan_ca.key", keys_dir / "lan_ca.crt"
    srv_key_p, srv_crt_p = keys_dir / "lan_server.key", keys_dir / "lan_server.crt"
    now = dt.datetime.now(dt.UTC)

    def write_private(p: Path, data: bytes) -> None:
        fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "wb") as f:
            f.write(data)

    if not (ca_key_p.exists() and ca_crt_p.exists()):
        ca_key = ec.generate_private_key(ec.SECP256R1())
        host = socket.gethostname().split(".")[0][:40]
        subj = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, f"NEBULA Local CA ({host})"),
                          x509.NameAttribute(NameOID.ORGANIZATION_NAME, "NEBULA (local only)")])
        permitted = [x509.IPAddress(n) for n in PRIVATE_NETS] + [x509.DNSName("local"), x509.DNSName(".local")]
        ca = (x509.CertificateBuilder().subject_name(subj).issuer_name(subj).public_key(ca_key.public_key())
              .serial_number(x509.random_serial_number()).not_valid_before(now - dt.timedelta(minutes=5))
              .not_valid_after(now + dt.timedelta(days=3650))
              .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
              .add_extension(x509.KeyUsage(digital_signature=False, content_commitment=False, key_encipherment=False,
                                           data_encipherment=False, key_agreement=False, key_cert_sign=True,
                                           crl_sign=True, encipher_only=False, decipher_only=False), critical=True)
              .add_extension(x509.NameConstraints(permitted_subtrees=permitted, excluded_subtrees=None), critical=True)
              .add_extension(x509.SubjectKeyIdentifier.from_public_key(ca_key.public_key()), critical=False)
              .sign(ca_key, hashes.SHA256()))
        write_private(ca_key_p, ca_key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                                     serialization.NoEncryption()))
        ca_crt_p.write_bytes(ca.public_bytes(serialization.Encoding.PEM))
        os.chmod(ca_crt_p, 0o644)
    ca_key = serialization.load_pem_private_key(ca_key_p.read_bytes(), password=None)
    ca = x509.load_pem_x509_certificate(ca_crt_p.read_bytes())

    want = sorted(set(ips)) + ([name] if name else [])
    reissue = True
    if srv_crt_p.exists() and srv_key_p.exists():
        cur = x509.load_pem_x509_certificate(srv_crt_p.read_bytes())
        san = cur.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
        have = sorted(str(v) for v in san.get_values_for_type(x509.IPAddress)) + san.get_values_for_type(x509.DNSName)
        reissue = sorted(have) != sorted(want) or cur.not_valid_after_utc - now < dt.timedelta(days=30)
    if reissue:
        key = ec.generate_private_key(ec.SECP256R1())
        sans: list[x509.GeneralName] = [x509.IPAddress(ipaddress.ip_address(i)) for i in sorted(set(ips))]
        if name:
            sans.append(x509.DNSName(name))
        cn = name or (ips[0] if ips else "nebula.local")
        crt = (x509.CertificateBuilder().subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, cn)]))
               .issuer_name(ca.subject).public_key(key.public_key()).serial_number(x509.random_serial_number())
               .not_valid_before(now - dt.timedelta(minutes=5)).not_valid_after(now + dt.timedelta(days=397))
               .add_extension(x509.SubjectAlternativeName(sans), critical=False)
               .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
               .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
               .add_extension(x509.KeyUsage(digital_signature=True, content_commitment=False, key_encipherment=False,
                                            data_encipherment=False, key_agreement=False, key_cert_sign=False,
                                            crl_sign=False, encipher_only=False, decipher_only=False), critical=True)
               .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()), critical=False)
               .sign(ca_key, hashes.SHA256()))
        write_private(srv_key_p, key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                                   serialization.NoEncryption()))
        srv_crt_p.write_bytes(crt.public_bytes(serialization.Encoding.PEM) + ca.public_bytes(serialization.Encoding.PEM))
    fp = ca.fingerprint(hashes.SHA256()).hex(":").upper()
    return {"ca_cert": str(ca_crt_p), "server_cert": str(srv_crt_p), "server_key": str(srv_key_p),
            "ca_sha256": fp, "ca_subject": ca.subject.rfc4514_string(), "reissued": reissue}


# --------------------------------------------------------------------------------------------- listeners
class _QuietServer:
    """Builds a uvicorn Server that never touches process signal handlers (the main server owns them)."""

    @staticmethod
    def make(app, *, ssl_files: dict[str, str] | None):
        import uvicorn

        class Server(uvicorn.Server):
            def capture_signals(self):  # type: ignore[override]
                return contextlib.nullcontext()

        kw: dict[str, Any] = {}
        if ssl_files:
            kw.update(ssl_certfile=ssl_files["server_cert"], ssl_keyfile=ssl_files["server_key"],
                      ssl_version=ssl.PROTOCOL_TLS_SERVER)
        cfg = uvicorn.Config(app, lifespan="off", log_level="info", ws_ping_interval=10, ws_ping_timeout=20,
                             proxy_headers=False, server_header=False, timeout_graceful_shutdown=5, **kw)
        return Server(cfg)


class LanManager:
    def __init__(self, cfg, app) -> None:
        self.cfg = cfg
        self.app = app
        self.servers: dict[tuple[str, int, bool], tuple[Any, asyncio.Task]] = {}
        self._task: asyncio.Task | None = None
        self.last_error: str | None = None
        self.tls: dict[str, Any] | None = None

    async def start(self) -> None:
        self._task = asyncio.create_task(self._loop(), name="lan-manager")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
        await self._apply(set())

    def desired(self) -> set[tuple[str, int, bool]]:
        lan = self.cfg.lan
        if not lan.enabled:
            return set()
        want = set()
        for i in lan_interfaces(force=True):
            want.add((i["ip"], self.cfg.instance.port, False))
            if lan.https:
                want.add((i["ip"], lan.https_port, True))
        return want

    async def reconcile(self) -> None:
        want = self.desired()
        if any(tls for _, _, tls in want):
            ips = sorted({ip for ip, _, _ in want})
            self.tls = await asyncio.to_thread(ensure_tls, self.cfg.keys_dir, ips, mdns_name())
            if self.tls["reissued"]:  # new certificate: restart TLS listeners so they load it
                for key in [k for k in self.servers if k[2]]:
                    await self._stop_one(key)
        await self._apply(want)

    async def _apply(self, want: set[tuple[str, int, bool]]) -> None:
        for key in list(self.servers):
            if key not in want:
                await self._stop_one(key)
        for key in want:
            if key in self.servers and not self.servers[key][1].done():
                continue
            ip, port, tls = key
            try:
                sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                sock.bind((ip, port))
                sock.listen(128)
                sock.setblocking(False)
            except OSError as e:
                self.last_error = f"cannot listen on {ip}:{port}: {e}"
                log.error(self.last_error)
                continue
            server = _QuietServer.make(self.app, ssl_files=self.tls if tls else None)
            task = asyncio.create_task(server.serve(sockets=[sock]), name=f"lan-{ip}:{port}")
            self.servers[key] = (server, task)
            self.last_error = None
            log.info("LAN listener up: %s://%s:%d", "https" if tls else "http", ip, port)

    async def _stop_one(self, key) -> None:
        server, task = self.servers.pop(key)
        server.should_exit = True
        with contextlib.suppress(asyncio.TimeoutError, asyncio.CancelledError, Exception):
            await asyncio.wait_for(task, 10)
        log.info("LAN listener down: %s:%d", key[0], key[1])

    async def _loop(self) -> None:
        while True:
            try:
                await self.reconcile()
            except Exception as e:  # noqa: BLE001
                self.last_error = str(e)
                log.exception("LAN reconcile failed")
            await asyncio.sleep(15)  # follows DHCP/IP changes and network coming up after boot

    def status(self) -> dict[str, Any]:
        lan = self.cfg.lan
        ifaces = lan_interfaces(force=True)
        name = mdns_name()
        addrs = []
        for i in ifaces:
            addrs.append({"iface": i["iface"], "ip": i["ip"], "network": i["network"],
                          "http_url": f"http://{i['ip']}:{self.cfg.instance.port}/",
                          "https_url": f"https://{i['ip']}:{lan.https_port}/" if lan.https else None})
        listening = [{"url": f"{'https' if tls else 'http'}://{ip}:{port}/", "running": not t.done()}
                     for (ip, port, tls), (_, t) in self.servers.items()]
        return {"enabled": lan.enabled, "https": lan.https, "port": self.cfg.instance.port, "https_port": lan.https_port,
                "addresses": addrs, "mdns_name": name,
                "mdns_urls": ([f"http://{name}:{self.cfg.instance.port}/"] +
                              ([f"https://{name}:{lan.https_port}/"] if lan.https else [])) if name else [],
                "listening": listening, "last_error": self.last_error,
                "ca": {"sha256": self.tls["ca_sha256"], "subject": self.tls["ca_subject"]} if self.tls else None,
                "loopback_url": f"http://127.0.0.1:{self.cfg.instance.port}/"}
