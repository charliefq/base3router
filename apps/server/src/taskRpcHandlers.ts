import { RpcGroup } from "effect/unstable/rpc";
import {
  ORCHESTRATION_V2_WS_METHODS,
  WsRpcGroup,
  WS_METHODS,
  WorkflowOperationError,
  CommandId,
  ThreadId,
  EnvironmentAuthorizationError,
  OrchestrationV2DispatchCommandError,
  OrchestrationV2GetThreadProjectionError,
  type OrchestrationV2Command,
} from "@t3tools/contracts";
import * as Workflow from "./workflow/Workflow.ts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { ProviderRegistry } from "./provider/Services/ProviderRegistry.ts";
import { ServerSettingsService } from "./serverSettings.ts";
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
      rpc._tag === ORCHESTRATION_V2_WS_METHODS.getTaskResultContinuationStatus ||
      rpc._tag === ORCHESTRATION_V2_WS_METHODS.getTaskAutoPreview ||
      rpc._tag === ORCHESTRATION_V2_WS_METHODS.getTaskReview ||
      rpc._tag === WS_METHODS.workflowCatalog ||
      rpc._tag === WS_METHODS.workflowAction ||
      rpc._tag === WS_METHODS.workflowConfigurationStatus ||
      rpc._tag === WS_METHODS.workflowReadRun ||
      rpc._tag === WS_METHODS.workflowStagePreview ||
      rpc._tag === WS_METHODS.workflowDispatchStage ||
      rpc._tag === WS_METHODS.workflowReconcileDispatch ||
      rpc._tag === WS_METHODS.workflowProposeArtifact,
  ),
);

const isWorkflowOperationError = Schema.is(WorkflowOperationError);

export const makeTaskRpcHandlers = Effect.fn("ws.makeTaskRpcHandlers")(function* (
  currentSession: AuthenticatedSession,
  recordClientCommandAnalytics: (command: OrchestrationV2Command) => Effect.Effect<void>,
) {
  const sql = yield* SqlClient.SqlClient;
  const providerRegistry = yield* ProviderRegistry;
  const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
  const settings = yield* Effect.serviceOption(ServerSettingsService);
  const recordedDefault =
    Option.isSome(settings) && settings.value.getRecordedDefaultModelSelection
      ? settings.value.getRecordedDefaultModelSelection
      : Effect.succeed(null);
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
    return instrumentRpcEffect(
      method,
      authorized.pipe(Effect.provideService(SqlClient.SqlClient, sql)),
      attributes,
    );
  };
  const workflowFailure = () =>
    new WorkflowOperationError({
      message: "Workflow action or catalog is unavailable, unauthorized or stale.",
    });
  return TaskRpcGroup.of({
    [WS_METHODS.workflowReadRun]: (input) =>
      observeRpcEffect(
        WS_METHODS.workflowReadRun,
        Effect.gen(function* () {
          const catalog = yield* Workflow.workflowCatalogForProject(input.projectId);
          return catalog.runs.find((run) => run.id === input.runId) ?? null;
        }).pipe(
          Effect.catchCause((cause) => {
            const error = Cause.squash(cause);
            if (isWorkflowOperationError(error)) return Effect.fail(error);
            return Effect.fail(
              new WorkflowOperationError({ message: "Workflow run is unavailable." }),
            );
          }),
        ),
        { "rpc.aggregate": "workflow" },
      ),
    [WS_METHODS.workflowStagePreview]: (input) =>
      observeRpcEffect(
        WS_METHODS.workflowStagePreview,
        Effect.gen(function* () {
          const [environmentId, providers, settings] = yield* Effect.all([
            serverEnvironment.getEnvironmentId,
            providerRegistry.getProviders,
            recordedDefault,
          ]);
          const preview = yield* Workflow.previewWorkflowStage(input, {
            environmentId,
            providers,
            environmentDefaultModelSelection: settings,
          });
          return {
            stage: preview.stage,
            profile: preview.profile,
            attempt: preview.attempt,
            packetText: preview.packetText,
            route: preview.route,
            ...(preview.review ? { review: preview.review } : {}),
          };
        }).pipe(
          Effect.catchCause((cause) => {
            const error = Cause.squash(cause);
            if (isWorkflowOperationError(error)) return Effect.fail(error);
            return Effect.fail(
              new WorkflowOperationError({
                message: "Workflow stage preview is unavailable.",
              }),
            );
          }),
        ),
        { "rpc.aggregate": "workflow" },
      ),
    [WS_METHODS.workflowReconcileDispatch]: (input) =>
      observeRpcEffect(
        WS_METHODS.workflowReconcileDispatch,
        Workflow.reconcileWorkflowDispatch(input).pipe(
          Effect.catchCause(() =>
            Effect.fail(
              new WorkflowOperationError({
                message: "Dispatch outcome UNKNOWN. No resend was attempted.",
              }),
            ),
          ),
        ),
        { "rpc.aggregate": "workflow" },
      ),
    [WS_METHODS.workflowDispatchStage]: (input) =>
      observeRpcEffect(
        WS_METHODS.workflowDispatchStage,
        Effect.gen(function* () {
          const [environmentId, providers, settings] = yield* Effect.all([
            serverEnvironment.getEnvironmentId,
            providerRegistry.getProviders,
            recordedDefault,
          ]);
          return yield* Workflow.dispatchWorkflowStage(input, {
            environmentId,
            providers,
            environmentDefaultModelSelection: settings,
            launch: (payload) =>
              threadLaunch
                .launch({
                  commandId: CommandId.make(`workflow-create-${input.dispatchId}`),
                  threadId: payload.threadId,
                  projectId: input.projectId,
                  title: `Workflow: ${payload.stage.label}`,
                  modelSelection: input.target,
                  taskGovernance: "required",
                  taskContract: payload.taskContract,
                  runtimeMode: "approval-required",
                  interactionMode: "default",
                  workspaceStrategy: { type: "root" },
                  initialMessage: {
                    messageId: payload.messageId,
                    text: payload.prompt,
                    attachments: [],
                  },
                  createdBy: "user",
                  creationSource: "web",
                })
                .pipe(Effect.as({ sequence: 1 })),
          });
        }).pipe(
          Effect.catchCause((cause) => {
            const error = Cause.squash(cause);
            if (isWorkflowOperationError(error)) return Effect.fail(error);
            return Effect.fail(
              new WorkflowOperationError({
                message: "Workflow dispatch failed or is stale.",
              }),
            );
          }),
        ),
        { "rpc.aggregate": "workflow" },
      ),
    [WS_METHODS.workflowProposeArtifact]: (input) =>
      observeRpcEffect(
        WS_METHODS.workflowProposeArtifact,
        Workflow.proposeWorkflowArtifact(input, () => Effect.succeed({ sequence: 1 })).pipe(
          Effect.catchCause((cause) => {
            const error = Cause.squash(cause);
            if (isWorkflowOperationError(error)) return Effect.fail(error);
            return Effect.fail(
              new WorkflowOperationError({
                message: "Workflow artifact could not be proposed.",
              }),
            );
          }),
        ),
        { "rpc.aggregate": "workflow" },
      ),
    [WS_METHODS.workflowConfigurationStatus]: (input) =>
      observeRpcEffect(
        WS_METHODS.workflowConfigurationStatus,
        Workflow.readConfigurationCommandStatus(input).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.provideService(ServerEnvironment.ServerEnvironment, serverEnvironment),
          Effect.catchCause(() => Effect.fail(workflowFailure())),
        ),
      ),
    [WS_METHODS.workflowCatalog]: (input) =>
      observeRpcEffect(
        WS_METHODS.workflowCatalog,
        Workflow.workflowCatalogForProject(input.projectId).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.provideService(ServerEnvironment.ServerEnvironment, serverEnvironment),
          Effect.catchCause(() => Effect.fail(workflowFailure())),
        ),
      ),
    [WS_METHODS.workflowAction]: (input) =>
      observeRpcEffect(
        WS_METHODS.workflowAction,
        Workflow.performWorkflowAction(input, () => Effect.succeed({ sequence: 1 })).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.provideService(ServerEnvironment.ServerEnvironment, serverEnvironment),
          Effect.catchCause(() => Effect.fail(workflowFailure())),
        ),
      ),
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
    [ORCHESTRATION_V2_WS_METHODS.getTaskResultContinuationStatus]: (input) =>
      observeRpcEffect(
        ORCHESTRATION_V2_WS_METHODS.getTaskResultContinuationStatus,
        orchestrationEngine
          .getTaskResultContinuationStatus(input)
          .pipe(
            Effect.provideService(ServerEnvironment.ServerEnvironment, serverEnvironment),
            Effect.provideService(SqlClient.SqlClient, sql),
          ),
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
