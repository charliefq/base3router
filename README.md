# Base3Router

Base3Router is an experimental, server-first dispatcher for coding agents. It extends [T3 Code](https://github.com/pingdotgg/t3code) with explicit task routing, immutable provider bindings, and reviewable cross-provider handoffs.

The goal is simple: start work with the best available coding agent, preserve what happened, and deliberately continue the same task with another provider when needed.

## What is implemented

- **Route preview** — proposes a project, provider, model, reason, and bounded fallbacks before submission.
- **Immutable route binding** — persists the selected provider instance and model for each turn.
- **Server-authoritative execution** — the backend validates runner availability and consumes the bound route.
- **Explicit provider handoff** — a settled task can continue with another configured provider without rewriting the source turn.
- **Structured handoff packets** — carries the objective, latest instruction, branch, commit, completed work, remaining steps, tests, and bounded references.
- **Durable lineage** — records source turn, destination turn, provider/model, and handoff status.
- **Web and mobile workflow** — exposes provisional routes, authoritative bound routes, and handoff states.
- **Privacy controls** — redacts credential-shaped values, environment assignments, URLs, and external absolute paths from generated handoff summaries.

There is no silent cross-provider retry. A handoff is an explicit user decision and creates a separately bound destination turn.

## Verified execution path

An isolated operational acceptance run completed a real sequential handoff:

| Stage        | Runner          | Model               | Result                                                                  |
| ------------ | --------------- | ------------------- | ----------------------------------------------------------------------- |
| Source       | Codex CLI       | `gpt-6-sol`         | Completed Phase A and focused tests                                     |
| Continuation | Claude Code CLI | `claude-sonnet-4-6` | Inspected the repository, completed Phase B, and passed the final tests |

The runners were authenticated independently and were never active concurrently. The acceptance fixture finished with four passing tests and one persisted source-to-destination handoff.

## Architecture

```text
Task request
  -> deterministic route preview
  -> authenticated command ingress
  -> immutable turn binding
  -> provider runner
  -> projected final state
  -> reviewable handoff packet
  -> separately bound continuation turn
```

Routing decisions and handoff records are server-owned. Clients display provisional and projected state but do not duplicate routing logic.

## Safety boundaries

- Existing tasks remain compatible because dispatcher fields are additive.
- Identical binding replays are idempotent; conflicting rewrites fail.
- Once a route is bound, execution does not silently switch providers.
- Provider availability comes from configured server runners, not an API model name.
- Handoff summaries are bounded and deterministic; they do not require an additional LLM call.
- Legacy behavior remains available when dispatcher support is disabled or unavailable.

## Current status

The dispatcher is an experimental fork under active development. Core routing and Codex-to-Claude continuation have passed focused tests and isolated runtime acceptance. Phase 7B packages the Internal Alpha as Base3Router. User-data directories stay on the legacy T3 Code paths so existing installs are not migrated or deleted.

Implementation is organized as stacked pull requests so each layer can be reviewed independently:

1. Server routing foundation
2. Route preview workflow
3. Explicit provider handoff
4. Verified handoff-summary extraction
5. Workflow OS
6. Cursor Cloud runner
7. Internal Alpha product shell

## Development

This repository retains T3 Code's monorepo tooling.

```bash
vp i
vp run -r test
vp run -r --concurrency-limit 2 typecheck
vp lint --report-unused-disable-directives
vp fmt --check
```

See the upstream [T3 Code documentation](https://github.com/pingdotgg/t3code/tree/main/docs) for platform installation, supported runners, and local development prerequisites.

## Attribution and license

Base3Router is built on the open-source T3 Code project and preserves its MIT license and copyright notice. The dispatcher-specific work in this fork focuses on routing, persistence, handoff semantics, and cross-provider workflow.
