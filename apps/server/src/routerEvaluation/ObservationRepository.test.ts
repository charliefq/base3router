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
import { knownQuantity } from "@t3tools/shared/turnOutcome";
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

it.effect("locks cancelled and failed terminals against later success", () =>
  Effect.gen(function* () {
    const store = yield* ObservationRepository;
    const cancelled = {
      ...observation("syn-obs-race"),
      terminalCategory: "cancelled" as const,
      cancelled: true,
      finishReason: "cancelled" as const,
    };
    yield* store.upsert(cancelled);
    const successWrite = yield* store.upsert(observation("syn-obs-race"));
    assert.strictEqual(successWrite.kind, "rejected");
    const stored = yield* store.get("syn-obs-race");
    assert.equal(Option.isSome(stored) && stored.value.terminalCategory === "cancelled", true);
    const failed = {
      ...observation("syn-obs-failed"),
      terminalCategory: "provider_failure" as const,
      finishReason: "error" as const,
    };
    yield* store.upsert(failed);
    const failedThenSuccess = yield* store.upsert(observation("syn-obs-failed"));
    assert.strictEqual(failedThenSuccess.kind, "rejected");
    const duplicate = yield* store.upsert(observation("syn-obs-ok"));
    assert.strictEqual(duplicate.kind, "inserted");
    const again = yield* store.upsert(observation("syn-obs-ok"));
    assert.strictEqual(again.kind, "idempotent");
    const enriched = yield* store.upsert({
      ...observation("syn-obs-ok"),
      usage: {
        ...emptyUsageMeasurement(),
        promptTokens: knownQuantity({
          value: 9,
          unit: "token",
          source: "provider_reported",
          provenance: "observed",
          observedAt: "2026-10-03T00:00:01.000Z",
        }),
      },
    });
    assert.strictEqual(enriched.kind, "enriched");
    assert.strictEqual(enriched.observation.terminalCategory, "success");
    const writers = yield* Effect.all(
      [
        store.upsert({
          ...observation("syn-obs-compete"),
          terminalCategory: "cancelled",
          cancelled: true,
          finishReason: "cancelled",
        }),
        store.upsert(observation("syn-obs-compete")),
      ],
      { concurrency: "unbounded" },
    );
    const afterRace = yield* store.get("syn-obs-compete");
    assert.equal(Option.isSome(afterRace), true);
    if (Option.isSome(afterRace)) {
      assert.notEqual(afterRace.value.terminalCategory, "success");
    }
    const events = yield* store.listEvents(EnvironmentId.make("lab-environment"));
    assert.equal(
      events.some((event) => event.eventType === "conflict_rejected"),
      true,
    );
    const beforeRestart = yield* store.get("syn-obs-race");
    const reread = yield* store.get("syn-obs-race");
    assert.deepEqual(beforeRestart, reread);
    void writers;
  }).pipe(Effect.provide(layer)),
);

it.effect("rebuilds terminal facts from append-only events", () =>
  Effect.gen(function* () {
    const store = yield* ObservationRepository;
    yield* store.upsert(observation("syn-obs-events"));
    yield* store.replaceEvidence({
      ...observation("syn-obs-events"),
      evidence: {
        explicitFeedback: [
          {
            kind: "helpful",
            recordedAt: "2026-10-03T00:01:00.000Z",
            freeTextIncluded: false,
          },
        ],
        reworkProxies: [],
        verification: [],
      },
    });
    const events = yield* store.listEvents(EnvironmentId.make("lab-environment"));
    const projected = events.reduce(
      (category, event) => event.terminalCategory ?? category,
      "unknown" as string,
    );
    const stored = yield* store.get("syn-obs-events");
    assert.equal(Option.isSome(stored) && stored.value.terminalCategory, "success");
    assert.equal(projected, "success");
    assert.equal(
      Option.isSome(stored) && stored.value.evidence.explicitFeedback[0]?.kind,
      "helpful",
    );
    yield* store.replaceEvidence({
      ...observation("syn-obs-events"),
      terminalCategory: "cancelled",
      cancelled: true,
      finishReason: "cancelled",
      evidence: { explicitFeedback: [], reworkProxies: [], verification: [] },
    });
    const still = yield* store.get("syn-obs-events");
    assert.equal(Option.isSome(still) && still.value.terminalCategory, "success");
    assert.equal(Option.isSome(still) && still.value.evidence.explicitFeedback[0]?.kind, "helpful");
  }).pipe(Effect.provide(layer)),
);
