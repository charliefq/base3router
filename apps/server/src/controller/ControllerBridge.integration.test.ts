import * as NodeCrypto from "node:crypto";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import * as Stream from "effect/Stream";
import * as Ref from "effect/Ref";
import * as Fiber from "effect/Fiber";
import {
  OrchestrationV2Command,
  AuthSessionId,
  ControllerStatus,
  ControllerTaskView,
  ControllerToolInputs,
  EnvironmentId,
  ThreadId,
  RunId,
  AuthAccessReadScope,
  AuthAccessWriteScope,
} from "@t3tools/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { PolicyExecutionContext } from "../policy/executionContext.ts";
import { taskResultFeedbackLayer } from "../collaboration/store.ts";
import * as RouterEvaluation from "../routerEvaluation/RouterEvaluationService.ts";
import * as Bridge from "./ControllerBridge.ts";
import * as TaskRecords from "../orchestration-v2/TaskRecords.ts";
import * as ControllerHttp from "./http.ts";
import { HttpRouter } from "effect/unstable/http";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { withTaskResultLinkageFixture } from "../collaboration/testkit/taskResultLinkageFixture.ts";
import { agentsCreationProvider } from "../collaboration/testkit/agentsTaskCreationFixture.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeCommand = Schema.decodeUnknownEffect(OrchestrationV2Command);
type Fixture = Parameters<Parameters<typeof withTaskResultLinkageFixture>[0]>[0];
const token = "b3rc_fixture_only_controller_alpha_00000000";
const other = "b3rc_fixture_only_controller_beta_00000000";
const create = {
  idempotencyKey: "create-1",
  projectId: "project-a",
  title: "Controller fixture",
  modelSelection: { instanceId: "codex", model: "fake-model" },
  contract: {
    goal: "Fix parser",
    redirect: "Ask before scope changes",
    acceptance: "Focused test passes",
    brake: { maxProviderStarts: 3, stopConditions: "Scope changes" },
  },
};
const withBridge = <A, E>(
  f: Fixture,
  test: (bridge: Bridge.ControllerBridge["Service"]) => Effect.Effect<A, E>,
  loseStartReply = false,
) => {
  let replyLost = false;
  return Effect.gen(function* () {
    const expires = DateTime.formatIso(DateTime.add(yield* DateTime.now, { hours: 1 }));
    for (const [id, value] of [
      ["alpha", token],
      ["beta", other],
    ] as const) {
      yield* f.sql`INSERT OR IGNORE INTO controller_identities(id,display_name,token_sha256,projects_json,actions_json,expires_at)
      VALUES(${id},${id},${NodeCrypto.createHash("sha256").update(value).digest("hex")},${encodeJson(["project-a"])},${encodeJson(Object.keys(ControllerToolInputs))},${expires})`;
    }
    const bridge = yield* Bridge.ControllerBridge;
    return yield* test(bridge);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Bridge.layer.pipe(
          Layer.provide(
            taskResultFeedbackLayer.pipe(
              Layer.provide(Layer.succeed(RouterEvaluation.RouterEvaluationService, f.evaluation)),
            ),
          ),
          Layer.provide(
            Layer.succeed(Orchestrator.OrchestratorV2, {
              ...f.orchestrator,
              dispatch: (command) =>
                Effect.gen(function* () {
                  const actor = yield* PolicyExecutionContext;
                  const result = yield* f.dispatch(
                    yield* decodeCommand(command).pipe(Effect.orDie),
                    actor,
                  );
                  if (loseStartReply && !replyLost && command.type === "message.dispatch") {
                    replyLost = true;
                    return yield* new Orchestrator.OrchestratorDispatchError({
                      commandId: command.commandId,
                      commandType: command.type,
                      cause: "Fixture lost response after durable admission",
                    });
                  }
                  return result;
                }),
            }),
          ),
          Layer.provide(
            Layer.mock(ServerEnvironment)({
              getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-a")),
            }),
          ),
          Layer.provide(Layer.succeed(SqlClient.SqlClient, f.sql)),
        ),
        Layer.mock(ServerEnvironment)({
          getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-a")),
        }),
        Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([agentsCreationProvider]) }),
        Layer.succeed(SqlClient.SqlClient, f.sql),
      ),
    ),
  );
};
const denied = <A>(
  effect: Effect.Effect<A, Bridge.ControllerBridgeError>,
  code: Bridge.ControllerBridgeError["code"],
) =>
  effect.pipe(
    Effect.flip,
    Effect.tap((error) => Effect.sync(() => assert.equal(error.code, code))),
    Effect.asVoid,
  );

it.live(
  "controller lifecycle uses governed receipts; duplicates start once and reads bounded result",
  () =>
    withTaskResultLinkageFixture(
      (f) =>
        withBridge(f, (bridge) =>
          Effect.scoped(
            Effect.gen(function* () {
              const created = yield* bridge.call(token, "create_task", create);
              assert.equal(created.admission, "created");
              assert.equal(created.run, null);
              assert.equal((yield* Ref.get(f.started)).length, 0);
              assert.deepEqual(yield* bridge.call(token, "create_task", create), created);
              const launch = {
                taskId: created.taskId,
                idempotencyKey: "start-1",
                expectedFence: created.fence,
                expectedRevision: 1,
                text: "Fix parser",
                routingMode: "manual",
              };
              const completed = yield* f.orchestrator.streamDomainEvents.pipe(
                Stream.filter(
                  (e) =>
                    e.type === "run.updated" &&
                    e.threadId === created.threadId &&
                    e.payload.status === "completed",
                ),
                Stream.take(1),
                Stream.runDrain,
                Effect.forkScoped,
              );
              const started = yield* bridge.call(token, "start_task", launch);
              assert.equal(started.admission, "admitted");
              assert.equal(started.receipt?.status, "accepted");
              assert.deepEqual(yield* bridge.call(token, "start_task", launch), started);
              yield* Fiber.join(completed);
              yield* f.worker.drain();
              const result = yield* bridge.call(token, "get_result", { taskId: created.taskId });
              assert.equal(result.terminal, true);
              assert.equal(result.result.status, "available");
              // The Tasks page must read the same durable run admitted by the controller.
              const record = yield* Effect.gen(function* () {
                const records = yield* TaskRecords.TaskRecords;
                const page = yield* records.list(0);
                const listed = page.records.find(
                  (entry) => entry.run.threadId === created.threadId,
                );
                assert.isDefined(listed);
                return yield* records.detail(
                  ThreadId.make(created.threadId),
                  RunId.make(listed!.run.id),
                );
              }).pipe(
                Effect.provide(
                  TaskRecords.layer.pipe(Layer.provide(Layer.succeed(SqlClient.SqlClient, f.sql))),
                ),
              );
              assert.equal(record?.record.run.status, "completed");
              assert.equal(record?.record.run.id, result.run?.runId);
              assert.equal(record?.record.governance, "required");
              assert.equal(record?.record.goal, "Fix parser");
              assert.equal(record?.record.run.modelSelection.model, "fake-model");
              assert.isUndefined(record?.record.turns[0]?.turn.modelIdentity?.resolved);
              assert.equal((yield* Ref.get(f.started)).length, 1);
              const receipts = yield* f.sql`SELECT * FROM controller_receipts`;
              assert.equal(receipts.length, 2);
              yield* denied(
                bridge.call(token, "create_task", { ...create, title: "Changed intent" }),
                "conflict",
              );
              const current = yield* bridge.call(token, "get_task", { taskId: created.taskId });
              assert.equal(current.feedback?.status, "available");
              if (current.feedback?.status !== "available" || !current.run)
                throw new Error("Missing feedback facts");
              const decision = {
                taskId: current.taskId,
                idempotencyKey: "feedback-1",
                expectedFence: current.fence,
                expectedRevision: current.contractRevision,
                runId: current.run.runId,
                attemptId: current.run.attemptId,
                fingerprint: current.feedback.fingerprint,
                contextKey: current.feedback.contextKey,
                kind: "helpful",
                confirm: true,
              };
              yield* denied(
                bridge.call(token, "submit_feedback", { ...decision, attemptId: "superseded" }),
                "stale",
              );
              yield* denied(
                bridge.call(token, "submit_feedback", { ...decision, expectedRevision: 2 }),
                "stale",
              );
              yield* denied(
                bridge.call(token, "submit_feedback", {
                  ...decision,
                  idempotencyKey: "stale-result",
                  fingerprint: "superseded-result",
                }),
                "stale",
              );
              const saved = yield* bridge.call(token, "submit_feedback", decision);
              assert.equal(
                saved.feedback?.status === "available" && saved.feedback.feedbackForResult,
                true,
              );
              assert.deepEqual(yield* bridge.call(token, "submit_feedback", decision), saved);
              yield* denied(
                bridge.call(token, "submit_feedback", {
                  ...decision,
                  idempotencyKey: "late-feedback",
                  kind: "not_helpful",
                }),
                "stale",
              );
              yield* denied(
                bridge.call(token, "cancel_task", {
                  taskId: current.taskId,
                  idempotencyKey: "late-cancel",
                  expectedFence: saved.fence,
                  expectedRevision: current.contractRevision,
                  runId: current.run.runId,
                  attemptId: current.run.attemptId,
                }),
                "stale",
              );
              const audits = yield* f.sql<{
                controller_id: string | null;
              }>`SELECT controller_id FROM controller_audit WHERE outcome='stale'`;
              assert.equal(
                audits.every((a) => a.controller_id === "alpha"),
                true,
              );
            }),
          ),
        ),
      { governedWorker: true },
    ),
  30000,
);

it.live(
  "denies unknown/revoked/cross-controller/project/action access and generic commands",
  () =>
    withTaskResultLinkageFixture((f) =>
      withBridge(f, (bridge) =>
        Effect.gen(function* () {
          yield* denied(
            bridge.call("internal-provider-session-token", "create_task", create),
            "unauthorized",
          );
          yield* denied(
            bridge.call(token, "create_task", { ...create, projectId: "project-b" }),
            "denied",
          );
          yield* denied(
            bridge.call(token, "create_task", { ...create, shell: "echo escape" }),
            "invalid_request",
          );
          const task = yield* bridge.call(token, "create_task", create);
          yield* denied(bridge.call(other, "get_task", { taskId: task.taskId }), "denied");
          yield* denied(
            bridge.call(other, "cancel_task", {
              taskId: task.taskId,
              idempotencyKey: "cross-cancel",
              expectedRevision: 1,
              expectedFence: 1,
              runId: "other",
              attemptId: "other",
            }),
            "denied",
          );
          yield* f.sql`UPDATE controller_identities SET actions_json='["get_task"]' WHERE id='beta'`;
          yield* denied(bridge.call(other, "create_task", create), "denied");
          yield* bridge.revoke("alpha").pipe(
            Effect.provideService(PolicyExecutionContext, {
              kind: "session",
              actorId: "owner",
              sessionId: "owner-session",
              scopes: [AuthAccessWriteScope],
            }),
          );
          yield* denied(bridge.call(token, "get_task", { taskId: task.taskId }), "unauthorized");
          const list = yield* bridge.list.pipe(
            Effect.provideService(PolicyExecutionContext, {
              kind: "session",
              actorId: "owner",
              sessionId: "owner-session",
              scopes: [AuthAccessReadScope],
            }),
          );
          assert.equal(list[0]?.revokedAt !== null, true);
          assert.equal((yield* Ref.get(f.started)).length, 0);
        }),
      ),
    ),
  30000,
);

it.live(
  "recovers a lost start receipt after service restart without another run",
  () =>
    withTaskResultLinkageFixture(
      (f) =>
        withBridge(
          f,
          (bridge) =>
            Effect.gen(function* () {
              const task = yield* bridge.call(token, "create_task", create);
              const input = {
                taskId: task.taskId,
                idempotencyKey: "lost-start",
                expectedFence: task.fence,
                expectedRevision: 1,
                text: "Fix parser",
                routingMode: "manual",
              };
              yield* denied(bridge.call(token, "start_task", input), "unavailable");
              const pending = yield* f.sql<{
                pending_key: string;
              }>`SELECT pending_key FROM controller_tasks WHERE task_id=${task.taskId}`;
              assert.equal(pending[0]?.pending_key, "lost-start");
              yield* denied(
                bridge.call(token, "start_task", { ...input, idempotencyKey: "new-start" }),
                "conflict",
              );
              yield* withBridge(f, (restarted) =>
                Effect.gen(function* () {
                  const recovered = yield* restarted.call(token, "start_task", input);
                  assert.equal(recovered.admission, "admitted");
                  const projection = yield* f.orchestrator.getThreadProjection(
                    ThreadId.make(task.threadId),
                  );
                  assert.equal(projection.runs.length, 1);
                  assert.equal(projection.messages.length, 1);
                  assert.equal((yield* Ref.get(f.started)).length, 0);
                }),
              );
            }),
          true,
        ),
      { startWorker: false },
    ),
  30000,
);

it.live(
  "cancels only the current revision/run/attempt and deduplicates interruption",
  () =>
    withTaskResultLinkageFixture(
      (f) =>
        withBridge(f, (bridge) =>
          Effect.scoped(
            Effect.gen(function* () {
              const task = yield* bridge.call(token, "create_task", create);
              const running = yield* f.orchestrator.streamDomainEvents.pipe(
                Stream.filter(
                  (e) =>
                    e.type === "provider-turn.updated" &&
                    e.threadId === task.threadId &&
                    e.payload.status === "running",
                ),
                Stream.take(1),
                Stream.runDrain,
                Effect.forkScoped,
              );
              yield* bridge.call(token, "start_task", {
                taskId: task.taskId,
                idempotencyKey: "start-active",
                expectedFence: task.fence,
                expectedRevision: 1,
                text: "Fix parser",
                routingMode: "manual",
              });
              yield* Fiber.join(running);
              const current = yield* bridge.call(token, "get_task", { taskId: task.taskId });
              if (!current.run) throw new Error("No current run");
              const input = {
                taskId: task.taskId,
                idempotencyKey: "cancel-active",
                expectedFence: current.fence,
                expectedRevision: 1,
                runId: current.run.runId,
                attemptId: current.run.attemptId,
              };
              yield* denied(
                bridge.call(token, "cancel_task", { ...input, expectedRevision: 2 }),
                "stale",
              );
              yield* denied(
                bridge.call(token, "cancel_task", { ...input, attemptId: "old-attempt" }),
                "stale",
              );
              const stopped = yield* f.orchestrator.streamDomainEvents.pipe(
                Stream.filter(
                  (e) =>
                    e.type === "run.updated" &&
                    e.threadId === task.threadId &&
                    e.payload.status === "interrupted",
                ),
                Stream.take(1),
                Stream.runDrain,
                Effect.forkScoped,
              );
              const receipt = yield* bridge.call(token, "cancel_task", input);
              assert.equal(receipt.receipt?.status, "accepted");
              assert.deepEqual(yield* bridge.call(token, "cancel_task", input), receipt);
              yield* Fiber.join(stopped);
              const latest = yield* bridge.call(token, "get_task", { taskId: task.taskId });
              assert.equal(latest.terminal, true);
              assert.equal(latest.run?.status, "interrupted");
            }),
          ),
        ),
      {
        governedWorker: true,
        onStart: (_input, events, emit) => {
          const root = events[0]!;
          if (root.type !== "provider_turn.updated") throw new Error("Missing fixture root");
          return emit({
            ...root,
            providerTurn: { ...root.providerTurn, status: "running", completedAt: null },
          });
        },
        onInterrupt: (_input, events, emit) =>
          Effect.gen(function* () {
            const root = events[0]!,
              terminal = events.at(-1)!;
            if (root.type !== "provider_turn.updated" || terminal.type !== "turn.terminal")
              throw new Error("Invalid fixture script");
            yield* emit({
              ...root,
              providerTurn: {
                ...root.providerTurn,
                status: "interrupted",
                completedAt: yield* DateTime.now,
              },
            });
            yield* emit({ ...terminal, status: "interrupted", failure: null });
          }),
      },
    ),
  30000,
);

const decodeHttpView = Schema.decodeUnknownEffect(Schema.fromJsonString(ControllerTaskView));
const decodeHttpStatus = Schema.decodeUnknownEffect(Schema.fromJsonString(ControllerStatus));
const decodeMcpTools = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      result: Schema.Struct({ tools: Schema.Array(Schema.Struct({ name: Schema.String })) }),
    }),
  ),
);
it.live(
  "HTTP/MCP isolate controller auth and owner-session status/revocation",
  () =>
    withTaskResultLinkageFixture((f) =>
      withBridge(f, (bridge) =>
        Effect.acquireUseRelease(
          Effect.sync(() =>
            HttpRouter.toWebHandler(
              ControllerHttp.routes.pipe(
                HttpRouter.provideRequest(Layer.succeed(Bridge.ControllerBridge, bridge)),
                HttpRouter.provideRequest(
                  Layer.mock(EnvironmentAuth.EnvironmentAuth)({
                    authenticateHttpRequest: (request) =>
                      request.headers.authorization === "Bearer fixture-owner-session"
                        ? Effect.succeed({
                            sessionId: AuthSessionId.make("owner-session"),
                            subject: "owner",
                            method: "bearer-access-token",
                            scopes: [AuthAccessReadScope, AuthAccessWriteScope],
                          })
                        : Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError({})),
                  }),
                ),
              ),
              { disableLogger: true },
            ),
          ),
          (web) =>
            Effect.gen(function* () {
              const post = (path: string, body: unknown, credential = token) =>
                Effect.promise(() =>
                  web.handler(
                    new Request(`http://fixture${path}`, {
                      method: "POST",
                      headers: {
                        "content-type": "application/json",
                        authorization: `Bearer ${credential}`,
                      },
                      body: encodeJson(body),
                    }),
                  ),
                );
              const path = "/api/controller/v1/tools/create_task";
              assert.equal((yield* post(path, create, "fixture-owner-session")).status, 401);
              assert.equal((yield* post(path, create, "provider-session-token")).status, 401);
              const response = yield* post(path, create);
              assert.equal(response.status, 200);
              const created = yield* decodeHttpView(yield* Effect.promise(() => response.text()));
              const mcp = yield* post("/api/controller/v1/mcp", {
                jsonrpc: "2.0",
                id: 1,
                method: "tools/list",
              });
              const tools = yield* decodeMcpTools(yield* Effect.promise(() => mcp.text()));
              assert.deepEqual(
                tools.result.tools.map((t) => t.name).sort(),
                Object.keys(ControllerToolInputs).sort(),
              );
              assert.equal(
                (yield* post("/api/controller/v1/status", { controllerId: "alpha" })).status,
                401,
              );
              const statusResponse = yield* post(
                "/api/controller/v1/status",
                { controllerId: "alpha" },
                "fixture-owner-session",
              );
              const status = yield* decodeHttpStatus(
                yield* Effect.promise(() => statusResponse.text()),
              );
              assert.equal(status.configuration, "configured");
              assert.equal(status.tasks[0]?.taskId, created.taskId);
              assert.equal(status.tasks[0]?.feedback, null);
              assert.equal(status.lastAuthenticatedAt !== null, true);
              assert.equal(
                (yield* post(
                  "/api/controller/v1/revoke",
                  { controllerId: "alpha" },
                  "fixture-owner-session",
                )).status,
                200,
              );
              assert.equal(
                (yield* post("/api/controller/v1/tools/get_task", { taskId: created.taskId }))
                  .status,
                401,
              );
            }),
          (web) => Effect.promise(() => web.dispose()),
        ),
      ),
    ),
  30000,
);
