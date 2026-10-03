import {
  MCP_DEFAULT_RETRY_POLICY,
  MCP_DESCRIPTOR_VERSION,
  MCP_METADATA_MAX_CHARS,
  MCP_UNKNOWN_COST,
  McpNamespacedToolId,
  McpServerId,
  type ActionRiskClass,
  type McpServerDescriptorV0,
  type McpServerRuntimeState,
  type McpToolCapability,
  type McpToolDescriptorV0,
  type McpTransportKind,
  type McpTrustState,
  type SideEffectClass,
} from "@t3tools/contracts";

import { digestCanonical } from "./actionCanonical.ts";

export type FirstPartyMcpToolSpec = {
  readonly name: string;
  readonly capability: McpToolCapability;
  readonly riskClass: ActionRiskClass;
  readonly sideEffectClass: SideEffectClass;
  readonly idempotent: boolean;
};

export const FIRST_PARTY_PREVIEW_TOOLS: ReadonlyArray<FirstPartyMcpToolSpec> = [
  {
    name: "preview_status",
    capability: "preview",
    riskClass: "read-only-local",
    sideEffectClass: "read",
    idempotent: true,
  },
  {
    name: "preview_open",
    capability: "preview",
    riskClass: "network-access",
    sideEffectClass: "network",
    idempotent: false,
  },
  {
    name: "preview_navigate",
    capability: "preview",
    riskClass: "network-access",
    sideEffectClass: "network",
    idempotent: false,
  },
  {
    name: "preview_resize",
    capability: "preview",
    riskClass: "local-mutation",
    sideEffectClass: "local-write",
    idempotent: true,
  },
  {
    name: "preview_set_appearance",
    capability: "preview",
    riskClass: "local-mutation",
    sideEffectClass: "local-write",
    idempotent: true,
  },
  {
    name: "preview_snapshot",
    capability: "preview",
    riskClass: "read-only-local",
    sideEffectClass: "read",
    idempotent: true,
  },
  {
    name: "preview_click",
    capability: "preview",
    riskClass: "network-access",
    sideEffectClass: "network",
    idempotent: false,
  },
  {
    name: "preview_type",
    capability: "preview",
    riskClass: "network-access",
    sideEffectClass: "network",
    idempotent: false,
  },
  {
    name: "preview_press",
    capability: "preview",
    riskClass: "network-access",
    sideEffectClass: "network",
    idempotent: false,
  },
  {
    name: "preview_scroll",
    capability: "preview",
    riskClass: "network-access",
    sideEffectClass: "read",
    idempotent: true,
  },
  {
    name: "preview_evaluate",
    capability: "preview",
    riskClass: "destructive",
    sideEffectClass: "network",
    idempotent: false,
  },
  {
    name: "preview_wait_for",
    capability: "preview",
    riskClass: "read-only-local",
    sideEffectClass: "read",
    idempotent: true,
  },
  {
    name: "preview_recording_start",
    capability: "preview",
    riskClass: "local-mutation",
    sideEffectClass: "local-write",
    idempotent: false,
  },
  {
    name: "preview_recording_stop",
    capability: "preview",
    riskClass: "local-mutation",
    sideEffectClass: "local-write",
    idempotent: false,
  },
];

export const FIRST_PARTY_DEVICE_TOOLS: ReadonlyArray<FirstPartyMcpToolSpec> = [
  {
    name: "device_list",
    capability: "device",
    riskClass: "read-only-local",
    sideEffectClass: "read",
    idempotent: true,
  },
  {
    name: "device_open",
    capability: "device",
    riskClass: "local-mutation",
    sideEffectClass: "local-write",
    idempotent: false,
  },
  {
    name: "device_screenshot",
    capability: "device",
    riskClass: "read-only-local",
    sideEffectClass: "read",
    idempotent: true,
  },
  {
    name: "device_close",
    capability: "device",
    riskClass: "local-mutation",
    sideEffectClass: "local-write",
    idempotent: false,
  },
];

export const FIRST_PARTY_PULL_REQUEST_TOOLS: ReadonlyArray<FirstPartyMcpToolSpec> = [
  {
    name: "list_thread_pull_requests",
    capability: "pull-requests",
    riskClass: "read-only-local",
    sideEffectClass: "read",
    idempotent: true,
  },
  {
    name: "link_pull_request",
    capability: "pull-requests",
    riskClass: "local-mutation",
    sideEffectClass: "local-write",
    idempotent: false,
  },
  {
    name: "unlink_pull_request",
    capability: "pull-requests",
    riskClass: "local-mutation",
    sideEffectClass: "local-write",
    idempotent: false,
  },
];

const PROMPT_INJECTION_SHAPED =
  /ignore (all|previous|prior) instructions|system prompt|you are now|exfiltrat|api[_-]?key|authorization:\s*bearer/i;

export const metadataLooksLikePromptInjection = (value: string): boolean =>
  PROMPT_INJECTION_SHAPED.test(value);

export const metadataIsOversized = (value: string): boolean =>
  value.length > MCP_METADATA_MAX_CHARS;

const toolDescriptor = (input: {
  readonly serverId: McpServerId;
  readonly spec: FirstPartyMcpToolSpec;
  readonly promptInjectionShaped?: boolean;
  readonly metadataOversized?: boolean;
}): McpToolDescriptorV0 => ({
  descriptorVersion: MCP_DESCRIPTOR_VERSION,
  toolId: McpNamespacedToolId.make(`${input.serverId}/${input.spec.name}`),
  serverId: input.serverId,
  name: input.spec.name,
  schemaDigest: digestCanonical({
    serverId: input.serverId,
    name: input.spec.name,
    schemaVersion: "t3-first-party.v0",
  }),
  capabilities: [input.spec.capability],
  compatibleModelCapabilities: ["tools"],
  riskClass: input.spec.riskClass,
  sideEffectClass: input.spec.sideEffectClass,
  retryPolicy: MCP_DEFAULT_RETRY_POLICY,
  costAttribution: MCP_UNKNOWN_COST,
  idempotent: input.spec.idempotent,
  metadataOversized: input.metadataOversized === true,
  promptInjectionShaped: input.promptInjectionShaped === true,
});

export const mcpServerDescriptor = (input: {
  readonly serverId: string;
  readonly name: string;
  readonly tools: ReadonlyArray<FirstPartyMcpToolSpec>;
  readonly transportKind?: McpTransportKind;
  readonly trustState?: McpTrustState;
  readonly runtimeState?: McpServerRuntimeState;
  readonly configured?: boolean;
  readonly enabled?: boolean;
  readonly connected?: boolean;
  readonly authRequired?: boolean;
  readonly freshness: string;
  readonly stale?: boolean;
}): McpServerDescriptorV0 => {
  const serverId = McpServerId.make(input.serverId);
  return {
    descriptorVersion: MCP_DESCRIPTOR_VERSION,
    serverId,
    name: input.name,
    transportKind: input.transportKind ?? "http",
    trustState: input.trustState ?? "trusted",
    runtimeState: input.runtimeState ?? "connected",
    configured: input.configured ?? true,
    enabled: input.enabled ?? true,
    connected: input.connected ?? true,
    authRequired: input.authRequired ?? true,
    freshness: input.freshness,
    stale: input.stale === true,
    identityDigest: digestCanonical({ serverId: input.serverId, name: input.name }),
    tools: input.tools.map((spec) => toolDescriptor({ serverId, spec })),
    driver: null,
  };
};

export const firstPartyMcpCatalog = (freshness: string): ReadonlyArray<McpServerDescriptorV0> => [
  mcpServerDescriptor({
    serverId: "t3-preview",
    name: "Preview",
    tools: FIRST_PARTY_PREVIEW_TOOLS,
    freshness,
  }),
  mcpServerDescriptor({
    serverId: "t3-device",
    name: "Device",
    tools: FIRST_PARTY_DEVICE_TOOLS,
    freshness,
  }),
  mcpServerDescriptor({
    serverId: "t3-pull-requests",
    name: "Pull requests",
    tools: FIRST_PARTY_PULL_REQUEST_TOOLS,
    freshness,
  }),
];

export const FIRST_PARTY_MCP_TOOL_NAMES: ReadonlyArray<string> = [
  ...FIRST_PARTY_PREVIEW_TOOLS,
  ...FIRST_PARTY_DEVICE_TOOLS,
  ...FIRST_PARTY_PULL_REQUEST_TOOLS,
].map((tool) => tool.name);

export type FakeMcpToolSpec = FirstPartyMcpToolSpec & {
  readonly description?: string;
};

export const fakeMcpServer = (input: {
  readonly serverId: string;
  readonly name: string;
  readonly tools: ReadonlyArray<FakeMcpToolSpec>;
  readonly freshness: string;
  readonly trustState?: McpTrustState;
  readonly runtimeState?: McpServerRuntimeState;
  readonly transportKind?: McpTransportKind;
  readonly configured?: boolean;
  readonly enabled?: boolean;
  readonly connected?: boolean;
  readonly stale?: boolean;
}): McpServerDescriptorV0 => {
  const server = mcpServerDescriptor({
    serverId: input.serverId,
    name: input.name,
    tools: input.tools,
    transportKind: input.transportKind ?? "in-process",
    trustState: input.trustState ?? "trusted",
    runtimeState: input.runtimeState ?? "connected",
    configured: input.configured,
    enabled: input.enabled,
    connected: input.connected,
    authRequired: false,
    freshness: input.freshness,
    stale: input.stale,
  });
  return {
    ...server,
    tools: server.tools.map((tool, index) => {
      const description = input.tools[index]?.description ?? "";
      return {
        ...tool,
        promptInjectionShaped: metadataLooksLikePromptInjection(description),
        metadataOversized: metadataIsOversized(description),
      };
    }),
  };
};
