# Task 4B route-selection comparison

Status: **PREPARED**. Live execution is **BLOCKED**. This comparison is separate
from the same-model workflow control in
[task-4b-paired-pilot.md](task-4b-paired-pilot.md). Neither comparison has
been started. This document does not start a provider, spend money, or change
routing.

The workflow control runs Auto and Manual on the same Codex model, so a
difference there is workflow noise. This comparison asks which route the
router records. Auto uses the frozen catalog below. Manual is pinned to one
catalog row. The six task prompts stay the workflow-control prompts.

## Frozen start

- Start commit: `b52026eab554ee4a5f4f4b20cac990c4355310fd` (PR #21 head).
- If that ref moves before an owner authorizes the pilot, stop and re-freeze
  the SHA in this document. Do not follow this documentation branch.
- Each arm is a new detached worktree of that commit. The worktree is clean.
  It does not receive `~/.t3/userdata`, secrets, or another arm's `.t3`.
- A pair matches when both worktrees print that SHA and an empty
  `git status --porcelain`.

## What was inspected

Auto ranking is `routeModel` in `packages/shared/src/modelRouter.ts`, policy
`model-router.v0`. A score dimension is used only when every eligible
candidate has that metric `known`. Otherwise the dimension is inactive and the
tie-break applies: preferred target, then
`MODEL_ROUTER_TIE_BREAK_DRIVERS`, then instance id, then model slug.
`entry.isDefault` is not that preferred target. Preferred targets are a
separate list, and this comparison leaves the list empty.

`modelRouterCatalogForMode` removes OpenRouter from Auto. The future driver
names `qwen`, `deepseek`, and `kimi` have no live adapters in V0 and are not
in this catalog. `pi` and `acpRegistry` are not in the tie-break list and are
not in this catalog.

Hybrid ranking is `routeHybridModel`. It changes the live decision only when
the active policy is `hybrid-router.v1.0.0` and local evidence is sufficient
(`HYBRID_MIN_SAMPLE_RATE` is 8). This comparison does not set that policy and
does not attach samples, prices, market priors, or other measured ranking
inputs. With an empty evidence map, Hybrid falls back to V0 and the selected
model stays the V0 choice. The lock test is
`packages/shared/src/routeSelectionCatalog.test.ts`.

Manual failover is refused. `selectNextAutoRoute` returns
`MANUAL_NO_FAILOVER` when the decision mode is not `auto`. Auto may move to
another instance. The router attempt budget is `MODEL_ROUTER_ATTEMPT_BUDGET`
(3). That budget is not a task-brake field.

## Frozen catalog

One row per tie-break driver. The slug is `DEFAULT_MODEL_BY_PROVIDER` in
`packages/contracts/src/model.ts`. No metric is declared, so quality, cost,
and latency stay unknown. Cooldowns are empty. Both arms see this catalog and
no other row.

| Instance id   | Driver        | Slug                  | Where the slug is defined                         |
| ------------- | ------------- | --------------------- | ------------------------------------------------- |
| `codex`       | `codex`       | `gpt-6-astra`         | `DEFAULT_MODEL`                                   |
| `claudeAgent` | `claudeAgent` | `claude-fable-5-1`    | `DEFAULT_MODEL_BY_PROVIDER`                       |
| `cursor`      | `cursor`      | `auto`                | `DEFAULT_MODEL_BY_PROVIDER`                       |
| `grok`        | `grok`        | `grok-build`          | product slug for the session's current Grok model |
| `opencode`    | `opencode`    | `openai/gpt-5`        | `DEFAULT_MODEL_BY_PROVIDER`                       |
| `antigravity` | `antigravity` | `antigravity-default` | keep the official session model; not an ACP id    |

`cursor` / `auto`, `grok` / `grok-build`, and `antigravity` /
`antigravity-default` are the configured default slugs. They are not resolved
here to a hidden model name. If a live snapshot does not list the exact slug,
that arm does not start.

With every row eligible, no preferred target, and unknown metrics, Auto
selects `codex` / `gpt-6-astra` by tie-break. The recorded fallback instance
order is `claudeAgent`, `cursor`, `grok`, `opencode`, `antigravity`. Estimated
cost, latency, and quality on that decision are unknown. The lock test is the
source of that prediction. A missing, disabled, uninstalled, or
unauthenticated instance, or a snapshot that does not contain the exact slug,
stops the arm. The catalog is not silently reduced.

## Fixed Manual baseline

Manual sets `routingMode: "manual"` and
`modelSelection: { instanceId: "claudeAgent", model: "claude-fable-5-1" }`.
That row is the Claude default in the table above. Automatic ranking is not
applied. A transport failure does not move Manual to another row.

Auto does not set a manual override. The controlled difference is the route:
Auto's tie-break winner versus this pinned row. If those two targets are ever
the same slug on the same instance, stop. The comparison would no longer
separate route from workflow.

Session settings match the workflow control so they are not a second
difference: runtime mode `full-access`, interaction mode `default`, task
governance `required`, policy weights quality 1, cost 1, latency 1. The
weights do not rank this catalog, because the metrics are unknown.

## Equal supported limits

Every task and both arms use the same brake:

- `maxProviderStarts`: 4, counted across the whole task tree, including
  children, retries, failover, and later handoffs. The server enforces this.
  Auto failover consumes starts from this budget. Manual has no failover, so
  the same number does not buy Manual another model.
- `stopConditions`, recorded and not enforced:
  `Stop after 4 provider starts anywhere in the task tree, after 80000 reported input-plus-output tokens, after 1.50 provider-reported USD on this arm, or 20 minutes after the first provider turn. Missing tokens and missing cost stay unknown and do not count as zero.`

There is no token field, money field, or clock field on the brake. Eighty
thousand tokens, 1.50 USD, and 20 minutes are the same human sentences on
every arm. The server does not interpret `stopConditions`.

Proposed monetary cap for these twelve arms: **18.00 USD** (12 × 1.50). This
cap is **not enabled**. It does not stack on the workflow-control proposal.
Running both comparisons is twenty-four arms and is not authorized.

Provider-reported cost cannot enforce the cap. Cost is stored after a turn
only when the provider reported a finite number. A missing cost stays null.
No price table fills it in. Nothing refuses the next start because a sum
crossed 1.50 or 18.00. The router attempt budget stops Auto failover after
three attempts. It does not stop Manual, and it is not a token or dollar
limit. A Cursor account spend limit meters Cursor on-demand usage. It does
not stop a provider CLI inside T3, it does not cover included plan usage, and
Cursor's own enforcement is not instant.

## Scoring

The human accepts or redirects the current contract revision. Provider
completion is not acceptance. The route recorded on the arm is part of the
observation: Auto should show `codex` / `gpt-6-astra` unless failover moved
it, and Manual should show `claudeAgent` / `claude-fable-5-1`. A different
route is a failed arm, not a ranking result. There is no quality score and no
price rank.

Failed, rejected, retry, failover, and child consumption stay in the task
tree. Missing usage or cost makes coverage partial and leaves the complete
total unknown. Wall-clock time is recorded from the first provider turn to
the human decision and is not turned into a usage ratio. If a cohort has no
accepted task, the per-accepted ratios are undefined, not zero.

An arm is unfinished when the person has neither accepted nor redirected it,
including when the start budget or the human clock stops it first.

## The six tasks

Each arm receives one task. Do not combine tasks in one worktree. The prompt
text is the workflow-control text for the same id. Do not edit it for this
comparison. The only allowed product change is
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
