import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as DateTime from "effect/DateTime";
import { EnvironmentId } from "@t3tools/contracts";
import {
  agentsCreationCommand,
  agentsCreationProvider,
  agentsCreationActor,
  withAgentsTaskCreationFixture,
} from "./testkit/agentsTaskCreationFixture.ts";

it.live(
  "creates two reviewed owned governed roots without changing the canonical conversation or execution",
  () =>
    withAgentsTaskCreationFixture((f) =>
      Effect.gen(function* () {
        const canonical = yield* f.openCanonical();
        assert.strictEqual(canonical.outcome, "applied");
        const canonicalId = canonical.snapshot.agents.find((a) => a.id === "codex")!.threadId;
        for (const id of ["agents-first", "agents-second"]) {
          const command = agentsCreationCommand(id);
          yield* f.dispatch(command);
          const projection = yield* f.orchestrator.getThreadProjection(command.threadId);
          assert.deepStrictEqual(projection.thread.taskContract, {
            revision: 1,
            ...command.taskContract,
          });
          assert.strictEqual(projection.thread.taskContractPhase, "active");
          assert.strictEqual(projection.thread.taskAcceptedRevision, null);
          assert.strictEqual(projection.thread.runtimeMode, "approval-required");
          assert.strictEqual(
            projection.thread.agentsTaskCreation?.actorId,
            agentsCreationActor.actorId,
          );
          const snapshot = yield* f.readSnapshot();
          assert.strictEqual(snapshot.tasks.filter((t) => t.threadId === id).length, 1);
          assert.strictEqual(snapshot.agents.find((a) => a.id === "codex")?.threadId, canonicalId);
          yield* f.dispatch(command);
        }
        assert.strictEqual((yield* f.readSnapshot()).tasks.length, 3);
        assert.strictEqual(
          (yield* f.openCanonical()).snapshot.agents.find((a) => a.id === "codex")?.threadId,
          canonicalId,
        );
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
  "read-only",
  "wrong-environment",
  "missing-provider",
  "disabled-provider",
  "missing-model",
  "wrong-project",
  "blank",
  "bad-brake",
  "missing-contract",
  "runtime",
  "review-model",
  "deadline",
] as const)("rejects reviewed creation with %s without partial artifacts", (mode) =>
  withAgentsTaskCreationFixture((f) =>
    Effect.gen(function* () {
      let command = agentsCreationCommand("agents-denied");
      let actor = agentsCreationActor;
      if (mode === "read-only") actor = { ...actor, scopes: [] };
      if (mode === "wrong-environment") f.setEnvironment("environment-b");
      if (mode === "missing-provider") f.setProviders([]);
      if (mode === "disabled-provider")
        f.setProviders([{ ...agentsCreationProvider, enabled: false }]);
      if (mode === "missing-model")
        command = {
          ...command,
          modelSelection: { ...command.modelSelection, model: "missing" },
          taskCreationReview: {
            ...command.taskCreationReview!,
            modelSelection: { ...command.modelSelection, model: "missing" },
          },
        };
      if (mode === "wrong-project")
        yield* f.sql`UPDATE projection_projects SET deleted_at='2026-10-13T00:00:00Z' WHERE project_id='project-a'`;
      if (mode === "blank")
        command = { ...command, taskContract: { ...command.taskContract!, goal: " " } };
      if (mode === "bad-brake")
        command = {
          ...command,
          taskContract: {
            ...command.taskContract!,
            brake: { maxProviderStarts: 0, stopConditions: "Stop" },
          },
        };
      if (mode === "missing-contract") command = { ...command, taskContract: undefined };
      if (mode === "runtime") command = { ...command, runtimeMode: "full-access" };
      if (mode === "review-model")
        command = {
          ...command,
          taskCreationReview: {
            ...command.taskCreationReview!,
            modelSelection: { ...command.modelSelection, model: "changed" },
          },
        };
      if (mode === "deadline")
        command = {
          ...command,
          taskContract: {
            ...command.taskContract!,
            brake: { ...command.taskContract!.brake, deadlineAt: "later" },
          },
        };
      assert.isTrue(Exit.isFailure(yield* Effect.exit(f.dispatch(command, actor))));
      assert.strictEqual(
        (yield* f.sql`SELECT thread_id FROM orchestration_v2_projection_threads`).length,
        0,
      );
      assert.strictEqual((yield* f.sql`SELECT command_id FROM collaboration_commands`).length, 0);
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
  "title",
  "contract",
  "brake",
  "review",
  "actor",
  "omitted-review",
  "current-project",
  "current-selection",
  "current-model",
  "current-lineage",
  "deleted",
] as const)("rejects conflicting reviewed creation %s at both replay boundaries", (mode) =>
  withAgentsTaskCreationFixture((f) =>
    Effect.gen(function* () {
      const command = agentsCreationCommand("agents-replay");
      const original = yield* f.dispatch(command);
      if (mode === "current-project")
        yield* f.sql`UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.projectId','foreign') WHERE thread_id=${command.threadId}`;
      if (mode === "current-selection")
        yield* f.sql`UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.modelSelection.instanceId','foreign') WHERE thread_id=${command.threadId}`;
      if (mode === "current-model")
        yield* f.sql`UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.modelSelection.model','unattested') WHERE thread_id=${command.threadId}`;
      if (mode === "current-lineage")
        yield* f.sql`UPDATE orchestration_v2_projection_threads SET payload_json=json_set(payload_json,'$.lineage.parentThreadId','foreign') WHERE thread_id=${command.threadId}`;
      if (mode === "deleted")
        yield* f.sql`UPDATE orchestration_v2_projection_threads SET deleted_at='2026-10-13T00:00:00Z' WHERE thread_id=${command.threadId}`;
      let conflict = command;
      let actor = agentsCreationActor;
      if (mode === "title") conflict = { ...command, title: "Different task" };
      if (mode === "contract")
        conflict = {
          ...command,
          taskContract: { ...command.taskContract!, goal: "Different goal" },
        };
      if (mode === "brake")
        conflict = {
          ...command,
          taskContract: {
            ...command.taskContract!,
            brake: { ...command.taskContract!.brake, maxCostUsd: 99 },
          },
        };
      if (mode === "review")
        conflict = {
          ...command,
          taskCreationReview: {
            ...command.taskCreationReview!,
            environmentId: EnvironmentId.make("different"),
          },
        };
      if (mode === "actor") actor = { ...actor, actorId: "foreign" };
      if (mode === "omitted-review") {
        const { taskCreationReview: _review, ...unbound } = command;
        conflict = unbound;
      }
      assert.isTrue(Exit.isFailure(yield* Effect.exit(f.dispatch(conflict, actor))));
      const { PolicyExecutionContext } = yield* Effect.promise(
        () => import("../policy/executionContext.ts"),
      );
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            f.eventSink
              .commitCommand({
                commandId: command.commandId,
                threadId: command.threadId,
                commandType: "thread.create",
                creationCommand: conflict,
                acceptedAt: yield* DateTime.now,
                events: original.storedEvents.map((e) => e.event),
                effects: [],
              })
              .pipe(Effect.provideService(PolicyExecutionContext, actor)),
          ),
        ),
      );
      assert.strictEqual(
        (yield* f.sql`SELECT command_id FROM collaboration_commands WHERE json_extract(payload_json,'$.type')='task.enroll'`)
          .length,
        1,
      );
    }),
  ),
);

it.live.each(["project-race", "enrollment-fault", "provider-race", "model-race"] as const)(
  "rolls back actual reviewed creation %s atomically",
  (mode) =>
    withAgentsTaskCreationFixture((f) =>
      Effect.gen(function* () {
        if (mode === "project-race")
          yield* f.sql`CREATE TRIGGER create_project_race BEFORE INSERT ON orchestration_command_receipts WHEN NEW.command_id='agents-create:atomic' BEGIN UPDATE projection_projects SET deleted_at='2026-10-13T00:00:00Z' WHERE project_id='project-a'; END`;
        else if (mode === "enrollment-fault")
          yield* f.sql`CREATE TRIGGER create_enrollment_fault BEFORE INSERT ON collaboration_commands WHEN json_extract(NEW.payload_json,'$.type')='task.enroll' BEGIN SELECT RAISE(ABORT,'fixture enrollment failure'); END`;
        else
          f.setProviderReadHook((count) => {
            if (count === 2)
              f.setProviders([
                {
                  ...agentsCreationProvider,
                  ...(mode === "provider-race" ? { enabled: false } : { models: [] }),
                },
              ]);
          });
        assert.isTrue(
          Exit.isFailure(yield* Effect.exit(f.dispatch(agentsCreationCommand("atomic")))),
        );
        assert.strictEqual(
          (yield* f.sql`SELECT thread_id FROM orchestration_v2_projection_threads`).length,
          0,
        );
        assert.strictEqual((yield* f.sql`SELECT command_id FROM collaboration_commands`).length, 0);
        assert.strictEqual((yield* f.sql`SELECT command_id FROM orchestration_events`).length, 0);
        assert.strictEqual(
          (yield* f.sql`SELECT command_id FROM orchestration_command_receipts WHERE status='accepted'`)
            .length,
          0,
        );
        assert.strictEqual(
          (yield* f.sql<{
            deleted_at: string | null;
          }>`SELECT deleted_at FROM projection_projects WHERE project_id='project-a'`)[0]!
            .deleted_at,
          null,
        );
        assert.deepStrictEqual(yield* f.noExecution(), {
          runs: 0,
          grants: 0,
          outbox: 0,
          messages: 0,
        });
      }),
    ),
);

it.live(
  "replays original reviewed creation after later revision and provider unavailability without effects",
  () =>
    withAgentsTaskCreationFixture((f) =>
      Effect.gen(function* () {
        const command = agentsCreationCommand("later");
        const receipt = yield* f.dispatch(command);
        yield* f.dispatch({
          type: "thread.task-contract.set",
          commandId: "later-revision" as typeof command.commandId,
          threadId: command.threadId,
          ...command.taskContract!,
          goal: "Later goal",
        });
        f.setProviders([]);
        assert.strictEqual((yield* f.dispatch(command)).sequence, receipt.sequence);
        assert.strictEqual(
          (yield* f.orchestrator.getThreadProjection(command.threadId)).thread.taskContract
            ?.revision,
          2,
        );
        assert.deepStrictEqual(yield* f.noExecution(), {
          runs: 0,
          grants: 0,
          outbox: 0,
          messages: 0,
        });
      }),
    ),
);
