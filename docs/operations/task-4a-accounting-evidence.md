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
The script refuses a dirty tree, deletes any previous artifact in the output
directory, runs that test, and writes `task-4a-binding-report.json` beside the
cohort file `synthetic-accounting-report.json`. The default directory is
`/opt/cursor/artifacts`. `TASK_USAGE_ARTIFACT_DIR` overrides it for both the
script and the test. The tested SHA, dirty state, command, and timestamps come
from that process. The totals are copied from the artifact the test just wrote.

Review copies of one fresh local run live in
[evidence/synthetic-accounting-report.json](evidence/synthetic-accounting-report.json)
and [evidence/task-4a-binding-report.json](evidence/task-4a-binding-report.json).
Their `testedCommitSha` is the clean commit the command ran against. The commit
that adds those files is the publication commit. It is a different SHA. Do not
edit the JSON by hand and do not paste an older run over them.

The workflow `Task 4A evidence` runs the same command on its checkout and
uploads both JSON files as the artifact `task-4a-synthetic-evidence`. That
artifact's `testedCommitSha` is the workflow head, which can differ from the
committed copies. A green aggregate `Check` job does not upload these files
and does not prove a local run that is missing.

## What 333 and 324 count

| Quantity                 | Value | What it includes                                                                                  |
| ------------------------ | ----: | ------------------------------------------------------------------------------------------------- |
| Reported input           |   269 | Known input reports. The unfinished attempt reported none.                                        |
| Reported output          |    64 | Known output reports, including 9 tokens from the unfinished attempt.                             |
| Input plus output        |   333 | Those two sums. Cache and reasoning are already inside input and output, and are not added again. |
| Reported billable tokens |   324 | Internal complete-pair sum: input plus output only where the attempt reported both.               |
| Excluded from that sum   |     9 | The unfinished attempt's output. It reported no input, so the complete-pair metric skips it.      |
| Provider-reported cost   |    13 | Fixture costs on the attempts that reported a cost.                                               |

`reportedCostUsd` 13 is synthetic USD in a field named USD. No provider priced
a model, and no account was charged. Missing cost stays unknown. It is not
stored as zero, and the complete cost total stays unknown because one task
never reported a cost.

Coverage is partial. One task is missing usage and cost, so the complete
input, output, and cost totals are unknown. Two tasks were accepted, so the
known-report ratios are defined: input 134.5, output 32, complete-pair 162, and
known cost 6.5 per accepted task. The output ratio includes the unfinished
attempt's 9 tokens. The complete-pair ratio does not. Skipping those 9 tokens
is only how this internal metric is defined. It is not a finding that a vendor
would decline to bill them. The attempt reported no cost, so its
provider-reported cost stays unknown rather than zero. The complete ratios stay
unknown. A cohort with no accepted task has an undefined ratio, not zero.

The five governed tasks:

| Task                                                      | Acceptance | Reported input | Reported output | Complete-pair | Reported cost |
| --------------------------------------------------------- | ---------- | -------------: | --------------: | ------------: | ------------: |
| Accepted turn, after one snapshot and one incremental add | accepted   |            145 |              27 |           172 |             3 |
| Parent plus child                                         | accepted   |             80 |              18 |            98 |             5 |
| Failed primary, failed retry, then failover               | unfinished |             37 |               6 |            43 |             3 |
| Redirected                                                | rejected   |              7 |               4 |            11 |             2 |
| Cancelled with no usage, then a partial output of 9       | unfinished |        unknown |               9 |      excluded |       unknown |

`excluded` means the internal complete-pair metric has no value for that task.
The 9 output tokens remain in the reported output column. Vendor billability
for them is unknown.

Failed, rejected, retry, failover, and child turns stay in the numerator.
Another environment's 999-token turn is not part of this cohort. A context
window of 9000 tokens on the accepted turn is not usage.
