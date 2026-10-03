/**
 * Typed MCP server/tool descriptors and MCP Router decisions (Phase 12).
 *
 * First-party T3 toolkits remain the live catalog. This module is the routing
 * contract. Names, descriptions, schemas, and results are untrusted data.
 *
 * @module mcpRouter
 */
import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ActionRiskClass, SideEffectClass } from "./actionGate.ts";
import {
  ModelRouterCapability,
  ModelRouterMetricValue,
  MODEL_ROUTER_UNKNOWN_METRIC,
} from "./modelRouter.ts";
import { ProviderDriverKind } from "./providerInstance.ts";

export const MCP_DESCRIPTOR_VERSION = "mcp-descriptor.v0" as const;
export const MCP_ROUTER_POLICY_VERSION = "mcp-router.v0" as const;
export const MCP_ROUTER_MAX_CANDIDATES = 32;
export const MCP_METADATA_MAX_CHARS = 4_096;

export const McpDescriptorVersion = Schema.Literal(MCP_DESCRIPTOR_VERSION);
export type McpDescriptorVersion = typeof McpDescriptorVersion.Type;

export const McpRouterPolicyVersion = Schema.Literal(MCP_ROUTER_POLICY_VERSION);
export type McpRouterPolicyVersion = typeof McpRouterPolicyVersion.Type;

export const McpServerId = TrimmedNonEmptyString.check(Schema.isMaxLength(128)).pipe(
  Schema.brand("McpServerId"),
);
export type McpServerId = typeof McpServerId.Type;

export const McpNamespacedToolId = TrimmedNonEmptyString.check(Schema.isMaxLength(256)).pipe(
  Schema.brand("McpNamespacedToolId"),
);
export type McpNamespacedToolId = typeof McpNamespacedToolId.Type;

const MCP_TRANSPORTS = ["http", "in-process", "stdio", "unsupported"] as const;
export const McpTransportKind = Schema.Literals(MCP_TRANSPORTS);
export type McpTransportKind = typeof McpTransportKind.Type;

const MCP_TRUST_STATES = ["trusted", "untrusted", "unknown"] as const;
export const McpTrustState = Schema.Literals(MCP_TRUST_STATES);
export type McpTrustState = typeof McpTrustState.Type;

const MCP_SERVER_STATES = ["configured", "enabled", "connected", "degraded", "disabled"] as const;
export const McpServerRuntimeState = Schema.Literals(MCP_SERVER_STATES);
export type McpServerRuntimeState = typeof McpServerRuntimeState.Type;

const MCP_TOOL_CAPABILITIES = [
  "preview",
  "device",
  "pull-requests",
  "filesystem",
  "network",
  "messaging",
  "custom",
] as const;
export const McpToolCapability = Schema.Literals(MCP_TOOL_CAPABILITIES);
export type McpToolCapability = typeof McpToolCapability.Type;

export const MCP_ROUTER_MODES = ["auto", "manual"] as const;
export const McpRouterMode = Schema.Literals(MCP_ROUTER_MODES);
export type McpRouterMode = typeof McpRouterMode.Type;

export const MCP_ROUTER_REASON_CODES = [
  "SELECTED",
  "NO_TOOL_REQUIRED",
  "NO_MCP_CONFIGURED",
  "MANUAL_OVERRIDE",
  "POLICY_TIE_BREAK",
  "METRICS_UNKNOWN",
  "REQUIRED_CAPABILITY_MISSING",
  "NOT_CONFIGURED",
  "DISABLED",
  "NOT_CONNECTED",
  "DEGRADED",
  "FILTERED_UNTRUSTED",
  "FILTERED_TRUST_UNKNOWN",
  "UNSUPPORTED_TRANSPORT",
  "STALE_DISCOVERY",
  "MALFORMED_SCHEMA",
  "OVERSIZED_METADATA",
  "MODEL_SKILL_INCOMPATIBLE",
  "ACTION_GATE_DENY",
  "CONSTRAINT_EXCLUDED",
  "CONSTRAINT_NOT_ALLOWED",
  "INSUFFICIENT_EVIDENCE",
  "PROMPT_INJECTION_SHAPED",
  "DUPLICATE_NAME",
  "NO_ELIGIBLE_CANDIDATES",
] as const;
export const McpRouterReasonCode = Schema.Literals(MCP_ROUTER_REASON_CODES);
export type McpRouterReasonCode = typeof McpRouterReasonCode.Type;

const BoundedName = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const BoundedExplanation = TrimmedNonEmptyString.check(Schema.isMaxLength(512));
const BoundedHash = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
const BoundedIso = TrimmedNonEmptyString.check(Schema.isMaxLength(64));
const BoundedReasonCodes = Schema.Array(McpRouterReasonCode).check(Schema.isMaxLength(16));
const BoundedCapabilities = Schema.Array(McpToolCapability).check(Schema.isMaxLength(8));
const BoundedModelCapabilities = Schema.Array(ModelRouterCapability).check(Schema.isMaxLength(8));
const BoundedServerIds = Schema.Array(McpServerId).check(Schema.isMaxLength(32));
const BoundedToolIds = Schema.Array(McpNamespacedToolId).check(Schema.isMaxLength(32));

export const McpRetryPolicy = Schema.Struct({
  maxAttempts: NonNegativeInt,
  retryUnsafe: Schema.Boolean,
  timeoutMs: NonNegativeInt,
  circuitBreakerThreshold: NonNegativeInt,
  cooldownMs: NonNegativeInt,
});
export type McpRetryPolicy = typeof McpRetryPolicy.Type;

export const MCP_DEFAULT_RETRY_POLICY: McpRetryPolicy = {
  maxAttempts: 2,
  retryUnsafe: false,
  timeoutMs: 15_000,
  circuitBreakerThreshold: 3,
  cooldownMs: 30_000,
};

export const McpToolDescriptorV0 = Schema.Struct({
  descriptorVersion: McpDescriptorVersion,
  toolId: McpNamespacedToolId,
  serverId: McpServerId,
  name: BoundedName,
  schemaDigest: BoundedHash,
  capabilities: BoundedCapabilities,
  compatibleModelCapabilities: BoundedModelCapabilities,
  riskClass: ActionRiskClass,
  sideEffectClass: SideEffectClass,
  retryPolicy: McpRetryPolicy,
  costAttribution: ModelRouterMetricValue,
  idempotent: Schema.Boolean,
  metadataOversized: Schema.Boolean,
  promptInjectionShaped: Schema.Boolean,
});
export type McpToolDescriptorV0 = typeof McpToolDescriptorV0.Type;

export const McpServerDescriptorV0 = Schema.Struct({
  descriptorVersion: McpDescriptorVersion,
  serverId: McpServerId,
  name: BoundedName,
  transportKind: McpTransportKind,
  trustState: McpTrustState,
  runtimeState: McpServerRuntimeState,
  configured: Schema.Boolean,
  enabled: Schema.Boolean,
  connected: Schema.Boolean,
  authRequired: Schema.Boolean,
  freshness: BoundedIso,
  stale: Schema.Boolean,
  identityDigest: BoundedHash,
  tools: Schema.Array(McpToolDescriptorV0).check(Schema.isMaxLength(64)),
  driver: Schema.NullOr(ProviderDriverKind),
});
export type McpServerDescriptorV0 = typeof McpServerDescriptorV0.Type;

export const McpRouterCandidate = Schema.Struct({
  toolId: McpNamespacedToolId,
  serverId: McpServerId,
  name: BoundedName,
  eligible: Schema.Boolean,
  reasonCodes: BoundedReasonCodes,
  trustState: McpTrustState,
  riskClass: ActionRiskClass,
  sideEffectClass: SideEffectClass,
  capabilities: BoundedCapabilities,
  costAttribution: ModelRouterMetricValue,
});
export type McpRouterCandidate = typeof McpRouterCandidate.Type;

export const McpRouterConstraints = Schema.Struct({
  requiredCapabilities: Schema.optional(BoundedCapabilities),
  allowedServerIds: Schema.optional(BoundedServerIds),
  excludedServerIds: Schema.optional(BoundedServerIds),
  allowedToolIds: Schema.optional(BoundedToolIds),
  excludedToolIds: Schema.optional(BoundedToolIds),
  allowUnknownTrust: Schema.optional(Schema.Boolean),
  allowUntrusted: Schema.optional(Schema.Boolean),
});
export type McpRouterConstraints = typeof McpRouterConstraints.Type;

export const McpRouterEvidence = Schema.Struct({
  toolId: McpNamespacedToolId,
  successTrials: NonNegativeInt,
  successCount: NonNegativeInt,
  valid: Schema.Boolean,
});
export type McpRouterEvidence = typeof McpRouterEvidence.Type;

export const McpRouterDecision = Schema.Struct({
  policyVersion: McpRouterPolicyVersion,
  mode: McpRouterMode,
  selected: Schema.NullOr(McpRouterCandidate),
  eligible: Schema.Array(McpRouterCandidate).check(Schema.isMaxLength(MCP_ROUTER_MAX_CANDIDATES)),
  filtered: Schema.Array(McpRouterCandidate).check(Schema.isMaxLength(MCP_ROUTER_MAX_CANDIDATES)),
  candidates: Schema.Array(McpRouterCandidate).check(Schema.isMaxLength(MCP_ROUTER_MAX_CANDIDATES)),
  reasonCodes: BoundedReasonCodes,
  explanation: BoundedExplanation,
  evidenceUsed: Schema.Boolean,
  tieBreak: BoundedExplanation,
  createdAt: BoundedIso,
});
export type McpRouterDecision = typeof McpRouterDecision.Type;

export const MCP_UNKNOWN_COST: ModelRouterMetricValue = MODEL_ROUTER_UNKNOWN_METRIC;
