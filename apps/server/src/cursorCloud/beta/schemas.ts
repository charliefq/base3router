import * as Schema from "effect/Schema";

/**
 * Isolated Cursor Cloud Agents API v1 (public beta) wire shapes.
 * Keep these here so API drift stays at the adapter boundary.
 */
const BoundedId = Schema.String.check(Schema.isMaxLength(128));
const BoundedText = Schema.String.check(Schema.isMaxLength(16_000));
const BoundedUrl = Schema.String.check(Schema.isMaxLength(1_024));
const BoundedTime = Schema.String.check(Schema.isMaxLength(64));

export const CursorCloudBetaAgentStatus = Schema.Literals(["ACTIVE", "IDLE", "ARCHIVED"]);
export const CursorCloudBetaRunStatus = Schema.Literals([
  "CREATING",
  "RUNNING",
  "FINISHED",
  "ERROR",
  "CANCELLED",
  "EXPIRED",
]);

export type CursorCloudBetaAgentStatus = typeof CursorCloudBetaAgentStatus.Type;
export type CursorCloudBetaRunStatus = typeof CursorCloudBetaRunStatus.Type;

export const CursorCloudBetaMe = Schema.Struct({
  apiKeyName: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
  createdAt: Schema.optionalKey(BoundedTime),
  userId: Schema.optionalKey(Schema.Number),
});

export const CursorCloudBetaModel = Schema.Struct({
  id: Schema.String.check(Schema.isMaxLength(256)),
  displayName: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
});

export const CursorCloudBetaModels = Schema.Struct({
  items: Schema.Array(CursorCloudBetaModel).check(Schema.isMaxLength(200)),
});

export const CursorCloudBetaGitBranch = Schema.Struct({
  repoUrl: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(512))),
  branch: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
  prUrl: Schema.optionalKey(BoundedUrl),
});

export const CursorCloudBetaGit = Schema.Struct({
  branches: Schema.optionalKey(
    Schema.Array(CursorCloudBetaGitBranch).check(Schema.isMaxLength(20)),
  ),
});

export const CursorCloudBetaAgent = Schema.Struct({
  id: BoundedId,
  name: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  status: CursorCloudBetaAgentStatus,
  url: Schema.optionalKey(BoundedUrl),
  createdAt: Schema.optionalKey(BoundedTime),
  updatedAt: Schema.optionalKey(BoundedTime),
  latestRunId: Schema.optionalKey(BoundedId),
});

export const CursorCloudBetaRun = Schema.Struct({
  id: BoundedId,
  agentId: BoundedId,
  status: CursorCloudBetaRunStatus,
  createdAt: Schema.optionalKey(BoundedTime),
  updatedAt: Schema.optionalKey(BoundedTime),
  durationMs: Schema.optionalKey(Schema.Number),
  result: Schema.optionalKey(BoundedText),
  git: Schema.optionalKey(CursorCloudBetaGit),
});

export const CursorCloudBetaCreateAgentResponse = Schema.Struct({
  agent: CursorCloudBetaAgent,
  run: CursorCloudBetaRun,
});

export const CursorCloudBetaCreateRunResponse = Schema.Struct({
  run: CursorCloudBetaRun,
});

export const CursorCloudBetaCancelResponse = Schema.Struct({
  id: BoundedId,
});

export const CursorCloudBetaRunList = Schema.Struct({
  items: Schema.Array(CursorCloudBetaRun).check(Schema.isMaxLength(100)),
  nextCursor: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
});

export const CursorCloudBetaErrorBody = Schema.Struct({
  error: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
  message: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1_024))),
  code: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(128))),
});

export type CursorCloudBetaMe = typeof CursorCloudBetaMe.Type;
export type CursorCloudBetaModel = typeof CursorCloudBetaModel.Type;
export type CursorCloudBetaAgent = typeof CursorCloudBetaAgent.Type;
export type CursorCloudBetaRun = typeof CursorCloudBetaRun.Type;

export const decodeBetaMe = Schema.decodeUnknownExit(CursorCloudBetaMe);
export const decodeBetaModels = Schema.decodeUnknownExit(CursorCloudBetaModels);
export const decodeBetaAgent = Schema.decodeUnknownExit(CursorCloudBetaAgent);
export const decodeBetaRun = Schema.decodeUnknownExit(CursorCloudBetaRun);
export const decodeBetaCreateAgent = Schema.decodeUnknownExit(CursorCloudBetaCreateAgentResponse);
export const decodeBetaCreateRun = Schema.decodeUnknownExit(CursorCloudBetaCreateRunResponse);
export const decodeBetaCancel = Schema.decodeUnknownExit(CursorCloudBetaCancelResponse);
export const decodeBetaRunList = Schema.decodeUnknownExit(CursorCloudBetaRunList);
export const decodeBetaError = Schema.decodeUnknownExit(CursorCloudBetaErrorBody);
