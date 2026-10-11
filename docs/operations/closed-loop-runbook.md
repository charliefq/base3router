# Closed-loop queue

Status: **PREPARED**. The GitHub handoff updates `ops/execution-slot.json` on
branch `ops/base3-execution-slot` with the file's current blob SHA. Event
review holds that ledger for `base3-repair-20261011-02`. This Cursor run does
not read it, write it, release it, or recreate it. Mock tests are not that
ledger. Product recurring execution stays disabled by owner instruction.
Hosted ChatGPT reconciliation is the enabled review path named by the owner.
This run did not read either setting, so neither state is verified from
configuration. Paid provider pilots
stay **BLOCKED**. The end-to-end loop stays **UNVERIFIED** until a successor
is accepted and its reviewed delivery is observed.

Agent: <https://cursor.com/agents/bc-8d1b16a8-c6a0-431c-a643-681f4f36abd5>.

## Goal

Make GitHub review, then one Cursor implementation, then a GitHub result
reliable enough to rehearse. One repository execution slot admits one sender.
The product does not grow a second scheduler for this.

## Owner

The connected GitHub account on `charliefq/base3router` is the owner surface.
ChatGPT event review is the dispatcher. Hosted reconciliation is described as
enabled, and product recurring execution is described as disabled. This file
does not verify those settings. Hourly supervision is recovery only and does
not dispatch. Standing authorization covers routine engineering.
Merges, releases, paid-provider pilots, and account settings stay excluded.
This run does not enable a Cursor automation.

## Dependencies

- PR #23 stays the coordination thread:
  <https://github.com/charliefq/base3router/pull/23>
- Dispatch `base3-unattended-20261010-02` is not active. PR #22 comment
  [6104214316](https://github.com/charliefq/base3router/pull/22#issuecomment-6104214316)
  is still **REVIEW_READY**. Cloud agent
  `bc-b428813a-b3b5-45dd-ba61-1d5591398ee5` was **IDLE** when the closed-loop
  setup started and was not overlapped.
- Baseline for the setup: `f13055e307c28068cb4f21c87429bd27b0963215` on
  `cursor/v2-unattended-followup-02-8ee5`.
- This repair starts at PR #24 head
  `08e36ac02d78f3f9d18ad29bcc68652c4ce95232` on
  `cursor/closed-loop-slot-abd5`. That head stays put. The repair is a stacked
  draft whose base is that branch.
- Preserved heads: PR #18 `2a07e9e10a3aeeb95ce09dcdb7c8b234cc34afdf`, PR #20
  `55a1ea4f496eadea161c0e88822b375e42a0f127`, PR #21
  `b52026eab554ee4a5f4f4b20cac990c4355310fd`, PR #22
  `ffd2203305b8b66cd8dfb2d982d7bd09c7f9ff8e`, PR #23
  `f13055e307c28068cb4f21c87429bd27b0963215`, PR #24
  `08e36ac02d78f3f9d18ad29bcc68652c4ce95232`.
- Queue name `codex/unattended-work-queue-20261010`. The file
  `docs/operations/unattended-work-queue.md` is cited from the single-worker
  note and is not in this tree. This runbook is the durable queue record.

## Acceptance

Two independent readers of one blob version admit one writer. The other
receives HTTP 409 and does not send. Restart and an uncertain comment do not
send a second time. An existing branch whose slot file is missing or
unreadable stays blocked. The active slot stays until observed termination.
The queue and the result fields below are readable from GitHub. Event review
can follow the acquire, check, and finish steps with the Contents API.

A local mock does not meet this acceptance on the live repository. A
fast-forward git push is not the claim.

## Brake

One implementation worker. Two failed repair iterations per demonstrated
defect. Highlighter repair `base3-mobile-highlighter-repair-20261011-06` is
attempt 2 of 2. No merge, no push to `main`, no live paid
pilot, no signing or publication, no spend, auth, or credential change, and
no real user data. Spend remains **UNKNOWN**. Do not infer unlimited or
finite. Finish at `COMPLETED` or `STOPPED`. Do not auto-expire a claim and do
not dispatch the successor from the worker that wrote this file.

## Roadmap

Keep this order. This setup does not skip ahead and does not replace it.

1. V2 / ActionGate
2. Goal, redirect, acceptance, and brake
3. Tree usage and human acceptance
4. Bounded real validation
5. Evidence-based model, MCP, and skill routing
6. Later memory compression

PR #18 is the policy integration. PR #20 is the task contract. PR #21 is task
usage accounting. PR #22 and PR #23 are the unattended evidence and the
coordination thread. PR #24 is the first slot rehearsal. None of those heads
move for this repair.

## Dispatches

| Dispatch                                      | State                                                                                                                                                                    | Agent                                                               |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| `base3-unattended-20261010-01`                | Earlier packet. Agent IDLE.                                                                                                                                              | <https://cursor.com/agents/bc-0b48c998-6c41-4ef0-bbff-a5ce12a0d2e4> |
| `base3-unattended-20261010-02`                | **REVIEW_READY** in PR #22 comment 6104214316. Agent IDLE. Not overlapped.                                                                                               | <https://cursor.com/agents/bc-b428813a-b3b5-45dd-ba61-1d5591398ee5> |
| `base3-closed-loop-20261011-01`               | **COMPLETED** in PR #23 comment 6105316354. PR #24 head `08e36ac02d78f3f9d18ad29bcc68652c4ce95232`. Required Check failed.                                               | <https://cursor.com/agents/bc-8d1b16a8-c6a0-431c-a643-681f4f36abd5> |
| `base3-repair-20261011-02`                    | **COMPLETED** in PR #23 comment 6105520995. PR #25 head `a4541db95049ec595570afaa6a9f17aed9702310`.                                                                      | <https://cursor.com/agents/bc-8d1b16a8-c6a0-431c-a643-681f4f36abd5> |
| `base3-chat-agents-20261011-03`               | **COMPLETED** in PR #23. PR #26 head `00c007a12564f0a7945aec111dde027b7e60015a`. Ledger stays with event review.                                                         | <https://cursor.com/agents/bc-8d1b16a8-c6a0-431c-a643-681f4f36abd5> |
| `base3-chat-integration-20261011-04`          | **COMPLETED**. PR #27 head `9dc41f4e168af5cdc233751ae23e3e9e5e17b29b`. Ledger stays with event review.                                                                   | <https://cursor.com/agents/bc-8d1b16a8-c6a0-431c-a643-681f4f36abd5> |
| `base3-offline-pilot-brakes-20261011-05`      | **COMPLETED**. PR #28 head `b61d636411b774c7e6eea0dfe38a80f6ebb4cb76`. Required Check failed on the highlighter. Ledger stays with event review.                         | <https://cursor.com/agents/bc-8d1b16a8-c6a0-431c-a643-681f4f36abd5> |
| `base3-mobile-highlighter-repair-20261011-06` | **COMPLETED**. PR #29 head `975af300b65c66ea427cd79bc81a994ea53582d7`. Check 114416912510 succeeded. Test checkout was merge `aadc9bd885d114e7b8236655ac1c1da37bcee6da`. | <https://cursor.com/agents/bc-8d1b16a8-c6a0-431c-a643-681f4f36abd5> |
| `base3-brakes-active-restart-20261011-07`     | This slice. Active leases stop when a frozen bound is spent, including after a real database reopen. Ledger stays with event review.                                     | <https://cursor.com/agents/bc-8d1b16a8-c6a0-431c-a643-681f4f36abd5> |

## Checkpoints

- 2026-10-11T02:20Z supervision on PR #23 was read-only. It did not dispatch a
  worker. It recorded Task 4A artifact run 38103212139 on merge SHA
  `121ad71f24c54823ee96374771515a842413048e`, separate from the committed
  local binding `dd92cfa19cbd6701364c405ee3691bc3cbf5fedf`.
- Before this repair, the only cloud agent in `RUNNING`,
  `NOT_YET_STARTED`, or `WAITING_FOR_BACKGROUND_WORK` was
  `bc-8d1b16a8-c6a0-431c-a643-681f4f36abd5`.
- `scripts/ops-claim.mjs` still creates `refs/ops/claims/<taskId>` inside one
  local repository. That remains a per-task rehearsal. It is not this slot.
- `scripts/ops-slot.mjs` still rehearses a git lease against a local bare
  repo. That lease is not the GitHub handoff.

## Blockers

- Required `Check` run
  [38110398025](https://github.com/charliefq/base3router/actions/runs/38110398025)
  failed. Job `Check` is 114385418283. Job `Test` is 114384569050. The run's
  head SHA was `08e36ac02d78f3f9d18ad29bcc68652c4ce95232`. Checkout of that
  job was test-merge `10cfbd78858acde5b56ad87ced8464da14ef6a0b`, not the PR
  head. Slot and claim tests passed in that job. The missing `42` token was
  the 500ms tokenize cutoff, fixed in dispatch 06. See the highlighter note.
- `update_ref` `expected_sha` stays unverified and is not used. A
  fast-forward ref update can move a held slot.
- Account spend at <https://cursor.com/dashboard/spending> was not read.
  On-demand limit: **UNKNOWN**.
- Paid Auto/Manual pilots stay blocked. Token, dollar, and clock sentences
  are not enforced. The next offline item prepares those brakes. It does not
  run a pilot.
- Product recurring execution is disabled by owner instruction. Hosted
  ChatGPT reconciliation is the enabled review path named by the owner.
  Neither was read from configuration.
- The end-to-end loop is **UNVERIFIED**. A result comment is not a passed
  loop.

## Highlighter repair

Cold TypeScript highlighting on the JavaScript regex engine was stopping
mid-line. Shiki's default `tokenizeTimeLimit` is 500ms. vscode-textmate
checks that limit with `Date.now()` while the engine compiles long grammar
patterns, then the unfinished tail is appended to the last token.

Required Check
[38119865290](https://github.com/charliefq/base3router/actions/runs/38119865290)
job `Test` 114412195874 checked out test-merge
`eadf4c605e53f3a70ae1233b2fa8e5bc5946422f` and failed
`shikiReviewHighlighter.test.ts:68`: no token content was exactly `42`.
Run 38110398025 stopped on the red operator and produced one token
`= 42;`. Node `v24.21.0` on this machine finishes the same cold line in
about 140ms, so the separate `42` token (`#79C0FF`) appears. A fresh
highlighter with `tokenizeTimeLimit: 1`, and one whose `Date.now` advances
600ms per read under the 500ms default, returns a single token for the
whole line.

`highlightLines` and the incremental snippet pass `tokenizeTimeLimit: 0`,
vscode-textmate's unlimited value. Lines longer than 1000 characters still
skip the tokenizer. The cold test still requires source and snippet
equality, rejects a collapsed `= 42;` token, and requires `42` to be its
own colored token. This is repair attempt 2 of 2.

## Repository execution slot

One file for the whole repository:

- Branch: `ops/base3-execution-slot`
- Path: `ops/execution-slot.json`

The write is a Contents API update that names the blob SHA just read. GitHub
returns 409 when that SHA is stale. States are `CLAIMED`, `DISPATCHED`,
`UNCERTAIN`, and `TERMINAL`. Every transition increments `generation` and
sets a new `nonce`, so two equal JSON bodies are still different versions.

An absent branch is free. An existing branch whose file is missing, does not
parse, or is not a complete record is **blocked**. JSON `null`, a scalar, a
malformed object, and a `TERMINAL` object without observed `COMPLETED` or
`STOPPED` evidence are not free. Check does not call those free, and acquire
does not overwrite them. A complete `TERMINAL` record is the free state on a
branch that already has a valid file. Finish does not delete the branch and
does not start the next task.

`scripts/ops-contents-slot.mjs` is the injected transition helper. Tests pass
`createMockContentsRemote`. They do not call GitHub, do not read credentials,
and do not start a provider.

```sh
vp test run --config vite.config.ts --dir scripts scripts/ops-contents-slot.test.mjs
```

`scripts/ops-slot.mjs` remains the local git-lease rehearsal. Do not use
`git push --force-with-lease` as the handoff. A push that omits the lease can
steal a held ref, and the connector's `expected_sha` argument is not the
verified operation.

## Crash behavior

Exactly-once is not available. The Contents update can land and the process
can die before the comment returns. Prefer no automatic duplicate. Never
expire a claim and send again.

The GitHub `@cursor` dispatch comment is the provider start. There is no
separate acknowledgment comment and then a provider start.

| Point                    | What is written first                                                         | If the outcome is unknown                                                                                  |
| ------------------------ | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Acquire                  | `CLAIMED`, `dispatchCount` 0, new generation and nonce                        | Slot stays. A second writer with the old blob SHA gets 409.                                                |
| Reserve the one send     | `DISPATCHED`, `dispatchCount` 1, `commentDelivery` `started`, before the post | If this swap loses, do not post. If the process dies before the post, do not post later.                   |
| Dispatch comment         | One `@cursor` comment. That comment starts the worker.                        | On timeout or a missing response, move to `UNCERTAIN` when the blob SHA is still yours. Do not post again. |
| Returned comment URL     | A later update stores `commentUrl` and `commentDelivery` `confirmed`          | That update posts nothing. A lost update leaves `DISPATCHED`. Still do not post again.                     |
| Uncertain comment        | `UNCERTAIN`                                                                   | Do not call the comment API again. Do not hand the slot to anyone else.                                    |
| Restart of the holder    | Read only, same worker and same task                                          | `restart`. No new dispatch id and no second post.                                                          |
| Explicit termination     | `TERMINAL` plus observed `COMPLETED` or `STOPPED` and evidence                | Without that evidence the file does not move. Nobody is redispatched.                                      |
| Age                      | Ignored                                                                       | `maxAgeMs` is refused. There is no expiry.                                                                 |
| Missing file on a branch | Nothing                                                                       | `blocked`. Do not create a replacement file.                                                               |

`DISPATCHED` means the one comment may or may not exist. `UNCERTAIN` means
the post was attempted and the result was ambiguous. Both stay pinned.

## ChatGPT acquire, check, and finish

Event review does this with the GitHub Contents API. Repository:
`charliefq/base3router`. Coordination comments go on PR #23. Cursor workers
do not write this file. The reviewer alone finishes the live ledger after a
terminal result.

### Check

1. Read `ops/execution-slot.json` on `ops/base3-execution-slot`. Keep the
   blob SHA.
2. No branch: the slot is free.
3. The branch exists and the file is missing, unreadable, a read errors, or
   the JSON is not a complete record: blocked. Stop. Do not create the file.
   Do not overwrite it. Do not comment a new dispatch. Do not delete the
   branch.
4. A complete record whose `state` is other than `TERMINAL`: occupied. Stop.

### Acquire

Only after check says free.

Update the file with the blob SHA from check. Pass no blob SHA only when the
branch itself is absent and this create is the first hold. A 409 means you
lost. Read again. Do not retry against an occupied or blocked record.

The JSON for a new hold:

```json
{
  "schema": 1,
  "generation": 1,
  "nonce": "<unique>",
  "state": "CLAIMED",
  "taskId": "<dispatch id>",
  "workerId": "<one worker id>",
  "dispatchId": null,
  "dispatchCount": 0,
  "commentUrl": null,
  "commentDelivery": null,
  "termination": null
}
```

`generation` is one greater than the previous record, or 1 when there was
none. `nonce` changes on every write. Read the file back. Continue only when
`workerId` is yours and `state` is `CLAIMED`.

### Reserve, then one dispatch comment

1. From `CLAIMED` only, update to `DISPATCHED` with `dispatchCount` 1,
   `dispatchId` `<workerId>:<taskId>:1`, and `commentDelivery` `started`.
   Bump `generation` and `nonce`. Do this before posting.
2. If that update returns 409, do not post.
3. Post one PR comment that dispatches `@cursor`. That comment starts the
   provider. Do not post an acknowledgment comment first.
4. If the post returns a URL, update `commentUrl` and set `commentDelivery`
   to `confirmed`. That update is not a second send.
5. If the post times out or the response is missing, update to `UNCERTAIN`
   when you still have the blob SHA, then stop. Do not post again.
6. A later check that sees `DISPATCHED` or `UNCERTAIN` does not post and does
   not start another worker.

### Finish

Finish only after the worker result is on the coordination thread and
`worker_state` is the observed `COMPLETED` or `STOPPED`, with a non-empty
evidence link. Update to `TERMINAL` with that evidence, a new generation, and
a new nonce. Do not delete the branch. Do not acquire the next task in the
same step. Unknown termination stays pinned.

## Capability

- Contents `update_file` with the current blob SHA is callable. Event review
  verified it on the live ledger: accepted update commit
  `6d842b9d2dda17b604e81fa6e273e7d8af9c90a3`; stale blob SHA
  `9e49026fa755574f10b2ec2e434768b941aba899` rejected with HTTP 409; readback
  retained `2173026a2b8511dddf835ffd72dc652e1e560437`. That was one stale
  writer against a version that had already moved. It was not two clients
  racing from separate working copies.
- The mock in `scripts/ops-contents-slot.test.mjs` is the concurrent case:
  two readers of one version, one winner, one 409. Restart, an uncertain
  comment, a missing file, terminal release, and increasing generations are
  in that file. Those tests do not call GitHub.
- Connector `update_ref` `expected_sha` remains unverified. Calls that include
  it have failed with `InvalidActionArgumentsError`
  ([openai/codex#50987](https://github.com/openai/codex/issues/50987)). The
  handoff does not need that argument. A fast-forward update without it is
  not exclusive. `scripts/ops-slot.test.mjs` shows that push taking a held
  slot.
- The connector has no delete-ref tool
  ([openai/codex#41863](https://github.com/openai/codex/issues/41863)). This
  protocol does not need one. Release is `TERMINAL`.

## CL-1 evidence

Event review acquired the live slot before this repair. Cursor did not create
it and must not change it.

| Field                  | Value                                      |
| ---------------------- | ------------------------------------------ |
| Branch                 | `ops/base3-execution-slot`                 |
| Path                   | `ops/execution-slot.json`                  |
| CLAIMED commit         | `6e3c77b9593edd2c0208b268ffffc8e0353a651d` |
| DISPATCHED reservation | `76269015160958dcbd02f36dbfe5d77d567af746` |
| Owner                  | `event-review:base3-repair-20261011-02`    |
| dispatchCount          | 1                                          |

No second worker was sent for that reservation. This repair is that one
dispatch. The reviewer finishes the ledger only after this worker posts an
explicit `COMPLETED` or `STOPPED`. A missing termination leaves the slot
pinned.

Required Check run 38110398025 failed on test-merge
`10cfbd78858acde5b56ad87ced8464da14ef6a0b`. That failure is recorded above.
It is not accepted by the slot tests that passed in the same job.

## Result protocol

The worker posts a new PR #23 comment. It does not edit an older result.
`worker_state` is `COMPLETED` or `STOPPED`.

```text
dispatch_id: <dispatch id>
worker_state: COMPLETED
starting_sha: <verified start>
final_sha: <branch head>
branch: <stacked branch>
pr: https://github.com/charliefq/base3router/pull/<stacked>
evidence_links: <runbook, tests, agent URL>
ci_workflow: Check
ci_run: <workflow run URL>
checkout_sha: <SHA the checker actually ran>
unresolved_blockers:
- <one line each>
suggested_next_task: <not launched>
```

`ci_workflow` is the `Check` job in `.github/workflows/ci.yml`. `checkout_sha`
is the SHA that job checked out. It can be a test merge and differ from the
PR head. Say which is which. A failed `Check` stays a blocker.

Bot-only completion comments are not a guaranteed event trigger. Link the
stacked PR on PR #23 as soon as it exists.

## Next task

`base3-brakes-active-restart-20261011-07` is the current slice. Frozen tree
bounds survive omission and a reopened database. A usage update or startup
recovery can interrupt an occupied lease without another admission. Chat
execution stays deny, and Grokbot stays not connected. Remaining product gaps
are in [the chat-agents note](../internals/chat-agents.md). The provider still
has no remaining-budget ceiling, so one turn can report past the cap.
`OPS-CLOSED-LOOP-RECONCILER` is next and is not started here. This worker does
not dispatch it.

ChatGPT finishes the current ledger only after the terminal result, then
acquires a new hold before any later send. A missing or unreadable slot file
stays blocked. The loop stays **UNVERIFIED** until a successor is accepted
and its reviewed delivery is observed.
