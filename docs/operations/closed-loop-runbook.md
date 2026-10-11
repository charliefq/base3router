# Closed-loop coordination

The repository contains an **offline** reconciliation kernel in
[`scripts/ops-reconciler.mjs`](../../scripts/ops-reconciler.mjs). It has no
GitHub client, worker launcher, CLI, scheduler, or credential access. Event
and periodic callers use the same `reconcile` operation with injected
adapters. Neither entrypoint grants additional dispatch authority.

The current handoff index is [PR #31](https://github.com/charliefq/base3router/pull/31).
[PR #23](https://github.com/charliefq/base3router/pull/23) contains the historical
worker and review evidence. Repository discovery in the kernel paginates PRs
and comments; it does not use either PR number as a discovery filter.

## Boundaries

This implementation is tested with fake GitHub, reviewer, and worker adapters
and disposable file-backed slots. No real coordination entrypoint imports it.
No hosted automation or product recurring-execution setting is changed or
verified by these tests. Mock cycles are not evidence of live worker execution,
automatic review wakeups, or a completed live closed loop.

The shared ledger remains `ops/execution-slot.json` on
`ops/base3-execution-slot`. Its existing holder must not be expired, replaced,
or released just because its status is old. A worker's terminal report and a
successful repair by another worker are different evidence. The coordinating
reviewer must establish the old holder's actual termination separately.
Implementation workers do not mutate that live ledger.

No Cursor integration, merge, release, signing, paid provider call, credential
change, or new scheduler belongs to this slice. Provider budget ceilings,
silent-deadline enforcement, live Grokbot connectivity, and executable chat
collaboration remain separate product work; see
[chat-agents](../internals/chat-agents.md). Offline coordination tests do not
remove those limitations.

## Durable transitions

The kernel reuses `recordValid` and the Contents helper's blob-SHA
`read`/`compareAndSwap` contract. It requires an existing valid slot; it does
not bootstrap an absent or corrupt live ledger. Each write increments
`generation`, changes `nonce`, and appends history. A stale version loses the
CAS and cannot review or send. Async adapters are supported.

The additive `coordination` field stores result identities, publication and
CI checkpoints, technical review ownership/receipts, and the current successor
intent. History retains prior dispatch intents and receipts across rollover.
Unrelated ledger extensions are preserved. Current scope, starting SHA,
branch, dependencies, and worker identity come from the explicitly supplied
next task; old CI, result checkpoint, provider/ack and review fields are reset.
Predecessor result evidence is stored separately from the new task.

| Observation                                          | Durable behavior                                                                                               |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| No matching terminal report                          | Keep holder; return `NO_RESULT`. Age is irrelevant.                                                            |
| Valid report before its commit is published          | Store `PUBLICATION_WAIT`.                                                                                      |
| Matching publication, required CI not complete       | Store `CI_WAIT`; either entrypoint can resume it.                                                              |
| Required CI succeeds on the bound head/checkout      | CAS one technical review owner and request ID.                                                                 |
| Review is missing or its response was lost           | Query that request ID; do not repeat the review call or send.                                                  |
| Explicit technical rejection                         | Store `CHANGES_REQUIRED`; no successor.                                                                        |
| Explicit technical acceptance                        | Store receipt and terminal worker evidence; check successor dependencies.                                      |
| One eligible successor                               | Recheck publication/CI, then CAS fresh task metadata and a one-send intent before calling the injected worker. |
| Start response is lost, or process dies after intent | Keep `DISPATCHED`/`UNCERTAIN`; query existing start by dispatch ID, never resend.                              |
| Matching start receipt found                         | Record confirmation without another start.                                                                     |

A crash after reservation but before the call may leave a task that never
started. This is deliberate at-most-once behavior, not an exactly-once
promise. Absence of a receipt cannot distinguish that crash from a lost
response. An operator must investigate; there is no expiry or automatic retry.

Malformed state, conflicting results, changed task bindings, unknown
termination, wrong SHA/CI, unaccepted dependencies, and invalid receipts fail
closed. A CI result is never a technical review decision. Both the reviewer
receipt and the current required CI must match the delivered SHA before a
successor can be reserved.

## Adapter contract for offline callers

`reconcile` receives `source` (`event` or `periodic`), `ownerId`, `tasks`, and
four injected interfaces. Tests provide all of them; there is no default live
adapter.

- `remote.read()` returns a validated record and blob SHA;
  `compareAndSwap({ expectedBlobSha, record })` commits only that version.
- `github.listPullRequests({ cursor })` and
  `listComments({ prNumber, cursor })` return `{ items, nextCursor }`, ending
  with `nextCursor: null`. Discovery must include all relevant PR states and
  comments, including bot comments. Repeated cursors/read failures block the
  iteration rather than pretending discovery is complete.
- `github.getPullRequest(number)` supplies current branch/base names, head,
  base SHA, and test-merge SHA. `getPublication({ branch, sha })` supplies the
  commit's **first publication evidence**, not its author/committer date or
  the time a poll happened to notice it. A missing publication returns `null`.
- `github.getCI({ prNumber, headSha })` supplies the configured required
  workflow/check, run identity/URL, status/conclusion, and actual checkout.
  A merge checkout must match the PR's test merge and have the exact head and
  base as its two parents. A direct-head checkout is also valid. Returning an
  unrelated green check cannot satisfy this gate.
- `reviewer.review({ ownerId, requestId, key, packet, ci })` supplies an
  explicit technical receipt (`ACCEPTED` or `CHANGES_REQUIRED`) bound to the
  request ID, owner, result key and head SHA, with evidence.
  `findReview(requestId)` recovers that receipt after a lost response.
- `worker.start(intent)` represents one offline fake send.
  `findStart(dispatchId)` returns an existing receipt bound to dispatch ID,
  task, worker, starting SHA and evidence URL. No receipt means no retry.

Task bindings are coordinator input, never authority supplied by comment text.
Each specifies `id`, `workerId`, `resultAuthorId`, `branch`, `baseBranch`,
`scope`, `startingSha`, `requiredCI: { workflow, check }`, `predecessor`, and
exact `{ taskId, sha }` dependencies. More than one successor is ambiguous and
blocked. A successor must depend on its accepted predecessor's exact SHA.

The offline parser consumes JSON comment bodies with `kind:
"implementation_result"`, `taskId`, `workerId`, `branch`, `startingSha`,
`finalSha`, `prNumber`, `workerState`, `classification`, `predecessor`, and
`dependencies`. It verifies the comment author against the task binding.
Legacy free-form PR result text needs an independently reviewed adapter before
live use; this slice does not interpret it as authorization.

`workerState` is `COMPLETED` or `STOPPED`. Only completed, technically accepted
work can progress. `classification` is `code` or `no_code`. Code results must
precede first publication; a no-code result must name its exact unchanged
starting SHA and may reference an earlier publication. CI and technical review
are still required. Result identity includes task, SHA and comment ID;
semantically identical duplicate comments or wording-only edits do not create
a second review. Changes to a recorded delivery binding block reconciliation.

## Verification

Run the focused offline checks from the repository root:

```sh
node_modules/.bin/vp test run --config vite.config.ts --dir scripts scripts/ops-reconciler.test.mjs scripts/ops-contents-slot.test.mjs
node_modules/.bin/vp lint scripts/ops-reconciler.mjs scripts/ops-reconciler.test.mjs
```

The tests reopen independent facades over temporary files after every call.
The test store uses an exclusive CAS lock and atomic rename. Scenarios cover
two result-before-publication/delayed-CI cycles, event/periodic races, lost
review/start receipts, a crash after intent commit, pagination, bot-only and
no-code completion, duplicate/edited results, invalid state, and mismatched
SHA/dependencies/receipts. External fake services retain their own receipts
while the coordinator is reopened, as an external service would.

`scripts/ops-claim.mjs` and `scripts/ops-slot.mjs` remain local git rehearsals.
A local ref or ordinary fast-forward push does not replace the shared Contents
CAS. Existing Contents-helper tests remain separate from live HTTP 409 proof.

## Before real integration

The coordinator owner must resolve the existing holder using independent
terminal evidence, agree the authoritative task/technical-review inputs, and
review real read/receipt adapters and result normalization. Event and periodic
entrypoints must share this same state machine and slot. Neither this offline
PR nor green CI authorizes enabling those entrypoints or starting another
worker. Publish real cycle evidence separately from fixture results.
