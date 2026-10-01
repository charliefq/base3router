# Base3Router Phase 10: OpenRouter adapter, task classification, Teacher/Shadow, market priors

Stacked on `main` after Phase 9 (PR #11), at
`0b41edbbfe249b7695c36032759ea7fd7dd892e5`. This note freezes the Phase 10
boundary. It records official OpenRouter request/response shapes retrieved on
2026-10-01. It does not restate Phase 8 routing or Phase 9 presentation that
contracts and tests already encode.

Starting branch: `cursor/phase-10-openrouter-teacher-shadow`.

## Goals

Let Base3Router learn from OpenRouter routing signals without surrendering
security, eligibility, audit, or policy authority.

- Optional OpenRouter provider adapter (server-side, injectable transport).
- Typed guidance modes: Off, Shadow, Teacher.
- Auditable task profiles with a preserved raw OpenRouter tag.
- Market-prior snapshots labeled as sampled spend share, never as quality.
- Nested fallback evidence: one Base3Router attempt may wrap OpenRouter
  internal routing.
- Sanitized Phase 11 observation records. No learning in this phase.

## Non-goals (Phase 11+)

- Self-training or reinforcement learning
- Automatic optimization from user edits or rework
- Evaluation benchmarks and reward computation
- Learned per-user routing
- Skill Router
- MCP Router
- Dream Memory
- Independent side-effect ActionGate redesign
- Unbounded concurrency
- Replacing Base3Router Auto Route with OpenRouter Auto
- Silently uploading prompts
- Storing raw prompts as telemetry
- Mobile Auto Route control
- Production billing or subscription UX

## Five names that must not collapse

| Name                         | What it is                                                 | Authority                             |
| ---------------------------- | ---------------------------------------------------------- | ------------------------------------- |
| **Base3Router Auto Route**   | Phase 8 local deterministic router (`routingMode: "auto"`) | Base3Router                           |
| **Manual**                   | Explicit user model selection (`routingMode: "manual"`)    | User, still gated                     |
| **Access Auto**              | Runtime action-permission policy (`RuntimeMode = "auto"`)  | Permissions                           |
| **OpenRouter Auto**          | External `openrouter/auto` routing service                 | OpenRouter, inside the allowed set    |
| **OpenRouter guidance mode** | Off, Shadow, or Teacher                                    | Base3Router policy + explicit consent |

Cursor catalog slug `"auto"` remains a Manual catalog id only.

## Official OpenRouter sources

Retrieved 2026-10-01 from official documentation. Use these shapes; do not
copy a stale request from memory.

| Topic                            | URL                                                                                           |
| -------------------------------- | --------------------------------------------------------------------------------------------- |
| Auto Router                      | https://openrouter.ai/docs/guides/routing/routers/auto-router                                 |
| Router Metadata                  | https://openrouter.ai/docs/guides/features/router-metadata                                    |
| Models API                       | https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties      |
| Task classification market share | https://openrouter.ai/docs/api/api-reference/classifications/task-classification-market-share |
| Go classifications SDK           | https://openrouter.ai/docs/client-sdks/go/sdks/classifications/README                         |
| Zero Data Retention              | https://openrouter.ai/docs/guides/features/zdr                                                |
| Data collection                  | https://openrouter.ai/docs/guides/privacy/data-collection                                     |
| Provider routing                 | https://openrouter.ai/docs/guides/routing/provider-selection                                  |
| Model fallbacks                  | https://openrouter.ai/docs/guides/routing/model-fallbacks                                     |

### Auto Router (`openrouter/auto`)

POST `https://openrouter.ai/api/v1/chat/completions`

Request (non-streaming Teacher/Shadow observation):

```json
{
  "model": "openrouter/auto",
  "messages": [{ "role": "user", "content": "<task text>" }],
  "stream": false,
  "provider": {
    "zdr": true,
    "data_collection": "deny"
  },
  "plugins": [
    {
      "id": "auto-router",
      "allowed_models": ["anthropic/claude-sonnet-4.5"],
      "cost_tier": "medium"
    }
  ]
}
```

Headers:

- `Authorization: Bearer <OPENROUTER_API_KEY>` (server-only; never serialized)
- `Content-Type: application/json`
- `X-OpenRouter-Metadata: enabled`

Documented Auto Router facts at retrieval:

- Classifies prompts into ~30 fine-grained task types (`code:debugging`,
  `agent:multi_step_planning`, `qa_knowledge`, `math`, `research_report`, …).
- Ranking uses trailing seven-day task-specific market spend share.
- `allowed_models` / `excluded_models` accept wildcard patterns.
- `cost_tier` is a band: `low` | `medium` | `high` | `xhigh` | `max`.
  Unset OpenRouter requests route as roughly `low`. Base3Router always sends
  an explicit tier.
- Cost tier, account restrictions, ZDR, `allowed_models`, and output modality
  affect routing.
- Settings for `openrouter/auto` must use plugin id `auto-router`.
  `openrouter/auto-beta` uses `auto-beta-router`. Phase 10 uses `openrouter/auto`.
- `cost_quality_tradeoff` is deprecated; do not send it.
- The `auto-router` plugin is OpenRouter's own routing configuration, not a
  third-party plugin. Phase 10 still forbids web-search, file-parser, and
  other third-party plugins/tools.
- Response `model` is the actual selected model slug.
- If classification or rankings are unavailable, OpenRouter degrades to a
  default set. Missing `task_type` stays unknown on our side.

Success response (relevant fields):

```json
{
  "id": "gen-...",
  "model": "anthropic/claude-sonnet-4.5",
  "choices": [{ "message": { "role": "assistant", "content": "..." } }],
  "usage": {
    "prompt_tokens": 15,
    "completion_tokens": 150,
    "total_tokens": 165
  },
  "openrouter_metadata": {
    "requested": "openrouter/auto",
    "strategy": "auto",
    "region": "iad",
    "summary": "available=N, selected=...",
    "attempt": 1,
    "is_byok": false,
    "endpoints": {
      "total": 1,
      "available": [
        { "provider": "Anthropic", "model": "anthropic/claude-sonnet-4.5", "selected": true }
      ]
    },
    "attempts": [
      { "provider": "Anthropic", "model": "anthropic/claude-sonnet-4.5", "status": 200 }
    ],
    "pipeline": [
      { "type": "router", "name": "auto-router", "data": { "task_type": "code:debugging" } }
    ]
  }
}
```

`openrouter_metadata` is present only when the metadata header is `enabled`.
Streaming delivers it on the terminal chunk before `data: [DONE]`. Cache hits
omit metadata. Treat unknown pipeline stage types as opaque. `data.task_type`
is absent when classification is unavailable.

Phase 10 does not send `session_id` stickiness. Each observation is a
standalone request.

### Router metadata header

`X-OpenRouter-Metadata: enabled` (case-insensitive). Any other value,
including empty, disables metadata.

### Models API

GET `https://openrouter.ai/api/v1/models`

Query: `offset` (default 0), `limit` (default 500, max 1000). When both
offset and limit are omitted, the full list is returned. Phase 10 paginates
with `limit=500` and increasing `offset` until a page is shorter than the
limit or empty.

Sort options used when fetching specialized views: `pricing-low-to-high`,
`latency-low-to-high`, `throughput-high-to-low`, `most-popular`,
`intelligence-high-to-low`, `coding-high-to-low`, `agentic-high-to-low`,
`design-arena-elo-high-to-low`. Models without a score for the chosen
benchmark are placed last by OpenRouter. Base3Router never turns a missing
score into zero.

`zdr=true` filters to models with ZDR endpoints.

Item shape (documented fields we normalize):

- `id`, `canonical_slug`, `name`, `context_length`
- `architecture.input_modalities`, `architecture.output_modalities`
- `supported_parameters`
- `pricing.prompt`, `pricing.completion`
- `top_provider.context_length`, `top_provider.is_moderated`,
  `top_provider.max_completion_tokens`
- `links.details`

Benchmark indices and recent latency/throughput are not guaranteed on every
item. Store them only when present, as `{ status: "known", value }` or
`{ status: "unknown" }`.

### Task classification market share

GET `https://openrouter.ai/api/v1/classifications/task?window=7d`

Rate limit: 30 requests/minute per key, 500 requests/day per account.

Response:

```json
{
  "data": {
    "as_of": "2026-06-17",
    "window_days": 7,
    "classifications": [
      {
        "tag": "code:general_impl",
        "display_name": "Code Generation",
        "macro_category": "code",
        "usage_share": 0.23,
        "token_share": 0.31,
        "category_usage_share": 0.51,
        "category_token_share": 0.48,
        "models": [
          { "id": "openai/gpt-4.1-mini", "tag_usage_share": 0.55, "tag_token_share": 0.75 }
        ]
      }
    ],
    "macro_categories": [
      { "key": "code", "label": "Code", "usage_share": 0.45, "token_share": 0.52 }
    ]
  }
}
```

These shares are sampled classified traffic, not absolute volume. Cite as
“Source: OpenRouter (openrouter.ai/rankings), as of {as_of}.” Missing
classification data stays unknown.

### Privacy request fields

From provider routing and ZDR docs:

```json
{ "provider": { "zdr": true, "data_collection": "deny" } }
```

- `zdr: true` is OR'd with account/guardrail ZDR; it cannot disable stricter
  account settings.
- ZDR covers provider inference routing. It does not cover plugins/tools
  such as web search. Phase 10 therefore does not enable those.
- OpenRouter itself does not retain prompts unless the account opts into
  logging. Base3Router never requests input/output logging.
- Do not send `tools`, `tool_choice`, web-search plugins, or file-parser
  plugins.

### Nested OpenRouter fallbacks

OpenRouter may try providers internally (`openrouter_metadata.attempts`) or
honor a `models` fallback array. Phase 10 does not send the `models`
fallback array for Auto Router requests. Internal attempts are nested
evidence on one Base3Router provider attempt.

## Trust boundaries

Base3Router remains authoritative for:

- required capabilities
- environment/project policy
- provider authorization
- allow/deny rules
- privacy requirements
- model allowlist
- cost ceilings
- ActionGate decisions
- route audit
- whether an external request is permitted
- whether Shadow or Teacher is enabled

OpenRouter may operate only inside the candidate set Base3Router permits.
Metadata or an actual returned model cannot bypass a hard constraint.

Clients never receive the API key, `Authorization` headers, raw prompts, or
raw completions. Feature availability is a server capability plus credential
status, not a fake client toggle.

## Request and response flow

```
Client turn.start
  routingMode?: auto | manual          # Phase 8
  openRouterGuidanceMode?: omitted     # optional; server settings win as default
       |
       v
Base3Router bind (Phase 8 eligibility + ActionGate)
       |
       +-- guidance Off --> execute bound target (byte-compatible with Phase 8)
       |
       +-- guidance Shadow --> execute bound target unchanged
       |                      fire-and-forget OpenRouter Auto observation
       |                      never writes routeBinding.target
       |
       +-- guidance Teacher --> map eligible set to OpenRouter slugs
                                bind OpenRouter Auto as the execution target
                                execute through the OpenRouter adapter
                                record actual model; fail if outside allowlist
```

Shadow observation and Teacher execution share the privacy payload. Shadow
discards completion content. Teacher streams completion through the existing
provider event path and still does not persist prompt/completion in the
observation record.

## Task taxonomy

`TaskProfileV0` always carries:

- `macroCategory` — Base3Router macro
- `rawExternalTag` — OpenRouter tag or omitted
- `source` — `openrouter_auto` | `openrouter_classifications` |
  `local_heuristic` | `unknown`
- `confidence` — only when OpenRouter returns one; otherwise omitted. Never
  invented.

Macro categories:

`coding`, `debugging`, `multi_step_agent`, `research`, `reasoning`,
`mathematics`, `summarization`, `simple_qa`, `writing`, `data_analysis`,
`other`, `unknown`.

Unknown future OpenRouter tags decode as the raw tag plus macro `other`.
Missing classification is `unknown`, never `other` and never a zero score.

A local heuristic, if used, is pure, tested, and labeled `local_heuristic`.
It is not machine-learned confidence.

## Guidance-mode semantics

### Off

- No OpenRouter guidance request.
- Phase 8 routing and execution remain unchanged for clients that omit the
  new fields.
- Default when OpenRouter is not configured or guidance is unset.

### Shadow

- Base3Router chooses and executes the real model exactly as Phase 8.
- An optional OpenRouter Auto observation may run independently.
- The observation must not change the current turn's selected model,
  provider, response, fallback chain, or user-visible answer.
- Store only sanitized structured observation data.
- Discard Shadow completion content.
- Shadow failure must never fail or delay the real turn.
- Requests are bounded, cancellable, timeout-limited, and budget-limited.
- Disabled by default. Enabling requires explicit consent because it sends
  another copy of task content and may incur cost. UI warns before activation.
- Skip and record a sanitized reason when privacy policy or likely
  credentials block the prompt.

### Teacher

- Explicit opt-in.
- Base3Router first builds the eligible candidate set with all hard
  constraints.
- OpenRouter Auto receives only allowed external model mappings from that
  set, plus privacy and cost constraints.
- OpenRouter performs model selection and execution for that turn.
- Record actual returned model, task type when present, sanitized metadata,
  and nested fallback evidence.
- Map the actual model into the route trace without rewriting historical
  policy input.
- An actual model outside the allowed set is a policy violation and fails
  safely.
- If OpenRouter is unavailable, use bounded Base3Router failover only when
  `teacherFallbackToBase3` is true. That is Auto Route failover, not Shadow.
- Never silently convert Teacher into Shadow or Shadow into Teacher.

Teacher is an external teacher observation/execution mode. It is not learned
Base3Router routing.

## Market-prior lifecycle

1. Credential present and guidance not Off → catalog service may refresh.
2. GET models with pagination; GET classifications `window=7d`.
3. Normalize, cache with TTL (default 6 hours), keep last-known-good.
4. On failure, serve stale snapshot marked `stale`. Do not block Phase 8.
5. Absent scores stay `{ status: "unknown" }`.
6. Sampled shares are priors, not objective quality.
7. Teacher may use priors only after hard eligibility filters, and only as
   candidate ordering hints. Shadow treats them as observational.
8. Avoid frequent polling. Rate-limit classification calls.

## Credential handling

- Server-side only.
- Sources, in order: provider-instance sensitive env `OPENROUTER_API_KEY`,
  then process environment `OPENROUTER_API_KEY`. Compatible with existing
  instance environment merge.
- Credential store bindings follow the existing provider secret pattern.
- Never paste a key into chat, fixtures, GitHub, route traces, URLs, logs,
  screenshots, or client state.
- Missing, invalid, or revoked keys produce sanitized failure categories.
- No global singleton that retains the raw key beyond the instance scope.

## Privacy and consent

Every Teacher or Shadow request sets:

- `provider.zdr: true`
- `provider.data_collection: "deny"`
- no third-party plugins
- no web-search plugin
- no external tool execution (`tools` omitted)
- no input/output logging requested by Base3Router
- no prompt/completion in Base3Router observation state

Account-level OpenRouter settings may be stricter and remain authoritative.

Shadow and Teacher require explicit environment consent distinct from merely
having a key. Off needs no consent.

Likely credentials in the prompt (including `sk-or-…` and other secret
shapes) skip Shadow and fail Teacher safely with a sanitized skip/failure
reason.

## Cost implications

- OpenRouter Auto has no extra router fee; the user pays the selected model.
- Shadow duplicates the prompt and therefore may incur a second completion
  cost. The UI warning says so.
- Shadow requests use a short max-token budget so observation stays cheap.
- Teacher pays for the executed model only.
- `cost_tier` constrains the OpenRouter band; it is not a hard dollar
  ceiling. Base3Router allow/deny and eligibility remain the hard cost
  policy.

## Nested fallback behavior

- `MODEL_ROUTER_ATTEMPT_BUDGET` stays 3 Base3Router attempts.
- One OpenRouter HTTP request counts as one Base3Router provider attempt,
  even if OpenRouter internally tries multiple endpoints.
- Do not send OpenRouter `models` fallback lists in Phase 10 Auto requests.
  That would multiply retries against Base3Router failover.
- Display OpenRouter `attempts` as nested evidence, not extra Auto Route
  attempts.
- Manual still never failovers.

## Data retention

Base3Router stores:

- sanitized observation records (task profile, slugs, agreement, token
  counts when reported, latency when reported, cost when reported, status,
  timestamps, policy/market-prior versions)
- last-known-good catalog/market-prior snapshot

Base3Router does not store:

- raw prompts
- raw completions
- API keys
- authorization headers
- unbounded metadata JSON

OpenRouter account retention is outside this repo. Phase 10 always requests
ZDR and denies provider data collection.

## Failure modes

| Case                           | Off               | Shadow                       | Teacher                                                   |
| ------------------------------ | ----------------- | ---------------------------- | --------------------------------------------------------- |
| No API key                     | n/a               | skip `missing_api_key`       | fail `missing_api_key` if Teacher was requested; else Off |
| 401 / revoked                  | n/a               | skip `authentication_failed` | fail category `authentication_failed`                     |
| 402                            | n/a               | skip `usage_quota_exhausted` | fail same                                                 |
| 403                            | n/a               | skip `authentication_failed` | fail same                                                 |
| 404 no models                  | n/a               | skip `model_unavailable`     | fail same                                                 |
| 429                            | n/a               | skip `rate_limited`          | fail same; cooldown                                       |
| 5xx                            | n/a               | skip `transient_transport`   | fail same; Teacher may Base3 fallback if allowed          |
| timeout / cancel               | n/a               | skip; never delay turn       | fail; interrupt honored                                   |
| actual model outside allowlist | n/a               | observational disagreement   | policy violation, fail safely                             |
| likely credentials in prompt   | n/a               | skip `likely_credentials`    | fail `likely_credentials`                                 |
| Teacher + Manual               | n/a               | observe only                 | skip `manual_selection`; Manual stays Manual              |
| catalog down                   | Phase 8 continues | observation may lack priors  | Teacher still constrained by live eligibility             |

Do not remap Teacher onto Shadow on failure.

## Redaction guarantees

Shared secret redaction matches at least:

- `Bearer …`
- `Authorization:`
- `api_key` / `api-key` assignments
- `sk-…` including `sk-or-…` (do not rely on a single exact prefix)
- `OPENROUTER_API_KEY=`
- Cursor `crsr_` tokens

Inspector, observations, logs, tests, UI Lab, and screenshots must not show
those values. Probe strings in the lab use non-production shapes.

## Phase 11 handoff

Append-only observation records (`OpenRouterTeacherObservationV0`) carry
sanitized fields listed above. Phase 11 may evaluate them later.

Phase 10 does not implement learning, reward calculation, retraining,
automatic weight changes, user-rework scoring, or quality judgment.

## Testing matrix

Deterministic fake transport only. No real OpenRouter key in CI.

- Off mode exact compatibility
- Shadow cannot alter execution
- Shadow failure cannot fail the real turn
- Teacher constrained to allowed models
- Out-of-policy returned model fails safely
- Missing / invalid / revoked API key
- Timeout and cancellation
- 401, 402, 403, 404, 429, 5xx normalization
- Streaming metadata on terminal chunk
- Missing task type and unknown future task type
- Actual model mapping; unresolved mappings stay unresolved
- Unknown metrics remain unknown
- Catalog pagination, cache TTL, last-known-good stale fallback
- Market-prior source timestamps
- ZDR/privacy payload; no plugins/tools
- Credential redaction; no prompt/completion in observations
- Bounded nested failover
- Phase 8 Manual/Auto and Phase 9 Control Center/Inspector regression
- UI Lab scenarios listed in the implementation

Optional live smoke (not blocking): `OPENROUTER_API_KEY` in the server
environment, never committed.

## Validation

- `vp run --filter @t3tools/web typecheck`
- `vp run --filter @t3tools/scripts typecheck`
- `vp run knip:check`
- `node scripts/base3router-ui-lab.ts`
- shared/contracts typechecks
- server provider/dispatcher tests
- Phase 8 router and failover regression
- Phase 9 composer/Inspector/Control Center tests
- security/redaction, catalog/cache tests
- targeted lint/format on touched files
