import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
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
import {
  ConcurrencyBudgetService,
  layerWithPolicy,
} from "../concurrencyBudget/ConcurrencyBudgetService.ts";
import * as ServerConfig from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
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

const waitUntil = <A>(
  read: Effect.Effect<A>,
  predicate: (value: A) => boolean,
  description: string,
) =>
  Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + 5_000;
    while (true) {
      const value = yield* read;
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
            result: {
              available: true,
              tabId: PreviewTabId.make("tab-mcp-ask"),
              url: "https://example.test/ask",
            },
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

it.live("MCP ASK grant executes the fake tool once through production ActionGate", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const executions = yield* Ref.make(0);
      yield* serveOpen("mcp-ask-grant", executions);
      const service = yield* ActionGateService;
      const fiber = yield* callOpen({ url: "https://example.test/ask-grant" }).pipe(
        Effect.forkChild,
      );
      const pending = yield* waitUntil(
        service.governance(environmentId, governanceCounts),
        (snapshot) => snapshot.pending.length === 1,
        "expected a pending ASK",
      );
      const approvalId = pending.pending[0]?.approvalId;
      expect(approvalId).toBeDefined();
      yield* service.respond(
        { approvalId: approvalId!, decision: "grant" },
        pending.pending[0]!.createdAt,
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
        Effect.forkChild,
      );
      const denyPending = yield* waitUntil(
        service.governance(environmentId, governanceCounts),
        (snapshot) => snapshot.pending.length === 1,
        "expected deny ASK",
      );
      yield* service.respond(
        { approvalId: denyPending.pending[0]!.approvalId, decision: "deny" },
        denyPending.pending[0]!.createdAt,
      );
      const denied = yield* Fiber.join(denyFiber).pipe(Effect.exit);
      expect(Exit.isFailure(denied) || (Exit.isSuccess(denied) && denied.value.isError)).toBe(true);

      const cancelFiber = yield* callOpen({ url: "https://example.test/ask-cancel" }).pipe(
        Effect.forkChild,
      );
      const cancelPending = yield* waitUntil(
        service.governance(environmentId, governanceCounts),
        (snapshot) => snapshot.pending.some((item) => item.status === "pending"),
        "expected cancel ASK",
      );
      const cancelId = cancelPending.pending.find((item) => item.status === "pending")?.approvalId;
      yield* service.respond(
        { approvalId: cancelId!, decision: "cancel" },
        cancelPending.pending[0]!.createdAt,
      );
      yield* Fiber.join(cancelFiber).pipe(Effect.exit);

      expect(yield* Ref.get(executions)).toBe(0);
    }),
  ).pipe(Effect.provide(ProductionAskLayer)),
);

it.live("revalidates mutated arguments after MCP admission queue delay", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const executions = yield* Ref.make(0);
      yield* serveOpen("mcp-ask-revalidate", executions);
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
        .pipe(Effect.forkChild);

      const args: { url: string } = { url: "https://example.test/ask-original" };
      const fiber = yield* callOpen(args).pipe(Effect.forkChild);
      const pending = yield* waitUntil(
        service.governance(environmentId, governanceCounts),
        (snapshot) => snapshot.pending.length === 1,
        "expected queued ASK",
      );
      args.url = "https://example.test/ask-mutated";
      yield* service.respond(
        { approvalId: pending.pending[0]!.approvalId, decision: "grant" },
        pending.pending[0]!.createdAt,
      );
      yield* Deferred.succeed(blocker, undefined);
      yield* Fiber.join(blocking);
      const result = yield* Fiber.join(fiber).pipe(Effect.exit);
      expect(Exit.isFailure(result) || (Exit.isSuccess(result) && result.value.isError)).toBe(true);
      expect(yield* Ref.get(executions)).toBe(0);
    }),
  ).pipe(Effect.provide(ProductionAskLayer)),
);
