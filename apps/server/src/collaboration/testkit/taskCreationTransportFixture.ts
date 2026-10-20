import { attachmentUploadRouteLayer } from "../../http.ts";
import * as Option from "effect/Option";
import * as FileSystem from "effect/FileSystem";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import {
  issueAttachmentUploadUrl,
  deletePendingAttachment,
} from "../../assets/AttachmentUpload.ts";
import { AuthSessionRepository } from "../../persistence/AuthSessions.ts";
import { EnvironmentAuthorizationError } from "@t3tools/contracts";
import {
  ChatFileAttachment,
  DispatcherTaskRouteBinding,
  HYBRID_TASK_ROUTER_POLICY_VERSION,
  MODEL_ROUTER_POLICY_VERSION,
  TURN_OUTCOME_OBSERVATION_VERSION,
  UNKNOWN_TASK_PROFILE,
  ObservationId,
  emptyTiming,
  emptyUsageMeasurement,
  emptyCostMeasurement,
  emptyOutcomeEvidence,
  type TaskMacroCategory,
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  EnvironmentId,
  CommandId,
  EnvironmentHttpApi,
  ORCHESTRATION_PROTOCOL_VERSION,
  ORCHESTRATION_V2_WS_METHODS,
  WS_METHODS,
  WsRpcGroup,
  DEFAULT_SERVER_SETTINGS,
  type AuthEnvironmentScope,
  type OrchestrationV2Command,
  type ServerConfig as ClientServerConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
const decodeNativeFileAttachment = Schema.decodeUnknownSync(ChatFileAttachment);
const decodeRouteBinding = Schema.decodeUnknownEffect(
  Schema.fromJsonString(DispatcherTaskRouteBinding),
);
import * as Layer from "effect/Layer";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Queue from "effect/Queue";
import * as Deferred from "effect/Deferred";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as Fiber from "effect/Fiber";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { HttpApi } from "effect/unstable/httpapi";
import { RpcServer, RpcSerialization, RpcGroup } from "effect/unstable/rpc";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { TaskRpcGroup, makeTaskRpcHandlers } from "../../taskRpcHandlers.ts";
import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import { environmentAuthenticatedAuthLayer } from "../../auth/http.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { PolicyExecutionContext } from "../../policy/executionContext.ts";
import { ServerRuntimeStartup, makeCommandGate } from "../../serverRuntimeStartup.ts";
import { collaborationHttpApiLayer } from "../http.ts";
import * as CollaborationThreads from "../CollaborationThreads.ts";
import type { ProviderAdapterV2Event } from "../../orchestration-v2/ProviderAdapter.ts";
import { withTaskResultLinkageFixture } from "./taskResultLinkageFixture.ts";
import { agentsCreationProvider } from "./agentsTaskCreationFixture.ts";

class FixtureHttpApi extends HttpApi.make("environment").add(
  EnvironmentHttpApi.groups.collaboration,
) {}
const group = TaskRpcGroup.merge(
  RpcGroup.make(
    ...Array.from(WsRpcGroup.requests.values()).filter(
      (rpc) =>
        rpc._tag === WS_METHODS.subscribeServerConfig ||
        rpc._tag === WS_METHODS.serverProbe ||
        rpc._tag === WS_METHODS.attachmentsCreateUploadUrl ||
        rpc._tag === WS_METHODS.attachmentsDelete,
    ),
  ),
);
const configuredProviders: ReadonlyArray<ServerProvider> = [
  {
    ...agentsCreationProvider,
    models: [
      ...agentsCreationProvider.models,
      { ...agentsCreationProvider.models[0]!, slug: "exact-second", name: "Exact second" },
      { ...agentsCreationProvider.models[0]!, slug: "bbb-auto", name: "Auto candidate" },
    ],
  },
];

/** Real loopback RPC, production handlers/intake/auth; only catalog, provider adapter and bootstrap config are fixtures. */
export async function withTaskCreationTransportFixture(
  check: (f: {
    expireAttachment: (
      attachment: import("@t3tools/contracts").ChatFileAttachment,
    ) => Promise<void>;
    failJointEvidence: (
      stage: "pending-file" | "accepted-file" | "accepted-skill" | "accepted-handoff",
    ) => void;
    corruptJointSkillDelivery: (threadId: string) => Promise<void>;
    corruptFileDelivery: (threadId: string) => Promise<void>;
    attachmentBytes: (
      attachment: import("@t3tools/contracts").ChatFileAttachment,
    ) => Promise<string>;
    changeAttachment: (
      attachment: import("@t3tools/contracts").ChatFileAttachment,
      text: string,
    ) => Promise<void>;
    providers: ReadonlyArray<ServerProvider>;
    seedTaskRouting: (
      profiles: ReadonlyArray<{
        category: TaskMacroCategory;
        classifierVersion: string;
        trials: number;
      }>,
    ) => Promise<void>;
    routingBinding: (threadId: string, messageId: string) => Promise<DispatcherTaskRouteBinding>;
    routingEvidenceState: () => Promise<{
      totalChanges: number;
      observations: ReadonlyArray<{ observation_id: string; payload_json: string }>;
      policies: ReadonlyArray<{ policy_id: string; payload_json: string }>;
    }>;
    connection: (
      scopes?: ReadonlyArray<AuthEnvironmentScope>,
      subject?: string,
    ) => Promise<{ httpBaseUrl: string; socketUrl: string; token: string; sessionId: string }>;
    revoke: (sessionId: string) => Promise<void>;
    dropNextReply: () => void;
    awaitDroppedReply: () => Promise<void>;
    setEnvironment: (value: string) => void;
    setProviders: (value: ReadonlyArray<ServerProvider>) => void;
    drain: () => Promise<void>;
    settle: (messageId: string) => Promise<void>;
    alterLatestOutput: (threadId: string, text: string) => Promise<void>;
    setWorkflowOutput: (text: string) => void;
    alterBackgroundWork: (threadId: string) => Promise<void>;
    runInput: (text: string) => void;
    awaitRunning: () => Promise<void>;
    awaitInterrupted: () => Promise<void>;
    finishRunning: (status: "completed" | "interrupted") => Promise<void>;
    flush: () => Promise<void>;
    interruptCount: () => number;
    holdInput: (text: string) => void;
    awaitHeldStart: () => Promise<void>;
    releaseHeldStart: () => void;
    failInput: (text: string) => void;
    holdContinuationCommit: (commandId: string) => void;
    awaitContinuationCommit: () => Promise<{
      commandId: string;
      priorRunId: string;
      plannedRunId: string;
      eventTypes: ReadonlyArray<string>;
    }>;
    releaseContinuationCommit: () => void;
    awaitDispatchReceived: (commandId: string) => Promise<void>;
    eventsForCommand: (commandId: string) => Promise<ReadonlyArray<string>>;
    executionCounts: () => Promise<{
      runs: number;
      grants: number;
      outbox: number;
      messages: number;
    }>;
    inspect: () => Promise<{
      starts: ReadonlyArray<import("@t3tools/contracts").ModelSelection>;
      inputs: ReadonlyArray<string>;
      fileReads: ReadonlyArray<{
        messageId: string;
        attachment: import("@t3tools/contracts").ChatFileAttachment;
        text: string;
      }>;
      attachments: ReadonlyArray<ReadonlyArray<import("@t3tools/contracts").ChatAttachment>>;
      commands: ReadonlyArray<OrchestrationV2Command>;
      rpcMethods: ReadonlyArray<string>;
    }>;
  }) => Promise<void>,
) {
  type CommitBoundary = {
    commandId: string;
    priorRunId: string;
    plannedRunId: string;
    eventTypes: ReadonlyArray<string>;
  };
  let commitTarget: string | null = null;
  let commitEntered = Deferred.makeUnsafe<CommitBoundary>();
  let commitRelease = Deferred.makeUnsafe<void>();
  const dispatchReceived = new Map<string, Deferred.Deferred<void>>();
  const received = (id: string) => {
    let gate = dispatchReceived.get(id);
    if (!gate) {
      gate = Deferred.makeUnsafe<void>();
      dispatchReceived.set(id, gate);
    }
    return gate;
  };
  let runningStarted = Deferred.makeUnsafe<void>();
  const nativeInterrupted = Deferred.makeUnsafe<void>();
  let runningText: string | null = null;
  let workflowOutput: string | null = null;
  let jointEvidenceFailure:
    | "pending-file"
    | "accepted-file"
    | "accepted-skill"
    | "accepted-handoff"
    | null = null;
  let interrupts = 0;
  let finishRunning: ((status: "completed" | "interrupted") => Effect.Effect<void>) | null = null;
  const nativeFileReads: Array<{
    messageId: string;
    attachment: import("@t3tools/contracts").ChatFileAttachment;
    text: string;
  }> = [];
  let heldText: string | null = null;
  let failedText: string | null = null;
  let heldStarted = Deferred.makeUnsafe<void>();
  let heldRelease = Deferred.makeUnsafe<void>();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const configContext = yield* Layer.build(
          ServerConfig.layerTest(process.cwd(), { prefix: "b3r-file-transport-" }).pipe(
            Layer.provide(NodeServices.layer),
          ),
        );
        const referenceConfig = Context.get(configContext, ServerConfig.ServerConfig);
        const referenceLayer = Layer.succeed(ServerConfig.ServerConfig, referenceConfig);
        return yield* withTaskResultLinkageFixture(
          (f) =>
            Effect.gen(function* () {
              let environment = "environment-a";
              let providers = configuredProviders;
              f.setProviders(providers);
              let drop = false;
              let dropped = yield* Deferred.make<void>();
              const commands: OrchestrationV2Command[] = [];
              const rpcMethods: string[] = [];
              const engine = Layer.succeed(Orchestrator.OrchestratorV2, f.orchestrator);
              const environmentLayer = Layer.mergeAll(
                Layer.mock(ServerEnvironment.ServerEnvironment)({
                  getEnvironmentId: Effect.sync(() => EnvironmentId.make(environment)),
                }),
                Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
                  getEnvironmentId: Effect.sync(() => EnvironmentId.make(environment)),
                }),
              );
              const gate = yield* makeCommandGate;
              yield* gate.signalCommandReady;
              const base = Layer.mergeAll(
                engine,
                Layer.succeed(SqlClient.SqlClient, f.sql),
                ThreadManagement.layer.pipe(Layer.provide(engine)),
                // Transport fake at the launch boundary; the separate workflow process journey
                // covers the real ThreadLaunchService and its preparation/recovery receipts.
                Layer.mock(ThreadLaunch.ThreadLaunchService)({
                  launch: (input) =>
                    Effect.gen(function* () {
                      const initial = input.initialMessage;
                      if (!input.threadId || !initial?.messageId)
                        return yield* Effect.die("workflow fixture requires stable IDs");
                      yield* f.orchestrator.dispatch({
                        type: "thread.create",
                        commandId: input.commandId,
                        threadId: input.threadId,
                        projectId: input.projectId,
                        title: input.title,
                        modelSelection: input.modelSelection,
                        runtimeMode: input.runtimeMode,
                        interactionMode: input.interactionMode,
                        branch: null,
                        worktreePath: null,
                        taskGovernance: input.taskGovernance,
                        taskContract: input.taskContract,
                        createdBy: "user",
                        creationSource: "web",
                      });
                      yield* f.orchestrator.dispatch({
                        type: "message.dispatch",
                        commandId: CommandId.make(`${input.commandId}:initial-message`),
                        threadId: input.threadId,
                        messageId: initial.messageId,
                        text: initial.text,
                        attachments: [],
                        modelSelection: input.modelSelection,
                        dispatchMode: { type: "start_immediately" },
                        createdBy: "user",
                        creationSource: "web",
                      });
                      return {
                        threadId: input.threadId,
                        projection: yield* f.orchestrator.getThreadProjection(input.threadId),
                        resumed: false,
                      };
                    }).pipe(
                      Effect.mapError(
                        (cause) =>
                          new ThreadLaunch.ThreadLaunchError({
                            operation: "dispatch-message",
                            commandId: input.commandId,
                            projectId: input.projectId,
                            cause,
                          }),
                      ),
                    ),
                }),
                referenceLayer,
                environmentLayer,
                Layer.succeed(ServerRuntimeStartup, {
                  enqueueCommand: gate.enqueueCommand,
                  awaitCommandReady: gate.awaitCommandReady,
                  markHttpListening: Effect.void,
                }),
                Layer.mock(ProviderRegistry)({ getProviders: Effect.sync(() => providers) }),
                ProjectStore.layer.pipe(Layer.provide(Layer.succeed(SqlClient.SqlClient, f.sql))),
              ).pipe(Layer.provideMerge(NodeServices.layer));
              const authRuntime = EnvironmentAuth.layer.pipe(
                Layer.provideMerge(ServerSecretStore.layer),
                Layer.provideMerge(base),
              );
              const collaboration = CollaborationThreads.layer.pipe(Layer.provide(base));
              const context = yield* Layer.build(Layer.mergeAll(authRuntime, collaboration));
              const auth = Context.get(context, EnvironmentAuth.EnvironmentAuth);
              const clientConfig: () => ClientServerConfig = () => ({
                environment: {
                  environmentId: EnvironmentId.make(environment),
                  label: "Transport fixture",
                  platform: { os: "linux", arch: "x64" },
                  serverVersion: "0.0.0-fixture",
                  capabilities: { repositoryIdentity: true, connectionProbe: true },
                },
                auth: {
                  policy: "loopback-browser",
                  bootstrapMethods: ["one-time-token"],
                  sessionMethods: ["browser-session-cookie", "bearer-access-token"],
                  sessionCookieName: "fixture",
                },
                cwd: "/fixture",
                keybindingsConfigPath: "/fixture/keybindings.json",
                keybindings: [],
                issues: [],
                providers,
                availableEditors: [],
                observability: {
                  logsDirectoryPath: "/fixture/logs",
                  localTracingEnabled: false,
                  otlpTracesEnabled: false,
                  otlpMetricsEnabled: false,
                  otlpLogsEnabled: false,
                },
                settings: DEFAULT_SERVER_SETTINGS,
              });
              const ws = HttpRouter.add(
                "GET",
                "/ws",
                Effect.gen(function* () {
                  const request = yield* HttpServerRequest.HttpServerRequest;
                  const session = yield* auth.authenticateWebSocketUpgrade(request);
                  const handlers = yield* makeTaskRpcHandlers(session, () => Effect.void).pipe(
                    Effect.provide(context),
                  );
                  const actualDispatch = handlers[ORCHESTRATION_V2_WS_METHODS.dispatchCommand];
                  const actualConfiguration = handlers[WS_METHODS.workflowAction];
                  const actualWorkflowDispatch = handlers[WS_METHODS.workflowDispatchStage];
                  const layer = group.toLayer({
                    ...handlers,
                    [WS_METHODS.workflowDispatchStage]: (input) =>
                      actualWorkflowDispatch(input).pipe(
                        Effect.flatMap((result) =>
                          drop
                            ? Effect.gen(function* () {
                                drop = false;
                                yield* Deferred.succeed(dropped, undefined);
                                return yield* Effect.never;
                              })
                            : Effect.succeed(result),
                        ),
                      ),
                    [WS_METHODS.workflowAction]: (input) =>
                      actualConfiguration(input).pipe(
                        Effect.flatMap((result) =>
                          drop
                            ? Effect.gen(function* () {
                                drop = false;
                                yield* Deferred.succeed(dropped, undefined);
                                return yield* Effect.never;
                              })
                            : Effect.succeed(result),
                        ),
                      ),
                    [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command) => {
                      commands.push(command);
                      Deferred.doneUnsafe(received(command.commandId), Effect.void);
                      rpcMethods.push(ORCHESTRATION_V2_WS_METHODS.dispatchCommand);
                      return actualDispatch(command).pipe(
                        Effect.flatMap((result) =>
                          drop
                            ? Effect.gen(function* () {
                                drop = false;
                                yield* Deferred.succeed(dropped, undefined);
                                return yield* Effect.never;
                              })
                            : Effect.succeed(result),
                        ),
                      );
                    },
                    [WS_METHODS.subscribeServerConfig]: () =>
                      Stream.concat(
                        Stream.make({
                          version: 1 as const,
                          type: "snapshot" as const,
                          config: clientConfig(),
                        }),
                        Stream.never,
                      ),
                    [WS_METHODS.serverProbe]: () => Effect.succeed({}),
                    [WS_METHODS.attachmentsCreateUploadUrl]: (input) =>
                      Effect.gen(function* () {
                        const repo = Context.get(context, AuthSessionRepository);
                        const current = yield* repo.getById({ sessionId: session.sessionId }).pipe(
                          Effect.mapError(
                            () =>
                              new EnvironmentAuthorizationError({
                                message: "Upload session unavailable",
                                requiredScope: AuthOrchestrationOperateScope,
                              }),
                          ),
                        );
                        if (
                          !session.scopes.includes(AuthOrchestrationOperateScope) ||
                          Option.isNone(current) ||
                          current.value.revokedAt !== null
                        )
                          return yield* new EnvironmentAuthorizationError({
                            message: "Upload requires current operate session",
                            requiredScope: AuthOrchestrationOperateScope,
                          });
                        return yield* issueAttachmentUploadUrl(input);
                      }).pipe(Effect.provide(context)),
                    [WS_METHODS.attachmentsDelete]: (input) =>
                      deletePendingAttachment(input.attachmentId).pipe(Effect.provide(context)),
                  });
                  const { protocol, httpEffect } =
                    yield* RpcServer.makeProtocolWithHttpEffectWebsocket;
                  yield* RpcServer.make(group, { disableTracing: true }).pipe(
                    Effect.provide(Layer.merge(layer, RpcSerialization.layerJson)),
                    Effect.provideService(RpcServer.Protocol, protocol),
                    Effect.provideService(PolicyExecutionContext, {
                      kind: "session",
                      actorId: session.subject,
                      sessionId: session.sessionId,
                      scopes: session.scopes,
                      ...(session.expiresAt
                        ? { expiresAt: DateTime.formatIso(session.expiresAt) }
                        : {}),
                    }),
                    Effect.forkScoped,
                  );
                  return yield* httpEffect;
                }).pipe(
                  Effect.provide(RpcSerialization.layerJson),
                  Effect.catch(() => Effect.succeed(HttpServerResponse.empty({ status: 401 }))),
                ),
              );
              const uploads = attachmentUploadRouteLayer.pipe(
                HttpRouter.provideRequest(Layer.succeedContext(context)),
              );
              const http = HttpApiBuilder.layer(FixtureHttpApi).pipe(
                Layer.provide(collaborationHttpApiLayer),
                Layer.provide(environmentAuthenticatedAuthLayer),
                Layer.provide(Layer.succeedContext(context)),
              );
              const server = yield* Layer.build(
                HttpRouter.serve(Layer.mergeAll(ws, http, uploads), {
                  disableListenLog: true,
                }).pipe(Layer.provideMerge(NodeHttpServer.layerTest)),
              );
              const httpBaseUrl = HttpServer.formatAddress(
                Context.get(server, HttpServer.HttpServer).address,
              );
              const run = Effect.runPromiseWith(context);
              const runningMessages = yield* Queue.unbounded<void>();
              const terminalMessages = yield* Queue.unbounded<string>();
              yield* f.orchestrator.streamDomainEvents.pipe(
                Stream.runForEach((e) =>
                  e.type === "provider-turn.updated" && e.payload.status === "running"
                    ? Queue.offer(runningMessages, undefined)
                    : e.type === "run.updated" &&
                        e.payload.userMessageId &&
                        ["completed", "failed", "interrupted", "cancelled"].includes(
                          e.payload.status,
                        )
                      ? Queue.offer(terminalMessages, e.payload.userMessageId)
                      : Effect.void,
                ),
                Effect.forkScoped,
              );
              const completed = yield* f.orchestrator.streamDomainEvents.pipe(
                Stream.filter(
                  (e) =>
                    e.type === "run.updated" &&
                    ["completed", "failed", "interrupted", "cancelled"].includes(e.payload.status),
                ),
                Stream.take(1),
                Stream.runDrain,
                Effect.forkScoped,
              );
              yield* Effect.promise(() =>
                check({
                  providers: configuredProviders,
                  // Fixture setup only: seed an already-selected policy in disposable SQLite.
                  // This does not call the activation API or change a real environment's policy.
                  seedTaskRouting: (profiles) =>
                    run(
                      Effect.gen(function* () {
                        const env = EnvironmentId.make("environment-a");
                        yield* f.evaluation.status(env);
                        const now = DateTime.formatIso(yield* DateTime.now);
                        yield* f.sql`UPDATE router_policies SET state='retired',payload_json=json_set(payload_json,'$.state','retired','$.retiredAt',${now}) WHERE environment_id=${env} AND state='active'`;
                        yield* f.sql`UPDATE router_policies SET state='active',payload_json=json_set(payload_json,'$.state','active','$.activationConfirmed',json('true'),'$.activatedAt',${now},'$.activatedBy','fixture-owner') WHERE environment_id=${env} AND json_extract(payload_json,'$.policyVersion')=${HYBRID_TASK_ROUTER_POLICY_VERSION}`;
                        for (const [profileIndex, profile] of profiles.entries())
                          for (const model of ["bbb-auto", "exact-second"])
                            for (let index = 0; index < profile.trials; index++)
                              yield* f.evaluation.recordObservation({
                                version: TURN_OUTCOME_OBSERVATION_VERSION,
                                observationId: ObservationId.make(
                                  `zh-fixture-${profileIndex}-${model}-${index}`,
                                ),
                                environmentId: env,
                                recordedAt: now,
                                policyVersion: MODEL_ROUTER_POLICY_VERSION,
                                routingMode: "auto",
                                instanceId: agentsCreationProvider.instanceId,
                                model,
                                taskProfile: UNKNOWN_TASK_PROFILE,
                                localTaskProfile: {
                                  classifierVersion: profile.classifierVersion,
                                  category: profile.category,
                                  source: "local-heuristic",
                                },
                                timing: emptyTiming(),
                                usage: emptyUsageMeasurement(),
                                cost: emptyCostMeasurement(),
                                providerAttempts: 1,
                                fallbackCount: 0,
                                cancelled: false,
                                timedOut: false,
                                finishReason: model === "exact-second" ? "stop" : "error",
                                terminalCategory:
                                  model === "exact-second" ? "success" : "provider_failure",
                                evidence: emptyOutcomeEvidence(),
                              });
                      }),
                    ),
                  routingBinding: (threadId, messageId) =>
                    run(
                      Effect.gen(function* () {
                        const rows = yield* f.sql<{
                          binding_json: string;
                        }>`SELECT binding_json FROM projection_dispatcher_task_routes WHERE thread_id=${threadId} AND message_id=${messageId}`;
                        if (!rows[0]) return yield* Effect.die("No fixture route binding");
                        return yield* decodeRouteBinding(rows[0].binding_json);
                      }),
                    ),
                  routingEvidenceState: () =>
                    run(
                      Effect.gen(function* () {
                        const changes = yield* f.sql<{ n: number }>`SELECT total_changes() AS n`;
                        return {
                          totalChanges: Number(changes[0]!.n),
                          observations: yield* f.sql<{
                            observation_id: string;
                            payload_json: string;
                          }>`SELECT observation_id,payload_json FROM router_turn_observations ORDER BY observation_id`,
                          policies: yield* f.sql<{
                            policy_id: string;
                            payload_json: string;
                          }>`SELECT policy_id,payload_json FROM router_policies ORDER BY policy_id`,
                        };
                      }),
                    ),
                  connection: async (
                    scopes = [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
                    subject = "fixture-owner",
                  ) => {
                    const issued = await run(auth.issueSession({ subject, scopes }));
                    const ticket = await run(auth.issueWebSocketTicket(issued));
                    const url = new URL("/ws", httpBaseUrl);
                    url.protocol = "ws:";
                    url.searchParams.set(
                      "orchestrationProtocol",
                      String(ORCHESTRATION_PROTOCOL_VERSION),
                    );
                    url.searchParams.set("wsTicket", ticket.ticket);
                    return {
                      httpBaseUrl,
                      socketUrl: url.toString(),
                      token: issued.token,
                      sessionId: issued.sessionId,
                    };
                  },
                  revoke: async (id) => {
                    await run(auth.revokeSession(importSessionId(id)));
                  },
                  dropNextReply: () => {
                    drop = true;
                    dropped = Deferred.makeUnsafe<void>();
                  },
                  awaitDroppedReply: () => Effect.runPromise(Deferred.await(dropped)),
                  setEnvironment: (value) => {
                    environment = value;
                    f.setEnvironment(value);
                  },
                  setProviders: (value) => {
                    providers = value;
                    f.setProviders(value);
                  },
                  failJointEvidence: (stage) => {
                    jointEvidenceFailure = stage;
                  },
                  corruptJointSkillDelivery: (threadId) =>
                    run(
                      f.sql`UPDATE orchestration_v2_projection_runs SET payload_json=json_set(payload_json,'$.instructionSkillDelivery.reviewId','unmatched-joint-review') WHERE thread_id=${threadId}`.pipe(
                        Effect.asVoid,
                      ),
                    ),
                  setWorkflowOutput: (text) => {
                    workflowOutput = text;
                  },
                  runInput: (text) => {
                    runningText = text;
                    runningStarted = Deferred.makeUnsafe<void>();
                  },
                  awaitRunning: () =>
                    run(
                      Deferred.await(runningStarted).pipe(
                        Effect.andThen(Queue.take(runningMessages)),
                      ),
                    ),
                  awaitInterrupted: () => run(Deferred.await(nativeInterrupted)),
                  finishRunning: (status) => {
                    if (!finishRunning) throw new Error("No running fixture turn");
                    return run(finishRunning(status));
                  },
                  flush: () => run(f.worker.drain().pipe(Effect.asVoid)),
                  interruptCount: () => interrupts,
                  holdInput: (text) => {
                    heldText = text;
                    heldStarted = Deferred.makeUnsafe<void>();
                    heldRelease = Deferred.makeUnsafe<void>();
                  },
                  awaitHeldStart: () => Effect.runPromise(Deferred.await(heldStarted)),
                  releaseHeldStart: () => {
                    Deferred.doneUnsafe(heldRelease, Effect.void);
                  },
                  failInput: (text) => {
                    failedText = text;
                  },
                  holdContinuationCommit: (commandId) => {
                    commitTarget = commandId;
                    commitEntered = Deferred.makeUnsafe<CommitBoundary>();
                    commitRelease = Deferred.makeUnsafe<void>();
                  },
                  awaitContinuationCommit: () => Effect.runPromise(Deferred.await(commitEntered)),
                  releaseContinuationCommit: () => {
                    Deferred.doneUnsafe(commitRelease, Effect.void);
                  },
                  awaitDispatchReceived: (commandId) =>
                    Effect.runPromise(Deferred.await(received(commandId))),
                  eventsForCommand: (commandId) =>
                    run(
                      f.eventSink.readByCommandId({ commandId: CommandId.make(commandId) }).pipe(
                        Stream.runCollect,
                        Effect.map((events) => Array.from(events, (event) => event.event.type)),
                      ),
                    ),
                  executionCounts: () => run(f.noExecution()),
                  alterBackgroundWork: (threadId) =>
                    run(
                      f.sql`UPDATE orchestration_v2_projection_provider_threads SET payload_json=json_set(payload_json,'$.pendingBackgroundTasks',json('[{"taskId":"fixture-background","kind":"background_task"}]')) WHERE thread_id=${threadId}`.pipe(
                        Effect.asVoid,
                      ),
                    ),
                  settle: (messageId) =>
                    run(
                      f.worker.drain().pipe(
                        Effect.andThen(
                          Stream.fromQueue(terminalMessages).pipe(
                            Stream.filter((id) => id === messageId),
                            Stream.take(1),
                            Stream.runDrain,
                          ),
                        ),
                        Effect.andThen(f.worker.drain()),
                        Effect.asVoid,
                      ),
                    ),
                  alterLatestOutput: (threadId, text) =>
                    run(
                      f.sql`UPDATE orchestration_v2_projection_turn_items SET payload_json=json_set(payload_json,'$.text',${text}) WHERE turn_item_id=(SELECT turn_item_id FROM orchestration_v2_projection_turn_items WHERE thread_id=${threadId} AND json_extract(payload_json,'$.type')='assistant_message' ORDER BY json_extract(payload_json,'$.ordinal') DESC LIMIT 1)`.pipe(
                        Effect.asVoid,
                      ),
                    ),
                  drain: () =>
                    Effect.runPromise(
                      f.worker
                        .drain()
                        .pipe(
                          Effect.andThen(Fiber.join(completed)),
                          Effect.andThen(f.worker.drain()),
                          Effect.asVoid,
                        ),
                    ),
                  expireAttachment: (attachment) =>
                    run(
                      Effect.gen(function* () {
                        const fs = yield* FileSystem.FileSystem;
                        const path = resolveAttachmentPath({
                          attachmentsDir: referenceConfig.attachmentsDir,
                          attachment,
                        });
                        if (!path) throw new Error("Missing path");
                        const old = DateTime.toDateUtc(DateTime.makeUnsafe(0));
                        yield* fs.utimes(path, old, old);
                      }),
                    ),
                  corruptFileDelivery: (threadId) =>
                    run(
                      f.sql`UPDATE orchestration_v2_projection_runs SET payload_json=json_set(payload_json,'$.referenceFileDelivery.modelSelection.model','unmatched-file-model') WHERE thread_id=${threadId}`.pipe(
                        Effect.asVoid,
                      ),
                    ),
                  attachmentBytes: (attachment: import("@t3tools/contracts").ChatFileAttachment) =>
                    run(
                      Effect.gen(function* () {
                        const fs = yield* FileSystem.FileSystem;
                        const path = resolveAttachmentPath({
                          attachmentsDir: referenceConfig.attachmentsDir,
                          attachment,
                        });
                        if (!path) throw new Error("Missing path");
                        return new TextDecoder().decode(yield* fs.readFile(path));
                      }),
                    ),
                  changeAttachment: (
                    attachment: import("@t3tools/contracts").ChatFileAttachment,
                    text: string,
                  ) =>
                    run(
                      Effect.gen(function* () {
                        const fs = yield* FileSystem.FileSystem;
                        const path = resolveAttachmentPath({
                          attachmentsDir: referenceConfig.attachmentsDir,
                          attachment,
                        });
                        if (!path) throw new Error("Missing path");
                        yield* fs.writeFileString(path, text);
                      }),
                    ),
                  inspect: () =>
                    Effect.runPromise(
                      Effect.gen(function* () {
                        return {
                          starts: yield* Ref.get(f.started),
                          inputs: (yield* Ref.get(f.executions)).map((e) => e.message.text),
                          fileReads: [...nativeFileReads],
                          attachments: (yield* Ref.get(f.executions)).map(
                            (e) => e.message.attachments,
                          ),
                          commands: [...commands],
                          rpcMethods: [...rpcMethods],
                        };
                      }),
                    ),
                }),
              );
            }),
          {
            serverConfigLayer: referenceLayer,
            governedWorker: true,
            useProjectRuntimePolicy: true,
            // Pause only after the real orchestrator has validated and planned.
            // Resume into the unchanged production transaction; never forge a plan.
            decorateEventSink: (service) => ({
              ...service,
              writeIfRunCurrent: (input) =>
                Effect.gen(function* () {
                  const event = input.events.find((e) => e.type === "run.updated");
                  if (event?.type === "run.updated") {
                    const file = event.payload.referenceFileDelivery,
                      skill = event.payload.instructionSkillDelivery;
                    if (
                      (jointEvidenceFailure === "accepted-handoff" &&
                        event.payload.resultHandoffDelivery?.status === "adapter-accepted") ||
                      (jointEvidenceFailure === "pending-file" &&
                        file?.status === "unknown" &&
                        skill?.status === "unknown") ||
                      (jointEvidenceFailure === "accepted-file" &&
                        file?.status === "adapter-accepted" &&
                        skill?.status === "unknown") ||
                      (jointEvidenceFailure === "accepted-skill" &&
                        file?.status === "adapter-accepted" &&
                        skill?.status === "adapter-accepted")
                    ) {
                      jointEvidenceFailure = null;
                      return yield* Effect.die(
                        "Synthetic interruption between joint evidence writes",
                      );
                    }
                  }
                  return yield* service.writeIfRunCurrent(input);
                }),
              commitCommand: (input) =>
                Effect.gen(function* () {
                  const marker = input.resultContinuationCommand?.taskResultContinuation;
                  const handoff = input.firstLaunchCommand?.taskFirstLaunch?.resultHandoff;
                  if ((marker || handoff) && input.commandId === commitTarget) {
                    commitTarget = null;
                    const plannedRun = input.events.find((event) => event.type === "run.created");
                    if (plannedRun?.type !== "run.created")
                      throw new Error("Continuation did not reach a successful run plan");
                    yield* Deferred.succeed(commitEntered, {
                      commandId: input.commandId,
                      priorRunId: marker?.priorResult.runId ?? handoff!.result.runId,
                      plannedRunId: plannedRun.payload.id,
                      eventTypes: input.events.map((event) => event.type),
                    });
                    yield* Deferred.await(commitRelease);
                  }
                  return yield* service.commitCommand(input);
                }),
            }),
            onInterrupt: () =>
              Effect.sync(() => {
                interrupts++;
              }).pipe(Effect.andThen(Deferred.succeed(nativeInterrupted, undefined))),
            onStart: (input, events, emit) =>
              Effect.gen(function* () {
                for (const attachment of input.message.attachments)
                  if (attachment.type === "file") {
                    const path = resolveAttachmentPath({
                      attachmentsDir: referenceConfig.attachmentsDir,
                      attachment,
                    });
                    if (!path) throw new Error("Native attachment path missing");
                    const text = yield* FileSystem.FileSystem.pipe(
                      Effect.flatMap((fs) => fs.readFileString(path)),
                      Effect.provide(NodeServices.layer),
                      Effect.orDie,
                    );
                    nativeFileReads.push({
                      messageId: input.message.messageId,
                      attachment: decodeNativeFileAttachment(attachment),
                      text,
                    });
                  }
                if (runningText === input.message.text) {
                  const first = events.find((e) => e.type === "provider_turn.updated");
                  if (first?.type !== "provider_turn.updated")
                    throw new Error("Missing running turn");
                  finishRunning = (status) =>
                    Effect.forEach(
                      events,
                      (e) => {
                        let event: ProviderAdapterV2Event = e;
                        if (status === "interrupted" && e.type === "provider_turn.updated")
                          event = {
                            ...e,
                            providerTurn: { ...e.providerTurn, status, terminationConfirmed: true },
                          };
                        else if (status === "interrupted" && e.type === "turn.terminal")
                          event = { ...e, status, failure: null };
                        return emit(event);
                      },
                      { discard: true },
                    );
                  yield* emit({
                    ...first,
                    providerTurn: { ...first.providerTurn, status: "running", completedAt: null },
                  });
                  yield* Deferred.succeed(runningStarted, undefined);
                  return;
                }
                if (heldText === input.message.text) {
                  const first = events.find((e) => e.type === "provider_turn.updated");
                  if (first?.type !== "provider_turn.updated")
                    throw new Error("Missing fake provider turn");
                  yield* emit({
                    ...first,
                    providerTurn: { ...first.providerTurn, status: "running", completedAt: null },
                  });
                  yield* Deferred.succeed(heldStarted, undefined);
                  yield* Deferred.await(heldRelease);
                }
                yield* Effect.forEach(
                  events,
                  (e) =>
                    emit(
                      failedText === input.message.text && e.type === "turn.terminal"
                        ? {
                            ...e,
                            status: "failed" as const,
                            failureItemOrdinal: e.runOrdinal * 100 + 99,
                            failure: {
                              class: "provider_error" as const,
                              message: "Disposable fake provider failure",
                              code: null,
                              retryable: false,
                            },
                          }
                        : failedText === input.message.text && e.type === "provider_turn.updated"
                          ? { ...e, providerTurn: { ...e.providerTurn, status: "failed" as const } }
                          : e.type === "turn_item.updated" &&
                              e.turnItem.type === "assistant_message"
                            ? {
                                ...e,
                                turnItem: {
                                  ...e.turnItem,
                                  text: workflowOutput ?? `Transport answer: ${input.message.text}`,
                                },
                              }
                            : e,
                    ),
                  { discard: true },
                );
              }),
          },
        );
      }),
    ),
  );
}
import { AuthSessionId as SessionId } from "@t3tools/contracts";
const importSessionId = (s: string) => SessionId.make(s);
