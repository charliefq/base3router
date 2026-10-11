# Milestone base3-unattended-20261010-02

One packet for dispatch `base3-unattended-20261010-02`, attempt 1. This agent
does not continue `bc-0b48c998-6c41-4ef0-bbff-a5ce12a0d2e4`.

Agent: <https://cursor.com/agents/bc-b428813a-b3b5-45dd-ba61-1d5591398ee5>.

Before work started, the only running cloud agent in this environment was
this one. Baseline `ffd2203305b8b66cd8dfb2d982d7bd09c7f9ff8e` matched
`cursor/v2-unattended-q1-q4-d2e4`. PR #18, PR #20, PR #21, and PR #22 heads
were not moved.

| Item                   | State                                                                     | Record                                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Q1 Task 4A evidence    | EXECUTED when the committed binding JSON matches a fresh binder run       | [Task 4A evidence](task-4a-accounting-evidence.md) and [evidence/](evidence/)                                                           |
| Q2 Route comparison    | PREPARED, not EXECUTED                                                    | [Route selection](task-4b-route-selection.md). Live pilot BLOCKED. The [same-model control](task-4b-paired-pilot.md) stays blocked too. |
| Q3 Unattended worker   | PREPARED, not ENABLED                                                     | [Single-worker queue](unattended-single-worker.md). Recurring automation DISABLED.                                                      |
| Q4 Account spend limit | BLOCKED on the owner account                                              | Spending tab, finite monthly on-demand limit. Unreadable from this run.                                                                 |
| Q5 This packet         | REVIEW_READY after the evidence publication commit and current-head Check | This file.                                                                                                                              |

Branch `cursor/v2-unattended-followup-02-8ee5`, based on
`cursor/v2-unattended-q1-q4-d2e4`. The publication commit adds
`docs/operations/evidence/`. `testedCommitSha` inside
`task-4a-binding-report.json` is the clean commit the local binder ran
against. It is not this file's commit. The workflow `Task 4A evidence`
uploads a separate artifact for its own head. Aggregate `Check` does not
upload that artifact.

The in-test generator still reports `commitSha: null`.

Required CI on this head is the GitHub Actions job `Check` in
`.github/workflows/ci.yml`. A green lint or typecheck job alone is not the
head result. The evidence workflow is additional and is not `Check`.

Configuration actually in force: no Cursor automation, no spend-limit change,
no provider pilot, no merge. Both 18.00 USD figures are proposals in the
pilot docs, not account settings.

## Owner decisions

- Accept this milestone, or name the queue item to redo.
- The paid pilots stay blocked until you authorize real provider spend.
  Accounting cannot stop an arm at the proposed cap. Token, dollar, and clock
  sentences in `stopConditions` are not enforced.
- Recurring automation stays off until the Spending tab at
  <https://cursor.com/dashboard/spending> has on-demand usage enabled and a
  finite monthly spend limit, and you choose to require `scripts/ops-claim.mjs`
  on the only dispatch path. This run cannot see the current limit.
