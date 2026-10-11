#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

node -e 'const [major, minor, patch] = process.versions.node.split(".").map(Number); if (major !== 24 || minor < 13 || (minor === 13 && patch < 1)) { console.error("Base3Router requires Node 24.13.1 or newer"); process.exit(1) }'

export COREPACK_HOME="${COREPACK_HOME:-/tmp/base3-corepack}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-/tmp/base3-cache}"

# Corepack reads the exact pnpm version from package.json. Keep the lockfile intact.
corepack pnpm install --frozen-lockfile --store-dir /tmp/base3-pnpm-store
test -x node_modules/.bin/vp
node_modules/.bin/vp --version
