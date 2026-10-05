# Follow-up experiments (not implemented)

These are design notes only. They are not entitlements, not billed
features, and not part of Internal Beta stabilization. Baseline
ActionGate, deletion, and privacy stay available.

Sources used as inspiration, not as proof of Base3Router behavior:
Replit “free the models”, Anthropic Claude-shaped science, Earendil
durable agents, arXiv 2609.37725, Google RRSI. QueryStory/Decisions
API integration is unverified; no vendor dependency is added.

## RoutingAdvisor

**Gap.** Auto Route binds from policy, eligibility, and failover
heuristics. There is no model that _recommends_ among already-eligible
candidates. Manual mode must remain an override the advisor cannot
touch.

**Seam.** After `Dispatcher` / model-router eligibility, before
`ProviderCommandReactor.sendTurn`. Hybrid Router stays the fallback
when the advisor abstains.

**Boundary.** The advisor may only rank server-filtered eligible
targets. It cannot add a filtered-out provider, skip ActionGate, or
override Manual.

**Evaluation.** Baseline: current Auto Route. Held-out: synthetic
turns with known eligible sets. Metrics: bind accuracy vs eligibility,
failover rate, rework (Phase 11), latency, advisor-call cost (known /
estimated / unknown).

**Rollback.** Settings flag default off. Disable returns current Auto
Route.

**Packaging.** Free: current Auto/Manual. Pro: optional advisor on
eligible candidates. Do not paywall eligibility filtering or Manual.

## ActionRiskAdvisor

**Gap.** ActionGate is deterministic ALLOW/ASK/DENY. There is no
advisory layer that can _flag_ ambiguous tools without granting
authority.

**Seam.** After `authorizeTool` produces a decision, before wait/execute.
Advisory output: allow / flag / block / abstain. `block` may only
tighten ASK/DENY, never weaken a DENY or skip ASK.

**Boundary.** Cannot grant authorization, change fingerprints, or
consume approvals. Untrusted tool descriptions remain untrusted.

**Evaluation.** Baseline: defaultDecisionForRisk. Held-out: synthetic
ASK/ALLOW/DENY tools including injection-shaped descriptions. Metrics:
false allow (must stay 0 vs ActionGate DENY), extra ASK rate, advisor
cost, latency.

**Rollback.** Flag off; ActionGate unchanged.

**Packaging.** Free: deterministic ActionGate. Pro: optional flags.
Never paywall DENY, ASK, or one-time consume.

## Context workspace

**Gap.** Dream Memory is durable facts. Users also need editable task
notes that are not memory, not evidence, not policy, and not
approvals.

**Seam.** New projection beside the thread, not `dream_memories`, not
ActionGate audit, not router observations.

**Boundary.** Notes never enter ActionGate, routing, or system
instructions unless the user explicitly pastes them. Not retrieved by
Dream. Deletion is the same logical tombstone story: not forensic,
not provider recall.

**Evaluation.** Baseline: none (feature absent). Held-out: notes must
not appear in memory list, capsules, or approval records.

**Rollback.** Hide UI; stop writing the projection.

**Packaging.** Free: local notes. Team: shared project notes later.
Do not paywall Dream deletion or ActionGate.

## Cost note

Advisor experiments add model-call cost that must stay known,
estimated, or unknown — never hidden. Total cost includes those calls
plus the bound provider turn. No automatic production self-modification.
