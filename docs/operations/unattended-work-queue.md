# Unattended Base3Router work queue

Owner intent: continue approved work while the owner is offline; request milestone acceptance instead of a prompt after every unit.

This document is a queue and execution contract, not an active executor. No unattended coding service or spending cap is claimed to be configured.

## Baseline
PR #21: b52026eab554ee4a5f4f4b20cac990c4355310fd, based on PR #20 branch cursor/v2-task-contract-dd71 at 55a1ea4f496eadea161c0e88822b375e42a0f127. Verify live refs before execution. Do not update PR #18/#20 or merge to main.

## Approved work
| ID | Status | Deliverable | Acceptance |
| --- | --- | --- | --- |
| Q1 | READY | Task 4A closure | Explain input 269 + output 64 vs billable 324, cost 13 currency/unit, and final-SHA synthetic report. Reuse existing artifacts. Correct labels/docs; demonstrate any code defect before changing code. |
| Q2 | READY | Task 4B plan, no execution | Six paired coding tasks on isolated identical starting states, fixed Auto/Manual configuration, human rubric, whole-tree accounting, missing-data coverage, bounded starts/tokens and proposed money cap. |
| Q3 | READY | Cursor native automation setup specification | Use supported scheduling/CI events rather than another orchestrator. Identify execution identity, scoped permissions, durable claims, restart behavior, and provider/account-enforced spending controls. Report unsupported controls; do not claim prompt prose is a hard cap or lock. |
| Q4 | READY | CEO milestone package | Final SHA/PR mapping, required CI, evidence/demo and only unresolved decisions. Depends on Q1-Q3. |

## Operating rules
Continue sequentially through READY work without seeking owner permission for already authorized reversible implementation and focused checks. Start with one implementation worker. When an item blocks, checkpoint it and continue independent READY work. Idle when the approved queue is exhausted; do not invent work to stay busy.

States: READY -> RUNNING -> CI_WAIT -> REVIEW_READY -> DONE. BLOCKED records an explicit dependency or missing authority. Only owner acceptance marks DONE. REVIEW_READY permits moving to independent next work.

Persist each claim and checkpoint with task ID, branch, SHA, PR, attempt count, owner and timestamp. Durable atomic claim/lease semantics must exist before enabling overlapping dispatch triggers. A running or CI_WAIT item must not be dispatched again. Human-readable status alone is not an atomic lock.

Use final-head CI evidence and targeted verification. Do not repeatedly run unchanged full suites. At most two repair iterations on the same demonstrated failure; then BLOCKED and move to independent work.

Do not launch agents by automated comments/API until the actual executor and usage controls have been configured. Cloud coding automation uses provider usage; no unlimited recurring spending is authorized by this document. Live paid-provider pilots remain BLOCKED.

## Existing boundaries
No merges, main push, signing, publication, real user data, or real-provider pilot. No new orchestration engine or dashboard. Existing CI and fake transports/disposable databases are permitted.

## Reporting
Notify the owner for REVIEW_READY milestones, authorization-dependent decisions, or blockers preventing all independent work. Do not send per-test/poll noise. Include the actual automation/run ID before claiming any background execution is active.

Until the executor is connected, automated GitHub supervision is read-only review and status tracking, not continuous coding.
