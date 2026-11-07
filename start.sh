#!/usr/bin/env bash

# Make sure pwd is the directory of the script
cd "$(dirname "$0")"

if ! command -v npm &> /dev/null
then
    echo -e "\033[0;31mnpm could not be found in PATH. If the startup fails, please install Node.js from https://nodejs.org/\033[0m"
fi

echo "Installing Node Modules..."
export NODE_ENV=production
# typescript/eslint in node_modules means a developer installed the dev dependencies on purpose - don't prune them.
# --include=dev overrides the dev omission NODE_ENV=production implies, so the server still runs as production.
if [ -d "node_modules/typescript" ] || [ -d "node_modules/eslint" ]
then
    NPM_DEV_FLAG="--include=dev"
else
    NPM_DEV_FLAG="--omit=dev"
fi
npm install --no-save --no-audit --no-fund --loglevel=error --no-progress "$NPM_DEV_FLAG" --ignore-scripts

# inotify-remastered-plus is built from patched source (patches/inotify-remastered-plus+*.patch): an unpatched
# build kills the process on an inotify queue overflow. --ignore-scripts above skipped both patch-package and the
# node-gyp build, so both run here, patch first. The probe exits 0 on non-Linux, where the package isn't installed.
if ! node src/probe-inotify-remastered-plus.js > /dev/null 2>&1
then
    echo "inotify-remastered-plus native binding is missing, unpatched, or broken, attempting a rebuild..."
    # patch-package without a package name applies patches/; with one it generates a patch instead.
    if ./node_modules/.bin/patch-package > /dev/null 2>&1 && npm rebuild inotify-remastered-plus --ignore-scripts=false
    then
        echo "inotify-remastered-plus rebuild finished."
    else
        echo -e "\033[0;33minotify-remastered-plus rebuild failed - the local-import directory scanner will fall back to its periodic backstop pass alone (no real-time inotify-queue-overflow detection). This usually means no C/C++ compiler toolchain and/or Python 3 is installed.\033[0m"
    fi
fi

# The new page's build for this checkout (packages/serve-ui): the one there, else its release's; between releases
# it's built here, which needs the dev dependencies (installed only then).
if ! node scripts/build-ui.mjs --ensure
then
    echo "Installing the tools to build the new page..."
    npm install --no-save --no-audit --no-fund --loglevel=error --no-progress --include=dev --ignore-scripts
    node scripts/build-ui.mjs --ensure || echo -e "\033[0;31mThe new page could not be built; SillyTavern will not start without it.\033[0m"
fi

echo "Entering SillyTavern..."
node "server.js" "$@"
