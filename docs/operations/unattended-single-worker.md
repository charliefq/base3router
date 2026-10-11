# Single-worker queue

Status: **PREPARED**. Recurring execution is **DISABLED**. No Cursor
automation was saved or activated. Dispatch `base3-unattended-20261010-02`,
attempt 1, is this checkpoint. Owner agent:
<https://cursor.com/agents/bc-b428813a-b3b5-45dd-ba61-1d5591398ee5>.

The earlier dispatch `base3-unattended-20261010-01` agent
`bc-0b48c998-6c41-4ef0-bbff-a5ce12a0d2e4` is not running this queue. Before
this dispatch started, the only running cloud agent in this environment was
this one. Prompt text is not a lock. This file is not a lock either.

| Field             | Value                                                                                                                                                                                                      |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Queue             | `codex/unattended-work-queue-20261010` `docs/operations/unattended-work-queue.md`                                                                                                                          |
| Preserved heads   | PR #18 `2a07e9e10a3aeeb95ce09dcdb7c8b234cc34afdf`, PR #20 `55a1ea4f496eadea161c0e88822b375e42a0f127`, PR #21 `b52026eab554ee4a5f4f4b20cac990c4355310fd`, PR #22 `ffd2203305b8b66cd8dfb2d982d7bd09c7f9ff8e` |
| Branch            | `cursor/v2-unattended-followup-02-8ee5`                                                                                                                                                                    |
| Base              | `cursor/v2-unattended-q1-q4-d2e4`                                                                                                                                                                          |
| Baseline verified | `ffd2203305b8b66cd8dfb2d982d7bd09c7f9ff8e`                                                                                                                                                                 |

## Native controls that were inspected

Cursor Automations can be saved in the Agents Window, at
[cursor.com/automations](https://cursor.com/automations), or with `/automate`.
Saving one starts cloud agents. A schedule or a GitHub "CI completed" trigger
can each start a run. The docs do not provide a single-worker lease, a claim
token, or a concurrency cap. Memories persist across runs and are not a lock.
`/automate` is not available on this run, and no automation was created.

GitHub Actions concurrency in `.github/workflows/ci.yml` uses the group
`ci-${{ github.event.pull_request.number || github.sha }}` and cancels the
older pull-request run. That dedupes CI jobs. It does not dedupe cloud
agents. Cancel-in-progress also drops a running job, which is the wrong
behavior for a claim that must stay until termination is established. This
repository has no GitHub Environment gate that serializes agent dispatch.

Those controls are not a single-worker lock. The claim below is the smallest
stand-in that uses git, which CI already has. It is not a product orchestrator
and it is not wired to a live trigger.

## Claim

`scripts/ops-claim.mjs` stores one task as the git ref
`refs/ops/claims/<taskId>`. Creating the ref succeeds only when the ref is
absent (`git update-ref <ref> <new> ""`). A second worker loses. The same
worker can read its own ref after a restart.

Dispatch compare-and-swaps the ref from `CLAIMED` to `DISPATCHED`. The fake
send runs only after that swap. A second dispatch, including a restart, sees
`DISPATCHED` and does not send again. Two overlapping dispatch calls send
once. Tests use a local bare repository and a fake sender. They do not call a
provider.

Release deletes the ref only when the caller passes termination evidence
(`established: true` and a non-empty evidence string). The script does not
watch processes, does not expire a claim on a timer, and does not dispatch a
replacement. A refused release leaves the holder in place. After a real
release, a later claim starts at `CLAIMED` with `dispatchCount` 0. That later
claim is a new decision. It is not an automatic redispatch.

The tests are `vp test run --config vite.config.ts --dir scripts scripts/ops-claim.test.mjs`.

## Account blocker

This run cannot read the account spend limit. There is no spend-limit tool
here, and this dispatch does not ask for credentials. Do not treat an absent
reading as "No Limit" or as any finite amount.

The supported page is the dashboard Spending tab:

- <https://cursor.com/dashboard/spending>
- The same tab is also opened as <https://cursor.com/dashboard?tab=spending>
- In the Cursor app, the documented path from the team forum is Cursor
  Settings → Plans & Usage
- The behavior of the control is documented at
  [Spend limits](https://cursor.com/docs/account/billing/spend-limits)

The limit that has to be set before any recurring automation is considered is
a **finite monthly on-demand spend limit**. On-demand usage must be enabled
before that limit can be set. The value "No Limit" removes the limit.
Included plan usage is outside this limit. Enforcement is not instant. This
checkpoint does not know whether the signed-in account is an individual plan
or a team plan, so it does not name a team-only override.

## Why the trigger stays off

The claim script is prepared and covered by fake-dispatch tests. It is not
installed on a path that cloud agents must pass through. Enabling a Cursor
automation would start recurring runs, and the account limit above is still
unreadable. Until an owner confirms the finite Spending-tab limit and chooses
to require this claim on the only dispatch path, supervision of GitHub stays
read-only. Unlimited recurring spend is not authorized.
