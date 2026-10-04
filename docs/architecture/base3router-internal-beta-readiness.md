# Base3Router Internal Beta readiness

Evidence-first audit of the integrated Phases 7–13 product. This is
stabilization, not Phase 14. Previous acceptance reports, UI Lab
fixtures, and schema definitions are not treated as proof of runtime
enforcement.

Generic pairing identity: one trusted local principal per environment
(`environment-local` unless the session subject is a distinct identity).
It is not multi-user isolation.

Deletion is a logical tombstone. SQLite WAL/backups and provider-side
copies are not forensically erased. An already-dispatched provider
request cannot be recalled after `sendTurn` returns.

## Capability map

| Capability                                    | Production entry                                         | Server handler / service                                                     | Persistence / execution                                 | Actual test coverage                                                                                                                                                                                                                                     | Known limitation                                                                                                                                        | Status                                                                          |
| --------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Auto / Manual bind + failover provenance      | Composer route mode → `dispatchCommand`                  | `ProviderCommandReactor`, `Dispatcher`                                       | SQLite route bindings; fake provider in tests           | Reactor/unit: `Dispatcher.test.ts`, `ProviderCommandReactor.test.ts`, `ProviderRuntimeIngestion.test.ts`. WS Auto/Manual bind through `buildAppUnderTest` still uses `RouterEvaluationService.layerTest`. UI Lab fixtures are not runtime proof.         | Live paid-provider failover is NOT RUN.                                                                                                                 | VERIFIED (unit/reactor). WS router evaluation stubbed. Live: NOT RUN            |
| ActionGate ASK grant / deny / cancel / expiry | MCP tool call + Control Center / Inspector approve       | `ActionGateService`, `McpActionAuthorization`, `actionGateRespondApproval`   | SQLite `action_gate_approvals` / audit                  | Service: grant once, deny/cancel/expiry zero-exec, replay, changed args, consume uses current time. WS: governance + missing respond + operate-scope. MCP HTTP still uses `layerTest` in its own suite.                                                  | Full MCP→WS grant journey in one process is not wired through `server.test.ts`.                                                                         | VERIFIED (service + WS auth/persistence). MCP HTTP ASK: NOT RUN in this harness |
| Approval refresh / replay                     | Reconnect reads governance; execute consumes fingerprint | `ActionGateService.consume` / `waitForAuthorized`                            | SQLite uniqueness indexes (063)                         | Service replay/changed-args. Uniqueness migration refuses duplicate live fingerprints. WS reconnect of a live pending approval is not exercised.                                                                                                         | Pending approvals survive process restart via SQLite; in-memory waiters do not.                                                                         | VERIFIED (service + migration). WS reconnect: NOT RUN                           |
| Dream Memory lifecycle                        | Settings, memory RPCs, turn retrieval                    | `DreamMemoryService`, `ws.ts` memory.\*, `persistTurnOutcome`                | SQLite `dream_memories`, `dream_deleted_sources`, audit | WS save/list/correct/delete/governance. Service proposal/approve, source invalidation, off disables Dream. Retrieval capsule is service-level. Process restart of a disposable DB after delete is the same SQLite file in-process, not a second process. | Proposal enqueue needs a successful turn + extractor; WS does not drive a full turn.                                                                    | VERIFIED (WS mutations + service lifecycle). Turn-retrieval WS: NOT RUN         |
| Memory off                                    | Settings → Dream Memory                                  | `serverUpdateSettings`, `retrieveMemories`, `enqueueEligibleTurn`            | `settings.json` in production; test mock/Ref            | Service: off → no extractor. WS: governance projects `enabled: false` / `captureMode: "off"`; explicit save still works.                                                                                                                                 | Production settings persistence not re-tested here (mocked in `buildAppUnderTest`).                                                                     | VERIFIED (service + WS projection)                                              |
| Concurrency capacity                          | Turn start, MCP, Dream, Shadow                           | `ConcurrencyScheduler`, `ConcurrencyBudgetService`, `ProviderCommandReactor` | Process-local in-memory leases; audit table 065         | Scheduler queue/cancel/aging/timeout. Service lease until forked work ends. Interrupt cancels queued admissions. WS governance topology. Saturating `sendTurn` via RPC is not in this harness (default cap 4, mocked orchestration).                     | Distributed limits unimplemented. Execution-tree not carried on live spawn paths. Foreground lease = `sendTurn` span.                                   | VERIFIED (scheduler/service). WS saturation via sendTurn: NOT RUN               |
| Inspector / Control Center                    | Chat inspector; Control Center page                      | `presentOperationalInspector`, `ControlCenterPage` queries RPCs              | Server projections / live snapshots                     | Control Center client queries real RPCs. Inspector concurrency now persists settled admission (not hardcoded `admitted`/`queuedMs: 0`). UI Lab remains fixture-only by design.                                                                           | Inspector does not show in-flight queued; Control Center snapshot does. Browser pass NOT RUN.                                                           | VERIFIED (server persist + RPC). Browser: NOT RUN                               |
| RPC authorization                             | WS methods                                               | `RpcAuthorization.ts`                                                        | Session scopes                                          | Scope map completeness test. WS negatives: router operate, memory save, ActionGate respond.                                                                                                                                                              | Device list operate already covered.                                                                                                                    | VERIFIED                                                                        |
| Migrations / recovery                         | Server startup `runMigrations`                           | `Migrations.ts` 062–065                                                      | Disposable `:memory:` SQLite only                       | Fresh init; 61→65 upgrade; 063 duplicate fingerprint fails rather than merging; malformed optional memory row does not block the table.                                                                                                                  | No schema downgrade. Restore a compatible backup; do not run an older binary on a newer DB. Backup/restore of user `~/.t3` is unauthorized and NOT RUN. | VERIFIED (disposable DBs)                                                       |

## Findings

| ID  | Severity | Boundary            | Behavior                                                                                                                            | Status                                                                                        |
| --- | -------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| S1  | High     | Dream Memory RPC    | `decide` / `correct` / `delete` omitted `projectId` on the viewer, so `requireReadable` 403'd environment-local project memory.     | Fixed: missing viewer `projectId` is env-scoped lookup; list/retrieve match.                  |
| S2  | High     | Dream Memory list   | `list` ignored `filter.threadId` and hid project rows unless `viewer.projectId` was set.                                            | Fixed.                                                                                        |
| S3  | Medium   | Dream enqueue       | `persistTurnOutcome` used `viewerFromSubject(env, undefined)` without `projectId`.                                                  | Fixed: ingestion passes `thread.projectId`.                                                   |
| S4  | Medium   | Source invalidation | `invalidateSourceThread` did not write `dream_deleted_sources`.                                                                     | Fixed.                                                                                        |
| S5  | Medium   | Concurrency tree    | `treeFor` committed counts on queue then again on drain.                                                                            | Fixed: preview without commit; drain commits.                                                 |
| S6  | Medium   | Interrupt           | Turn interrupt did not cancel queued admissions.                                                                                    | Fixed: `cancelQueuedForThread`.                                                               |
| S7  | Medium   | ActionGate          | `waitForAuthorized` consumed with the waiter’s stale `nowIso`.                                                                      | Fixed: consume uses `DateTime.now`.                                                           |
| S8  | Medium   | Inspector           | Foreground concurrency trace was hardcoded `admitted` / `queuedMs: 0` before admission settled.                                     | Fixed: persist settled admission (or rejection). In-flight queue remains Control Center-only. |
| S9  | Low      | Docs                | User copy implied prompt-injection immunity from keyword text. Architecture overstated execution-tree carry and starvation-freedom. | Fixed in `docs/user/dream-memory.md` and `base3router-phase-13.md`.                           |
| S10 | Info     | Topology            | No distributed concurrency. Provider-native subagents are not individually enforced.                                                | Documented; not advertised as implemented.                                                    |
| S11 | Info     | Deletion            | Logical tombstone only.                                                                                                             | Documented.                                                                                   |
| S12 | Info     | Pairing             | One trusted local principal.                                                                                                        | Documented.                                                                                   |
| S13 | Medium   | ActionGate retry    | Cancelled/denied/expired ASK reused the same approval id and idempotency key, so a later exact-action retry conflicted.             | Fixed: successor pending row with new ids; consumed still conflicts.                          |
| O1  | Open     | WS Auto/Manual      | `RouterEvaluationService.layerTest` still stubbed in `buildAppUnderTest`.                                                           | Open; covered at reactor/unit.                                                                |
| O2  | Open     | MCP HTTP ASK        | `McpHttpServer.test.ts` still uses ActionGate `layerTest`.                                                                          | Open; ActionGate service + WS respond covered.                                                |
| O3  | Open     | Live providers      | Paid network calls unauthorized.                                                                                                    | NOT RUN / BLOCKED ON USER AUTHORIZATION                                                       |
| O4  | Open     | Native / signing    | Installers, notarization, upgrades.                                                                                                 | NOT RUN / BLOCKED ON USER AUTHORIZATION                                                       |
| O5  | Open     | Browser UI          | AGENTS.md: no computer use unless requested.                                                                                        | NOT RUN                                                                                       |
| O6  | Open     | sendTurn saturation | Default policy cap 4; orchestration in `server.test.ts` is mocked. Scheduler proves queue/timeout.                                  | Open as WS journey                                                                            |

## Concurrency lifetime

- Base3Router-controlled work: foreground `sendTurn` Effect, MCP handler after ActionGate ALLOW, Dream jobs, Shadow `forkDetach`, failover-retry `runWithBudget`.
- Provider-native subagents: observed only; T3 cannot intercept a provider-internal spawn.
- Process-local limits: in-memory scheduler per environment id in this process.
- Distributed limits: not implemented.
- Foreground lease covers `sendTurn` until that Effect completes. Adapters that return when the stream starts release before the turn is terminal.
- Bounded wait for non-sheddable queued work: class `maxQueueTimeMs` (30s foreground). Aging cannot promote Dream over foreground. That is not starvation-freedom.

## Memory privacy

- Cross-project reads/mutations fail when the viewer is project-bound.
- Environment-local pairing may list/retrieve project records in that environment.
- Deleted content is omitted from list/export/audit payloads (`contentPresent: false`).
- Dispatch point of no recall: after `providerService.sendTurn` has been invoked for that attempt.

## Migration and recovery

- Tested only on disposable `:memory:` databases.
- Duplicate live ActionGate fingerprints: migration 063 fails rather than merging.
- Schema downgrade is unsafe. Restore a backup taken with a compatible schema.
- Never tested against `~/.t3/userdata`.

## Monetization (not implemented)

- Monetize orchestration, optimization, and governance only.
- Baseline safety, privacy, and deletion remain available.
- Costs are known, estimated, or unknown — never hidden.
- Packaging ideas are not entitlements. Billing is out of scope.

## Live-provider smoke checklist (prepared, not executed)

Do not run without explicit authorization and a spending cap.

1. Providers: one of Codex, Claude Code, Cursor, using existing local CLI credentials.
2. Calls: one Manual turn; one Auto turn with a forced failover (invalid model then valid); one ASK MCP tool grant; one deny.
3. Data: a disposable git worktree and synthetic prompt text only. No user production DBs.
4. Spending cap: operator-set; abort if usage exceeds the cap.
5. Assert: bound model, provenance, one grant execution, zero deny execution, Inspector shows server traces.

## Native / signing (NOT RUN)

Installer, code signing, notarization, OS upgrade, and mobile store checks remain BLOCKED ON USER AUTHORIZATION.

## Copy review

Unsupported claims removed or hedged: prompt-injection immunity, forensic deletion, starvation-freedom, multi-user isolation, native subagent limits, advertised savings. Model-selection remains policy/heuristic, not claimed intelligence.

## Crash / replay

Durable ActionGate state is SQLite. In-memory waiters are not. Unknown outcomes default to no automatic replay.

| Window                                          | Behavior                                                                                                                        | Test                                                                               |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Before dispatch                                 | Pending row remains without a waiter; later grant consumes once                                                                 | `durable pending approvals grant once after waiters disappear`                     |
| Interrupted wait                                | Fiber interrupt does not consume. Last-waiter cancel is best-effort `onInterrupt`; pending can remain if the wait never started | `interrupting a waiter never consumes or auto-executes`                            |
| Cancelled ASK                                   | Cancelled/denied/expired fingerprints can open a **new** pending ASK. Consumed fingerprints cannot be resurrected               | `cancel requires a successor ASK`; `does not resurrect consumed approvals`         |
| After consume, handler crash after a fake write | External write count stays 1; persist flag stays false; replay is blocked                                                       | `does not auto-replay after a side effect when the handler crashes before persist` |

Consume is one-time authorization, not an exactly-once log of the external tool. Recheck at resume: fingerprint, expiry via `DateTime.now`, and current approval status.

## Follow-up experiments (not implemented)

See `docs/architecture/base3router-follow-up-experiments.md`. RoutingAdvisor, ActionRiskAdvisor, and Context workspace are design notes only.

## Acceptance manifest

Versioned requirement IDs: `docs/architecture/base3router-internal-beta-acceptance.v1.md`. That file is not a shell runner.
