#!/usr/bin/env bash

# Make sure pwd is the directory of the script
cd "$(dirname "$0")"

if ! command -v node &> /dev/null
then
    echo -e "\033[0;31mnode could not be found in PATH. If the startup fails, please install Node.js from https://nodejs.org/\033[0m"
fi

# A node_modules without .modules.yaml was made by npm; pnpm would install around the packages npm left there.
for modules in node_modules engine/node_modules tests/node_modules
do
    if [ -d "$modules" ] && [ ! -f "$modules/.modules.yaml" ]
    then
        rm -rf "$modules"
    fi
done

echo "Installing Node Modules..."
export NODE_ENV=production
# typescript/eslint in node_modules means a developer installed the dev dependencies on purpose - don't prune them.
# --prod=false overrides the dev omission NODE_ENV=production implies, so the server still runs as production.
if [ -d "node_modules/typescript" ] || [ -d "node_modules/eslint" ]
then
    PNPM_PROD_FLAG="--prod=false"
else
    PNPM_PROD_FLAG="--prod"
fi
scripts/pnpm.sh install --frozen-lockfile --loglevel=error "$PNPM_PROD_FLAG"

if ! node src/probe-inotify-remastered-plus.js > /dev/null 2>&1
then
    echo -e "\033[0;33minotify-remastered-plus isn't built - the local-import directory scanner will fall back to its periodic backstop pass alone (no real-time inotify-queue-overflow detection). Building it needs a C/C++ compiler toolchain and Python 3; with them installed, delete node_modules and start again.\033[0m"
fi

# The new page's build for this checkout (packages/serve-ui): the one there, else its release's; between releases
# it's built here, which needs the dev dependencies (installed only then).
if ! node scripts/build-ui.mjs --ensure
then
    echo "Installing the tools to build the new page..."
    scripts/pnpm.sh install --frozen-lockfile --loglevel=error --prod=false
    node scripts/build-ui.mjs --ensure || echo -e "\033[0;31mThe new page could not be built; SillyTavern will not start without it.\033[0m"
fi

echo "Entering SillyTavern..."
node "server.js" "$@"
