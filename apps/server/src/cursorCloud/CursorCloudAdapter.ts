import {
  cursorCloudCreateRequestFromTarget,
  emptyCursorCloudBinding,
  isCursorCloudRunActive,
  mapCursorAgentStatus,
  mapCursorRunStatus,
  type CloudRunnerCanonicalStatus,
  type CursorCloudCreateRequest,
  type CursorCloudExecutionTarget,
  type CursorCloudFollowUpRequest,
  type CursorCloudGitOutput,
  type CursorCloudRunnerBinding,
} from "@t3tools/contracts";
import * as Exit from "effect/Exit";
import type { ProviderDriverKind } from "@t3tools/contracts";

import {
  decodeBetaAgent,
  decodeBetaCancel,
  decodeBetaCreateAgent,
  decodeBetaCreateRun,
  decodeBetaError,
  decodeBetaMe,
  decodeBetaModels,
  decodeBetaRun,
  type CursorCloudBetaAgent,
  type CursorCloudBetaRun,
} from "./beta/schemas.ts";
import type { CursorCloudCredentialProvider } from "./CursorCloudCredentials.ts";
import {
  cursorCloudError,
  isCursorCloudError,
  sanitizeCursorCloudText,
} from "./CursorCloudErrors.ts";
import {
  CURSOR_CLOUD_CREATE_TIMEOUT_MS,
  CURSOR_CLOUD_DEFAULT_TIMEOUT_MS,
  toCursorCloudHttpError,
  type CursorCloudHttpResponse,
  type CursorCloudHttpTransport,
} from "./CursorCloudHttp.ts";

export type CursorCloudIdentity = {
  readonly apiKeyName: string | null;
  readonly createdAt: string | null;
};

export type CursorCloudModel = {
  readonly id: string;
  readonly displayName: string | null;
};

export type CursorCloudAdapter = {
  verifyIdentity(): Promise<CursorCloudIdentity>;
  listModels(): Promise<ReadonlyArray<CursorCloudModel>>;
  createAgent(input: {
    readonly prompt: string;
    readonly agentId: string;
    readonly cursorModelId?: string;
    readonly name?: string;
    readonly target: CursorCloudExecutionTarget;
    readonly provider: ProviderDriverKind;
    readonly dispatcherModel: string;
    readonly at: string;
  }): Promise<CursorCloudRunnerBinding>;
  getAgent(agentId: string): Promise<CursorCloudBetaAgent>;
  createFollowUpRun(input: {
    readonly binding: CursorCloudRunnerBinding;
    readonly prompt: string;
    readonly at: string;
  }): Promise<CursorCloudRunnerBinding>;
  getRun(agentId: string, runId: string): Promise<CursorCloudBetaRun>;
  cancelRun(input: {
    readonly binding: CursorCloudRunnerBinding;
    readonly at: string;
  }): Promise<CursorCloudRunnerBinding>;
  refreshBinding(input: {
    readonly binding: CursorCloudRunnerBinding;
    readonly at: string;
  }): Promise<CursorCloudRunnerBinding>;
};

const parseJson = (bodyText: string): unknown => {
  if (bodyText.trim().length === 0) return {};
  try {
    return JSON.parse(bodyText) as unknown;
  } catch {
    throw cursorCloudError("malformed_response", "Cursor Cloud returned a non-JSON body.");
  }
};

const decodeOrThrow = <A>(decoded: Exit.Exit<A, unknown>, message: string): A => {
  if (Exit.isFailure(decoded)) {
    throw cursorCloudError("malformed_response", message);
  }
  return decoded.value;
};

const gitOutput = (run: CursorCloudBetaRun): CursorCloudGitOutput | undefined => {
  const branch = run.git?.branches?.[0];
  if (branch === undefined) return undefined;
  return {
    ...(branch.repoUrl === undefined ? {} : { repositoryUrl: branch.repoUrl }),
    ...(branch.branch === undefined ? {} : { branch: branch.branch }),
    ...(branch.prUrl === undefined ? {} : { pullRequestUrl: branch.prUrl }),
  };
};

const combinedStatus = (
  agentStatus: CursorCloudBetaAgent["status"] | undefined,
  runStatus: CursorCloudBetaRun["status"] | undefined,
): CloudRunnerCanonicalStatus => {
  if (runStatus !== undefined) return mapCursorRunStatus(runStatus);
  if (agentStatus !== undefined) return mapCursorAgentStatus(agentStatus);
  return "creating";
};

type RunBindingPatch = {
  readonly cursorAgentId?: string;
  readonly cursorAgentUrl?: string;
  readonly cursorAgentStatus?: CursorCloudBetaAgent["status"];
  readonly status?: CloudRunnerCanonicalStatus;
};

const withoutSanitizedError = (binding: CursorCloudRunnerBinding): CursorCloudRunnerBinding => {
  const { sanitizedError: _cleared, ...rest } = binding;
  return rest;
};

const applyRunToBinding = (
  binding: CursorCloudRunnerBinding,
  run: CursorCloudBetaRun,
  at: string,
  extras: RunBindingPatch = {},
): CursorCloudRunnerBinding => {
  const output = gitOutput(run) ?? binding.output;
  const sanitizedResult =
    run.result === undefined
      ? binding.sanitizedResult
      : sanitizeCursorCloudText(run.result).slice(0, 2_000);
  return {
    ...binding,
    cursorAgentId: run.agentId,
    cursorRunId: run.id,
    cursorRunStatus: run.status,
    status:
      extras.status ??
      combinedStatus(extras.cursorAgentStatus ?? binding.cursorAgentStatus, run.status),
    updatedAt: at,
    ...extras,
    credentialRef: binding.credentialRef,
    ...(output === undefined ? {} : { output }),
    ...(sanitizedResult === undefined ? {} : { sanitizedResult }),
  };
};

export const makeCursorCloudAdapter = (input: {
  readonly transport: CursorCloudHttpTransport;
  readonly credentials: CursorCloudCredentialProvider;
  readonly defaultTimeoutMs?: number;
  readonly createTimeoutMs?: number;
}): CursorCloudAdapter => {
  const defaultTimeoutMs = input.defaultTimeoutMs ?? CURSOR_CLOUD_DEFAULT_TIMEOUT_MS;
  const createTimeoutMs = input.createTimeoutMs ?? CURSOR_CLOUD_CREATE_TIMEOUT_MS;

  const authorizedRequest = async (request: {
    readonly method: "GET" | "POST";
    readonly path: string;
    readonly body?: unknown;
    readonly timeoutMs?: number;
  }): Promise<CursorCloudHttpResponse> => {
    const credential = input.credentials.resolve();
    if (!credential.ok) throw credential.error;
    try {
      return await input.transport({
        method: request.method,
        path: request.path,
        timeoutMs: request.timeoutMs ?? defaultTimeoutMs,
        authorization: credential.token,
        ...(request.body === undefined ? {} : { body: request.body }),
      });
    } catch (cause) {
      if (cause && typeof cause === "object" && "_tag" in cause) throw cause;
      throw cursorCloudError("transport", "Cursor Cloud transport failed.");
    }
  };

  const readJson = async (
    request: {
      readonly method: "GET" | "POST";
      readonly path: string;
      readonly body?: unknown;
      readonly timeoutMs?: number;
    },
    fallback: string,
  ): Promise<unknown> => {
    const response = await authorizedRequest(request);
    if (response.status < 200 || response.status >= 300) {
      const body = decodeBetaError(parseJson(response.bodyText));
      const message = Exit.isSuccess(body)
        ? (body.value.message ?? body.value.error ?? fallback)
        : fallback;
      throw toCursorCloudHttpError(response, message);
    }
    return parseJson(response.bodyText);
  };

  const getAgent = async (agentId: string) => {
    const decoded = decodeBetaAgent(
      await readJson({ method: "GET", path: `/v1/agents/${agentId}` }, "Get agent failed."),
    );
    return decodeOrThrow(decoded, "Get agent response was malformed.");
  };

  const getRun = async (agentId: string, runId: string) => {
    const decoded = decodeBetaRun(
      await readJson(
        { method: "GET", path: `/v1/agents/${agentId}/runs/${runId}` },
        "Get run failed.",
      ),
    );
    return decodeOrThrow(decoded, "Get run response was malformed.");
  };

  return {
    async verifyIdentity() {
      const decoded = decodeBetaMe(
        await readJson({ method: "GET", path: "/v1/me" }, "Identity check failed."),
      );
      const value = decodeOrThrow(decoded, "Identity response was malformed.");
      return {
        apiKeyName: value.apiKeyName ?? null,
        createdAt: value.createdAt ?? null,
      };
    },

    async listModels() {
      const decoded = decodeBetaModels(
        await readJson({ method: "GET", path: "/v1/models" }, "Model discovery failed."),
      );
      const value = decodeOrThrow(decoded, "Model list response was malformed.");
      return value.items.map((item) => ({ id: item.id, displayName: item.displayName ?? null }));
    },

    async createAgent(createInput) {
      const body: CursorCloudCreateRequest = cursorCloudCreateRequestFromTarget({
        prompt: createInput.prompt,
        agentId: createInput.agentId,
        target: createInput.target,
        ...(createInput.cursorModelId === undefined
          ? {}
          : { cursorModelId: createInput.cursorModelId }),
        ...(createInput.name === undefined ? {} : { name: createInput.name }),
      });
      const binding = emptyCursorCloudBinding({
        provider: createInput.provider,
        model: createInput.dispatcherModel,
        target: createInput.target,
        at: createInput.at,
      });
      try {
        const decoded = decodeBetaCreateAgent(
          await readJson(
            { method: "POST", path: "/v1/agents", body, timeoutMs: createTimeoutMs },
            "Create agent failed.",
          ),
        );
        const value = decodeOrThrow(decoded, "Create agent response was malformed.");
        return applyRunToBinding(binding, value.run, createInput.at, {
          cursorAgentId: value.agent.id,
          cursorAgentStatus: value.agent.status,
          status: combinedStatus(value.agent.status, value.run.status),
          ...(value.agent.url === undefined ? {} : { cursorAgentUrl: value.agent.url }),
        });
      } catch (cause) {
        if (!isCursorCloudError(cause) || cause.code !== "agent_id_conflict") throw cause;
        const agent = await getAgent(createInput.agentId);
        const run =
          agent.latestRunId === undefined
            ? undefined
            : await getRun(createInput.agentId, agent.latestRunId);
        if (run === undefined) {
          return {
            ...binding,
            cursorAgentId: agent.id,
            cursorAgentStatus: agent.status,
            status: mapCursorAgentStatus(agent.status),
            updatedAt: createInput.at,
            ...(agent.url === undefined ? {} : { cursorAgentUrl: agent.url }),
          };
        }
        return applyRunToBinding(binding, run, createInput.at, {
          cursorAgentId: agent.id,
          cursorAgentStatus: agent.status,
          ...(agent.url === undefined ? {} : { cursorAgentUrl: agent.url }),
        });
      }
    },

    getAgent,

    async createFollowUpRun(followUp) {
      const agentId = followUp.binding.cursorAgentId;
      if (agentId === undefined) {
        throw cursorCloudError(
          "rejected",
          "A durable Cursor agent is required before a follow-up.",
        );
      }
      if (isCursorCloudRunActive(followUp.binding.cursorRunStatus)) {
        throw cursorCloudError("agent_busy", "The Cursor agent is busy with another run.", {
          httpStatus: 409,
        });
      }
      const body: CursorCloudFollowUpRequest = { prompt: { text: followUp.prompt } };
      const decoded = decodeBetaCreateRun(
        await readJson(
          { method: "POST", path: `/v1/agents/${agentId}/runs`, body },
          "Follow-up run failed.",
        ),
      );
      const value = decodeOrThrow(decoded, "Follow-up run response was malformed.");
      return applyRunToBinding(withoutSanitizedError(followUp.binding), value.run, followUp.at, {
        cursorAgentId: agentId,
      });
    },

    getRun,

    async cancelRun(cancelInput) {
      const agentId = cancelInput.binding.cursorAgentId;
      const runId = cancelInput.binding.cursorRunId;
      if (agentId === undefined || runId === undefined) {
        throw cursorCloudError("rejected", "A Cursor run is required before cancellation.");
      }
      const decoded = decodeBetaCancel(
        await readJson(
          { method: "POST", path: `/v1/agents/${agentId}/runs/${runId}/cancel` },
          "Cancel run failed.",
        ),
      );
      decodeOrThrow(decoded, "Cancel run response was malformed.");
      return {
        ...withoutSanitizedError(cancelInput.binding),
        cursorRunStatus: "CANCELLED",
        status: "cancelled",
        updatedAt: cancelInput.at,
      };
    },

    async refreshBinding(refreshInput) {
      const agentId = refreshInput.binding.cursorAgentId;
      const runId = refreshInput.binding.cursorRunId;
      if (agentId === undefined) return refreshInput.binding;
      const agent = await getAgent(agentId);
      const run =
        runId === undefined
          ? agent.latestRunId === undefined
            ? undefined
            : await getRun(agentId, agent.latestRunId)
          : await getRun(agentId, runId);
      const cursorAgentUrl = agent.url ?? refreshInput.binding.cursorAgentUrl;
      if (run === undefined) {
        return {
          ...refreshInput.binding,
          cursorAgentStatus: agent.status,
          status: mapCursorAgentStatus(agent.status),
          updatedAt: refreshInput.at,
          ...(cursorAgentUrl === undefined ? {} : { cursorAgentUrl }),
        };
      }
      return applyRunToBinding(refreshInput.binding, run, refreshInput.at, {
        cursorAgentId: agent.id,
        cursorAgentStatus: agent.status,
        ...(cursorAgentUrl === undefined ? {} : { cursorAgentUrl }),
      });
    },
  };
};
