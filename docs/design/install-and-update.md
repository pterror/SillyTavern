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

## Data migrations, run by the server

Replaces the one-offs and the "stop the server and run" guards.

- Each migration is code in the version, with an id, recorded in the store when done.
- At start, before serving, the server runs the pending ones in order: first a snapshot of the store (the engine's
  own checkpoint, cheap: its files are immutable runs), then each migration, resumable after a crash (it records
  how far it got), with a progress page shown meanwhile.
- A migration that fails stops the start, says which and why, and leaves the snapshot to go back to (the launcher's
  rollback restores it with the version).
- Downgrading across a migration restores that migration's snapshot (changes made since are listed and kept aside
  first, not silently lost).
- The current one-offs (`convert-settings-to-model`, `name-every-chat`) become the first two, already recorded as
  done on stores that ran them.

## Also

- `start.sh` / `Start.bat` and the update scripts go once the launcher exists (a checkout uses `st use`).
- The start script's probes for better-sqlite3 and inotify, and its "falls back to Fuse.js search" message,
  predate the engine: what's still needed is decided while building the archives (each native module either ships
  prebuilt or goes).
- Remote access (`Remote-Link.cmd`) and the config file become launcher settings shown in the page.
