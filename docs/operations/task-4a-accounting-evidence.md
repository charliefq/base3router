# Task 4A synthetic accounting evidence

The cohort is fake provider traffic on disposable SQLite. It checks that the
governed-task ledger adds the turns it was given. It is not a model-quality
result, not an Auto versus Manual comparison, and not a vendor invoice.

PR #21 head `b52026eab554ee4a5f4f4b20cac990c4355310fd` is the accounting
implementation. The cohort test writes `commitSha: null` because that test no
longer shells out to git. Binding the run to a commit is a separate command,
below. Do not paste a SHA into an older artifact.

## Reproduce

From a clean checkout of the commit under test, with Node 24:

```sh
node scripts/bind-task-usage-accounting-report.mjs
```

The command is `vp test run apps/server/src/policy/TaskUsageAccounting.test.ts`.
The script refuses a dirty tree, deletes any previous artifact, runs that
test, and writes `/opt/cursor/artifacts/task-4a-binding-report.json`. The
tested SHA, dirty state, command, and timestamps come from that process. The
totals are copied from the artifact the test just wrote.

## What 333 and 324 count

| Quantity                 | Value | What it includes                                                                                  |
| ------------------------ | ----: | ------------------------------------------------------------------------------------------------- |
| Reported input           |   269 | Known input reports. The unfinished attempt reported none.                                        |
| Reported output          |    64 | Known output reports, including 9 tokens from the unfinished attempt.                             |
| Input plus output        |   333 | Those two sums. Cache and reasoning are already inside input and output, and are not added again. |
| Reported billable tokens |   324 | Input plus output only where the attempt reported both.                                           |
| Difference               |     9 | The unfinished attempt's output. It has no input, so it is not billable.                          |
| Provider-reported cost   |    13 | Fixture costs on the attempts that reported a cost.                                               |

`reportedCostUsd` 13 is synthetic USD in a field named USD. No provider priced
a model, and no account was charged. Missing cost stays unknown. It is not
stored as zero, and the complete cost total stays unknown because one task
never reported a cost.

Coverage is partial. One task is missing usage and cost, so the complete
input, output, and cost totals are unknown. Two tasks were accepted, so the
known-report ratios are defined: input 134.5, output 32, billable 162, and
known cost 6.5 per accepted task. The output ratio includes the unfinished
attempt's 9 tokens. The billable ratio does not. The complete ratios stay
unknown. A cohort with no accepted task has an undefined ratio, not zero.

The five governed tasks:

| Task                                                      | Acceptance | Reported input | Reported output | Billable | Reported cost |
| --------------------------------------------------------- | ---------- | -------------: | --------------: | -------: | ------------: |
| Accepted turn, after one snapshot and one incremental add | accepted   |            145 |              27 |      172 |             3 |
| Parent plus child                                         | accepted   |             80 |              18 |       98 |             5 |
| Failed primary, failed retry, then failover               | unfinished |             37 |               6 |       43 |             3 |
| Redirected                                                | rejected   |              7 |               4 |       11 |             2 |
| Cancelled with no usage, then a partial output of 9       | unfinished |        unknown |               9 | excluded |       unknown |

Failed, rejected, retry, failover, and child turns stay in the numerator.
Another environment's 999-token turn is not part of this cohort. A context
window of 9000 tokens on the accepted turn is not usage.
