# Closed-loop queue

Status: **PREPARED**. The shared-slot script is covered by local tests. Those
tests are not an operational claim, and this run did not create
`refs/heads/ops/base3-execution-slot` on GitHub. Recurring Cursor automation
stays **DISABLED**. Paid provider pilots stay **BLOCKED**.

Dispatch `base3-closed-loop-20261011-01` is this setup. Agent:
<https://cursor.com/agents/bc-8d1b16a8-c6a0-431c-a643-681f4f36abd5>.

## Goal

Make GitHub review, then Cursor implementation, then a GitHub result reliable
enough to rehearse. One repository execution slot has to admit one sender.
The product orchestrator does not grow a second scheduler for this.

## Owner

The connected GitHub account on `charliefq/base3router` is the owner surface.
ChatGPT event review for PR #23 is the dispatcher. Hourly supervision is
recovery only and does not dispatch. This run does not enable a Cursor
automation.

## Dependencies

- PR #23 stays the coordination thread:
  <https://github.com/charliefq/base3router/pull/23>
- Dispatch `base3-unattended-20261010-02` is not active. PR #22 comment
  [6104214316](https://github.com/charliefq/base3router/pull/22#issuecomment-6104214316)
  is still **REVIEW_READY**. Cloud agent
  `bc-b428813a-b3b5-45dd-ba61-1d5591398ee5` was **IDLE**, not RUNNING, when
  this dispatch started.
- Baseline `f13055e307c28068cb4f21c87429bd27b0963215` on
  `cursor/v2-unattended-followup-02-8ee5`.
- Preserved heads: PR #18 `2a07e9e10a3aeeb95ce09dcdb7c8b234cc34afdf`, PR #20
  `55a1ea4f496eadea161c0e88822b375e42a0f127`, PR #21
  `b52026eab554ee4a5f4f4b20cac990c4355310fd`, PR #22
  `ffd2203305b8b66cd8dfb2d982d7bd09c7f9ff8e`, PR #23
  `f13055e307c28068cb4f21c87429bd27b0963215`.
- Queue name `codex/unattended-work-queue-20261010`. The file
  `docs/operations/unattended-work-queue.md` is cited from the single-worker
  note and is not in this tree. This runbook is the durable queue record.

## Acceptance

Distinct working copies admit one sender. Restart and an uncertain send do
not send a second time. The active slot stays until the holder finishes with
established termination. The queue and the result fields below are readable
from GitHub. Event review can follow the acquire, check, and finish steps.
Local tests do not by themselves meet this acceptance on the live repository.

## Brake

One implementation worker. Two failed repair iterations per defect. No merge,
no push to `main`, no live paid pilot, no signing or publication, no spend,
auth, or credential change, and no real user data. Spend remains **UNKNOWN**
unless a run actually reads it. Do not infer unlimited or finite. Finish at
`COMPLETED` or `STOPPED`. Do not auto-expire a claim and do not dispatch the
successor from the worker that wrote this file.

## Roadmap

Keep this order. This setup does not skip ahead and does not replace it.

1. V2 / ActionGate
2. Enforced task contracts
3. Tree usage and human acceptance
4. Bounded real validation
5. Evidence-based model, MCP, and skill routing
6. Memory compression

PR #18 is the policy integration. PR #20 is the task contract. PR #21 is task
usage accounting. PR #22 and PR #23 are the unattended evidence and this
coordination thread. None of those heads move for this setup.

## Dispatches

| Dispatch                        | State when this run started                                                             | Agent                                                               |
| ------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `base3-unattended-20261010-01`  | Earlier packet. Agent IDLE.                                                             | <https://cursor.com/agents/bc-0b48c998-6c41-4ef0-bbff-a5ce12a0d2e4> |
| `base3-unattended-20261010-02`  | **REVIEW_READY** in PR #22 comment 6104214316. Agent IDLE, not RUNNING. Not overlapped. | <https://cursor.com/agents/bc-b428813a-b3b5-45dd-ba61-1d5591398ee5> |
| `base3-closed-loop-20261011-01` | This setup.                                                                             | <https://cursor.com/agents/bc-8d1b16a8-c6a0-431c-a643-681f4f36abd5> |

## Checkpoints

- 2026-10-11T02:20Z supervision on PR #23 was read-only. It did not dispatch a
  worker. It recorded Task 4A artifact run 38103212139 on merge SHA
  `121ad71f24c54823ee96374771515a842413048e`, separate from the committed
  local binding `dd92cfa19cbd6701364c405ee3691bc3cbf5fedf`.
- This run re-read the five preserved heads before editing. They matched.
- `scripts/ops-claim.mjs` still creates `refs/ops/claims/<taskId>` inside one
  local repository. That remains a per-task rehearsal. It is not this slot.

## Blockers

- ChatGPT's GitHub connector does not currently expose a working
  compare-and-swap. See the capability gap below. Until event review can run
  that operation, it must not dispatch the successor.
- The slot ref was not created on `charliefq/base3router`. Local bare-repo
  tests are not that ref.
- Account spend at <https://cursor.com/dashboard/spending> was not read.
  On-demand limit: **UNKNOWN**.
- Paid Auto/Manual pilots stay blocked. Token, dollar, and clock sentences
  are not enforced.
- Recurring Cursor automation stays off. It is not required for this handoff.
- `scripts/ops-slot.mjs` is not installed on a path that every GitHub comment
  must pass through. The procedure below is the requirement. A comment that
  skips it is not a claim.

## Repository execution slot

One ref for the whole repository:

`refs/heads/ops/base3-execution-slot`

The commit at that ref stores `ops/execution-slot.json`. States are
`CLAIMED`, `ACK_STARTED`, `ACKED`, `DISPATCHED`, `UNCERTAIN`, and `TERMINAL`.
Anything other than `TERMINAL`, including a missing or unreadable file on an
existing ref, stays occupied. Check never releases it.

`scripts/ops-slot.mjs` implements the transitions. Each caller has its own
work directory. The only shared state is the remote. The update is:

```sh
git push --force-with-lease=refs/heads/ops/base3-execution-slot:<expected> \
  origin <new>:<ref>
```

`<expected>` is the SHA just read, or forty zeros when the ref is absent.
Git rejects the push when the remote ref is no longer that value. The loser
does not send. The script does not delete the ref. `TERMINAL` is the free
state, and the next acquire is a new lease from that commit. That next
acquire has `dispatchCount` 0. Finish does not start it.

Rehearse against a local bare repo:

```sh
node scripts/ops-slot.mjs init --remote /tmp/slot.git
node scripts/ops-slot.mjs acquire --remote /tmp/slot.git --work /tmp/copy-a --task queue-item --worker worker-a
node scripts/ops-slot.mjs check --remote /tmp/slot.git --work /tmp/copy-a
node scripts/ops-slot.mjs acknowledge --remote /tmp/slot.git --work /tmp/copy-a --worker worker-a
node scripts/ops-slot.mjs start --remote /tmp/slot.git --work /tmp/copy-a --worker worker-a
node scripts/ops-slot.mjs finish --remote /tmp/slot.git --work /tmp/copy-a --worker worker-a \
  --worker-state COMPLETED --termination-evidence https://github.com/charliefq/base3router/pull/23
```

Focused test:

```sh
vp test run --config vite.config.ts --dir scripts scripts/ops-slot.test.mjs
```

A fast-forward `git push` that omits the lease can move a held slot. The test
records that failure mode. Do not use it as the claim.

## Crash behavior

Exactly-once is not available. The remote can accept a compare-and-swap and
the process can die before the comment or the provider call returns. Prefer
no automatic duplicate.

| Point                  | What is written first                                   | If the outcome is unknown                                                                        |
| ---------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Claim before comment   | `CLAIMED` on the remote, then the comment may be posted | Slot stays. No second claim. No provider yet.                                                    |
| Comment acknowledgment | `ACK_STARTED`, then one post                            | Leave `ACK_STARTED` or `ack.delivery` `uncertain`. Do not post again. Do not start the provider. |
| Confirmed comment      | `ACKED` with the comment URL                            | A later `confirmAck` may record a URL the reviewer can already see. That call does not post.     |
| Provider start         | `DISPATCHED` with `dispatchCount` 1, then one send      | A crash before the send drops the send. A crash after the send must not send again.              |
| Uncertain send         | `UNCERTAIN` when the sender reports an ambiguous result | Do not call the sender again. Do not hand the slot to anyone else.                               |
| Restart of the holder  | Read only                                               | Same worker and same task: `restart`, no new dispatch id.                                        |
| Explicit termination   | `TERMINAL` plus `COMPLETED` or `STOPPED` and evidence   | Without that evidence the ref does not move. Nobody is redispatched.                             |
| Age                    | Ignored                                                 | `maxAgeMs` is refused. There is no expiry.                                                       |

`ACK_STARTED` means a comment may or may not exist. `DISPATCHED` means a
provider call may or may not have left this process. `UNCERTAIN` means the
call was attempted and the result was ambiguous. All three stay pinned.

## ChatGPT acquire, check, and finish

Event review does this with its GitHub connector. This Cursor run cannot see
that connector's live tool list. The names below are the operations public
connector reports expose. If a named compare-and-swap is missing, stop and
report the gap. Do not dispatch.

Repository: `charliefq/base3router`. Coordination comments go on PR #23.
Branch name: `ops/base3-execution-slot`. File: `ops/execution-slot.json`.

### Check

1. Read `ops/execution-slot.json` on `ops/base3-execution-slot`. Keep the
   commit SHA and, for a file update, the blob SHA.
2. No branch, or a branch with no such file: the slot is free.
3. `state` other than `TERMINAL`, or a file that does not parse: occupied.
   Stop. Do not comment a new dispatch. Do not delete the branch.
4. A read error: occupied. Stop.

### Acquire

Only after check says free.

Use one of these writes. Both name the value you just read and fail when it
has changed.

- Contents API file update. Create the file when it is absent. Update it when
  `state` is `TERMINAL`, passing the blob SHA from check. A 409 or an
  "already exists" result means you lost. Read again. Do not retry against an
  occupied record.
- GraphQL `updateRefs` with `beforeOid`. Build one commit that contains the
  JSON. `beforeOid` is the current commit SHA, or forty zeros when the ref is
  absent. `afterOid` is the new commit. `force` is false. A rejected ref
  means you lost.

The JSON for a new hold:

```json
{
  "schema": 1,
  "state": "CLAIMED",
  "taskId": "<dispatch id>",
  "workerId": "<one worker id>",
  "dispatchId": null,
  "dispatchCount": 0,
  "ack": null,
  "provider": null,
  "termination": null
}
```

Read the file back. Continue only when `workerId` is yours and `state` is
`CLAIMED`.

### Comment, then provider

1. Compare-and-swap `CLAIMED` to `ACK_STARTED` before posting.
2. Post one PR #23 comment that names the dispatch id and the worker URL.
3. If the post returns a URL, compare-and-swap to `ACKED` and store that URL.
4. If the post times out or the response is missing, stop. Do not post again.
   If you can later see that single comment URL and the state is still
   `ACK_STARTED`, you may compare-and-swap to `ACKED` with that URL. That
   confirmation posts nothing.
5. From `ACKED` only, compare-and-swap to `DISPATCHED` with `dispatchCount`
   1 and `dispatchId` `<workerId>:<taskId>:1` before starting the worker.
6. If that swap loses, do not start a worker.
7. If the worker start's result is unknown, compare-and-swap to `UNCERTAIN`
   when you still have the expected SHA, then stop. A later check that sees
   `DISPATCHED` or `UNCERTAIN` does not start another worker.

### Finish

Finish only after the worker result is on PR #23 and includes `worker_state`
`COMPLETED` or `STOPPED` plus a non-empty evidence link. Compare-and-swap to
`TERMINAL` with that evidence. Do not delete the ref. Do not acquire the next
task in the same step.

## Capability gap

Inspected from GitHub's public API and from open connector reports. This run
did not call the connector.

- GitHub GraphQL `updateRefs` accepts `beforeOid` and applies the batch
  atomically. Forty zeros means the ref must be absent. That is the
  compare-and-swap this slot wants. The connector does not expose it as a
  working argument.
- Connector `update_ref` advertises `expected_sha`. Calls that include it
  fail with `InvalidActionArgumentsError` and do not move the branch
  ([openai/codex#50987](https://github.com/openai/codex/issues/50987), open,
  reproduced 2026-10-04). The same call without `expected_sha` and with
  `force` false is only a fast-forward update.
- A fast-forward update is not exclusive. A second client can parent a commit
  on the winner and push. `scripts/ops-slot.test.mjs` shows that push taking
  the slot. REST "Update a reference" has `sha` and `force`. It has no
  expected-SHA field.
- The connector can create branches, blobs, trees, commits, files, and pull
  requests. It has no delete-ref tool
  ([openai/codex#41863](https://github.com/openai/codex/issues/41863)). This
  protocol does not need one. Release is `TERMINAL`.
- A contents PUT that requires the current blob SHA is the other atomic write
  ([create or update file contents](https://docs.github.com/en/rest/repos/contents)).
  A mismatch is 409. Use it when the connector actually accepts that SHA. A
  file update that ignores the blob SHA is not this procedure.
- This account's event-review tool list was not enumerable here. If
  `expected_sha`, `beforeOid`, and blob-SHA file update are all unavailable,
  event review cannot acquire the slot. Report that gap and do not dispatch.
  Do not describe the local tests as operational.

## Result protocol

The worker's last PR #23 comment uses these fields. `worker_state` is
`COMPLETED` or `STOPPED`. `scripts/ops-slot.mjs` exports `formatResultPacket`
for that shape.

```text
dispatch_id: base3-closed-loop-20261011-01
worker_state: COMPLETED
starting_sha: <baseline>
final_sha: <branch head>
branch: <stacked branch>
pr: https://github.com/charliefq/base3router/pull/<stacked>
evidence_links: <runbook path, test command, agent URL>
ci_workflow: Check
ci_run: <workflow run URL>
checkout_sha: <SHA the checker actually ran>
unresolved_blockers:
- <one line each>
suggested_next_task: CL-1, not launched
```

`ci_workflow` for this repository's required result is the `Check` job in
`.github/workflows/ci.yml`. A green lint job alone is not the head result.
`checkout_sha` is the SHA that job checked out, which can differ from the PR
head when GitHub builds a test merge.

Bot-only completion comments are not a guaranteed event trigger. The result
comment is a human-visible coordination comment on PR #23. The worker also
links the stacked PR as soon as it exists.

## Proposed successor

Do not start this from the worker that lands the slot. ChatGPT reviews the
delivery, runs check, acquires the slot with a real compare-and-swap, and
only then dispatches one worker.

**CL-1.** `docs(operations): record one closed-loop claim check`

One documentation edit. Append a `CL-1 evidence` section to this runbook with
the slot commit SHA read back after acquire, the worker id, and a statement
that no second worker was sent. No product code. No provider call. No rerun
of Task 3A, 3B, or 4A. No spend change. No merge.

If the connector cannot compare-and-swap, do not dispatch CL-1. Post
`worker_state: STOPPED` for that attempt and leave the slot untouched. That
stopped attempt is the honest gap. It is not a passed acceptance test, and a
result comment by itself is not a passed loop.
