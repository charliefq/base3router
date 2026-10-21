import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import type * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { OrchestrationV2Command, EnvironmentId } from "@t3tools/contracts";
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
  "nonexistent/both",
  "nonexistent/command",
  "nonexistent/thread",
  "existing/both",
  "existing/command",
  "existing/thread",
] as const)("rejects substituted %s nested creation receipt identities", (mode) =>
  withAgentsTaskCreationFixture((f) =>
    Effect.gen(function* () {
      const [kind, changed] = mode.split("/");
      const a = agentsCreationCommand("receipt-a");
      const original = yield* f.dispatch(a);
      const { taskCreationReview: _review, ...b } = agentsCreationCommand("receipt-b");
      if (kind === "existing") yield* f.dispatch(b);
      const { PolicyExecutionContext } = yield* Effect.promise(
        () => import("../policy/executionContext.ts"),
      );
      const substituted = {
        ...b,
        commandId: changed === "thread" ? a.commandId : b.commandId,
        threadId: changed === "command" ? a.threadId : b.threadId,
      };
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            f.eventSink
              .commitCommand({
                commandId: a.commandId,
                threadId: a.threadId,
                commandType: "thread.create",
                creationCommand: substituted,
                acceptedAt: yield* DateTime.now,
                events: original.storedEvents.map((e) => e.event),
                effects: [],
              })
              .pipe(Effect.provideService(PolicyExecutionContext, agentsCreationActor)),
          ),
        ),
        `${kind} ${changed} identity substitution must reject`,
      );
      assert.strictEqual((yield* f.dispatch(a)).sequence, original.sequence);
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
        assert.deepStrictEqual(yield* f.readStatus(command), { status: "committed" });
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

it.live("reads committed and future rejected creation outcomes without mutating or replaying", () =>
  withAgentsTaskCreationFixture((f) =>
    Effect.gen(function* () {
      const committed = agentsCreationCommand("status-committed");
      assert.deepStrictEqual(yield* f.readStatus(committed), { status: "unknown" });
      yield* f.dispatch(committed);
      assert.deepStrictEqual(yield* f.readStatus(committed), { status: "committed" });
      const rejected = agentsCreationCommand("status-rejected");
      f.setProviders([]);
      assert.isTrue(Exit.isFailure(yield* Effect.exit(f.dispatch(rejected))));
      const changesBefore = yield* f.sql<{ n: number }>`SELECT total_changes() AS n`;
      for (let i = 0; i < 2; i++)
        assert.deepStrictEqual(yield* f.readStatus(rejected), { status: "rejected" });
      assert.deepStrictEqual(yield* f.sql`SELECT total_changes() AS n`, changesBefore);
      assert.deepStrictEqual(yield* f.readStatus(committed), { status: "committed" });
      assert.deepStrictEqual(yield* f.noExecution(), {
        runs: 0,
        grants: 0,
        outbox: 0,
        messages: 0,
      });
      assert.strictEqual((yield* f.readSnapshot()).tasks.length, 1);
    }),
  ),
);

it.live.each([
  "actor",
  "readonly",
  "missing-session",
  "expired",
  "environment",
  "project",
  "thread",
  "command",
  "title",
  "contract",
  "model",
  "review",
] as const)("does not disclose/unlock creation rejection to %s mismatch", (mode) =>
  withAgentsTaskCreationFixture((f) =>
    Effect.gen(function* () {
      const command = agentsCreationCommand("isolated-rejection");
      f.setProviders([]);
      yield* Effect.exit(f.dispatch(command));
      let query = command;
      let actor: typeof agentsCreationActor & { expiresAt?: string } = agentsCreationActor;
      if (mode === "actor") actor = { ...actor, actorId: "foreign" };
      if (mode === "readonly") actor = { ...actor, scopes: ["orchestration:read"] };
      if (mode === "missing-session") actor = { ...actor, sessionId: "" };
      if (mode === "expired") actor = { ...actor, expiresAt: "2000-01-01T00:00:00Z" };
      if (mode === "environment") f.setEnvironment("foreign");
      if (mode === "project")
        query = {
          ...command,
          projectId:
            agentsCreationCommand("x").projectId === command.projectId
              ? ("project-b" as typeof command.projectId)
              : command.projectId,
        };
      if (mode === "thread")
        query = { ...command, threadId: agentsCreationCommand("other").threadId };
      if (mode === "command")
        query = { ...command, commandId: agentsCreationCommand("other").commandId };
      if (mode === "title") query = { ...command, title: "Other" };
      if (mode === "contract")
        query = { ...command, taskContract: { ...command.taskContract!, goal: "Other" } };
      if (mode === "model")
        query = { ...command, modelSelection: { ...command.modelSelection, model: "other" } };
      if (mode === "review")
        query = {
          ...command,
          taskCreationReview: {
            ...command.taskCreationReview!,
            projectId: "project-b" as typeof command.projectId,
          },
        };
      const before = yield* f.sql`SELECT total_changes() AS n`;
      const status = yield* f.readStatus(query, actor);
      assert.deepStrictEqual(status, {
        status:
          mode === "readonly" || mode === "missing-session" || mode === "expired"
            ? "unavailable"
            : "unknown",
      });
      assert.deepStrictEqual(yield* f.sql`SELECT total_changes() AS n`, before);
    }),
  ),
);

it.live.each([
  "accepted-first",
  "rejected-first",
  "same-thread-collision",
  "different-thread-collision",
  "legacy",
  "rollback",
  "corrupt-proof",
  "conflicting-event",
  "read-unavailable",
] as const)("keeps first-writer creation finality through %s", (mode) =>
  withAgentsTaskCreationFixture((f) =>
    Effect.gen(function* () {
      const a = agentsCreationCommand("first-writer-a");
      const b = { ...agentsCreationCommand("first-writer-b"), commandId: a.commandId };
      if (mode === "accepted-first") {
        yield* f.dispatch(a);
        f.setProviders([]);
        yield* Effect.exit(f.dispatch(b));
        assert.deepStrictEqual(yield* f.readStatus(a), { status: "committed" });
        assert.deepStrictEqual(yield* f.readStatus(b), { status: "unknown" });
        assert.strictEqual((yield* f.sql`SELECT * FROM agents_task_creation_rejections`).length, 0);
      } else if (mode === "legacy") {
        yield* f.eventSink.commitRejectedCommand({
          commandId: a.commandId,
          threadId: a.threadId,
          commandType: a.type,
          rejectedAt: yield* DateTime.now,
          error: "foreign legacy error",
        });
        f.setProviders([]);
        yield* Effect.exit(f.dispatch(a));
        assert.deepStrictEqual(yield* f.readStatus(a), { status: "unknown" });
        assert.strictEqual((yield* f.sql`SELECT * FROM agents_task_creation_rejections`).length, 0);
      } else if (mode === "rollback") {
        yield* f.sql`CREATE TRIGGER reject_proof_fault BEFORE INSERT ON agents_task_creation_rejections BEGIN SELECT RAISE(ABORT,'fixture proof fault'); END`;
        f.setProviders([]);
        yield* Effect.exit(f.dispatch(a));
        assert.strictEqual(
          (yield* f.sql`SELECT * FROM orchestration_command_receipts WHERE command_id=${a.commandId}`)
            .length,
          0,
        );
        assert.deepStrictEqual(yield* f.readStatus(a), { status: "unknown" });
      } else if (mode === "same-thread-collision" || mode === "different-thread-collision") {
        yield* f.dispatch(a);
        const other = {
          ...agentsCreationCommand("collision"),
          ...(mode === "same-thread-collision"
            ? { threadId: a.threadId }
            : { commandId: a.commandId }),
        };
        f.setProviders([]);
        yield* Effect.exit(f.dispatch(other));
        assert.deepStrictEqual(yield* f.readStatus(other), {
          status: mode === "same-thread-collision" ? "rejected" : "unknown",
        });
        assert.deepStrictEqual(yield* f.readStatus(a), { status: "committed" });
      } else {
        f.setProviders([]);
        yield* Effect.exit(f.dispatch(a));
        f.setProviders([agentsCreationProvider]);
        yield* Effect.exit(f.dispatch(a));
        yield* Effect.exit(f.dispatch(b));
        assert.strictEqual((yield* f.readSnapshot()).tasks.length, 0);
        assert.deepStrictEqual(yield* f.readStatus(a), { status: "rejected" });
        assert.deepStrictEqual(yield* f.readStatus(b), { status: "unknown" });
        if (mode === "corrupt-proof")
          yield* f.sql`UPDATE agents_task_creation_rejections SET command_json='{}' WHERE command_id=${a.commandId}`;
        if (mode === "conflicting-event") {
          const other = agentsCreationCommand("contradiction");
          yield* f.dispatch(other);
          yield* f.sql`UPDATE orchestration_events SET command_id=${a.commandId} WHERE command_id=${other.commandId}`;
        }
        if (mode === "read-unavailable") yield* f.sql`DROP TABLE agents_task_creation_rejections`;
        if (mode !== "rejected-first")
          assert.deepStrictEqual(yield* f.readStatus(a), {
            status: mode === "read-unavailable" ? "unavailable" : "unknown",
          });
      }
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
  "recovers only bound durable evidence after closing and reopening a disposable service",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "b3r-receipt-restart-" });
        const command = agentsCreationCommand("restarted-rejected");
        const committed = agentsCreationCommand("restarted-committed");
        yield* withAgentsTaskCreationFixture(
          (f) =>
            Effect.gen(function* () {
              yield* f.dispatch(committed);
              f.setProviders([]);
              yield* Effect.exit(f.dispatch(command));
              assert.deepStrictEqual(yield* f.readStatus(command), { status: "rejected" });
            }),
          { dbPath: `${dir}/fixture.sqlite` },
        );
        yield* withAgentsTaskCreationFixture(
          (f) =>
            Effect.gen(function* () {
              const before = yield* f.sql`SELECT total_changes() AS n`;
              assert.deepStrictEqual(yield* f.readStatus(command), { status: "rejected" });
              assert.deepStrictEqual(yield* f.readStatus(committed), { status: "committed" });
              assert.deepStrictEqual(yield* f.sql`SELECT total_changes() AS n`, before);
              assert.deepStrictEqual(yield* f.noExecution(), {
                runs: 0,
                grants: 0,
                outbox: 0,
                messages: 0,
              });
            }),
          { dbPath: `${dir}/fixture.sqlite` },
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live.each(["time", "error"] as const)(
  "keeps contradictory accepted receipt %s metadata unknown",
  (mode) =>
    withAgentsTaskCreationFixture((f) =>
      Effect.gen(function* () {
        const command = agentsCreationCommand(`accepted-corrupt-${mode}`);
        yield* f.dispatch(command);
        assert.deepStrictEqual(yield* f.readStatus(command), { status: "committed" });
        if (mode === "time")
          yield* f.sql`UPDATE orchestration_command_receipts SET accepted_at='not-a-timestamp' WHERE command_id=${command.commandId}`;
        else
          yield* f.sql`UPDATE orchestration_command_receipts SET error='private contradictory error' WHERE command_id=${command.commandId}`;
        const before = yield* f.sql`SELECT total_changes() AS n`;
        assert.deepStrictEqual(yield* f.readStatus(command), { status: "unknown" });
        assert.deepStrictEqual(yield* f.sql`SELECT total_changes() AS n`, before);
        assert.strictEqual((yield* f.readSnapshot()).tasks.length, 1);
        assert.deepStrictEqual(yield* f.noExecution(), {
          runs: 0,
          grants: 0,
          outbox: 0,
          messages: 0,
        });
      }),
    ),
);

const decodeRaceCreationProof = Schema.decodeUnknownSync(
  Schema.fromJsonString(OrchestrationV2Command),
);

it.live.each([
  "accepted/same",
  "accepted/different",
  "rejected/same",
  "rejected/different",
] as const)(
  "resolves actual EventSink reservation/commit race with %s winner and preserves replay",
  (mode) =>
    Effect.scoped(
      Effect.gen(function* () {
        const winner = mode.startsWith("accepted/") ? "accepted" : "rejected";
        const kind = mode.endsWith("/same") ? "same" : "different";
        const a = agentsCreationCommand(`boundary-${mode.replace("/", "-")}`);
        const b =
          kind === "same"
            ? a
            : { ...agentsCreationCommand(`${a.threadId}-other`), commandId: a.commandId };
        const planned = yield* Deferred.make<void>();
        const allowAccept = yield* Deferred.make<void>();
        const reserved = yield* Deferred.make<void>();
        const releaseWinner = yield* Deferred.make<void>();
        const acceptEntered = yield* Deferred.make<void>();
        const rejectEntered = yield* Deferred.make<void>();
        const inserts: Array<{ status: string; won: boolean }> = [];
        let plan: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | undefined;
        yield* withAgentsTaskCreationFixture(
          (f) =>
            Effect.gen(function* () {
              const accepted = yield* f.dispatch(a).pipe(Effect.exit, Effect.forkChild);
              yield* Deferred.await(planned);
              // Both contenders enter the real EventSink, while the winner still owns its SQL transaction.
              const beginReject = f.reject(b).pipe(Effect.forkChild);
              if (winner === "accepted") {
                yield* Deferred.succeed(allowAccept, undefined);
                yield* Deferred.await(reserved);
                const rejection = yield* beginReject;
                yield* Deferred.await(rejectEntered);
                yield* Deferred.succeed(releaseWinner, undefined);
                const acceptedResult = yield* Fiber.join(accepted);
                const rejectionResult = yield* Fiber.join(rejection);
                assert.isTrue(Exit.isSuccess(acceptedResult));
                assert.strictEqual(rejectionResult.status, "accepted");
              } else {
                const rejection = yield* beginReject;
                yield* Deferred.await(reserved);
                yield* Deferred.succeed(allowAccept, undefined);
                yield* Deferred.await(acceptEntered);
                yield* Deferred.succeed(releaseWinner, undefined);
                const rejectionResult = yield* Fiber.join(rejection);
                const acceptedResult = yield* Fiber.join(accepted);
                assert.strictEqual(rejectionResult.status, "rejected");
                assert.isTrue(Exit.isFailure(acceptedResult));
              }
              assert.deepStrictEqual(inserts, [
                { status: winner, won: true },
                { status: winner === "accepted" ? "rejected" : "accepted", won: false },
              ]);
              const receipts = yield* f.sql<{
                status: string;
                aggregate_id: string;
              }>`SELECT status,aggregate_id FROM orchestration_command_receipts WHERE command_id=${a.commandId}`;
              assert.deepStrictEqual(receipts, [
                { status: winner, aggregate_id: winner === "accepted" ? a.threadId : b.threadId },
              ]);
              const proofs = yield* f.sql<{
                actor_id: string;
                command_json: string;
              }>`SELECT actor_id,command_json FROM agents_task_creation_rejections WHERE command_id=${a.commandId}`;
              assert.strictEqual(proofs.length, winner === "rejected" ? 1 : 0);
              if (winner === "rejected") {
                assert.strictEqual(proofs[0]!.actor_id, agentsCreationActor.actorId);
                assert.deepStrictEqual(decodeRaceCreationProof(proofs[0]!.command_json), b);
              }
              assert.strictEqual(
                (yield* f.sql`SELECT sequence FROM orchestration_events WHERE command_id=${a.commandId}`)
                  .length,
                winner === "accepted" ? 1 : 0,
              );
              assert.strictEqual(
                (yield* f.sql`SELECT thread_id FROM orchestration_v2_projection_threads`).length,
                winner === "accepted" ? 1 : 0,
              );
              assert.strictEqual(
                (yield* f.readSnapshot()).tasks.length,
                winner === "accepted" ? 1 : 0,
              );
              assert.deepStrictEqual(yield* f.readStatus(winner === "accepted" ? a : b), {
                status: winner === "accepted" ? "committed" : "rejected",
              });
              if (kind === "different")
                assert.deepStrictEqual(yield* f.readStatus(winner === "accepted" ? b : a), {
                  status: "unknown",
                });
              const before = yield* f.sql`SELECT total_changes() AS n`;
              if (winner === "accepted") {
                assert.isDefined(plan);
                const replay = yield* f.commitCreation(plan!);
                assert.isFalse(replay.committed);
                assert.strictEqual(replay.receipt.status, "accepted");
                yield* f.dispatch(a);
              } else {
                assert.strictEqual((yield* f.reject(b)).status, "rejected");
                assert.isTrue(Exit.isFailure(yield* Effect.exit(f.dispatch(b))));
              }
              assert.deepStrictEqual(yield* f.sql`SELECT total_changes() AS n`, before);
              assert.deepStrictEqual(yield* f.noExecution(), {
                runs: 0,
                grants: 0,
                outbox: 0,
                messages: 0,
              });
            }),
          {
            decorateEventSink: (service) => ({
              ...service,
              commitCommand: (input) =>
                Effect.gen(function* () {
                  if (input.commandId === a.commandId) {
                    plan = input;
                    yield* Deferred.succeed(planned, undefined);
                    yield* Deferred.await(allowAccept);
                    yield* Deferred.succeed(acceptEntered, undefined);
                  }
                  return yield* service.commitCommand(input);
                }),
              commitRejectedCommand: (input) =>
                Effect.gen(function* () {
                  if (input.commandId === a.commandId)
                    yield* Deferred.succeed(rejectEntered, undefined);
                  return yield* service.commitRejectedCommand(input);
                }),
            }),
            decorateCommandReceipts: (service) => ({
              ...service,
              insertIfAbsent: (receipt) =>
                Effect.gen(function* () {
                  const won = yield* service.insertIfAbsent(receipt);
                  if (receipt.commandId === a.commandId) {
                    inserts.push({ status: receipt.status, won });
                    if (won && receipt.status === winner) {
                      yield* Deferred.succeed(reserved, undefined);
                      yield* Deferred.await(releaseWinner);
                    }
                  }
                  return won;
                }),
            }),
          },
        );
      }),
    ),
);
