import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { evidenceFromObservations } from "@t3tools/shared/routerEvaluation";
import {
  TaskResultFeedbackState as FeedbackStateSchema,
  type TaskResultFeedbackState,
  type TaskResultFeedbackSubmit,
} from "@t3tools/contracts";
import { withTaskResultFeedbackEffects } from "./testkit/taskResultFeedbackFixture.ts";
const decodeHttpFeedback = Schema.decodeUnknownEffect(FeedbackStateSchema);
const httpFeedback = (response: Promise<Response>) =>
  Effect.promise(() => response).pipe(
    Effect.flatMap((r) => Effect.promise(() => r.json())),
    Effect.flatMap(decodeHttpFeedback),
  );
const confirmed = (
  state: TaskResultFeedbackState,
  kind: "helpful" | "not_helpful",
): TaskResultFeedbackSubmit => {
  if (state.status !== "available") throw new Error(state.reason);
  return {
    ...state.target,
    reference: state.reference,
    fingerprint: state.fingerprint,
    contextKey: state.contextKey,
    kind,
    confirm: true,
  };
};
it.effect.each(["helpful", "not_helpful"] as const)(
  "persists immutable %s and enters existing explicit evidence",
  (kind) =>
    withTaskResultFeedbackEffects((f) =>
      Effect.gen(function* () {
        const before = yield* Effect.promise(f.baseline),
          changes = yield* f.sql`SELECT total_changes() AS n`;
        const facts = yield* Effect.promise(() => f.read());
        if (facts.status !== "available") throw new Error(facts.reason);
        expect(yield* f.sql`SELECT total_changes() AS n`).toEqual(changes);
        const saved = yield* Effect.promise(() => f.submit(confirmed(facts, kind)));
        expect(saved.status === "available" && saved.feedback.map((x) => x.kind)).toEqual([kind]);
        const replayChanges = yield* f.sql`SELECT total_changes() AS n`;
        yield* Effect.promise(() => f.submit(confirmed(facts, kind)));
        yield* Effect.promise(() =>
          f.submit(confirmed(facts, kind === "helpful" ? "not_helpful" : "helpful")),
        );
        expect(yield* f.sql`SELECT total_changes() AS n`).toEqual(replayChanges);
        expect(yield* Effect.promise(f.baseline)).toEqual(before);
        const reload = yield* Effect.promise(() => f.read());
        expect(reload.status === "available" && reload.feedback.map((x) => x.kind)).toEqual([kind]);
        const observations = yield* f.evaluation.exportObservations(f.observation.environmentId);
        const evidence = [...evidenceFromObservations(observations.records).values()][0];
        expect(evidence?.explicitTotal).toBe(1);
        expect(evidence?.explicitPositive).toBe(kind === "helpful" ? 1 : 0);
        expect(evidence?.explicitNegative).toBe(kind === "not_helpful" ? 1 : 0);
      }),
    ),
);
it.effect("records current dispatch attribution conflict and performs zero feedback writes", () =>
  withTaskResultFeedbackEffects(
    (f) =>
      Effect.gen(function* () {
        expect(f.observation.providerAttempts).toBe(0);
        const before = yield* Effect.promise(f.baseline),
          changes = yield* f.sql`SELECT total_changes() AS n`;
        expect(yield* Effect.promise(() => f.read())).toEqual({
          status: "unavailable",
          reason: "route-attribution-unavailable",
        });
        const snapshot = yield* Effect.promise(f.snapshot),
          task = snapshot.tasks.find((t) => t.id === f.input.taskId)!;
        yield* Effect.promise(() =>
          f.submit({
            ...f.input,
            reference: task.review!.reference,
            fingerprint: "diagnostic-only",
            contextKey: "diagnostic-only",
            kind: "helpful",
            confirm: true,
          }),
        );
        expect(yield* f.sql`SELECT total_changes() AS n`).toEqual(changes);
        expect(yield* Effect.promise(f.baseline)).toEqual(before);
        const stored = yield* f.evaluation.exportObservations(f.observation.environmentId);
        expect(stored.records[0]?.providerAttempts).toBe(0);
        expect(stored.records[0]?.evidence.explicitFeedback).toEqual([]);
      }),
    { legacyZero: true },
  ),
);
it.effect("has one durable winner under real concurrent opposing submissions", () =>
  withTaskResultFeedbackEffects((f) =>
    Effect.gen(function* () {
      const facts = yield* Effect.promise(() => f.read()),
        before = yield* Effect.promise(f.baseline);
      const results = yield* Effect.all(
        [
          Effect.promise(() => f.submit(confirmed(facts, "helpful"))),
          Effect.promise(() => f.submit(confirmed(facts, "not_helpful"))),
        ],
        { concurrency: "unbounded" },
      );
      const saved = yield* Effect.promise(() => f.read());
      expect(saved.status === "available" && saved.feedback).toHaveLength(1);
      expect(results.every((r) => r.status === "available" && r.feedbackForResult)).toBe(true);
      expect(
        yield* f.sql`SELECT event_id FROM router_observation_events WHERE event_type='explicit_feedback'`,
      ).toHaveLength(1);
      expect(yield* Effect.promise(f.baseline)).toEqual(before);
    }),
  ),
);
it.effect("rolls feedback and owner audit back together when audit insertion fails", () =>
  withTaskResultFeedbackEffects((f) =>
    Effect.gen(function* () {
      const facts = yield* Effect.promise(() => f.read()),
        before = yield* Effect.promise(f.baseline);
      yield* f.sql`CREATE TEMP TRIGGER feedback_audit_fault BEFORE INSERT ON router_observation_events WHEN NEW.event_type='explicit_feedback' BEGIN SELECT RAISE(ABORT,'fixture-audit-fault'); END`;
      yield* Effect.promise(() =>
        expect(f.submit(confirmed(facts, "helpful"))).rejects.toBeDefined(),
      );
      const fresh = yield* Effect.promise(() => f.read());
      expect(fresh.status === "available" && fresh.feedback).toEqual([]);
      expect(
        yield* f.sql`SELECT event_id FROM router_observation_events WHERE event_type='explicit_feedback'`,
      ).toHaveLength(0);
      expect(yield* Effect.promise(f.baseline)).toEqual(before);
    }),
  ),
);
it.effect(
  "preserves result judgment and all other evidence during actual duplicate and usage enrichment",
  () =>
    withTaskResultFeedbackEffects((f) =>
      Effect.gen(function* () {
        const verificationExit = yield* Effect.scoped(
          Effect.gen(function* () {
            const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
            return yield* spawner.exitCode(
              ChildProcess.make(process.execPath, ["-e", "if(2+2!==4)process.exit(1)"]),
            );
          }),
        ).pipe(Effect.provide(NodeServices.layer));
        expect(verificationExit).toBe(0);
        yield* f.evaluation.recordReworkProxy(
          f.observation.environmentId,
          f.observation.observationId,
          {
            kind: "regenerate",
            recordedAt: "2026-10-14T00:00:02Z",
            deduped: false,
            labeledAs: "proxy",
            rawEventType: "fixture-regenerate",
            detectionWindowMs: 5000,
          },
        );
        const withProxy = (yield* f.evaluation.exportObservations(f.observation.environmentId))
          .records[0]!;
        yield* f.repository.replaceEvidence({
          ...withProxy,
          evidence: {
            ...withProxy.evidence,
            verification: [
              {
                kind: "tests",
                result: "passed",
                exitStatus: verificationExit,
                retryCount: 0,
                recordedAt: "2026-10-14T00:00:03Z",
                fromRealCommand: true,
              },
            ],
          },
        });
        const preRating = (yield* f.evaluation.exportObservations(f.observation.environmentId))
          .records[0]!;
        const facts = yield* Effect.promise(() => f.read()),
          saved = yield* Effect.promise(() => f.submit(confirmed(facts, "helpful")));
        expect(saved.status === "available" && saved.feedbackForResult).toBe(true);
        const before = (yield* f.evaluation.exportObservations(f.observation.environmentId))
          .records[0]!;
        yield* f.repository.replaceEvidence({
          ...preRating,
          evidence: { explicitFeedback: [], reworkProxies: [], verification: [] },
        });
        yield* Effect.promise(f.replay);
        const replayed = (yield* f.evaluation.exportObservations(f.observation.environmentId))
          .records[0]!;
        expect(replayed.providerAttempts).toBe(1);
        expect(replayed.evidence).toEqual(before.evidence);
        yield* f.evaluation.recordObservation({
          ...before,
          usage: {
            ...before.usage,
            promptTokens: {
              status: "known",
              value: 19,
              unit: "token",
              source: "provider_reported",
              provenance: "observed",
              observedAt: "2026-10-14T00:00:02Z",
            },
          },
        });
        const after = (yield* f.evaluation.exportObservations(f.observation.environmentId))
          .records[0]!;
        expect(after.evidence).toEqual(before.evidence);
        expect(after.providerAttempts).toBe(1);
        expect(after.fallbackCount).toBe(0);
        expect(after.model).toBe(before.model);
        expect(after.cost).toEqual(before.cost);
        expect(after.usage.promptTokens.status).toBe("known");
        const fresh = yield* Effect.promise(() => f.read());
        expect(fresh.status === "available" && fresh.feedbackForResult).toBe(true);
      }),
    ),
);
it.effect.each([
  "foreign",
  "read-only",
  "expired",
  "wrong-environment",
  "wrong-project",
  "stale-revision",
  "stale-reference",
  "wrong-fingerprint",
  "wrong-session",
])("rejects %s with zero SQL mutation", (scenario) =>
  withTaskResultFeedbackEffects((f) =>
    Effect.gen(function* () {
      const facts = yield* Effect.promise(() => f.read()),
        original = confirmed(facts, "helpful"),
        before = yield* Effect.promise(f.baseline),
        changes = yield* f.sql`SELECT total_changes() AS n`;
      const request = { ...original };
      const actor = {
        kind: "session" as const,
        actorId: "fixture-owner",
        sessionId: "fixture-session",
        scopes: ["orchestration:read", "orchestration:operate"] as (
          | "orchestration:read"
          | "orchestration:operate"
        )[],
        expiresAt: undefined as string | undefined,
      };
      if (scenario === "foreign") actor.actorId = "other-owner";
      if (scenario === "read-only") actor.scopes = ["orchestration:read"];
      if (scenario === "expired") actor.expiresAt = "2020-01-01T00:00:00Z";
      if (scenario === "wrong-environment") request.environmentId = "other-environment";
      if (scenario === "wrong-project") request.projectId = "other-project";
      if (scenario === "stale-revision") request.revision++;
      if (scenario === "stale-reference")
        request.reference = {
          ...request.reference,
          threadSequence: request.reference.threadSequence + 1,
        };
      if (scenario === "wrong-fingerprint") request.fingerprint = "forged";
      if (scenario === "wrong-session") actor.sessionId = "replacement-session";
      expect((yield* Effect.promise(() => f.submit(request, actor))).status).toBe("unavailable");
      expect(yield* f.sql`SELECT total_changes() AS n`).toEqual(changes);
      expect(yield* Effect.promise(f.baseline)).toEqual(before);
    }),
  ),
);
it.effect.each([
  "physical-environment",
  "physical-message",
  "physical-version",
  "payload-model",
  "malformed-owner",
  "missing-observation",
  "same-item-tail",
  "provider-context",
])("retires %s before mutation", (scenario) =>
  withTaskResultFeedbackEffects((f) =>
    Effect.gen(function* () {
      const facts = yield* Effect.promise(() => f.read()),
        request = confirmed(facts, "helpful");
      if (scenario === "physical-environment")
        yield* f.sql`UPDATE router_turn_observations SET environment_id='forged'`;
      if (scenario === "physical-message")
        yield* f.sql`UPDATE router_turn_observations SET message_id='forged'`;
      if (scenario === "physical-version")
        yield* f.sql`UPDATE router_turn_observations SET schema_version='forged'`;
      if (scenario === "payload-model")
        yield* f.sql`UPDATE router_turn_observations SET payload_json=json_set(payload_json,'$.model','forged')`;
      if (scenario === "malformed-owner")
        yield* f.sql`UPDATE collaboration_commands SET payload_json=json_set(payload_json,'$.admittedBy','forged') WHERE json_extract(payload_json,'$.type')='task.enroll'`;
      if (scenario === "missing-observation") yield* f.sql`DELETE FROM router_turn_observations`;
      if (scenario === "same-item-tail")
        yield* f.sql`UPDATE orchestration_v2_projection_turn_items SET payload_json=json_set(payload_json,'$.text',json_extract(payload_json,'$.text') || 'changed beyond preview') WHERE type='assistant_message'`;
      if (scenario === "provider-context")
        yield* f.sql`UPDATE orchestration_v2_projection_provider_threads SET payload_json=json_set(payload_json,'$.nativeConversationHeadRef','replacement')`;
      const changes = yield* f.sql`SELECT total_changes() AS n`;
      expect((yield* Effect.promise(() => f.submit(request))).status).toBe("unavailable");
      expect(yield* f.sql`SELECT total_changes() AS n`).toEqual(changes);
    }),
  ),
);
it.effect(
  "retains an immutable judgment but does not present it as feedback for changed full output",
  () =>
    withTaskResultFeedbackEffects((f) =>
      Effect.gen(function* () {
        const facts = yield* Effect.promise(() => f.read());
        yield* Effect.promise(() => f.submit(confirmed(facts, "not_helpful")));
        yield* f.sql`UPDATE orchestration_v2_projection_turn_items SET payload_json=json_set(payload_json,'$.text',json_extract(payload_json,'$.text') || 'changed beyond preview') WHERE type='assistant_message'`;
        const fresh = yield* Effect.promise(() => f.read());
        expect(fresh.status === "available" && fresh.feedback[0]?.kind).toBe("not_helpful");
        expect(fresh.status === "available" && fresh.feedbackForResult).toBe(false);
      }),
    ),
);
it.effect(
  "authenticates and binds the actual selected-environment HTTP read and mutation without grants",
  () =>
    withTaskResultFeedbackEffects((f) =>
      Effect.gen(function* () {
        const before = yield* Effect.promise(f.baseline),
          changes = yield* f.sql`SELECT total_changes() AS n`;
        expect((yield* Effect.promise(() => f.http("read", f.input))).status).toBe(401);
        expect((yield* Effect.promise(() => f.http("read", f.input, "read"))).status).toBe(403);
        expect((yield* httpFeedback(f.http("read", f.input, "expired"))).status).toBe(
          "unavailable",
        );
        expect((yield* httpFeedback(f.http("read", f.input, "owner", "foreign"))).status).toBe(
          "unavailable",
        );
        const facts = yield* Effect.promise(() => f.readHttp());
        expect(facts.status).toBe("available");
        expect(yield* f.sql`SELECT total_changes() AS n`).toEqual(changes);
        const request = confirmed(facts, "helpful");
        expect((yield* Effect.promise(() => f.http("submit", request, "read"))).status).toBe(403);
        expect((yield* httpFeedback(f.http("submit", request, "expired"))).status).toBe(
          "unavailable",
        );
        expect((yield* httpFeedback(f.http("submit", request, "owner", "foreign"))).status).toBe(
          "unavailable",
        );
        expect(yield* f.sql`SELECT total_changes() AS n`).toEqual(changes);
        const saved = yield* Effect.promise(() => f.submitHttp(request));
        expect(saved.status === "available" && saved.feedbackForResult).toBe(true);
        expect(yield* Effect.promise(f.baseline)).toEqual(before);
      }),
    ),
);
