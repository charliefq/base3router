import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ActionGateResult } from "./dispatcher.ts";
import { ProviderDriverKind } from "./providerInstance.ts";

/**
 * Execution runner identity. Distinct from {@link ProviderDriverKind}:
 * `cursor` is the local CLI driver, while `cursor-cloud` is the remote
 * Cloud Agents runner.
 */
export const CLOUD_RUNNER_KIND_CURSOR_CLOUD = "cursor-cloud" as const;
export const CloudRunnerKind = Schema.Literal(CLOUD_RUNNER_KIND_CURSOR_CLOUD);
export type CloudRunnerKind = typeof CloudRunnerKind.Type;

export const CURSOR_CLOUD_CREDENTIAL_ENV_NAME = "CURSOR_API_KEY" as const;

const BoundedModel = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const BoundedCursorId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/),
);
/** Client-supplied Cursor agent id: `bc-` plus a UUID v5. */
export const CursorCloudAgentId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(39),
  Schema.isPattern(/^bc-[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
);
export type CursorCloudAgentId = typeof CursorCloudAgentId.Type;
const BoundedHttpsUrl = TrimmedNonEmptyString.check(
  Schema.isMaxLength(1_024),
  Schema.isPattern(/^https:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[\w.~:/?#@!$&'()*+,;=%[\]-]*)?$/),
);
const BoundedGitHubRepositoryUrl = TrimmedNonEmptyString.check(
  Schema.isMaxLength(512),
  Schema.isPattern(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?\/?$/),
);
const BoundedCommitSha = TrimmedNonEmptyString.check(
  Schema.isMaxLength(40),
  Schema.isPattern(/^[0-9a-f]{40}$/i),
);
const BoundedBranchName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(256),
  Schema.isPattern(/^(?!\/)(?!.*(?:\.\.|\/\/|@\{))[A-Za-z0-9._/-]+(?<!\/)(?<!\.lock)$/),
);
const BoundedEnvironmentName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z][A-Za-z0-9._-]*$/),
);
const BoundedBuildId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9._-]+$/),
);
const BoundedPrompt = TrimmedNonEmptyString.check(Schema.isMaxLength(16_000));
const BoundedSanitizedText = Schema.String.check(Schema.isMaxLength(2_000));

export const CursorCloudCredentialReference = Schema.Struct({
  kind: Schema.Literal("env"),
  name: Schema.Literal(CURSOR_CLOUD_CREDENTIAL_ENV_NAME),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type CursorCloudCredentialReference = typeof CursorCloudCredentialReference.Type;

export const CURSOR_CLOUD_CREDENTIAL_REFERENCE: CursorCloudCredentialReference = {
  kind: "env",
  name: CURSOR_CLOUD_CREDENTIAL_ENV_NAME,
};

export const CursorCloudTargetMode = Schema.Literals(["repository", "named-environment"]);
export type CursorCloudTargetMode = typeof CursorCloudTargetMode.Type;

/**
 * Repository launch target. `expectedEnvironmentName` / `expectedBuildId` may
 * be retained for post-launch verification and must never be sent as `env`.
 */
export const CursorCloudRepositoryTarget = Schema.Struct({
  mode: Schema.Literal("repository"),
  repositoryUrl: BoundedGitHubRepositoryUrl,
  startingRef: BoundedCommitSha,
  expectedEnvironmentName: Schema.optionalKey(BoundedEnvironmentName),
  expectedBuildId: Schema.optionalKey(BoundedBuildId),
});
export type CursorCloudRepositoryTarget = typeof CursorCloudRepositoryTarget.Type;

/** Named Cursor-hosted environment. Mutually exclusive with explicit repos. */
export const CursorCloudNamedEnvironmentTarget = Schema.Struct({
  mode: Schema.Literal("named-environment"),
  environmentName: BoundedEnvironmentName,
});
export type CursorCloudNamedEnvironmentTarget = typeof CursorCloudNamedEnvironmentTarget.Type;

export const CursorCloudExecutionTarget = Schema.Union([
  CursorCloudRepositoryTarget,
  CursorCloudNamedEnvironmentTarget,
]);
export type CursorCloudExecutionTarget = typeof CursorCloudExecutionTarget.Type;

export const CursorCloudAgentStatus = Schema.Literals(["ACTIVE", "IDLE", "ARCHIVED"]);
export type CursorCloudAgentStatus = typeof CursorCloudAgentStatus.Type;

export const CursorCloudRunStatus = Schema.Literals([
  "CREATING",
  "RUNNING",
  "FINISHED",
  "ERROR",
  "CANCELLED",
  "EXPIRED",
]);
export type CursorCloudRunStatus = typeof CursorCloudRunStatus.Type;

export const CLOUD_RUNNER_CANONICAL_STATUSES = [
  "creating",
  "running",
  "idle",
  "finished",
  "error",
  "cancelled",
  "expired",
  "busy",
] as const;
export const CloudRunnerCanonicalStatus = Schema.Literals(CLOUD_RUNNER_CANONICAL_STATUSES);
export type CloudRunnerCanonicalStatus = typeof CloudRunnerCanonicalStatus.Type;

export const CursorCloudGitOutput = Schema.Struct({
  repositoryUrl: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(512))),
  branch: Schema.optionalKey(BoundedBranchName),
  commitSha: Schema.optionalKey(BoundedCommitSha),
  pullRequestUrl: Schema.optionalKey(BoundedHttpsUrl),
});
export type CursorCloudGitOutput = typeof CursorCloudGitOutput.Type;

/**
 * Persisted Cursor Cloud runner binding. Stores identities, sanitized status,
 * and a credential *reference* — never a credential value.
 */
export const CursorCloudRunnerBinding = Schema.Struct({
  provider: ProviderDriverKind,
  model: BoundedModel,
  runnerKind: CloudRunnerKind,
  target: CursorCloudExecutionTarget,
  cursorAgentId: Schema.optionalKey(BoundedCursorId),
  cursorRunId: Schema.optionalKey(BoundedCursorId),
  cursorAgentUrl: Schema.optionalKey(BoundedHttpsUrl),
  cursorAgentStatus: Schema.optionalKey(CursorCloudAgentStatus),
  cursorRunStatus: Schema.optionalKey(CursorCloudRunStatus),
  output: Schema.optionalKey(CursorCloudGitOutput),
  status: CloudRunnerCanonicalStatus,
  sanitizedResult: Schema.optionalKey(BoundedSanitizedText),
  sanitizedError: Schema.optionalKey(BoundedSanitizedText),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  credentialRef: CursorCloudCredentialReference,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type CursorCloudRunnerBinding = typeof CursorCloudRunnerBinding.Type;

export const CursorCloudImmutableDispatchPayload = Schema.Struct({
  runnerKind: CloudRunnerKind,
  provider: ProviderDriverKind,
  model: BoundedModel,
  target: CursorCloudExecutionTarget,
  workOnCurrentBranch: Schema.Literal(false),
  autoCreatePR: Schema.Literal(false),
  credentialRef: CursorCloudCredentialReference,
});
export type CursorCloudImmutableDispatchPayload = typeof CursorCloudImmutableDispatchPayload.Type;

export const CursorCloudDispatchPreview = Schema.Struct({
  available: Schema.Boolean,
  configured: Schema.Boolean,
  target: Schema.NullOr(CursorCloudExecutionTarget),
  payload: Schema.NullOr(CursorCloudImmutableDispatchPayload),
  gate: ActionGateResult,
});
export type CursorCloudDispatchPreview = typeof CursorCloudDispatchPreview.Type;

const CursorCloudPrompt = Schema.Struct({
  text: BoundedPrompt,
});
const CursorCloudModelSelection = Schema.Struct({
  id: BoundedModel,
});
const CursorCloudNamedEnv = Schema.Struct({
  type: Schema.Literal("cloud"),
  name: BoundedEnvironmentName,
});
const CursorCloudRepoEntry = Schema.Struct({
  url: BoundedGitHubRepositoryUrl,
  startingRef: BoundedCommitSha,
});

/**
 * Outbound create-agent request. Repository mode sends `repos` and omits
 * `env`. Named-environment mode sends `env` and omits `repos`. Cursor rejects
 * both in the same request; the filter keeps that invariant at our boundary.
 */
export const CursorCloudCreateRequest = Schema.Struct({
  prompt: CursorCloudPrompt,
  agentId: CursorCloudAgentId,
  /** Cursor model id from GET /v1/models only. Never a dispatcher/Codex/Claude model name. */
  model: Schema.optionalKey(CursorCloudModelSelection),
  name: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(100))),
  env: Schema.optionalKey(CursorCloudNamedEnv),
  repos: Schema.optionalKey(
    Schema.Array(CursorCloudRepoEntry).check(Schema.isMinLength(1), Schema.isMaxLength(1)),
  ),
  workOnCurrentBranch: Schema.Literal(false),
  autoCreatePR: Schema.Literal(false),
}).check(
  Schema.makeFilter(
    (request) => {
      const hasEnv = request.env !== undefined;
      const hasRepos = request.repos !== undefined;
      return hasEnv !== hasRepos;
    },
    { message: "Named cloud environments cannot include explicit repository configuration." },
  ),
);
export type CursorCloudCreateRequest = typeof CursorCloudCreateRequest.Type;

export const CursorCloudFollowUpRequest = Schema.Struct({
  prompt: CursorCloudPrompt,
});
export type CursorCloudFollowUpRequest = typeof CursorCloudFollowUpRequest.Type;

export const WorkflowCursorCloudFollowUpInput = Schema.Struct({
  environmentId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  projectId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  runId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  stageId: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  attempt: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 })),
  commandId: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  prompt: BoundedPrompt,
});
export type WorkflowCursorCloudFollowUpInput = typeof WorkflowCursorCloudFollowUpInput.Type;

export const WorkflowCursorCloudCancelInput = Schema.Struct({
  environmentId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  projectId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  runId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  stageId: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  attempt: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 })),
  commandId: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
});
export type WorkflowCursorCloudCancelInput = typeof WorkflowCursorCloudCancelInput.Type;

export const WorkflowCursorCloudRefreshInput = Schema.Struct({
  environmentId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  projectId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  runId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  stageId: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  attempt: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 })),
});
export type WorkflowCursorCloudRefreshInput = typeof WorkflowCursorCloudRefreshInput.Type;

export const mapCursorRunStatus = (status: CursorCloudRunStatus): CloudRunnerCanonicalStatus => {
  switch (status) {
    case "CREATING":
      return "creating";
    case "RUNNING":
      return "running";
    case "FINISHED":
      return "finished";
    case "ERROR":
      return "error";
    case "CANCELLED":
      return "cancelled";
    case "EXPIRED":
      return "expired";
  }
};

export const mapCursorAgentStatus = (
  status: CursorCloudAgentStatus,
): CloudRunnerCanonicalStatus => {
  switch (status) {
    case "ACTIVE":
      return "running";
    case "IDLE":
      return "idle";
    case "ARCHIVED":
      return "finished";
  }
};

export const isCursorCloudRunActive = (status: CursorCloudRunStatus | undefined): boolean =>
  status === "CREATING" || status === "RUNNING";

export const cursorCloudCreateRequestFromTarget = (input: {
  readonly prompt: string;
  readonly agentId: string;
  readonly cursorModelId?: string;
  readonly name?: string;
  readonly target: CursorCloudExecutionTarget;
}): CursorCloudCreateRequest => {
  const base = {
    prompt: { text: input.prompt },
    agentId: input.agentId,
    workOnCurrentBranch: false as const,
    autoCreatePR: false as const,
    ...(input.cursorModelId === undefined ? {} : { model: { id: input.cursorModelId } }),
    ...(input.name === undefined ? {} : { name: input.name }),
  };
  if (input.target.mode === "repository") {
    return {
      ...base,
      repos: [{ url: input.target.repositoryUrl, startingRef: input.target.startingRef }],
    };
  }
  return {
    ...base,
    env: { type: "cloud", name: input.target.environmentName },
  };
};

const FORBIDDEN_CREDENTIAL_KEYS = new Set([
  "value",
  "token",
  "apiKey",
  "api_key",
  "authorization",
  "CURSOR_API_KEY",
  "secret",
]);

const containsForbiddenCredentialKey = (value: unknown): boolean => {
  if (typeof value !== "object" || value === null) return false;
  if (Array.isArray(value)) return value.some(containsForbiddenCredentialKey);
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_CREDENTIAL_KEYS.has(key)) return true;
    if (containsForbiddenCredentialKey(nested)) return true;
  }
  return false;
};

const CursorCloudRunnerBindingCodec = Schema.Unknown.check(
  Schema.makeFilter((value) => !containsForbiddenCredentialKey(value), {
    message: "A credential value cannot be persisted.",
  }),
).pipe(Schema.decodeTo(CursorCloudRunnerBinding));

export const decodeCursorCloudCreateRequest = Schema.decodeUnknownExit(CursorCloudCreateRequest);
export const decodeCursorCloudExecutionTarget = Schema.decodeUnknownExit(
  CursorCloudExecutionTarget,
);
export const decodeCursorCloudRunnerBinding = Schema.decodeUnknownExit(
  CursorCloudRunnerBindingCodec,
);

export const encodeCursorCloudCreateRequest = Schema.encodeUnknownSync(CursorCloudCreateRequest);

const decodeBindingUnknown = Schema.decodeUnknownOption(CursorCloudRunnerBinding);

/** True when a persisted record contains only the allowed binding keys. */
export const runnerBindingOmitsCredentialValue = (value: unknown): boolean => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (
    "value" in record ||
    "token" in record ||
    "apiKey" in record ||
    "authorization" in record ||
    "CURSOR_API_KEY" in record
  ) {
    return false;
  }
  const ref = record.credentialRef;
  if (typeof ref === "object" && ref !== null) {
    const credential = ref as Record<string, unknown>;
    if (
      "value" in credential ||
      "token" in credential ||
      "apiKey" in credential ||
      "authorization" in credential
    ) {
      return false;
    }
  }
  return decodeBindingUnknown(value)._tag === "Some";
};

export const emptyCursorCloudBinding = (input: {
  readonly provider: ProviderDriverKind;
  readonly model: string;
  readonly target: CursorCloudExecutionTarget;
  readonly at: string;
}): CursorCloudRunnerBinding => ({
  provider: input.provider,
  model: input.model,
  runnerKind: CLOUD_RUNNER_KIND_CURSOR_CLOUD,
  target: input.target,
  status: "creating",
  createdAt: input.at,
  updatedAt: input.at,
  credentialRef: CURSOR_CLOUD_CREDENTIAL_REFERENCE,
});
