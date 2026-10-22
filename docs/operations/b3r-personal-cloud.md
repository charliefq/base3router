# B3R personal cloud runtime

This package prepares one owner's long-running Linux VM environment. One Node server owns
SQLite and provider processes; the Mac and Alienware use remote connections to that same
environment. There is no database sync or second writer. Public multi-user hosting is deferred.
Nothing here provisions a machine, installs credentials, configures a network, or deploys publicly.

## Choose the host before setup

Use an owner-controlled Linux VM with systemd, a persistent local filesystem, Python >=3.12,
Git, a C/C++ toolchain for native Node dependencies, Node 24 >=24.13.1, and pnpm 11.10.0.
Choose and record an exact Node patch version, OS image and architecture for repeat builds.
A VM is chosen over a request/serverless service because providers spawn long-running CLI,
PTY and Git subprocesses. Runtime state and workspace paths must survive restart. NFS or
object storage mounted as a filesystem is not a suitable SQLite disk. VM snapshots alone
are not the backup procedure below.

The owner must select/approve:

- Hosting account, region, VM architecture, disk capacity, backup destination and retention.
  Set a budget ceiling and spending alerts using the chosen provider's actual quote; this
  package makes no price estimate. Allow space for source/dependencies, repositories,
  attachments, archives and retained pre-restore data. Run `du -sh` periodically.
- A dedicated unprivileged OS user and an empty absolute deployment path (examples use
  `/srv/b3r-personal`). An administrator must separately approve ownership and boot-time
  user-service lingering. This package never runs sudo or changes those settings.
- A reachable HTTPS/WSS origin, DNS/certificate ownership, access boundary and client pairing
  policy. No ports, firewall rules, VPN or tunnels are created here.
- Which provider CLIs and exact versions are allowed, and whether existing subscriptions,
  accounts, OAuth/device login and licensing permit a headless cloud VM. **Compatibility is
  unknown until each provider/account is checked.** CLI executables, authentication and
  model access are separate prerequisites. Grokbot's external-controller bridge is a separate
  dependency; this runtime package neither connects it nor supplies its credentials.

The active Mac runtime, its port 3789, live `~/.t3/userdata`, and PR91/92 are not migration
sources for these commands. Data migration requires a separately approved coordinated cutover.

## Layout and release build

Run future setup as the dedicated VM owner after the decisions above. The code shown below
is an operator procedure, not an instruction to provision during this implementation task.
Substitute the **reviewed integrated commit**, including required dependency PRs, for `SHA`.

```sh
# Run from the reviewed checkout on the VM; ROOT must initially be empty.
ROOT=/srv/b3r-personal
python3 deploy/personal-cloud/control.py --root "$ROOT" init
mkdir "$ROOT/operator"
cp deploy/personal-cloud/control.py "$ROOT/operator/control.py"
cp deploy/personal-cloud/build.sh "$ROOT/operator/build.sh"

SHA=<full-reviewed-40-character-commit-sha>
git clone https://github.com/charliefq/base3router.git "$ROOT/releases/$SHA"
git -C "$ROOT/releases/$SHA" checkout --detach "$SHA"
bash "$ROOT/operator/build.sh" "$ROOT/releases/$SHA" "$SHA"
```

The build uses the frozen pnpm lockfile and existing web/server build graph, checks the CLI's
`--help`, and writes a local build receipt. It does not run providers or publish artifacts.
Build a fresh checkout for each SHA on the target Linux architecture; do not copy Mac native
modules. Keep the whole checkout and `node_modules`: native server dependencies remain external
to the bundle. Supply any approved public client build identifiers before build, using the
existing [Connect setup](connect-setup.md) if relay access is later chosen. Do not bake origins
or put secrets in a release checkout. The package does not require Clerk/relay provisioning
for a direct environment connection.

Persistent directories, all owned by this user with private permissions:

| Path under ROOT | Contents |
| --- | --- |
| `t3-home/` | Explicit T3 home: userdata SQLite, WAL/SHM, attachments, settings, environment identity/auth state and managed provider artifacts |
| `provider-home/` | Runtime HOME, CLI state, config/cache and owner-approved executables in `.local/bin` |
| `workspaces/` | Canonical project directories, repositories and Git worktrees |
| `releases/<SHA>/` | Built code and dependencies; separate from data |
| `current` | Atomically selected release pointer |
| `backups/` | Private offline archives, requiring independent off-VM retention |

Edit `ROOT/config.json` to set the canonical **real** Node executable path (no symlink ancestors)
and an unused loopback port. The generated config defaults to `/usr/bin/node` and 3773; these
are placeholders to validate on the VM. The runner supplies a minimal environment, HOME and
PATH and an explicit `--base-dir`; it never inherits this Mac's provider credentials or dev
settings. It binds only `127.0.0.1`. Provider binaries that need extra system libraries or
variables require a reviewed operator change, not an ambient login shell.

```sh
python3 "$ROOT/operator/control.py" --root "$ROOT" activate "$SHA"
# Review the generated file before installing into this dedicated user's service manager.
python3 "$ROOT/operator/control.py" --root "$ROOT" unit > "$ROOT/b3r-personal-cloud.service"
mkdir -p "$HOME/.config/systemd/user"
cp "$ROOT/b3r-personal-cloud.service" "$HOME/.config/systemd/user/"
systemctl --user daemon-reload
# Only after provider startup behavior/accounts and remote-entry prerequisites are approved:
python3 "$ROOT/operator/control.py" --root "$ROOT" start
python3 "$ROOT/operator/control.py" --root "$ROOT" status
python3 "$ROOT/operator/control.py" --root "$ROOT" health
# Optional boot start, after administrator-approved user lingering is available:
systemctl --user enable b3r-personal-cloud.service
```

The service restarts on failure. `KillMode=mixed` gives Node time to close its providers before
systemd terminates the remaining cgroup after 120 seconds. A file lock inherited across exec
prevents a second package-managed writer, activation or backup while it runs. Start all B3R
processes for this root through this unit; a separately launched Node bypasses that lock.
Lifecycle commands verify the installed unit targets this exact root and operator script.
Never run a second unit or CLI directly against this home.

`health` checks the loopback environment descriptor and prints its environment ID. This is
HTTP availability only: it does not test provider execution, authenticated API/WSS, disk
capacity or end-to-end task completion. Status and health failures return nonzero. Service
logs are available to the owner with `journalctl --user -u b3r-personal-cloud.service`; startup
logs may contain pairing material, so keep them private and do not paste them into issues.

## Authenticated remote entry and clients

Before exposure, the owner must approve and verify a TLS reverse proxy or an existing approved
private connection route on this VM. The proxy must support WebSocket upgrade and long-lived
connections, preserve API/Authorization/cookies/Origin behavior, forward the entire application
(including `/.well-known/t3/environment`, `/api`, `/ws` and pairing routes), and terminate a
valid certificate for the canonical HTTPS origin. An outer authentication layer must support
Electron and WSS clients; a browser-only login redirect is not sufficient. Configure neither
a proxy nor Tailscale Serve as part of this task. T3's environment authentication must remain
in force at the backend, including when using an outer private network boundary.

Client pairing is an owner-operated credential issuance step: use the existing server CLI
`pair` / `auth` tools against this explicit home after approving access, and keep links/tokens
out of source, logs shared with others and the PR. See CLI help and
[remote connection guidance](../user/remote-access.md).
No bearer secret is needed for the availability probe, and none is stored in this package.

On both desktops, add the same canonical remote environment through the existing connection
flow and use it for cloud projects. Verify both show the same descriptor environment ID and
the same project/thread/task records. A desktop's embedded local environment can still exist
as an independent environment; it must not point at the VM's SQLite files or mount a synchronized
copy as another writer. The remote-only client wiring is a separate checklist dependency.
No changes to Electron, mobile, Agents or provider adapters are included here.

Before accepting the final integrated environment, the coordinator should perform one approved
fixture task from both clients, attachment upload/download, a reconnect and authenticated WSS
check, then separately approve any real provider execution. Local fixtures do not prove Grokbot
reachability, account compatibility or paid model access.

## Stop, back up and restore

Backups require planned downtime. First stop/drain tasks in the UI, then stop this exact service.
Stop all other jobs/terminals that write within this dedicated root. Never copy a live SQLite
file alone. These archives copy the whole stopped home, including WAL/SHM, attachments, CLI state
and workspaces as a single set. Repositories/worktrees must be self-contained within workspaces;
external/absolute symlinks and external `.git` pointers are refused. Persistent paths outside
this root are not supported. Relative internal links are retained. Processes outside the service
and filesystem mount points are an owner responsibility.

```sh
python3 "$ROOT/operator/control.py" --root "$ROOT" stop
ARCHIVE="$ROOT/backups/$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
python3 "$ROOT/operator/control.py" --root "$ROOT" backup "$ARCHIVE"
python3 "$ROOT/operator/control.py" --root "$ROOT" start
```

Archives and SHA-256 sidecars must be new files. They are mode 0600 and include credentials
and private source if present in the homes: store them only in an owner-approved encrypted
backup location with restricted access and retention. The checksum detects accidental corruption;
it is not a signature. A failed backup can leave a partial archive without a checksum: discard
that incomplete output privately and retry with a new filename. Backup does not upload anything,
restart the service, rotate old archives or print file contents. Retain the matching release
checkout/build receipt and operator/config files separately so they can be reproduced.

Restore only trusted archives, with the same OS user, architecture, Node version and absolute
ROOT. Durable workspace paths and provider state are not relocatable by this script. For a new
VM, initialize an empty root, rebuild the recorded release, copy the archive plus checksum
sidecar, and restore before starting. No credentials from the current Mac are needed for
fixture restore checks.

```sh
python3 "$ROOT/operator/control.py" --root "$ROOT" stop
python3 "$ROOT/operator/control.py" --root "$ROOT" restore "$ARCHIVE"
# Read required_release from the result and select that exact reviewed build:
python3 "$ROOT/operator/control.py" --root "$ROOT" activate <required-release-sha>
python3 "$ROOT/operator/control.py" --root "$ROOT" start
python3 "$ROOT/operator/control.py" --root "$ROOT" health
```

Restore verifies the checksum and safe archive paths before swapping data. It retains the old
directories under `before-restore-<id>` and blocks startup with a different release until the
recorded release is activated. It never silently resumes work. Verify SQLite integrity, expected
records, files and clients before approving any task continuation; a stopped provider process
may need explicit session recovery. After acceptance, the owner can privately retire the retained
copy under their retention policy. A restore failure leaves the service stopped; inspect the
error and retained data before recovery. Keep the source archive and its sidecar off the runtime
disk as well, since a single disk failure can destroy both local data and local backups.

## Upgrade and rollback

Build the new reviewed SHA in a fresh `releases/<SHA>` directory. Drain tasks, stop, and take a
backup **before the first new-version start**, then `activate <new-SHA>` and start. Check HTTP,
authenticated WSS and the shared records. Keep the previous release and pre-upgrade backup.
For rollback after a new version has opened SQLite, stop and restore that pre-upgrade backup,
activate its recorded SHA and start. Switching binaries alone is unsafe after schema migration.
Restore loses work since that backup: the owner must choose whether to preserve newer results
before rollback. Never run the old and new versions concurrently against these directories.

## Focused validation and remaining setup

```sh
python3 -m unittest discover -s deploy/personal-cloud -p 'test_*.py' -v
bash -n deploy/personal-cloud/build.sh
```

The offline fixtures cover SQLite integrity after restore, attachment/workspace/CLI-state
retention, inherited writer lock, release selection, unsafe paths, checksum mismatch and
existing destination refusal. No runtime, account login or provider is invoked. Linux build,
systemd lifecycle/boot, actual HTTPS/WSS, two-desktop integration and cloud/account compatibility
remain unverified until an approved Linux target and access prerequisites exist. This Mac has
no Docker or pnpm executable available for a Linux build; the build script intentionally refuses
macOS. This is a deployment foundation, not a deployed service.
