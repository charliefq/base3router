/**
 * Read model for Base3Router governance on Orchestrator V2.
 * Payloads, prompts, and memory content stay out of this projection.
 */
import * as Schema from "effect/Schema";

export class GovernanceReadError extends Schema.TaggedError<GovernanceReadError>()(
  "GovernanceReadError",
  {
    message: Schema.String,
  },
) {}

const GOVERNANCE_ROUTE_MODES = ["auto", "manual", "unknown"] as const;

export const GovernanceRouteProjection = Schema.Struct({
  threadId: Schema.String,
  messageId: Schema.String,
  mode: Schema.Literals(GOVERNANCE_ROUTE_MODES),
  model: Schema.NullOr(Schema.String),
  instanceId: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});
export type GovernanceRouteProjection = typeof GovernanceRouteProjection.Type;

export const GovernanceLeaseProjection = Schema.Struct({
  leaseId: Schema.String,
  threadId: Schema.String,
  messageId: Schema.NullOr(Schema.String),
  runId: Schema.NullOr(Schema.String),
  workloadClass: Schema.String,
  status: Schema.String,
  interruptRequested: Schema.Boolean,
  disconnectUnconfirmed: Schema.Boolean,
  runStatus: Schema.NullOr(Schema.String),
  occupied: Schema.Boolean,
});
export type GovernanceLeaseProjection = typeof GovernanceLeaseProjection.Type;

export const GovernanceApprovalProjection = Schema.Struct({
  approvalId: Schema.String,
  status: Schema.String,
  consumedAt: Schema.NullOr(Schema.String),
});
export type GovernanceApprovalProjection = typeof GovernanceApprovalProjection.Type;

export const GovernanceMemoryProjection = Schema.Struct({
  memoryId: Schema.String,
  status: Schema.String,
  scopeKind: Schema.String,
  contentPresent: Schema.Boolean,
});
export type GovernanceMemoryProjection = typeof GovernanceMemoryProjection.Type;

export const GovernanceSnapshot = Schema.Struct({
  protocolVersion: Schema.Number,
  threadId: Schema.optional(Schema.String),
  routes: Schema.Array(GovernanceRouteProjection),
  leases: Schema.Array(GovernanceLeaseProjection),
  approvals: Schema.Array(GovernanceApprovalProjection),
  memories: Schema.Array(GovernanceMemoryProjection),
  deletedSourceCount: Schema.Number,
});
export type GovernanceSnapshot = typeof GovernanceSnapshot.Type;

export const GovernanceSnapshotInput = Schema.Struct({
  threadId: Schema.optional(Schema.String),
});
export type GovernanceSnapshotInput = typeof GovernanceSnapshotInput.Type;
