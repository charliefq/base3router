import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  PreviewTabId,
  ProviderInstanceId,
  ThreadId,
  defaultConcurrencyBudgetPolicy,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/unstable/ai";

import { ActionGateService, layer as actionGateLayer } from "../actionGate/ActionGateService.ts";
import { PolicyExecutionContext } from "../policy/executionContext.ts";
import {
  ConcurrencyBudgetService,
  layerWithPolicy,
} from "../concurrencyBudget/ConcurrencyBudgetService.ts";
import * as ServerConfig from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { withAllowedMcpTool } from "./McpActionAuthorization.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";

const environmentId = EnvironmentId.make("environment-mcp-ask");
const threadId = ThreadId.make("thread-mcp-ask");

const invocation = {
  environmentId,
  threadId,
  providerSessionId: "provider-session-mcp-ask",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "mcp-ask-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-ask-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const tightMcpPolicy = () => {
  const policy = defaultConcurrencyBudgetPolicy();
  return {
    ...policy,
    classes: {
      ...policy.classes,
      "mcp-action": { maxConcurrent: 1, maxQueue: 2, maxQueueTimeMs: 5_000 },
    },
  };
};

const ProductionAskLayer = McpHttpServer.PreviewToolkitRegistrationLive.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(PreviewAutomationBroker.layer),
  Layer.provideMerge(actionGateLayer.pipe(Layer.provideMerge(SqlitePersistenceMemory))),
  Layer.provideMerge(
    Layer.succeed(PolicyExecutionContext, {
      kind: "session",
      actorId: "user-mcp",
      sessionId: "session-mcp",
      scopes: [AuthOrchestrationOperateScope],
    }),
  ),
  Layer.provideMerge(layerWithPolicy(tightMcpPolicy())),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-production-ask-" })),
  Layer.provideMerge(NodeServices.layer),
);

const governanceCounts = {
  configuredSkillCount: 0,
  enabledSkillCount: 0,
  configuredMcpServerCount: 3,
  enabledMcpServerCount: 3,
  degradedMcpServerCount: 0,
};

const openStatus = {
  available: true,
  visible: true,
  tabId: PreviewTabId.make("tab-mcp-ask"),
  url: "https://example.test/ask",
  title: "Ask",
  loading: false,
};

const waitUntil = <A, E>(
  read: Effect.Effect<A, E>,
  predicate: (value: A) => boolean,
  description: string,
) =>
  Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + 5_000;
    while (true) {
      const value = yield* Effect.orDie(read);
      if (predicate(value)) return value;
      if ((yield* Clock.currentTimeMillis) >= deadline) {
        return yield* Effect.die(new Error(description));
      }
      yield* Effect.sleep("10 millis");
    }
  });

const serveOpen = (clientId: string, executions: Ref.Ref<number>) =>
  Effect.gen(function* () {
    const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
    const connected = yield* Deferred.make<void>();
    const events = yield* broker.connect({ clientId, environmentId });
    yield* Stream.runForEach(events, (event) => {
      if (event.type === "connected") return Deferred.succeed(connected, undefined);
      return Ref.update(executions, (value) => value + 1).pipe(
        Effect.andThen(
          broker.respond({
            clientId,
            connectionId: event.connectionId,
            requestId: event.request.requestId,
            ok: true,
            result: openStatus,
          }),
        ),
      );
    }).pipe(Effect.forkScoped);
    yield* Deferred.await(connected);
  });

const callOpen = (args: Record<string, unknown>) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name: "preview_open", arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  });

const pendingAsk = (service: ActionGateService["Service"]) =>
  waitUntil(
    service.governance(environmentId, governanceCounts),
    (snapshot) => snapshot.pending.some((item) => item.status === "pending"),
    "expected a pending ASK",
  );

const noPendingAsk = (service: ActionGateService["Service"]) =>
  waitUntil(
    service.governance(environmentId, governanceCounts),
    (snapshot) => snapshot.pending.every((item) => item.status !== "pending"),
    "expected no pending ASK",
  );

it.live("MCP ASK grant executes the fake tool once through production ActionGate", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const executions = yield* Ref.make(0);
      yield* serveOpen("mcp-ask-grant", executions);
      const service = yield* ActionGateService;
      const fiber = yield* callOpen({ url: "https://example.test/ask-grant" }).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      const pending = yield* pendingAsk(service);
      const approval = pending.pending.find((item) => item.status === "pending");
      expect(approval?.approvalId).toBeDefined();
      yield* service.respond(
        { approvalId: approval!.approvalId, decision: "grant" },
        approval!.createdAt,
      );
      const result = yield* Fiber.join(fiber);
      expect(result.isError).toBe(false);
      expect(yield* Ref.get(executions)).toBe(1);
    }),
  ).pipe(Effect.provide(ProductionAskLayer)),
);

it.live("MCP ASK deny, cancel, and expiry execute the fake tool zero times", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const executions = yield* Ref.make(0);
      yield* serveOpen("mcp-ask-deny", executions);
      const service = yield* ActionGateService;

      const denyFiber = yield* callOpen({ url: "https://example.test/ask-deny" }).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      const denyPending = yield* pendingAsk(service);
      const denyApproval = denyPending.pending.find((item) => item.status === "pending");
      yield* service.respond(
        { approvalId: denyApproval!.approvalId, decision: "deny" },
        denyApproval!.createdAt,
      );
      const denied = yield* Fiber.join(denyFiber).pipe(Effect.exit);
      expect(Exit.isFailure(denied) || (Exit.isSuccess(denied) && denied.value.isError)).toBe(true);
      yield* noPendingAsk(service);

      const cancelFiber = yield* callOpen({ url: "https://example.test/ask-cancel" }).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      const cancelPending = yield* pendingAsk(service);
      const cancelApproval = cancelPending.pending.find((item) => item.status === "pending");
      yield* service.respond(
        { approvalId: cancelApproval!.approvalId, decision: "cancel" },
        cancelApproval!.createdAt,
      );
      yield* Fiber.join(cancelFiber).pipe(Effect.exit);
      yield* noPendingAsk(service);

      const expireFiber = yield* callOpen({ url: "https://example.test/ask-expire" }).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      const expirePending = yield* pendingAsk(service);
      const expireApproval = expirePending.pending.find((item) => item.status === "pending");
      const expired = yield* service
        .respond(
          { approvalId: expireApproval!.approvalId, decision: "grant" },
          "2099-01-01T00:00:00.000Z",
        )
        .pipe(Effect.exit);
      expect(Exit.isFailure(expired)).toBe(true);
      yield* Fiber.join(expireFiber).pipe(Effect.exit);

      expect(yield* Ref.get(executions)).toBe(0);
    }),
  ).pipe(Effect.provide(ProductionAskLayer)),
);

it.live("revalidates mutated arguments after MCP admission queue delay", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const executions = yield* Ref.make(0);
      const service = yield* ActionGateService;
      const budget = yield* ConcurrencyBudgetService;
      const blocker = yield* Deferred.make<void>();
      const blocking = yield* budget
        .withAdmission(
          {
            workloadClass: "mcp-action",
            environmentId,
            threadId,
            requestedAt: "2026-10-04T00:00:00.000Z",
          },
          Deferred.await(blocker),
        )
        .pipe(Effect.forkChild({ startImmediately: true }));

      const args: { url: string } = { url: "https://example.test/ask-original" };
      const fiber = yield* withAllowedMcpTool(
        "preview_open",
        args,
        Ref.update(executions, (value) => value + 1),
      ).pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.forkChild({ startImmediately: true }),
      );
      const pending = yield* pendingAsk(service);
      const approval = pending.pending.find((item) => item.status === "pending");
      args.url = "https://example.test/ask-mutated";
      yield* service.respond(
        { approvalId: approval!.approvalId, decision: "grant" },
        approval!.createdAt,
      );
      yield* Deferred.succeed(blocker, undefined);
      yield* Fiber.join(blocking);
      const result = yield* Fiber.join(fiber).pipe(Effect.exit);
      expect(Exit.isFailure(result)).toBe(true);
      expect(yield* Ref.get(executions)).toBe(0);
    }),
  ).pipe(Effect.provide(ProductionAskLayer)),
);
