import {
  taskInstructionSkillModules,
  taskInstructionSkillRef,
} from "@t3tools/shared/taskInstructionSkills";
import * as Stream from "effect/Stream";
import * as Fiber from "effect/Fiber";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Context from "effect/Context";
import * as Ref from "effect/Ref";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  MessageId,
  ChatAttachmentId,
  type TaskFirstLaunch,
  type OrchestrationV2Command,
} from "@t3tools/contracts";
import { sha256Hex } from "@t3tools/shared/actionCanonical";
import { withTaskResultLinkageFixture } from "./testkit/taskResultLinkageFixture.ts";
import * as Config from "../config.ts";
import { createPendingAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";
it.live.each([
  ...(["adapter-accepted", "unknown"] as const).flatMap((outcome) =>
    [false, true].map((joint) => ({ outcome, joint })),
  ),
  { outcome: "partial" as const, joint: true },
])(
  "disk restart preserves $outcome file identity, joint=$joint, and readonly reconciliation without a new claim",
  ({ outcome, joint }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileOutcome = outcome === "partial" ? "adapter-accepted" : outcome;
        const skillOutcome = outcome === "partial" ? "unknown" : outcome;
        let interruptedEvidence = false;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "reference-file-restart-" });
        const dbPath = path.join(dir, "state.sqlite");
        const cfgctx = yield* Layer.build(Config.layerTest(dir, { prefix: "reference-store-" }));
        const config = Context.get(cfgctx, Config.ServerConfig);
        const configLayer = Layer.succeed(Config.ServerConfig, config);
        const text = "Original reference bytes: café\n";
        const source = {
          type: "file" as const,
          id: ChatAttachmentId.make(createPendingAttachmentId(".txt")),
          name: "notes.txt",
          mimeType: "text/plain",
          sizeBytes: new TextEncoder().encode(text).length,
        };
        const sourcePath = resolveAttachmentPath({
          attachmentsDir: config.attachmentsDir,
          attachment: source,
        })!;
        yield* fs.writeFileString(sourcePath, text);
        let original: Extract<OrchestrationV2Command, { type: "message.dispatch" }> | undefined;
        yield* withTaskResultLinkageFixture(
          (f) =>
            Effect.gen(function* () {
              const c = yield* f.createTask("reference-disk");
              const task = (yield* f.readSnapshot()).tasks.find((t) => t.threadId === c.threadId)!;
              const thread = (yield* f.orchestrator.getThreadProjection(c.threadId)).thread;
              const facts = yield* f.readReview({
                environmentId: "environment-a",
                projectId: c.projectId,
                taskId: task.id,
                threadId: c.threadId,
                revision: 1,
              });
              if (facts.status !== "available") throw new Error("No facts");
              const launch: TaskFirstLaunch = {
                commandId: CommandId.make("reference-disk"),
                messageId: MessageId.make("reference-disk"),
                threadId: c.threadId,
                text: "Use supplied notes only",
                reference: facts.reference,
                contract: facts.contract,
                routingMode: "auto",
                modelSelection: thread.modelSelection,
                runtimeMode: thread.runtimeMode,
                interactionMode: thread.interactionMode,
              };
              const reviewed = yield* f.reviewReferenceFile({
                launch,
                attachment: source,
                contentSha256: sha256Hex(text),
                ...(joint
                  ? { module: taskInstructionSkillRef(taskInstructionSkillModules()[0]!) }
                  : {}),
              });
              if (reviewed.status !== "available") throw new Error(reviewed.reason);
              const marker = {
                ...launch,
                referenceFile: reviewed.review,
                ...(reviewed.instructionSkill
                  ? { instructionSkill: reviewed.instructionSkill }
                  : {}),
              };
              original = {
                type: "message.dispatch",
                commandId: marker.commandId,
                messageId: marker.messageId,
                threadId: marker.threadId,
                text: marker.text,
                attachments: [source],
                routingMode: marker.routingMode,
                modelSelection: marker.modelSelection,
                dispatchMode: { type: "start_immediately" },
                createdBy: "user",
                creationSource: "web",
                taskFirstLaunch: marker,
              };
              const terminal = yield* f.orchestrator.streamDomainEvents.pipe(
                Stream.filter(
                  (e) =>
                    e.type === "run.updated" &&
                    e.payload.userMessageId === marker.messageId &&
                    ["completed", "failed", "cancelled", "interrupted"].includes(e.payload.status),
                ),
                Stream.take(1),
                Stream.runDrain,
                Effect.forkScoped,
              );
              yield* f.dispatchReference(original);
              yield* Fiber.join(terminal);
              yield* f.worker.drain();
              assert.equal((yield* Ref.get(f.started)).length, 1);
              const status = yield* f.readFirstLaunchStatus(original);
              assert.equal(status.status, "admitted");
              if (status.status === "admitted") {
                assert.equal(status.referenceFileDelivery?.status, fileOutcome);
                if (joint) assert.equal(status.instructionSkillDelivery?.status, skillOutcome);
              }
            }),
          {
            dbPath,
            serverConfigLayer: configLayer,
            governedWorker: true,
            useProjectRuntimePolicy: true,
            ...(outcome === "partial"
              ? {
                  decorateEventSink: (service) => ({
                    ...service,
                    writeIfRunCurrent: (input) => {
                      const event = input.events.find((e) => e.type === "run.updated");
                      if (
                        !interruptedEvidence &&
                        event?.type === "run.updated" &&
                        event.payload.referenceFileDelivery?.status === "adapter-accepted" &&
                        event.payload.instructionSkillDelivery?.status === "adapter-accepted"
                      ) {
                        interruptedEvidence = true;
                        return Effect.die("Synthetic interrupted joint acceptance evidence");
                      }
                      return service.writeIfRunCurrent(input);
                    },
                  }),
                }
              : {}),
            ...(outcome === "unknown"
              ? {
                  terminalOnly: true,
                  onStart: () => Effect.die("Synthetic unknown native acknowledgement"),
                }
              : {}),
          },
        );
        yield* fs.remove(sourcePath);
        yield* withTaskResultLinkageFixture(
          (f) =>
            Effect.gen(function* () {
              if (!original) throw new Error("No retained original");
              const before = yield* f.sql`SELECT total_changes() AS n`;
              const result = yield* f.readFirstLaunchStatus(original);
              assert.equal(result.status, "admitted");
              if (result.status !== "admitted") throw new Error("No original status");
              assert.equal(result.referenceFileDelivery?.status, fileOutcome);
              if (joint) assert.equal(result.instructionSkillDelivery?.status, skillOutcome);
              assert.deepEqual(yield* f.sql`SELECT total_changes() AS n`, before);
              yield* f.rebuild;
              assert.deepEqual(yield* f.readFirstLaunchStatus(original), result);
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
            startWorker: false,
          },
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  30000,
);

it.live("joint issuance consumption rolls back both pending records with failed admission", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "joint-atomic-" });
      const configContext = yield* Layer.build(
        Config.layerTest(dir, { prefix: "joint-atomic-store-" }),
      );
      const config = Context.get(configContext, Config.ServerConfig);
      const source = {
        type: "file" as const,
        id: ChatAttachmentId.make(createPendingAttachmentId(".txt")),
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 1,
      };
      yield* fs.writeFileString(
        resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment: source })!,
        "x",
      );
      yield* withTaskResultLinkageFixture(
        (f) =>
          Effect.gen(function* () {
            const created = yield* f.createTask("joint-atomic");
            const task = (yield* f.readSnapshot()).tasks.find(
              (t) => t.threadId === created.threadId,
            )!;
            const thread = (yield* f.orchestrator.getThreadProjection(created.threadId)).thread;
            const facts = yield* f.readReview({
              environmentId: "environment-a",
              projectId: created.projectId,
              taskId: task.id,
              threadId: created.threadId,
              revision: 1,
            });
            if (facts.status !== "available") return yield* Effect.die("No owned facts");
            const launch: TaskFirstLaunch = {
              commandId: CommandId.make("joint-atomic"),
              messageId: MessageId.make("joint-atomic"),
              threadId: created.threadId,
              text: "Summarize supplied notes",
              reference: facts.reference,
              contract: facts.contract,
              routingMode: "auto",
              modelSelection: thread.modelSelection,
              runtimeMode: thread.runtimeMode,
              interactionMode: thread.interactionMode,
            };
            const reviewed = yield* f.reviewReferenceFile({
              launch,
              attachment: source,
              contentSha256: sha256Hex("x"),
              module: taskInstructionSkillRef(taskInstructionSkillModules()[0]!),
            });
            if (reviewed.status !== "available" || !reviewed.instructionSkill)
              return yield* Effect.die("No joint issuance");
            const before =
              yield* f.sql`SELECT json_extract(payload_json,'$.__taskReferenceFileReview') AS file, json_extract(payload_json,'$.__taskInstructionSkillReview') AS skill FROM orchestration_v2_projection_threads WHERE thread_id=${created.threadId}`;
            yield* f.sql
              .unsafe(`CREATE TEMP TRIGGER reject_joint_retirement BEFORE UPDATE OF payload_json ON orchestration_v2_projection_threads
        WHEN json_extract(OLD.payload_json,'$.__taskInstructionSkillReview.review.reviewId') IS NOT NULL
        AND json_extract(OLD.payload_json,'$.__taskReferenceFileReview.review.reviewId') IS NULL
        AND json_extract(NEW.payload_json,'$.__taskInstructionSkillReview.review.reviewId') IS NULL
        BEGIN SELECT RAISE(ABORT,'Controlled joint retirement failure'); END`);
            const result = yield* f
              .dispatchReference({
                type: "message.dispatch",
                commandId: launch.commandId,
                messageId: launch.messageId,
                threadId: launch.threadId,
                text: launch.text,
                attachments: [source],
                routingMode: launch.routingMode,
                modelSelection: launch.modelSelection,
                dispatchMode: { type: "start_immediately" },
                createdBy: "user",
                creationSource: "web",
                taskFirstLaunch: {
                  ...launch,
                  referenceFile: reviewed.review,
                  instructionSkill: reviewed.instructionSkill,
                },
              })
              .pipe(Effect.exit);
            assert.equal(result._tag, "Failure");
            const after =
              yield* f.sql`SELECT json_extract(payload_json,'$.__taskReferenceFileReview') AS file, json_extract(payload_json,'$.__taskInstructionSkillReview') AS skill FROM orchestration_v2_projection_threads WHERE thread_id=${created.threadId}`;
            assert.deepEqual(after, before);
            // Policy admission reserves a start before the domain transaction; preserve that conservative bound on failure.
            assert.deepEqual(yield* f.noExecution(), {
              runs: 0,
              grants: 1,
              outbox: 0,
              messages: 0,
            });
            assert.equal((yield* Ref.get(f.started)).length, 0);
          }),
        {
          serverConfigLayer: Layer.succeed(Config.ServerConfig, config),
          governedWorker: true,
          useProjectRuntimePolicy: true,
        },
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
