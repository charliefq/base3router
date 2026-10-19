import { expect } from "vite-plus/test";
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
import { revisionRequestFacts, continuationResult } from "@t3tools/shared/taskRevisionRequest";
import { withTaskTransportFixture } from "./taskCreationTransportFixture";
export const creation = (
  key: string,
): Extract<OrchestrationV2Command, { type: "thread.create" }> => ({
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
type Fixture = Parameters<Parameters<typeof withTaskTransportFixture>[0]>[0];
export const send = (f: Fixture, m: TaskFirstLaunch, continuation?: TaskResultContinuation) =>
  f.start({
    commandId: m.commandId,
    threadId: m.threadId,
    message: { messageId: m.messageId, role: "user", text: m.text, attachments: [] },
    modelSelection: m.modelSelection,
    routingMode: m.routingMode,
    runtimeMode: m.runtimeMode,
    interactionMode: m.interactionMode,
    dispatchMode: "start",
    ...(continuation ? { taskResultContinuation: continuation } : { taskFirstLaunch: m }),
  });
export async function completed(
  f: Fixture,
  key: string,
  text = "First attributable output",
  custom?: ReturnType<typeof creation>,
) {
  const c = custom ?? creation(key);
  expect((await f.create(c))._tag).toBe("Success");
  const task = (await f.snapshot()).tasks.find((t) => t.threadId === c.threadId)!;
  const review = await f.review({
    environmentId: "environment-a",
    projectId: c.projectId,
    threadId: c.threadId,
    taskId: task.id,
    revision: 1,
  });
  if (review._tag !== "Success" || review.value.status !== "available")
    throw new Error("Missing first review");
  const m: TaskFirstLaunch = {
    commandId: CommandId.make(`first-${key}`),
    messageId: MessageId.make(`first-${key}`),
    threadId: c.threadId,
    reference: review.value.reference,
    contract: review.value.contract,
    text,
    routingMode: "manual",
    modelSelection: c.modelSelection,
    runtimeMode: c.runtimeMode,
    interactionMode: c.interactionMode,
  };
  expect((await send(f, m))._tag).toBe("Success");
  await f.settle(m.messageId);
  return c;
}
export async function continuation(
  f: Fixture,
  c: ReturnType<typeof creation>,
  key: string,
  mode: "manual" | "auto" = "manual",
) {
  const task = (await f.snapshot()).tasks.find((t) => t.threadId === c.threadId)!;
  const review = await f.review({
    environmentId: "environment-a",
    projectId: c.projectId,
    threadId: c.threadId,
    taskId: task.id,
    revision: 1,
  });
  const projection = await f.projection({ threadId: c.threadId });
  if (review._tag !== "Success" || projection._tag !== "Success")
    throw new Error("Missing actual review/projection");
  const facts = revisionRequestFacts(
    task,
    EnvironmentId.make("environment-a"),
    review.value,
    projection.value,
  );
  if (!facts)
    throw new Error(
      "Actual completed result could not be validated: " +
        JSON.stringify({ task, review: review.value, projection: projection.value }),
    );
  const m: TaskResultContinuation = {
    commandId: CommandId.make(`continue-${key}`),
    messageId: MessageId.make(`continue-${key}`),
    threadId: c.threadId,
    reference: facts.review.reference,
    contract: facts.review.contract,
    text: "Apply these exact requested changes.",
    routingMode: mode,
    modelSelection: facts.projection.thread.modelSelection,
    runtimeMode: facts.projection.thread.runtimeMode,
    interactionMode: facts.projection.thread.interactionMode,
    priorResult: continuationResult(facts),
  };
  return { m, facts };
}
