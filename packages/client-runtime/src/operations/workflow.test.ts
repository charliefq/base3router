import { EnvironmentId, ProjectId, WS_METHODS, type WorkflowCatalog } from "@t3tools/contracts";
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
import { catalog, cursorCloudFollowUp, readRun } from "./workflow.ts";

const environmentId = EnvironmentId.make("environment-1");
const projectId = ProjectId.make("project-1");
const target = new PrimaryConnectionTarget({
  environmentId,
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

it.effect("reads server-owned workflow state through typed runtime operations", () =>
  Effect.gen(function* () {
    const observed: string[] = [];
    const state: WorkflowCatalog = { profiles: [], templates: [], runs: [] };
    const client = {
      [WS_METHODS.workflowCatalog]: (input: { projectId: ProjectId }) =>
        Effect.sync(() => {
          observed.push(`catalog:${input.projectId}`);
          return state;
        }),
      [WS_METHODS.workflowReadRun]: (input: { projectId: ProjectId; runId: string }) =>
        Effect.sync(() => {
          observed.push(`run:${input.projectId}:${input.runId}`);
          return null;
        }),
      [WS_METHODS.workflowCursorCloudFollowUp]: (input: { runId: string; prompt: string }) =>
        Effect.sync(() => {
          observed.push(`follow-up:${input.runId}:${input.prompt}`);
          return { run: { id: input.runId }, runnerBinding: { runnerKind: "cursor-cloud" } };
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
    expect(
      yield* catalog({ projectId }).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      ),
    ).toEqual(state);
    expect(
      yield* readRun({ projectId, runId: "run-1" }).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      ),
    ).toBeNull();
    expect(
      yield* cursorCloudFollowUp({
        environmentId,
        projectId,
        runId: "run-1",
        stageId: "research",
        attempt: 1,
        commandId: "cmd-1",
        prompt: "Continue",
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor)),
    ).toEqual({ run: { id: "run-1" }, runnerBinding: { runnerKind: "cursor-cloud" } });
    expect(observed).toEqual([
      "catalog:project-1",
      "run:project-1:run-1",
      "follow-up:run-1:Continue",
    ]);
  }),
);
