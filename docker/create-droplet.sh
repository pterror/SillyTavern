#!/bin/bash
# One-command DigitalOcean Droplet launcher for cloud-init.sh - collapses "open the DO web
# UI, pick region/size/image, paste user-data by hand" into a single CLI call via doctl.
#
# Prereqs (one-time, off this box):
#   - doctl authenticated: `doctl auth init` (asks for a DO API token from
#     https://cloud.digitalocean.com/account/api/tokens)
#   - an SSH key already uploaded to your DO account (doctl compute ssh-key list)
#   - a Tailscale auth key from https://login.tailscale.com/admin/settings/keys
#
# Usage:
#   TAILSCALE_AUTHKEY=tskey-... ./docker/create-droplet.sh
#   TAILSCALE_AUTHKEY=tskey-... DO_REGION=nyc3 DO_SIZE=s-1vcpu-1gb DO_IMAGE=ubuntu-24-04-x64 ./docker/create-droplet.sh
set -euo pipefail

: "${TAILSCALE_AUTHKEY:?Set TAILSCALE_AUTHKEY to a key from https://login.tailscale.com/admin/settings/keys}"

DO_REGION="${DO_REGION:-nyc3}"
DO_SIZE="${DO_SIZE:-s-1vcpu-1gb}"
DO_IMAGE="${DO_IMAGE:-ubuntu-24-04-x64}"
DROPLET_NAME="${DROPLET_NAME:-sillytavern}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
USER_DATA_FILE="$(mktemp)"
trap 'rm -f "$USER_DATA_FILE"' EXIT
sed "s/TAILSCALE_AUTHKEY_HERE/${TAILSCALE_AUTHKEY}/" "$SCRIPT_DIR/cloud-init.sh" > "$USER_DATA_FILE"

command -v doctl >/dev/null 2>&1 || { echo "doctl not found - run via: nix run nixpkgs#doctl -- $0" >&2; exit 1; }
doctl auth list >/dev/null 2>&1 || { echo "doctl isn't authenticated yet - run: doctl auth init" >&2; exit 1; }

SSH_KEY_IDS="$(doctl compute ssh-key list --format ID --no-header | paste -sd,)"
[ -n "$SSH_KEY_IDS" ] || { echo "No SSH keys on your DO account - upload one first: doctl compute ssh-key create <name> --public-key-file <path>" >&2; exit 1; }

echo "Creating Droplet '$DROPLET_NAME' ($DO_SIZE, $DO_REGION, $DO_IMAGE)..."
doctl compute droplet create "$DROPLET_NAME" \
  --region "$DO_REGION" \
  --size "$DO_SIZE" \
  --image "$DO_IMAGE" \
  --ssh-keys "$SSH_KEY_IDS" \
  --user-data-file "$USER_DATA_FILE" \
  --wait \
  --format ID,Name,PublicIPv4,Status

echo
echo "Droplet is up. First boot takes a couple more minutes to finish provisioning SillyTavern."
echo "Once it's done, find its Tailscale IP in https://login.tailscale.com/admin/machines (hostname: sillytavern)"
echo "and open http://<tailscale-ip>:8000 - it is NOT reachable on the public IP above."
