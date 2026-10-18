import {
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  EnvironmentId,
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
import * as Layer from "effect/Layer";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
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
import { withTaskResultLinkageFixture } from "./taskResultLinkageFixture.ts";
import { agentsCreationProvider } from "./agentsTaskCreationFixture.ts";

class FixtureHttpApi extends HttpApi.make("environment").add(
  EnvironmentHttpApi.groups.collaboration,
) {}
const group = TaskRpcGroup.merge(
  RpcGroup.make(
    ...Array.from(WsRpcGroup.requests.values()).filter(
      (rpc) => rpc._tag === WS_METHODS.subscribeServerConfig || rpc._tag === WS_METHODS.serverProbe,
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
    providers: ReadonlyArray<ServerProvider>;
    connection: (
      scopes?: ReadonlyArray<AuthEnvironmentScope>,
    ) => Promise<{ httpBaseUrl: string; socketUrl: string; token: string; sessionId: string }>;
    revoke: (sessionId: string) => Promise<void>;
    dropNextReply: () => void;
    awaitDroppedReply: () => Promise<void>;
    setEnvironment: (value: string) => void;
    setProviders: (value: ReadonlyArray<ServerProvider>) => void;
    drain: () => Promise<void>;
    inspect: () => Promise<{
      starts: ReadonlyArray<import("@t3tools/contracts").ModelSelection>;
      inputs: ReadonlyArray<string>;
      commands: ReadonlyArray<OrchestrationV2Command>;
      rpcMethods: ReadonlyArray<string>;
    }>;
  }) => Promise<void>,
) {
  await Effect.runPromise(
    Effect.scoped(
      withTaskResultLinkageFixture(
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
              Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
              ServerConfig.layerTest(process.cwd(), { prefix: "b3r-task-transport-" }),
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
                const layer = group.toLayer({
                  ...handlers,
                  [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command) => {
                    commands.push(command);
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
            const http = HttpApiBuilder.layer(FixtureHttpApi).pipe(
              Layer.provide(collaborationHttpApiLayer),
              Layer.provide(environmentAuthenticatedAuthLayer),
              Layer.provide(Layer.succeedContext(context)),
            );
            const server = yield* Layer.build(
              HttpRouter.serve(Layer.merge(ws, http), { disableListenLog: true }).pipe(
                Layer.provideMerge(NodeHttpServer.layerTest),
              ),
            );
            const httpBaseUrl = HttpServer.formatAddress(
              Context.get(server, HttpServer.HttpServer).address,
            );
            const run = Effect.runPromiseWith(context);
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
                connection: async (
                  scopes = [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
                ) => {
                  const issued = await run(auth.issueSession({ subject: "fixture-owner", scopes }));
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
                inspect: () =>
                  Effect.runPromise(
                    Effect.gen(function* () {
                      return {
                        starts: yield* Ref.get(f.started),
                        inputs: (yield* Ref.get(f.executions)).map((e) => e.message.text),
                        commands: [...commands],
                        rpcMethods: [...rpcMethods],
                      };
                    }),
                  ),
              }),
            );
          }),
        {
          governedWorker: true,
          useProjectRuntimePolicy: true,
          onStart: (input, events, emit) =>
            Effect.forEach(
              events,
              (e) =>
                emit(
                  e.type === "turn_item.updated" && e.turnItem.type === "assistant_message"
                    ? {
                        ...e,
                        turnItem: {
                          ...e.turnItem,
                          text: `Transport answer: ${input.message.text}`,
                        },
                      }
                    : e,
                ),
              { discard: true },
            ),
        },
      ),
    ),
  );
}
import { AuthSessionId as SessionId } from "@t3tools/contracts";
const importSessionId = (s: string) => SessionId.make(s);
