import * as Layer from "effect/Layer";
import * as Context from "effect/Context";
import * as Config from "../config.ts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  MessageId,
  EnvironmentId,
  type OrchestrationV2Command,
  type TaskFirstLaunch,
} from "@t3tools/contracts";
import { acceptedResultFacts, resultHandoffReference } from "@t3tools/shared/taskResultHandoff";
import { withTaskResultLinkageFixture } from "./testkit/taskResultLinkageFixture.ts";
import { agentsCreationCommand } from "./testkit/agentsTaskCreationFixture.ts";
it.live.each(["adapter-accepted", "unknown"] as const)(
  "disk restart/rebuild preserves %s handoff without source fetching or resend",
  (outcome) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem,
          path = yield* Path.Path,
          dir = yield* fs.makeTempDirectoryScoped({ prefix: "handoff-restart-" }),
          dbPath = path.join(dir, "state.sqlite");
        const context = yield* Layer.build(Config.layerTest(dir, { prefix: "handoff-store-" }));
        const configLayer = Layer.succeed(
          Config.ServerConfig,
          Context.get(context, Config.ServerConfig),
        );
        let original: Extract<OrchestrationV2Command, { type: "message.dispatch" }> | undefined;
        yield* withTaskResultLinkageFixture(
          (f) =>
            Effect.gen(function* () {
              const c = yield* f.createTask("disk-source");
              const initial = yield* f.readReview({
                environmentId: "environment-a",
                projectId: c.projectId,
                threadId: c.threadId,
                taskId: `task:governed:thread:${c.threadId}`,
                revision: 1,
              });
              if (initial.status !== "available") throw new Error("Source launch review missing");
              const sourceLaunch: TaskFirstLaunch = {
                commandId: CommandId.make("disk-source-output"),
                messageId: MessageId.make("disk-source-output"),
                threadId: c.threadId,
                reference: initial.reference,
                contract: initial.contract,
                text: "disk-source-output",
                routingMode: "manual",
                modelSelection: c.modelSelection,
                runtimeMode: c.runtimeMode,
                interactionMode: c.interactionMode,
              };
              yield* f.execute(c, "disk-source-output", {
                taskFirstLaunch: sourceLaunch,
                modelSelection: sourceLaunch.modelSelection,
                routingMode: "manual",
              });
              const input = {
                environmentId: "environment-a",
                projectId: c.projectId,
                threadId: c.threadId,
                taskId: `task:governed:thread:${c.threadId}`,
                revision: 1,
              };
              const review = yield* f.readReview(input);
              if (review.status !== "available") throw new Error("Source review missing");
              yield* f.dispatch({
                type: "thread.task-contract.accept",
                commandId: CommandId.make("disk-source-accept"),
                threadId: c.threadId,
                revision: 1,
                reviewTask: review.reference,
              });
              const task = (yield* f.readSnapshot()).tasks.find((t) => t.threadId === c.threadId)!;
              const projection = yield* f.orchestrator.getThreadProjection(c.threadId),
                facts = acceptedResultFacts(
                  task,
                  EnvironmentId.make("environment-a"),
                  yield* f.readReview(input),
                  projection,
                );
              if (!facts) throw new Error("Source facts missing");
              const source = resultHandoffReference(facts);
              const base = agentsCreationCommand("disk-destination"),
                d = {
                  ...base,
                  taskContract: {
                    goal: "Independent writing",
                    redirect: "Own scope",
                    acceptance: "Owner checks writing",
                    brake: { maxProviderStarts: 1, stopConditions: "Stop" },
                  },
                  taskCreationReview: { ...base.taskCreationReview!, resultHandoff: source },
                };
              yield* f.dispatch(d);
              const reviewD = yield* f.readReview({
                environmentId: "environment-a",
                projectId: d.projectId,
                threadId: d.threadId,
                taskId: `task:governed:thread:${d.threadId}`,
                revision: 1,
              });
              if (reviewD.status !== "available") throw new Error("Destination review missing");
              const marker: TaskFirstLaunch = {
                commandId: CommandId.make("disk-destination-output"),
                messageId: MessageId.make("disk-destination-output"),
                threadId: d.threadId,
                reference: reviewD.reference,
                contract: reviewD.contract,
                text: "Write using reference",
                routingMode: "manual",
                modelSelection: d.modelSelection,
                runtimeMode: d.runtimeMode,
                interactionMode: d.interactionMode,
                resultHandoff: source,
              };
              original = {
                type: "message.dispatch",
                commandId: marker.commandId,
                messageId: marker.messageId,
                threadId: marker.threadId,
                text: marker.text,
                attachments: [],
                routingMode: marker.routingMode,
                modelSelection: marker.modelSelection,
                dispatchMode: { type: "start_immediately" },
                createdBy: "user",
                creationSource: "web",
                taskFirstLaunch: marker,
              };
              yield* f.execute(d, marker.messageId, {
                taskFirstLaunch: marker,
                text: marker.text,
                routingMode: marker.routingMode,
                modelSelection: marker.modelSelection,
              });
              const status = yield* f.readFirstLaunchStatus(original);
              assert.equal(status.status, "admitted");
              if (status.status === "admitted")
                assert.equal(status.resultHandoffDelivery?.status, outcome);
              assert.deepEqual(yield* f.orchestrator.getThreadProjection(c.threadId), projection);
            }),
          {
            dbPath,
            serverConfigLayer: configLayer,
            governedWorker: true,
            useProjectRuntimePolicy: true,
            ...(outcome === "unknown"
              ? {
                  terminalOnly: true,
                  onStart: (input, events, emit) =>
                    input.threadId === "disk-destination"
                      ? Effect.die("Synthetic uncertain native outcome")
                      : Effect.forEach(events, emit, { discard: true }),
                }
              : {}),
          },
        );
        yield* withTaskResultLinkageFixture(
          (f) =>
            Effect.gen(function* () {
              if (!original) throw new Error("Original absent");
              const before = yield* f.sql`SELECT total_changes() AS n`,
                status = yield* f.readFirstLaunchStatus(original);
              assert.equal(status.status, "admitted");
              if (status.status === "admitted")
                assert.equal(status.resultHandoffDelivery?.status, outcome);
              assert.deepEqual(yield* f.sql`SELECT total_changes() AS n`, before);
              yield* f.rebuild;
              assert.deepEqual(yield* f.readFirstLaunchStatus(original), status);
              yield* f.dispatchReference(original);
              yield* f.dispatchReference(original);
              yield* f.worker.drain();
              assert.equal((yield* Ref.get(f.started)).length, 0);
            }),
          {
            dbPath,
            serverConfigLayer: configLayer,
            governedWorker: true,
            useProjectRuntimePolicy: true,
            startWorker: true,
          },
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  30000,
);
