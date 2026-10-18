import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  RunId,
  EnvironmentId,
  ThreadId,
  ActionApprovalId,
  ProjectId,
  type OrchestrationV2Command,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as DateTime from "effect/DateTime";
import { ActionGateService } from "../actionGate/ActionGateService.ts";
import { planMcpToolAction } from "../actionGate/mcpToolPlan.ts";
import { createPendingApproval } from "@t3tools/shared/actionGate";
import { agentsCreationProvider } from "./testkit/agentsTaskCreationFixture.ts";
import { executeCapabilityStep, CapabilityStepDenied } from "./TaskCapabilityStep.ts";
import { withTaskResultLinkageFixture } from "./testkit/taskResultLinkageFixture.ts";
import { withAgentsTaskCreationFixture } from "./testkit/agentsTaskCreationFixture.ts";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Recovery from "../orchestration-v2/ProviderRuntimeRecoveryService.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import * as ServerSettings from "../serverSettings.ts";

const decodeModelData = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      source: Schema.String,
      result: Schema.Struct({
        pullRequests: Schema.Array(
          Schema.Struct({ repository: Schema.String, number: Schema.Number }),
        ),
      }),
    }),
  ),
);

it.live(
  "reviews, admits and reads persisted PRs once, then the selected fake model answers from actual provenance context",
  () =>
    Effect.gen(function* () {
      let reads = 0;
      yield* withTaskResultLinkageFixture(
        (f) =>
          Effect.gen(function* () {
            const creation = yield* f.createTask("capability-root");
            yield* f.dispatch({
              type: "thread.pull-request.link",
              commandId: CommandId.make("link-capability-pr"),
              threadId: creation.threadId,
              host: "github.com",
              repository: "fixture/repository",
              number: 42,
              url: "https://github.com/fixture/repository/pull/42",
              source: "agent",
            });
            const task = (yield* f.readSnapshot()).tasks.find(
              (t) => t.threadId === creation.threadId,
            )!;
            const key = "capability-answer";
            const proposal = yield* f.readReview({
              environmentId: "environment-a",
              taskId: task.id,
              projectId: creation.projectId,
              threadId: creation.threadId,
              revision: 1,
              capabilityStep: { commandId: key, messageId: key, text: key },
            });
            assert.equal(proposal.status, "available");
            if (proposal.status !== "available" || !proposal.capabilityStep)
              throw new Error("Missing server-owned review");
            assert.equal(reads, 0);
            assert.equal(yield* Ref.get(f.opened), 0);
            assert.equal(
              proposal.capabilityStep.toolId,
              "t3-pull-requests/list_thread_pull_requests",
            );
            assert.equal(proposal.capabilityStep.argumentsJson, "{}");
            yield* f.execute(creation, key, {
              routingMode: "manual",
              modelSelection: creation.modelSelection,
              capabilityStep: proposal.capabilityStep,
            });
            assert.equal(reads, 1);
            const review = yield* f.readReview({
              environmentId: "environment-a",
              taskId: task.id,
              projectId: creation.projectId,
              threadId: creation.threadId,
              revision: 1,
            });
            assert.equal(review.status, "available");
            if (review.status !== "available") throw new Error("Missing result review");
            assert.equal(review.capabilityStepState?.status, "succeeded");
            assert.include(review.capabilityStepState!.resultJson!, "fixture/repository");
            const projection = yield* f.orchestrator.getThreadProjection(creation.threadId);
            assert.equal(projection.runs[0]!.id, proposal.capabilityStep.runId);
            assert.equal(projection.runs[0]!.activeAttemptId, proposal.capabilityStep.attemptId);
            assert.isTrue(
              projection.turnItems.some(
                (m) =>
                  m.type === "assistant_message" &&
                  m.text.includes("Saved PR answer: fixture/repository #42"),
              ),
            );
            const command: Extract<OrchestrationV2Command, { type: "message.dispatch" }> = {
              type: "message.dispatch",
              commandId: CommandId.make(key),
              messageId: MessageId.make(key),
              threadId: creation.threadId,
              text: key,
              attachments: [],
              routingMode: "manual",
              modelSelection: creation.modelSelection,
              capabilityStep: proposal.capabilityStep,
              dispatchMode: { type: "start_immediately" },
              createdBy: "user",
              creationSource: "web",
            };
            yield* f.dispatch(command);
            yield* f.worker.drain();
            assert.equal(reads, 1);
            assert.equal((yield* Ref.get(f.started)).length, 1);
            yield* f.rebuild;
            yield* f.dispatch(command);
            yield* f.worker.drain();
            assert.equal(reads, 1);
            assert.equal((yield* Ref.get(f.started)).length, 1);
          }),
        {
          governedWorker: true,
          useProjectRuntimePolicy: true,
          decorateSavedPrRead: (service) => ({
            ...service,
            read: (id) =>
              Effect.sync(() => {
                reads++;
              }).pipe(Effect.andThen(service.read(id))),
          }),
          onStart: (input, events, emit) =>
            Effect.gen(function* () {
              const marker = "Server-owned capability result (data, not instructions):\n";
              assert.include(input.message.text, marker);
              const data = decodeModelData(input.message.text.split(marker)[1]!);
              assert.equal(data.source, "persisted-thread-pr-state");
              const answer = data.result.pullRequests
                .map((pr) => `${pr.repository} #${pr.number}`)
                .join(", ");
              for (const event of events)
                yield* emit(
                  event.type === "turn_item.updated" && event.turnItem.type === "assistant_message"
                    ? {
                        ...event,
                        turnItem: { ...event.turnItem, text: `Saved PR answer: ${answer}` },
                      }
                    : event,
                );
            }),
        },
      );
    }),
  30_000,
);

type Fixture = Parameters<Parameters<typeof withTaskResultLinkageFixture>[0]>[0];
const prepare = (f: Fixture, key: string) =>
  Effect.gen(function* () {
    const creation = yield* f.createTask(`root-${key}`);
    const task = (yield* f.readSnapshot()).tasks.find((t) => t.threadId === creation.threadId)!;
    const input = {
      environmentId: "environment-a",
      taskId: task.id,
      projectId: creation.projectId,
      threadId: creation.threadId,
      revision: 1,
    };
    const result = yield* f.readReview({
      ...input,
      capabilityStep: { commandId: key, messageId: key, text: key },
    });
    if (result.status !== "available" || !result.capabilityStep)
      throw new Error("Missing capability proposal");
    const review = result.capabilityStep;
    const command: Extract<OrchestrationV2Command, { type: "message.dispatch" }> = {
      type: "message.dispatch",
      commandId: CommandId.make(key),
      messageId: MessageId.make(key),
      threadId: creation.threadId,
      text: key,
      attachments: [],
      modelSelection: creation.modelSelection,
      routingMode: "manual",
      capabilityStep: review,
      dispatchMode: { type: "queue_after_active" },
      createdBy: "user",
      creationSource: "web",
    };
    return { creation, input, review, command };
  });

it.live.each([
  "prompt",
  "model",
  "attempt",
  "schema",
  "tool",
  "arguments",
  "revision",
  "workspace",
  "missing step",
  "provider disabled",
] as const)(
  "denies %s before operation or provider startup",
  (change) =>
    Effect.gen(function* () {
      let reads = 0;
      yield* withTaskResultLinkageFixture(
        (f) =>
          Effect.gen(function* () {
            const p = yield* prepare(f, `mismatch-${change}`);
            const command = { ...p.command };
            switch (change) {
              case "prompt":
                command.text = "Changed instructions";
                break;
              case "model":
                command.modelSelection = { ...p.review.modelSelection, model: "different-model" };
                break;
              case "attempt":
                command.capabilityStep = { ...p.review, attemptId: "other-attempt" };
                break;
              case "schema":
                command.capabilityStep = { ...p.review, schemaDigest: "other-schema" };
                break;
              case "tool":
                command.capabilityStep = {
                  ...p.review,
                  toolId: "t3-preview/device_screenshot" as typeof p.review.toolId,
                };
                break;
              case "arguments":
                command.capabilityStep = {
                  ...p.review,
                  argumentsJson: '{"threadId":"other"}' as "{}",
                };
                break;
              case "revision":
                command.capabilityStep = { ...p.review, revision: 2 };
                break;
              case "workspace":
                command.capabilityStep = { ...p.review, workspace: "/other" };
                break;
              case "missing step":
                delete command.capabilityStep;
                break;
              case "provider disabled":
                f.setProviders([{ ...agentsCreationProvider, enabled: false, status: "disabled" }]);
                break;
            }
            const result = yield* Effect.result(f.dispatch(command));
            assert.equal(result._tag, "Failure");
            yield* f.worker.drain();
            assert.equal(reads, 0);
            assert.equal(yield* Ref.get(f.opened), 0);
            assert.equal((yield* Ref.get(f.started)).length, 0);
            assert.equal((yield* f.noExecution()).runs, 0);
          }),
        {
          governedWorker: true,
          useProjectRuntimePolicy: true,
          startWorker: false,
          decorateSavedPrRead: (service) => ({
            ...service,
            read: (id) =>
              Effect.sync(() => {
                reads++;
              }).pipe(Effect.andThen(service.read(id))),
          }),
        },
      );
    }),
  30_000,
);

it.live(
  "atomically allows one competing invoker and leaves an interrupted claimed operation UNKNOWN without native start",
  () =>
    Effect.gen(function* () {
      let reads = 0;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      yield* withTaskResultLinkageFixture(
        (f) =>
          Effect.gen(function* () {
            const p = yield* prepare(f, "competing-step");
            yield* Effect.all([f.dispatch(p.command), f.dispatch(p.command)], {
              concurrency: "unbounded",
            });
            const first = yield* f
              .governWorker(executeCapabilityStep(f.sql, p.review))
              .pipe(Effect.forkScoped);
            yield* Deferred.await(entered);
            const second = yield* Effect.result(
              f.governWorker(executeCapabilityStep(f.sql, p.review)),
            );
            assert.equal(second._tag, "Failure");
            assert.equal(reads, 1);
            yield* Fiber.interrupt(first);
            const state = yield* f.sql<{
              status: string;
            }>`SELECT status FROM base3_capability_steps WHERE review_id=${p.review.reviewId}`;
            assert.equal(state[0]!.status, "unknown");
            yield* f.rebuild;
            yield* f.dispatch(p.command);
            yield* f.worker.drain();
            assert.equal(reads, 1);
            assert.equal(yield* Ref.get(f.opened), 0);
            assert.equal((yield* Ref.get(f.started)).length, 0);
            assert.equal(
              (yield* f.sql<{
                status: string;
              }>`SELECT status FROM base3_capability_steps WHERE review_id=${p.review.reviewId}`)[0]!
                .status,
              "unknown",
            );
          }),
        {
          governedWorker: true,
          useProjectRuntimePolicy: true,
          startWorker: false,
          decorateSavedPrRead: (service) => ({
            ...service,
            read: (id) =>
              Effect.gen(function* () {
                reads++;
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
                return yield* service.read(id);
              }),
          }),
        },
      );
    }),
  30_000,
);

it.live(
  "a failed result write stays UNKNOWN and cannot start a model or resend after projection rebuild",
  () =>
    Effect.gen(function* () {
      let reads = 0;
      yield* withTaskResultLinkageFixture(
        (f) =>
          Effect.gen(function* () {
            const p = yield* prepare(f, "lost-result-write");
            yield* f.dispatch(p.command);
            yield* f.sql`CREATE TRIGGER fail_capability_result BEFORE UPDATE ON base3_capability_steps WHEN NEW.status='succeeded' BEGIN SELECT RAISE(FAIL,'synthetic result-write failure'); END`;
            yield* f.worker.drain();
            assert.equal(reads, 1);
            assert.equal(yield* Ref.get(f.opened), 0);
            yield* f.rebuild;
            yield* f.dispatch(p.command);
            yield* f.worker.drain();
            assert.equal(reads, 1);
            assert.equal((yield* Ref.get(f.started)).length, 0);
            assert.equal(
              (yield* f.sql<{
                status: string;
              }>`SELECT status FROM base3_capability_steps WHERE review_id=${p.review.reviewId}`)[0]!
                .status,
              "unknown",
            );
          }),
        {
          governedWorker: true,
          useProjectRuntimePolicy: true,
          startWorker: false,
          decorateSavedPrRead: (service) => ({
            ...service,
            read: (id) =>
              Effect.sync(() => {
                reads++;
              }).pipe(Effect.andThen(service.read(id))),
          }),
        },
      );
    }),
  30_000,
);

it.live(
  "a known operation failure is persisted and no provider starts",
  () =>
    Effect.gen(function* () {
      let reads = 0;
      yield* withTaskResultLinkageFixture(
        (f) =>
          Effect.gen(function* () {
            const p = yield* prepare(f, "failed-read");
            yield* f.dispatch(p.command);
            yield* f.worker.drain();
            assert.equal(reads, 1);
            assert.equal(yield* Ref.get(f.opened), 0);
            assert.equal(
              (yield* f.sql<{
                status: string;
              }>`SELECT status FROM base3_capability_steps WHERE review_id=${p.review.reviewId}`)[0]!
                .status,
              "failed",
            );
          }),
        {
          governedWorker: true,
          useProjectRuntimePolicy: true,
          startWorker: false,
          decorateSavedPrRead: (service) => ({
            ...service,
            read: () =>
              Effect.sync(() => {
                reads++;
              }).pipe(
                Effect.andThen(
                  new CapabilityStepDenied({ reason: "synthetic fixture read failure" }),
                ),
              ),
          }),
        },
      );
    }),
  30_000,
);

it.live.each([
  "disabled registration",
  "schema registration",
  "provider changed",
  "workspace changed",
  "task paused",
  "run interrupted",
] as const)(
  "revalidates %s after an admitted queue delay before read or provider",
  (change) =>
    Effect.gen(function* () {
      let reads = 0,
        enabled = true,
        digest: string | null = null;
      yield* withTaskResultLinkageFixture(
        (f) =>
          Effect.gen(function* () {
            const p = yield* prepare(f, `delayed-${change}`);
            yield* f.dispatch(p.command);
            if (change === "disabled registration") enabled = false;
            if (change === "schema registration") digest = "changed-schema";
            if (change === "provider changed")
              f.setProviders([{ ...agentsCreationProvider, enabled: false, status: "disabled" }]);
            if (change === "workspace changed")
              yield* f.sql`UPDATE projection_projects SET workspace_root='/different-scope' WHERE project_id=${p.creation.projectId}`;
            if (change === "task paused")
              yield* f.dispatch({
                type: "thread.task-contract.redirect",
                commandId: CommandId.make("pause-delayed"),
                threadId: p.creation.threadId,
                revision: 1,
              });
            if (change === "run interrupted")
              yield* f.dispatch({
                type: "run.interrupt",
                commandId: CommandId.make("interrupt-delayed"),
                threadId: p.creation.threadId,
                runId: RunId.make(p.review.runId),
              });
            yield* f.worker.drain();
            assert.equal(reads, 0);
            assert.equal(yield* Ref.get(f.opened), 0);
            assert.equal((yield* Ref.get(f.started)).length, 0);
          }),
        {
          governedWorker: true,
          useProjectRuntimePolicy: true,
          startWorker: false,
          decorateSavedPrRead: (service) => ({
            ...service,
            get enabled() {
              return enabled;
            },
            get schemaDigest() {
              return digest ?? service.schemaDigest;
            },
            read: (id) =>
              Effect.sync(() => {
                reads++;
              }).pipe(Effect.andThen(service.read(id))),
          }),
        },
      );
    }),
  30_000,
);

it.live(
  "an actual one-time approval is consumed, then changed task scope denies the read after the wait",
  () =>
    Effect.gen(function* () {
      let reads = 0;
      const waiting = yield* Deferred.make<void>();
      yield* withTaskResultLinkageFixture(
        (f) =>
          Effect.gen(function* () {
            const p = yield* prepare(f, "approval-delayed-step");
            yield* f.dispatch(p.command);
            const now = yield* DateTime.now;
            const nowIso = DateTime.formatIso(now);
            const plan = planMcpToolAction({
              toolName: "list_thread_pull_requests",
              args: {},
              environmentId: EnvironmentId.make("environment-a"),
              threadId: ThreadId.make(p.review.threadId),
              nowIso,
              expiresAt: DateTime.formatIso(DateTime.add(now, { minutes: 5 })),
            });
            if (!plan.action) throw new Error("Missing ActionGate recipe");
            const approval = yield* f.actionGate.putApproval(
              createPendingApproval({
                approvalId: ActionApprovalId.make("saved-pr-one-time"),
                plan: plan.plan,
                action: plan.action,
                nowIso,
                expiresAt: plan.plan.expiresAt!,
                threadId: p.creation.threadId,
                projectId: ProjectId.make(p.creation.projectId),
                askExplanation: "Synthetic stricter read policy",
              }),
            );
            const gate = {
              ...f.actionGate,
              authorizeTool: (input: Parameters<typeof f.actionGate.authorizeTool>[0]) =>
                f.actionGate.authorizeTool(input).pipe(
                  Effect.map((d) => ({
                    ...d,
                    decision: "ASK" as const,
                    requiresApproval: true,
                    approvalId: approval.approvalId,
                  })),
                ),
              waitForAuthorized: (...args: Parameters<typeof f.actionGate.waitForAuthorized>) =>
                Deferred.succeed(waiting, undefined).pipe(
                  Effect.andThen(f.actionGate.waitForAuthorized(...args)),
                ),
            };
            const executing = yield* f
              .governWorker(
                executeCapabilityStep(f.sql, p.review).pipe(
                  Effect.provideService(ActionGateService, gate),
                  Effect.result,
                ),
              )
              .pipe(Effect.forkScoped);
            yield* Deferred.await(waiting);
            f.setProviders([{ ...agentsCreationProvider, enabled: false, status: "disabled" }]);
            yield* f.actionGate.respond(
              { approvalId: approval.approvalId, decision: "grant" },
              nowIso,
            );
            assert.equal((yield* Fiber.join(executing))._tag, "Failure");
            assert.equal(reads, 0);
            assert.equal(yield* Ref.get(f.opened), 0);
            const stored = yield* f.actionGate.getApproval(approval.approvalId);
            assert.equal(stored._tag, "Some");
            if (stored._tag === "Some") assert.equal(stored.value.status, "consumed");
            yield* f.worker.drain();
            assert.equal(reads, 0);
          }),
        {
          governedWorker: true,
          useProjectRuntimePolicy: true,
          startWorker: false,
          decorateSavedPrRead: (service) => ({
            ...service,
            read: (id) =>
              Effect.sync(() => {
                reads++;
              }).pipe(Effect.andThen(service.read(id))),
          }),
        },
      );
    }),
  30_000,
);

it.live(
  "two invokers that both saw admitted still claim the operation only once",
  () =>
    Effect.gen(function* () {
      let reads = 0,
        arrived = 0;
      const both = yield* Deferred.make<void>();
      yield* withTaskResultLinkageFixture(
        (f) =>
          Effect.gen(function* () {
            const p = yield* prepare(f, "atomic-claim-race");
            yield* f.dispatch(p.command);
            const gate = {
              ...f.actionGate,
              authorizeTool: (input: Parameters<typeof f.actionGate.authorizeTool>[0]) =>
                Effect.gen(function* () {
                  arrived++;
                  if (arrived === 2) yield* Deferred.succeed(both, undefined);
                  yield* Deferred.await(both);
                  return yield* f.actionGate.authorizeTool(input);
                }),
            };
            const results = yield* Effect.all(
              [1, 2].map(() =>
                f.governWorker(
                  executeCapabilityStep(f.sql, p.review).pipe(
                    Effect.provideService(ActionGateService, gate),
                    Effect.result,
                  ),
                ),
              ),
              { concurrency: "unbounded" },
            );
            assert.equal(results.filter((r) => r._tag === "Success").length, 1);
            assert.equal(results.filter((r) => r._tag === "Failure").length, 1);
            assert.equal(reads, 1);
            assert.equal(yield* Ref.get(f.opened), 0);
          }),
        {
          governedWorker: true,
          useProjectRuntimePolicy: true,
          startWorker: false,
          decorateSavedPrRead: (service) => ({
            ...service,
            read: (id) =>
              Effect.sync(() => {
                reads++;
              }).pipe(Effect.andThen(service.read(id))),
          }),
        },
      );
    }),
  30_000,
);

it.live(
  "provider invalidation during the actual read retains the true read result but denies native session startup",
  () =>
    Effect.gen(function* () {
      let invalidate = () => {},
        reads = 0;
      yield* withTaskResultLinkageFixture(
        (f) =>
          Effect.gen(function* () {
            const p = yield* prepare(f, "after-read-invalidated");
            invalidate = () =>
              f.setProviders([{ ...agentsCreationProvider, enabled: false, status: "disabled" }]);
            yield* f.dispatch(p.command);
            yield* f.worker.drain();
            assert.equal(reads, 1);
            assert.equal(yield* Ref.get(f.opened), 0);
            assert.equal((yield* Ref.get(f.started)).length, 0);
            assert.equal(
              (yield* f.sql<{
                status: string;
              }>`SELECT status FROM base3_capability_steps WHERE review_id=${p.review.reviewId}`)[0]!
                .status,
              "succeeded",
            );
          }),
        {
          governedWorker: true,
          useProjectRuntimePolicy: true,
          startWorker: false,
          decorateSavedPrRead: (service) => ({
            ...service,
            read: (id) =>
              service.read(id).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    reads++;
                    invalidate();
                  }),
                ),
              ),
          }),
        },
      );
    }),
  30_000,
);

it.live(
  "closes and reopens the disposable database, then actual startup recovery retains UNKNOWN without resending operation or model",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let reads = 0;
        const entered = yield* Deferred.make<void>();
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "capability-restart-" });
        const dbPath = `${directory}/state.sqlite`;
        yield* withTaskResultLinkageFixture(
          (f) =>
            Effect.gen(function* () {
              const p = yield* prepare(f, "restart-uncertain-step");
              yield* f.dispatch(p.command);
              const invocation = yield* f
                .governWorker(executeCapabilityStep(f.sql, p.review))
                .pipe(Effect.forkScoped);
              yield* Deferred.await(entered);
              yield* Fiber.interrupt(invocation);
              assert.equal(reads, 1);
              assert.equal(yield* Ref.get(f.opened), 0);
              assert.equal(
                (yield* f.sql<{ status: string }>`SELECT status FROM base3_capability_steps`)[0]!
                  .status,
                "unknown",
              );
            }),
          {
            dbPath,
            governedWorker: true,
            useProjectRuntimePolicy: true,
            startWorker: false,
            decorateSavedPrRead: (service) => ({
              ...service,
              read: () =>
                Effect.gen(function* () {
                  reads++;
                  yield* Deferred.succeed(entered, undefined);
                  return yield* Effect.never;
                }),
            }),
          },
        );
        yield* withAgentsTaskCreationFixture(
          (f) =>
            Effect.gen(function* () {
              const layer = Recovery.layer.pipe(
                Layer.provide(
                  Layer.mergeAll(
                    ProjectionStore.layer,
                    EffectOutbox.layer,
                    IdAllocator.layer,
                    ServerSettings.layerTest(),
                    Layer.succeed(EventSink.EventSinkV2, f.eventSink),
                  ),
                ),
                Layer.provide(Layer.succeed(SqlClient.SqlClient, f.sql)),
              );
              yield* f.governWorker(
                Recovery.ProviderRuntimeRecoveryService.use((r) => r.recover).pipe(
                  Effect.provide(layer),
                ),
              );
              yield* f.governWorker(f.worker.drain());
              assert.equal(reads, 1);
              assert.equal(f.providerStarts(), 0);
              assert.equal(
                (yield* f.sql<{ status: string }>`SELECT status FROM base3_capability_steps`)[0]!
                  .status,
                "unknown",
              );
              assert.equal(
                (yield* f.sql<{
                  count: number;
                }>`SELECT COUNT(*) AS count FROM base3_capability_steps`)[0]!.count,
                1,
              );
            }),
          { dbPath },
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  30_000,
);
