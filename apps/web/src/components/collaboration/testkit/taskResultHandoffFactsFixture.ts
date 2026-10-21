import * as Effect from "effect/Effect";
import { CommandId, type TaskContractReviewReference } from "@t3tools/contracts";
import { withTaskRevisionRequestFixture } from "./taskRevisionRequestFixture";
type Fixture = Parameters<Parameters<typeof withTaskRevisionRequestFixture>[0]>[0];
export const withHandoffFactsFixture = (
  check: (
    f: Fixture & {
      acceptAsync: (reference: TaskContractReviewReference) => Promise<unknown>;
      countsAsync: () => Promise<unknown>;
    },
  ) => Promise<void>,
) =>
  withTaskRevisionRequestFixture((f) =>
    check({
      ...f,
      acceptAsync: (reference) =>
        Effect.runPromise(
          f.dispatch({
            type: "thread.task-contract.accept",
            commandId: CommandId.make("handoff-accept"),
            threadId: f.command.threadId,
            revision: 1,
            reviewTask: reference,
          }),
        ),
      countsAsync: () => Effect.runPromise(f.noExecution()),
    }),
  );
