# Base3Router Internal Alpha

Phase 7A turns the existing T3 client shells into the first recognizable
Base3Router control-plane UI. It does not add a second application, a second
backend, or a second source of routing truth.

Starting point: `main` @ `e39e44c7c52204d29f1fa7bc458a3a7e16979772`.

## Product hierarchy

Base3Router is the product. Device surfaces are Mac desktop, Windows/Alienware
desktop, and iPhone. Those surfaces share one server-authoritative project,
task, workflow, route, memory, and runner state.

The execution layer sits beneath the surfaces: Cursor Cloud, Codex, Claude, and
later Grok or other runners. Cursor Cloud remains a `runnerKind`, not a
provider. Credentials stay server-side references.

## Current architecture to reuse

Clients already share:

- `packages/contracts` — dispatcher, workflow, ActionGate, Cursor Cloud, RPC
- `packages/client-runtime` — preview/bound presenters, workflow atoms, Cursor
  Cloud presentation and secret redaction
- `apps/web` ChatView / composer / Sidebar — the live workspace
- `apps/desktop` Electron wrapper around the same web client
- `apps/mobile` read-only workflow/run presentation

Phase 1–6 RPCs and selection policy stay authoritative. This phase only
presents that state.

## Information architecture

Desktop is a three-column control plane:

1. Left — Base3Router identity plus Projects, Tasks, Workflows, Agents/runs,
   and Settings. Existing create/select behavior stays in the current sidebar.
2. Center — existing chat, composer, attachments, approvals, and workflow
   controls. Control Center is an overview of the same projected state.
3. Right — operational inspector. Collapses on narrow desktop widths.

Mobile stays a read-only surface for workflow and runner state. It is not a
separate product.

Capability-off servers keep the current chat/sidebar path. New chrome renders
empty or unavailable states instead of inventing data.

## Component boundaries

Presentation adapters live in `apps/web/src/controlPlane/`. They wrap existing
client-runtime presenters and never reimplement Dispatcher or Cursor Cloud
policy.

UI lives in `apps/web/src/components/controlPlane/`. ChatView is not rewritten.
The inspector mounts beside it. Control Center is a new route that reads the
same project/thread/workflow projections.

## File ownership

Workstream 1 owns this note and the docs index link.

Workstream 2 owns branding strings, the Base3Router mark, About attribution,
and design tokens. It may change `branding.ts`, `Base3RouterMark.tsx`,
`index.css` tokens, Settings About copy, sidebar/onboarding lockups, and mobile
brand marks. It does not change ChatView or `AppSidebarLayout`.

Workstream 3 owns the root web/desktop shell: `AppSidebarLayout.tsx`,
`ProductRail.tsx`, `productNavigation.ts`, `ThreadRouteView.tsx` inspector
mount, `_chat.index.tsx` inspector mount, and `control-center.tsx`. Only this
workstream edits those shell files.

Workstream 4 owns inspector view-models, inspector components, and their tests.

Workstream 5 owns Control Center view-models, status cards, the overview
surface, fixtures used only by tests/previews, and their tests.

Workstream 6 owns mobile read-only workflow presentation, desktop visible
branding that does not migrate user-data paths, and packaging notes. It does
not redesign the desktop shell.

## Internal Alpha desktop artifacts

Unsigned packages are built by `.github/workflows/internal-alpha-desktop.yml`
through the existing `vp run dist:desktop:artifact` path. Supported targets:

- macOS arm64 on `macos-14` (`Base3Router-Internal-Alpha-mac-arm64`)
- macOS x64 on `macos-14` via `--arch x64` (`Base3Router-Internal-Alpha-mac-x64`),
  matching `release.yml` rather than a retired Intel image
- Windows x64 on `windows-2022` (`Base3Router-Internal-Alpha-windows-x64`)

Linux installers, Windows arm64, and macOS universal binaries remain supported
by `scripts/build-desktop-artifact.ts` but are not produced by this Internal
Alpha workflow. The workflow never signs, notarizes, or publishes.

iPhone EAS preview is a separate labeled workflow (`mobile-eas-preview.yml`)
that requires `EXPO_TOKEN` and the `🚀 Mobile Continuous Deployment` label.
This Internal Alpha fork does not configure that token, so no iPhone/EAS
preview is claimed. Mobile stays a read-only client of the same server
catalog: identity, workflow name/stage, runner kind, Cursor agent/run ids,
and terminal/error/cancelled state. Mutation controls stay on web/desktop.

## Explicit non-goals

- No parallel side application
- No Dispatcher selection-policy change
- No Cursor Cloud execution-semantics change
- No client-side credentials or secret-shaped values
- No fake production data
- No removal of the upstream MIT license or T3 attribution
- Packaged Electron `productName` is Base3Router. Installer and artifact
  filenames use `Base3Router-Internal-Alpha`. Visible stage is Internal Alpha.
- Desktop IPC `stageLabel` remains `Alpha` | `Dev` | `Nightly`. Clients map
  `Alpha` to Internal Alpha for display only.
- User-data paths stay on the legacy T3 Code directories
  (`T3 Code (Alpha)` / `t3code`, plus `T3 Code (Dev)` / `t3code-dev` in
  development). Fresh installs keep using those folders. Existing T3 data is
  never deleted, relocated, or overwritten. `appId` stays `com.t3tools.t3code`
  so protocol handlers and single-instance locks remain compatible.
