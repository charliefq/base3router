import type { SqlError } from "effect/unstable/sql/SqlError";
import * as ObservationRepository from "../../routerEvaluation/ObservationRepository.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as Etag from "effect/unstable/http/Etag";
import {
  AuthSessionId,
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  EnvironmentHttpApi,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentAuthInvalidError,
  TaskResultFeedbackState,
} from "@t3tools/contracts";
import { taskResultFeedbackHttpApiLayer } from "../http.ts";
import * as EventStore from "../../orchestration-v2/EventStore.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as IdAllocator from "../../orchestration-v2/IdAllocator.ts";
import * as ProviderEventIngestor from "../../orchestration-v2/ProviderEventIngestor.ts";
import { ProviderSessionId } from "@t3tools/contracts";
import {
  CommandId,
  MessageId,
  OrchestrationV2Run,
  OrchestrationV2RunAttempt,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  OrchestrationV2ExecutionNode,
  OrchestrationV2TurnItem,
  type CollaborationSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const decodeFixtureBinding = Schema.decodeUnknownEffect(
  Schema.fromJsonString(DispatcherTaskRouteBinding),
);
const decodeRun = Schema.decodeUnknownEffect(Schema.toCodecJson(OrchestrationV2Run));
const encodeRun = Schema.encodeEffect(
  Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2Run)),
);
const decodeAttempt = Schema.decodeUnknownEffect(Schema.toCodecJson(OrchestrationV2RunAttempt));
const encodeAttempt = Schema.encodeEffect(
  Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2RunAttempt)),
);
const decodeThread = Schema.decodeUnknownEffect(Schema.toCodecJson(OrchestrationV2ProviderThread));
const encodeThread = Schema.encodeEffect(
  Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2ProviderThread)),
);
const decodeTurn = Schema.decodeUnknownEffect(Schema.toCodecJson(OrchestrationV2ProviderTurn));
const encodeTurn = Schema.encodeEffect(
  Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2ProviderTurn)),
);
const decodeNode = Schema.decodeUnknownEffect(Schema.toCodecJson(OrchestrationV2ExecutionNode));
const encodeNode = Schema.encodeEffect(
  Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2ExecutionNode)),
);
const decodeItem = Schema.decodeUnknownEffect(Schema.toCodecJson(OrchestrationV2TurnItem));
const encodeItem = Schema.encodeEffect(
  Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2TurnItem)),
);

import * as Layer from "effect/Layer";
import * as DateTime from "effect/DateTime";
import {
  EnvironmentId,
  ThreadId,
  ProviderDriverKind,
  DispatcherTaskRouteBinding,
  type TaskResultFeedbackInput,
  type TaskResultFeedbackSubmit,
} from "@t3tools/contracts";
import { PolicyExecutionContext } from "../../policy/executionContext.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as RouterEvaluation from "../../routerEvaluation/RouterEvaluationService.ts";
import {
  buildTurnOutcomeObservation,
  runtimeEventFromV2ProviderTurn,
} from "../../routerEvaluation/persistTurnOutcome.ts";
import { TaskResultFeedbackService, taskResultFeedbackLayer } from "../store.ts";
import {
  agentsCreationCommand,
  agentsCreationActor,
  withAgentsTaskCreationFixture,
} from "./agentsTaskCreationFixture.ts";

class FeedbackFixtureApi extends HttpApi.make("environment").add(
  EnvironmentHttpApi.groups.taskResultFeedback,
) {}
const feedbackFixtureAuth = Layer.succeed(EnvironmentAuthenticatedAuth, (httpEffect) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const scope = request.headers["x-fixture-scope"];
    if (!scope)
      return yield* new EnvironmentAuthInvalidError({
        code: "auth_invalid",
        reason: "invalid_credential",
        traceId: "fixture",
      });
    return yield* httpEffect.pipe(
      Effect.provideService(EnvironmentAuthenticatedPrincipal, {
        sessionId: AuthSessionId.make(agentsCreationActor.sessionId),
        subject:
          request.headers["x-fixture-actor"] === "foreign"
            ? "foreign-owner"
            : agentsCreationActor.actorId,
        method: "browser-session-cookie",
        scopes: new Set(
          scope === "read"
            ? [AuthOrchestrationReadScope]
            : [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
        ),
        ...(scope === "expired" ? { expiresAt: DateTime.makeUnsafe("2020-01-01T00:00:00Z") } : {}),
      }),
    );
  }),
);
const encodeFeedbackRequest = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeFeedbackResponse = Schema.decodeUnknownEffect(TaskResultFeedbackState);

export async function withTaskResultFeedbackFixture(
  check: (f: {
    sql: SqlClient.SqlClient;
    input: TaskResultFeedbackInput;
    read: (
      input?: TaskResultFeedbackInput,
      actor?: typeof agentsCreationActor,
    ) => Promise<import("@t3tools/contracts").TaskResultFeedbackState>;
    submit: (
      input: TaskResultFeedbackSubmit,
      actor?: typeof agentsCreationActor,
    ) => Promise<import("@t3tools/contracts").TaskResultFeedbackState>;
    snapshot: () => Promise<CollaborationSnapshot>;
    http: (
      method: "read" | "submit",
      request: TaskResultFeedbackInput | TaskResultFeedbackSubmit,
      scope?: "owner" | "read" | "expired",
      actor?: "foreign",
    ) => Promise<Response>;
    readHttp: (input?: TaskResultFeedbackInput) => Promise<TaskResultFeedbackState>;
    submitHttp: (input: TaskResultFeedbackSubmit) => Promise<TaskResultFeedbackState>;
    evaluation: RouterEvaluation.RouterEvaluationService["Service"];
    repository: ObservationRepository.ObservationRepository["Service"];
    observation: import("@t3tools/contracts").TurnOutcomeObservationV0;
    capturePhase: { run: string; attempt: string; attemptTurn: string | null };
    bindingBefore: string;
    replay: () => Promise<void>;
    baseline: () => Promise<unknown>;
  }) => Promise<void>,
  options: {
    legacyZero?: boolean;
    afterProjection?: (
      sql: SqlClient.SqlClient,
      ids: { run: string; attempt: string; turn: string; thread: string; message: string },
    ) => Effect.Effect<void, SqlError>;
    beforeCapture?: (
      sql: SqlClient.SqlClient,
      ids: { run: string; attempt: string; turn: string; thread: string; message: string },
    ) => Effect.Effect<void, SqlError>;
  } = {},
) {
  await Effect.runPromise(
    withAgentsTaskCreationFixture((f) =>
      Effect.promise(async () => {
        const base = agentsCreationCommand("revision-request-root");
        const command = {
          ...base,
          taskContract: {
            ...base.taskContract!,
            brake: { maxProviderStarts: 2, stopConditions: "Scope changed" },
          },
        };
        await Effect.runPromise(f.dispatch(command));
        await Effect.runPromise(
          f.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("revision-fixture-dispatch"),
            threadId: command.threadId,
            messageId: MessageId.make("revision-input"),
            text: "Implement parser",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
            routingMode: "manual",
            dispatchMode: { type: "start_immediately" },
          }),
        );
        const p = await Effect.runPromise(f.orchestrator.getThreadProjection(command.threadId));
        const current = p.runs[0]!;
        const start = "2026-10-14T00:00:00.000Z",
          end = "2026-10-14T00:00:01.000Z";
        const wire = {
          id: current.id,
          threadId: command.threadId,
          ordinal: 1,
          providerInstanceId: "codex",
          modelSelection: current.modelSelection,
          userMessageId: current.userMessageId,
          rootNodeId: current.rootNodeId ?? "revision-root-node",
          activeAttemptId: current.activeAttemptId ?? "revision-attempt",
          providerThreadId: current.providerThreadId ?? "revision-provider-thread",
          status: "completed",
          requestedAt: start,
          startedAt: start,
          completedAt: end,
          checkpointId: null,
          contextHandoffId: null,
        };
        const run = await Effect.runPromise(decodeRun(wire));
        const attempt = await Effect.runPromise(
          decodeAttempt({
            id: wire.activeAttemptId,
            runId: run.id,
            attemptOrdinal: 1,
            rootNodeId: wire.rootNodeId,
            providerInstanceId: "codex",
            providerThreadId: wire.providerThreadId,
            providerTurnId: "revision-turn",
            reason: "initial",
            status: "completed",
            startedAt: start,
            completedAt: end,
          }),
        );
        const thread = await Effect.runPromise(
          decodeThread({
            id: wire.providerThreadId,
            driver: "codex",
            providerInstanceId: "codex",
            providerSessionId: null,
            appThreadId: command.threadId,
            ownerNodeId: null,
            nativeThreadRef: null,
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: 1,
            lastRunOrdinal: 1,
            handoffIds: [],
            forkedFrom: null,
            createdAt: start,
            updatedAt: end,
          }),
        );
        const turn = await Effect.runPromise(
          decodeTurn({
            id: "revision-turn",
            providerThreadId: thread.id,
            nodeId: wire.rootNodeId,
            runAttemptId: attempt.id,
            nativeTurnRef: null,
            ordinal: 1,
            status: "completed",
            startedAt: start,
            completedAt: end,
          }),
        );
        const rootWire = {
          id: wire.rootNodeId,
          threadId: command.threadId,
          runId: run.id,
          parentNodeId: null,
          rootNodeId: wire.rootNodeId,
          kind: "root_turn",
          status: "completed",
          countsForRun: true,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: start,
          completedAt: end,
        };
        const root = await Effect.runPromise(decodeNode(rootWire));
        const nativeItemRef = {
          driver: "codex",
          nativeId: "revision-assistant",
          strength: "strong",
        };
        const child = await Effect.runPromise(
          decodeNode({
            ...rootWire,
            id: "revision-assistant-node",
            parentNodeId: root.id,
            kind: "assistant_message",
            countsForRun: false,
            providerThreadId: thread.id,
            providerTurnId: turn.id,
            nativeItemRef,
          }),
        );
        const item = await Effect.runPromise(
          decodeItem({
            id: "revision-output",
            messageId: "revision-assistant-message",
            threadId: command.threadId,
            runId: run.id,
            nodeId: child.id,
            providerThreadId: thread.id,
            providerTurnId: turn.id,
            nativeItemRef,
            parentItemId: null,
            ordinal: 1,
            type: "assistant_message",
            status: "completed",
            title: null,
            startedAt: start,
            completedAt: end,
            updatedAt: end,
            text: "Attributed parser output. " + "x".repeat(2200),
            streaming: false,
          }),
        );
        const sql = f.sql;
        await Effect.runPromise(
          sql`UPDATE orchestration_v2_projection_runs SET requested_at=${start},provider_thread_id=${thread.id},status='completed',completed_at=${end},payload_json=${await Effect.runPromise(encodeRun(run))} WHERE run_id=${run.id}`,
        );
        await Effect.runPromise(
          sql`INSERT OR REPLACE INTO orchestration_v2_projection_run_attempts (attempt_id,thread_id,run_id,attempt_ordinal,root_node_id,provider,provider_instance_id,provider_thread_id,provider_turn_id,status,payload_json) VALUES (${attempt.id},${command.threadId},${run.id},1,${root.id},'codex','codex',${thread.id},${turn.id},'completed',${await Effect.runPromise(encodeAttempt(attempt))})`,
        );
        await Effect.runPromise(
          sql`INSERT OR REPLACE INTO orchestration_v2_projection_provider_threads (provider_thread_id,thread_id,owner_node_id,provider,driver,provider_instance_id,provider_session_id,status,first_run_ordinal,last_run_ordinal,updated_at,payload_json) VALUES (${thread.id},${command.threadId},NULL,'codex','codex','codex',NULL,'idle',1,1,${end},${await Effect.runPromise(encodeThread(thread))})`,
        );
        await Effect.runPromise(
          sql`INSERT OR REPLACE INTO orchestration_v2_projection_provider_turns (provider_turn_id,thread_id,provider_thread_id,node_id,run_attempt_id,ordinal,status,started_at,completed_at,payload_json) VALUES (${turn.id},${command.threadId},${thread.id},${root.id},${attempt.id},1,'completed',${start},${end},${await Effect.runPromise(encodeTurn(turn))})`,
        );
        for (const node of [root, child])
          await Effect.runPromise(
            sql`INSERT OR REPLACE INTO orchestration_v2_projection_nodes (node_id,thread_id,run_id,parent_node_id,root_node_id,kind,status,provider_thread_id,provider_turn_id,runtime_request_id,checkpoint_scope_id,started_at,completed_at,payload_json) VALUES (${node.id},${command.threadId},${run.id},${node.parentNodeId},${root.id},${node.kind},'completed',${node.providerThreadId},${node.providerTurnId},NULL,NULL,${start},${end},${await Effect.runPromise(encodeNode(node))})`,
          );
        await Effect.runPromise(
          sql`INSERT OR REPLACE INTO orchestration_v2_projection_turn_items (turn_item_id,thread_id,run_id,node_id,provider_thread_id,provider_turn_id,parent_item_id,ordinal,type,status,updated_at,payload_json) VALUES (${item.id},${command.threadId},${run.id},${child.id},${thread.id},${turn.id},NULL,1,'assistant_message','completed',${end},${await Effect.runPromise(encodeItem(item))})`,
        );

        const environmentId = EnvironmentId.make("environment-a");
        const database = Layer.succeed(SqlClient.SqlClient, sql);
        const evaluation = await Effect.runPromise(
          RouterEvaluation.RouterEvaluationService.pipe(
            Effect.provide(RouterEvaluation.layer.pipe(Layer.provide(database))),
          ),
        );
        const repository = await Effect.runPromise(
          ObservationRepository.ObservationRepository.pipe(
            Effect.provide(ObservationRepository.layer.pipe(Layer.provide(database))),
          ),
        );
        const service = await Effect.runPromise(
          TaskResultFeedbackService.pipe(
            Effect.provide(
              taskResultFeedbackLayer.pipe(
                Layer.provide(database),
                Layer.provide(Layer.succeed(RouterEvaluation.RouterEvaluationService, evaluation)),
              ),
            ),
          ),
        );
        const environment = ServerEnvironment.ServerEnvironment.of({
          getEnvironmentId: Effect.succeed(environmentId),
          getDescriptor: Effect.die("unused"),
        });
        const authenticated = <A, E>(effect: Effect.Effect<A, E>, actor = agentsCreationActor) =>
          effect.pipe(
            Effect.provideService(PolicyExecutionContext, actor),
            Effect.provideService(ServerEnvironment.ServerEnvironment, environment),
          );
        const input: TaskResultFeedbackInput = {
          environmentId,
          taskId: `task:governed:thread:${command.threadId}`,
          projectId: command.projectId,
          threadId: command.threadId,
          revision: 1,
        };
        const route = await Effect.runPromise(
          sql<{
            binding_json: string;
          }>`SELECT binding_json FROM projection_dispatcher_task_routes WHERE thread_id=${command.threadId} AND message_id=${run.userMessageId}`,
        );
        const binding = await Effect.runPromise(decodeFixtureBinding(route[0]!.binding_json));
        if (options.legacyZero) {
          const event = runtimeEventFromV2ProviderTurn({
            threadId: ThreadId.make(command.threadId),
            providerInstanceId: binding.target.instanceId,
            driver: ProviderDriverKind.make(binding.driver),
            providerTurn: turn,
          })!;
          const legacy = buildTurnOutcomeObservation({
            environmentId,
            threadId: ThreadId.make(command.threadId),
            messageId: run.userMessageId,
            event,
            binding,
            nowMs: Date.parse(end),
            nowIso: end,
          });
          await Effect.runPromise(
            evaluation.recordObservation(legacy, {
              threadId: ThreadId.make(command.threadId),
              messageId: run.userMessageId,
            }),
          );
        }
        // Capture through the real ingestion boundary before run/attempt finalization.
        const runningRun = { ...run, status: "running" as const, completedAt: null };
        const runningAttempt = {
          ...attempt,
          status: "running" as const,
          providerTurnId: null,
          completedAt: null,
        };
        await Effect.runPromise(
          sql`UPDATE orchestration_v2_projection_runs SET status='running',completed_at=NULL,payload_json=${await Effect.runPromise(encodeRun(runningRun))} WHERE run_id=${run.id}`,
        );
        await Effect.runPromise(
          sql`UPDATE orchestration_v2_projection_run_attempts SET status='running',provider_turn_id=NULL,payload_json=${await Effect.runPromise(encodeAttempt(runningAttempt))} WHERE attempt_id=${attempt.id}`,
        );
        await Effect.runPromise(
          sql`DELETE FROM orchestration_v2_projection_provider_turns WHERE provider_turn_id=${turn.id}`,
        );
        if (options.beforeCapture)
          await Effect.runPromise(
            options.beforeCapture(sql, {
              run: run.id,
              attempt: attempt.id,
              turn: turn.id,
              thread: command.threadId,
              message: run.userMessageId,
            }),
          );
        const stores = Layer.merge(EventStore.layer, ProjectionStore.layer).pipe(
          Layer.provideMerge(database),
        );
        const sinkLayer = EventSink.layer.pipe(Layer.provide(stores));
        const capturePhase: { run: string; attempt: string; attemptTurn: string | null } = {
          run: "unobserved",
          attempt: "unobserved",
          attemptTurn: null,
        };
        const checkedSink = Layer.effect(
          EventSink.EventSinkV2,
          Effect.gen(function* () {
            const base = yield* EventSink.EventSinkV2;
            return EventSink.EventSinkV2.of({
              ...base,
              write: (request) =>
                base.write(request).pipe(
                  Effect.tap(() =>
                    Effect.gen(function* () {
                      const currentRuns = yield* sql<{
                        status: string;
                      }>`SELECT status FROM orchestration_v2_projection_runs WHERE run_id=${run.id}`;
                      const currentAttempts = yield* sql<{
                        status: string;
                        provider_turn_id: string | null;
                      }>`SELECT status,provider_turn_id FROM orchestration_v2_projection_run_attempts WHERE attempt_id=${attempt.id}`;
                      capturePhase.run = currentRuns[0]?.status ?? "missing";
                      capturePhase.attempt = currentAttempts[0]?.status ?? "missing";
                      capturePhase.attemptTurn = currentAttempts[0]?.provider_turn_id ?? null;
                      if (options.afterProjection)
                        yield* options.afterProjection(sql, {
                          run: run.id,
                          attempt: attempt.id,
                          turn: turn.id,
                          thread: command.threadId,
                          message: run.userMessageId,
                        });
                    }).pipe(Effect.orDie),
                  ),
                ),
            });
          }),
        ).pipe(Layer.provide(sinkLayer));
        const ingestion = ProviderEventIngestor.layer.pipe(
          Layer.provide(Layer.mergeAll(stores, IdAllocator.layer, checkedSink)),
        );
        const ingestor = await Effect.runPromise(
          ProviderEventIngestor.ProviderEventIngestorV2.pipe(Effect.provide(ingestion)),
        );
        const ingest = (targetIngestor = ingestor) =>
          Effect.runPromise(
            targetIngestor
              .ingestNormalized({
                providerSessionId: ProviderSessionId.make("feedback-fixture-session"),
                providerInstanceId: binding.target.instanceId,
                threadId: ThreadId.make(command.threadId),
                runId: run.id,
                event: {
                  type: "provider_turn.updated",
                  driver: ProviderDriverKind.make(binding.driver),
                  providerTurn: turn,
                },
              })
              .pipe(
                Effect.provideService(SqlClient.SqlClient, sql),
                Effect.provideService(RouterEvaluation.RouterEvaluationService, evaluation),
                Effect.provideService(ServerEnvironment.ServerEnvironment, environment),
              ),
          );
        await ingest();
        await Effect.runPromise(
          sql`UPDATE orchestration_v2_projection_runs SET status='completed',completed_at=${end},payload_json=${await Effect.runPromise(encodeRun(run))} WHERE run_id=${run.id}`,
        );
        await Effect.runPromise(
          sql`UPDATE orchestration_v2_projection_run_attempts SET status='completed',provider_turn_id=${turn.id},payload_json=${await Effect.runPromise(encodeAttempt(attempt))} WHERE attempt_id=${attempt.id}`,
        );
        const observation = (await Effect.runPromise(evaluation.exportObservations(environmentId)))
          .records[0]!;
        const httpLayer = HttpApiBuilder.layer(FeedbackFixtureApi).pipe(
          Layer.provide(taskResultFeedbackHttpApiLayer),
          Layer.provide(feedbackFixtureAuth),
          Layer.provide(database),
          Layer.provide(Layer.succeed(RouterEvaluation.RouterEvaluationService, evaluation)),
          Layer.provide(Layer.succeed(ServerEnvironment.ServerEnvironment, environment)),
          Layer.provideMerge(
            HttpPlatform.layer.pipe(
              Layer.provideMerge(NodeServices.layer),
              Layer.provideMerge(Etag.layerWeak),
            ),
          ),
          Layer.provide(NodeServices.layer),
        );
        const web = HttpRouter.toWebHandler(httpLayer, { disableLogger: true });
        const http = async (
          method: "read" | "submit",
          request: TaskResultFeedbackInput | TaskResultFeedbackSubmit,
          scope?: "owner" | "read" | "expired",
          actor?: "foreign",
        ) =>
          web.handler(
            new Request(
              `http://fixture/api/collaboration/task/result-feedback${method === "read" ? "/read" : ""}`,
              {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  ...(scope ? { "x-fixture-scope": scope } : {}),
                  ...(actor ? { "x-fixture-actor": actor } : {}),
                },
                body: await Effect.runPromise(encodeFeedbackRequest(request)),
              },
            ),
          );
        const readHttp = async (request = input) =>
          Effect.runPromise(
            decodeFeedbackResponse(await (await http("read", request, "owner")).json()),
          );
        const submitHttp = async (request: TaskResultFeedbackSubmit) =>
          Effect.runPromise(
            decodeFeedbackResponse(await (await http("submit", request, "owner")).json()),
          );
        try {
          await check({
            http,
            readHttp,
            submitHttp,

            sql,
            input,
            evaluation,
            repository,
            observation,
            capturePhase,
            bindingBefore: route[0]!.binding_json,
            replay: async () => {
              const fresh = await Effect.runPromise(
                ProviderEventIngestor.ProviderEventIngestorV2.pipe(Effect.provide(ingestion)),
              );
              await ingest(fresh);
            },
            read: (request = input, actor = agentsCreationActor) =>
              Effect.runPromise(authenticated(service.read(request), actor)),
            submit: (request, actor = agentsCreationActor) =>
              Effect.runPromise(authenticated(service.submit(request), actor)),
            snapshot: () => Effect.runPromise(f.readSnapshot()),
            baseline: () =>
              Effect.runPromise(
                Effect.all([
                  sql`SELECT * FROM collaboration_commands`,
                  sql`SELECT * FROM orchestration_events`,
                  sql`SELECT * FROM base3_execution_grants`,
                  sql`SELECT * FROM orchestration_v2_effect_outbox`,
                ]),
              ),
          });
        } finally {
          await web.dispose();
        }
      }),
    ),
  );
}

/** The renderer uses the Promise facade; Effect tests run their assertions inside this fixture boundary. */
export const withTaskResultFeedbackEffects = <E>(
  check: (
    fixture: Parameters<Parameters<typeof withTaskResultFeedbackFixture>[0]>[0],
  ) => Effect.Effect<void, E>,
  options?: Parameters<typeof withTaskResultFeedbackFixture>[1],
) =>
  Effect.promise(() => withTaskResultFeedbackFixture((f) => Effect.runPromise(check(f)), options));
