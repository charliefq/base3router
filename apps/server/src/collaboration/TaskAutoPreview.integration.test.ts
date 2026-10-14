import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import {
  AuthOrchestrationReadScope,
  EnvironmentId,
  HYBRID_ROUTER_POLICY_VERSION,
  HYBRID_TASK_ROUTER_POLICY_VERSION,
  MODEL_ROUTER_POLICY_VERSION,
  UNKNOWN_TASK_PROFILE,
  ObservationId,
  ProviderInstanceId,
  TURN_OUTCOME_OBSERVATION_VERSION,
  emptyTiming,
  emptyUsageMeasurement,
  emptyCostMeasurement,
  emptyOutcomeEvidence,
  CommandId,
  MessageId,
  TaskAutoPreviewInput,
  TaskAutoPreviewState,
  DispatcherTaskRouteBinding,
} from "@t3tools/contracts";
import {
  agentsCreationActor,
  agentsCreationCommand,
  agentsCreationProvider,
  withAgentsTaskCreationFixture,
} from "./testkit/agentsTaskCreationFixture.ts";

const isPreviewState = Schema.is(TaskAutoPreviewState);
const decodeBinding = Schema.decodeUnknownSync(Schema.fromJsonString(DispatcherTaskRouteBinding));
it.live(
  "previews ephemeral Auto with zero writes and matches an actual disabled fake-adapter dispatch",
  () =>
    withAgentsTaskCreationFixture((f) =>
      Effect.gen(function* () {
        const c = agentsCreationCommand("auto-preview");
        c.taskContract = {
          ...c.taskContract!,
          brake: { maxProviderStarts: 2, stopConditions: "Scope changed" },
        };
        yield* f.dispatch(c);
        const task = (yield* f.readSnapshot()).tasks[0]!;
        const input: TaskAutoPreviewInput = {
          environmentId: "environment-a",
          taskId: task.id,
          projectId: c.projectId,
          threadId: c.threadId,
          revision: 1,
          reference: task.review!.reference,
          text: "Implement parser regression tests",
        };
        const before = yield* f.sql`SELECT total_changes() AS n`;
        const preview = yield* f.previewAuto(input);
        assert.strictEqual(preview.status, "available");
        if (preview.status !== "available") return;
        assert.deepStrictEqual(preview.request, input);
        assert.include(preview.policyFallbackReason!, "ephemeral");
        assert.strictEqual(preview.decision.executionStatus, "not-started");
        assert.equal(preview.decision.estimatedCostUsd.status, "unknown");
        assert.equal(preview.decision.estimatedLatencyMs.status, "unknown");
        assert.equal(preview.decision.estimatedQuality.status, "unknown");
        assert.deepStrictEqual(yield* f.sql`SELECT total_changes() AS n`, before);
        assert.deepStrictEqual(yield* f.noExecution(), {
          runs: 0,
          grants: 0,
          outbox: 0,
          messages: 0,
        });
        yield* f.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("send-auto"),
          threadId: c.threadId,
          messageId: MessageId.make("auto-message"),
          text: input.text,
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          routingMode: "auto",
        });
        const rows = yield* f.sql<{
          binding_json: string;
        }>`SELECT binding_json FROM projection_dispatcher_task_routes WHERE thread_id=${c.threadId}`;
        const binding = decodeBinding(rows[0]!.binding_json);
        assert.deepStrictEqual(binding.modelRoute?.selected, preview.decision.selected);
        assert.strictEqual(binding.modelRoute?.explanation, preview.decision.explanation);
        assert.deepStrictEqual(binding.localTaskProfile, preview.profile);
      }),
    ),
);

it.live.each([
  "readonly",
  "foreign",
  "environment",
  "project",
  "thread",
  "task",
  "revision",
  "reference",
  "blank",
  "ordinary",
  "child",
  "paused",
  "accepted",
  "deleted",
  "invalid-model",
  "sealed-owner",
] as const)("denies %s preview without SQL or execution effects", (mode) =>
  withAgentsTaskCreationFixture((f) =>
    Effect.gen(function* () {
      const c = agentsCreationCommand(`deny-${mode}`);
      yield* f.dispatch(c);
      const task = (yield* f.readSnapshot()).tasks[0]!;
      let input: TaskAutoPreviewInput = {
        environmentId: "environment-a",
        taskId: task.id,
        projectId: c.projectId,
        threadId: c.threadId,
        revision: 1,
        reference: task.review!.reference,
        text: "Implement parser tests",
      };
      const actor =
        mode === "foreign"
          ? { ...agentsCreationActor, actorId: "foreign" }
          : mode === "readonly"
            ? { ...agentsCreationActor, scopes: [AuthOrchestrationReadScope] }
            : agentsCreationActor;
      if (mode === "environment") input = { ...input, environmentId: "environment-b" };
      if (mode === "project") input = { ...input, projectId: "other" };
      if (mode === "thread") input = { ...input, threadId: "other" };
      if (mode === "task") input = { ...input, taskId: "other" };
      if (mode === "revision") input = { ...input, revision: 2 };
      if (mode === "reference")
        input = {
          ...input,
          reference: { ...input.reference, threadSequence: input.reference.threadSequence + 1 },
        };
      if (mode === "blank") input = { ...input, text: "  " };
      const changes = {
        ordinary: ["$.taskGovernance", "chat"],
        child: ["$.lineage.parentThreadId", "other"],
        paused: ["$.taskContractPhase", "redirected"],
        accepted: ["$.taskAcceptedRevision", 1],
        "invalid-model": ["$.modelSelection.model", "unattested"],
      } as const;
      if (mode in changes) {
        const [path, value] = changes[mode as keyof typeof changes];
        yield* f.sql`UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,${path},${value}) WHERE thread_id=${c.threadId}`;
      }
      if (mode === "deleted")
        yield* f.sql`UPDATE orchestration_v2_projection_threads SET deleted_at='2026-10-14T00:00:00Z' WHERE thread_id=${c.threadId}`;
      if (mode === "sealed-owner")
        yield* f.sql`UPDATE collaboration_commands SET payload_json=json_set(payload_json,'$.admittedBy','foreign') WHERE command_id=${`task:enroll:${c.commandId}`}`;
      const before = yield* f.sql`SELECT total_changes() AS n`;
      assert.deepStrictEqual(yield* f.previewAuto(input, actor), {
        status: "unavailable",
        reason: "task-preview-unavailable",
      });
      assert.deepStrictEqual(yield* f.sql`SELECT total_changes() AS n`, before);
      assert.deepStrictEqual(yield* f.noExecution(), {
        runs: 0,
        grants: 0,
        outbox: 0,
        messages: 0,
      });
    }),
  ),
);

it.live.each([
  "v1",
  "task-empty",
  "task-evidence",
  "task-evidence-manual",
  "unknown",
  "unavailable-policy",
  "unavailable-provider",
  "constraints",
] as const)("reads %s snapshot without writes and matches authoritative dispatch", (mode) =>
  withAgentsTaskCreationFixture((f) =>
    Effect.gen(function* () {
      const c = agentsCreationCommand(`policy-${mode}`);
      c.taskContract = {
        ...c.taskContract!,
        brake: { maxProviderStarts: 2, stopConditions: "Scope changed" },
      };
      yield* f.dispatch(c);
      const task = (yield* f.readSnapshot()).tasks[0]!;
      const input: TaskAutoPreviewInput = {
        environmentId: "environment-a",
        taskId: task.id,
        projectId: c.projectId,
        threadId: c.threadId,
        revision: 1,
        reference: task.review!.reference,
        text: mode === "unknown" ? "hello" : "Implement parser regression tests",
        ...(mode === "constraints" ? { constraints: { maxCostUsd: 0, maxLatencyMs: 0 } } : {}),
      };
      const env = EnvironmentId.make(input.environmentId);
      const now = DateTime.formatIso(yield* DateTime.now);
      if (!["unavailable-policy", "unavailable-provider", "constraints"].includes(mode)) {
        const initial = yield* f.evaluation.status(env);
        const candidate = initial.policies.find(
          (p) =>
            p.policyVersion ===
            (mode === "v1" ? HYBRID_ROUTER_POLICY_VERSION : HYBRID_TASK_ROUTER_POLICY_VERSION),
        )!;
        const shadow = yield* f.evaluation.control(
          env,
          {
            action: "shadow",
            policyId: candidate.policyId,
            expectedRevision: initial.revision,
            confirm: true,
          },
          now,
          "fixture-owner",
        );
        yield* f.evaluation.control(
          env,
          {
            action: "activate",
            policyId: candidate.policyId,
            expectedRevision: shadow.revision,
            confirm: true,
          },
          now,
          "fixture-owner",
        );
      }
      if (mode === "unavailable-policy") yield* f.sql`DROP TABLE router_policies`;
      if (mode === "unavailable-provider")
        f.setProviders([{ ...agentsCreationProvider, enabled: false }]);
      if (mode.startsWith("task-evidence")) {
        f.setProviders([
          agentsCreationProvider,
          { ...agentsCreationProvider, instanceId: ProviderInstanceId.make("alternative") },
        ]);
        const p = yield* f.previewAuto(input);
        assert.equal(p.status, "available");
        if (p.status !== "available") return;
        for (const instanceId of [
          agentsCreationProvider.instanceId,
          ProviderInstanceId.make("alternative"),
        ])
          for (let index = 0; index < 8; index++)
            yield* f.evaluation.recordObservation({
              version: TURN_OUTCOME_OBSERVATION_VERSION,
              observationId: ObservationId.make(`preview-evidence-${instanceId}-${index}`),
              environmentId: env,
              recordedAt: now,
              policyVersion: MODEL_ROUTER_POLICY_VERSION,
              routingMode: "auto",
              instanceId,
              model: "fake-model",
              taskProfile: UNKNOWN_TASK_PROFILE,
              localTaskProfile: p.profile,
              timing: emptyTiming(),
              usage: emptyUsageMeasurement(),
              cost: emptyCostMeasurement(),
              providerAttempts: 1,
              fallbackCount: 0,
              cancelled: false,
              timedOut: false,
              finishReason: instanceId === "alternative" ? "stop" : "error",
              terminalCategory: instanceId === "alternative" ? "success" : "provider_failure",
              evidence: emptyOutcomeEvidence(),
            });
      }
      const before = yield* f.sql`SELECT total_changes() AS n`;
      const preview = yield* f.previewAuto(input);
      assert.equal(preview.status, "available");
      assert.isTrue(isPreviewState(preview));
      if (preview.status !== "available") return;
      assert.deepStrictEqual(yield* f.sql`SELECT total_changes() AS n`, before);
      assert.deepStrictEqual(yield* f.noExecution(), {
        runs: 0,
        grants: 0,
        outbox: 0,
        messages: 0,
      });
      if (mode.startsWith("task-evidence")) {
        assert.equal(preview.decision.policyVersion, HYBRID_TASK_ROUTER_POLICY_VERSION);
        assert.equal(preview.decision.selected?.target.instanceId, "alternative");
      }
      if (mode === "task-empty") assert.include(preview.hybrid!.fallbackReason!, "coverage");
      if (mode === "unknown") {
        assert.equal(preview.profile.category, "unknown");
        assert.include(preview.hybrid!.fallbackReason!, "unknown");
      }
      if (mode === "unavailable-policy") {
        assert.include(preview.policyFallbackReason!, "ephemeral");
        return;
      }
      if (mode === "unavailable-provider" || mode === "constraints") {
        assert.equal(preview.decision.selected, null);
        return;
      }
      yield* f.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`send-${mode}`),
        threadId: c.threadId,
        messageId: MessageId.make(`message-${mode}`),
        text: input.text,
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        routingMode: mode === "task-evidence-manual" ? "manual" : "auto",
      });
      const rows = yield* f.sql<{
        binding_json: string;
      }>`SELECT binding_json FROM projection_dispatcher_task_routes WHERE thread_id=${c.threadId}`;
      const actual = decodeBinding(rows[0]!.binding_json);
      if (mode === "task-evidence-manual") {
        assert.equal(actual.modelRoute?.selected?.target.instanceId, "codex");
        assert.notEqual(actual.modelRoute?.explanation, preview.decision.explanation);
      } else {
        assert.deepStrictEqual(actual.modelRoute?.selected, preview.decision.selected);
        assert.equal(actual.modelRoute?.explanation, preview.decision.explanation);
      }
    }),
  ),
);

it.live("refuses a populated root even with a freshly read matching reference", () =>
  withAgentsTaskCreationFixture((f) =>
    Effect.gen(function* () {
      const c = agentsCreationCommand("populated-preview");
      c.taskContract = {
        ...c.taskContract!,
        brake: { maxProviderStarts: 2, stopConditions: "Scope changed" },
      };
      yield* f.dispatch(c);
      const task = (yield* f.readSnapshot()).tasks[0]!;
      const target = {
        environmentId: "environment-a",
        taskId: task.id,
        projectId: c.projectId,
        threadId: c.threadId,
        revision: 1,
      };
      yield* f.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("populate-preview"),
        threadId: c.threadId,
        messageId: MessageId.make("populated-message"),
        text: "Implement parser tests",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        routingMode: "auto",
      });
      const review = yield* f.readReview(target);
      assert.equal(review.status, "available");
      if (review.status !== "available") return;
      const before = yield* f.sql`SELECT total_changes() AS n`;
      const effects = yield* f.noExecution();
      assert.equal(effects.messages, 1);
      assert.deepStrictEqual(
        yield* f.previewAuto({
          ...target,
          reference: review.reference,
          text: "Implement further tests",
        }),
        { status: "unavailable", reason: "task-preview-unavailable" },
      );
      assert.deepStrictEqual(yield* f.sql`SELECT total_changes() AS n`, before);
      assert.deepStrictEqual(yield* f.noExecution(), effects);
    }),
  ),
);
