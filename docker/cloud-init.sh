#!/bin/bash
# Cloud-init user-data: zero-touch SillyTavern host, no Docker, distro-agnostic
# (Ubuntu/Debian/Fedora/Rocky/Arch/openSUSE - anything with systemd). Reachable
# only over your tailnet, never on the public IP.
#
# Provider-agnostic - this is a plain cloud-init user-data script, not DO-specific.
# Paste it unchanged into whichever field your provider calls it:
#   DigitalOcean Droplet   -> "User Data"            (docker/create-droplet.sh|ps1 automates this)
#   AWS EC2 / Lightsail    -> "User data"
#   Vultr                  -> "Startup Script"
#   Hetzner Cloud          -> "Cloud config" / user data
#   Linode                 -> "User Data"
#   OVHcloud Public Cloud  -> "Configuration script" / cloud-init user data
# Any size/distro with systemd works; 1 vCPU / 1GB is enough.
#
# Before launching: replace TAILSCALE_AUTHKEY_HERE below with a one-off auth
# key from https://login.tailscale.com/admin/settings/keys (unavoidable -
# Tailscale has to be told which tailnet to join, and that can't be generated
# on the box itself). Nothing else needs to be run by hand.
set -euo pipefail

TAILSCALE_AUTHKEY="TAILSCALE_AUTHKEY_HERE"
NODE_VERSION="22.20.0"

install_pkg() {
  if command -v apt-get >/dev/null 2>&1; then apt-get update -y && apt-get install -y "$@"
  elif command -v dnf >/dev/null 2>&1; then dnf install -y "$@"
  elif command -v yum >/dev/null 2>&1; then yum install -y "$@"
  elif command -v pacman >/dev/null 2>&1; then pacman -Sy --noconfirm "$@"
  elif command -v zypper >/dev/null 2>&1; then zypper install -y "$@"
  elif command -v apk >/dev/null 2>&1; then apk add --no-cache "$@"
  else echo "no supported package manager found" >&2; exit 1
  fi
}

command -v git >/dev/null 2>&1 || install_pkg git
command -v curl >/dev/null 2>&1 || install_pkg curl
command -v tar >/dev/null 2>&1 || install_pkg tar

# 2GB swap so npm install / runtime don't OOM on small droplets. Only add
# ours if the machine has no swap at all yet - never touch/replace swap that
# was already there (could be larger, a partition, zram, etc).
if [ -z "$(swapon --show=NAME --noheadings 2>/dev/null)" ]; then
  fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# Node.js from the official prebuilt tarball - sidesteps distro package
# managers shipping stale/incompatible versions (ST needs Node >= 22.15.1)
case "$(uname -m)" in
  x86_64) NODE_ARCH=x64 ;;
  aarch64) NODE_ARCH=arm64 ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac
if [ "$(/opt/node/bin/node --version 2>/dev/null)" != "v${NODE_VERSION}" ]; then
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" -o /tmp/node.tar.xz
  rm -rf /opt/node
  mkdir -p /opt/node
  tar -xJf /tmp/node.tar.xz -C /opt/node --strip-components=1
fi
ln -sf /opt/node/bin/node /usr/local/bin/node
ln -sf /opt/node/bin/npm /usr/local/bin/npm
ln -sf /opt/node/bin/npx /usr/local/bin/npx

# Tailscale's own installer and `up` are already idempotent
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up --authkey="${TAILSCALE_AUTHKEY}" --hostname=sillytavern --ssh
TS_IP="$(tailscale ip -4)"

if [ -d /opt/SillyTavern/.git ]; then
  git -C /opt/SillyTavern pull --ff-only
else
  git clone --depth=1 https://github.com/SillyTavern/SillyTavern.git /opt/SillyTavern
fi
cd /opt/SillyTavern
npm install --no-audit --no-fund --omit=dev

# Default extensions - cloned straight into third-party/, same as SillyTavern's own
# "Install extension" button does. Idempotent: pull if already present, clone otherwise.
mkdir -p public/scripts/extensions/third-party
install_default_extension() {
  local name="$1" url="$2" dir="public/scripts/extensions/third-party/$1"
  if [ -d "$dir/.git" ]; then
    git -C "$dir" pull --ff-only
  else
    git clone --depth=1 "$url" "$dir"
  fi
}
install_default_extension SillyTavern-WorldInfoInfo https://github.com/LenAnderson/SillyTavern-WorldInfoInfo
install_default_extension GuidedGenerations-Extension https://github.com/Samueras/GuidedGenerations-Extension
install_default_extension SillyTavern-MoonlitEchoesTheme https://github.com/RivelleDays/SillyTavern-MoonlitEchoesTheme
install_default_extension SillyTavern-Tavernary https://github.com/pterror/SillyTavern-Tavernary
install_default_extension SillyTavern-ChubSearch https://github.com/pterror/SillyTavern-ChubSearch
install_default_extension SillyTavern-CharacterLibrary https://github.com/pterror/SillyTavern-CharacterLibrary

cat > config.yaml <<EOF
port: 8000
listen: true
listenAddress:
  ipv4: ${TS_IP}
  ipv6: "::"
whitelistMode: false
securityOverride: true
enableUserAccounts: true
EOF

cat > /etc/systemd/system/sillytavern.service <<'EOF'
[Unit]
Description=SillyTavern
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/SillyTavern
ExecStart=/usr/local/bin/node server.js
Restart=on-failure
RestartSec=5
MemoryMax=700M

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable sillytavern
systemctl restart sillytavern
