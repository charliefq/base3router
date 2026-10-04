# Base3Router Phase 13: Dream Memory, Provenance, and Concurrency Budgets

Stacked on `main` after Phase 12 (PR #14 merge
`4c425d06623a4ca4638d8dfe817248b8bfaabc4b`). This note freezes the Phase 13
boundary. It records the audit of conversation persistence, identity,
Phase 11 evidence, Phase 12 ActionGate audit, spawn/cancellation paths,
and Control Center / Inspector projections. It does not restate Phase 8
model routing, Phase 10 Teacher/Shadow, Phase 11 Hybrid evaluation, or
Phase 12 Skill/MCP/ActionGate that contracts and tests already encode.

Starting branch: `cursor/phase-13-dream-memory-concurrency-budgets`.

Working title: **Dream Memory, Provenance, and Code-Enforced Agent
Concurrency Budgets**.

This is the final currently planned architecture phase. It does not
expand into billing, marketplace, production release packaging, or
unrelated redesign.

Two subsystems ship together but remain distinct:

```text
Dream Memory V0          Concurrency Budget V0
  capture / propose        admit / queue / lease
  persist / retrieve       fan-out / recursion
  correct / delete         cancel / cleanup
  capsule into context     never substitutes for ActionGate
```

They may share IDs, sanitized audit, observability, and UI projections.
Memory is never authority. Admission is never authorization.

## Goals

Ship the first production-safe version of:

- typed, versioned, scoped durable memory with explicit provenance
- explicit user save and a bounded background Dream lifecycle
- opt-in capture policy (`off` / `review` / `automatic`)
- inspectable, correctable, deletable, exportable memory
- safe retrieval into a delimited untrusted memory capsule
- code-enforced concurrency budgets at every relevant spawn path
- server-owned admission, queueing, leases, cancellation, and cleanup
- bounded child-agent fan-out and recursion
- Inspector and Control Center projections
- UI Lab, CI, and deterministic stress tests
- a documented monetization boundary (not implemented)

## Non-goals (release / later)

- billing, checkout, subscriptions, or payment processing
- public plugin/skill marketplace
- automatic production credential migration
- signed installers
- mobile redesign
- foundation-model training
- vector database deployment (none exists; V0 uses deterministic
  lexical retrieval)
- hidden behavioral profiling
- unrestricted autonomous self-modification
- automatic use of memory as authorization
- cross-tenant learning
- broad Phase 8–12 rewrites
- unrelated UI redesign
- installing or enabling plugins (the USC account prohibits plugins)

## Names that must not collapse

| Name                            | What it is                                     | Authority                                      |
| ------------------------------- | ---------------------------------------------- | ---------------------------------------------- |
| **Dream Memory**                | Durable, scoped, inspectable memory records    | Base3Router `dream-memory.v0`                  |
| **Ephemeral conversation**      | Thread messages and composer context           | Orchestration event store + projections        |
| **Phase 11 routing evidence**   | Turn outcome observations and Hybrid policy    | `router_turn_observations` / `router_policies` |
| **ActionGate audit**            | Phase 12 side-effect authorization history     | `action_gate_audit`                            |
| **Memory capsule**              | Delimited untrusted reference data in a turn   | Retrieval assembler; never system instructions |
| **Concurrency Budget**          | Admission, queue, lease, fan-out limits        | Base3Router `concurrency-budget.v0`            |
| **Dispatcher route ActionGate** | Whether the routed turn may start              | Dispatcher `ALLOW`/`DENY`                      |
| **Independent ActionGate**      | Whether each side-effecting action may execute | Phase 12 `action-gate.v0`                      |
| **OpenRouter Shadow**           | Phase 10 non-blocking observation              | Phase 10 policy + concurrency class            |
| **Hybrid Router V1**            | Phase 11 local evidence ranking                | Phase 11 policy                                |

Memory content cannot grant permissions, change ActionGate policy, or
override system instructions. Concurrency admission cannot substitute
for ActionGate. Memory cannot substitute for routing evidence.

## Audit matrix

| Capability                                           | Exists | Partial | Missing | Relevant files                                                              | Phase     |
| ---------------------------------------------------- | ------ | ------- | ------- | --------------------------------------------------------------------------- | --------- |
| Thread/message event store + projections             | x      |         |         | `orchestration_events`, `projection_thread_messages`                        | inherited |
| Provider `/compact` and Claude auto-compact          | x      |         |         | `ProviderRuntimeIngestion.ts`, `claudeCompaction.ts`                        | inherited |
| App-owned durable memory                             |        |         | x       | —                                                                           | 13        |
| Typed memory provenance / confidence / freshness     |        |         | x       | —                                                                           | 13        |
| Explicit “remember this” save                        |        |         | x       | —                                                                           | 13        |
| Background Dream proposal/consolidation              |        |         | x       | —                                                                           | 13        |
| Capture modes off/review/automatic                   |        |         | x       | —                                                                           | 13        |
| Memory retrieval capsule                             |        |         | x       | —                                                                           | 13        |
| Correction / supersession / contradiction            |        |         | x       | —                                                                           | 13        |
| Content-removing deletion + no resurrection          |        |         | x       | —                                                                           | 13        |
| Environment / project / thread branded IDs           | x      |         |         | `packages/contracts/src/baseSchemas.ts`                                     | inherited |
| Product `UserId` brand                               |        |         | x       | Auth uses `subject`; V0 actor id is derived, not invented as a login system | 13 (V0)   |
| Phase 11 observation store (separate)                | x      |         |         | `060_RouterEvaluationObservations.ts`                                       | 11        |
| Phase 12 ActionGate approvals + audit (separate)     | x      |         |         | `062_ActionGateApprovals.ts`                                                | 12        |
| Secret-shaped redaction helpers                      | x      |         |         | `actionAudit.ts`, `textOmitsCursorSecrets`, `sanitizeDisplayText`           | inherited |
| Foreground turn spawn (`sendTurn` forkScoped)        | x      |         |         | `ProviderCommandReactor.ts`                                                 | inherited |
| OpenRouter Shadow `forkDetach`                       | x      |         |         | `ProviderCommandReactor.ts`, `OpenRouterShadow.ts`                          | 10        |
| Model-router failover attempt budget (3)             | x      |         |         | `MODEL_ROUTER_ATTEMPT_BUDGET`                                               | 8         |
| MCP ActionGate authorize-then-execute                | x      |         |         | `McpActionAuthorization.ts`                                                 | 12        |
| MCP retry planner (not live execute)                 |        | x       |         | `mcpLifecycle.ts` used in tests only                                        | 12        |
| Provider-native subagents (Claude/Codex/Antigravity) |        | x       |         | Observed via runtime events; T3 does not spawn them                         | inherited |
| Global agent concurrency budget                      |        |         | x       | —                                                                           | 13        |
| Queue / lease / reserved foreground capacity         |        |         | x       | Workspace lease is per-cwd Sem(1), not an agent budget                      | 13        |
| Fan-out / recursion / descendant limits              |        |         | x       | —                                                                           | 13        |
| Shutdown cancel of detached shadow/failover          |        | x       |         | Scope interrupt; detached fibers are not budget-drained                     | 13        |
| Inspector Hybrid / Skill / MCP / ActionGate cards    | x      |         |         | `presentOperationalInspector.ts`                                            | 7–12      |
| Inspector memory / concurrency cards                 |        |         | x       | —                                                                           | 13        |
| Control Center Router Insights / Action governance   | x      |         |         | `presentControlCenter.ts`                                                   | 11–12     |
| Control Center memory / concurrency projections      |        |         | x       | —                                                                           | 13        |
| Settings for OpenRouter / Router evaluation          | x      |         |         | `settings.ts`                                                               | 10–11     |
| Dream Memory / concurrency policy settings           |        |         | x       | —                                                                           | 13        |
| SQLite migrations through 063                        | x      |         |         | `apps/server/src/persistence/Migrations.ts`                                 | inherited |
| Vector / embedding index                             |        |         | x       | None exists; V0 does not invent one                                         | never V0  |
| Plugins / marketplace                                |        |         | x       | USC account prohibits plugins                                               | never     |

## Reuse versus new modules

Reuse, do not replace:

- Orchestration event store and thread/message projections as the
  conversation source of truth. Do not copy messages into memory.
- Phase 11 `router_turn_observations` as routing evidence. Do not treat
  observations as memory.
- Phase 12 `action_gate_audit` as ActionGate provenance. Do not treat
  audit events as memory.
- `RuntimeMode`, Skill Router, MCP Router, and Independent ActionGate as
  authorization/planning. Memory never participates.
- Secret-shaped redaction (`redactSecretShapedText`,
  `textOmitsCursorSecrets`, `sanitizeDisplayText`).
- Inspector `OperationalStatusCard` and Control Center projection
  pattern.
- DrainableWorker / workspace lease as local serialization, not as the
  agent budget.
- Model-router attempt budget (3) as a nested attempt counter inside
  the execution tree, not a replacement for concurrency classes.
- Auth session `subject` as the only available actor hint. Do not invent
  a product-wide UserId login system.

New:

- `packages/contracts/src/dreamMemory.ts`
- `packages/contracts/src/concurrencyBudget.ts`
- `packages/shared/src/dreamMemory.ts`
- `packages/shared/src/concurrencyBudget.ts`
- `apps/server/src/dreamMemory/` persistence, Dream worker, RPC
- `apps/server/src/concurrencyBudget/` scheduler and spawn integration
- migrations `064_DreamMemory` and `065_ConcurrencyBudgetAudit`
- Inspector / Control Center presenters, settings, memory controls, UI Lab

## Trust boundaries

| Boundary                   | Who may cross it                      | What never crosses it                                    |
| -------------------------- | ------------------------------------- | -------------------------------------------------------- |
| Conversation messages      | Orchestration projections             | Silent promotion into personal memory                    |
| Durable memory store       | Dream Memory service                  | Authorization, ActionGate policy, system instructions    |
| Memory capsule             | Retrieval assembler → provider prompt | Undelimited instructions; hidden chain-of-thought        |
| Phase 11 observations      | Router evaluation service             | Memory records                                           |
| ActionGate audit           | ActionGate service                    | Memory content, deleted bodies                           |
| Concurrency scheduler      | Server process (in-memory V0)         | Client-owned counters                                    |
| Dream extractor            | Injectable interface; fake in CI      | Silent network when Dream is disabled                    |
| Inspector / Control Center | Sanitized structured records          | Raw private memory bodies, secrets, unrestricted prompts |
| Export                     | User-readable scoped records          | Other actors, other projects, deleted content            |

Memory is data, never authority. Stored text is untrusted even when a
model previously generated it. Prompt-injection-shaped content remains
data.

## Identity and scope

The product has branded `EnvironmentId`, `ProjectId`, `ThreadId`,
`MessageId`, `TurnId`, and `AuthSessionId`. It does not have a `UserId`
login system. Phase 13 introduces `MemoryActorId`, derived by the
server from the authenticated session subject when that subject is a
distinct identity, otherwise `environment-local` for this environment.

V0 personal memory is therefore environment-local unless a distinct
auth subject exists. Isolation tests still prove:

- project memory cannot leak to unrelated projects
- one actor cannot read another actor’s personal memory
- environment-local observations stay environment-scoped
- client-provided IDs are lookup inputs, not authority
- no cross-user aggregation
- no silent promotion from thread memory to personal memory

The server computes authoritative scope from the request context
(environment identity, project/thread ownership, session subject). A
client cannot claim another scope.

Keep these stores separate:

| Store                      | Location                                     |
| -------------------------- | -------------------------------------------- |
| Ephemeral conversation     | `orchestration_events` / message projections |
| Durable personal memory    | `dream_memories` (`scopeKind=personal`)      |
| Durable project memory     | `dream_memories` (`scopeKind=project`)       |
| Environment observation    | `dream_memories` (`scopeKind=environment`)   |
| Phase 11 routing evidence  | `router_turn_observations`                   |
| ActionGate / audit history | `action_gate_audit` + `dream_memory_audit`   |

Do not create a second source of truth for messages, routing evidence,
or ActionGate audit events.

## Capture modes and Dream lifecycle

Safe default: **`review`**.

| Mode        | Automatic capture                        | Retrieval of Dream output              | Explicit save |
| ----------- | ---------------------------------------- | -------------------------------------- | ------------- |
| `off`       | None. No Dream jobs. No Dream retrieval. | Disabled                               | **Allowed**   |
| `review`    | Dream may propose after eligible turns   | Proposals are not active until approve | Allowed       |
| `automatic` | Allowlisted low-risk kinds may activate  | Active allowlisted records only        | Allowed       |

Disabling Dream Memory (`enabled=false` or mode `off`) stops new
automatic capture, Dream background processing, and retrieval into
future turns. Explicit manual save remains available. UI copy states
this without dark patterns. Privacy and deletion controls are not
paywalled.

Eligible Dream sources: successfully completed turns only. Failed,
interrupted, and cancelled turns never become successful memory.

Automatic activation allowlist (low-risk only):

- `explicit-user-preference`
- `workflow-convention`

Never auto-activate: `user-confirmed-fact`, `project-decision`,
`project-constraint`, `unresolved-proposal`, `correction`, anything
with sensitivity `sensitive` or `secret-rejected`, or claims that are
financial, medical, legal, security, authorization, credential-shaped,
or ambiguous.

Provider-assisted extraction is behind `DreamExtractor`. CI and UI Lab
use fakes only. No silent network call when Dream is disabled.
Provider cost/usage is visible when known; unknown stays unknown.

The Dream worker may deduplicate, propose, expire, and identify
contradictions. It must not rewrite history silently.

## Memory state machine

```text
proposed → active | rejected | deleted
active → superseded | contradicted | expired | deleted
contradicted → active (user confirmation) | superseded | deleted
expired → deleted
rejected → deleted
deleted is terminal
```

Correction creates a new record that becomes `active`. The old record
becomes `superseded` with inspectable provenance. Retrieval excludes
the old record.

Contradiction retains both provenance chains. Both are not presented
as simultaneously trusted facts. Explicit user confirmation wins.
Otherwise V0 does not silently choose a winner.

Deletion removes retrievable content and derived indexes. A
content-free tombstone remains for integrity (id, scope, source
fingerprint, timestamps, status=`deleted`). Raw deleted content never
appears in audit, UI state, logs, or exports. Background jobs cannot
recreate a deleted record from the same deleted source without a new
user action.

Source-thread/message deletion policy:

- Model-proposed and system-observation memories whose sole provenance
  is the deleted source are tombstoned.
- Explicit user saves stay until the user deletes them, but freshness
  becomes `stale` and `sourceInvalidated` is recorded.

## Retrieval and context assembly

Deterministic, bounded retrieval. No embedding system is invented.

Filter order:

1. authorized user / environment / project scope
2. enabled memory policy (off → empty)
3. `active` status only
4. sensitivity and purpose restrictions
5. freshness / expiry
6. task relevance via lexical overlap with the current task text
   (existing string capabilities; no semantic score)
7. confidence / provenance class
8. bounded count and token budget
9. deterministic tie-break: confidence rank, then freshness rank,
   then `memoryId`

Retrieved memories enter the model request only through a structured
capsule: IDs, scope, provenance, confidence, freshness, and delimited
content labeled as untrusted reference data. They are never system
instructions.

Retrieval IDs and later used/corrected/rejected/contradicted signals
are recorded. Complete prompts are not stored for analytics.

Prompt-injection-shaped memories (`ignore previous instructions`, fake
tool instructions, fake authorization, fake system messages, credential
requests) remain untrusted data. None may alter routing, ActionGate,
approval, or system policy.

Secrets and credential-shaped content are rejected at capture, never
stored as memory, and proven absent from audit/UI/logs/exports.

## Concurrency Budget V0 topology

V0 enforcement is **process-local**. Policy is persisted in
`settings.json`. Runtime leases and queues live in memory in the server
process. A process restart releases all leases; that is the documented
failure mode, not a distributed lock.

This deployment is a single Node process per environment. V0 does not
claim cross-process or multi-host enforcement.

Workload classes, highest priority first:

| Class                 | Priority | Reserved | Shed under overload     |
| --------------------- | -------- | -------- | ----------------------- |
| `foreground-turn`     | 100      | yes      | no                      |
| `child-agent`         | 80       | no       | no (queue, then reject) |
| `mcp-action`          | 70       | no       | no (queue, then reject) |
| `failover-retry`      | 60       | no       | no                      |
| `detached-background` | 40       | no       | yes after queue full    |
| `openrouter-shadow`   | 20       | no       | yes (expendable)        |
| `dream-job`           | 10       | no       | yes (lowest)            |

Admission outcomes: `admitted` | `queued` | `rejected` | `cancelled` |
`timed-out`.

Rules:

- Atomic capacity acquisition (synchronous counter mutation).
- No client-owned counters.
- FIFO within a priority class.
- Aging cannot promote Dream/Shadow above reserved foreground.
- Dream and Shadow cannot block foreground turns.
- Queue length bound and wait timeout.
- Cancellation while queued removes the waiter.
- Interruption while active releases the lease (ensuring finalizer).
- Shutdown cancels queued work and releases active leases.
- No leaked permits, double-release (second release is a no-op), or
  negative counters.
- Queue entry that is cancelled never executes.

Canonical acquisition order to prevent deadlock:

```text
environment → project → thread → actor → execution-tree → class pool
```

Parent/child deadlock prevention: separate capacity pools. A parent
holding a `foreground-turn` lease does not consume the `child-agent`
pool. Children acquire from the child pool. A parent never waits on a
child that needs the parent’s own class permit.

Execution-tree context is server-generated at foreground admit and
carried to nested work. The child cannot reset or expand its budget.

Limits (conservative V0; larger user-configurable values are a
documented Pro/Team boundary, not implemented billing):

- environment foreground concurrent: 4 (1 reserved)
- project foreground concurrent: 2
- thread foreground concurrent: 1
- child: max depth 3, max direct children 4, max descendants 8,
  max concurrent children 2
- max attempts (including failover): 3 (aligns with Phase 8)
- max queue time: 30s
- Shadow concurrent: 1, queue 0 (shed)
- Dream concurrent: 1, queue 2, shed when saturated

Retries consume the attempt budget. Fallback does not reset
recursion/fan-out limits. Shadow remains non-blocking and expendable.
Dream is the lowest-priority class. MCP actions still require Phase 12
ActionGate; admission is additional, not a substitute.

## Integration points (Phase 8–12 spawn paths)

| Path                       | File                                        | Class                 | Behavior                                          |
| -------------------------- | ------------------------------------------- | --------------------- | ------------------------------------------------- |
| Foreground `sendTurn`      | `ProviderCommandReactor.ts`                 | `foreground-turn`     | Admit before send; ensuring release               |
| Auto-route failover        | `continueRoutedAttempts`                    | `failover-retry`      | Consumes attempt budget; no reset                 |
| OpenRouter Shadow          | `maybeRunOpenRouterShadow`                  | `openrouter-shadow`   | Shed if no capacity; abort releases               |
| MCP tool execute           | `McpActionAuthorization.ts`                 | `mcp-action`          | After ActionGate ALLOW; ensuring release          |
| Dream worker               | `DreamMemoryService`                        | `dream-job`           | Lowest priority; cancellable                      |
| Observed provider subagent | `ThreadBackgroundLiveness` / runtime ingest | `child-agent`         | Admit against parent tree; reject records fan-out |
| Title / detached helpers   | existing `forkDetach` / title worker        | `detached-background` | Bounded; shed under overload                      |
| Interrupt / session stop   | `processTurnInterruptRequested`             | all active for thread | Cancel queued + release leases                    |
| Application shutdown       | scheduler `shutdown` finalizer              | all                   | Cancel queued, interrupt active                   |

Provider-native subagents are not spawned by T3. V0 still attaches an
execution-tree context to the parent turn and counts observed children
against fan-out limits. When admission rejects, the rejection is
recorded and the parent is not given additional T3-side nested work.
V0 does not claim it can intercept a provider’s internal spawn before
the provider process starts it.

## Inspector and Control Center

Operational Inspector adds progressive cards after ActionGate / Outcome
and **before** Route Gate:

- Dream Memory (capture mode, retrieval IDs/count, provenance,
  confidence, freshness, proposal/active/contradicted). Raw private
  memory bodies are not shown unless the current user opens memory
  detail in the memory-management UI.
- Concurrency (admission, scope, workload class, queue duration,
  acquired/released lease, depth/fan-out/attempt consumption,
  cancellation/backpressure reason, known/estimated/unknown cost).

Control Center adds environment-scoped projections (not sources of
truth):

- Dream enabled/disabled, capture mode, proposal/active/contradicted/
  expired counts, recent maintenance, known Dream cost exposure
- Active and queued workload counts, configured limits, saturation/
  backpressure, foreground versus background, cancelled/expired/
  rejected jobs, known cost/token exposure

## Privacy, audit, and security

Sanitized audit events cover memory proposal, activation, retrieval,
correction, supersession, contradiction, expiry, deletion, Dream job
lifecycle, and concurrency admission, queue, acquisition, release,
timeout, cancellation, rejection, and budget exhaustion.

Never store in audit: API keys, authorization headers, credentials,
deleted memory content, unrestricted prompts, private tool bodies,
hidden chain-of-thought.

Prove `sk-`, `Bearer`, credential-shaped strings, and deleted content
do not appear in serialized audit, UI state, logs, or exports.

## Monetization boundary (not implemented)

Phase 13 does not bill, check out, subscribe, or enforce paid gates.

| Tier           | Included (documented, not billed)                                                                                                                                    |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Free/local** | transparent memory controls, explicit save and deletion, bounded local/project memory, conservative concurrency, baseline privacy and safety, basic queue visibility |
| **Pro**        | richer personal retention policies, advanced personal retrieval controls, larger user-configurable concurrency within safe limits, deeper personal insights          |
| **Team**       | shared project-memory policy, team concurrency budgets, queue visibility, audit and policy controls, cost attribution                                                |
| **Enterprise** | RBAC, tenant isolation, retention/legal policy controls, compliance exports, centralized concurrency and cost governance, private deployment policy                  |

Never paywall: deletion, disabling memory, provenance visibility,
baseline safety, secret protection.

Measure only defensible value. Do not claim saved time or money
without measured evidence:

- memory proposal acceptance/rejection
- correction/deletion/contradiction rates
- retrieval usefulness signals (used / corrected / rejected / later contradicted)
- rework changes (Phase 11 observations, not memory)
- queue latency
- saturation
- prevented fan-out
- cancelled background cost
- known provider/tool/token cost
- foreground latency protection

Unknown cost and usage remain unknown.

## End-to-end path

1. Client may explicitly save memory (`memory.save`) after validation,
   redaction, authorization, and server-computed scope.
2. On a successful eligible turn, if Dream is enabled and not `off`,
   a low-priority Dream job is admitted. The injectable extractor
   proposes records. `review` keeps them proposed; `automatic` may
   activate only the allowlist.
3. On the next foreground turn, after dispatcher routing and before
   provider send, the server admits a `foreground-turn` lease and
   retrieves an authorized memory capsule when policy allows.
4. The capsule is delimited untrusted data. It cannot change routing,
   ActionGate, or system policy.
5. Nested MCP, Shadow, failover, Dream, and observed children admit
   against the same execution tree.
6. Interrupt and shutdown release every lease through finalizers.
7. Inspector and Control Center render sanitized projections.

## Phase 13 versus later release work

Phase 13 implements local, inspectable Dream Memory V0 and
process-local concurrency budgets.

Later release work (not this PR): billing, marketplace, signed
installers, production credential migration, team/enterprise RBAC
enforcement, distributed multi-process budgets, vector retrieval if a
real index is introduced, mobile Auto Route redesign.

## Validation

- `vp run --filter @t3tools/contracts typecheck`
- `vp run --filter @t3tools/shared typecheck`
- `vp run --filter @t3tools/client-runtime typecheck`
- `vp run --filter @t3tools/server typecheck`
- `vp run --filter @t3tools/web typecheck`
- focused tests for memory, concurrency, RPC, presenters
- existing Phase 8–12 regression tests in the touched files
- `vp run knip:check`
- `node scripts/base3router-ui-lab.ts`
- no live provider or MCP requests in CI
