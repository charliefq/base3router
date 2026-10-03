import {
  EnvironmentId,
  HYBRID_ROUTER_POLICY_VERSION,
  MODEL_ROUTER_POLICY_VERSION,
  ObservationId,
  TURN_OUTCOME_OBSERVATION_VERSION,
  UNKNOWN_TASK_PROFILE,
  emptyCostMeasurement,
  emptyOutcomeEvidence,
  emptyTiming,
  emptyUsageMeasurement,
  type TurnOutcomeObservationV0,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { RouterEvaluationService, layer as evaluationLayer } from "./RouterEvaluationService.ts";

const layer = evaluationLayer.pipe(Layer.provideMerge(SqlitePersistenceMemory));
const environmentId = EnvironmentId.make("lab-environment");
const settings = {
  measurementEnabled: true,
  retentionDays: 90,
  challengerShadowEnabled: false,
};

const observation = (
  category: TurnOutcomeObservationV0["terminalCategory"],
): TurnOutcomeObservationV0 => ({
  version: TURN_OUTCOME_OBSERVATION_VERSION,
  observationId: ObservationId.make("syn-obs-eval"),
  environmentId,
  recordedAt: "2026-10-03T00:00:00.000Z",
  policyVersion: HYBRID_ROUTER_POLICY_VERSION,
  routingMode: "auto",
  model: "gpt-5.5",
  taskProfile: UNKNOWN_TASK_PROFILE,
  timing: emptyTiming(),
  usage: emptyUsageMeasurement(),
  cost: emptyCostMeasurement(),
  providerAttempts: 1,
  fallbackCount: 0,
  cancelled: false,
  timedOut: false,
  finishReason: category === "success" ? "stop" : "error",
  terminalCategory: category,
  evidence: emptyOutcomeEvidence(),
});

it.effect("records candidate provenance, typed confirmation failures, and live insights", () =>
  Effect.gen(function* () {
    const service = yield* RouterEvaluationService;
    const insights = yield* service.insights(environmentId, settings);
    assert.equal(insights.activePolicyVersion, MODEL_ROUTER_POLICY_VERSION);
    assert.equal(insights.candidatePolicyVersion, HYBRID_ROUTER_POLICY_VERSION);
    assert.equal(insights.candidatePolicyState, "candidate");
    assert.equal(insights.insufficientData, true);
    const policies = yield* service.listPolicies(environmentId);
    const candidate = policies.policies.find(
      (policy) => policy.policyVersion === HYBRID_ROUTER_POLICY_VERSION,
    );
    assert.equal(candidate?.sourceDatasetHash !== undefined, true);
    assert.equal(candidate?.evaluationRecordId !== undefined, true);
    const unconfirmed = yield* service
      .shadow(
        environmentId,
        { policyId: candidate!.policyId, confirmShadow: false },
        true,
        "2026-10-03T01:00:00.000Z",
        "user:test",
      )
      .pipe(Effect.flip);
    assert.equal(unconfirmed.reason, "confirmation_required");
    const unauthorized = yield* service
      .shadow(
        environmentId,
        { policyId: candidate!.policyId, confirmShadow: true },
        false,
        "2026-10-03T01:00:00.000Z",
      )
      .pipe(Effect.flip);
    assert.equal(unauthorized.reason, "unauthorized_activation");
    const shadowed = yield* service.shadow(
      environmentId,
      { policyId: candidate!.policyId, confirmShadow: true },
      true,
      "2026-10-03T01:00:00.000Z",
      "user:test",
    );
    assert.equal(shadowed.active.state, "shadow");
    assert.equal(shadowed.active.activatedBy, "user:test");
    const activated = yield* service.activate(
      environmentId,
      { policyId: candidate!.policyId, confirmActivation: true },
      true,
      "2026-10-03T01:01:00.000Z",
      "user:test",
    );
    assert.equal(activated.active.state, "active");
    assert.equal(activated.active.policyVersion, HYBRID_ROUTER_POLICY_VERSION);
    assert.equal(activated.active.activatedBy, "user:test");
    yield* service.recordObservation(observation("provider_failure"));
    yield* service.submitFeedback(
      environmentId,
      { observationId: ObservationId.make("syn-obs-eval"), kind: "not_helpful" },
      "2026-10-03T01:02:00.000Z",
      "user:test",
    );
    const afterFeedback = yield* service.insights(environmentId, settings);
    assert.equal(afterFeedback.observationCount, 1);
    assert.equal(afterFeedback.activePolicyVersion, HYBRID_ROUTER_POLICY_VERSION);
    const listed = yield* service.exportObservations(environmentId);
    assert.equal(listed.records[0]?.terminalCategory, "provider_failure");
    assert.equal(listed.records[0]?.evidence.explicitFeedback[0]?.kind, "not_helpful");
    assert.equal(listed.records[0]?.policyVersion, HYBRID_ROUTER_POLICY_VERSION);
    yield* service.rollback(
      environmentId,
      { confirmRollback: true },
      true,
      "2026-10-03T01:03:00.000Z",
      "user:test",
    );
    const afterRollback = yield* service.exportObservations(environmentId);
    assert.equal(afterRollback.records[0]?.policyVersion, HYBRID_ROUTER_POLICY_VERSION);
    const rolled = yield* service.insights(environmentId, settings);
    assert.equal(rolled.activePolicyVersion, MODEL_ROUTER_POLICY_VERSION);
  }).pipe(Effect.provide(layer)),
);
