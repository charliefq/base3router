import { expect, it } from "vite-plus/test";
import {
  CommandId,
  ThreadId,
  ProjectId,
  ProviderInstanceId,
  EnvironmentId,
  MessageId,
  type OrchestrationV2Command,
  type TaskFirstLaunch,
  type TaskResultContinuation,
} from "@t3tools/contracts";
import { withTaskTransportFixture } from "./testkit/taskCreationTransportFixture";
const creation = (key: string): Extract<OrchestrationV2Command, { type: "thread.create" }> => ({
  type: "thread.create",
  commandId: CommandId.make(`create-${key}`),
  threadId: ThreadId.make(`transport-${key}`),
  projectId: ProjectId.make("project-a"),
  title: `Transport ${key}`,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "exact-second" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  createdBy: "user",
  creationSource: "web",
  taskGovernance: "required",
  taskContract: {
    goal: "Prove transport",
    redirect: "Keep fixture scope",
    acceptance: "Owner reads actual linked output",
    brake: { maxProviderStarts: 3, stopConditions: "Scope changed" },
  },
  taskCreationReview: {
    environmentId: EnvironmentId.make("environment-a"),
    projectId: ProjectId.make("project-a"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "exact-second" },
  },
});
it.each(["forged digest", "missing prior result"])(
  "result-bound Start denies %s without downgrading to ordinary Send",
  async (kind) => {
    await withTaskTransportFixture(async (f) => {
      const c = creation(kind);
      expect((await f.create(c))._tag).toBe("Success");
      const task = (await f.snapshot()).tasks.find((t) => t.threadId === c.threadId)!;
      const first = await f.review({
        environmentId: "environment-a",
        taskId: task.id,
        projectId: c.projectId,
        threadId: c.threadId,
        revision: 1,
      });
      if (first._tag !== "Success" || first.value.status !== "available")
        throw new Error("No first review");
      const m: TaskFirstLaunch = {
        commandId: CommandId.make("first"),
        messageId: MessageId.make("first"),
        threadId: c.threadId,
        reference: first.value.reference,
        contract: first.value.contract,
        text: "First completed output",
        routingMode: "manual",
        modelSelection: c.modelSelection,
        runtimeMode: c.runtimeMode,
        interactionMode: c.interactionMode,
      };
      const start = (marker: TaskFirstLaunch, continuation?: TaskResultContinuation) =>
        f.start({
          commandId: marker.commandId,
          threadId: c.threadId,
          message: {
            messageId: marker.messageId,
            role: "user",
            text: marker.text,
            attachments: [],
          },
          modelSelection: marker.modelSelection,
          routingMode: marker.routingMode,
          runtimeMode: marker.runtimeMode,
          interactionMode: marker.interactionMode,
          dispatchMode: "start",
          ...(continuation
            ? { taskResultContinuation: continuation }
            : { taskFirstLaunch: marker }),
        });
      expect((await start(m))._tag).toBe("Success");
      await f.drain();
      const review = await f.review({
        environmentId: "environment-a",
        taskId: task.id,
        projectId: c.projectId,
        threadId: c.threadId,
        revision: 1,
      });
      const projection = await f.projection({ threadId: c.threadId });
      if (
        review._tag !== "Success" ||
        review.value.status !== "available" ||
        projection._tag !== "Success"
      )
        throw new Error("No completed facts");
      const run = projection.value.runs[0]!;
      const item = projection.value.turnItems.find((i) => i.type === "assistant_message")!;
      const attempt = projection.value.attempts.find((a) => a.id === run.activeAttemptId)!;
      const next: TaskResultContinuation = {
        ...m,
        commandId: CommandId.make("next"),
        messageId: MessageId.make("next"),
        reference: review.value.reference,
        text: "Requested changes",
        priorResult: {
          runId: kind === "missing prior result" ? "missing" : run.id,
          messageId: run.userMessageId!,
          attemptId: attempt.id,
          providerThreadId: run.providerThreadId!,
          providerTurnId: attempt.providerTurnId!,
          itemId: item.id,
          rootNodeId: run.rootNodeId!,
          nodeId: item.nodeId!,
          outputSha256: "0".repeat(64),
        },
      };
      expect((await start(next, next))._tag).toBe("Failure");
      expect((await f.inspect()).starts).toHaveLength(1);
      expect((await f.snapshot()).tasks).toHaveLength(1);
    });
  },
  30000,
);
