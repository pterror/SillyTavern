#!/usr/bin/env bash
if command -v pnpm > /dev/null 2>&1
then
    exec pnpm "$@"
fi
if command -v corepack > /dev/null 2>&1
then
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 exec corepack pnpm "$@"
fi
echo -e "\033[0;31mpnpm could not be found in PATH, and this Node.js has no corepack to run it with. Install pnpm from https://pnpm.io/installation\033[0m" >&2
exit 127
