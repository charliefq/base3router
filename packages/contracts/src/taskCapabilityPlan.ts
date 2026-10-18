import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

const Text = TrimmedNonEmptyString.check(Schema.isMaxLength(512));
export const TaskCapabilityPlan = Schema.Struct({
  version: Schema.Literal("task-capability-review.v1"),
  mode: Schema.Literal("review-only"),
  grantsAccess: Schema.Literal(false),
  environmentId: Text,
  projectId: Text,
  providerId: Text,
  model: Text,
  workspace: Schema.NullOr(TrimmedNonEmptyString),
  intentDigest: Text,
  inventoryDigest: Text,
  entries: Schema.Array(
    Schema.Struct({
      id: Text,
      kind: Schema.Literals(["skill", "mcp"]),
      name: Text,
      provenance: Text,
      availability: Schema.Literals(["available", "disabled", "unknown", "setup-required"]),
      selected: Schema.Boolean,
      reason: Text,
    }),
  ).check(Schema.isMaxLength(96)),
  explanation: Text,
});
export type TaskCapabilityPlan = typeof TaskCapabilityPlan.Type;

/** Advisory evidence only: never an instruction reference or permission grant. */
export const TaskCapabilityEvidence = Schema.Struct({
  mode: Schema.Literal("review-only"),
  status: Schema.Literals(["current", "stale", "unknown"]),
  reason: Text,
  reviewed: TaskCapabilityPlan,
});
export type TaskCapabilityEvidence = typeof TaskCapabilityEvidence.Type;
