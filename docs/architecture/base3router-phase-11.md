# Base3Router Phase 11: Evaluation harness, measured outcomes, rework feedback, Hybrid Router V1

Stacked on `main` after Phase 10 (PR #12 merge
`71156d891154a18291ff1304675b6d81c5eb2210`). This note freezes the Phase 11
boundary. It records official OpenRouter usage/accounting shapes retrieved on
2026-10-03. It does not restate Phase 8 routing, Phase 9 presentation, or
Phase 10 Teacher/Shadow that contracts and tests already encode.

Starting branch: `cursor/phase-11-router-evaluation-learning-v0`.

Working title: **Evaluation Harness, Measured Outcomes, Rework Feedback, and
Hybrid Router V1**.

The loop is:

```text
Execution
→ measured observation
→ explicit/proxy outcome evidence
→ offline deterministic evaluation
→ versioned candidate policy
→ shadow comparison
→ explicit activation
```

Phase 11 must not introduce uncontrolled online learning. A candidate policy
cannot activate itself.

## Goals

Turn Phase 10’s sanitized observations into a privacy-preserving, auditable
evaluation loop that can rank eligible models with local evidence without
surrendering Phase 8 hard filters.

- Versioned outcome contracts with unknown ≠ zero.
- Local append-only observation persistence.
- Measured latency, tokens, and cost with provenance.
- Explicit user feedback and carefully labeled rework proxies.
- Coding-task verification evidence when a real command result exists.
- Deterministic offline evaluation and policy comparison.
- Hybrid Router V1 layered on Phase 8 hard filters.
- Champion/challenger **policy** shadow (no second inference).
- Explainable routing evidence.
- Local retention, export, and delete controls.

## Non-goals (Phase 12+)

- Model retraining
- Autonomous weight mutation
- Automatic deployment of a candidate policy
- Raw prompt or completion retention by default
- Cloud analytics upload
- Cross-user profiling
- Causal claims from weak behavioral signals
- Skill Router
- MCP Router
- Independent ActionGate redesign
- Dream Memory
- Autonomous concurrency-budget changes
- Unrelated UI redesign
- Replacing Base3Router Auto Route with OpenRouter Auto
- Recency decay in Hybrid scoring (not implemented; do not claim it)

## Required statements

These are product rules, not slogans:

- **Correlation is not causation.** Agreement, rework, or latency movement
  does not prove a model is better.
- **A regeneration or model switch is a rework proxy, not proof of poor
  quality.** The raw event type is preserved. Proxies are never converted
  into a “bad quality” label.
- **Absence of negative feedback is not positive feedback.** Missing
  explicit feedback stays unknown.
- **Missing metrics remain unknown.** Numeric zero is never used to mean
  unavailable.
- **External market popularity is a prior, not objective quality.** Phase 10
  OpenRouter sampled spend share stays labeled `sampled`.
- **A candidate policy cannot activate itself.** CI, metrics, and shadow
  agreement never flip `active`. Only an explicit authorized action does.

## Trust boundaries

| Boundary                          | Who may cross it                                   | What never crosses it                                      |
| --------------------------------- | -------------------------------------------------- | ---------------------------------------------------------- |
| Provider subprocess               | Adapter, usage parser                              | Raw prompts into the observation store                     |
| OpenRouter HTTP                   | Server-side Teacher/Shadow only (Phase 10)         | Observation store, Hybrid scoring, evaluation harness      |
| Local observation SQLite          | Server process, same environment                   | Other environments, clients as a writable store, the cloud |
| Hybrid scoring function           | Pure in-memory inputs                              | Network, persistence, clocks that are not injected         |
| Evaluation harness                | Fixture or exported sanitized dataset on disk      | Live provider credentials, network                         |
| Policy activation                 | `orchestration:operate` plus explicit confirmation | CI, metrics, challenger agreement, Teacher/Shadow          |
| Client Inspector / Control Center | Sanitized structured records                       | API keys, Authorization headers, prompts, completions      |

Phase 10 OpenRouter Shadow may make an external request. Phase 11 Policy
Shadow / Challenger must not.

## Official OpenRouter usage sources

Retrieved **2026-10-03** from official documentation. Use these shapes. Do
not depend on undocumented fields.

| Topic                           | URL                                                                 |
| ------------------------------- | ------------------------------------------------------------------- |
| Usage Accounting                | https://openrouter.ai/docs/cookbook/administration/usage-accounting |
| API response / generation stats | https://openrouter.ai/docs/api_reference/overview                   |
| Router metadata                 | https://openrouter.ai/docs/guides/features/router-metadata          |
| Data API / task classifications | https://openrouter.ai/docs/cookbook/administration/data-api         |
| Data collection / privacy       | https://openrouter.ai/docs/guides/privacy/data-collection           |

Verified documented behavior at retrieval:

- Usage is present on the **final** streaming event when requested with
  `stream_options.include_usage` / documented usage-include flags.
- `prompt_tokens`, `completion_tokens`, and `total_tokens` are available
  when usage is present.
- `cost` may be present. It is an **OpenRouter account charge**, not
  necessarily the upstream provider invoice.
- Reasoning and cache details may be present under documented
  `prompt_tokens_details` / `completion_tokens_details` objects
  (`cached_tokens`, `reasoning_tokens`).
- Generation `id` (`gen-…`) can support later usage lookup. Phase 11 stores
  the id only as an opaque generation identifier, never as a prompt.
- Usage provenance may be estimated. When OpenRouter marks usage as
  estimated, Base3Router records `estimated`. Otherwise reported usage is
  `observed` from `openrouter_accounting`.
- Null or absent values mean unavailable, not zero.
- BYOK may expose `cost_details.upstream_inference_cost` with a different
  meaning from `cost`. Preserve the distinction. Do not mix them.
- `openrouter_metadata` arrives on the terminal chunk when
  `X-OpenRouter-Metadata: enabled` is set (Phase 10).

Exact fields Phase 11 reads from a usage object, when present and numeric
or boolean as documented:

- `prompt_tokens`
- `completion_tokens`
- `total_tokens`
- `cost`
- `is_byok`
- `prompt_tokens_details.cached_tokens`
- `completion_tokens_details.reasoning_tokens`
- `cost_details.upstream_inference_cost`
- generation `id`

No other usage keys are treated as sources of truth.

## Observation lifecycle

1. **Route bind.** Dispatcher records route start, policy version, selected
   and eligible candidates, routing mode, and task profile when known.
2. **Provider request.** Adapter records provider-request start. Missing
   start stays unknown.
3. **First output.** First assistant content (or equivalent) records time
   to first token. Side-effect/tool start is not first token.
4. **Terminal.** Success, classified failure, cancel, or timeout closes
   timing. Durations use the same clock source as the timestamps
   (Effect `Clock.currentTimeMillis` in production and tests).
5. **Usage.** Tokens and cost are copied from provider-reported usage when
   present. Catalog estimates are computed separately and never overwrite
   reported cost.
6. **Evidence.** Explicit feedback, rework proxies, and verification
   results attach to the same observation id. They do not rewrite measured
   facts.
7. **Retention.** Append-only until the retention window or an explicit
   delete. Export is sanitized structured JSON. No automatic upload.

Idempotent writes key on `observationId` (environment + turn/message). A
retry does not duplicate the fact row. Later evidence patches are
versioned events against that id, not silent mutation of history. The
store keeps the latest sanitized projection plus an append-only event log
for feedback/proxy/verification.

## Event taxonomy

Separate facts, user signals, and inference. Never collapse them.

### Directly measured facts

Captured where available:

- route start timestamp
- provider request start
- first output timestamp
- terminal timestamp
- time to first token
- total duration
- prompt / completion / reasoning / cache-read / cache-write tokens
- reported cost
- estimated cost (catalog snapshot at execution time)
- provider attempts
- fallback count
- cancellation
- timeout
- normalized finish reason
- terminal success/failure category
- actual execution model
- task profile
- routing policy version

### Explicit user feedback

Structured, local, optional, no free-text required:

- `helpful`
- `not_helpful`
- `accepted`
- `incorrect`
- `incomplete`
- `too_slow`
- `too_expensive`
- `wrong_model_choice`

Optional short reason category uses the same closed set. If free text is
ever added later, it stays opt-in, local, excluded from routing training
by default, and never sent externally. Phase 11 does not persist free
text.

Absence of feedback is not positive feedback.

### Rework proxies

Observable proxies, each labeled `proxy`:

| Raw event               | Detection window                         | Notes                                       |
| ----------------------- | ---------------------------------------- | ------------------------------------------- |
| `regenerate`            | same turn/message, before a new prompt   | Deduplicate repeated UI clicks              |
| `retry_after_failure`   | after a classified failure, same thread  | Not a quality score                         |
| `edit_and_resubmit`     | next user message edits the prior prompt | Structural; no prompt text stored           |
| `manual_model_switch`   | next turn, different Manual target       |                                             |
| `auto_to_manual_switch` | next turn Auto → Manual                  |                                             |
| `immediate_abandonment` | no further turn in the window            | Window: 2 minutes after terminal            |
| `undo_revert`           | genuine checkpoint restore of that turn  | Only when the restore target is that turn   |
| `follow_up_correction`  | next user turn explicitly linked         | Link must be the prior turn id, not “later” |

Do not infer intent from unrelated later messages. Do not convert proxy
presence directly into “bad quality.” Preserve the raw event type.

### Verification evidence

For coding work, record structured evidence when a real command result
exists:

- tests passed/failed
- typecheck passed/failed
- lint passed/failed
- build passed/failed
- command exit status
- bounded retry count

An LLM must not fabricate verification evidence. Missing evidence stays
unknown. Heuristic “the model said tests passed” is not evidence.

## Measurement provenance

Every measurement carries:

- value **or** explicit `unknown`
- unit
- source
- observed timestamp (when a value exists)
- `observed` vs `estimated`
- policy version (on the parent observation)
- model identity (on the parent observation)
- provider identity when known (on the parent observation)

Cost sources:

| Source                     | Meaning                                   |
| -------------------------- | ----------------------------------------- |
| `provider_reported`        | Provider transcript/CLI reported a cost   |
| `openrouter_accounting`    | OpenRouter `usage.cost` account charge    |
| `openrouter_upstream_byok` | Documented BYOK `upstream_inference_cost` |
| `catalog_estimate`         | Pricing snapshot active at execution time |
| `unknown`                  | Not available                             |

Catalog estimates:

- Use the model/pricing snapshot active at execution time.
- Preserve snapshot timestamp/version.
- Account separately for prompt and completion tokens.
- Include cache/reasoning/tool costs only when that snapshot’s pricing
  model supports them.
- Mark the result `estimated`.
- Never overwrite reported cost with an estimate.
- Never compare mixed cost provenance without labeling it.

OpenRouter `cost` is an account charge. BYOK upstream cost may be absent
or mean something else. Preserve that distinction.

## Privacy and retention

Default retention: **90 days**. Conservative and documented. Users may
shorten it. Measurement may be turned off.

The observation store:

- is server-owned and environment-scoped
- is append-only with idempotent writes and deterministic ordering
  (`recordedAt`, then `observationId`)
- supports schema version on every record
- supports delete-all (this environment) and delete-one
- exports sanitized structured records
- never automatically uploads anywhere

Forbidden in stored records, exports, Inspector, logs, tests, and UI Lab:

- API keys
- Authorization headers
- raw prompts
- raw completions
- source-code content
- tool arguments containing user content
- absolute local paths unless already safely normalized
- reversible “anonymized” user tracking

Task classification and derived structural features are stored only when
they already meet the Phase 10 privacy boundary (macro category, raw
external tag, source). Hashes are used only for idempotent observation ids
and dataset manifests, not as user tracking.

Turning measurement off stops new writes. It does not upload anything.
Existing records remain until retention or delete.

## Evaluation dataset rules

Datasets are built only from sanitized observation records.

Segmentation, when sample size permits:

- task macro category
- raw task tag
- project/environment policy
- routing mode
- model
- provider
- policy version
- time window

Rules:

- Minimum sample thresholds (see below). No metric is shown as reliable
  below threshold.
- Deterministic temporal holdout: last 20% of records by `recordedAt` then
  `observationId` is evaluation; the rest is train. No random split that
  can leak future rows into train.
- No future data leakage: a policy evaluated at time T may use evidence
  with `recordedAt <= T` only.
- Deduplicate by `observationId`.
- Cancellation and infrastructure failure are excluded from quality-like
  rates and reported separately.
- Sampled/estimated values retain provenance.
- Dataset manifest includes record count, date range, schema version,
  filters, and a dataset hash.
- The primary evaluation path does not require raw prompts.

Synthetic fixture datasets are obviously synthetic (`synthetic: true`,
ids prefixed `syn-`).

## Offline replay

`vp run router:evaluate` (script `scripts/router-evaluate.ts`) loads a
sanitized dataset manifest, runs Phase 8 Router V0 and Hybrid Router V1
against identical eligible candidate sets, optionally compares recorded
OpenRouter Teacher choices, and writes JSON plus a concise human report.

The harness:

- never mutates the active policy
- never requires a provider credential
- never makes network calls
- preserves historical catalog/market-prior snapshots from the dataset
- reports coverage, exclusions, sample sizes, changed decisions,
  regressions, improvements, unknowns, policy version, reproducibility
  config, and dataset hash

## Policy versioning and lifecycle

States: `baseline` | `candidate` | `shadow` | `active` | `retired`.

- `model-router.v0` is the baseline. It remains the safe fallback.
- `hybrid-router.v1.0.0` is the Hybrid policy identifier.
- Candidate policies are immutable and versioned. Creation records the
  source dataset hash and evaluation result.
- Only one `active` policy per environment.
- Malformed or missing policy falls back to Router V0.
- Historical turns retain the policy version actually used.
- Activation is audited (who/when/from/to).
- Rollback to the prior policy is immediate.
- No automatic activation from CI or metrics.

Authorization: `orchestration:operate` plus `confirmActivation: true` on
the activate RPC. Read scope can inspect. Missing confirmation is denied.

## Champion/challenger lifecycle

**OpenRouter Shadow** (Phase 10): optional extra HTTP request to
OpenRouter Auto. Completions discarded. May incur cost. Never changes
Manual. Named “OpenRouter Shadow” in UI.

**Policy Shadow / Challenger** (Phase 11): pure function over the same
eligible set. Calculates what Hybrid Router V1 would have selected. Does
not change the live execution target. Does not create a second model
inference request. Records agreement/disagreement and expected metric
evidence.

Users must not confuse these two. Inspector labels them separately.

A challenger may move `candidate` → `shadow` without becoming `active`.
Activation remains a separate explicit action.

## Hybrid Router scoring

Selection order remains:

1. capability requirements
2. installed/enabled/authenticated/available
3. allow/deny constraints
4. privacy and environment policy
5. explicit Manual selection
6. eligible candidate set
7. Hybrid ranking (Auto only, sufficient evidence)
8. deterministic tie-break
9. bounded fallback

Hard constraints cannot be outweighed. Manual bypasses ranking and still
emits an audit decision. Insufficient evidence falls back to Router V0.
Unknown is not zero. Incompatible cost provenance is not silently mixed.

Hybrid ranking may use, each with source, sample size, time window, and
weight:

- Phase 8 configured preferences (only when every eligible candidate has a
  known value for that dimension — same rule as V0)
- task profile
- Phase 10 OpenRouter market prior (sampled spend share)
- locally measured success evidence
- locally measured latency
- reported or estimated cost (never mixed in one comparison)
- explicit user feedback
- rework proxy evidence (labeled proxy)
- verification evidence

Implemented math is shrinkage toward a documented prior for small samples:

```text
posterior = (n / (n + k)) * observed + (k / (n + k)) * prior
k = 10
```

Priors:

- success: market-prior share when known, otherwise uninformative 0.5
  (labeled)
- explicit negative / rework proxy: uninformative 0.5 so a tiny sample
  cannot look “perfect”
- verification pass: uninformative 0.5
- latency/cost: no numeric prior; dimension omitted below threshold

Recency decay is **not** implemented. Do not claim it.

There is no universal “quality score.” Composite utility is the weighted
sum of visible components. Weights live on the policy version.

Ties use the Phase 8 order: preferred default, documented driver order,
instance id, model slug.

The pure scoring function has no network or persistence access.

## Minimum sample requirements

| Metric                       | Display as reliable | Used in Hybrid ranking |
| ---------------------------- | ------------------- | ---------------------- |
| Rates (success, feedback, …) | n ≥ 8               | n ≥ 8                  |
| Median latency / TTFT / cost | n ≥ 8               | n ≥ 8                  |
| p90 latency                  | n ≥ 20              | not used in V1         |
| p95 latency                  | n ≥ 40              | not used in V1         |

Below threshold the metric status is `insufficient`, never a fake number.
Coverage below threshold is an explicit Inspector warning: evidence is
insufficient, Router V0 is used.

Cold start: zero observations → Router V0. Market prior may still exist
from Phase 10; it is a prior, not local evidence, and is not enough alone
to leave V0.

## Explainability

Every Hybrid decision exposes components without user content. Example:

```text
Selected model X
- passed all hard constraints
- coding verification evidence: 18/21 successful
- median latency: measured, n=24
- cost: OpenRouter accounting, n=20
- rework proxy: 2/19
- market prior: 7-day sampled prior
- policy: hybrid-router.v1.0.0
```

Forbidden language: “this model is better because the user edited fewer
messages,” or any causal claim from a proxy.

## Rollback

Rollback restores the previously active policy immediately. The retired
policy remains inspectable. In-flight turns keep the version they bound.
New turns use the restored policy. If the previous policy is missing,
fall back to `model-router.v0`.

## Phase 12 boundary

Phase 12 remains Skill Router, MCP Router, and independent ActionGate.
Phase 11 does not start those. It also does not start Dream Memory or
autonomous concurrency budgets.

## Test matrix

Deterministic only. No live provider calls. No real OpenRouter key in CI.

- observation schema decoding
- no raw prompt/completion fields
- idempotent persistence
- ordering and retention
- environment scoping
- export/delete
- measured versus estimated cost
- missing values remain unknown
- latency monotonicity
- explicit feedback
- proxy detection windows
- proxy deduplication
- verification evidence (real results only)
- dataset construction
- no future leakage
- minimum sample thresholds
- deterministic metrics
- pure Hybrid scoring
- hard constraints dominate
- Manual bypass
- insufficient evidence falls back to V0
- shrinkage/small-sample behavior
- deterministic tie-break
- policy state transitions
- unauthorized activation denied
- rollback
- policy shadow cannot affect execution
- OpenRouter Shadow remains distinct
- redaction and serialized-state safety
- Phase 8–10 regressions

## Validation

- `vp run --filter @t3tools/web typecheck`
- `vp run --filter @t3tools/scripts typecheck`
- `vp run knip:check`
- `node scripts/base3router-ui-lab.ts`
- contracts/shared typechecks and tests
- observation repository tests
- evaluation harness tests
- Hybrid Router tests
- dispatcher/provider regression tests
- Phase 8 routing/failover tests
- Phase 9 UI/scroll tests
- Phase 10 OpenRouter/privacy tests
- formatting/lint checks
