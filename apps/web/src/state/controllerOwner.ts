import { createControllerOwnerCommand } from "@t3tools/client-runtime/controllers/owner";
import { connectionAtomRuntime } from "../connection/runtime";
export const controllerOwnerCommand = createControllerOwnerCommand(connectionAtomRuntime);
