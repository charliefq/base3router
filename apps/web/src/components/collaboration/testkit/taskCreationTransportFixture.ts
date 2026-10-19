import {
  EnvironmentId,
  type WorkflowStagePreviewInput,
  type WorkflowReconcileDispatchInput,
  type WorkflowProposeArtifactInput,
  type WorkflowDispatchStageInput,
  type WorkflowReadRunInput,
  type AuthEnvironmentScope,
  type ServerProvider,
  type OrchestrationV2Command,
  type ModelSelection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Socket from "effect/unstable/socket/Socket";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import {
  PrimaryConnectionTarget,
  AVAILABLE_CONNECTION_STATE,
  EnvironmentSupervisor,
  type PreparedConnection,
} from "@t3tools/client-runtime/connection";
import * as Crypto from "effect/Crypto";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  request,
  EnvironmentRpcRequestObserver,
  makeRpcSessionFactory,
  type RpcSession,
  makeEnvironmentHttpApiGroupClient,
} from "@t3tools/client-runtime/rpc";
import * as Commands from "@t3tools/client-runtime/operations";

type ServerFixture = {
  providers: ReadonlyArray<ServerProvider>;
  seedTaskRouting: (
    profiles: ReadonlyArray<{
      category: import("@t3tools/contracts").TaskMacroCategory;
      classifierVersion: string;
      trials: number;
    }>,
  ) => Promise<void>;
  routingBinding: (
    threadId: string,
    messageId: string,
  ) => Promise<import("@t3tools/contracts").DispatcherTaskRouteBinding>;
  routingEvidenceState: () => Promise<{
    totalChanges: number;
    observations: ReadonlyArray<{ observation_id: string; payload_json: string }>;
    policies: ReadonlyArray<{ policy_id: string; payload_json: string }>;
  }>;
  connection: (
    scopes?: ReadonlyArray<AuthEnvironmentScope>,
    subject?: string,
  ) => Promise<{ httpBaseUrl: string; socketUrl: string; token: string; sessionId: string }>;
  revoke: (id: string) => Promise<void>;
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
    starts: ReadonlyArray<ModelSelection>;
    inputs: ReadonlyArray<string>;
    commands: ReadonlyArray<OrchestrationV2Command>;
    rpcMethods: ReadonlyArray<string>;
  }>;
};
async function clientFixture(
  server: ServerFixture,
  check: (f: Effect.Success<ReturnType<typeof makeClientFixture>>) => Promise<void>,
) {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* makeClientFixture(server);
        yield* Effect.promise(() => check(f));
      }),
    ),
  );
}
const makeClientFixture = Effect.fn("TaskTransport.makeClientFixture")(function* (
  server: ServerFixture,
) {
  const factory = yield* makeRpcSessionFactory().pipe(
    Effect.provideService(Socket.WebSocketConstructor, (url) => new WebSocket(url)),
  );
  const target = new PrimaryConnectionTarget({
    environmentId: EnvironmentId.make("environment-a"),
    label: "Task transport",
    httpBaseUrl: "http://fixture",
    wsBaseUrl: "ws://fixture",
  });
  const active = yield* SubscriptionRef.make<Option.Option<RpcSession>>(Option.none());
  const prepared = yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none());
  const state = yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE);
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target,
    state,
    session: active,
    prepared,
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const methods: string[] = [];
  const observer = {
    observe: ({ method }: { method: string }) =>
      Effect.sync(() => {
        methods.push(method);
        return Effect.void;
      }),
  };
  const provide = <A, E>(
    effect: Effect.Effect<A, E, EnvironmentSupervisor.EnvironmentSupervisor | Crypto.Crypto>,
  ) =>
    effect.pipe(
      Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      Effect.provideService(EnvironmentRpcRequestObserver, observer),
      Effect.provide(NodeCrypto.layer),
    );
  let connectionScope = yield* Scope.make();
  let identity: RpcSession | null = null;
  let currentDetails: Awaited<ReturnType<ServerFixture["connection"]>> | undefined;
  const connect = async (
    scopes?: ReadonlyArray<AuthEnvironmentScope>,
    expectedEnvironment = "environment-a",
    retained = false,
    subject?: string,
  ) => {
    const details = retained ? currentDetails : await server.connection(scopes, subject);
    if (!details) throw new Error("No original fixture session");
    currentDetails = details;
    const connection: PreparedConnection = {
      environmentId: EnvironmentId.make(expectedEnvironment),
      label: target.label,
      httpBaseUrl: details.httpBaseUrl,
      socketUrl: details.socketUrl,
      httpAuthorization: { _tag: "Bearer", token: details.token },
      target,
    };
    connectionScope = await Effect.runPromise(Scope.make());
    const session = await Effect.runPromise(
      factory.connect(connection).pipe(Effect.provideService(Scope.Scope, connectionScope)),
    );
    await Effect.runPromise(session.ready);
    await Effect.runPromise(session.initialConfig);
    identity = session;
    await Effect.runPromise(SubscriptionRef.set(prepared, Option.some(connection)));
    await Effect.runPromise(SubscriptionRef.set(active, Option.some(session)));
  };
  const disconnect = async () => {
    identity = null;
    await Effect.runPromise(SubscriptionRef.set(active, Option.none()));
    await Effect.runPromise(Scope.close(connectionScope, Exit.void));
  };
  yield* Effect.addFinalizer(() => Effect.promise(disconnect));
  yield* Effect.promise(() => connect());
  const command = <A, E>(
    effect: Effect.Effect<A, E, EnvironmentSupervisor.EnvironmentSupervisor | Crypto.Crypto>,
  ) =>
    Effect.runPromise(
      provide(effect).pipe(
        Effect.matchCause({
          onFailure: (cause) => ({ _tag: "Failure" as const, cause }),
          onSuccess: (value) => ({ _tag: "Success" as const, value }),
        }),
      ),
    );
  const snapshot = async () => {
    if (!currentDetails) throw new Error("No connected fixture session");
    const details = currentDetails;
    return await Effect.runPromise(
      Effect.gen(function* () {
        const httpClient = yield* HttpClient.HttpClient;
        const api = yield* makeEnvironmentHttpApiGroupClient(
          details.httpBaseUrl,
          "collaboration",
        ).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.mapRequest(
              httpClient,
              HttpClientRequest.setHeader("authorization", `Bearer ${details.token}`),
            ),
          ),
        );
        return yield* api.snapshot({ headers: {} });
      }).pipe(Effect.provide(FetchHttpClient.layer)),
    );
  };
  return {
    ...server,
    identity: () => identity,
    reconnectRetained: () => connect(undefined, "environment-a", true),
    connect,
    connectAs: (subject: string) => connect(undefined, "environment-a", false, subject),
    disconnect,
    snapshot,
    methods,
    catalog: (input: Parameters<typeof Commands.readConfigurationCatalog>[0]) =>
      command(Commands.readConfigurationCatalog(input)),
    configurationStatus: (input: Parameters<typeof Commands.readConfigurationCommandStatus>[0]) =>
      command(Commands.readConfigurationCommandStatus(input)),
    workflowTemplateStatus: (input: Parameters<typeof Commands.writeConfiguration>[0]) =>
      command(request("workflow.templateCommandStatus", input)),
    workflowPreview: (input: typeof WorkflowStagePreviewInput.Type) =>
      command(request("workflow.stagePreview", input)),
    workflowDispatch: (input: typeof WorkflowDispatchStageInput.Type) =>
      command(request("workflow.dispatchStage", input)),
    workflowReconcile: (input: typeof WorkflowReconcileDispatchInput.Type) =>
      command(request("workflow.reconcileDispatch", input)),
    workflowPropose: (input: typeof WorkflowProposeArtifactInput.Type) =>
      command(request("workflow.proposeArtifact", input)),
    workflowRun: (input: typeof WorkflowReadRunInput.Type) =>
      command(request("workflow.readRun", input)),
    workflowAction: (input: Parameters<typeof Commands.writeConfiguration>[0]) =>
      command(request("workflow.action", input)),
    configuration: (input: Parameters<typeof Commands.writeConfiguration>[0]) =>
      command(Commands.writeConfiguration(input)),
    create: (input: Parameters<typeof Commands.createThread>[0]) =>
      command(Commands.createThread(input)),
    interrupt: (input: Parameters<typeof Commands.interruptThreadTurn>[0]) =>
      command(Commands.interruptThreadTurn(input)),
    start: (input: Parameters<typeof Commands.startThreadTurn>[0]) =>
      command(Commands.startThreadTurn(input)),
    projection: (input: Parameters<typeof Commands.readThreadProjection>[0]) =>
      command(Commands.readThreadProjection(input)),
    previewAuto: (input: Parameters<typeof Commands.readTaskAutoPreview>[0]) =>
      command(Commands.readTaskAutoPreview(input)),
    review: (input: Parameters<typeof Commands.readTaskReview>[0]) =>
      command(Commands.readTaskReview(input)),
    creationStatus: (input: Parameters<typeof Commands.readAgentsCreationStatus>[0]) =>
      command(Commands.readAgentsCreationStatus(input)),
    continuationStatus: (input: Parameters<typeof Commands.readTaskResultContinuationStatus>[0]) =>
      command(Commands.readTaskResultContinuationStatus(input)),
    dispatch: (input: OrchestrationV2Command) =>
      command(request("orchestration.dispatchCommand", input)),
    reviewInstructionSkill: (
      input: Parameters<typeof Commands.readTaskInstructionSkillReview>[0],
    ) => command(Commands.readTaskInstructionSkillReview(input)),
    launchStatus: (input: Parameters<typeof Commands.readTaskFirstLaunchStatus>[0]) =>
      command(Commands.readTaskFirstLaunchStatus(input)),
    revokeCurrent: () =>
      currentDetails
        ? server.revoke(currentDetails.sessionId)
        : Promise.reject(new Error("No fixture session")),
    inspect: async () => ({ ...(await server.inspect()), methods: [...methods] }),
  };
});
type ClientFixture = Effect.Success<ReturnType<typeof makeClientFixture>>;
export async function withTaskTransportFixture(check: (f: ClientFixture) => Promise<void>) {
  const module = (await import(
    /* @vite-ignore */ new URL(
      "../../../../../server/src/collaboration/testkit/taskCreationTransportFixture.ts",
      import.meta.url,
    ).href
  )) as {
    withTaskCreationTransportFixture: (check: (f: ServerFixture) => Promise<void>) => Promise<void>;
  };
  await module.withTaskCreationTransportFixture((server) => clientFixture(server, check));
}
