#!/usr/bin/env bash

# Make sure pwd is the directory of the script
cd "$(dirname "$0")"

echo "Assuming Node.js is already installed. If you haven't installed it already, do so now"
if [ -d node_modules ] && [ ! -f node_modules/.modules.yaml ]
then
    rm -rf node_modules
fi
echo "Installing Electron Wrapper's Node Modules..."
../../scripts/pnpm.sh install --frozen-lockfile --loglevel=error --prod

echo "Starting Electron Wrapper..."
../../scripts/pnpm.sh run start "$@"
