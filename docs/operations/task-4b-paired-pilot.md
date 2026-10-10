# Task 4B paired Auto/Manual pilot

Status: **PREPARED**. Live execution is **BLOCKED**. This document freezes the
pilot. It does not start a provider, spend money, or change routing.

Six coding tasks are each run twice, once in Auto and once in Manual, on
isolated checkouts of the same commit. That is twelve arms. No arm has been
started.

## Frozen start

- Start commit: `b52026eab554ee4a5f4f4b20cac990c4355310fd` (PR #21 head).
- If that ref moves before an owner authorizes the pilot, stop and re-freeze
  the SHA in this document. Do not silently follow a newer branch.
- Each arm is a new detached worktree:
  `git worktree add --detach <path> b52026eab554ee4a5f4f4b20cac990c4355310fd`.
- The worktree is clean. It does not receive `~/.t3/userdata`, secrets, or
  another arm's `.t3`.
- A pair matches when both worktrees print that SHA and an empty
  `git status --porcelain`.

## Frozen route

Policy `model-router.v0`, weights quality 1, cost 1, latency 1. Every catalog
metric is unknown. Cooldowns are empty. Project and environment defaults are
empty. Hybrid ranking is off. OpenRouter guidance is off. Runtime mode is
`full-access`. Interaction mode is `default`. Task governance is `required`.

Both arms see only this catalog. Both instances are the same Codex binary and
the same `gpt-5.4` model, enabled, installed, and authenticated:

| Instance             | Driver  | Model     | Default |
| -------------------- | ------- | --------- | ------- |
| `codex-pilot-auto`   | `codex` | `gpt-5.4` | no      |
| `codex-pilot-manual` | `codex` | `gpt-5.4` | no      |

Auto has no manual override. With unknown metrics the tie-break keeps the
Codex driver, then sorts instance ids by code point, so Auto binds
`codex-pilot-auto` / `gpt-5.4`. Manual sets `routingMode: "manual"` and
`modelSelection: { instanceId: "codex-pilot-manual", model: "gpt-5.4" }`.
The model slug matches. The instance id is the controlled difference. If
either instance is missing, unauthenticated, or a different model, that arm
does not start.

The router attempt budget stays 3. A failover to the other instance is still
`gpt-5.4`. It counts as a failover attempt and consumes a provider start.

## Equal limits

Every task and both arms use the same brake:

- `maxProviderStarts`: 4, counted across the whole task tree, including
  children, retries, failover, and later handoffs. The server enforces this.
- `stopConditions`, recorded and not enforced:
  `Stop after 4 provider starts anywhere in the task tree, after 80000 reported input-plus-output tokens, after 1.50 provider-reported USD on this arm, or 20 minutes after the first provider turn. Missing tokens and missing cost stay unknown and do not count as zero.`

There is no token field on the brake. Eighty thousand tokens, 1.50 USD, and
20 minutes are human stop sentences. The same sentences are on every arm.

Proposed monetary cap for all twelve arms: **18.00 USD** (12 × 1.50). This
cap is **not enabled**.

Provider-reported cost cannot enforce that cap. The brake has no money field.
`stopConditions` is natural language for a person; the server does not
interpret it. Cost is stored after a turn, only when the provider reported a
finite number, and a missing cost stays null. No price table fills it in.
Nothing refuses the next start because a sum crossed 1.50 or 18.00. A Cursor
account spend limit, even when set, meters Cursor on-demand usage. It does not
stop a Codex CLI process inside T3, it does not cover included plan usage,
and Cursor's own enforcement is not instant.

## Scoring

The human accepts or redirects the current contract revision. Provider
completion is not acceptance. Failed, rejected, retry, failover, and child
consumption stay in the task tree. Missing usage or cost makes coverage
partial and leaves the complete total unknown. Wall-clock time is recorded
from the first provider turn to the human decision and is not turned into a
usage ratio. If a cohort has no accepted task, the per-accepted ratios are
undefined, not zero.

An arm is unfinished when the person has neither accepted nor redirected it,
including when the start budget or the human clock stops it first.

## The six tasks

Each arm receives one task. Do not combine tasks in one worktree. The prompt
text is identical for Auto and Manual. The only allowed change is
`apps/web/src/components/chat/TaskContractPanel.tsx`. Any other path is a
redirect. The machine check on an arm that claims to be finished is
`git diff --name-only b52026eab554ee4a5f4f4b20cac990c4355310fd` equals that
single path, then `vp run --filter @t3tools/web typecheck`. The human still
has to accept the visible copy. These checks have not been run, because no
arm has been started.

Shared redirect sentence: `Stop and wait if the change would touch a file outside TaskContractPanel.tsx or would change usage arithmetic.`

Shared acceptance sentence: `A person accepts only when the named row is visible, unknown stays the word unknown, and usage arithmetic is unchanged.`

| Id  | Goal                                                                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| T1  | Show `reportedBillableTokens` as "Reported billable tokens". Bind `data-task-usage-billable` to the number or `unknown`. State that this is input plus output for attempts that reported both, and that cache and reasoning are not added. |
| T2  | Show `failedAttempts` and `cancelledAttempts` on the attempts row. Bind `data-task-usage-failed` and `data-task-usage-cancelled`.                                                                                                          |
| T3  | Show `usageCoverage`, `categoryCoverage`, and `costCoverage` as three separate values. Do not collapse them into `totalsComplete`.                                                                                                         |
| T4  | Show `primaryAttempts` on the attempts row. Bind `data-task-usage-primary`. Keep the existing retry and failover counts.                                                                                                                   |
| T5  | Show `acceptedRevision` beside the contract revision. Bind `data-task-usage-accepted-revision` to the number or `missing`.                                                                                                                 |
| T6  | When `totalsComplete` is false, show the label "Complete total unknown" next to the reported token sums. Do not replace a known reported sum with zero.                                                                                    |

Mobile does not render this readout. A web accept is not a mobile accept.
None of the prompts ask for a child thread. If one is created, its usage
still counts toward the tree and the start budget.
