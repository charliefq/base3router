import {
  EnvironmentId,
  HYBRID_ROUTER_POLICY_VERSION,
  HYBRID_TASK_ROUTER_POLICY_VERSION,
  MODEL_ROUTER_POLICY_VERSION,
  ObservationId,
  RouterPolicyId,
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
import * as SqlClient from "effect/unstable/sql/SqlClient";

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

it.effect(
  "keeps environment defaults isolated and rejects stale competing operator transitions",
  () =>
    Effect.gen(function* () {
      const service = yield* RouterEvaluationService;
      const first = yield* service.status(environmentId);
      const remote = yield* service.status(EnvironmentId.make("other-environment"));
      assert.notEqual(first.active.policyId, remote.active.policyId);
      const candidate = first.policies.find(
        (policy) => policy.policyVersion === HYBRID_ROUTER_POLICY_VERSION,
      )!;
      const now = "2026-10-13T00:00:00.000Z";
      const forbidden = yield* service
        .activate(
          environmentId,
          { policyId: candidate.policyId, confirmActivation: true },
          true,
          now,
          "operator",
          first.revision,
        )
        .pipe(Effect.result);
      assert.equal(forbidden._tag, "Failure");
      assert.deepEqual(yield* service.status(environmentId), first);
      const crossEnvironment = yield* service
        .shadow(
          remote.environmentId,
          { policyId: candidate.policyId, confirmShadow: true },
          true,
          now,
          "operator",
          remote.revision,
        )
        .pipe(Effect.result);
      assert.equal(crossEnvironment._tag, "Failure");
      assert.deepEqual(yield* service.status(remote.environmentId), remote);
      const attempts = yield* Effect.all(
        [
          service
            .shadow(
              environmentId,
              { policyId: candidate.policyId, confirmShadow: true },
              true,
              now,
              "operator-a",
              first.revision,
            )
            .pipe(Effect.result),
          service
            .shadow(
              environmentId,
              { policyId: candidate.policyId, confirmShadow: true },
              true,
              now,
              "operator-b",
              first.revision,
            )
            .pipe(Effect.result),
        ],
        { concurrency: "unbounded" },
      );
      assert.equal(attempts.filter((attempt) => attempt._tag === "Success").length, 1);
      assert.equal(attempts.filter((attempt) => attempt._tag === "Failure").length, 1);
      const after = yield* service.status(environmentId);
      assert.equal(after.policies.filter((policy) => policy.state === "active").length, 1);
      assert.equal(after.policies.filter((policy) => policy.state === "shadow").length, 1);
      assert.equal(after.revision > first.revision, true);
      assert.deepEqual(yield* service.status(remote.environmentId), remote);
    }).pipe(Effect.provide(layer)),
);

it.effect("unauthorized or unconfirmed calls do not even initialize policies", () =>
  Effect.gen(function* () {
    const service = yield* RouterEvaluationService;
    const sql = yield* SqlClient.SqlClient;
    const candidate = RouterPolicyId.make("absent-policy");
    const unauthorized = yield* service
      .shadow(
        environmentId,
        { policyId: candidate, confirmShadow: true },
        false,
        "2026-10-13T00:00:00.000Z",
      )
      .pipe(Effect.flip);
    assert.equal(unauthorized.reason, "unauthorized_activation");
    const unconfirmed = yield* service
      .rollback(environmentId, { confirmRollback: false }, true, "2026-10-13T00:00:00.000Z")
      .pipe(Effect.flip);
    assert.equal(unconfirmed.reason, "confirmation_required");
    assert.equal(
      (yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM router_policies`)[0]?.count,
      0,
    );
    assert.equal(
      (yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM router_observation_events`)[0]
        ?.count,
      0,
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("audit failure rolls back policy changes and default initialization", () =>
  Effect.gen(function* () {
    const service = yield* RouterEvaluationService;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TRIGGER reject_policy_audit BEFORE INSERT ON router_observation_events WHEN NEW.event_type LIKE 'policy_%' BEGIN SELECT RAISE(ABORT, 'fixture audit failure'); END`;
    const failedInitialization = yield* service.status(environmentId).pipe(Effect.result);
    assert.equal(failedInitialization._tag, "Failure");
    assert.equal(
      (yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM router_policies`)[0]?.count,
      0,
    );
    yield* sql`DROP TRIGGER reject_policy_audit`;
    const status = yield* service.status(environmentId);
    const candidate = status.policies.find(
      (policy) => policy.policyVersion === HYBRID_ROUTER_POLICY_VERSION,
    )!;
    yield* sql`CREATE TRIGGER reject_policy_audit BEFORE INSERT ON router_observation_events WHEN NEW.event_type = 'policy_shadowed' BEGIN SELECT RAISE(ABORT, 'fixture audit failure'); END`;
    const failedShadow = yield* service
      .shadow(
        environmentId,
        { policyId: candidate.policyId, confirmShadow: true },
        true,
        "2026-10-13T00:00:00.000Z",
        "operator",
        status.revision,
      )
      .pipe(Effect.result);
    assert.equal(failedShadow._tag, "Failure");
    assert.deepEqual(yield* service.status(environmentId), status);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "activation audit failure rolls back both the new policy and retirement of the prior policy",
  () =>
    Effect.gen(function* () {
      const service = yield* RouterEvaluationService;
      const sql = yield* SqlClient.SqlClient;
      const initial = yield* service.status(environmentId);
      const candidate = initial.policies.find(
        (policy) => policy.policyVersion === HYBRID_ROUTER_POLICY_VERSION,
      )!;
      const shadow = yield* service.control(
        environmentId,
        {
          action: "shadow",
          policyId: candidate.policyId,
          expectedRevision: initial.revision,
          confirm: true,
        },
        "2026-10-13T00:00:00.000Z",
        "operator",
      );
      yield* sql`CREATE TRIGGER reject_activation_audit BEFORE INSERT ON router_observation_events WHEN NEW.event_type = 'policy_activated' BEGIN SELECT RAISE(ABORT, 'fixture activation audit failure'); END`;
      const failed = yield* service
        .control(
          environmentId,
          {
            action: "activate",
            policyId: candidate.policyId,
            expectedRevision: shadow.revision,
            confirm: true,
          },
          "2026-10-13T00:00:00.000Z",
          "operator",
        )
        .pipe(Effect.result);
      assert.equal(failed._tag, "Failure");
      assert.deepEqual(yield* service.status(environmentId), shadow);
      assert.equal(
        (yield* service.status(environmentId)).policies.filter(
          (policy) => policy.state === "active",
        ).length,
        1,
      );
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "adds a separate task candidate without rewriting existing policies and serializes one shadow",
  () =>
    Effect.gen(function* () {
      const service = yield* RouterEvaluationService;
      const sql = yield* SqlClient.SqlClient;
      const initial = yield* service.status(environmentId);
      const original = initial.policies.filter(
        (policy) => policy.policyVersion !== HYBRID_TASK_ROUTER_POLICY_VERSION,
      );
      yield* sql`DELETE FROM router_policies WHERE policy_id = ${initial.policies.find((policy) => policy.policyVersion === HYBRID_TASK_ROUTER_POLICY_VERSION)!.policyId}`;
      const after = yield* service.status(environmentId);
      assert.deepEqual(
        after.policies.filter(
          (policy) => policy.policyVersion !== HYBRID_TASK_ROUTER_POLICY_VERSION,
        ),
        original,
      );
      assert.equal(after.active.policyId, initial.active.policyId);
      const candidates = after.policies.filter((policy) => policy.state === "candidate");
      assert.equal(candidates.length, 2);
      assert.notEqual(candidates[0]!.policyId, candidates[1]!.policyId);
      const transitions = yield* Effect.all(
        candidates.map((policy) =>
          service
            .control(
              environmentId,
              {
                action: "shadow",
                policyId: policy.policyId,
                expectedRevision: after.revision,
                confirm: true,
              },
              "2026-10-13T00:00:00.000Z",
              "operator",
            )
            .pipe(Effect.result),
        ),
        { concurrency: "unbounded" },
      );
      assert.equal(transitions.filter((transition) => transition._tag === "Success").length, 1);
      assert.equal(transitions.filter((transition) => transition._tag === "Failure").length, 1);
      const shadow = yield* service.status(environmentId);
      assert.equal(shadow.policies.filter((policy) => policy.state === "shadow").length, 1);
      const other = shadow.policies.find((policy) => policy.state === "candidate")!;
      const rejected = yield* service
        .control(
          environmentId,
          {
            action: "shadow",
            policyId: other.policyId,
            expectedRevision: shadow.revision,
            confirm: true,
          },
          "2026-10-13T00:00:00.000Z",
          "operator",
        )
        .pipe(Effect.flip);
      assert.equal(rejected.reason, "illegal_transition");
      assert.deepEqual(yield* service.status(environmentId), shadow);
      assert.equal(
        (yield* service.status(EnvironmentId.make("second-environment"))).policies.filter(
          (policy) => policy.state === "shadow",
        ).length,
        0,
      );
    }).pipe(Effect.provide(layer)),
);
