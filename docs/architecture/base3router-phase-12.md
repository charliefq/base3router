# Base3Router Phase 12: Skill Router, MCP Router, and Independent ActionGate

Stacked on `main` after Phase 11 (PR #13 merge
`1e5e09418a757fcd9771042cf77f4034dad7fb9f`). This note freezes the Phase 12
boundary. It records the audit of existing skill discovery, MCP toolkits,
dispatcher route ActionGate, and permission modes. It does not restate Phase 8
model routing, Phase 10 Teacher/Shadow, or Phase 11 Hybrid evaluation that
contracts and tests already encode.

Starting branch: `cursor/phase-12-skill-mcp-action-gate`.

Working title: **Skill Router, MCP Router, and Independent ActionGate**.

The required execution boundary is:

```text
request
→ route model (Phase 8/11)
→ select skills (Skill Router)
→ select MCP tools (MCP Router)
→ build immutable execution plan
→ authorize each planned action (ActionGate)
→ execute only ALLOW-bound actions
→ record sanitized outcome
```

Planning, authorization, and execution remain distinct. An allowed model
route does not imply that a tool action is allowed.

## Goals

Ship the first production-safe version of:

- typed, versioned skill manifests over existing provider discovery
- a deterministic Skill Router
- typed, versioned MCP server/tool descriptors over existing toolkits
- a deterministic MCP Router
- model/skill/tool compatibility filtering
- an independent ActionGate for side effects (`ALLOW` / `DENY` / `ASK`)
- immutable execution-plan provenance
- exact-action approval binding with expiry, replay prevention, and
  race-safe one-time consumption
- tool cancellation, timeout, bounded retry, and circuit breaker
- sanitized audit history
- Inspector and Control Center governance surfaces
- measurable value and cost signals for later monetization

## Non-goals (Phase 13+ / release)

- Dream Memory
- global agent-concurrency budgets
- autonomous policy generation
- online learning or model retraining
- billing, checkout, subscriptions, or payment processing
- automatic paid feature enforcement
- mobile Auto Route redesign
- arbitrary public MCP marketplace installation
- downloading or enabling plugins (the USC account prohibits plugins)
- unrelated product redesign
- rewriting Phase 8/10/11 routers
- production credential migration
- signed release packaging
- team/enterprise RBAC enforcement (architecture boundary only)

## Names that must not collapse

| Name                            | What it is                                       | Authority                                          |
| ------------------------------- | ------------------------------------------------ | -------------------------------------------------- |
| **Model Router**                | Phase 8/11 provider instance + model selection   | Base3Router `model-router.v0` / Hybrid V1          |
| **Skill Router**                | Reusable instruction/capability selection        | Base3Router `skill-router.v0`                      |
| **MCP Router**                  | MCP server/tool selection                        | Base3Router `mcp-router.v0`                        |
| **Dispatcher route ActionGate** | Whether the routed turn may start                | Dispatcher `dispatcher.phase-1a.v1` `ALLOW`/`DENY` |
| **Independent ActionGate**      | Whether each side-effecting action may execute   | Base3Router `action-gate.v0` `ALLOW`/`DENY`/`ASK`  |
| **Access Auto**                 | Runtime permission mode (`RuntimeMode = "auto"`) | Provider permission policy, not routing            |
| **OpenRouter Teacher/Shadow**   | Phase 10 external guidance                       | Phase 10 policy + consent                          |
| **Hybrid Router V1**            | Phase 11 local evidence ranking                  | Phase 11 policy, after hard filters                |

Runtime Access Auto is still a permission mode. It is not model, skill, or
MCP routing. OpenRouter Teacher/Shadow and Hybrid Router V1 remain Phase
10/11 systems.

## Audit matrix

| Capability                                                     | Exists | Partial | Missing | Relevant files                                                     | Phase           |
| -------------------------------------------------------------- | ------ | ------- | ------- | ------------------------------------------------------------------ | --------------- |
| Per-provider skill filesystem/CLI discovery                    | x      |         |         | `apps/server/src/provider/Drivers/*Skills.ts`, Codex `skills/list` | inherited       |
| Skill picker / `$` / slash UX                                  | x      |         |         | `packages/client-runtime/src/providerSkills.ts`, composer tokens   | inherited       |
| Typed versioned skill manifests                                |        |         | x       | only `ServerProviderSkill` picker DTO                              | 12              |
| Skill Router (deterministic)                                   |        |         | x       | —                                                                  | 12              |
| Trusted-instruction adapter boundary                           |        |         | x       | discovery prose is not instructions                                | 12              |
| First-party MCP HTTP transport                                 | x      |         |         | `apps/server/src/mcp/McpHttpServer.ts` (`v2025_06_18`)             | inherited       |
| Session capability grants (`preview`/`device`/`pull-requests`) | x      |         |         | `McpSessionRegistry`, `McpInvocationContext`                       | inherited       |
| Call-time MCP capability denial                                | x      |         |         | `requireMcpCapability`                                             | inherited       |
| Task-scoped MCP Router                                         |        |         | x       | tools advertised broadly                                           | 12              |
| Typed MCP server/tool descriptors                              |        |         | x       | toolkit `Tool.make` only                                           | 12              |
| Fake in-process MCP for tests/UI Lab                           |        |         | x       | —                                                                  | 12              |
| Dispatcher route ActionGate (`ALLOW`/`DENY`)                   | x      |         |         | `packages/contracts/src/dispatcher.ts`                             | 1 / 8           |
| Independent per-action ActionGate (`ASK`)                      |        | x       |         | RuntimeMode + provider approvals; no shared gate                   | 12              |
| Route-binding provenance                                       | x      |         |         | `DispatcherTaskRouteBinding`                                       | 1 / 8 / 10 / 11 |
| Immutable execution plan                                       |        |         | x       | —                                                                  | 12              |
| Approval expiry / replay / one-time race                       |        |         | x       | pending approvals have no fingerprint                              | 12              |
| Canonical action fingerprint                                   |        |         | x       | `JSON.stringify` is not used as a security digest                  | 12              |
| Credential store + client redaction                            | x      |         |         | settings redact, `textOmitsCursorSecrets`                          | inherited       |
| Provider cancellation                                          | x      |         |         | turn abort / Cursor Cloud cancel                                   | inherited       |
| Bounded model-router retry/cooldown                            | x      |         |         | failover + instance cooldown                                       | 8               |
| Tool timeout / circuit breaker / authorized fallback           |        | x       |         | model failover only; not per MCP tool                              | 12              |
| Phase 11 outcome/evaluation records                            | x      |         |         | `routerEvaluation.ts`                                              | 11              |
| Inspector route / OpenRouter / Hybrid cards                    | x      |         |         | `presentOperationalInspector.ts`                                   | 7–11            |
| Inspector Skill/MCP/ActionGate/plan cards                      |        | x       |         | route ActionGate card only                                         | 12              |
| Control Center Router Insights                                 | x      |         |         | `presentControlCenter.ts`                                          | 11              |
| Control Center skill/MCP/approval governance                   |        | x       |         | provider pending-approval bucket only                              | 12              |
| Effect MCP protocol (`McpServer`, HTTP)                        | x      |         |         | vendored `effect/unstable/ai`                                      | inherited       |
| stdio MCP transport                                            |        |         | x       | not used by this repository                                        | unsupported     |
| Plugins / marketplace install                                  |        |         | x       | USC account prohibits plugins                                      | never           |

## Reuse versus new modules

Reuse, do not replace:

- Provider skill discovery catalogs (`ServerProviderSkill`) as Skill Router
  input. Do not invent a second filesystem walker.
- First-party MCP toolkits and session credentials as MCP Router input and
  enforcement. Do not register a parallel HTTP MCP server.
- Dispatcher `ActionGateResult` as **route eligibility only**. Do not extend
  `evaluateActionGate` into side-effect authorization.
- `RuntimeMode` and composer approval UX as permission hints / ASK chrome.
  Independent ActionGate is authoritative for Base3Router-owned side effects.
- Cursor Cloud outbox `operationKey` / fingerprint claim pattern for
  one-time consumption.
- Phase 11 observation redaction and unknown-metric conventions.
- Inspector `OperationalStatusCard` and Control Center projection pattern.

New:

- `packages/contracts/src/skillRouter.ts`
- `packages/contracts/src/mcpRouter.ts`
- `packages/contracts/src/actionGate.ts`
- `packages/contracts/src/executionPlan.ts`
- `packages/shared/src/skillRouter.ts`
- `packages/shared/src/mcpRouter.ts`
- `packages/shared/src/actionCanonical.ts`
- `packages/shared/src/actionGate.ts`
- `packages/shared/src/executionPlan.ts`
- `packages/shared/src/mcpLifecycle.ts`
- `packages/shared/src/skillCatalog.ts`
- `packages/shared/src/mcpCatalog.ts`
- `apps/server/src/actionGate/` persistence and RPC
- Inspector / Control Center presenters and UI Lab fixtures

## Trust boundaries

| Boundary                   | Who may cross it                      | What never crosses it                                 |
| -------------------------- | ------------------------------------- | ----------------------------------------------------- |
| Provider skill discovery   | Adapter → typed manifest              | Skill prose into system instructions                  |
| MCP tools/list metadata    | Descriptor catalog                    | Tool descriptions as instructions                     |
| MCP tool results           | Adapter, after ActionGate ALLOW       | Raw secrets, unrestricted output in audit             |
| Independent ActionGate     | Server process                        | Client-supplied approval claims                       |
| Approval store             | Server-owned SQLite / in-memory store | Client as writable authority                          |
| Execution plan             | Server bind at turn start             | Mutated client copies                                 |
| Inspector / Control Center | Sanitized structured records          | API keys, Bearer tokens, prompts, private tool output |
| Fake MCP / UI Lab          | In-process fixtures                   | Production credentials, live MCP HTTP                 |

Skill prose, descriptions, examples, and external metadata are untrusted
data. They are never inserted into system instructions merely because
discovery returned them. Only explicitly trusted and selected skill
instructions may reach execution, through `trustedSkillInstructionRef`.

MCP server/tool names, descriptions, schemas, errors, and returned content
are untrusted data. They are never treated as policy or instructions.

Unknown values remain unknown. Compatibility, quality, cost, trust, and
performance scores are never fabricated.

## Typed skill manifests (`skill-manifest.v0`)

A manifest is a versioned contract, not a picker DTO.

Required fields:

- stable `skillId` (branded slug; never a display name)
- human-readable `name` (untrusted display)
- `version`
- `source` (`local-filesystem` \| `provider-catalog` \| `fake-lab`) plus
  provenance
- `trustState` (`trusted` \| `untrusted` \| `unknown`)
- `enabled` / `available`
- declared `capabilities`
- compatible `taskClasses` (`TaskMacroCategory`, including `unknown`)
- compatible `modelCapabilities` (`ModelRouterCapability`)
- `requiredMcpTools` (namespaced tool ids, possibly empty)
- optional input/output schema references (digests, not prose)
- `riskClass`
- `requiredPermissions`
- optional cost/resource hints as known/unknown metrics

Default mapping from `ServerProviderSkill`:

- `skillId` = `{source}:{driver}:{slug(name)}`
- `trustState` = `unknown` (do not invent trust)
- capabilities / task classes / model capabilities = empty unless the
  catalog declares them
- cost/resource = unknown
- `instructionsTrust` = `not-executable`

The instruction adapter returns a ref only when `trustState === "trusted"`,
the skill is selected, and `instructionsTrust === "trusted-selected"`.
Otherwise execution receives no skill body.

## Skill Router (`skill-router.v0`)

Pure function. No I/O. No clocks except injected evidence timestamps that
are not used for ranking unless validity checks pass.

Filter order:

1. Required capabilities
2. Enabled and available
3. Trust and policy restrictions
4. Provider/model compatibility
5. MCP/tool dependencies
6. Explicit allow/deny constraints
7. Manual override (still emits an audit decision)
8. Phase 11 measured evidence only when sample thresholds are met
9. Stable tie-break: `skillId` lexicographic (UTF-16 `<`), then `version`

Display names and discovery order never decide a tie.

A request may validly require no skill. `selected: null` with reason
`NO_SKILL_REQUIRED` is success, not failure.

## Typed MCP descriptors (`mcp-descriptor.v0`)

Servers:

- stable `serverId`
- `transportKind`: `http` (this repository) or `in-process` (fake/lab).
  `stdio` is recorded as unsupported and filtered.
- `trustState`
- `configured` / `enabled` / `connected`
- `authRequired` boolean — never credentials
- descriptor provenance and freshness

Tools:

- namespaced `toolId` (`{serverId}/{toolName}`)
- schema digest (not raw schema in audit)
- declared capabilities
- action/risk category and side-effect class
- timeout and retry policy
- cost attribution where known

First-party T3 toolkits (`preview`, `device`, `pull-requests`) are the
authoritative live catalog. Fake MCP exists only for tests and UI Lab.
No CI test performs a live MCP request.

## MCP Router (`mcp-router.v0`)

Pure function. Distinct typed decision from `modelRoute` and `skillRoute`.

Filter order:

1. Required capability
2. Configured / enabled / connected
3. Trust policy
4. Model and skill compatibility
5. ActionGate eligibility (risk class may be DENY/ASK; ASK is still
   selectable, DENY is not)
6. Explicit allow/deny
7. Manual override
8. Measured evidence only when valid
9. Tie-break: namespaced `toolId`, then `serverId`

Protections: prompt-injection-shaped descriptions are never copied into
instructions; duplicate names are namespaced; schema mutation after
approval invalidates the plan; oversized/malformed metadata is dropped;
unsupported transports are filtered; credential-shaped strings are
redacted; stale discovery is labeled and excluded when expired.

## Immutable execution plan (`execution-plan.v0`)

Created after model/skill/MCP routing and before ActionGate execution.

Binds:

- request/turn/thread/project/environment identity
- selected model route summary (ids only)
- selected skills
- selected MCP servers/tools
- exact planned actions
- canonical argument digest (never unrestricted arguments)
- risk classifications
- required approvals
- policy ids/versions and descriptor versions
- provenance, `createdAt`, optional `expiresAt`

The plan is the authorization input. If the tool, arguments, server
identity, schema digest, route, policy, or material execution scope
changes after authorization, the existing approval is invalid.

Canonicalization is RFC 8785-style deterministic JSON: UTF-16 key sort
with `<` (not `localeCompare`), finite numbers only, no `undefined`,
hashed with SHA-256. Raw `JSON.stringify` is not the fingerprint
algorithm.

## Independent ActionGate (`action-gate.v0`)

Independent of `Dispatcher.evaluateActionGate`. Each planned action
receives `ALLOW`, `DENY`, or `ASK`.

Risk classes:

- `read-only-local`
- `local-mutation`
- `network-access`
- `external-write`
- `destructive`
- `financial`
- `credential`
- `administrative`
- `unclassified`

Default policy:

- `unclassified` or unknown side effects → `ASK` (never silent execute)
- `destructive`, `financial`, `credential`, `administrative` → `ASK` by
  default; policy may `DENY` but must not auto-ALLOW
- baseline safety cannot be disabled by a paid tier
- `read-only-local` does not automatically mean safe if the action can
  expose secrets or private data → `ASK`
- first-party read-only local inspection of non-secret status (e.g.
  `preview_status` with trusted first-party server) → `ALLOW`

`ASK` pauses before adapter/tool execution. It is never implicit
approval. First-party MCP toolkits (`preview`, `device`,
`pull-requests`) call `ActionGateService.authorizeTool` at the handler
boundary before broker/device/PR side effects. `layerTest` allows tools
so existing toolkit tests stay focused; live persistence evaluates the
real policy.

## Approvals

Server-owned. Client claims are not authority. Inspector and Control Center
Grant / Deny / Cancel call `actionGate.respondApproval`. UI Lab uses the same
controls through a handler; production chrome is never display-only.

An approval binds to:

- exact action fingerprint
- canonical argument digest
- tool and server identity
- requesting environment, and thread/project when known
- policy version
- allowed scope (`exact-action`)
- expiration
- one-time (default) or explicitly declared reuse

### Persistence

Creation is database-enforced and transactional. `putApproval` inserts inside
`sql.withTransaction` with `ON CONFLICT DO NOTHING RETURNING`. Uniqueness:

- `(environment_id, idempotency_key)` where the key is present
- `(environment_id, fingerprint)` while status is `pending` or `granted`

ASK creation uses `ask:{fingerprint}` as the idempotency key so refresh and
reconnect reuse the live row. Same key + same fingerprint returns the existing
live approval. Same key + different fingerprint is a typed `conflict`. Terminal
rows (`consumed`, `denied`, `cancelled`, `expired`, `invalidated`) are not
resurrected. SQLite uniqueness errors are mapped to `ActionGateError` and are
not thrown as uncaught driver errors. Audit inserts use `ON CONFLICT(event_id)
DO NOTHING` so concurrent identical creates audit once.

### State machine

```text
putApproval → pending
pending + grant (UPDATE … WHERE status='pending') → granted
pending + deny  → denied
pending + cancel → cancelled
pending|granted + expiresAt ≤ now → expired
granted + consume (UPDATE … WHERE status='granted' AND fingerprint=…) → consumed
granted + explicit-reuse consume → granted (unchanged)
```

Terminal: `denied`, `cancelled`, `expired`, `consumed`, `invalidated`.
A late grant cannot revive a terminal row.

### Concurrency winners

- Identical concurrent `putApproval`: one row; both callers receive it.
- Conflicting concurrent `putApproval` (same key, different fingerprint): one
  insert wins; the other is `conflict`. The winner is never the wrong
  fingerprint.
- Two Grant RPCs: first `pending → granted` wins; a second Grant on `granted`
  is idempotent. Consume still happens once (`UPDATE … WHERE status='granted'`).
- Grant versus Deny: first `UPDATE … WHERE status='pending'` wins. The loser is
  `conflict`. Exactly one terminal decision.
- Two consume callers: one `consumed`; the other `replay`.
- Replay after consume is `replay`. Changed arguments produce a new fingerprint
  and cannot consume the old approval.

`ASK` pauses MCP handlers in `requireAllowedMcpTool` before adapter execution.
Grant consumes, then the original waiter resumes and the tool runs once. Deny,
expire, and cancel terminate the waiter with a typed error and zero tool calls.
Fiber interruption cancels the pending approval when no other waiter remains.

Consumption:

- expiry rejects
- one-time: atomic consume (`UPDATE … WHERE status='granted' AND fingerprint=…`)
  so a race cannot execute twice
- replay of a consumed fingerprint is `REPLAY_REJECTED`
- plan mutation invalidates
- deny/cancel are terminal
- idempotency key: the same key with the same fingerprint is a no-op
  success; a different fingerprint with the same key is rejected

## MCP execution lifecycle

- Credentials stay in `McpSessionRegistry` (server-side)
- Cancellation follows the originating turn abort
- Bounded timeout from the tool descriptor
- Bounded retry only for retry-safe transport failures
- No retry for policy denial, invalid arguments, cancellation, or unsafe
  ambiguity
- Circuit breaker/cooldown after repeated transport failure
- Idempotency key forwarded when the tool declares support
- Sanitized errors only
- Fallback must create a new bound plan/action decision; approvals never
  transfer to a materially different action
- Tool failure cannot be stored as Phase 11 success

## Audit and privacy

Append-oriented typed events:

- plan created
- skill routed / MCP routed
- ActionGate decided
- approval requested / granted / denied / expired / cancelled / consumed
- action started / succeeded / failed / interrupted
- retry / fallback / circuit-breaker

Events carry ids, decisions, reason codes, timestamps, policy versions,
fingerprints, outcome classification, and safe cost attribution.

Never persist by default: secrets, API keys, Authorization headers, raw
credentials, entire prompts, private tool output, arbitrary MCP
descriptions, unrestricted tool arguments.

Secret-shaped strings (`sk-`, `Bearer`, representative credential
material) are redacted at every client, log, Inspector, and serialization
boundary.

## Inspector and Control Center

Operational Inspector adds progressive cards after Hybrid and **before**
the existing dispatcher route gate, which is relabeled **Route Gate** so
the independent ActionGate is not collapsed into turn eligibility:

- Execution Plan
- Skill Route
- MCP Route
- ActionGate
- Approval
- Tool Execution
- Outcome

Control Center adds an environment-scoped **Action governance**
projection: configured skills, MCP servers, enabled/degraded status,
pending approvals, denied/expired actions, recent outcomes, cost exposure
where known, and policy compliance. It remains a projection, not a second
source of truth.

Approval UX shows exact action type, destination/server/tool, material
argument summary (redacted), risk, side effects, environment/project/thread
scope, requested scope, expiry, fingerprint abbreviation, and why ActionGate
returned ASK. Live Grant once, Deny, and Cancel call
`actionGate.respondApproval` and render server state after the RPC
(pending, submitting, granted, denied, expired, cancelled, consumed, conflict,
disconnected/error). Duplicate clicks are disabled while a response is in
flight. Copy is never a deceptive broad “Allow” or persistent “always allow”.
Changed arguments require a new approval.

## End-to-end path

1. Client starts a turn (`thread.turn.start`) with optional manual skill
   and tool overrides.
2. Dispatcher binds Model Router (Phase 8/11) as today.
3. Skill catalog is projected from provider discovery + fake/lab entries.
4. Skill Router emits `skillRoute`.
5. MCP catalog is projected from first-party toolkit descriptors +
   configured fake servers. No live `tools/list` in CI.
6. MCP Router emits `mcpRoute`.
7. Server builds `execution-plan.v0` with canonical action fingerprints.
8. Independent ActionGate evaluates each planned action.
9. `ASK` actions wait on server-owned approvals. `DENY` never executes.
   `ALLOW` may execute.
10. Lifecycle: timeout, cancellation, bounded retry, circuit breaker,
    authorized fallback (new plan).
11. Sanitized audit events append. Phase 11 outcomes record terminal
    classification without flipping failure into success.
12. Inspector and Control Center render sanitized projections.

## Monetization boundary (not implemented)

Phase 12 does not bill, check out, subscribe, or enforce paid gates.

| Tier           | Included (documented, not billed)                                                                                                 |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Free/local** | local skills, basic manual tool use, BYOK, baseline ActionGate safety, local audit visibility                                     |
| **Pro**        | advanced personal routing, personal policies, richer evaluation, longer local audit/insight history                               |
| **Team**       | shared skill/MCP policies, centralized approvals, shared allowlists, audit and budgets, team outcome/cost insights                |
| **Enterprise** | RBAC, centralized governance, private/self-hosted MCP policy, compliance controls, governance exports, org retention/audit policy |

Do not monetize by weakening safety, hiding provider/tool costs, reselling
tokens invisibly, or fabricating savings. Baseline ActionGate cannot be
disabled by a paid tier.

Measurable customer-value signals (known vs estimated labeled separately;
unknown stays unknown):

- prevented unsafe actions
- approval frequency and latency
- tool success / failure / interruption rate
- setup time reduction when measurable
- policy compliance
- authorized fallback success
- rework reduction
- third-party MCP/API cost exposure

## Phase 12 versus Phase 13

Phase 12 implements the local, deterministic, auditable control plane for
skills, MCP tools, and per-action authorization.

Phase 13+ may add: Dream Memory, global agent-concurrency budgets, and later
governance/release work (team/enterprise policy enforcement, billing,
marketplace if ever allowed, stdio MCP, mobile Auto Route). Atomic approval
idempotency and live Grant/Deny chrome are Phase 12, not residuals.

## Validation

- `vp run --filter @t3tools/contracts typecheck`
- `vp run --filter @t3tools/shared typecheck`
- `vp run --filter @t3tools/web typecheck`
- `vp run --filter @t3tools/scripts typecheck`
- focused tests for contracts, shared routers, ActionGate, lifecycle
- `vp run knip:check`
- `node scripts/base3router-ui-lab.ts`
- no live provider or MCP requests in CI
