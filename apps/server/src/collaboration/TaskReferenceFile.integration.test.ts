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
it.live.each(["adapter-accepted", "unknown"] as const)(
  "disk restart preserves %s file identity and readonly reconciliation without a new claim",
  (outcome) =>
    Effect.scoped(
      Effect.gen(function* () {
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
              });
              if (reviewed.status !== "available") throw new Error(reviewed.reason);
              const marker = { ...launch, referenceFile: reviewed.review };
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
              if (status.status === "admitted")
                assert.equal(status.referenceFileDelivery?.status, outcome);
            }),
          {
            dbPath,
            serverConfigLayer: configLayer,
            governedWorker: true,
            useProjectRuntimePolicy: true,
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
              assert.equal(result.referenceFileDelivery?.status, outcome);
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
