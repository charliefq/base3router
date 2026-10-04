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

| Capability                                    | Production entry                                         | Server handler / service                                                | Persistence / execution           | Actual test coverage                                                                  | Known limitation                                       | Status                                       |
| --------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------- |
| Auto / Manual bind + failover provenance      | Composer route mode → `dispatchCommand`                  | `ProviderCommandReactor`, `Dispatcher`, `RouterEvaluationService.layer` | SQLite route bindings             | Dispatcher Auto/Manual; WS lists candidate policies from production evaluation        | Live paid-provider failover is NOT RUN                 | VERIFIED (unit/WS). Live: NOT RUN            |
| ActionGate ASK grant / deny / cancel / expiry | MCP tool call + Inspector approve                        | `ActionGateService`, `McpActionAuthorization`                           | SQLite approvals                  | Production MCP ASK tests; WS grant path; existing snapshot tests keep `layerTest`     | Distributed exactly-once is not implemented            | VERIFIED (production ActionGate + MCP)       |
| Approval refresh / replay                     | Reconnect reads governance; execute consumes fingerprint | `consume` / `waitForAuthorized`; explicit `retry: true`                 | SQLite uniqueness (063)           | Transport replay does not create successors; explicit retry does; consumed stays dead | In-memory waiters do not survive restart               | VERIFIED                                     |
| Dream Memory lifecycle                        | Settings, memory RPCs, turn retrieval                    | `DreamMemoryService`, `ws.ts` memory.*                                  | SQLite memories + deleted sources | WS save/list/correct/delete; file-backed delete/invalidation restart                  | Turn-retrieval capsule is service-level                | VERIFIED (WS + file restart)                 |
| Memory off                                    | Settings → Dream Memory                                  | `enqueueEligibleTurn`, WS governance                                    | settings.json / test mock         | WS projects `off`; explicit save remains                                              | Production settings file is mocked in WS harness       | VERIFIED                                     |
| Concurrency capacity                          | Turn start, MCP, Dream, Shadow                           | `sendTurnUntilTerminal`, `ConcurrencyBudgetService`                     | Process-local leases              | Lease until terminal; mixed FG/BG measurement; WS sendTurn hold/queue/cancel          | Distributed limits unimplemented                       | VERIFIED (terminal lease)                    |
| Inspector / Control Center                    | Chat inspector; Control Center                           | presenters consume WS snapshots                                         | Server projections                | WS RPCs return production ActionGate/memory/concurrency/router state                  | UI Lab fixtures do not certify this                    | VERIFIED (RPC). Native browser host: NOT RUN |
| RPC authorization                             | WS methods                                               | `RpcAuthorization.ts`                                                   | Session scopes                    | Operate-scope negatives                                                               | Device list operate already covered                    | VERIFIED                                     |
| Migrations / recovery                         | Server startup `runMigrations`                           | `Migrations.ts` 062–065                                                 | Disposable file-backed SQLite     | Restart, backup restore, 063 fail-closed with intact rows                             | Never `~/.t3/userdata`. Do not merge live fingerprints | VERIFIED (disposable file DBs)               |

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
| S13 | Medium   | ActionGate retry    | Cancelled/denied/expired ASK reused the same approval id, so later exact-action retry conflicted.                                   | Fixed: successor only on explicit `retry: true`; consumed stays dead.                         |
| O1  | Closed   | WS Auto/Manual      | `buildAppUnderTest` now uses `RouterEvaluationService.layer`.                                                                       | WS Internal Beta lists candidate policies. Live failover still NOT RUN.                       |
| O2  | Closed   | MCP HTTP ASK        | Production ActionGate ASK tests; existing snapshot suite keeps `layerTest` so auto-ALLOW tools do not hang.                         | WS grant path covered in Internal Beta MCP test.                                              |
| O3  | Open     | Live providers      | Paid network calls unauthorized.                                                                                                    | NOT RUN / BLOCKED ON USER AUTHORIZATION                                                       |
| O4  | Open     | Native / signing    | Installers, notarization, upgrades.                                                                                                 | NOT RUN / BLOCKED ON USER AUTHORIZATION                                                       |
| O5  | Partial  | Browser UI          | Production Inspector/CC state is certified via the WS RPCs those surfaces consume. UI Lab remains fixture-only.                     | Native production-browser host walkthrough still NOT RUN.                                     |
| O6  | Closed   | sendTurn saturation | Foreground lease waits for terminal events; WS Internal Beta holds capacity until complete and cancels queued work.                 | Live adapter occupancy still NOT RUN.                                                         |

## Concurrency lifetime

- Base3Router-controlled work: foreground `sendTurn` Effect, MCP handler after ActionGate ALLOW, Dream jobs, Shadow `forkDetach`, failover-retry `runWithBudget`.
- Provider-native subagents: observed only; T3 cannot intercept a provider-internal spawn.
- Process-local limits: in-memory scheduler per environment id in this process.
- Distributed limits: not implemented.
- Foreground lease covers active execution until `turn.completed`, `turn.aborted`, or the 10-minute terminal timeout. Start-return adapters no longer release at `sendTurn` return.
- Bounded wait for non-sheddable queued work: class `maxQueueTimeMs` (30s foreground). Aging cannot promote Dream over foreground. That is not starvation-freedom.

## Memory privacy

- Cross-project reads/mutations fail when the viewer is project-bound.
- Environment-local pairing may list/retrieve project records in that environment.
- Deleted content is omitted from list/export/audit payloads (`contentPresent: false`).
- Dispatch point of no recall: after `providerService.sendTurn` has been invoked for that attempt.

## Migration and recovery

- Tested on disposable `:memory:` and file-backed temp databases.
- Duplicate live ActionGate fingerprints: migration 063 fails rather than merging. The failed transaction leaves prior rows and schema intact. Operator path: inspect both live rows, move the unintended one to a terminal status, retry; or restore a compatible backup taken before the upgrade.
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
