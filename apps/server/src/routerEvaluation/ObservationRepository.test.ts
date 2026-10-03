import {
  EnvironmentId,
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
import * as Option from "effect/Option";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ObservationRepository, layer as observationLayer } from "./ObservationRepository.ts";

const layer = observationLayer.pipe(Layer.provideMerge(SqlitePersistenceMemory));

const observation = (id: string, environment = "lab-environment"): TurnOutcomeObservationV0 => ({
  version: TURN_OUTCOME_OBSERVATION_VERSION,
  observationId: ObservationId.make(id),
  environmentId: EnvironmentId.make(environment),
  recordedAt: "2026-10-03T00:00:00.000Z",
  policyVersion: "model-router.v0",
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
  finishReason: "stop",
  terminalCategory: "success",
  evidence: emptyOutcomeEvidence(),
});

it.effect("upserts idempotently, scopes by environment, and deletes", () =>
  Effect.gen(function* () {
    const store = yield* ObservationRepository;
    const first = observation("syn-obs-1");
    yield* store.upsert(first);
    yield* store.upsert(first);
    yield* store.upsert(observation("syn-obs-2", "other-environment"));
    const listed = yield* store.listByEnvironment(EnvironmentId.make("lab-environment"));
    assert.strictEqual(listed.length, 1);
    assert.strictEqual(listed[0]?.observationId, "syn-obs-1");
    const encoded = listed[0];
    assert.equal("prompt" in (encoded ?? {}), false);
    assert.equal("completion" in (encoded ?? {}), false);
    const got = yield* store.get("syn-obs-1");
    assert.equal(Option.isSome(got), true);
    const deleted = yield* store.deleteByEnvironment(EnvironmentId.make("lab-environment"));
    assert.strictEqual(deleted, 1);
    const remaining = yield* store.listByEnvironment(EnvironmentId.make("lab-environment"));
    assert.strictEqual(remaining.length, 0);
    const other = yield* store.listByEnvironment(EnvironmentId.make("other-environment"));
    assert.strictEqual(other.length, 1);
    yield* store.upsert(observation("syn-obs-old"));
    const pruned = yield* store.pruneBefore(
      EnvironmentId.make("lab-environment"),
      "2026-10-04T00:00:00.000Z",
    );
    assert.strictEqual(pruned, 1);
    const afterPrune = yield* store.listByEnvironment(EnvironmentId.make("lab-environment"));
    assert.strictEqual(afterPrune.length, 0);
  }).pipe(Effect.provide(layer)),
);
