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

echo "Entering SillyTavern..."
node "server.js" "$@"
