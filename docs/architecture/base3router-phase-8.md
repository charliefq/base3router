# Base3Router Phase 8: Auto Model Router V0

Stacked on Phase 7 (`66b8655666c21cafb5b845ac1ee04cfcd471696c`). This note
records the repository audit, the V0 routing boundary, and the conflicts with
inherited T3 controls. It does not restate schema fields or control flow that
the contracts and tests already encode.

Starting point: Phase 7 Internal Alpha shell. Dispatcher policy
`dispatcher.phase-1a.v1` stays the turn-binding envelope. Model Router V0 is
`model-router.v0`.

## Audit matrix

| Capability                                                                     | Exists | Partial | Missing | Relevant files                                                                                                                      | Phase                            |
| ------------------------------------------------------------------------------ | ------ | ------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Composer model picker (`instanceId` + slug)                                    | x      |         |         | `apps/web/src/components/chat/ProviderModelPicker.tsx`, `apps/web/src/modelSelection.ts`, `packages/contracts/src/orchestration.ts` | inherited                        |
| Composer control labeled `Auto`                                                | x      |         |         | `apps/web/src/components/chat/runtimeModeConfig.ts` — this is `RuntimeMode`, not a model router                                     | inherited                        |
| Cursor catalog slug `"auto"`                                                   | x      |         |         | `packages/contracts/src/model.ts` `DEFAULT_MODEL_BY_PROVIDER.cursor`                                                                | inherited                        |
| Provider registry (codex, claudeAgent, cursor, grok, opencode, antigravity)    | x      |         |         | `apps/server/src/provider/builtInDrivers.ts`, `packages/contracts/src/providerInstance.ts`                                          | inherited                        |
| Open `ProviderDriverKind` (Qwen/DeepSeek/Kimi representable, no live adapters) | x      |         |         | `packages/contracts/src/providerInstance.ts`                                                                                        | inherited / 8 docs               |
| Turn start carries `modelSelection` into adapters                              | x      |         |         | `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`                                                                    | inherited                        |
| Dispatcher preview + immutable task bind                                       | x      |         |         | `packages/contracts/src/dispatcher.ts`, `apps/server/src/dispatcher/Dispatcher.ts`                                                  | 1–4                              |
| Dispatcher gated by `T3CODE_DISPATCHER_ENABLED`                                | x      |         |         | `apps/server/src/ws.ts` `bindDispatcherTurnStartCommand`                                                                            | 1                                |
| Capability/cost/latency ranking                                                |        |         | x       | —                                                                                                                                   | 8 (unknown metrics stay unknown) |
| Auto vs Manual model routing mode                                              |        |         | x       | —                                                                                                                                   | 8                                |
| Selected Auto model reaching execution                                         |        | x       |         | Bind uses preferred `modelSelection` only when dispatcher is enabled                                                                | 8                                |
| Skills discovery                                                               | x      |         |         | `packages/client-runtime/src/providerSkills.ts`, per-driver `*Skills.ts`                                                            | inherited                        |
| Skill Router execution                                                         |        |         | x       | —                                                                                                                                   | later                            |
| MCP toolkits (preview/device/PR)                                               | x      |         |         | `apps/server/src/mcp/`                                                                                                              | inherited                        |
| MCP Router (task-scoped tool exposure)                                         |        |         | x       | —                                                                                                                                   | later                            |
| Credential store + client redaction                                            | x      |         |         | `apps/server/src/serverSettings.ts`, `packages/client-runtime/src/cursorCloud.ts`                                                   | inherited                        |
| Dispatcher ActionGate (route ALLOW/DENY)                                       | x      |         |         | `packages/contracts/src/dispatcher.ts` `ActionGateResult`                                                                           | 1                                |
| Independent ActionGate for external side effects                               |        | x       |         | Permission `RuntimeMode` + approval UI exist; not an independent side-effect gate                                                   | later                            |
| Project memory / Dream provenance                                              |        |         | x       | Provider `dream` is an inert task type only                                                                                         | later                            |
| Code-enforced agent concurrency limits                                         |        | x       |         | Effect reactor concurrency, not a product agent budget                                                                              | later                            |
| Usage/cost telemetry                                                           | x      |         |         | `apps/server/src/usage/`, `provider.turn.completed` analytics                                                                       | inherited                        |
| Measured routing quality / rework loop                                         |        |         | x       | —                                                                                                                                   | later                            |
| Operational Inspector route card                                               | x      |         |         | `apps/web/src/controlPlane/presentOperationalInspector.ts`                                                                          | 7                                |
| Inspector model-router trace                                                   |        | x       |         | Provisional/bound provider·model·gate only                                                                                          | 8                                |
| Control Center + independent scroll regions                                    | x      |         |         | `apps/web/src/components/controlPlane/`                                                                                             | 7                                |

## Inherited `Auto` control

The composer control labeled **Auto** is `RuntimeMode = "auto"`: a permission
policy (“supported providers approve routine actions”). It is not a model
selector. Cursor’s default **chat** model slug is also `"auto"`, which Cursor
may route internally. Phase 8 names the new mode **Auto Route** so those three
meanings stay distinct.

## Intended router boundaries (V0 implements Model Router only)

- **Model Router** — chooses provider instance + model for a turn. This phase.
- **Skill Router** — chooses working method/instructions. Discovery exists;
  do not execute skill-based routing yet.
- **MCP Router** — exposes only authorized tools required for the task.
  Toolkits exist; do not add a second tool-policy service yet.
- **ActionGate** — future independent approval for external side effects.
  Today’s dispatcher gate is route eligibility only. Do not weaken it.
- **Memory / Dream** — future consolidation with provenance. Not this phase.
- **Evaluation metrics** — future measured cost, quality, latency, failure
  rate, and human rework. V0 never fabricates those scores.

## Conflicts with this prompt, adapted to the repo

1. Do not reuse the RuntimeMode label `Auto` for model routing.
2. Do not send Cursor slug `"auto"` unless that slug is the actual selected
   catalog model.
3. Dispatcher bind was flag-gated. Auto Route clients send `routingMode` and
   the server binds even when `T3CODE_DISPATCHER_ENABLED` is false, so the UI
   cannot claim Auto while the backend uses a different model.
4. Clients that omit `routingMode` keep pre-Phase-8 behavior (explicit
   `modelSelection`, dispatcher bind only when enabled).
5. Qwen / DeepSeek / Kimi are valid future `ProviderDriverKind` slugs. This
   phase does not add credentials, API runners, or live calls.
6. Mobile keeps the existing explicit picker (Manual). It does not grow a
   fake Auto Route control in this phase.
7. Mid-turn Auto Route failover is bounded: Auto may try the next eligible
   provider instance after a classified pre-output failure, at most three
   attempts. Usage-limit failures cool down the whole provider instance.
   Manual selection never switches silently. After tools or assistant output
   begin, automatic replay is skipped.
8. Resting composer measurement used the model picker as the only leading
   control. Auto Route hides that picker, so the Auto Route cluster is now a
   measured leading control and does not return `null` in reduced-height layout.

## V0 selection order

1. Required capabilities.
2. Provider/model availability and authorization.
3. Explicit user constraints (allow/deny instance, driver, or model).
4. Manual override (bypasses ranking; still emits an audit decision).
5. Policy weights for quality, cost, and latency — only when every eligible
   candidate has a **known** value for that dimension.
6. Deterministic tie-break: preferred project/environment default, then
   documented driver order, then `instanceId`, then model slug.
