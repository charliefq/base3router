# Internal Beta acceptance manifest v1

Versioned mapping from requirement IDs to reviewed tests. This file is documentation. The executable mapping is
`scripts/internal-beta-acceptance-lib.ts`. Run
`node scripts/internal-beta-acceptance.ts run` after checkout to produce
SHA-bound evidence. Do not extract or execute commands from this Markdown.

Local verification is separate from live-provider and native release
gates. Skipped checks, older-tree executions, and fixture-only UI Lab
scenarios cannot establish readiness for a later SHA. The runner refuses
`LOCAL_STABILIZATION_VERIFIED` unless every required local gate is `PASS`
for the current SHA.

Statuses: `PASS`, `FAIL`, `NOT_RUN`, `BLOCKED`.

## Environment

- Disposable SQLite (`:memory:` or temp `t3-router-test-*`)
- Fake provider/MCP transports only
- No `~/.t3/userdata`
- No paid provider calls

## Requirements

The executable ID → command map is `scripts/internal-beta-acceptance-lib.ts`.
This table is the readable index.

| ID  | Requirement                                        | Reviewed tests                                                                          | Local gate                                          |
| --- | -------------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------- |
| R1  | Auto/Manual bind + sendTurn + failover provenance  | Dispatcher bind; PCR Auto/Manual sendTurn to fake models; WS policy list                | `L-auto-manual`, `L-ws-production`                  |
| R2  | ASK grant once; deny/cancel/expiry zero exec       | `ActionGateService.test.ts`, `McpHttpServer.productionAsk.test.ts`                      | `L-successor-ask`, `L-mcp-ask`                      |
| R3  | Replay and changed args cannot reuse authorization | `ActionGateService.test.ts`; MCP post-queue revalidation                                | `L-successor-ask`, `L-mcp-ask`                      |
| R4  | Memory save/list/correct/delete through auth       | `server.test.ts` Dream Memory RPCs; production browser Settings                         | `L-ws-production`, `L-production-browser`           |
| R5  | Memory off projected; explicit save remains        | `DreamMemoryService.test.ts`; WS off projection; production browser toggle              | `L-ws-production`, `L-production-browser`           |
| R6  | Concurrency queue, cancel, timeout, lease span     | Terminal wait + interrupt-on-timeout; scheduler occupancy; sustained fake-provider load | `L-lease-terminal`, `L-workload`, `L-ws-production` |
| R7  | Inspector / Control Center receive real state      | WS governance RPCs; production Playwright against real RPC                              | `L-ws-production`, `L-production-browser`           |
| R8  | RPC operate-scope negatives                        | `RpcAuthorization.test.ts`; WS operate-scope tests                                      | existing CI server tests                            |
| R9  | Migrations 063 fail-closed; upgrade; restore       | `063_ActionGateApprovalUniqueness.test.ts`, `SqliteRecovery.test.ts`                    | `L-recovery`                                        |
| R10 | Pending approval across process restart            | `SqliteRecovery.test.ts`                                                                | `L-recovery`                                        |
| R11 | Crash after fake write does not auto-replay        | `SqliteRecovery.test.ts`; in-memory crash-after-write                                   | `L-recovery`                                        |
| R12 | Unknown external outcome is not retried            | consume is one-time; consumed+retry stays dead                                          | `L-successor-ask`                                   |
| R13 | UI Lab visual fixtures                             | `scripts/base3router-ui-lab.ts`                                                         | `L-ui-lab` (fixtures, not production RPC)           |
| R14 | Live providers                                     | readiness checklist                                                                     | `E-live-provider` BLOCKED                           |
| R15 | Native install/signing                             | readiness doc                                                                           | `E-native-signing` BLOCKED                          |
| R16 | Successor ASK is explicit; consumed stays dead     | `retry: true`; transport replay conflicts                                               | `L-successor-ask`                                   |
| R17 | Follow-up experiments documented, not implemented  | `docs/architecture/base3router-follow-up-experiments.md`                                | docs only                                           |

## Execution record

SHA-bound evidence is a CI artifact from
`node scripts/internal-beta-acceptance.ts run` after checkout. Do not
commit a report that names a future SHA. Older-tree results do not
carry forward.

- Evidence artifact: `internal-beta-acceptance-<sha>/evidence.json`
- Environment: disposable SQLite; fake transports; Node 24 via nvm
- This file is documentation. Do not execute commands copied from it.
