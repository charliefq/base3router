import {
  controllerActions,
  type ControllerAction,
  type ControllerKind,
  type ControllerTask,
} from "./client.ts";
export interface ControllerGrant {
  projectIds: readonly string[];
  actions: readonly ControllerAction[];
}
export interface ControllerConnection {
  version: 1;
  controller: ControllerKind;
  callerId: string;
  environmentId: string;
  status: "needs_setup" | "unavailable" | "verified_connected" | "revoked" | "disconnected";
  evidence: "fixture" | "bridge";
  verifiedAt: string | null;
  grant: ControllerGrant;
  tasks: readonly ControllerTask[];
}
/** Administrative bridge binding, separate from controller task tools. Never provision credentials here. */
export interface ControllerManagement {
  read(controller: ControllerKind): Promise<ControllerConnection>;
  revoke(controller: ControllerKind): Promise<void>;
  disconnect(controller: ControllerKind): Promise<void>;
}
export function connectionLabel(connection: ControllerConnection | null): string {
  if (!connection) return "Needs setup";
  if (connection.evidence === "fixture") return "Fixture preview — not live";
  if (connection.status === "verified_connected" && !connection.verifiedAt) return "Needs setup";
  return {
    needs_setup: "Needs setup",
    unavailable: "Unavailable",
    verified_connected: "Verified connected",
    revoked: "Revoked",
    disconnected: "Disconnected",
  }[connection.status];
}
export function onboardingHandoff(controller: ControllerKind, grant: ControllerGrant) {
  return {
    version: 1,
    controller,
    role: "supervisor/controller",
    requestedGrant: grant,
    tools: controllerActions,
    state: "needs_setup",
    prerequisites: [
      "Deploy the governed controller bridge; bind a separately scoped caller identity.",
      "Choose an authenticated endpoint reachable from the controller's computer. A private tailnet or localhost URL is not reachable from Grok Bot cloud.",
      "Configure MCP in Grok Bot with the owner. This draft contains no URL, token, or credentials.",
      "Verify identity, project/action grants, revocation, and one fixture lifecycle before an owner-authorized live run.",
    ],
  };
}
