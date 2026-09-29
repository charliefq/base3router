import {
  decodeCursorCloudExecutionTarget,
  isCursorCloudRunActive,
  type CursorCloudDispatchPreview,
  type CursorCloudExecutionTarget,
  type CursorCloudImmutableDispatchPayload,
  type CursorCloudRunnerBinding,
} from "@t3tools/contracts";

export type CursorCloudTargetDraft = {
  mode: "repository" | "named-environment";
  repositoryUrl: string;
  startingRef: string;
  environmentName: string;
};

export const emptyCursorCloudTargetDraft = (): CursorCloudTargetDraft => ({
  mode: "repository",
  repositoryUrl: "",
  startingRef: "",
  environmentName: "",
});

export const parseCursorCloudTarget = (
  draft: CursorCloudTargetDraft,
): CursorCloudExecutionTarget | null => {
  const encoded =
    draft.mode === "repository"
      ? {
          mode: "repository" as const,
          repositoryUrl: draft.repositoryUrl.trim(),
          startingRef: draft.startingRef.trim().toLowerCase(),
        }
      : {
          mode: "named-environment" as const,
          environmentName: draft.environmentName.trim(),
        };
  const decoded = decodeCursorCloudExecutionTarget(encoded);
  return decoded._tag === "Success" ? decoded.value : null;
};

export const cursorCloudDispatchAllowed = (
  preview: CursorCloudDispatchPreview | undefined,
): boolean =>
  preview !== undefined && preview.payload !== null && preview.gate.decision === "ALLOW";

export const cursorCloudFollowUpDisabled = (
  binding: CursorCloudRunnerBinding | undefined,
): boolean => binding === undefined || isCursorCloudRunActive(binding.cursorRunStatus);

export const cursorCloudCancelDisabled = (binding: CursorCloudRunnerBinding | undefined): boolean =>
  binding === undefined || binding.cursorRunId === undefined;

export type CursorCloudTargetPresentation = {
  readonly runner: "Cursor Cloud";
  readonly repository: string | null;
  readonly startingRef: string | null;
  readonly expectedEnvironment: string | null;
  readonly expectedBuild: string | null;
  readonly environmentName: string | null;
};

export const presentCursorCloudTarget = (
  target: CursorCloudExecutionTarget,
): CursorCloudTargetPresentation =>
  target.mode === "repository"
    ? {
        runner: "Cursor Cloud",
        repository: target.repositoryUrl,
        startingRef: target.startingRef,
        expectedEnvironment: target.expectedEnvironmentName ?? null,
        expectedBuild: target.expectedBuildId ?? null,
        environmentName: null,
      }
    : {
        runner: "Cursor Cloud",
        repository: null,
        startingRef: null,
        expectedEnvironment: null,
        expectedBuild: null,
        environmentName: target.environmentName,
      };

export type CursorCloudPayloadPresentation = CursorCloudTargetPresentation & {
  readonly provider: string;
  readonly model: string;
  readonly workOnCurrentBranch: false;
  readonly autoCreatePR: false;
  readonly credentialReference: "env";
};

export const presentCursorCloudPayload = (
  payload: CursorCloudImmutableDispatchPayload,
): CursorCloudPayloadPresentation => ({
  ...presentCursorCloudTarget(payload.target),
  provider: payload.provider,
  model: payload.model,
  workOnCurrentBranch: false,
  autoCreatePR: false,
  credentialReference: "env",
});

export type CursorCloudBindingPresentation = CursorCloudPayloadPresentation & {
  readonly agentId: string | null;
  readonly runId: string | null;
  readonly status: CursorCloudRunnerBinding["status"];
  readonly agentUrl: string | null;
  readonly outputBranch: string | null;
  readonly outputCommit: string | null;
  readonly pullRequestUrl: string | null;
  readonly result: string | null;
  readonly error: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export const presentCursorCloudBinding = (
  binding: CursorCloudRunnerBinding,
): CursorCloudBindingPresentation => ({
  ...presentCursorCloudPayload({
    runnerKind: binding.runnerKind,
    provider: binding.provider,
    model: binding.model,
    target: binding.target,
    workOnCurrentBranch: false,
    autoCreatePR: false,
    credentialRef: binding.credentialRef,
  }),
  agentId: binding.cursorAgentId ?? null,
  runId: binding.cursorRunId ?? null,
  status: binding.status,
  agentUrl: binding.cursorAgentUrl ?? null,
  outputBranch: binding.output?.branch ?? null,
  outputCommit: binding.output?.commitSha ?? null,
  pullRequestUrl: binding.output?.pullRequestUrl ?? null,
  result: binding.sanitizedResult ?? null,
  error: binding.sanitizedError ?? null,
  createdAt: binding.createdAt,
  updatedAt: binding.updatedAt,
});

const SECRET_SHAPED = /Bearer\s+\S+|crsr[_-][A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]+|CURSOR_API_KEY\s*=/i;

export const textOmitsCursorSecrets = (value: string): boolean => !SECRET_SHAPED.test(value);

export const valueOmitsCursorSecrets = (value: unknown): boolean => {
  if (typeof value === "string") return textOmitsCursorSecrets(value);
  if (typeof value !== "object" || value === null) return true;
  if (Array.isArray(value)) return value.every(valueOmitsCursorSecrets);
  const record = value as Record<string, unknown>;
  if (
    "value" in record ||
    "token" in record ||
    "apiKey" in record ||
    "api_key" in record ||
    "authorization" in record
  ) {
    return false;
  }
  return Object.values(record).every(valueOmitsCursorSecrets);
};
