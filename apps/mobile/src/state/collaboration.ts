import { createCollaborationEnvironmentAtoms } from "@t3tools/client-runtime/state/collaboration";
import { connectionAtomRuntime } from "../connection/runtime";

export const collaborationEnvironment = createCollaborationEnvironmentAtoms(connectionAtomRuntime);
