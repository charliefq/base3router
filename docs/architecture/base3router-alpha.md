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

## Explicit non-goals

- No parallel side application
- No Dispatcher selection-policy change
- No Cursor Cloud execution-semantics change
- No client-side credentials or secret-shaped values
- No fake production data
- No removal of the upstream MIT license or T3 attribution
- Packaged Electron `productName` and user-data directory names stay on the
  existing T3 Code identity so this alpha does not migrate installs
- Desktop IPC `stageLabel` remains `Alpha` | `Dev` | `Nightly`; the web shell
  can show Internal Alpha when desktop branding is not injected
