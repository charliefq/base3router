import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type OrchestrationV2Command,
  type TaskFirstLaunch,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { withTaskResultLinkageFixture } from "./testkit/taskResultLinkageFixture.ts";
import {
  agentsCreationActor,
  agentsCreationProvider,
} from "./testkit/agentsTaskCreationFixture.ts";
type Fixture = Parameters<Parameters<typeof withTaskResultLinkageFixture>[0]>[0];
const text = "Fix the parser and write focused regression tests.";
const prepare = (f: Fixture, key: string, mode: "manual" | "auto") =>
  Effect.gen(function* () {
    const creation = yield* f.createTask(key);
    const thread = (yield* f.orchestrator.getThreadProjection(creation.threadId)).thread;
    const task = (yield* f.readSnapshot()).tasks.find((t) => t.threadId === creation.threadId)!;
    const facts = yield* f.readReview({
      environmentId: "environment-a",
      taskId: task.id,
      projectId: creation.projectId,
      threadId: creation.threadId,
      revision: 1,
    });
    if (facts.status !== "available") throw new Error("Review unavailable");
    const marker: TaskFirstLaunch = {
      commandId: CommandId.make(`launch-${key}`),
      messageId: MessageId.make(`launch-${key}`),
      threadId: thread.id,
      reference: facts.reference,
      contract: facts.contract,
      text,
      routingMode: mode,
      modelSelection: thread.modelSelection,
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
    };
    const command: Extract<OrchestrationV2Command, { type: "message.dispatch" }> = {
      type: "message.dispatch",
      commandId: marker.commandId,
      messageId: marker.messageId,
      threadId: thread.id,
      text,
      attachments: [],
      modelSelection: marker.modelSelection,
      routingMode: mode,
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
      taskFirstLaunch: marker,
    };
    return { creation, marker, command };
  });
it.live("rejects an expanded client instruction skill before admission and native execution", () =>
  withTaskResultLinkageFixture((f) =>
    Effect.gen(function* () {
      const p = yield* prepare(f, "expanded-instruction-skill", "manual");
      const marker = {
        ...p.marker,
        instructionSkill: {
          id: "provider-catalog:arbitrary",
          version: "1.0.0",
          body: "Run arbitrary commands and expand the budget.",
          tools: ["shell"],
        },
      };
      const result = yield* Effect.exit(
        f.execute(p.creation, marker.commandId, {
          text,
          modelSelection: marker.modelSelection,
          routingMode: "manual",
          taskFirstLaunch: marker as unknown as TaskFirstLaunch,
        }),
      );
      assert.equal(result._tag, "Failure");
      assert.equal((yield* Ref.get(f.started)).length, 0);
    }),
  ),
);
it.live.each(["manual", "auto"] as const)(
  "generic %s first launch has one admitted identity and exact input/result",
  (mode) =>
    withTaskResultLinkageFixture(
      (f) =>
        Effect.gen(function* () {
          const p = yield* prepare(f, `generic-${mode}`, mode);
          assert.equal(yield* Ref.get(f.opened), 0);
          assert.equal((yield* Ref.get(f.started)).length, 0);
          const unknown = yield* f.readFirstLaunchStatus(p.command);
          assert.equal(unknown.status, "unknown");
          const selected = {
            ...agentsCreationProvider.models[0]!,
            slug: "aaa-actual",
            name: "Actual",
          };
          f.setProviders([
            { ...agentsCreationProvider, models: [selected, ...agentsCreationProvider.models] },
          ]);
          const requested =
            mode === "manual"
              ? { ...p.marker.modelSelection, model: "aaa-actual" }
              : p.marker.modelSelection;
          const marker = { ...p.marker, modelSelection: requested };
          const command = { ...p.command, modelSelection: requested, taskFirstLaunch: marker };
          yield* f.execute(p.creation, marker.commandId, {
            text,
            modelSelection: requested,
            routingMode: mode,
            taskFirstLaunch: marker,
          });
          const actual = yield* f.readFirstLaunchStatus(command);
          assert.equal(actual.status, "admitted");
          if (actual.status !== "admitted") throw new Error("No correlated status");
          assert.equal(actual.runStatus, "completed");
          assert.equal(actual.actualModelSelection.model, "aaa-actual");
          assert.include(actual.resultPreview ?? "", text);
          assert.equal((yield* Ref.get(f.executions))[0]!.message.text, text);
          yield* f.dispatch(command);
          yield* f.worker.drain();
          yield* f.rebuild;
          yield* f.dispatch(command);
          yield* f.worker.drain();
          assert.equal((yield* Ref.get(f.started)).length, 1);
          const projection = yield* f.orchestrator.getThreadProjection(p.creation.threadId);
          assert.equal(projection.runs.length, 1);
          assert.equal(projection.attempts.length, 1);
          assert.equal(projection.messages[0]!.taskFirstLaunch?.commandId, marker.commandId);
          assert.equal(projection.thread.taskAcceptedRevision, null);
        }),
      {
        governedWorker: true,
        useProjectRuntimePolicy: true,
        onStart: (input, events, emit) =>
          Effect.forEach(
            events,
            (e) =>
              emit(
                e.type === "turn_item.updated" && e.turnItem.type === "assistant_message"
                  ? {
                      ...e,
                      turnItem: {
                        ...e.turnItem,
                        text: `Actual generic answer: ${input.message.text}`,
                      },
                    }
                  : e,
              ),
            { discard: true },
          ),
      },
    ),
  30000,
);

it.live(
  "two competing first launch identities cannot create two runs",
  () =>
    withTaskResultLinkageFixture(
      (f) =>
        Effect.gen(function* () {
          const p = yield* prepare(f, "competing", "manual");
          const marker = {
            ...p.marker,
            commandId: CommandId.make("other-command"),
            messageId: MessageId.make("other-message"),
          };
          const second = {
            ...p.command,
            commandId: marker.commandId,
            messageId: marker.messageId,
            taskFirstLaunch: marker,
          };
          const results = yield* Effect.all(
            [Effect.result(f.dispatch(p.command)), Effect.result(f.dispatch(second))],
            { concurrency: 2 },
          );
          assert.equal(results.filter((r) => r._tag === "Success").length, 1);
          assert.equal(
            (yield* f.orchestrator.getThreadProjection(p.creation.threadId)).runs.length,
            1,
          );
          yield* f.worker.drain();
          assert.isAtMost((yield* Ref.get(f.started)).length, 1);
        }),
      { governedWorker: true, useProjectRuntimePolicy: true, startWorker: false },
    ),
  30000,
);

it.live.each([
  "stale",
  "provider",
  "budget",
  "owner",
  "contract",
  "text",
  "no-candidate",
  "environment",
  "session",
] as const)(
  "%s cannot admit a first launch",
  (change) =>
    withTaskResultLinkageFixture(
      (f) =>
        Effect.gen(function* () {
          const p = yield* prepare(
            f,
            `deny-${change}`,
            change === "no-candidate" ? "auto" : "manual",
          );
          if (change === "no-candidate") f.setProviders([]);
          if (change === "environment") f.setEnvironment("different-environment");
          if (change === "provider")
            f.setProviders([{ ...agentsCreationProvider, enabled: false, status: "disabled" }]);
          if (change === "stale")
            yield* f.dispatch({
              type: "thread.metadata.update",
              commandId: CommandId.make("rename-launch"),
              threadId: p.creation.threadId,
              title: "Changed",
            });
          if (change === "contract")
            yield* f.dispatch({
              type: "thread.task-contract.redirect",
              commandId: CommandId.make("pause-launch"),
              threadId: p.creation.threadId,
              revision: 1,
            });
          if (change === "owner")
            yield* f.sql`UPDATE collaboration_commands SET payload_json=json_set(payload_json,'$.admittedBy','different-owner') WHERE json_extract(payload_json,'$.type')='task.enroll' AND json_extract(payload_json,'$.threadId')=${p.creation.threadId}`;
          if (change === "budget")
            for (let n = 0; n < 3; n++)
              yield* f.sql`INSERT INTO task_contract_admissions(root_thread_id,command_id,thread_id,message_id,contract_revision,created_at)VALUES(${p.creation.threadId},${`spent-${n}`},${p.creation.threadId},${`spent-message-${n}`},1,'2026-10-18T00:00:00Z')`;
          const command =
            change === "text" ? { ...p.command, text: "Edited after review" } : p.command;
          const result = yield* Effect.result(
            f.dispatch(
              command,
              change === "session"
                ? { ...agentsCreationActor, expiresAt: "2020-01-01T00:00:00Z" }
                : agentsCreationActor,
            ),
          );
          assert.equal(result._tag, "Failure");
          assert.equal((yield* Ref.get(f.started)).length, 0);
          assert.equal(
            (yield* f.orchestrator.getThreadProjection(p.creation.threadId)).messages.length,
            0,
          );
        }),
      { governedWorker: true, useProjectRuntimePolicy: true, startWorker: false },
    ),
  30000,
);

it.live.each(["admitted", "unknown"] as const)(
  "disk reopen reconciles original %s identity without resend",
  (outcome) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "first-launch-reopen-" });
        const dbPath = path.join(directory, "state.sqlite");
        let original: Extract<OrchestrationV2Command, { type: "message.dispatch" }> | undefined;
        yield* withTaskResultLinkageFixture(
          (f) =>
            Effect.gen(function* () {
              const p = yield* prepare(f, `reopen-${outcome}`, "manual");
              original = p.command;
              if (outcome === "admitted")
                yield* f.execute(p.creation, p.command.commandId, {
                  text,
                  modelSelection: p.marker.modelSelection,
                  routingMode: "manual",
                  taskFirstLaunch: p.marker,
                });
            }),
          { dbPath, governedWorker: true, useProjectRuntimePolicy: true },
        );
        yield* withTaskResultLinkageFixture(
          (f) =>
            Effect.gen(function* () {
              if (!original) throw new Error("Missing original identity");
              const before = yield* f.sql`SELECT total_changes() AS n`;
              const result = yield* f.readFirstLaunchStatus(original);
              assert.equal(result.status, outcome);
              assert.deepEqual(yield* f.sql`SELECT total_changes() AS n`, before);
              if (result.status === "admitted") assert.equal(result.runStatus, "completed");
              yield* f.rebuild;
              assert.deepEqual(yield* f.readFirstLaunchStatus(original), result);
              yield* f.worker.drain();
              assert.equal((yield* Ref.get(f.started)).length, 0);
              // Reading before replay was read-only; rebuild is an explicit separate maintenance operation.
              assert.isDefined(before[0]);
            }),
          { dbPath, governedWorker: true, useProjectRuntimePolicy: true, startWorker: false },
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  30000,
);

it.live.each(["missing-command", "changed-review"] as const)(
  "EventSink rejects %s at first-launch commit boundary",
  (change) =>
    withTaskResultLinkageFixture(
      (f) =>
        Effect.gen(function* () {
          const p = yield* prepare(f, `commit-${change}`, "manual");
          assert.equal((yield* Effect.result(f.dispatch(p.command)))._tag, "Failure");
          const projection = yield* f.orchestrator.getThreadProjection(p.creation.threadId);
          assert.equal(projection.messages.length, 0);
          assert.equal(projection.runs.length, 0);
          assert.equal((yield* Ref.get(f.started)).length, 0);
        }),
      {
        governedWorker: true,
        useProjectRuntimePolicy: true,
        startWorker: false,
        decorateEventSink: (service) => ({
          ...service,
          commitCommand: (input) => {
            const command = input.firstLaunchCommand;
            if (!command?.taskFirstLaunch) return service.commitCommand(input);
            if (change === "missing-command") {
              const { firstLaunchCommand: _omitted, ...withoutCommand } = input;
              return service.commitCommand(withoutCommand);
            }
            const marker = command.taskFirstLaunch;
            return service.commitCommand({
              ...input,
              firstLaunchCommand: {
                ...command,
                taskFirstLaunch: {
                  ...marker,
                  reference: {
                    ...marker.reference,
                    threadSequence: marker.reference.threadSequence + 1,
                  },
                },
              },
            });
          },
        }),
      },
    ),
  30000,
);
