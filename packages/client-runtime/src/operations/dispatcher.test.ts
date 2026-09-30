import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  WS_METHODS,
  type DispatcherRouteDecision,
  type DispatcherRoutePreviewRequest,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { previewRoute } from "./dispatcher.ts";

const environmentId = EnvironmentId.make("environment-1");
const target = new PrimaryConnectionTarget({
  environmentId,
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

it.effect("requests a typed route preview from the selected environment", () =>
  Effect.gen(function* () {
    const requests: DispatcherRoutePreviewRequest[] = [];
    const selected = {
      fallbackIndex: 0,
      target: { instanceId: ProviderInstanceId.make("codex_work"), model: "gpt-5.4" },
      driver: ProviderDriverKind.make("codex"),
      modelFamily: "openai",
      source: "project-default",
      eligible: true,
      reasonCodes: [],
    } as const;
    const decision: DispatcherRouteDecision = {
      policyVersion: "dispatcher.phase-1a.v1",
      environmentId,
      actionKind: "read",
      projectResolution: {
        status: "resolved",
        source: "project-id",
        projectId: ProjectId.make("project-1"),
        reasonCodes: [],
      },
      context: {
        threadId: null,
        messageId: null,
        hasPersistedMessage: false,
        attachmentCount: 0,
        composerContextKinds: [],
      },
      candidates: [selected],
      selected,
      gate: { decision: "ALLOW", reasonCodes: ["ACTION_ALLOWED"] },
    };
    const client = {
      [WS_METHODS.dispatcherRoutePreview]: (input: DispatcherRoutePreviewRequest) =>
        Effect.sync(() => {
          requests.push(input);
          return decision;
        }),
    } as unknown as WsRpcProtocolClient;
    const session: RpcSession = {
      client,
      initialConfig: Effect.never,
      subscribeServerConfig: (input) => client.subscribeServerConfig(input),
      ready: Effect.void,
      probe: Effect.void,
      closed: Effect.never,
    };
    const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
      target,
      state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
      session: yield* SubscriptionRef.make(Option.some(session)),
      prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
      connect: Effect.void,
      disconnect: Effect.void,
      retryNow: Effect.void,
    } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
    const input: DispatcherRoutePreviewRequest = {
      environmentId,
      projectId: ProjectId.make("project-1"),
      actionKind: "read",
    };

    const result = yield* previewRoute(input).pipe(
      Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    );

    expect(requests).toEqual([input]);
    expect(result).toEqual(decision);
  }),
);
