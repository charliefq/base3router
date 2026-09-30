import type {
  DispatcherHandoffPreviewRequest,
  DispatcherRoutePreviewRequest,
} from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { previewHandoff, previewRoute } from "../operations/dispatcher.ts";
import { createAtomCommandScheduler, createEnvironmentCommand } from "./runtime.ts";

export function createDispatcherEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  return {
    previewRoute: createEnvironmentCommand(runtime, {
      label: "environment-data:dispatcher:route-preview",
      execute: (input: DispatcherRoutePreviewRequest) => previewRoute(input),
      scheduler,
      concurrency: {
        mode: "latest",
        key: ({ environmentId }) => String(environmentId),
      },
    }),
    previewHandoff: createEnvironmentCommand(runtime, {
      label: "environment-data:dispatcher:handoff-preview",
      execute: (input: DispatcherHandoffPreviewRequest) => previewHandoff(input),
      scheduler,
      concurrency: {
        mode: "latest",
        key: ({ environmentId }) => String(environmentId),
      },
    }),
  };
}
