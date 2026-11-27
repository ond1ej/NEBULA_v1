"""LAN access rules: which interfaces may listen, which clients may connect, CA constraints, API toggle."""

from __future__ import annotations

import pytest

IFCONFIG = """lo0: flags=8049<UP,LOOPBACK,RUNNING,MULTICAST> mtu 16384
\tinet 127.0.0.1 netmask 0xff000000
en0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
\tinet 169.254.10.10 netmask 0xffff0000
en1: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
\tinet 192.168.1.20 netmask 0xffffff00 broadcast 192.168.1.255
en5: flags=8822<BROADCAST,SMART,SIMPLEX,MULTICAST> mtu 1500
\tinet 10.0.0.9 netmask 0xff000000
bridge100: flags=8a63<UP,BROADCAST,SMART,RUNNING,ALLMULTI,SIMPLEX,MULTICAST> mtu 1500
\tinet 192.168.64.1 netmask 0xffffff00 broadcast 192.168.64.255
utun4: flags=8051<UP,POINTOPOINT,RUNNING,MULTICAST> mtu 1280
\tinet 100.101.102.103 netmask 0xffffffff
"""


@pytest.fixture()
def fake_ifaces(monkeypatch):
    import subprocess

    from nebula_host import lan

    real = subprocess.run

    def run(cmd, *a, **kw):
        if cmd and cmd[0] == "/sbin/ifconfig":
            return subprocess.CompletedProcess(cmd, 0, IFCONFIG, "")
        if cmd and cmd[0] == "/usr/sbin/scutil":
            return subprocess.CompletedProcess(cmd, 0, "nebula-mini\n", "")
        return real(cmd, *a, **kw)

    monkeypatch.setattr(lan.subprocess, "run", run)
    lan._iface_cache = (0.0, [])
    lan._mdns_cache = (0.0, None)  # the Bonjour name is cached too (perf audit): never leak it between tests
    yield lan
    lan._iface_cache = (0.0, [])
    lan._mdns_cache = (0.0, None)


def test_only_physical_private_up_interfaces_are_lan(fake_ifaces):
    ifs = fake_ifaces.lan_interfaces(force=True)
    assert [(i["iface"], i["ip"], i["network"]) for i in ifs] == [("en1", "192.168.1.20", "192.168.1.0/24")]


@pytest.mark.parametrize("addr,enabled,ok", [
    ("127.0.0.1", False, True), ("::1", False, True),
    ("192.168.1.50", True, True), ("192.168.1.50", False, False),
    ("192.168.64.3", True, False),  # an agent inside the VM
    ("100.101.102.200", True, False),  # VPN peer (Tailscale range)
    ("8.8.8.8", True, False), ("10.0.0.5", True, False),  # interface down
    ("", True, False), ("garbage", True, False),
])
def test_client_filter(fake_ifaces, addr, enabled, ok):
    assert fake_ifaces.client_allowed(addr, enabled) is ok


def test_hosts_and_origins_cover_ip_and_mdns(fake_ifaces):
    assert fake_ifaces.lan_hosts(3101, 3443) == {"192.168.1.20:3101", "192.168.1.20:3443",
                                                 "nebula-mini.local:3101", "nebula-mini.local:3443"}
    assert "https://192.168.1.20:3443" in fake_ifaces.lan_origins(3101, 3443)
    assert "http://192.168.64.1:3101" not in fake_ifaces.lan_origins(3101, 3443)


def test_local_ca_is_name_constrained_and_issues_valid_server_cert(tmp_path):
    from cryptography import x509
    from nebula_host import lan

    info = lan.ensure_tls(tmp_path, ["192.168.1.20"], "nebula-mini.local")
    ca = x509.load_pem_x509_certificate((tmp_path / "lan_ca.crt").read_bytes())
    nc = ca.extensions.get_extension_for_class(x509.NameConstraints)
    assert nc.critical and {str(v.value) for v in nc.value.permitted_subtrees} >= {"192.168.0.0/16", "10.0.0.0/8",
                                                                                    "172.16.0.0/12", "local"}
    srv = x509.load_pem_x509_certificates((tmp_path / "lan_server.crt").read_bytes())[0]
    srv.verify_directly_issued_by(ca)
    san = srv.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    assert [str(i) for i in san.get_values_for_type(x509.IPAddress)] == ["192.168.1.20"]
    assert san.get_values_for_type(x509.DNSName) == ["nebula-mini.local"]
    assert (tmp_path / "lan_ca.key").stat().st_mode & 0o777 == 0o600
    assert lan.ensure_tls(tmp_path, ["192.168.1.20"], "nebula-mini.local")["reissued"] is False
    assert lan.ensure_tls(tmp_path, ["192.168.1.99"], "nebula-mini.local")["reissued"] is True  # IP changed
    assert info["ca_sha256"].count(":") == 31


def test_lan_toggle_persists_and_siwc_requires_loopback(data_dir, monkeypatch):
    from fastapi.testclient import TestClient
    from nebula_host import auth, lan
    from nebula_host.app import create_app

    monkeypatch.setattr(lan, "lan_interfaces", lambda force=False: [])  # never bind real sockets in tests
    monkeypatch.setattr(lan, "mdns_name", lambda: "nebula-mini.local")
    auth._ip_attempts.clear()
    with TestClient(create_app(), base_url="http://127.0.0.1:3199") as c:
        o = {"origin": "http://127.0.0.1:3199"}
        r = c.post("/api/v1/auth/setup", json={"username": "o", "password": "correct horse battery",
                                               "setup_token": auth.ensure_setup_token()}, headers=o)
        h = {**o, "x-csrf-token": r.json()["data"]["csrf_token"]}
        assert c.get("/api/v1/system/lan").json()["data"]["enabled"] is False
        # LAN host is rejected while LAN access is off (DNS-rebinding / host allowlist)
        assert c.get("/api/v1/health", headers={"host": "nebula-mini.local:3199"}).status_code == 403
        r = c.post("/api/v1/system/lan", json={"enabled": True, "https": False}, headers=h).json()["data"]
        assert r["enabled"] is True
        from nebula_host.config import load_config

        assert load_config().lan.enabled is True  # written to config.yaml
        assert c.get("/api/v1/health", headers={"host": "nebula-mini.local:3199"}).status_code == 200
        lan_h = {"host": "nebula-mini.local:3199", "origin": "http://nebula-mini.local:3199",
                 "x-csrf-token": h["x-csrf-token"]}
        r = c.post("/api/v1/providers/openai-siwc/connect", headers=lan_h)
        assert r.status_code == 409 and r.json()["error"]["code"] == "loopback_required"
        csp = c.get("/api/v1/health", headers={"host": "nebula-mini.local:3199"}).headers["content-security-policy"]
        assert "ws://nebula-mini.local:3199" in csp
        c.post("/api/v1/system/lan", json={"enabled": False}, headers=h)
        assert c.get("/api/v1/health", headers={"host": "nebula-mini.local:3199"}).status_code == 403
