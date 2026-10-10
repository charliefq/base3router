# Single-worker queue

Status: **PREPARED**. Recurring execution is **DISABLED**. No Cursor
automation was saved or activated. This file is a checkpoint for one
authorized dispatch. It is not an atomic lock. Two workers can both read it
and both continue.

Dispatch `base3-unattended-20261010-01`, attempt 1. Owner agent:
<https://cursor.com/agents/bc-0b48c998-6c41-4ef0-bbff-a5ce12a0d2e4>.
This is a new agent. The earlier Task 4A agent
`bc-3cf5bfa9-3527-47b9-8536-36f4f141dd71` was idle and is not running this
queue. No other running agent had claimed Q1–Q4.

| Field                               | Value                                                                             |
| ----------------------------------- | --------------------------------------------------------------------------------- |
| Queue                               | `codex/unattended-work-queue-20261010` `docs/operations/unattended-work-queue.md` |
| PR #21 head verified before writing | `b52026eab554ee4a5f4f4b20cac990c4355310fd`                                        |
| PR #18 / #20 / #21                  | draft, unmerged, heads not moved by this dispatch                                 |
| Branch                              | `cursor/v2-unattended-q1-q4-d2e4`                                                 |
| Base                                | `cursor/v2-task-usage-accounting-dd71`                                            |
| Owner comment                       | 2026-10-10T20:35:02Z                                                              |

## What was inspected

Cursor Automations are created in the Agents Window, at
[cursor.com/automations](https://cursor.com/automations), or with the local
`/automate` skill. Saving and activating an automation starts cloud agents.
Triggers include a schedule and GitHub "CI completed". An automation can have
several triggers, and any one of them starts a run. The docs do not provide a
single-worker lease, a claim token, or a concurrency cap. Memories persist
across runs and are not a lock. Prompt text that says "process this once" is
not a lock.

Billing follows the cloud agent. A personal account has no Share menu and
always bills the owner. There is no per-automation spend cap. Account spend
limits live on the dashboard Spending tab and are documented at
[Spend limits](https://cursor.com/docs/account/billing/spend-limits). On-demand
usage must be enabled before a limit can be set. The limit has to be a finite
amount. "No Limit" removes it. The limit applies to on-demand usage, not to
included plan usage, and enforcement is not instant.

This agent could not read the account's current spend limit. There is no
spend-limit tool on this run. The `/automate` skill is not available here.

## Prepared workflow, not enabled

One automation, name `base3-unattended-queue`, repository
`charliefq/base3router`, branch taken from the pull request. Tools would be
limited to reading the repo and commenting on the pull request. Memories off.
No schedule. The only trigger would be GitHub CI completed for workflow `CI`.

The agent would continue only when all of these are true:

1. The finished check is the job named `Check` in `.github/workflows/ci.yml`,
   and its result is success. Earlier jobs are not enough. `Check` fails when
   any required job fails.
2. The workflow head SHA equals the pull request head.
3. A claim row for that SHA is not already `RUNNING` or `CI_WAIT`.
4. The approved queue still has independent `READY` work.

GitHub Actions already cancels an older PR run inside
`ci-${{ github.event.pull_request.number || github.sha }}`. That dedupes CI
runs. It does not dedupe cloud agents. A CI-completed trigger fires per
finished check, so several jobs can start several agents before `Check`
exists. That is why the trigger stays off.

## Why it stays off

Enable the recurring trigger only after both of these exist:

1. Dashboard → Spending: on-demand usage enabled, and a monthly spend limit
   set to a finite USD amount rather than "No Limit"
   ([Spend limits](https://cursor.com/docs/account/billing/spend-limits)).
2. An atomic claim store outside the prompt. A row transitions to `RUNNING`
   only if no other worker holds that task id. A file, a memory, or an
   instruction does not qualify.

This dispatch does not ask for credentials and does not create that
automation. Unlimited recurring spend is not authorized. Until those two
controls exist, supervision of GitHub remains read-only.
