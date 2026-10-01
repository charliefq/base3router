# Base3Router Phase 9: product rebrand and router UI

Stacked on `main` after Phase 7 (PR #9) and Phase 8 (PR #10), at
`4208ff30a0f1b916b89d0a9defa555b01077c931`. This note freezes the Phase 9
boundary. It does not restate schema, dispatch, or failover policy that
contracts and tests already encode.

Starting branch: `cursor/phase-9-base3router-rebrand-ui`.

## Goals

Make Base3Router look and read as one product: identity, design tokens, the
three-region desktop shell, Auto Route vs Manual in the composer, and a
readable Inspector route trace. Preserve Phase 7 environment-owned projection
and Phase 8 routing semantics.

## Non-goals

- OpenRouter integration
- Prompt task classification
- Learned routing
- Cost, quality, or latency telemetry beyond existing unknown-metric honesty
- Skill Router execution
- MCP Router (task-scoped tool exposure)
- Dream Memory
- A rewrite of the Phase 8 routing algorithm
- Database or user-data migration
- Provider credential or `appId` / protocol-scheme changes
- Marketing-site rewrite (`apps/marketing` remains the upstream T3 Code site)
- Renaming the CLI binary (`npx t3`) or `T3CODE_*` environment variables

## Inherited Phase 7 / 8 behavior

Phase 7: Control Center, environment-owned projection, desktop Internal Alpha
packaging, Base3Router mark, three-column shell, independent scroll regions.

Phase 8: Auto Route vs Manual, execution binding, bounded provider failover,
Inspector attempt history, UI Lab Playwright acceptance. Clients that omit
`routingMode` keep pre-Phase-8 behavior. Mobile stays Manual-only.

## Four names that must not collapse in the UI

| Name                           | What it is                                                       | Where it appears                                         |
| ------------------------------ | ---------------------------------------------------------------- | -------------------------------------------------------- |
| **Auto Route**                 | Base3Router model router (`routingMode: "auto"`)                 | Composer model cluster, Inspector route card             |
| **Manual**                     | User-chosen `instanceId` + model slug                            | Composer picker, Inspector mode                          |
| **Access Auto**                | Runtime permission policy (`RuntimeMode = "auto"`)               | Composer access/permission control                       |
| Cursor catalog slug **`auto`** | Provider-native model id, only if that slug is actually selected | Model list under Manual, never as the Auto Route control |

## User-visible surfaces

Web (app.t3.codes and `npx t3` hosted web), desktop Electron shell, mobile
read-only client, Control Center, Inspector, composer, About/Settings,
onboarding, splash/`index.html` title, UI Lab.

## Branding compatibility boundary

Preserve: `T3CODE_*` / `VITE_T3CODE_*`, `com.t3tools.t3code`, protocol schemes
`t3code` / `t3code-dev` / `t3code-preview`, user-data directories (`t3code`,
legacy `T3 Code (Alpha)`), npm package names `@t3tools/*`, storage keys
`t3code:*`, CLI `npx t3`, T3 Connect as the tunnel product, MIT attribution
to the T3 Code project.

Those names must not appear as the ordinary product title. About may still
say the app is built on the open-source T3 Code project.

## Design principles

Focused, technical, calm, operational. Information-dense without crowding.
Semantic tokens over scattered literals. Distinct from a generic chat clone.
Light and dark share the same roles. No new UI framework.

## UI states

Empty, loading, unpaired, offline, ready, degraded, error, Auto Route
preview, Manual, successful route, capability-filtered, provider unavailable,
fallback succeeded, alternates exhausted, Inspector with no route, Inspector
success, Inspector failure.

## Accessibility

Keyboard to composer, rail, Inspector toggle, and menus. Visible focus.
Labels on icon-only controls. Contrast on status tones. No page-level
horizontal overflow. Independent scroll regions stay operable. Composer
usable at compact height (~360px). Inspector collapsible under 1280px.
Honor `prefers-reduced-motion` for existing motion.

## Validation matrix

- `vp run --filter @t3tools/web typecheck`
- `node scripts/base3router-ui-lab.ts`
- Control Center, workspace scroll-layout, Operational Inspector, composer
  router-control, model-router / failover / dispatcher tests
- Scripts typecheck if scripts change
- Targeted `vp lint` on touched files

## Deferred (Phase 10+)

OpenRouter, classification, learned routing, measured telemetry, Skill/MCP
routers, Dream Memory, user-data path migration, CLI rename, marketing site,
mobile Auto Route control, native-only DMG identity beyond existing
Base3Router `productName`. Packaging identifiers (`com.t3tools.t3code`, `t3code`
schemes, legacy user-data folders) stay on the compatibility boundary.

## Identity audit decisions

Replace now: application title and window title, rail/About/onboarding/settings
copy, composer empty/error states, splash/`index.html`, client presentation
labels (`Base3Router Desktop/Web/Mobile`), CLI user-facing descriptions, and UI
Lab fixtures.

Preserve: `T3CODE_*` / `VITE_T3CODE_*`, `com.t3tools.t3code`, `t3code` URL
schemes, user-data directories (`T3 Code (Alpha)` / `t3code`), `@t3tools/*`
package names, `npx t3`, T3 Connect, storage keys `t3code:*`, git author
`T3 Code`, MCP server name `T3 Code`, and About attribution to the upstream
project.

Ambiguous, decided preserve: `apps/marketing` remains the upstream T3 Code
site. Contributor docs that still say "Working on T3 Code" refer to the
upstream project, not the product title. Injected Electron branding tests keep
a fictional `T3 Code` payload to prove the injection path.

Deferred: CLI binary rename, user-data path migration, marketing rewrite,
mobile Auto Route control.
