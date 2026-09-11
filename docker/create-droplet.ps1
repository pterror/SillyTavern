# One-command DigitalOcean Droplet launcher for cloud-init.sh - collapses "open the DO web
# UI, pick region/size/image, paste user-data by hand" into a single command via doctl.
#
# Prereqs (one-time, off this box):
#   - doctl installed: winget install DigitalOcean.Doctl  (or scoop install doctl, or download from
#     https://github.com/digitalocean/doctl/releases)
#   - doctl authenticated: doctl auth init  (asks for a DO API token from
#     https://cloud.digitalocean.com/account/api/tokens)
#   - an SSH key already uploaded to your DO account (doctl compute ssh-key list)
#   - a Tailscale auth key from https://login.tailscale.com/admin/settings/keys
#
# Usage (PowerShell):
#   $env:TAILSCALE_AUTHKEY = "tskey-..."
#   .\docker\create-droplet.ps1
#   .\docker\create-droplet.ps1 -Region nyc3 -Size s-1vcpu-1gb -Image ubuntu-24-04-x64

param(
    [string]$Region = "nyc3",
    [string]$Size = "s-1vcpu-1gb",
    [string]$Image = "ubuntu-24-04-x64",
    [string]$DropletName = "sillytavern"
)

$ErrorActionPreference = "Stop"

$TailscaleAuthKey = $env:TAILSCALE_AUTHKEY
if (-not $TailscaleAuthKey) {
    Write-Error "Set `$env:TAILSCALE_AUTHKEY to a key from https://login.tailscale.com/admin/settings/keys"
    exit 1
}

if (-not (Get-Command doctl -ErrorAction SilentlyContinue)) {
    Write-Error "doctl not found - install it first: winget install DigitalOcean.Doctl"
    exit 1
}

doctl auth list *>$null
if ($LASTEXITCODE -ne 0) {
    Write-Error "doctl isn't authenticated yet - run: doctl auth init"
    exit 1
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$CloudInitPath = Join-Path $ScriptDir "cloud-init.sh"
$UserDataFile = Join-Path ([System.IO.Path]::GetTempPath()) ([System.IO.Path]::GetRandomFileName())

try {
    (Get-Content -Raw $CloudInitPath) -replace "TAILSCALE_AUTHKEY_HERE", $TailscaleAuthKey |
        Set-Content -NoNewline -Encoding utf8 $UserDataFile

    $sshKeyIds = (doctl compute ssh-key list --format ID --no-header) -join ","
    if (-not $sshKeyIds) {
        Write-Error "No SSH keys on your DO account - upload one first: doctl compute ssh-key create <name> --public-key-file <path>"
        exit 1
    }

    Write-Host "Creating Droplet '$DropletName' ($Size, $Region, $Image)..."
    doctl compute droplet create $DropletName `
        --region $Region `
        --size $Size `
        --image $Image `
        --ssh-keys $sshKeyIds `
        --user-data-file $UserDataFile `
        --wait `
        --format ID,Name,PublicIPv4,Status

    Write-Host ""
    Write-Host "Droplet is up. First boot takes a couple more minutes to finish provisioning SillyTavern."
    Write-Host "Once it's done, find its Tailscale IP in https://login.tailscale.com/admin/machines (hostname: sillytavern)"
    Write-Host "and open http://<tailscale-ip>:8000 - it is NOT reachable on the public IP above."
}
finally {
    Remove-Item -ErrorAction SilentlyContinue $UserDataFile
}
