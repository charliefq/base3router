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

### B3R-05A: disabled evidence adapters

`scripts/ops-evidence-adapters.mjs` is a contract boundary, not an installed
GitHub integration. It has no HTTP implementation, credential access, CLI,
scheduler, or default transport. Tests inject synthetic REST responses from
`scripts/testFixtures/ops-github-evidence.json`; fixture values are not live
cycle evidence. The read facade constructs GET requests only. Contents CAS,
technical review submission, and worker start always throw
`offline-write-disabled`; there is no enable flag. The Contents request planner
and receipt journal updater return data without sending or writing it.

The normalizers follow these GitHub contracts:

- [PRs](https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request) supply
  head/base refs and SHAs. Discovery requests all PR states; evidence evaluation
  currently rejects closed/merged and fork PRs instead of guessing their merge
  semantics. A null test-merge SHA cannot validate a merge checkout.
- [Issue comments](https://docs.github.com/en/rest/issues/comments) supply numeric
  `user.id`, comment ID, URL and timestamps. Task authority must bind that ID;
  login, bot status, author association and body claims are not authorization.
  Native JSON result bodies remain unchanged. Recognized legacy key/value report
  markers block with `legacy-result-format-unapproved`; other prose remains
  opaque. Legacy/Markdown reports need an explicit approved format before they
  can authorize a transition; this is not a general legacy parser.
- [Pagination](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api)
  uses Link headers. The fixture adapter rejects foreign hosts/repositories,
  changed query scopes, skipped/repeated pages, malformed headers and failed
  reads. It does not follow arbitrary returned URLs. GET-only is not a promise
  of an atomic repository snapshot while comments or PRs change.
- [Workflow runs](https://docs.github.com/en/rest/actions/workflow-runs),
  [jobs](https://docs.github.com/en/rest/actions/workflow-jobs) and
  [checks](https://docs.github.com/en/rest/checks/runs) bind configured repository,
  workflow ID/path, app ID, check name, run attempt, job/check relation and head.
  API metadata alone does not prove the job's actual checkout. `normalizeCI`
  returns unknown without checkout evidence; its only accepted checkout input
  is explicitly synthetic and its output is labeled `fixture-only`. Tests bind
  exact head or test-merge SHA and both parent SHAs. The read facade's `getCI`
  remains blocked; no fixture result is wired into real acceptance.
- [Contents](https://docs.github.com/en/rest/repos/contents) supplies base64 bytes
  and the current blob SHA. Reads validate bytes, Git blob digest and slot schema.
  A 404 means missing or inaccessible, never permission to recreate a slot.
  Pure update plans require the expected blob SHA, next generation and changed
  nonce. Response fixtures distinguish 409 conflict, 422 validation rejection,
  unknown response and a matching successful content receipt. These are not
  live CAS or permission tests; the slot schema check is not a substitute for
  the reconciler's coordination and ownership validation.

First publication remains `unknown`: commit dates, polling timestamps and one
push event do not establish that a SHA was never published earlier. The owner
must approve a durable publication evidence source or revise the protocol;
the adapter cannot fabricate this field. Actual checkout similarly needs a
reviewed provenance source bound to the run attempt, not a comment claiming it.

Receipt journal entries bind review request ID to owner/result/head, or dispatch
ID to task/worker/starting SHA. Pending and uncertain entries never become a
confirmed receipt merely because time passed. Changed bindings, duplicate keys,
conflicting confirmations and state regressions fail closed. Tests reopen a
temporary file to recover a confirmed mapping without another send. Production
journal storage, CAS, signer/author verification and retention are not provided;
the injected store and binding map are trusted inputs, not evidence that an
arbitrary file or receipt is authentic. There is no guessed Codex cloud API.

The dot/main-thread coordinator can hand work to its existing Codex task. That
platform capability and identity do not give this repository a worker launcher.
The local Codex app-server provider is another execution path, not an automatic
bridge to dot's cloud task. GitHub comments are records, not a demonstrated Codex
wakeup mechanism. Choosing an executor and proving its start/lookup/auth contract
remain B3R-05 decisions; provider execution verification remains B3R-06.

Before any live wiring, independently resolve the old holder, approve result
and technical-review identities, publication and checkout provenance, receipt
storage and executor authentication, then separately authorize writes and
dispatch. This slice changes none of those decisions and does not enable chat
execution, which remains DENY.

Run the three offline script suites together:

```sh
node_modules/.bin/vp test run --config vite.config.ts --dir scripts scripts/ops-evidence-adapters.test.mjs scripts/ops-reconciler.test.mjs scripts/ops-contents-slot.test.mjs
```

The coordinator owner must resolve the existing holder using independent
terminal evidence, agree the authoritative task/technical-review inputs, and
review real read/receipt adapters and result normalization. Event and periodic
entrypoints must share this same state machine and slot. Neither this offline
PR nor green CI authorizes enabling those entrypoints or starting another
worker. Publish real cycle evidence separately from fixture results.

## B3R-05C read-only GitHub evidence collector

`scripts/ops-github-evidence-collector.mjs` exports `collectGitHubEvidence`.
It requires an injected `readTransport` and explicit repository name/ID, PR,
expected head/base SHAs, workflow ID/name/path, run ID/attempt, required check
ID/name/app ID/job ID, a separate actual test job ID, an `actualTestStep` with
the exact trusted step `name` and positive `number`, and comment ID/author ID/
body SHA-256 bindings. Those bindings are trusted caller inputs, not a role
authorization policy. There is no default transport, credential discovery, CLI,
scheduler, provider invocation, reconciler integration, or write path.

The transport receives `{ method: "GET", path, query, format }` and returns
`{ status, headers, complete, data }`. Paths are constructed within the supplied
repository. `format` is `json` or `text`; `complete: true` is the transport's
explicit assertion that the entire response was delivered, not a native GitHub
API field. A transport must not assert completeness for capped or partial tool
output. Redirects and partial responses are unusable; the collector never
follows a returned external URL. Its tests inject synthetic REST envelopes and
sanitized checkout logs, not a production authenticated transport.

Evidence separates PR metadata, raw comment envelopes, workflow run, aggregate
required check, actual job/check status, actual test step, checkout, publication observation, and closing
stability reads. Each part is `verified`, `unknown`, or `blocked` with a reason;
an overall verified result means only that these observations match the supplied
bindings. It is not an acceptance, review, dispatch, or execution permission.
Comment envelopes preserve numeric author IDs, created/updated timestamps, raw
bodies, and body digests. Bound edited comments fail closed even when their
current digest matches; comment creation time is never a body-version proof.

The required aggregate check does not establish checkout or test execution.
`actualJob` preserves successful job/check status bound to the run attempt and
check suite. `actualTestJob` additionally requires exactly one step matching both
the caller's name and number, with completed/success status. Missing, skipped,
failed, pending or duplicate/ambiguous step identities cannot verify that part.
The caller must bind the reviewed workflow's actual test step; a name alone does
not establish what commands it runs. This is GitHub step-status observation,
not execution attestation, proof of test counts, or a log-echo inference.

Checkout is evaluated independently from the Test step and requires a successful
Checkout step. A skipped Test can therefore leave checkout verified while the
overall bundle and actual test evidence are unverified. Conversely, successful
Test status does not repair missing checkout logs.
Its complete log must contain one checkout group/command, one short-SHA HEAD
marker, one full-SHA `git log -1 --format=%H` result, and a following step boundary.
The action start, checkout command, HEAD marker, git-log command and full SHA
must occur in that order, all before the first subsequent Run group. Their log
timestamps must be ordered and fall inside the successful Checkout step's REST
start/end times (compared at the API's second precision). Missing step times or
markers supplied across another step fail closed; a later arbitrary echo cannot
fill missing checkout evidence. Text markers alone do not establish provenance:
the caller must trust the workflow and authentic complete job-log transport.
The full SHA must be the expected head or the PR test-merge with exactly the
expected head/base parents. These job-log observations are not cryptographic
attestations and still depend on the reviewed workflow and transport. Missing,
ambiguous or truncated logs, stale attempts, mismatched identities, failed
pagination and inaccessible resources leave evidence blocked or unknown.

Closing reads compare metadata and all comment pages with their initial
snapshots. Two matching reads reduce unnoticed change but do not provide an
atomic snapshot or prevent changes afterward. Publication records only that
the expected SHA was observed published on the PR branch at the read time.
There is no `firstPublishedAt`, and neither commit dates nor comment timestamps
establish first publication. Existing live-holder, identity, provenance,
receipt-store and executor decisions remain unresolved by this collector.

Run the four related offline suites together:

```sh
node_modules/.bin/vp test run --config vite.config.ts --dir scripts scripts/ops-github-evidence-collector.test.mjs scripts/ops-evidence-adapters.test.mjs scripts/ops-reconciler.test.mjs scripts/ops-contents-slot.test.mjs
```

## B3R-05E explicit HTTP read transport

`scripts/ops-http-read-transport.mjs` exports `createHttpReadTransport`. Callers
must inject a trusted standards-compatible `fetch`, repository, and exact
`allowedPaths`. Optional request headers are copied; only Accept, Authorization,
X-GitHub-Api-Version and User-Agent are supported. No token, environment, CLI,
cookie jar or default fetch is discovered. A path capability is an additional
local restriction, never an authorization grant or a connector allowlist bypass.
The current connector's rejected direct-job endpoint remains blocked.

Only GET requests to supported resources beneath that repository on
`https://api.github.com` are constructed. Only positive integer page/per_page
queries are accepted. The caller configures a bounded decoded-body size (8 MiB
default, 64 MiB maximum) and timeout (30 seconds default, 5 minutes maximum).
An abort timer remains active for asynchronous waits. Monotonic deadline checks
also run after fetch, around stream reads, after joining/decoding/parsing, and
immediately before returning. Synchronous work cannot be preempted by a timer,
but work that exceeds the deadline cannot return complete evidence afterward.
Actual Response status and headers, including Link, are preserved. The transport
never follows Link itself; existing pagination validation constructs subsequent
requests. It rejects normalized objects pretending to be Response instances.

`complete: true` means the Response stream reached EOF within the limits and
UTF-8 decoding plus requested JSON parsing succeeded. It does not mean HTTP
success: 403/404/429 remain those statuses. Partial responses, interrupted streams,
oversize bodies, invalid UTF-8/JSON and identity Content-Length mismatches throw
fixed reasons without exposing upstream errors or credentials. Content-Encoding
tokens are trimmed and case-normalized; supported tokens are identity, gzip,
deflate and br. Missing encoding or only identity tokens requires an exact
Content-Length match. For content-encoded responses, the injected fetch must
correctly decode and reject truncated wire bodies. `maxBytes` always bounds the
decoded stream, not the declared compressed wire length; no independent wire-byte
cap is claimed. A compressed wire length larger than maxBytes does not reject an
otherwise bounded decoded body. A clean
EOF without a declared length cannot establish an application's semantic
completeness, so this is a transport guarantee, not an attestation.

Redirect policy is explicitly **reject all**, including same-origin redirects.
Requests use `redirect: "manual"` and `credentials: "omit"`; an explicit
Authorization header is sent only to the constructed GitHub API URL. Redirect
targets are neither followed nor given credentials. Already-followed responses,
opaque redirects and source URL mismatches fail closed. Consequently GitHub job
log download redirects remain unusable until a separately reviewed safe download
capability exists. A malicious injected fetch cannot be made trustworthy by
checking its response afterward; dependency and runtime policy remain trusted.

Tests use real controlled Response/ReadableStream objects and synthetic headers,
with no private GitHub or provider calls. This adds a future compliant HTTP
environment's transport implementation; it does not resolve B3R-05D's current
connector/header/permission or edited-comment blockers, and does not establish a
live closed loop. Add `scripts/ops-http-read-transport.test.mjs` to the four-suite
command above to run all five related suites. Independent review precedes the
next receipt-persistence slice; green CI alone is not project completion.
