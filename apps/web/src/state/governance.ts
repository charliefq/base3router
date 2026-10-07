import { createGovernanceEnvironmentAtoms } from "@t3tools/client-runtime/state/governance";

import { connectionAtomRuntime } from "../connection/runtime";

export const governanceEnvironment = createGovernanceEnvironmentAtoms(connectionAtomRuntime);
