import { RpcGroup } from "effect/unstable/rpc";
import {
  ORCHESTRATION_V2_WS_METHODS,
  WsRpcGroup,
  ThreadId,
  EnvironmentAuthorizationError,
  OrchestrationV2DispatchCommandError,
  OrchestrationV2GetThreadProjectionError,
  type OrchestrationV2Command,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { AuthSessionRepository } from "./persistence/AuthSessions.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { AuthenticatedSession } from "./auth/EnvironmentAuth.ts";
import { requiredScopeForRpcMethod } from "./auth/RpcAuthorization.ts";
import { observeRpcEffect as instrumentRpcEffect } from "./observability/RpcInstrumentation.ts";
import * as ThreadManagementService from "./orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunchService from "./orchestration-v2/ThreadLaunchService.ts";
import * as ThreadMessageIntake from "./orchestration-v2/ThreadMessageIntake.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as ServerConfig from "./config.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import {
  buildBoundedThreadProjection,
  THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
} from "./orchestration-v2/threadHistoryPaging.ts";
import { projectThreadProjectionForWire } from "./orchestration-v2/WireProjection.ts";
import { userFacingDispatchErrorMessage } from "./orchestration-v2/UserFacingErrors.ts";

/** Shared production handlers; the transport and test route use the same intake and authorization. */
export const TaskRpcGroup = RpcGroup.make(
  ...Array.from(WsRpcGroup.requests.values()).filter(
    (rpc) =>
      rpc._tag === ORCHESTRATION_V2_WS_METHODS.dispatchCommand ||
      rpc._tag === ORCHESTRATION_V2_WS_METHODS.getThreadProjection ||
      rpc._tag === ORCHESTRATION_V2_WS_METHODS.getAgentsCreationStatus ||
      rpc._tag === ORCHESTRATION_V2_WS_METHODS.getTaskFirstLaunchStatus ||
      rpc._tag === ORCHESTRATION_V2_WS_METHODS.getTaskAutoPreview ||
      rpc._tag === ORCHESTRATION_V2_WS_METHODS.getTaskReview,
  ),
);

export const makeTaskRpcHandlers = Effect.fn("ws.makeTaskRpcHandlers")(function* (
  currentSession: AuthenticatedSession,
  recordClientCommandAnalytics: (command: OrchestrationV2Command) => Effect.Effect<void>,
) {
  const sql = yield* SqlClient.SqlClient;
  const sessions = yield* AuthSessionRepository;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const orchestrationEngine = yield* Orchestrator.OrchestratorV2;
  const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const intakeContext = yield* Effect.context<
    | ThreadManagementService.ThreadManagementService
    | ThreadLaunchService.ThreadLaunchService
    | FileSystem.FileSystem
    | ServerConfig.ServerConfig
  >();
  const observeRpcEffect = <A, E, R>(
    method: string,
    effect: Effect.Effect<A, E, R>,
    attributes?: Readonly<Record<string, unknown>>,
  ) => {
    const requiredScope = requiredScopeForRpcMethod(method);
    const denied = () =>
      new EnvironmentAuthorizationError({
        message: "The authenticated session is no longer active or lacks the required scope.",
        requiredScope,
      });
    const authorized: Effect.Effect<A, E | EnvironmentAuthorizationError, R> = Effect.gen(
      function* () {
        if (!currentSession.scopes.includes(requiredScope)) return yield* denied();
        const row = yield* sessions
          .getById({ sessionId: currentSession.sessionId })
          .pipe(Effect.mapError(denied));
        if (
          Option.isNone(row) ||
          row.value.subject !== currentSession.subject ||
          row.value.revokedAt !== null ||
          !row.value.scopes.includes(requiredScope) ||
          DateTime.toEpochMillis(row.value.expiresAt) <= DateTime.toEpochMillis(yield* DateTime.now)
        )
          return yield* denied();
        return yield* effect;
      },
    );
    return instrumentRpcEffect(method, authorized, attributes);
  };
  return TaskRpcGroup.of({
    [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command) =>
      observeRpcEffect(
        ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
        startup
          .enqueueCommand(
            ThreadMessageIntake.dispatchCommand(
              ThreadManagementService.withCreationProvenance(command, {
                createdBy: "user",
                creationSource: "creationSource" in command ? command.creationSource : "web",
              }),
            ).pipe(
              Effect.provideService(ServerEnvironment.ServerEnvironment, serverEnvironment),
              Effect.provideService(SqlClient.SqlClient, sql),
              Effect.provide(intakeContext),
            ),
          )
          .pipe(
            Effect.tap(() => recordClientCommandAnalytics(command)),
            Effect.provideService(ServerEnvironment.ServerEnvironment, serverEnvironment),
            Effect.map((result) => ({
              sequence: result.sequence,
              ...(result.taskEnrollment === undefined
                ? {}
                : { taskEnrollment: result.taskEnrollment }),
            })),
            Effect.mapError((cause) => {
              const detail = userFacingDispatchErrorMessage(cause);
              return new OrchestrationV2DispatchCommandError({
                commandId: command.commandId,
                commandType: command.type,
                message: detail ?? "Failed to dispatch orchestration V2 command",
                ...(detail === undefined ? {} : { detail }),
                cause,
              });
            }),
          ),
        {
          "rpc.aggregate": "orchestrationV2",
          "orchestration_v2.command_id": command.commandId,
          "orchestration_v2.command_type": command.type,
          "orchestration_v2.thread_id":
            command.type === "thread.fork" || command.type === "thread.merge_back"
              ? command.targetThreadId
              : command.type === "delegated_task.request" ||
                  command.type === "delegated_task.wake-policy" ||
                  command.type === "delegated_task.completion-delivery.acknowledge" ||
                  command.type === "delegated_task.completion-delivery.dispose" ||
                  command.type === "thread.created.record"
                ? command.parentThreadId
                : command.threadId,
          ...(command.type === "thread.fork" || command.type === "thread.merge_back"
            ? { "orchestration_v2.source_thread_id": command.sourceThreadId }
            : {}),
        },
      ),
    [ORCHESTRATION_V2_WS_METHODS.getThreadProjection]: (input) =>
      observeRpcEffect(
        ORCHESTRATION_V2_WS_METHODS.getThreadProjection,
        // Pre-pagination clients still call this compatibility endpoint.
        // Keep stale clients from materializing an unbounded transcript.
        threadManagement
          .getThreadSnapshotWindow(input.threadId, {
            rowLimit: THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
          })
          .pipe(
            Effect.map((snapshot) =>
              projectThreadProjectionForWire(
                buildBoundedThreadProjection({
                  projection: snapshot.projection,
                  snapshotSequence: snapshot.snapshotSequence,
                }).projection,
              ),
            ),
            Effect.mapError(
              (cause) =>
                new OrchestrationV2GetThreadProjectionError({
                  threadId: input.threadId,
                  message: `Failed to load orchestration V2 thread ${input.threadId}`,
                  cause,
                }),
            ),
          ),
        {
          "rpc.aggregate": "orchestrationV2",
          "orchestration_v2.thread_id": input.threadId,
        },
      ),
    [ORCHESTRATION_V2_WS_METHODS.getAgentsCreationStatus]: (input) =>
      observeRpcEffect(
        ORCHESTRATION_V2_WS_METHODS.getAgentsCreationStatus,
        orchestrationEngine
          .getAgentsCreationStatus(input)
          .pipe(
            Effect.provideService(ServerEnvironment.ServerEnvironment, serverEnvironment),
            Effect.provideService(SqlClient.SqlClient, sql),
          ),
        { "rpc.aggregate": "orchestrationV2" },
      ),
    [ORCHESTRATION_V2_WS_METHODS.getTaskFirstLaunchStatus]: (input) =>
      observeRpcEffect(
        ORCHESTRATION_V2_WS_METHODS.getTaskFirstLaunchStatus,
        orchestrationEngine
          .getTaskFirstLaunchStatus(input)
          .pipe(
            Effect.provideService(ServerEnvironment.ServerEnvironment, serverEnvironment),
            Effect.provideService(SqlClient.SqlClient, sql),
          ),
        { "rpc.aggregate": "orchestrationV2" },
      ),
    [ORCHESTRATION_V2_WS_METHODS.getTaskAutoPreview]: (input) =>
      observeRpcEffect(
        ORCHESTRATION_V2_WS_METHODS.getTaskAutoPreview,
        orchestrationEngine
          .getTaskAutoPreview(input)
          .pipe(
            Effect.provideService(ServerEnvironment.ServerEnvironment, serverEnvironment),
            Effect.provideService(SqlClient.SqlClient, sql),
          ),
        { "rpc.aggregate": "orchestrationV2" },
      ),
    [ORCHESTRATION_V2_WS_METHODS.getTaskReview]: (input) =>
      observeRpcEffect(
        ORCHESTRATION_V2_WS_METHODS.getTaskReview,
        orchestrationEngine.getTaskReview(input).pipe(
          Effect.provideService(ServerEnvironment.ServerEnvironment, serverEnvironment),
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.mapError(
            (cause) =>
              new OrchestrationV2GetThreadProjectionError({
                threadId: ThreadId.make(input.threadId),
                message: "Failed to read task review",
                cause,
              }),
          ),
        ),
        { "rpc.aggregate": "orchestrationV2", "orchestration_v2.thread_id": input.threadId },
      ),
  });
});
