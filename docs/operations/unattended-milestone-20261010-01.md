# Milestone base3-unattended-20261010-01

One packet for the approved queue. States mean: **PREPARED** is written and
not running, **ENABLED** is a live trigger, **EXECUTED** is a run that
happened. Owner acceptance is the only **DONE**.

Agent: <https://cursor.com/agents/bc-0b48c998-6c41-4ef0-bbff-a5ce12a0d2e4>.
New agent, attempt 1. It does not continue
`bc-3cf5bfa9-3527-47b9-8536-36f4f141dd71`.

| Item                 | State                                                                         | Record                                                                             |
| -------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Q1 Task 4A evidence  | EXECUTED when the binding command in the evidence doc exits 0 on a clean tree | [Task 4A evidence](task-4a-accounting-evidence.md)                                 |
| Q2 Task 4B pilot     | PREPARED, not EXECUTED                                                        | [Paired pilot](task-4b-paired-pilot.md). Live pilot BLOCKED.                       |
| Q3 Unattended worker | PREPARED, not ENABLED                                                         | [Single-worker queue](unattended-single-worker.md). Recurring automation DISABLED. |
| Q4 This packet       | REVIEW_READY after the binding artifact names this commit                     | This file.                                                                         |

Branch `cursor/v2-unattended-q1-q4-d2e4`, based on
`cursor/v2-task-usage-accounting-dd71`. PR #21 stays at
`b52026eab554ee4a5f4f4b20cac990c4355310fd`. PR #18 and PR #20 were not
updated. The tested SHA is the `testedCommitSha` field of
`/opt/cursor/artifacts/task-4a-binding-report.json`, which must equal
`git rev-parse HEAD` with an empty porcelain status. The generator inside
the cohort test still reports `commitSha: null`.

Required CI on this head is the GitHub Actions job `Check` in
`.github/workflows/ci.yml`. That job is the aggregate. A green lint or
typecheck job alone is not the head result.

Configuration actually in force: no Cursor automation, no spend-limit change,
no provider pilot, no merge. The 4B monetary figure of 18.00 USD is a
proposal in the pilot doc, not an account setting.

## Owner decisions

- Accept this milestone, or name the queue item to redo.
- The paid Auto/Manual pilot stays blocked until you authorize real provider
  spend. Accounting cannot stop an arm at the proposed cap.
- Recurring automation stays off until the Spending tab has a finite on-demand
  limit and an atomic claim store exists outside the prompt.
