#!/usr/bin/env bash

# Make sure pwd is the directory of the script
cd "$(dirname "$0")"

if ! command -v npm &> /dev/null
then
    echo -e "\033[0;31mnpm could not be found in PATH. If the startup fails, please install Node.js from https://nodejs.org/\033[0m"
fi

echo "Installing Node Modules..."
export NODE_ENV=production
npm install --no-save --no-audit --no-fund --loglevel=error --no-progress --omit=dev --ignore-scripts

# --ignore-scripts above means better-sqlite3's native .node addon never gets auto-built/rebuilt on install,
# so a missing/broken binding would otherwise stay silently broken forever (search falls back to slower
# Fuse.js every launch, with no fix-it path). Probe it the same way the server does at runtime, and only pay
# the rebuild cost on the launches where it's actually needed - a working binding costs nothing extra here.
if ! node src/probe-better-sqlite3.js > /dev/null 2>&1
then
    echo "better-sqlite3 native binding is missing or broken, attempting a rebuild..."
    # This repo's .npmrc sets ignore-scripts=true (so arbitrary deps can't run install scripts), but
    # better-sqlite3's actual build step - "prebuild-install || node-gyp rebuild --release" - IS its
    # package.json install script, so it needs that override here or this rebuild is a silent no-op.
    if npm rebuild better-sqlite3 --ignore-scripts=false
    then
        echo "better-sqlite3 rebuild finished."
    else
        echo -e "\033[0;33mbetter-sqlite3 rebuild failed - character/group search will fall back to the slower Fuse.js search. This usually means no C/C++ compiler toolchain and/or Python 3 is installed.\033[0m"
    fi
fi

# Same shape as the better-sqlite3 block above, plus one extra step: this repo also carries a real source patch
# for inotify-remastered-plus (patches/inotify-remastered-plus+*.patch - see probe-inotify-remastered-plus.js
# and that patch file's own comments on why an UNPATCHED build is actually worse than no binding at all - it
# crashes the whole process on a real inotify queue overflow instead of just missing the fast-path detection).
# --ignore-scripts above means neither patch-package nor this package's own node-gyp build ever ran on install,
# so both need running here, in order (patch the source, then build it). A no-op on non-Linux (the probe exits
# 0 immediately there - see its own header) since this package is `os: linux`-gated and never gets installed
# elsewhere.
if ! node src/probe-inotify-remastered-plus.js > /dev/null 2>&1
then
    echo "inotify-remastered-plus native binding is missing, unpatched, or broken, attempting a rebuild..."
    # patch-package with NO package-name argument is its apply mode (applying every patch found in patches/) -
    # passing a package name instead switches it into GENERATE mode (diffing node_modules against a fresh
    # install to CREATE a patch from local changes), which is a different command entirely and would silently
    # do nothing useful here (confirmed the hard way: it reported "no changes" and made this whole chain fail).
    if npx patch-package > /dev/null 2>&1 && npm rebuild inotify-remastered-plus --ignore-scripts=false
    then
        echo "inotify-remastered-plus rebuild finished."
    else
        echo -e "\033[0;33minotify-remastered-plus rebuild failed - the local-import directory scanner will fall back to its periodic backstop pass alone (no real-time inotify-queue-overflow detection). This usually means no C/C++ compiler toolchain and/or Python 3 is installed.\033[0m"
    fi
fi

echo "Entering SillyTavern..."
node "server.js" "$@"
