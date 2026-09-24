import {
  DISPATCHER_MAX_CANDIDATES,
  DISPATCHER_POLICY_VERSION,
  type ActionGateResult,
  type DispatcherContextSummary,
  type DispatcherProjectResolution,
  type DispatcherReasonCode,
  type DispatcherRouteCandidate,
  type DispatcherRouteCandidateSource,
  type DispatcherRouteDecision,
  type DispatcherRoutePreviewRequest,
  type DispatcherRouteTarget,
  type EnvironmentId,
  type MessageId,
  ModelSelection,
  type OrchestrationMessage,
  ProjectId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export interface DispatcherProjectState {
  readonly id: ProjectId;
  readonly workspaceRoot: string;
  readonly defaultModelSelection: ModelSelection | null;
  readonly deletedAt: string | null;
}

export interface DispatcherThreadState {
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly modelSelection: ModelSelection;
  readonly deletedAt: string | null;
}

export interface DispatcherProjectedState {
  readonly projects: ReadonlyArray<DispatcherProjectState>;
  readonly threads: ReadonlyArray<DispatcherThreadState>;
}

const DispatcherProjectRows = Schema.Array(
  Schema.Struct({
    id: ProjectId,
    workspaceRoot: Schema.String,
    defaultModelSelection: Schema.NullOr(Schema.fromJsonString(ModelSelection)),
    deletedAt: Schema.NullOr(Schema.String),
  }),
);
const DispatcherThreadRows = Schema.Array(
  Schema.Struct({
    id: ThreadId,
    projectId: ProjectId,
    modelSelection: Schema.fromJsonString(ModelSelection),
    deletedAt: Schema.NullOr(Schema.String),
  }),
);

const decodeDispatcherProjectRows = Schema.decodeUnknownEffect(DispatcherProjectRows);
const decodeDispatcherThreadRows = Schema.decodeUnknownEffect(DispatcherThreadRows);

/** Read only the projection columns the dispatcher is allowed to consider. */
export const readDispatcherProjectedState = Effect.fn("Dispatcher.readDispatcherProjectedState")(
  function* (input: { readonly threadId?: ThreadId }) {
    const sql = yield* SqlClient.SqlClient;
    const projectRows = yield* sql`
    SELECT
      project_id AS "id",
      workspace_root AS "workspaceRoot",
      default_model_selection_json AS "defaultModelSelection",
      deleted_at AS "deletedAt"
    FROM projection_projects
    ORDER BY created_at ASC, project_id ASC
  `;
    const threadRows =
      input.threadId === undefined
        ? []
        : yield* sql`
          SELECT
            thread_id AS "id",
            project_id AS "projectId",
            model_selection_json AS "modelSelection",
            deleted_at AS "deletedAt"
          FROM projection_threads
          WHERE thread_id = ${input.threadId}
          LIMIT 1
        `;

    return {
      projects: yield* decodeDispatcherProjectRows(projectRows),
      threads: yield* decodeDispatcherThreadRows(threadRows),
    } satisfies DispatcherProjectedState;
  },
);

export interface DispatcherMessageMetadata {
  readonly id: MessageId;
  readonly threadId: ThreadId;
  readonly role: OrchestrationMessage["role"];
  readonly attachmentCount: number;
  readonly composerContextKinds: ReadonlyArray<string>;
}

export interface DispatcherResolutionInput {
  readonly environmentId: EnvironmentId;
  readonly request: DispatcherRoutePreviewRequest;
  readonly projected: DispatcherProjectedState;
  readonly message: DispatcherMessageMetadata | null;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly environmentDefaultModelSelection: ModelSelection | null;
}

interface ResolvedProject {
  readonly resolution: DispatcherProjectResolution;
  readonly project: DispatcherProjectState | null;
  readonly thread: DispatcherThreadState | null;
}

const rejectedProject = (
  source: DispatcherProjectResolution["source"],
  reason: DispatcherReasonCode,
): ResolvedProject => ({
  resolution: {
    status: "rejected",
    source,
    projectId: null,
    reasonCodes: [reason],
  },
  project: null,
  thread: null,
});

const resolvedProject = (
  source: DispatcherProjectResolution["source"],
  project: DispatcherProjectState,
  thread: DispatcherThreadState | null,
): ResolvedProject => ({
  resolution: {
    status: "resolved",
    source,
    projectId: project.id,
    reasonCodes: [],
  },
  project,
  thread,
});

function workspaceRootsMatch(left: string, right: string): boolean {
  return normalizeProjectPathForComparison(left) === normalizeProjectPathForComparison(right);
}

export function resolveDispatcherProject(input: {
  readonly environmentId: EnvironmentId;
  readonly request: DispatcherRoutePreviewRequest;
  readonly projected: DispatcherProjectedState;
}): ResolvedProject {
  const { request, projected } = input;
  if (request.environmentId !== input.environmentId) {
    return rejectedProject("none", "ENVIRONMENT_MISMATCH");
  }

  if (request.threadId !== undefined) {
    const thread = projected.threads.find((candidate) => candidate.id === request.threadId);
    if (thread === undefined) {
      return rejectedProject("thread", "THREAD_NOT_FOUND");
    }
    if (thread.deletedAt !== null) {
      return rejectedProject("thread", "THREAD_DELETED");
    }
    const project = projected.projects.find((candidate) => candidate.id === thread.projectId);
    if (project === undefined) {
      return rejectedProject("thread", "PROJECT_NOT_FOUND");
    }
    if (project.deletedAt !== null) {
      return rejectedProject("thread", "PROJECT_DELETED");
    }
    if (
      (request.projectId !== undefined && request.projectId !== project.id) ||
      (request.workspaceRoot !== undefined &&
        !workspaceRootsMatch(request.workspaceRoot, project.workspaceRoot))
    ) {
      return rejectedProject("thread", "PROJECT_MISMATCH");
    }
    return resolvedProject("thread", project, thread);
  }

  if (request.projectId !== undefined) {
    const project = projected.projects.find((candidate) => candidate.id === request.projectId);
    if (project === undefined) {
      return rejectedProject("project-id", "PROJECT_NOT_FOUND");
    }
    if (project.deletedAt !== null) {
      return rejectedProject("project-id", "PROJECT_DELETED");
    }
    if (
      request.workspaceRoot !== undefined &&
      !workspaceRootsMatch(request.workspaceRoot, project.workspaceRoot)
    ) {
      return rejectedProject("project-id", "PROJECT_MISMATCH");
    }
    return resolvedProject("project-id", project, null);
  }

  if (request.workspaceRoot !== undefined) {
    const workspaceRoot = request.workspaceRoot;
    const matching = projected.projects.filter((candidate) =>
      workspaceRootsMatch(workspaceRoot, candidate.workspaceRoot),
    );
    const active = matching.filter((candidate) => candidate.deletedAt === null);
    if (active.length > 1) {
      return rejectedProject("workspace-root", "PROJECT_AMBIGUOUS");
    }
    const project = active[0];
    if (project !== undefined) {
      return resolvedProject("workspace-root", project, null);
    }
    return rejectedProject(
      "workspace-root",
      matching.length > 0 ? "PROJECT_DELETED" : "PROJECT_NOT_FOUND",
    );
  }

  return rejectedProject("none", "PROJECT_SELECTOR_REQUIRED");
}

export function normalizeModelFamily(model: string): string {
  const normalized = model.trim().toLowerCase();
  if (normalized.includes("claude")) return "claude";
  if (normalized.includes("gemini")) return "gemini";
  if (normalized.includes("grok")) return "grok";
  if (normalized.includes("codex")) return "codex";
  if (/^(?:gpt|o\d)/.test(normalized)) return "openai";
  return "other";
}

const routeTarget = (selection: ModelSelection): DispatcherRouteTarget => ({
  instanceId: selection.instanceId,
  model: selection.model,
});

const routeKey = (target: DispatcherRouteTarget): string =>
  `${target.instanceId}\u0000${target.model}`;

const compareStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

function defaultProviderTarget(provider: ServerProvider): DispatcherRouteTarget | null {
  const models = [...provider.models].sort((left, right) => compareStrings(left.slug, right.slug));
  const model = models.find((candidate) => candidate.isDefault === true) ?? models[0];
  return model === undefined ? null : { instanceId: provider.instanceId, model: model.slug };
}

function candidateReasons(
  target: DispatcherRouteTarget,
  provider: ServerProvider | undefined,
): ReadonlyArray<DispatcherReasonCode> {
  if (provider === undefined) return ["PROVIDER_INSTANCE_NOT_FOUND"];
  if (provider.availability === "unavailable") return ["PROVIDER_UNAVAILABLE"];
  if (!provider.enabled || provider.status === "disabled") return ["PROVIDER_DISABLED"];
  if (!provider.installed) return ["PROVIDER_NOT_INSTALLED"];
  if (provider.auth.status === "unauthenticated") return ["PROVIDER_UNAUTHENTICATED"];
  if (provider.status === "error") return ["PROVIDER_ERROR"];
  if (!provider.models.some((model) => model.slug === target.model)) return ["MODEL_NOT_FOUND"];
  return [];
}

function buildCandidates(input: {
  readonly request: DispatcherRoutePreviewRequest;
  readonly resolved: ResolvedProject;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly environmentDefaultModelSelection: ModelSelection | null;
}): ReadonlyArray<DispatcherRouteCandidate> {
  if (input.resolved.project === null) return [];

  const orderedTargets: Array<{
    readonly target: DispatcherRouteTarget;
    readonly source: DispatcherRouteCandidateSource;
  }> = [];
  const append = (
    source: DispatcherRouteCandidateSource,
    target: DispatcherRouteTarget | null | undefined,
  ) => {
    if (target !== null && target !== undefined) orderedTargets.push({ source, target });
  };

  append("explicit", input.request.preferredRoute);
  append(
    "thread",
    input.resolved.thread === null ? null : routeTarget(input.resolved.thread.modelSelection),
  );
  append(
    "project-default",
    input.resolved.project.defaultModelSelection === null
      ? null
      : routeTarget(input.resolved.project.defaultModelSelection),
  );
  append(
    "environment-default",
    input.environmentDefaultModelSelection === null
      ? null
      : routeTarget(input.environmentDefaultModelSelection),
  );
  for (const provider of [...input.providers].sort((left, right) =>
    compareStrings(left.instanceId, right.instanceId),
  )) {
    append("provider-default", defaultProviderTarget(provider));
  }

  const providersByInstance = new Map(
    input.providers.map((provider) => [provider.instanceId, provider] as const),
  );
  const seen = new Set<string>();
  const candidates: Array<DispatcherRouteCandidate> = [];
  for (const item of orderedTargets) {
    const key = routeKey(item.target);
    if (seen.has(key)) continue;
    seen.add(key);
    const provider = providersByInstance.get(item.target.instanceId);
    const reasonCodes = candidateReasons(item.target, provider);
    candidates.push({
      fallbackIndex: candidates.length,
      target: item.target,
      driver: provider?.driver ?? null,
      modelFamily: normalizeModelFamily(item.target.model),
      source: item.source,
      eligible: reasonCodes.length === 0,
      reasonCodes,
    });
    if (candidates.length === DISPATCHER_MAX_CANDIDATES) break;
  }
  return candidates;
}

export function evaluateActionGate(input: {
  readonly resolution: DispatcherProjectResolution;
  readonly requestedMessageId: MessageId | undefined;
  readonly message: DispatcherMessageMetadata | null;
  readonly candidates: ReadonlyArray<DispatcherRouteCandidate>;
}): ActionGateResult {
  if (input.resolution.status === "rejected") {
    return { decision: "DENY", reasonCodes: input.resolution.reasonCodes };
  }
  if (input.requestedMessageId !== undefined && input.message === null) {
    return { decision: "DENY", reasonCodes: ["MESSAGE_NOT_FOUND"] };
  }
  if (input.candidates.length === 0) {
    return { decision: "DENY", reasonCodes: ["NO_ROUTE_CANDIDATES"] };
  }
  const selected = input.candidates.find((candidate) => candidate.eligible);
  if (selected === undefined) {
    const reasonCodes = [
      ...new Set(input.candidates.flatMap((candidate) => candidate.reasonCodes)),
    ];
    return {
      decision: "DENY",
      reasonCodes: reasonCodes.length > 0 ? reasonCodes.slice(0, 16) : ["NO_ROUTE_CANDIDATES"],
    };
  }
  return { decision: "ALLOW", reasonCodes: ["ACTION_ALLOWED"] };
}

const contextSummary = (
  request: DispatcherRoutePreviewRequest,
  message: DispatcherMessageMetadata | null,
): DispatcherContextSummary => ({
  threadId: request.threadId ?? null,
  messageId: request.messageId ?? null,
  hasPersistedMessage: message !== null,
  attachmentCount: message?.attachmentCount ?? 0,
  composerContextKinds: message?.composerContextKinds ?? [],
});

export function resolveDispatcherRoute(input: DispatcherResolutionInput): DispatcherRouteDecision {
  const resolved = resolveDispatcherProject(input);
  const message =
    input.request.messageId !== undefined &&
    input.message?.id === input.request.messageId &&
    input.message.threadId === input.request.threadId &&
    input.message.role === "user"
      ? input.message
      : null;
  const candidates = buildCandidates({
    request: input.request,
    resolved,
    providers: input.providers,
    environmentDefaultModelSelection: input.environmentDefaultModelSelection,
  });
  const gate = evaluateActionGate({
    resolution: resolved.resolution,
    requestedMessageId: input.request.messageId,
    message,
    candidates,
  });

  return {
    policyVersion: DISPATCHER_POLICY_VERSION,
    environmentId: input.environmentId,
    actionKind: input.request.actionKind,
    projectResolution: resolved.resolution,
    context: contextSummary(input.request, message),
    candidates,
    selected: candidates.find((candidate) => candidate.eligible) ?? null,
    gate,
  };
}

export const previewDispatcherRoute = (
  input: DispatcherResolutionInput,
): Effect.Effect<DispatcherRouteDecision> =>
  Effect.sync(() => resolveDispatcherRoute(input)).pipe(
    Effect.tap((decision) => {
      const selected = decision.selected;
      return Effect.annotateCurrentSpan({
        "dispatcher.policy_version": decision.policyVersion,
        "dispatcher.resolution_source": decision.projectResolution.source,
        "dispatcher.provider_instance": selected?.target.instanceId ?? "none",
        "dispatcher.provider_driver": selected?.driver ?? "none",
        "dispatcher.model_family": selected?.modelFamily ?? "none",
        "dispatcher.fallback_index": selected?.fallbackIndex ?? -1,
        "dispatcher.gate_result": decision.gate.decision,
        "dispatcher.reason_codes": decision.gate.reasonCodes.join(","),
      });
    }),
    Effect.withSpan("dispatcher.route_preview"),
  );

export function summarizeDispatcherMessage(input: {
  readonly threadId: ThreadId;
  readonly message: OrchestrationMessage;
}): DispatcherMessageMetadata {
  return {
    id: input.message.id,
    threadId: input.threadId,
    role: input.message.role,
    attachmentCount: input.message.attachments?.length ?? 0,
    composerContextKinds: [
      ...new Set((input.message.context?.records ?? []).map((record) => record.kind)),
    ].sort(),
  };
}
