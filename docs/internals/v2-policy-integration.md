# V2 policy integration ancestry

This branch is the Base3Router policy wrap on one Orchestrator V2 engine.
It is not a graft of V2 beside V1, and it does not cherry-pick kernel features
back into the V1 spine. Protocol is 2. Protocol 1 clients are rejected.

## Pinned baseline

Execution baseline: `8ed276c246b624631e7d39241ebfd22d8314cb68`
(`v0.0.46-nightly.20261003.2610`).

The branch was created with that commit as its parent, so the nightly remains
a Git ancestor. Reviewers can split the history without mixing the two diffs:

- Upstream adoption, from the fork merge-base through the pin:
  `git diff 7cfb4987fe27da3e1d4e86abacae3a1fc12af5bb 8ed276c246b624631e7d39241ebfd22d8314cb68`
  and `git log --oneline 7cfb4987fe27da3e1d4e86abacae3a1fc12af5bb..8ed276c246b624631e7d39241ebfd22d8314cb68`
- Base3Router ports on top of that pin:
  `git diff 8ed276c246b624631e7d39241ebfd22d8314cb68 HEAD`
  and `git log --oneline 8ed276c246b624631e7d39241ebfd22d8314cb68..HEAD`

`origin/main` (`bab26191075ec8806894478970e8d9954c357290`) and this branch
diverge at `7cfb4987`. A pull request into `main` therefore contains both the
upstream V2 history and the policy ports. Use the ranges above to review them
separately.

GitHub cannot start `pull_request` CI while that history is unmerged, because
the test merge is conflicting. A merge commit of `origin/main` records the
join and keeps this branch's tree: V1 files are not added back. The resulting
tree is the V2 engine plus the Base3Router ports.

## Sources left untouched

- Policy and stabilization reference: PR #16 at
  `8191cfc534b25b3d6f06c06031bfe53691f83e1a`
- Compatibility audit: PR #17 at
  `429724b8474e64e44922fd6beb7ec353976a1fb1`

Those branches are not reset, merged, or closed by this work. The audit's
recommendation B is the plan this branch implements.

## Later upstream commits

Commits after the pin are not part of the baseline. Add one only when a
migration defect on this branch requires that exact commit, and record the
SHA and the defect in this file. None are included yet.

## What this branch changes about execution

One engine: `apps/server/src/orchestration-v2`. V1 `apps/server/src/orchestration`
is not present. Base3Router policy runs inside V2 command dispatch and effect
execution. Identity comes from the authenticated session (or from a grant row
written by that session), not from model-supplied fields.

Cursor Cloud REST execution is not a second engine here. Product sessions
fail that path closed. Explicit handoff remains the provider-switch contract.
Mid-thread `provider.switch` is denied for authenticated sessions.

Schema changes for Base3Router tables live in `base3_policy_migrations`, not
in `effect_sql_migrations`. Upstream's id-only migrator is not applied to a
database that already contains Base3Router policy tables.

Terminal V2 provider turns (`provider_turn.updated` completed, failed,
interrupted, or cancelled) write one router observation keyed by
`environmentId:threadId:messageId`. Unknown cost stays unknown. Duplicate
terminal events for the same turn do not add a second row. A restart that
binds a new message writes a new observation.

## Dispatch coverage

One gate, `authorizeDispatch`, sits in `Orchestrator.dispatchOnce`. Effect
execution revalidates in `EffectWorker`. Schedules, usage-limit continuation,
and MCP tools call the same grant and ActionGate helpers. Ordinary
`message.dispatch` does not require an external-write approval. ASK applies
to delegation, unattended schedule creation, and external-write MCP tools.

| Entry                         | Policy                                                                               | Unsupported behavior                                   |
| ----------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| Foreground `message.dispatch` | Session operate scope, immutable Auto/Manual bind, capacity, message grant           | Absent context is denied                               |
| Delegation                    | ASK consumed before admit; child admit rejects instead of waiting                    | No grant means zero attempts                           |
| T3 MCP thread tools           | Session actor captured at issue time; model-supplied subject is ignored              | Missing actor fails closed                             |
| Queued edit / resume          | Grant hash and revocation checked again after the delay                              | Argument changes do not run                            |
| Schedules                     | User schedules get a grant; agent/MCP schedules require ASK                          | A fired prompt that does not match the grant is denied |
| Resume / continuation         | Continuation grant copied from the latest unrevoked thread grant                     | No prior grant skips the dispatch                      |
| Usage-limit continuation      | Same continuation grant, hashed to the continuation text                             | Mismatched text is denied                              |
| Effect outbox                 | Start, steer, restart, and continue require the message grant and a non-terminal run | Terminal runs are not replayed                         |
| `provider.switch`             | Denied for authenticated sessions                                                    | Explicit handoff is the switch contract                |
| Cursor Cloud REST             | Not a second engine                                                                  | Product sessions fail closed                           |
| OpenRouter HTTP execution     | No executable provider driver on this pin                                            | Guidance / Teacher / Shadow only                       |
| Protocol 1                    | Not accepted                                                                         | Clients must speak protocol 2                          |

Interrupt requests and unconfirmed disconnects set flags on the lease. A slot
stays occupied until a matching V2 `provider_turn.updated` terminal is ingested
and `confirmProviderTermination` writes `released_at`. Local projection
`completed|failed|cancelled|interrupted|rolled_back` does not free capacity.
A closed event stream without that confirmation leaves the slot pinned.
`ProviderRuntimeRecoveryService` can terminalize projection runs on
startup/shutdown; it does not confirm that the provider process stopped, so it
does not release the lease. A missing run row stays occupied.

## Schema import

`importBase3Policy` maps a disposable Base3Router database into the V2 file.
Approvals are copied as stored. Ambiguous external outcomes are held and are
not replayed. Import retry uses the batch id so rows are not duplicated.
`initializeV2Database` snapshots `state.sqlite` into a missing
`statev2.sqlite` when the source has V1 transcript tables. A policy-only
Base3Router file with no `projection_threads` is left uncopied;
`importBase3Policy` is the import path for those rows. An existing V2 file
is never replaced, so repeated startup does not overwrite data or duplicate
the snapshot.

## Governance surfaces

Inspector and Control Center read `governance.snapshot`. The snapshot is
authorized with `orchestration:read` on the authenticated session. It shows
route mode, lease occupancy, approval status, and whether memory content is
present. It does not include prompts or memory content.

Workflow Phase 5 human decisions use `workflow.catalog`, `workflow.readRun`,
and `workflow.action` on that same authenticated session. `orchestration:read`
can view a pending gate; `orchestration:operate` records approve, reject, or
cancel. Approved agent stages dispatch through governed V2
`ThreadLaunchService` / `message.dispatch`. Cursor Cloud REST stays fail-closed.
OpenRouter has no executable driver on this pin.

ActionGate ASK uses `actionGate.authorizeTool` with the governed MCP tool path
(`preview_open` is network-access → ASK). `waitForAuthorized` consumes a grant
once and records `action.started`. Deny, cancel, and expiry never start the
action. Dream Memory save, capture-off, enqueue, and delete go through
`memory.save`, settings `dreamMemory.captureMode`, `memory.enqueueEligible`,
and `memory.delete`. Deleted rows stay deleted after reopen.

## Task contract

A new thread is ordinary chat unless `thread.create` sets `taskGovernance` to
`required` or includes a contract. Historical threads omit that field and stay
readable and launchable. A required task with a missing or blank goal,
redirect, acceptance, or brake is paused: `message.dispatch` and delegated
starts are rejected before a provider starts. Completing it is
`thread.task-contract.set`. Continuation does not replace the contract. It
uses the persisted revision and still counts toward the brake.

`maxProviderStarts` counts reservations in `task_contract_admissions` across
the task tree, including later handoffs. The first `provider-turn.start` for
an admitted command reuses that reservation. A retry of the same effect, a
`provider-turn.restart`, or a `provider-runtime.continue` takes another slot.
A contract edit does not delete earlier rows, so the budget does not reset.
Exhaustion blocks new starts and enqueues `provider-turn.interrupt` for running
turns. The outbox worker delivers that request to the provider. The lease stays
occupied until provider termination is confirmed.

Redirect and acceptance sentences are human decisions on a session with
`orchestration:operate`. Accepting the current revision blocks further starts.
Redirect pauses governed work and asks active turns to cancel until
`thread.task-contract.resume` clears that pause on the same revision. Provider
completion does not accept the task. A child inherits the parent contract and
cannot replace it. An existing governed thread cannot be written back to
ordinary chat by metadata, continuation, delegation, or resume. Changing the
contract bumps the revision, clears acceptance, and revokes execution grants
for the tree. Queued provider starts are rechecked against that revision
before they run.

The draft composer has a compact governed-task form. Inspector reads the
persisted thread. Ordinary chat leaves the form off.

Task usage is the provider-turn totals that produced a governed task, including
children, retries, failover, and rejected work. `turnTokenUsage` is one turn's
snapshot: input already includes cache, and output already includes reasoning,
so those splits are shown and not added again. A later snapshot for the same
turn replaces it. An incremental report adds. The context-window `usedTokens`
meter is not task usage. A replayed event id is ignored. Missing tokens or
cost stay unknown. Cost is the provider-reported figure only. Human acceptance
is a separate decision from provider completion. A cohort with no accepted
task has an undefined consumption ratio. Incomplete coverage is partial.

## Later upstream commits

None. The pin remains `8ed276c246b624631e7d39241ebfd22d8314cb68`.
