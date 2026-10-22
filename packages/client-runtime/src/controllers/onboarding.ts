import { ControllerIdentityView, ControllerStatus } from "@t3tools/contracts";
import { controllerActions, type ControllerAction, type ControllerKind } from "./client.ts";
export interface ControllerGrant {
  projectIds: readonly string[];
  actions: readonly ControllerAction[];
}
export interface ControllerManagement {
  list(): Promise<readonly (typeof ControllerIdentityView.Type)[]>;
  read(controllerId: string): Promise<typeof ControllerStatus.Type>;
  revoke(controllerId: string): Promise<void>;
}
export function connectionLabel(status: typeof ControllerStatus.Type | null): string {
  if (!status) return "Needs setup / status not checked";
  return {
    not_configured: "Needs setup",
    configured: "Configured — live connection untested",
    expired: "Expired — unavailable",
    revoked: "Revoked",
  }[status.configuration];
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
      "Owner separately provisions a scoped identity, then explicitly selects its ID in Connect agent. This draft grants nothing.",
      "Configure the external product's MCP client with its separately provisioned credential and a reachable authenticated /api/controller/v1/mcp endpoint. Never enter a controller bearer in this browser.",
      "Grok Bot cloud cannot assume localhost or private tailnet reachability. Network/credential setup requires separate approval.",
      "Review model selection and the full governed contract before create_task. Retain reviewed text/routing choice for start_task and copy fresh fence/revision/run/attempt guards from get_task.",
      "submit_feedback records an explicit helpful/not_helpful rating using current fingerprint/contextKey; it never delivers a correction prompt or starts another run.",
      "For a new prompt through bridge v1, create a new reviewed task and start its first run. Existing-task revision/continuation is not supported by bridge v1.",
      "Verify an authorized end-to-end lifecycle separately. Registry configuration or recent authenticated traffic alone is not a live connectivity test.",
    ],
  };
}
