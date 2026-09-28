import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type DispatcherTaskRouteBinding,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "../orchestration/decider.ts";
import { createEmptyReadModel, projectEvent } from "../orchestration/projector.ts";
import { BUILTIN_WORKFLOW_TEMPLATES } from "./Builtins.ts";
import { initialWorkflowRun } from "./Policy.ts";

const at = "2026-09-28T00:00:00.000Z";
const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("workflow-thread-1");
const messageId = MessageId.make("workflow-message-1");
const route: DispatcherTaskRouteBinding = {
  policyVersion: "dispatcher.phase-1a.v1",
  target: { instanceId: ProviderInstanceId.make("codex-work"), model: "gpt-5.4" },
  driver: ProviderDriverKind.make("codex"),
  modelFamily: "openai",
  fallbackIndex: 0,
  source: "explicit",
  gate: { decision: "ALLOW", reasonCodes: ["ACTION_ALLOWED"] },
};
const workflowStage = {
  type: "stage.dispatch" as const,
  runId: "run-1",
  stageId: "discovery",
  attempt: 1,
  threadId,
  messageId,
  routeBinding: route,
  at,
};
const baseModel = Effect.gen(function* () {
  const project = yield* projectEvent(createEmptyReadModel(at), {
    sequence: 1,
    eventId: EventId.make("project-event"),
    aggregateKind: "project",
    aggregateId: projectId,
    type: "project.created",
    occurredAt: at,
    commandId: CommandId.make("project-command"),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: {
      projectId,
      title: "Project",
      workspaceRoot: "/tmp/disposable-project",
      defaultModelSelection: null,
      scripts: [],
      createdAt: at,
      updatedAt: at,
    },
  });
  const thread = yield* projectEvent(project, {
    sequence: 2,
    eventId: EventId.make("thread-event"),
    aggregateKind: "thread",
    aggregateId: threadId,
    type: "thread.created",
    occurredAt: at,
    commandId: CommandId.make("thread-command"),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: {
      threadId,
      projectId,
      title: "Workflow task",
      modelSelection: route.target,
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: at,
      updatedAt: at,
    },
  });
  return yield* projectEvent(thread, {
    sequence: 3,
    eventId: EventId.make("workflow-event"),
    aggregateKind: "project",
    aggregateId: projectId,
    type: "workflow.recorded",
    occurredAt: at,
    commandId: CommandId.make("workflow-command"),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: {
      projectId,
      mutation: {
        type: "run.start",
        run: initialWorkflowRun({
          runId: "run-1",
          projectId,
          template: BUILTIN_WORKFLOW_TEMPLATES[0]!,
          originThreadId: null,
          originMessageId: null,
          at,
        }),
      },
    },
  });
});

const turnCommand = {
  type: "thread.turn.start" as const,
  commandId: CommandId.make("workflow-turn-1"),
  threadId,
  message: { messageId, role: "user" as const, text: "Do discovery", attachments: [] },
  modelSelection: route.target,
  runtimeMode: "approval-required" as const,
  interactionMode: "default" as const,
  routeBinding: route,
  workflowStage,
  createdAt: at,
};

it.layer(NodeServices.layer)("workflow execution binding", (it) => {
  it.effect("commits stage linkage in the same turn-start event batch as immutable route", () =>
    Effect.gen(function* () {
      const readModel = yield* baseModel;
      const planned = yield* decideOrchestrationCommand({ command: turnCommand, readModel });
      const events = Array.isArray(planned) ? planned : [planned];
      expect(events.map((event) => event.type)).toEqual([
        "workflow.recorded",
        "thread.message-sent",
        "thread.turn-start-requested",
      ]);
      expect(events[0]?.payload).toMatchObject({ projectId, mutation: workflowStage });
      const first = yield* projectEvent(readModel, { ...events[0]!, sequence: 4 });
      expect(first.workflow?.runs[0]?.attempts[0]?.routeBinding).toEqual(route);
      const error = yield* Effect.flip(
        decideOrchestrationCommand({ command: turnCommand, readModel: first }),
      );
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("rejects a route mismatch without emitting provider work", () =>
    Effect.gen(function* () {
      const readModel = yield* baseModel;
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            ...turnCommand,
            workflowStage: {
              ...workflowStage,
              routeBinding: {
                ...route,
                target: { instanceId: ProviderInstanceId.make("claude-work"), model: "sonnet" },
              },
            },
          },
          readModel,
        }),
      );
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );
});
