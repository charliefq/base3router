# Development

## First checkout

Install `vp` using the [root README](../../README.md#install-vp). The checkout requires Node 24;
Bun is optional. From the repository root:

```sh
vp i
vp run dev
```

Open the pairing URL printed by the dev runner. The bare origin does not authenticate
a new browser.

Prefer a container? See [Dev container](../internals/devcontainer.md) for VS Code and Codespaces setup.

## Choosing a dev process

Use `vp run dev` for server and web, or `vp run dev:desktop` for the Electron client.
`dev:server` and `dev:web` start those processes separately.
See the [mobile README](../../apps/mobile/README.md) for native builds and Metro.

Flags go directly after the task name, for example `vp run dev --home-dir /tmp/t3code-dev`.
Add `--browser` to open a browser automatically.

### State and ports

Linked worktrees default to their own `.t3/userdata`, even when `T3CODE_HOME` is set.
The main checkout defaults to `~/.t3/dev/userdata`. An explicit `--home-dir` wins in both cases.
Never run a development server against the live `~/.t3/userdata`.
See [test data](../../AGENTS.md#test-data) for copying a consistent database snapshot.

Read ports from the `[dev-runner]` output. Worktrees derive stable preferences from their paths,
but occupied ports can shift them. `T3CODE_PORT_OFFSET` or `T3CODE_DEV_INSTANCE` can select a
different preference when needed.

### Sharing and remote debugging

`vp run dev --share` publishes the web port over the machine's tailnet and prints a pairing URL
for that origin. Give the tester the complete URL, including its token. The dev runner removes
its mapping on exit.

Leave `VITE_HTTP_URL` and `VITE_WS_URL` unset. Vite proxies the backend through the browser's
origin so the same build works over localhost and remote connections.

Shared runs enable bundled dev to avoid a network round trip for each import level.
`T3CODE_BUNDLED_DEV=0` opts out when debugging bundler differences. Two reload traps matter
when changing this setup:

- The web entry must dynamically import the app so React refresh initializes before application
  chunks. Static imports can work on first load and fail after a route split.
- Bundled dev rebuilds Tailwind through watched files. Its ordinary Vite hot-update hook expects
  a server/module graph that Rolldown does not provide.

The workarounds live in the [web entry](../../apps/web/src/bootstrap.ts) and
[Tailwind plugin](../../apps/web/vite/tailwind.ts).

#### Reusable dev credential

Use this only on a hostname where you trust every service. Browsers send cookies to all ports
on that hostname. Any service you visit there can receive the reusable admin credential,
including services unrelated to T3 Code. If you run untrusted services on that hostname, keep
normal per-environment pairing instead.

To use one browser profile across web dev worktrees on the same hostname, generate one fixed
value once:

```sh
openssl rand -hex 32
```

Put that value in the main checkout's gitignored `.env`:

```dotenv
T3CODE_DEV_AUTH_TOKEN=<the value generated above>
```

The `t3.json` Setup Worktree action links that file to each worktree's `.env`. The dev runner reads repository env files at startup. `.env.local` and inherited process
environment values override `.env`, so no per-worktree export is needed after setup.

For a manual worktree or launcher without that link, export the same fixed value instead:

```sh
export T3CODE_DEV_AUTH_TOKEN="<the value generated above>"
```

Do not generate a new value at startup. Start or restart `vp run dev --share` after configuration,
then open its printed startup pairing URL once per browser profile on that hostname. Later web dev
servers on the same hostname accept the shared cookie across ports. The cookie expires after 30
days. Reload an old tab if its URL now serves a replacement environment.

The token and startup pairing URLs are reusable administrative secrets. Never put them in a
commit, pull request, or public output. Every server still seeds its own auth database record at
startup and keeps its own SQLite data, signing key, and revocation state. Desktop and non-dev
servers ignore the value. See [environment authentication](../internals/environment-auth.md#reusable-dev-credential)
for the security model.

## Verify the disposable production journey

Build the web client and package the server before starting the local fixture:

```sh
vp run --filter @t3tools/web build
node apps/server/scripts/cli.ts build
node scripts/local-product-runtime.ts start --output /tmp/b3r-local-product-evidence
```

Run the launcher in its own terminal. It prints the isolated root and localhost
origin; pairing material stays in that root's private log. In another terminal:

```sh
node scripts/local-product-check.ts --journey --output /tmp/b3r-local-product-evidence
node scripts/local-product-check.ts --lifecycle --output /tmp/b3r-local-product-evidence
```

This uses the built production server, normal authentication and shared client
HTTP/WebSocket contracts. The only enabled provider is a deterministic local
fixture. The launcher gives it fresh home, project and data directories and
blocks non-loopback Node traffic. It does not activate a real provider. Journey
and lifecycle modes refuse to rerun on a root with retained original commands;
use `--read-originals` to inspect original statuses instead of replacing an
uncertain Start. This inspection does not certify restart recovery.

Use the printed root for process control; the launcher retains its child handle:

```sh
node scripts/local-product-runtime.ts restart --runtime <printed-root> --output /tmp/b3r-local-product-evidence
node scripts/local-product-check.ts --recover --output /tmp/b3r-local-product-evidence
node scripts/local-product-check.ts --inflight --output /tmp/b3r-local-product-evidence
node scripts/local-product-runtime.ts restart --crash --runtime <printed-root> --output /tmp/b3r-local-product-evidence
node scripts/local-product-check.ts --recover --output /tmp/b3r-local-product-evidence
node scripts/local-product-runtime.ts cleanup --runtime <printed-root>
```

Restart in its own terminal too. Before signalling the server, restart saves a
checkpoint of the original command hashes, receipts, native-start count and task
readouts. Recovery requires that pre-restart checkpoint and fails on replay,
receipt loss, changed run/output/route, or admission of the unsubmitted original.
The crash-held original must retain its run identity, cancel without a completed
result, and add no native starts. Observation and review timestamps may refresh.
Cleanup waits for confirmed child exit before removing only that disposable
root. Keep private logs, auth material and raw
provider journals out of shared evidence. These checks prove the local protocol
journey and recovery; they do not prove browser interaction, desktop/mobile
installation, remote TLS, or real-provider readiness. For a locally extracted
server package, `start --entrypoint <package>/dist/bin.mjs` can use a path below
`/tmp/b3r-local-product-package-*`; its declared runtime dependencies must already
be installed. A package run using cached dependencies is not an installer test.

## Build a registry-dependent Node package

After the web and server build above, create a new artifact directory:

```sh
node scripts/build-node-package.ts --output-dir /tmp/t3-node-artifact
```

The tarball contains the built server/client, registry-resolvable runtime
externals, and the existing native-build, patch and override policy. It omits
repository scripts and workspace dependencies. This delivery builds Linux
x64/glibc only; the builder rejects Windows, macOS and ARM hosts before staging
or invoking npm. It records the target in the artifact README. Registry access
and pnpm 11 are required; the artifact includes neither Node nor installed
dependencies.

Use the [local Node package instructions](../user/install.md#local-node-package)
to extract and install into a fresh directory. Keep `NODE_PATH` unset. To verify
without real providers, extract below a fresh
`/tmp/b3r-portable-node-install-*/package` directory, give the install a fresh
HOME/cache/config, and use its installed `dist/bin.mjs` with the existing local
fixture launcher `--entrypoint`. The launcher checks every installed dependency
and symlink resolves within the installed tree before boot. Continue the
journey/lifecycle/checkpointed restart steps above. The installation command may
use the existing `vp install --prod` tooling; the runtime must not link checkout
`node_modules`. Preserve the shipped native-build/patch policy. Registry or native
build/download failures are prerequisites to report, not permission to approve
extra scripts or substitute cached repository links.

## Checks

Run checks for the files and packages you changed:

```sh
vp test run <files>
vp lint <files>
vp run --filter <package> typecheck
```

Use `vp run lint:mobile` for native mobile changes. CI owns the full suite; see
[ci.yml](../../.github/workflows/ci.yml) for its current jobs.
The [manual Windows lane](../../.github/workflows/windows-tests.yml) is available for focused
Windows investigation while that suite is not a required gate.

### Unused code

`vp run knip:check` checks unused files and dependencies across the repo, then
unused runtime exports in `apps/server`, `apps/desktop`, `apps/web`, and every internal package under
`packages/`. CI enforces both checks.
Exported types and Effect schemas are allowed without consumers. The schema preprocessor
recognizes schema types, including aliases and schema classes; functions that create or decode
schemas remain checked. Canonical Effect service construction APIs stay exported with an explicit
`@public` annotation, which Knip recognizes. Completely unused files remain checked too.
Named exports in web UI component modules are kept as complete component sets. Knip ignores
unused exports in `apps/web/src/components/ui/*.tsx`, while still reporting an entire unused file.
Use `vp run knip --workspace apps/web` to audit one workspace, including exports,
or `vp run knip:production --workspace apps/web` to find code kept alive only by tests.
The full export audit still has findings and is not a repo-wide CI gate. Extend the
export check's workspace selectors as more workspaces become clean. Review callers before
deleting code; production mode can also report development scripts and test fixtures.
Runtime-discovered entrypoints and dependency exceptions belong in [knip.jsonc](../../knip.jsonc).

## Desktop artifacts

Local artifact builds are unsigned by default and write to `release/`:

```sh
vp run dist:desktop:dmg
vp run dist:desktop:linux
vp run dist:desktop:win
```

DMGs default to the host architecture. Use `--arch` to choose another target and `--keep-stage`
to retain packaging files for inspection. Run `vp run dist:desktop:artifact --help` for other
options.

### Linux AppImage prerequisites

Build on Linux because the browser-secret helper links against the host's libsecret. Install
Rust, C/C++ build tools, libsecret development headers, pkg-config, and ImageMagick.

Ubuntu and Debian:

```sh
sudo apt-get update
sudo apt-get install cargo rustc build-essential libsecret-1-dev pkg-config imagemagick
```

Fedora:

```sh
sudo dnf install rust cargo gcc gcc-c++ make libsecret-devel pkgconf-pkg-config ImageMagick
```

Arch Linux:

```sh
sudo pacman -S rust base-devel libsecret pkgconf imagemagick
```

The C toolchain, pkg-config, and libsecret headers are also needed for Linux desktop development.

### macOS DMG prerequisites

Install the Xcode Command Line Tools with `xcode-select --install` and install Rust.
For a cross-architecture or universal build, add the requested Rust targets:

```sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin
```

### Windows installer prerequisites

Install Rust, Python 3, and Visual Studio Build Tools with **Desktop development with C++**.
Include the Windows SDK and the MSVC build tools and Spectre-mitigated libraries for the target
architecture. Add its Rust target:

```powershell
rustup target add x86_64-pc-windows-msvc
# For an ARM64 installer:
rustup target add aarch64-pc-windows-msvc
```

NSIS is downloaded by electron-builder. WSL support additionally needs the Linux CLI archive
passed as `--wsl-runtime`; see the
[release runbook](./release.md#windows-payload-topology-and-update-validation).

### Signing and passkeys

Add `--signed` after configuring the platform credentials in the
[release runbook](./release.md). macOS passkeys need a signed, provisioned app; follow the
[Connect setup](./connect-setup.md#desktop-passkeys) for local signing and renderer HMR.
