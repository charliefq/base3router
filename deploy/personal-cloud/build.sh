#!/usr/bin/env bash
# Build a reviewed checkout on the target Linux architecture, without publishing.
set -euo pipefail
if [[ $# != 2 || ! "$2" =~ ^[0-9a-f]{40}$ ]]; then
  echo 'Usage: build.sh /absolute/release/checkout full-commit-sha' >&2
  exit 2
fi
cd "$1"
[[ $(uname -s) == Linux ]] || { echo 'Build on the target Linux VM/architecture' >&2; exit 1; }
[[ $(git rev-parse HEAD) == "$2" ]] || { echo 'Checkout SHA differs' >&2; exit 1; }
[[ -z $(git status --porcelain) ]] || { echo 'Checkout must be clean' >&2; exit 1; }
node -e 'const [a,b,c]=process.versions.node.split(".").map(Number); if(a!==24 || b<13 || (b===13 && c<1)) throw Error("Use Node 24 >=24.13.1")'
[[ $(pnpm --version) == 11.10.0 ]] || { echo 'Use pnpm 11.10.0' >&2; exit 1; }
# Leave workspace dependencies in place: native modules are external to bin.mjs.
# No .env or provider login belongs in this release checkout.
[[ ! -e .env && ! -e .env.local ]] || { echo 'Use a secret-free checkout' >&2; exit 1; }
export ELECTRON_SKIP_BINARY_DOWNLOAD=1
unset VITE_HTTP_URL VITE_WS_URL VITE_DEV_SERVER_URL T3CODE_HOME
pnpm install --frozen-lockfile
pnpm exec vp run --filter t3 build
[[ -s apps/server/dist/bin.mjs && -s apps/server/dist/client/index.html ]]
node apps/server/dist/bin.mjs --help >/dev/null
node -e 'const fs=require("node:fs"); fs.writeFileSync(".personal-cloud-build.json", JSON.stringify({commit:process.argv[1],node:process.version,platform:process.platform,arch:process.arch})+"\n")' "$2"
echo "Built $2; no service was started"
