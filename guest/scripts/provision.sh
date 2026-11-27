#!/bin/bash
# NEBULA guest provisioning — idempotent; safe to re-run (used by install AND repair).
# Runs as root inside the Ubuntu ARM64 VM. Inputs (uploaded by the host over SSH):
#   $1  path to guest bundle tarball (nebula_guest + nebula_contracts + desktop files)
#   $2  path to the RPC key file (hex, 32 bytes) — moved to /etc/nebula/rpc.key (0600)
#   nebula-guest-version (optional) next to the bundle; NEBULA_GUEST_REQUIREMENTS (optional) hash-pinned pip file
# The host should stage these inputs in a private directory (e.g. mktemp -d in ~nebula-admin), not in the shared
# /tmp that every agent can write to (audit VM-10). Staged inputs owned by anyone but root or the uploading admin
# are refused.
# Progress lines "NEBULA_STEP <name>" are parsed by the host installer.
set -euo pipefail
BUNDLE="${1:?bundle path}"
KEYFILE="${2:-}"
STAGE_DIR="$(dirname "$BUNDLE")"
PLAYWRIGHT_VERSION="${NEBULA_PLAYWRIGHT_VERSION:-1.65.2}"
GUEST_REQUIREMENTS="${NEBULA_GUEST_REQUIREMENTS:-}"
export DEBIAN_FRONTEND=noninteractive
step() { echo "NEBULA_STEP $*"; }
# A staged input must be a regular file (never a symlink) owned by root or by the admin who uploaded it over SSH,
# so a file an agent planted in a shared directory is never used as root.
staged_ok() {
  local f="$1" owner
  [ -f "$f" ] && [ ! -L "$f" ] || return 1
  owner="$(stat -c %U -- "$f")"
  [ "$owner" = root ] || [ "$owner" = "${SUDO_USER:-root}" ]
}
for f in "$BUNDLE" ${KEYFILE:+"$KEYFILE"} ${GUEST_REQUIREMENTS:+"$GUEST_REQUIREMENTS"}; do
  # the RPC key is optional on re-runs (an existing /etc/nebula/rpc.key is kept), but never a planted file
  if [ "$f" = "$KEYFILE" ] && [ ! -e "$f" ] && [ ! -L "$f" ]; then continue; fi
  if ! staged_ok "$f"; then
    echo "refusing staged input $f: not a regular file owned by root or ${SUDO_USER:-root}" >&2
    exit 1
  fi
done
GUEST_VERSION=dev
if staged_ok "$STAGE_DIR/nebula-guest-version"; then
  GUEST_VERSION="$(head -c 64 "$STAGE_DIR/nebula-guest-version" | tr -cd 'A-Za-z0-9._+-')"
  GUEST_VERSION="${GUEST_VERSION:-dev}"
fi

step security_baseline
install -d -m 0755 /etc/ssh/sshd_config.d
cat > /etc/ssh/sshd_config.d/90-nebula.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
PermitEmptyPasswords no
AllowUsers nebula-admin
X11Forwarding no
EOF
systemctl reload ssh || systemctl reload sshd || true
passwd -l root >/dev/null 2>&1 || true
# remove the stock cloud user if an image ever ships one
if id ubuntu >/dev/null 2>&1; then userdel -r ubuntu || true; fi
echo vmw_vsock_virtio_transport > /etc/modules-load.d/nebula.conf
modprobe vmw_vsock_virtio_transport || true
# serial console on virtio console for diagnostics (console.log on host)
# kernel log on the virtio console (host console.log) + full fsck/repair of the root fs on every boot, so a VM that
# had to be force-stopped never runs on a damaged filesystem
if ! grep -q 'fsck.repair=yes' /etc/default/grub.d/90-nebula.cfg 2>/dev/null; then
  echo 'GRUB_CMDLINE_LINUX_DEFAULT="console=hvc0 fsck.mode=force fsck.repair=yes"' > /etc/default/grub.d/90-nebula.cfg
  update-grub >/dev/null 2>&1 || true
fi

step apt_install
PKGS="xfce4-session xfwm4 xfce4-panel xfdesktop4 xfce4-settings xfce4-terminal thunar \
  xfce4-notifyd adwaita-icon-theme elementary-xfce-icon-theme \
  tigervnc-standalone-server tigervnc-tools xauth x11-utils x11-xserver-utils xdotool dbus-x11 \
  fonts-dejavu-core fonts-liberation2 fonts-noto-core libatomic1 earlyoom \
  python3-venv python3-pip python3-dev ca-certificates curl nftables acl util-linux \
  poppler-utils git mousepad"
MISSING=""
for p in $PKGS; do
  dpkg-query -W -f='${Status}' "$p" 2>/dev/null | grep -q "install ok installed" || MISSING="$MISSING $p"
done
if [ -n "$MISSING" ]; then
  apt-get update -q
  # shellcheck disable=SC2086
  apt-get install -y -q --no-install-recommends $MISSING
fi
install -d -m 0700 /var/lib/nebula
install -d -m 0755 /srv/nebula /srv/nebula/shared /opt/nebula/plugins

step memory_safety
# Without swap a full guest thrashes page cache and freezes (observed on hardware, docs/decisions.md D26).
if ! swapon --show=NAME --noheadings | grep -qx /swapfile; then
  if [ ! -f /swapfile ]; then fallocate -l 2G /swapfile; chmod 600 /swapfile; mkswap /swapfile >/dev/null; fi
  swapon /swapfile
fi
grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
cat > /etc/sysctl.d/90-nebula.conf <<'EOF2'
vm.swappiness = 60
vm.min_free_kbytes = 65536
vm.watermark_scale_factor = 200
EOF2
sysctl -q --system || true
# earlyoom: kill the biggest browser renderer before the kernel livelocks; never the desktop/guest service
cat > /etc/default/earlyoom <<'EOF2'
EARLYOOM_ARGS="-m 6,3 -s 20,10 -r 0 --prefer '(chrome|chromium|chrome_crashpad)' --avoid '(^|/)(Xvnc|xfce4-session|python3|systemd|sshd|nebula-guest)$'"
EOF2
systemctl enable earlyoom >/dev/null 2>&1 || true
systemctl restart earlyoom || true

step python_runtime
install -d -m 0755 /opt/nebula
if [ ! -x /opt/nebula/venv/bin/python ]; then
  python3 -m venv /opt/nebula/venv
fi
# Wheels only (--only-binary :all:): pip never downloads and builds an sdist, so no package build script ever runs
# as root here. Every package in the lock ships an aarch64 Linux wheel.
if [ -n "$GUEST_REQUIREMENTS" ]; then
  # hash-pinned lock file staged by the host (checked by staged_ok above); every file hash must match
  /opt/nebula/venv/bin/pip install -q --require-hashes --only-binary :all: -r "$GUEST_REQUIREMENTS"
else
  # manual runs without the host's lock file only (the installer always stages it): not hash-pinned
  echo "warning: NEBULA_GUEST_REQUIREMENTS not set; installing playwright without hash pinning" >&2
  /opt/nebula/venv/bin/pip install -q --only-binary :all: --upgrade pip
  /opt/nebula/venv/bin/pip install -q --only-binary :all: "playwright==${PLAYWRIGHT_VERSION}" "pillow>=10"
fi

step browser_install
export PLAYWRIGHT_BROWSERS_PATH=/opt/nebula/ms-playwright
install -d -m 0755 "$PLAYWRIGHT_BROWSERS_PATH"
/opt/nebula/venv/bin/python -m playwright install-deps chromium >/dev/null
/opt/nebula/venv/bin/python -m playwright install chromium
chmod -R a+rX "$PLAYWRIGHT_BROWSERS_PATH"
# Ubuntu 24.04 restricts unprivileged user namespaces; allow them ONLY for the Playwright
# Chromium binary so its sandbox works (instead of running with --no-sandbox).
# Known limit (audit VM-12), accepted on purpose: AppArmor attaches this profile by binary path, and an agent
# controls that binary's environment and flags (LD_PRELOAD, --renderer-cmd-prefix, ...), so agent code CAN obtain
# unprivileged user namespaces through it. The exception cannot be scoped to "only Chromium's own sandbox". The
# alternative, --no-sandbox, would drop Chromium's renderer sandbox against hostile web pages, which agents load all
# day; that is the larger risk. Net effect: an agent gets the user-namespace ability every Ubuntu user had before
# 23.10 (more kernel attack surface, no new privileges). Keep the guest kernel patched.
CHROME_BIN="$(ls -d "$PLAYWRIGHT_BROWSERS_PATH"/chromium-*/chrome-linux*/chrome 2>/dev/null | head -1 || true)"
if [ -n "$CHROME_BIN" ] && [ -d /etc/apparmor.d ]; then
  cat > /etc/apparmor.d/nebula-chromium <<EOF
abi <abi/4.0>,
include <tunables/global>
profile nebula-chromium ${PLAYWRIGHT_BROWSERS_PATH}/chromium-*/chrome-linux*/chrome flags=(unconfined) {
  userns,
  include if exists <local/nebula-chromium>
}
EOF
  apparmor_parser -r /etc/apparmor.d/nebula-chromium || true
fi

step guest_code
TMPD="$(mktemp -d)"
tar -xzf "$BUNDLE" -C "$TMPD"
rm -rf /opt/nebula/guest.new
install -d -m 0755 /opt/nebula/guest.new
cp -a "$TMPD"/. /opt/nebula/guest.new/
chown -R root:root /opt/nebula/guest.new
chmod -R a+rX,go-w /opt/nebula/guest.new
chmod 0755 /opt/nebula/guest.new/desktop/bin/*
rm -rf /opt/nebula/guest.old
if [ -d /opt/nebula/guest ]; then mv /opt/nebula/guest /opt/nebula/guest.old; fi
mv /opt/nebula/guest.new /opt/nebula/guest
rm -rf "$TMPD" "$BUNDLE"
install -m 0644 /opt/nebula/guest/desktop/systemd/*.service /etc/systemd/system/

step vault_broker
# Password Vault login broker (V3.2): a dedicated system user that is NOT an agent, has no login shell, no shared
# groups and a private home. The guest service runs the isolated login (vault_login.py) as this user.
if ! id -u nebula-vault >/dev/null 2>&1; then
  useradd --system --user-group --home-dir /var/lib/nebula-vault --create-home --shell /usr/sbin/nologin nebula-vault
fi
install -d -m 0700 -o nebula-vault -g nebula-vault /var/lib/nebula-vault
usermod -s /usr/sbin/nologin -G "" nebula-vault 2>/dev/null || true
passwd -l nebula-vault >/dev/null 2>&1 || true

step rpc_key
install -d -m 0700 /etc/nebula
if [ -n "$KEYFILE" ] && [ -f "$KEYFILE" ]; then
  install -m 0600 -o root -g root "$KEYFILE" /etc/nebula/rpc.key
  shred -u "$KEYFILE" 2>/dev/null || rm -f "$KEYFILE"
fi
test -s /etc/nebula/rpc.key

step firewall
# DNS resolvers this VM actually uses (audit VM-05), for the dns4 / dns6 sets below: the upstream servers
# systemd-resolved got from DHCP or router advertisements (/run/systemd/resolve/resolv.conf), any nameserver in the
# other files given, and the default IPv4 gateway (Apple's vmnet NAT answers DNS there). Loopback is skipped ("oif lo"
# already allows the local stub resolver). Only plain addresses are accepted, so nothing a DHCP server sends can
# inject nft syntax. Prints nft "add element" lines.
nft_join() { local out="" x; for x in "$@"; do out="${out:+$out, }$x"; done; printf '%s' "$out"; }
dns_resolver_elements() {  # $1 = default IPv4 gateway (may be empty), $2... = resolv.conf-style files
  local gw="$1" f a
  local -a v4=() v6=()
  shift
  while read -r a; do
    a="${a%%[%]*}"  # an IPv6 zone index (fe80::1%enp0s1) cannot go into an nft set
    case "$a" in ''|127.*|::1|0.0.0.0|::) continue ;; esac
    if [[ "$a" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
      [[ " ${v4[*]-} " == *" $a "* ]] || v4+=("$a")
    elif [[ "$a" =~ ^[0-9A-Fa-f:]+$ && "$a" == *:* ]]; then
      [[ " ${v6[*]-} " == *" $a "* ]] || v6+=("$a")
    fi
  done < <(for f in "$@"; do if [ -r "$f" ]; then awk '$1 == "nameserver" {print $2}' "$f"; fi; done
           printf '%s\n' "$gw")
  # nothing found: Apple vmnet's NAT gateway and DNS proxy (the address the input chain trusts for SSH)
  [ "${#v4[@]}" -gt 0 ] || v4=(192.168.64.1)
  echo "add element inet filter dns4 { $(nft_join "${v4[@]}") }"
  if [ "${#v6[@]}" -gt 0 ]; then echo "add element inet filter dns6 { $(nft_join "${v6[@]}") }"; fi
}
GW4="$(ip -4 route show default 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "via") {print $(i + 1); exit}}')"
{
  echo "# generated by NEBULA provisioning (repair regenerates it): the DNS resolvers agents may reach"
  dns_resolver_elements "$GW4" /run/systemd/resolve/resolv.conf /etc/resolv.conf
} > /etc/nebula/firewall-dns.nft
chmod 0600 /etc/nebula/firewall-dns.nft
# Owner-approved exceptions to the egress block below (apply to every agent); kept across repair.
if [ ! -f /etc/nebula/firewall-lan-allow.nft ]; then
  cat > /etc/nebula/firewall-lan-allow.nft <<'EOF'
# NEBULA guest egress exceptions (owner-managed). Agents cannot reach private, link-local or CGNAT addresses
# (your LAN, this Mac, other VMs, Tailscale) unless an address or range is listed here, one line each, e.g.
#   add element inet filter lan_allow4 { 192.168.1.20 }
#   add element inet filter lan_allow6 { fd00::20 }
# Apply with: sudo nft -c -f /etc/nftables.conf && sudo nft -f /etc/nftables.conf
EOF
  chmod 0600 /etc/nebula/firewall-lan-allow.nft
fi
cat > /etc/nftables.conf <<'EOF'
#!/usr/sbin/nft -f
# NEBULA guest firewall.
# input:  nothing except SSH (key-only) from the host NAT gateway. Host<->guest RPC and VNC use virtio-vsock,
#         which is not IP traffic.
# output: agents keep Internet access but cannot reach the owner's LAN, the Mac itself (NAT gateway 192.168.64.1),
#         other VMs on the vmnet bridge, link-local, CGNAT/Tailscale or multicast addresses (audit VM-05).
#         DHCP stays open. DNS (port 53) to a private address is allowed only to the resolvers this VM uses
#         (/etc/nebula/firewall-dns.nft, regenerated on every provisioning and repair); DNS to public resolvers is
#         Internet egress like any other. Exceptions: /etc/nebula/firewall-lan-allow.nft
flush ruleset
table inet filter {
  set lan_allow4 { type ipv4_addr; flags interval; }
  set lan_allow6 { type ipv6_addr; flags interval; }
  set dns4 { type ipv4_addr; }
  set dns6 { type ipv6_addr; }
  set blocked4 {
    type ipv4_addr
    flags interval
    elements = { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24,
                 192.168.0.0/16, 198.18.0.0/15, 224.0.0.0/3 }
  }
  set blocked6 {
    type ipv6_addr
    flags interval
    elements = { fc00::/7, fe80::/10, ff00::/8 }
  }
  chain input {
    type filter hook input priority 0; policy drop;
    iif lo accept
    ct state established,related accept
    ip protocol icmp accept
    ip6 nexthdr ipv6-icmp accept
    udp sport 67 udp dport 68 accept
    ip saddr 192.168.64.1 tcp dport 22 accept
  }
  chain forward { type filter hook forward priority 0; policy drop; }
  chain output {
    type filter hook output priority 0; policy accept;
    oif lo accept
    ct state established,related accept
    # sshd's replies to the host. Needed even with the conntrack rule above: the installer's SSH session is opened
    # before this ruleset (and conntrack) first loads, so its next packet out is picked up mid-stream as a new flow
    # to 192.168.64.1 and would hit the drop below, hanging provisioning. Only root's sshd can send from port 22.
    ip daddr 192.168.64.1 tcp sport 22 accept
    ip daddr @dns4 meta l4proto { tcp, udp } th dport 53 accept
    ip6 daddr @dns6 meta l4proto { tcp, udp } th dport 53 accept
    udp sport 68 udp dport 67 accept
    udp sport 546 udp dport 547 accept
    meta l4proto ipv6-icmp accept
    ip daddr @lan_allow4 accept
    ip6 daddr @lan_allow6 accept
    ip daddr @blocked4 limit rate 6/minute log prefix "nebula-egress-drop " level info
    ip daddr @blocked4 counter drop
    ip6 daddr @blocked6 counter drop
  }
}
include "/etc/nebula/firewall-dns.nft"
include "/etc/nebula/firewall-lan-allow.nft"
EOF
# validate before loading: a broken ruleset must fail provisioning, never leave the guest half-configured
if ! nft -c -f /etc/nftables.conf; then
  echo "warning: nft refused the ruleset; retrying with only the vmnet gateway as DNS resolver" >&2
  dns_resolver_elements "" > /etc/nebula/firewall-dns.nft
  nft -c -f /etc/nftables.conf
fi
systemctl enable --now nftables >/dev/null 2>&1
nft -f /etc/nftables.conf

step services
systemctl daemon-reload
systemctl enable nebula-guest.service >/dev/null 2>&1
systemctl restart nebula-guest.service
# re-apply units for existing agents (repair path)
systemctl restart 'nebula-desktop@*' 'nebula-tools@*' 2>/dev/null || true
for i in $(seq 1 30); do
  systemctl is-active --quiet nebula-guest.service && break
  sleep 1
done
systemctl is-active --quiet nebula-guest.service

step finalize
echo "$GUEST_VERSION" > /var/lib/nebula/provisioned
apt-get clean
echo "NEBULA_PROVISION_OK"
