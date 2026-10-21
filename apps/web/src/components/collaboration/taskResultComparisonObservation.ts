import { createRuntimeCommand } from "@t3tools/client-runtime/state/runtime";
import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { connectionAtomRuntime } from "../../connection/runtime";
import {
  observeTaskResultComparison,
  type ComparisonObservationInput,
} from "./observeTaskResultComparison";

export const taskResultComparisonObservation = createRuntimeCommand(connectionAtomRuntime, {
  label: "task-result-comparison:observe",
  execute: (input: ComparisonObservationInput & { environmentId: EnvironmentId }) =>
    Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      yield* registry.run(input.environmentId, observeTaskResultComparison(input));
    }),
});
