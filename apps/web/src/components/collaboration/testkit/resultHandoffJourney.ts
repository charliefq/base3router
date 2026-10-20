import {
  CommandId,
  MessageId,
  EnvironmentId,
  type TaskFirstLaunch,
  type TaskResultHandoff,
} from "@t3tools/contracts";
import { acceptedResultFacts, resultHandoffReference } from "@t3tools/shared/taskResultHandoff";
import { withTaskTransportFixture } from "./taskCreationTransportFixture";
import { completed, creation } from "./resultContinuationJourney";
type Fixture = Parameters<Parameters<typeof withTaskTransportFixture>[0]>[0];
export function value<A>(
  r: { _tag: "Success"; value: A } | { _tag: "Failure"; cause: unknown },
): A {
  if (r._tag !== "Success") throw new Error(String(r.cause));
  return r.value;
}
export async function acceptedHandoffSource(
  f: Fixture,
  key: string,
  output = "  Complete source output café\n" + "x".repeat(2200) + "\n  ",
) {
  f.setWorkflowOutput(output);
  const c = await completed(f, key);
  const task = (await f.snapshot()).tasks.find((t) => t.threadId === c.threadId)!;
  const input = {
    environmentId: "environment-a",
    taskId: task.id,
    projectId: c.projectId,
    threadId: c.threadId,
    revision: 1,
  };
  const before = value(await f.review(input));
  if (before.status !== "available") throw new Error("Source review missing");
  value(
    await f.dispatch({
      type: "thread.task-contract.accept",
      commandId: CommandId.make(`accept-${key}`),
      threadId: c.threadId,
      revision: 1,
      reviewTask: before.reference,
    }),
  );
  const snapshot = await f.snapshot(),
    projection = value(await f.projection({ threadId: c.threadId })),
    review = value(await f.review(input));
  const facts = acceptedResultFacts(
    snapshot.tasks.find((t) => t.id === task.id)!,
    EnvironmentId.make("environment-a"),
    review,
    projection,
  );
  if (!facts) throw new Error("Accepted attributable source missing");
  return { c, source: resultHandoffReference(facts), projection };
}
export async function handoffDestination(
  f: Fixture,
  source: TaskResultHandoff,
  key: string,
  mode: "manual" | "auto" = "manual",
) {
  const base = creation(key),
    c = { ...base, taskCreationReview: { ...base.taskCreationReview!, resultHandoff: source } };
  value(await f.create(c));
  const task = (await f.snapshot()).tasks.find((t) => t.threadId === c.threadId)!;
  const review = value(
    await f.review({
      environmentId: "environment-a",
      taskId: task.id,
      projectId: c.projectId,
      threadId: c.threadId,
      revision: 1,
    }),
  );
  if (review.status !== "available") throw new Error("Destination review missing");
  const m: TaskFirstLaunch = {
    commandId: CommandId.make(`handoff-${key}`),
    messageId: MessageId.make(`handoff-${key}`),
    threadId: c.threadId,
    reference: review.reference,
    contract: review.contract,
    text: "Write a separately governed article.\n",
    routingMode: mode,
    modelSelection: c.modelSelection,
    runtimeMode: c.runtimeMode,
    interactionMode: c.interactionMode,
    resultHandoff: source,
  };
  return { c, m };
}
