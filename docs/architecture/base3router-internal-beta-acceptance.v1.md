# Internal Beta acceptance manifest v1

Versioned mapping from requirement IDs to reviewed tests. This file is
documentation. It is not a shell runner. Do not extract or execute
commands from untrusted Markdown.

Local verification is separate from live-provider and native release
gates. Skipped checks, older-tree executions, and fixture-only UI Lab
scenarios cannot establish readiness for a later SHA.

Statuses: `PASS`, `FAIL`, `NOT_RUN`, `BLOCKED`.

## Environment

- Disposable SQLite (`:memory:` or temp `t3-router-test-*`)
- Fake provider/MCP transports only
- No `~/.t3/userdata`
- No paid provider calls

## Requirements

| ID  | Requirement                                                | Reviewed tests / assertions                                                                       | Local result                                                          |
| --- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| R1  | Auto/Manual bind + failover provenance                     | `Dispatcher.test.ts`, `ProviderCommandReactor.test.ts`, `ProviderRuntimeIngestion.test.ts`        | PASS (unit/reactor). WS router layer still `layerTest`. Live: NOT_RUN |
| R2  | ASK grant once; deny/cancel/expiry zero exec               | `ActionGateService.test.ts` grant/deny/expire/cancel; WS `ActionGate RPCs read SQLite governance` | PASS                                                                  |
| R3  | Replay and changed args cannot reuse authorization         | `ActionGateService.test.ts` replay + changed arguments                                            | PASS                                                                  |
| R4  | Memory save/list/correct/delete through auth               | `server.test.ts` Dream Memory RPCs persist…                                                       | PASS                                                                  |
| R5  | Memory off projected; explicit save remains                | `DreamMemoryService.test.ts` disabled; `server.test.ts` Dream Memory off…                         | PASS                                                                  |
| R6  | Concurrency queue, cancel, timeout, lease span             | `concurrencyBudget.test.ts`, `ConcurrencyBudgetService.test.ts`                                   | PASS                                                                  |
| R7  | Inspector persists settled admission                       | `ProviderCommandReactor.ts` persist after `admit`; UI Lab Inspector scenarios                     | PASS (server persist). Browser production: NOT_RUN                    |
| R8  | RPC operate-scope negatives                                | `RpcAuthorization.test.ts`; WS memory save + ActionGate respond                                   | PASS                                                                  |
| R9  | Migrations 063 conflict fails; 064/065 upgrade; fresh init | `063_ActionGateApprovalUniqueness.test.ts`, `064_DreamMemory.test.ts`                             | PASS                                                                  |
| R10 | Crash before dispatch leaves pending approval              | `ActionGateService.test.ts` durable pending without waiter                                        | PASS                                                                  |
| R11 | Crash after consume does not auto-replay                   | `does not auto-replay after a side effect when the handler crashes before persist`                | PASS                                                                  |
| R12 | Unknown external outcome is not retried                    | consume is one-time; fake write + interrupt; no second write                                      | PASS (policy). Distributed exactly-once: NOT implemented              |
| R13 | UI Lab visual fixtures                                     | `node scripts/base3router-ui-lab.ts` 149 passed                                                   | PASS (fixtures, not live RPC)                                         |
| R14 | Live providers                                             | prepared checklist in readiness doc                                                               | BLOCKED                                                               |
| R15 | Native install/signing                                     | readiness doc                                                                                     | BLOCKED                                                               |
| R16 | Cancel/deny/expire successor ASK; consumed stays dead      | `cancel requires a successor ASK`; resurrection test                                              | PASS                                                                  |
| R17 | Follow-up experiments documented, not implemented          | `docs/architecture/base3router-follow-up-experiments.md`                                          | PASS (docs only)                                                      |

## Execution record

Fill at verification time for the SHA under test. Older-tree results
do not carry forward.

- SHA: `34e5a146b` (crash/replay implementation); PR head after this docs commit
- Environment: disposable SQLite; fake transports; Node 24 via nvm
- Command set: `vp test run` on the files named above; UI Lab script
- Evidence: this table plus `docs/architecture/base3router-internal-beta-readiness.md`
