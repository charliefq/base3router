# Base3Router and T3 Orchestrator V2 compatibility

This is an evidence-backed audit, not a migration. It records how Base3Router
can reuse upstream T3 Orchestrator V2 without dropping task contracts, routing
evaluation, ActionGate, governed memory, privacy controls, or concurrency
guarantees.

No code, dependency, schema, or data migration was performed for this note.
Synthetic databases only. PR #16 stays open and unmerged.

## Compared SHAs and ancestry

Recorded 2026-10-05 from `charliefq/base3router` and
`https://github.com/pingdotgg/t3code`. Primary comparison is the pinned
nightly, not moving `upstream/main`.

| Ref                                                      | SHA                                                                                             | Role                                                                          |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Audit branch HEAD                                        | `8191cfc534b25b3d6f06c06031bfe53691f83e1a`                                                      | Current stabilization head (PR #16)                                           |
| `origin/cursor/internal-beta-security-release-readiness` | `8191cfc534b25b3d6f06c06031bfe53691f83e1a`                                                      | Same SHA; PR #16 head                                                         |
| `origin/main`                                            | `bab26191075ec8806894478970e8d9954c357290`                                                      | Merged through Phase 13 (PR #15). **Not identical** to the stabilization head |
| PR #16 base                                              | `1c4ed9e59b7c697063dc42cffaf45dba799c1248` (`cursor/phase-13-dream-memory-concurrency-budgets`) | Open, draft, unmerged                                                         |
| Merge-base with upstream                                 | `7cfb4987fe27da3e1d4e86abacae3a1fc12af5bb`                                                      | `chore(ci): use GPT 6 Sol Max for check agents (#13473)`, 2026-09-24          |
| Pinned nightly `v0.0.46-nightly.20261003.2610`           | `8ed276c246b624631e7d39241ebfd22d8314cb68`                                                      | First Orchestrator V2 nightly; **primary comparison**                         |
| `upstream/main` at audit time                            | `06e627448bc1ee58487c1a2a9d6bf8d5ef479af3`                                                      | 144 commits after the nightly; listed separately, not the comparison base     |
| `origin/codex/workflow-phase-5`                          | `9d5f2d8e41823acf518e7761a5b916defd5e4b2f`                                                      | Identical to `workflow-phase-5-acceptance`                                    |

Ancestry facts:

- The nightly **is** an ancestor of `upstream/main`.
- `origin/main` **is** an ancestor of the stabilization head (39 commits behind it).
- Both Base3Router tips share the same merge-base with the nightly:
  `7cfb4987`.
- Counts from that merge-base: Base3Router stabilization +168, `origin/main`
  +129, nightly +223, then `upstream/main` +144 after the nightly.
- The nightly tag **is not** in Base3Router history. V2 landed upstream as
  `feat(orchestrator): introduce new orchestrator` (pingdotgg/t3code#2829) after
  the fork point.

Inspected trees (read-only worktrees; `/workspace` left on `origin/main`):

- Base3Router: `/tmp/base3router-audit/v2-compat` @ `8191cfc53`
- Upstream nightly: `/tmp/base3router-audit/upstream-v2` @ `8ed276c24`

## What already exists in Base3Router

**Confirmed: Orchestrator V2 is not in this fork.** There is no
`apps/server/src/orchestration-v2/`. `ORCHESTRATION_PROTOCOL_VERSION` is `1`.
Symbols `orchestrationV2` / `OrchestratorV2` are absent. The live engine is
still V1 `apps/server/src/orchestration/` (82 TypeScript files) plus Base3
policy directories that upstream does not have.

The only V2-shaped code in this HEAD is a **client fold** that prefers a future
subagent projection and otherwise reads V1 `task.*` / `tool.*` activities:

```1:11:packages/client-runtime/src/state/subagentRuntime.ts
/**
 * Native-provider subagent observability: a tolerant fold over persisted
 * task.* / tool.* thread activities into orchestration-v2-shaped subagent
 * state, plus the source-neutral panel model every client renders.
 *
 * This module is deliberately legacy-bridge code. When orchestration-v2's
 * subagent projection is available for a thread, deriveAgentPanelModel
 * prefers it (see the v2Projection parameter) and the fold is skipped; when
 * the v1 orchestrator is retired this file is deleted.
```

`delegate_task` / `schedule_task` / `t3_thread_*` strings in
`packages/client-runtime/src/work-log/presentation.ts` are UI labels for
provider tool names, not Base3Router APIs.

V1-shaped overlaps that must not be confused with V2:

| Capability                           | Base3Router today                                                          | Upstream V2                                                                |
| ------------------------------------ | -------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Event store + projections + receipts | `orchestration_events`, `projection_*`                                     | Separate `orchestration_v2_*` tables + `statev2.sqlite`                    |
| Turn start                           | V1 `dispatchCommand` → PCR `sendTurn`                                      | V2 `message.dispatch` / `launchThread` → adapter `startTurn`               |
| Interrupt                            | Adapter `interruptTurn`; lease waits for `turn.completed` / `turn.aborted` | `run_interrupt_request` then `run_interrupt_result` on provider terminal   |
| Child work                           | Provider-native subagents observed; explicit **handoff**                   | `delegate_task` child threads + native subagent lineage                    |
| Message queue                        | Client follow-up setting; in-memory concurrency queue                      | Durable queued **runs** + effect outbox leases                             |
| Cursor                               | ACP CLI (`cursor-agent acp`) + separate Cursor Cloud REST runner           | Official Cursor SDK (`CursorAgentSdk` / `Agent.create`)                    |
| MCP                                  | First-party preview/device/PR toolkits + Independent ActionGate            | Those plus orchestration toolkit (`delegate_task`, thread CRUD, schedules) |
| Usage limits                         | Probe + display; no auto-resume worker                                     | `UsageLimitRecoveryWorker` dispatches `message.dispatch`                   |
| Schedules                            | None as agent cron (snooze only)                                           | `scheduled_tasks` + MCP `schedule_task`                                    |
| Protocol                             | `1`; exact-match client gate                                               | `2`; V2 clients only; HTTP 426 on mismatch                                 |

## Execution-boundary matrix

Each row: current files → upstream files → overlap → semantic difference →
integration risk → reuse / retain / wrap.

Legend: **reuse** = take upstream V2 as the execution kernel; **retain** = keep
Base3Router behavior as the product contract; **wrap** = keep the V2 primitive
but intercept every dispatch that starts or continues work.

### Provider adapters and Cursor SDK

|                     |                                                                                                                                                                                                                                                                                                                            |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Current             | `apps/server/src/provider/Services/ProviderAdapter.ts`, `Layers/{Cursor,Claude,Codex,Grok,Antigravity,OpenCode,OpenRouter}Adapter.ts`, ACP runtime, `apps/server/src/cursorCloud/*`                                                                                                                                        |
| Upstream            | `apps/server/src/orchestration-v2/ProviderAdapter.ts`, `Adapters/*AdapterV2.ts`, `Adapters/CursorAgentSdk.ts`, `provider/cursorSdk.ts`, Pi + ACP Registry + OpenCode 2                                                                                                                                                     |
| Overlap             | Same provider names. Shared ACP ideas. Tests exist on both sides.                                                                                                                                                                                                                                                          |
| Semantic difference | Base3 Cursor is **ACP CLI**, not the SDK. Cloud is a REST outbox (`migrations 057–059`), not V2 sessions. Upstream Cursor `interruptTurn` awaits `run.cancel` up to 10s then finalizes `interrupted`. Base3 Cursor interrupt is ACP `session/cancel` (request only). Pi, ACP Registry, and OpenCode 2 are **absent** here. |
| Risk                | High. Adapter contracts are different (`startSession`/`sendTurn` vs `openSession`/`startTurn`/`steerTurn`/`resumeThread`).                                                                                                                                                                                                 |
| Decision            | **Reuse** V2 adapters as the kernel. **Retain** Cursor Cloud as a Base3 runner until it is re-expressed as a V2 provider or an explicit wrap. Do not treat ACP Cursor as SDK-equivalent.                                                                                                                                   |

### Turn identity, terminal events, interruption, disconnect, recovery

|                     |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Current             | `packages/contracts/src/providerRuntime.ts` (`turn.started/completed/aborted`); `apps/server/src/concurrencyBudget/awaitTurnTerminal.ts`; `orchestration/Layers/ProviderCommandReactor.ts`; `serverRuntimeStartup.ts` reconcile; `ProviderSessionReaper.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Upstream            | `orchestration-v2/Orchestrator.ts` (`run_interrupt_request` / `run_interrupt_result`); `ProviderTurnControlService.ts`; `ProviderRuntimeRecoveryService.ts`; `docs/orchestration-v2/feature-lifecycles.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Overlap             | Both document that interrupt RPC return is **ack, not stop**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Semantic difference | Base3 **holds a process-local foreground lease** until `turn.completed` / `turn.aborted` or `executionStopped: true`. PCR currently always returns `executionStopped: false` from cleanup, so capacity stays occupied on unresolved execution (`awaitTurnTerminal.ts`, PCR ~2108–2124). V2 keeps the run active, keeps ingesting chunks, and terminalizes only when the provider reports `interrupted`. V2 also has an explicit TODO for providers that complete normally, never terminalize, or accept concurrent steer/queue (`Orchestrator.ts` ~7993–8018). V2 recovery writes `statev2` effect-outbox leases and can auto-continue; Base3 reconcilers orphan projected sessions without that durable outbox. |
| Risk                | High for concurrency accounting. V2 interrupt semantics can preserve Base3 lease intent **only if** every V2 start/steer/restart/continue path admits a lease and releases it on `run_interrupt_result` / run terminal — not on `run_interrupt_request` or Stop UI.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Decision            | **Reuse** V2 terminal graph. **Wrap** with Base3 `concurrency-budget.v0` so unresolved execution still occupies capacity. Do not infer stop from a Stop button, interrupt ack, or `run_interrupt_request`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

### Child delegation, completion, lineage, background work

|                     |                                                                                                                                                                                                                                                                                                                         |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Current             | Provider-native `task.*` events; `ThreadBackgroundLiveness.ts`; explicit `dispatcher/Handoff.ts` (`candidateMode: "explicit-only"`); no `delegated_task.request`                                                                                                                                                        |
| Upstream            | MCP `delegate_task` → `delegated_task.request` → child app thread (`creationSource: "mcp"`); completion delivery state machine; native subagents are read-only                                                                                                                                                          |
| Overlap             | Lineage UI ambition. Provider-native children exist on both.                                                                                                                                                                                                                                                            |
| Semantic difference | Base3 **handoff** is a user-approved provider switch of the same task with a new immutable route binding. V2 **delegate_task** spawns a child on any provider/model, optionally waits, and can wake the parent. Mid-thread provider switch in V2 is documented as **lossy** and not the recommended multi-harness path. |
| Risk                | Critical policy. `delegate_task` is a new dispatch path. If reused raw, it bypasses immutable route binding, Manual selection, ActionGate, and concurrency admission.                                                                                                                                                   |
| Decision            | **Retain** explicit handoff as the Base3 product contract for provider switches. **Wrap** `delegate_task` (do not drop it if V2 is adopted) so child creation is bound, gated, and admitted. Native subagents stay observation-only unless separately admitted.                                                         |

### Persistent queues, steering, schedules, usage-limit recovery

|                     |                                                                                                                                                                                                                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Current             | `followUpBehavior: queue \| steer`; in-memory `ConcurrencyScheduler`; Cursor Cloud SQLite outbox; snooze columns; usage probes; **no** agent cron                                                                                                                             |
| Upstream            | Queued runs (`queueHeld`, reorder/edit); effect outbox with `lease_owner` / `lease_expires_at`; `scheduled_tasks`; `UsageLimitRecoveryWorker` auto `message.dispatch`                                                                                                         |
| Overlap             | Steer vs queue as a user setting. Usage-limit **display**.                                                                                                                                                                                                                    |
| Semantic difference | V2 queue and schedules **start agent work after restart** without a new client click. Base3 concurrency queue is process-local and does not survive restart. Auto-resume is a server-authored continuation.                                                                   |
| Risk                | Critical. Schedules, queue.resume, usage-limit continuation, and delegated-completion wake are dispatch paths.                                                                                                                                                                |
| Decision            | **Reuse** durable V2 queue/outbox. **Wrap** every effect type that starts or continues work (`provider-turn.start\|steer\|restart`, `provider-runtime.continue`, scheduled dispatch, limit-resume). **Retain** Base3 “no silent cross-provider retry” and Manual no-failover. |

### RPC, authentication, clients, projections

|                     |                                                                                                                                                                              |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Current             | `packages/contracts/src/rpc.ts` V1 `WsRpcGroup`; `orchestrationProtocolVersion = 1`; pairing/DPoP scopes; dispatcher/ActionGate/Dream/concurrency RPCs                       |
| Upstream            | `ORCHESTRATION_V2_WS_METHODS`; protocol `2`; `/ws` rejects mismatch with HTTP 426 before RPC; V2 projections (`getThreadProjection`, diffs)                                  |
| Overlap             | Pairing/auth stack and WS transport patterns. Client compatibility helper is the same function with a different constant.                                                    |
| Semantic difference | Hard gate: V1 clients cannot talk to V2 servers and vice versa. Mobile store apps are V1; upstream requires V2 beta clients. Base3-specific RPCs have no V2 equivalents.     |
| Risk                | High for every surface (web, desktop wrap, mobile).                                                                                                                          |
| Decision            | **Reuse** V2 protocol as the wire if the kernel moves. **Retain** Base3 RPCs by porting them onto V2, not by running two orchestrators. Ship V2-capable clients in lockstep. |

### Database schemas, migrations, transcripts

|                     |                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Current             | `effect_sql_migrations` ids **001–065** in `state.sqlite`. Fork ids **054–065** own Base3 tables (routes, handoffs, workflow OS, Cursor Cloud, router eval, ActionGate, Dream Memory, concurrency audit). Projector caps 2000 messages / 500 checkpoints / 500 activities.                                                                                                                                                                                              |
| Upstream            | Shared 001–053, then **054** auto-settle, **055 OrchestrationV2** (events, projections, effect outbox, scheduled tasks, legacy import), **056** index cleanup. First V2 launch copies `state.sqlite` → `statev2.sqlite` once (`initializeV2Database.ts`). Transcript import is lazy from V1 `projection_thread_messages`. Native sessions, checkpoints, tool/approval history, and proposed plans are **not** imported. First continuation is a 32k-char lossy handoff. |
| Overlap             | Migration ids 001–053 names mostly match through the fork point.                                                                                                                                                                                                                                                                                                                                                                                                        |
| Semantic difference | **Id collision after 053.** Upstream documents that the migrator compares ids only: a fork row at id 054+ **masks** the upstream migration forever (`docs/internals/legacy-orchestration-migration.md`, “Divergent migration ids”). There is **no** supported schema downgrade. Copy is one-way and is not refreshed.                                                                                                                                                   |
| Risk                | Critical for any in-place merge. Upstream V1→V2 copy does **not** understand Base3 tables. Approvals, Dream Memory, router observations, workflow runs, and concurrency audit would not become V2 authority even if the file copy included the bytes.                                                                                                                                                                                                                   |
| Decision            | **Do not** run upstream cutover against live or copied production userdata. **Retain** Base3 tables in a **separate migration ledger** (upstream’s own guidance). Backup = untouched userdata copy + SQLite read-only; restore = replace files, never “migrate down”.                                                                                                                                                                                                   |

## Policy boundaries and V2 bypass risks

Enforcement is an integration-point property. “Retained files” do not prove
retained enforcement. `T3CODE_DISPATCHER_ENABLED` defaults to `false`
(`apps/server/src/config.ts`); Auto/Manual bind, handoff, and workflow OS are
off unless that flag is true.

### Confirmed Base3 enforcement (when dispatcher is enabled)

| Policy                                    | Integration point                                                                                                                                                                             | Proof                                                                                      |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Immutable route binding                   | WS `dispatchCommand` → `Dispatcher.bindDispatcherTurnStartCommand` → SQLite `ON CONFLICT DO NOTHING` → PCR re-read; client schema omits `routeBinding`                                        | `Dispatcher.ts`, `Dispatcher.test.ts`, `orchestration.test.ts`                             |
| Manual selection                          | `routingMode === "manual"` uses `manualOverride`; PCR failover only when `auto`                                                                                                               | `modelRouterFailover.test.ts`, PCR                                                         |
| Explicit handoff                          | `previewTaskHandoff` / `bindTaskHandoffTurnStart`; settled source; different instance; `explicit-only`                                                                                        | `Handoff.ts`, `Handoff.test.ts`                                                            |
| Hybrid Router                             | Bind-time `routeHybridModel`; observations from terminals; activate requires confirm+auth                                                                                                     | `RouterEvaluationService.ts` + tests                                                       |
| Skill/MCP snapshot                        | `attachPhase12Routes` stores plan on the binding                                                                                                                                              | `phase12Bind.ts`                                                                           |
| ActionGate fingerprint / consume / replay | MCP `withAllowedMcpTool` → `authorizeTool` → `waitForAuthorized` **consumes on grant before the tool runs**; cancel/deny/expire need successor ASK (`retry: true`); consumed cannot resurrect | `ActionGateService.ts` ~638–652, crash-window tests, `McpHttpServer.productionAsk.test.ts` |
| Dream Memory                              | Server-computed scope; PCR capsule inject; thread delete invalidates source                                                                                                                   | `DreamMemoryService.ts`, PCR, `ThreadDeletionReactor`                                      |
| Concurrency / unresolved execution        | PCR `admit(foreground-turn)` + `sendTurnUntilTerminal`; MCP `mcp-action`                                                                                                                      | `awaitTurnTerminal.test.ts`, workload tests                                                |
| Privacy / Inspector / Control Center      | Handoff sanitizer, ActionGate/Dream redaction; approvals via `actionGate.respondApproval`                                                                                                     | presenter tests + ActionGate RPC                                                           |

### Confirmed gaps on the current V1 spine (independent of V2)

- MCP ActionGate builds a **fresh** `planMcpToolAction`; it does not enforce
  the turn-bound `executionPlan` / `mcpRoute`.
- Provider-native tools and shells are outside Independent ActionGate.
- Provider-native subagents are not per-child admitted.
- Dispatcher route bind is skipped when `dispatcherEnabled === false` and the
  client omits `routingMode`.
- Cursor Cloud uses dispatcher `ActionGateResult`, not Independent ActionGate.
- Live MCP success path audits `action.started`; `action.succeeded` /
  `action.failed` writers were not found outside shared tests.
- RoutingAdvisor / ActionRiskAdvisor / Context workspace are **unimplemented
  experiments**, not unique shipped capabilities.

### New V2 paths that would bypass these controls if reused unwrapped

These are **confirmed in upstream source** at the pinned nightly. They start or
continue agent work without Base3 PCR/Dispatcher/ActionGate.

| Path                                                                             | Mechanism                                                      | Policies at risk                                                    |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------- |
| MCP `delegate_task`                                                              | `delegated_task.request` child run                             | Route bind, Manual, ActionGate, concurrency, privacy (child prompt) |
| MCP `create_threads` / `t3_thread_launch` / `t3_thread_send`                     | Thread create + `message.dispatch`                             | Same                                                                |
| MCP `t3_thread_interrupt` / `task_cancel`                                        | `run.interrupt`                                                | Lease/unresolved accounting if treated as stop                      |
| MCP queue edit/reorder/promote-to-steer                                          | Queued run mutations                                           | Route bind of the eventual start; steer vs Manual                   |
| MCP `schedule_task` + due worker                                                 | Later `message.dispatch`                                       | All turn policies, plus unattended execution                        |
| Usage-limit worker                                                               | Server `message.dispatch` with `usageLimitContinuationOfRunId` | Auto continuation without a new user bind                           |
| Provider continuation / delegated completion wake                                | `creationSource: "provider"\|"server"`                         | Silent re-entry; Dream capsule; leases                              |
| Effect outbox `provider-turn.start\|steer\|restart`, `provider-runtime.continue` | Durable after restart                                          | Same; process-loss replay rules differ from Base3 leases            |
| `queue.resume` after restart                                                     | Held queued runs                                               | Restart-continued work                                              |
| Mid-thread provider switch                                                       | Lossy context handoff                                          | Conflicts with Base3 explicit-handoff contract                      |
| ACP Registry / Pi / OpenCode 2 sessions                                          | New adapters + MCP injection                                   | Skill/MCP snapshot, ActionGate toolkit boundary                     |
| PR-watch wake (post-tag on main, not in nightly)                                 | Later `upstream/main`                                          | Same class as auto-resume; list only                                |

Agents cannot approve their own permission requests in V2 MCP docs. That is
**not** Independent ActionGate fingerprint/consume/replay.

## Workflow Phase 5 residuals

Compared `origin/codex/workflow-phase-5` (= `workflow-phase-5-acceptance`,
`9d5f2d8e4`) with **both** `origin/main` and the stabilization head.

| Comparison               | Merge-base  | Relation                                                  |
| ------------------------ | ----------- | --------------------------------------------------------- |
| Phase 5 vs `origin/main` | `9d5f2d8e4` | Phase 5 is a **strict ancestor** (main +121 / phase-5 +0) |
| Phase 5 vs stabilization | `9d5f2d8e4` | Strict ancestor (stab +160 / phase-5 +0)                  |
| Unique phase-5 commits   | none        | Merged as PR #6 (`e56e77e96`)                             |

Classification versus stabilization `8191cfc53`:

| Capability                           | Class            | Evidence                                                                                              |
| ------------------------------------ | ---------------- | ----------------------------------------------------------------------------------------------------- |
| Agent profiles                       | **absorbed**     | `workflow/Builtins.ts` byte-identical; RPC `workflow.action`                                          |
| Linear templates (`saas-production`) | **absorbed**     | Same builtins                                                                                         |
| Event-sourced runs                   | **absorbed**     | `workflow.record` / `workflow.recorded` in V1 decider/projector; migration `056_ProjectionWorkflowOs` |
| Human decision points                | **absorbed**     | `decision.record`; orthogonal to ActionGate                                                           |
| Stage binding (dispatcher)           | **absorbed**     | `stage.dispatch` + `DispatcherTaskRouteBinding`                                                       |
| Stage binding (Cursor Cloud)         | **still useful** | Post-phase-5 extension on the same OS (`runnerBinding`)                                               |
| Artifact propose/accept              | **absorbed**     | Same policy/UI                                                                                        |
| Named `AcceptanceHook` plugin        | **missing**      | Never existed; Internal Beta acceptance manifest is a later, unrelated system                         |
| Second orchestrator                  | **not present**  | Phase 5 reused V1 orchestration + dispatcher                                                          |

Do not cherry-pick the historical branch. Do not resurrect a second
orchestrator. On a V2 kernel the absorbed workflow OS still has to be
**re-bound** to V2 runs (wrap), because its stage dispatch currently talks to
the V1 command path.

## Recommended migration strategy

**Recommend B: move Base3Router policy layers onto a V2-based branch.**

Do not implement that move in this task. Keep Internal Beta (PR #16) on the
verified V1 spine until a synthetic-DB trial on a separate branch proves the
wraps.

### Why not A (integrate V2 into the existing fork)

- The nightly **replaced** `apps/server/src/orchestration/` with
  `orchestration-v2/` (380 files, 103 tests). Grafting that tree beside the
  live V1 engine creates two orchestrators.
- Protocol is a hard gate (`1` vs `2`). Clients cannot straddle.
- Migration ids **054–065 collide**. Upstream says fork schema must leave the
  shared `effect_sql_migrations` ledger. An in-place merge would skip
  OrchestrationV2 at id 055.
- 168 Base3 commits and 223 upstream commits from the same merge-base is a
  hostile three-way merge of the execution kernel.

### Why not C as the primary plan (selectively port bounded changes)

- Durable queues, `delegate_task`, Cursor SDK, scheduled tasks, usage-limit
  auto-resume, and V2 recovery are kernel features, not isolatable patches.
- Cherry-picking them into V1 recreates a second orchestrator (the Phase 5
  anti-pattern).
- C remains valid **only** for non-kernel fixes that already apply to V1
  (unrelated lint/CI, docs) — none of those deliver V2.

### Why B

- V2 is the execution kernel Base3Router does not have.
- Base3Router’s product is the **policy wrap** (bind, handoff, Hybrid eval,
  ActionGate, Dream Memory, concurrency leases, Inspector/Control Center).
  Those directories have **zero** upstream counterparts.
- Policy must be re-attached at V2 command/effect/MCP boundaries. File copies
  of PCR/Dispatcher will not run.
- A V2-based branch can keep a separate Base3 migration table, matching
  upstream’s fork guidance.
- Trial is reversible: do not point at live userdata; keep `state.sqlite` /
  PR #16 untouched; abandon the branch if wraps fail.

### Alternatives (rejected as primary, kept as references)

| Option                  | When it would win                              | Why it does not now                                           |
| ----------------------- | ---------------------------------------------- | ------------------------------------------------------------- |
| A                       | If V2 were a small module and ids 054+ matched | Neither is true                                               |
| C                       | If the goal were one adapter bugfix            | Goal is V2 reuse plus policy preservation                     |
| Stay on V1 indefinitely | If Internal Beta must ship before any V2 trial | Compatible with B: PR #16 stays; Task 3 is a different branch |

## Work packages (Task 3 inputs, not this PR)

Dependencies are strict. Effort is complexity, not calendar time. Uncertainty
is high wherever V2 interrupt TODOs or Base3 wrap coverage is incomplete.

| ID  | Package                                                                                                              | Depends on                     | Complexity | Uncertainty | Notes                                                                                                                     |
| --- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ---------- | ----------- | ------------------------------------------------------------------------------------------------------------------------- |
| P0  | Pin nightly (or a reviewed later SHA) on a **new** branch from a V2-based tree; do not reset PR #16                  | Decision on pin vs later fixes | M          | L           | Nightly is the specified pin; 144 later commits include real interrupt/delegate/MCP fixes                                 |
| P1  | Separate Base3 migration ledger; synthetic `statev2` only; backup/restore runbook                                    | P0                             | L          | L           | No downgrade path to invent                                                                                               |
| P2  | Port protocol-2 clients (web/desktop/mobile) in lockstep                                                             | P0                             | L          | M           | Store mobile is V1; desktop/web must match                                                                                |
| P3  | Wrap **every** V2 start/continue path listed above with Dispatcher bind + Manual + Hybrid snapshot                   | P0                             | XL         | H           | Includes MCP, schedules, limit-resume, outbox, completion wake                                                            |
| P4  | Map ActionGate fingerprint/consume/successor ASK onto V2 MCP + provider tools that Base3 currently gates             | P3                             | L          | H           | V2 “agents cannot self-approve” ≠ consume-before-execute                                                                  |
| P5  | Re-home concurrency leases on V2 run terminals (`run_interrupt_result` / run status), including unresolved execution | P3                             | L          | H           | Must not release on interrupt ack                                                                                         |
| P6  | Dream Memory retrieve/correct/delete/invalidate on V2 turns; keep capsule untrusted                                  | P3                             | M          | M           |                                                                                                                           |
| P7  | Re-bind workflow OS stage dispatch to V2 runs; keep human gates                                                      | P3                             | M          | M           | Absorbed Phase 5; do not revive the old branch                                                                            |
| P8  | Privacy redaction + Inspector/Control Center on V2 projections                                                       | P4–P6                          | M          | M           |                                                                                                                           |
| P9  | Execution-task contract: goal / redirect conditions / acceptance / **enforceable** brakes                            | P3–P5                          | L          | H           | Ordinary chat stays lightweight; explicit “no redirect condition” is valid; do not promise hard spend caps without a wrap |
| P10 | Regression pack: lease, ActionGate crash-window, MCP HTTP ASK, Manual no-failover, Hybrid offline eval               | P3–P9                          | L          | M           | Fake providers; no paid calls                                                                                             |

### Test requirements

- Re-run Base3 lease tests against V2 terminals, including interrupt that does
  **not** confirm stop.
- Re-run ActionGate consume/replay/successor ASK through V2 MCP `delegate_task`
  and `t3_thread_send`, not only preview tools.
- Prove Manual bind cannot be changed by queue steer, limit-resume, or child
  delegate.
- Prove dispatcher-off still cannot silently Auto-switch if product requires
  bind (decide whether V2 trial forces `T3CODE_DISPATCHER_ENABLED=true`).
- Workflow stage + human gate on a V2 run.
- Client protocol mismatch still 426.
- **No** production userdata. **No** paid provider calls in Task 3 unless an
  approved model list and budget exist (they do not, per Task 4).

### Data compatibility

- Upstream copy `state.sqlite` → `statev2.sqlite` imports shells + lazy
  user/assistant text. It does **not** migrate Base3 `projection_dispatcher_task_routes`,
  `projection_task_handoffs`, `projection_workflow_*`, `action_gate_*`,
  `dream_*`, `router_*`, `concurrency_budget_audit`, or `cursor_cloud_*`.
- After copy, V2 and V1 diverge; later V1 writes never appear in V2.
- Backup: copy the whole synthetic home (sqlite + wal/shm if any) before
  trial. Restore: replace the directory; do not start a server against the
  backup. There is no schema downgrade.
- Live `~/.t3/userdata` must not be opened read-write by the trial.

### Reversible trial plan

1. New branch, not PR #16. Synthetic `T3CODE_HOME`.
2. Boot V2-based tree with Base3 wraps behind a flag; empty DB.
3. Seed **synthetic** threads only.
4. Exercise the bypass matrix (delegate, schedule, limit-resume, queue resume,
   MCP send) and show either bind+gate+lease or a hard deny.
5. Snapshot the synthetic DB; restore onto a second home; prove the backup
   opens read-only.
6. If wraps fail, abandon the branch. V1 stabilization remains authoritative.

## Decisions needed before implementation

1. Accept B (policy-on-V2) vs stay on V1 for Internal Beta only.
2. Pin SHA: nightly `8ed276c24` vs a reviewed later `upstream/main` commit
   (interrupt/delegate/MCP fixes exist after the tag).
3. Force `T3CODE_DISPATCHER_ENABLED` on the V2 trial, or re-specify ungoverned
   chat.
4. Is `delegate_task` allowed at all, and if so only after bind+ActionGate+lease?
5. Are schedules and usage-limit auto-resume allowed, or must they deny until
   wraps exist?
6. Cursor Cloud: wrap as a V2 provider, keep as a side runner, or freeze?
7. Mobile: V2 beta clients only, or delay mobile until clients exist?
8. Workflow OS: rebind to V2 now, or leave catalog read-only during trial?
9. Execution-task brakes: which are actually enforceable (lease, ActionGate,
   Manual bind) vs documentation-only (spend caps)?
10. Migration ledger name and backup operator steps before any real-data talk.

## Later upstream fixes (not the comparison base)

`upstream/main` was `06e627448` (144 commits after the nightly). Orchestrator-
related samples, for pin-vs-later discussion only:

- `5108c978b` restarts keep delegated tasks, queued threads, and stops intact
- `ce90eec1f` Claude stop shows as interrupted
- `44bd4c9ca` Codex resume archived native sessions
- `06e627448` T3 MCP tools take explicit thread and project targets
- `efecd3cf8` / `5bf19d12b` Claude background / stuck-thread fixes
- `18b21325c` PR watch wakes agents (another auto-dispatch path)
- `88744f3dd` restore earlier app agent transcript pages

Do not silently retarget the trial at moving main.

## Task 3 and Task 4 handoff

**Task 3 — do not start until this audit is reviewed.** On a separate branch,
execute the selected plan (recommended: B). Preserve policy enforcement and
regression evidence. Then implement the execution-task contract: goal /
redirect conditions / acceptance / brakes. Ordinary chat remains lightweight.
Explicit “no redirect condition” is valid. Audit which brakes are actually
enforceable; do not promise hard spending caps without enforcement.

**Task 4 — do not start yet.** Bounded real-task pilot for Hybrid Router
evaluation: task class, harness, model, success evidence, rework, latency,
known/estimated/unknown cost. Keep challenger promotion manual. Use reviewed
acceptance criteria and held-out evaluation before claiming improvement. Live
or paid calls require an explicitly approved provider/model list and budget.
The previously proposed smoke plan is not authorization.

## Surfaces checklist (this audit)

- **Entry points:** WS dispatch, MCP HTTP, Cursor Cloud, workflow stage, PCR
  resume/compaction. V2 adds schedules, limit-resume, outbox, delegate, queue
  resume.
- **Clients:** protocol 1 vs 2 hard gate on web, desktop wrap, and mobile.
- **Providers:** per-adapter interrupt ≠ stop; Cursor ACP vs SDK; Pi / ACP
  Registry / OpenCode 2 absent here.
- **Contracts:** V1 vs V2 schema packages; Base3 dispatcher/ActionGate/Dream
  contracts have no V2 dual.
- **Reverse states:** V2 interrupt request vs result; Base3 successor ASK;
  workflow human gates. Auto-resume needs a way out (snooze/disable).
- **Connection modes:** not re-tested here; protocol mismatch fails before
  RPC on V2.
- **Docs:** this page; do not treat nightly release notes as capability proof.

## Uncertainties (explicit)

- Whether every non-PCR spawn on today’s V1 spine already admits through
  ConcurrencyBudget (Cloud outbox vs PCR vs MCP are confirmed; other adapters
  were not exhaustively runtime-traced).
- Production deployments’ actual `T3CODE_DISPATCHER_ENABLED` value vs tree
  default `false`.
- Live-provider interrupt→terminal behavior per adapter; tests use fakes.
- Long-term V2 event-log retention (wire truncation exists; no productized
  TTL found).
- Whether later `upstream/main` interrupt hardening closed the TODO at
  `Orchestrator.ts` ~7993; this audit did not treat that as the pin.

Cursor Grok 4.6 / Cursor Cloud (documentation-only audit).
