# Installing and updating

Today: Node and git required; `git clone`, then `start.sh` runs `npm install`, rebuilds native modules (a C/C++
toolchain and Python), builds or fetches the page (`scripts/build-ui.mjs --ensure`), and fetches the engine by
source hash from a GitHub release (`engine/fetch.js`), building it with cargo between releases (Rust). Data
migrations are one-offs run by hand with the server stopped (`src/migrations/`), the server refusing until they
are. Updating is `git pull` and the same script.

## The goal

Nothing to install first, nothing to build, nothing to run by hand: download, run, and from then on the app keeps
itself current, with a way back.

## The launcher

A small native program (Rust: one static binary per platform, no runtime) is what the user installs and runs. It
owns versions; the app is data to it.

- **Versions side by side**: each version is a directory holding everything it needs: Node, the server, the page
  built, the engine and every native module prebuilt for the platform. Installing a version is unpacking it next to
  the others; switching is changing which one the launcher starts (atomic: a pointer file renamed into place). The
  previous version stays until the next one has run, so going back is switching back.
- **Data outside the app**: the user's data lives in the platform's data directory (XDG on Linux,
  `%APPDATA%` on Windows, `~/Library/Application Support` on macOS, Termux's home on Android), never in a version's
  directory, so no update touches it. An existing checkout's `data/` is adopted where it is (the launcher records
  its path), never copied without asking.
- **Running**: starts the server of the current version, opens the browser at it, shows a tray icon (open, update,
  versions, logs, quit) on desktops; runs headless where there's no desktop (servers, Docker, Termux) with the same
  commands on its CLI (`st update`, `st versions`, `st use <version>`, `st logs`).
- **Developers**: a git checkout is a version too (`st use ./path`), built by the checkout's own scripts, so working
  on the app needs no second setup.

## Fitting into the system

The launcher's install step, per platform:

| Platform | Added |
|---|---|
| Windows | Start menu entry; optional desktop shortcut; an Installed apps entry (uninstall, version); optional start at login |
| macOS | the app in Applications (Dock, Launchpad); optional Login Item |
| Linux | a `.desktop` file in `~/.local/share/applications`, icons in the hicolor theme; optional autostart; AppImage and tarball installs get it from `st integrate`, Flatpak does its own |
| Termux | a Termux:Widget shortcut |

- File associations: "Open with" for `.charx`, `.byaf`, lorebook and preset files, handed to the input handlers
  (`modules.md`); not PNG or JSON (too generic to claim).
- A link scheme, `sillytavern://import?url=…`, so a site's "open in SillyTavern" lands in the import handlers.
- Uninstalling removes the app and its integration; the data stays unless the user asks for it to go.

## Packages

Per platform, the launcher in the platform's usual form; each fetches the current version on first run (or carries
it, for offline installs):

| Platform | Form |
|---|---|
| Windows (x64, arm64) | a signed installer (per-user, no admin), and on winget and Scoop |
| macOS (arm64, x64) | a signed, notarized app in a DMG, and on Homebrew |
| Linux (x64, arm64, armv7) | an AppImage, a tarball, and Flatpak |
| Android | a Termux package now; an app later (OT2) |
| Docker | the existing image, built from the same version archives |

A version archive per platform is built by CI from a release commit: Node, the server, the page, the engine and the
native modules, prebuilt and tested on that platform.

## Updating

- **Where from**: releases of this fork on GitHub (the engine and page builds are released there already), with a
  manifest per channel listing versions, their archives per platform, sizes and hashes.
- **Trust**: every manifest and archive is signed (minisign); the launcher carries the public key and refuses
  anything unsigned or altered. HTTPS alone isn't trusted.
- **Channels**: release; staging (every staging commit CI passes).
- **The flow**: the launcher checks the channel (at start and daily, never while generating); the page shows a
  notice with what changed (the release notes); on the user's word it downloads the archive (resumable), checks its
  signature, unpacks it beside the current version, stops the server, switches, starts the new version, and checks
  it came up (a health check); if it didn't, it switches back by itself and says why.
- **Rolling back**: from the tray or `st use`, any version still installed, with the data snapshot taken before
  that version's migrations (below).

## Changes to our own data formats

While there are no users, our own formats change by hard cutover: a throwaway one-off run once on the existing data
with the server stopped, then deleted; the server only ever knows the current format and holds no migration. Only
importing from upstream is a supported path (permanent, in the import). A server-run migration registry was built and
removed again (10-29) for this reason; what replaces it for users is decided when there are users, not before.

## Also

- `start.sh` / `Start.bat` stay: git installs, their guides, Termux and headless setups, and third-party installers
  (SillyTavern Launcher, Pinokio, StabilityMatrix) call them. They become thin: in a launcher install they hand
  off to the launcher; in a plain checkout they run it as a version, as now (dependencies, the page and engine fetched
  or built, then start), the server running pending migrations itself.
- The start script's probes for better-sqlite3 and inotify, and its "falls back to Fuse.js search" message,
  predate the engine: what's still needed is decided while building the archives (each native module either ships
  prebuilt or goes).
- Remote access (`Remote-Link.cmd`) and the config file become launcher settings shown in the page.

## Running elsewhere, and reaching it

### Headless

A one-line install (downloads the launcher, checks its signature) that installs it as a service: a systemd unit on
Linux, a launchd agent on macOS, a Windows service. Everything over SSH with `st` (status, logs, update, versions,
rollback); updates on a schedule the user sets, never during a generation, with the health check and rollback.

### From other devices

One "Access from other devices" setup in the page, a choice per situation that writes the few settings it needs
(listen addresses, allowed ranges, login, TLS):

| Situation | What it sets up |
|---|---|
| same network | listens on the LAN address; allows the LAN range; login required |
| Tailscale | `tailscale serve` (HTTPS on the tailnet name, no certificates to manage); allows tailnet addresses; Funnel (public through Tailscale) only as its own explicit choice |
| WireGuard or another VPN | listens on that interface's address; allows the VPN's subnet |
| public, with a domain | HTTPS by ACME (Let's Encrypt) itself, or behind the user's reverse proxy (Caddy, nginx) with trusted proxy headers |
| tunnel | Cloudflare Tunnel (what `Remote-Link.cmd` does), run by the launcher |

Always: localhost only until one is chosen; never beyond localhost without a login; never public without HTTPS; the
page shows how and from where it is reachable now.

### Installing it somewhere else, from the desktop

The app needs a long-running process and a persistent disk (the store; long streamed generations):
- **fits**: a VPS or VM (DigitalOcean Droplets, Hetzner, OVH, Linode, Vultr, AWS Lightsail / EC2, Oracle Cloud's free
  tier); containers with a persistent volume (Fly.io, Railway, Render); home hardware (a NAS, a Raspberry Pi);
- **not yet**: containers without a disk that survives a restart (DO App Platform, Cloud Run, App Runner): see
  object storage below;
- **no**: serverless (Vercel, Netlify, Workers): no long-running process, no disk, execution limits.

The launcher's "Run it somewhere else", with one adapter per provider (a module with its own API host,
`modules.md`):
1. a server the user has: its SSH address; the one-line install over SSH, the service set up;
2. a new server: a provider and an API token; the smallest fitting machine made, its first boot (cloud-init)
   installing the launcher and the service;
3. container platforms: the platform's own config written and deployed (`fly.toml` with a volume, …).
Then access (join the user's tailnet — the easiest, nothing public — or a domain with HTTPS) and data (start empty,
or copy the library across, its size and time shown first; keeping two in sync is OT2). The token is used for the
setup only and kept only if the user lets it manage updates and backups there.

### Object storage (later)

Runs are written once and never changed, which object storage suits: uploaded as made, a local disk only a cache.
The log stays local and is shipped in segments (as Litestream does); a fresh container restores runs and the log
after them. Writes since the last shipped segment are lost if the container dies (seconds); one instance at a time
(scaling to zero works). Uploaded files go to the bucket. This opens containers without a disk (DO App Platform,
App Runner, Cloud Run), and gives everyone off-site backups.
