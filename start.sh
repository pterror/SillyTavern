#!/usr/bin/env bash

cd "$(dirname "$0")" || exit 1
if ! command -v node > /dev/null 2>&1; then
    echo "Node.js could not be found in PATH. Install it from https://nodejs.org/" >&2
    exit 127
fi
exec node scripts/start.mjs "$@"
