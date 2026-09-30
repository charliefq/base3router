import { createDispatcherEnvironmentAtoms } from "@t3tools/client-runtime/state/dispatcher";

import { connectionAtomRuntime } from "../connection/runtime";

export const dispatcherEnvironment = createDispatcherEnvironmentAtoms(connectionAtomRuntime);
