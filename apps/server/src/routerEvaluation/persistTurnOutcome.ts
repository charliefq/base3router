import * as Schema from "effect/Schema";
import {
  OrchestrationV2AppThreadJson,
  OrchestrationV2Run,
  OrchestrationV2RunAttempt,
  OrchestrationV2ProviderThread,
  OrchestrationV2ExecutionNode,
  OrchestrationV2ConversationMessage,
  TurnOutcomeObservationV0,
} from "@t3tools/contracts";
import {
  EnvironmentId,
  EventId,
  MessageId,
  ObservationId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  TURN_OUTCOME_OBSERVATION_VERSION,
  UNKNOWN_TASK_PROFILE,
  emptyOutcomeEvidence,
  type DispatcherTaskRouteBinding,
  OrchestrationV2ProviderTurn,
  type ProviderRuntimeEvent,
  type ReworkSignalV0,
  type ThreadId,
  REWORK_ABANDONMENT_WINDOW_MS,
  DEFAULT_DREAM_MEMORY_SETTINGS,
} from "@t3tools/contracts";
import {
  classifyTurnTerminal,
  costFromProviderTotal,
  costFromReportedAndEstimate,
  effectivePolicyVersion,
  nanosToDurationMs,
  timingFromClock,
  usageFromOpenRouter,
  usageFromTurnTokenUsage,
} from "@t3tools/shared/turnOutcome";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as Dispatcher from "../dispatcher/Dispatcher.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import type { ProjectionStoreV2Error } from "../orchestration-v2/ProjectionStore.ts";
import { RouterEvaluationService } from "./RouterEvaluationService.ts";
import { TurnTiming, type TurnTimingSnapshot } from "./TurnTiming.ts";
import { DreamMemoryService, viewerFromSubject } from "../dreamMemory/DreamMemoryService.ts";
import { ConcurrencyBudgetService } from "../concurrencyBudget/ConcurrencyBudgetService.ts";
import { ServerSettingsService } from "../serverSettings.ts";

const observationIdForTurn = (
  environmentId: EnvironmentId,
  threadId: ThreadId,
  messageId: MessageId,
): ObservationId => ObservationId.make(`${environmentId}:${threadId}:${messageId}`);

export const buildTurnOutcomeObservation = (input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly event: ProviderRuntimeEvent;
  readonly binding: DispatcherTaskRouteBinding;
  readonly nowMs: number;
  readonly nowIso: string;
  readonly timing?: TurnTimingSnapshot;
  readonly verifiedSingleStart?: true;
}): TurnOutcomeObservationV0 => {
  const event = input.event;
  const binding = input.binding;
  const aborted = event.type === "turn.aborted" ? event.payload : undefined;
  const completed = event.type === "turn.completed" ? event.payload : undefined;
  const classification = classifyTurnTerminal(
    aborted !== undefined
      ? { eventType: "turn.aborted", abortReason: aborted.reason }
      : {
          eventType: "turn.completed",
          ...(completed?.state !== undefined ? { state: completed.state } : {}),
          ...(completed?.failureCategory !== undefined
            ? { failureCategory: completed.failureCategory }
            : {}),
          ...(completed?.stopReason !== undefined ? { stopReason: completed.stopReason } : {}),
          ...(completed?.errorMessage !== undefined
            ? { errorMessage: completed.errorMessage }
            : {}),
          ...(completed?.openRouter?.errorCategory !== undefined
            ? { openRouterErrorCategory: completed.openRouter.errorCategory }
            : {}),
          ...(completed?.openRouter?.status !== undefined
            ? { openRouterStatus: completed.openRouter.status }
            : {}),
        },
  );
  const incompleteStream =
    classification.cancelled ||
    classification.timedOut ||
    classification.terminalCategory === "infrastructure_failure" ||
    completed?.state === "interrupted" ||
    completed?.state === "cancelled";
  const tokenUsage = completed?.tokenUsage ?? aborted?.tokenUsage;
  const openRouter = binding.openRouter ?? completed?.openRouter;
  const usage =
    openRouter?.promptTokens?.status === "known" || openRouter?.completionTokens?.status === "known"
      ? usageFromOpenRouter({
          observedAt: input.nowIso,
          ...(openRouter.promptTokens?.status === "known"
            ? { promptTokens: openRouter.promptTokens.value }
            : {}),
          ...(openRouter.completionTokens?.status === "known"
            ? { completionTokens: openRouter.completionTokens.value }
            : {}),
          ...(openRouter.totalTokens?.status === "known"
            ? { totalTokens: openRouter.totalTokens.value }
            : {}),
          ...(openRouter.routingMetadata?.isByok !== undefined
            ? { isByok: openRouter.routingMetadata.isByok }
            : {}),
        })
      : usageFromTurnTokenUsage({
          ...(tokenUsage === undefined ? {} : { tokenUsage }),
          completeAccounting: !incompleteStream,
          observedAt: input.nowIso,
        });
  const reportedOpenRouterCost =
    openRouter?.reportedCostUsd?.status === "known" ? openRouter.reportedCostUsd.value : undefined;
  const providerCost =
    completed !== undefined && !incompleteStream ? completed.totalCostUsd : undefined;
  const cost =
    reportedOpenRouterCost !== undefined
      ? costFromReportedAndEstimate({
          observedAt: input.nowIso,
          reportedUsd: reportedOpenRouterCost,
          ...(openRouter?.routingMetadata?.isByok === true ? { isByok: true } : {}),
        })
      : costFromProviderTotal({
          observedAt: input.nowIso,
          ...(providerCost !== undefined ? { totalCostUsd: providerCost } : {}),
        });
  const snapshot = input.timing;
  const ttft = nanosToDurationMs(
    snapshot?.providerRequestStartNanos ?? snapshot?.routeStartNanos,
    snapshot?.firstOutputNanos,
  );
  const total = nanosToDurationMs(
    snapshot?.routeStartNanos ?? snapshot?.providerRequestStartNanos,
    snapshot?.terminalNanos,
  );
  return {
    version: TURN_OUTCOME_OBSERVATION_VERSION,
    observationId: observationIdForTurn(input.environmentId, input.threadId, input.messageId),
    environmentId: input.environmentId,
    recordedAt: input.nowIso,
    policyVersion: effectivePolicyVersion({
      ...(binding.hybrid === undefined
        ? {}
        : { hybridPolicyVersion: binding.hybrid.policyVersion }),
      ...(binding.hybrid?.usedHybridRanking === undefined
        ? {}
        : { usedHybridRanking: binding.hybrid.usedHybridRanking }),
      ...(binding.modelRoute?.policyVersion === undefined
        ? {}
        : { modelRoutePolicyVersion: binding.modelRoute.policyVersion }),
    }),
    routingMode: binding.modelRoute?.mode ?? "auto",
    model: binding.target.model,
    instanceId: binding.target.instanceId,
    driver: binding.driver,
    actualExecutionModel: openRouter?.actualExecutionModel ?? binding.target.model,
    taskProfile: openRouter?.taskProfile ?? UNKNOWN_TASK_PROFILE,
    ...(binding.localTaskProfile === undefined
      ? {}
      : { localTaskProfile: binding.localTaskProfile }),
    timing: timingFromClock({
      iso: (ms) => DateTime.formatIso(DateTime.makeUnsafe(ms)),
      clock: "monotonic_nanos",
      ...(snapshot?.routeStartMs !== undefined ? { routeStartMs: snapshot.routeStartMs } : {}),
      ...(snapshot?.providerRequestStartMs !== undefined
        ? { providerRequestStartMs: snapshot.providerRequestStartMs }
        : {}),
      ...(snapshot?.firstOutputMs !== undefined ? { firstOutputMs: snapshot.firstOutputMs } : {}),
      terminalMs: snapshot?.terminalMs ?? input.nowMs,
      ...(ttft !== undefined ? { timeToFirstTokenMs: ttft } : {}),
      ...(total !== undefined ? { totalDurationMs: total } : {}),
    }),
    usage,
    cost,
    providerAttempts:
      input.verifiedSingleStart === true ? 1 : (binding.modelRoute?.attempts?.length ?? 1),
    fallbackCount:
      input.verifiedSingleStart === true
        ? 0
        : Math.max(0, (binding.modelRoute?.attempts?.length ?? 1) - 1),
    cancelled: classification.cancelled,
    timedOut: classification.timedOut,
    finishReason: classification.finishReason,
    terminalCategory: classification.terminalCategory,
    evidence: emptyOutcomeEvidence(),
    ...(binding.hybrid !== undefined ? { hybrid: binding.hybrid } : {}),
    ...(openRouter?.agreement !== undefined ? { openRouterAgreement: openRouter.agreement } : {}),
    eligibleCandidateCount: binding.modelRoute?.candidates.filter((candidate) => candidate.eligible)
      .length,
  };
};

export const detectReworkProxy = (input: {
  readonly previous: TurnOutcomeObservationV0;
  readonly next: TurnOutcomeObservationV0;
  readonly nowMs: number;
}): ReworkSignalV0 | undefined => {
  const previousMs = Date.parse(input.previous.recordedAt);
  const deltaMs = Number.isFinite(previousMs) ? input.nowMs - previousMs : Number.NaN;
  const inWindow =
    Number.isFinite(deltaMs) && deltaMs >= 0 && deltaMs <= REWORK_ABANDONMENT_WINDOW_MS;
  const recordedAt = input.next.recordedAt;
  const already = (kind: ReworkSignalV0["kind"]) =>
    input.previous.evidence.reworkProxies.some((entry) => entry.kind === kind);
  const signal = (kind: ReworkSignalV0["kind"]): ReworkSignalV0 => ({
    kind,
    labeledAs: "proxy",
    rawEventType: kind,
    detectionWindowMs: Number.isFinite(deltaMs) && deltaMs >= 0 ? Math.trunc(deltaMs) : 0,
    recordedAt,
    deduped: already(kind),
  });
  if (
    input.previous.terminalCategory === "provider_failure" ||
    input.previous.terminalCategory === "timeout"
  ) {
    return signal("retry_after_failure");
  }
  if (input.previous.routingMode === "auto" && input.next.routingMode === "manual") {
    return signal("auto_to_manual_switch");
  }
  if (
    input.previous.routingMode === "manual" &&
    input.next.routingMode === "manual" &&
    input.previous.model !== input.next.model
  ) {
    return signal("manual_model_switch");
  }
  if (inWindow && input.previous.terminalCategory === "success") {
    return signal("regenerate");
  }
  return undefined;
};

const persistTurnOutcomeFromRuntimeEvent = Effect.fn("persistTurnOutcomeFromRuntimeEvent")(
  function* (input: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
    readonly event: ProviderRuntimeEvent;
    readonly measurementEnabled: boolean;
    readonly projectId?: ProjectId;
    readonly timing?: TurnTimingSnapshot;
    readonly verifiedSingleStart?: true;
  }) {
    if (!input.measurementEnabled) return;
    if (input.event.type !== "turn.completed" && input.event.type !== "turn.aborted") return;
    const evaluation = yield* Effect.serviceOption(RouterEvaluationService);
    if (Option.isNone(evaluation)) return;
    const existing = yield* Dispatcher.readDispatcherTaskRoute({
      threadId: input.threadId,
      messageId: input.messageId,
    });
    if (Option.isNone(existing)) return;
    const nowMs = yield* Clock.currentTimeMillis;
    const now = DateTime.formatIso(DateTime.makeUnsafe(nowMs));
    const timingService = yield* Effect.serviceOption(TurnTiming);
    const timing =
      input.timing ??
      (Option.isSome(timingService) && input.event.turnId !== undefined
        ? yield* timingService.value.take({
            environmentId: input.environmentId,
            threadId: input.threadId,
            turnId: input.event.turnId,
          })
        : undefined);
    const observation = buildTurnOutcomeObservation({
      environmentId: input.environmentId,
      threadId: input.threadId,
      messageId: input.messageId,
      event: input.event,
      binding: existing.value,
      nowMs,
      nowIso: now,
      ...(timing !== undefined ? { timing } : {}),
      ...(input.verifiedSingleStart === true ? { verifiedSingleStart: true } : {}),
    });
    yield* evaluation.value.recordObservation(observation, {
      threadId: input.threadId,
      messageId: input.messageId,
    });
    // Return optional enrichment work so the caller commits attribution and the outcome first.
    // Capacity admission must never wait while this observation transaction owns SQLite.
    return Effect.gen(function* () {
      const dream = yield* Effect.serviceOption(DreamMemoryService);
      const settingsService = yield* Effect.serviceOption(ServerSettingsService);
      if (Option.isSome(dream) && observation.terminalCategory === "success") {
        const settings = Option.isSome(settingsService)
          ? yield* settingsService.value.getSettings.pipe(
              Effect.catch(() => Effect.succeed({ dreamMemory: DEFAULT_DREAM_MEMORY_SETTINGS })),
            )
          : { dreamMemory: DEFAULT_DREAM_MEMORY_SETTINGS };
        const budget = yield* Effect.serviceOption(ConcurrencyBudgetService);
        const enqueue = dream.value.enqueueEligibleTurn({
          viewer: viewerFromSubject(input.environmentId, undefined, input.projectId),
          settings: settings.dreamMemory,
          turnSucceeded: true,
          turnText: `completed turn ${input.messageId}`,
          nowIso: now,
          threadId: input.threadId,
        });
        yield* (
          Option.isSome(budget)
            ? budget.value
                .withAdmission(
                  {
                    workloadClass: "dream-job",
                    environmentId: input.environmentId,
                    threadId: input.threadId,
                    requestedAt: now,
                  },
                  enqueue,
                )
                .pipe(Effect.catch(() => Effect.void))
            : enqueue
        ).pipe(Effect.ignore);
      }
      const previous = yield* evaluation.value.latestObservationForThread(
        input.environmentId,
        input.threadId,
        observation.observationId,
      );
      if (Option.isSome(previous)) {
        const proxy = detectReworkProxy({ previous: previous.value, next: observation, nowMs });
        if (proxy !== undefined) {
          yield* evaluation.value.recordReworkProxy(
            input.environmentId,
            previous.value.observationId,
            proxy,
          );
        }
      }
    });
  },
);

const isV2TerminalTurnStatus = (
  status: OrchestrationV2ProviderTurn["status"],
): status is "completed" | "failed" | "interrupted" | "cancelled" =>
  status === "completed" ||
  status === "failed" ||
  status === "interrupted" ||
  status === "cancelled";

/** Map a V2 provider turn into the observation runtime event. Cost stays unknown. */
export const runtimeEventFromV2ProviderTurn = (input: {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly providerTurn: OrchestrationV2ProviderTurn;
}): ProviderRuntimeEvent | undefined => {
  const status = input.providerTurn.status;
  if (!isV2TerminalTurnStatus(status)) return undefined;
  const at = input.providerTurn.completedAt ?? input.providerTurn.startedAt;
  const createdAt = at !== null ? DateTime.formatIso(at) : "1970-01-01T00:00:00.000Z";
  const tokenUsage = input.providerTurn.turnTokenUsage;
  return {
    type: "turn.completed",
    eventId: EventId.make(`turn-outcome:${input.providerTurn.id}`),
    provider: input.driver,
    providerInstanceId: input.providerInstanceId,
    threadId: input.threadId,
    createdAt,
    payload: {
      state: status,
      ...(tokenUsage === undefined ? {} : { tokenUsage }),
    },
  } as ProviderRuntimeEvent;
};

/**
 * Persist one V2 terminal provider turn into the router observation store.
 * Skips when identity, measurement, or the dispatcher binding is missing.
 * Duplicate observation ids merge; unknown cost is not fabricated.
 */
export const persistTurnOutcomeFromV2ProviderTurn = Effect.fn(
  "persistTurnOutcomeFromV2ProviderTurn",
)(function* (input: {
  readonly threadId: ThreadId;
  readonly runId?: RunId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly providerTurn: OrchestrationV2ProviderTurn;
  readonly getRunMessage: (
    threadId: ThreadId,
    runId: RunId,
  ) => Effect.Effect<{ readonly id: MessageId } | undefined, ProjectionStoreV2Error>;
}) {
  const event = runtimeEventFromV2ProviderTurn(input);
  if (event === undefined) return;
  if (input.runId === undefined) return;
  const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
  if (Option.isNone(sql)) return;
  const environment = yield* Effect.serviceOption(ServerEnvironment);
  if (Option.isNone(environment)) return;
  const message = yield* input.getRunMessage(input.threadId, input.runId);
  if (message === undefined) return;
  const environmentId = yield* environment.value.getEnvironmentId;
  const afterCommit = yield* sql.value
    .withTransaction(
      Effect.gen(function* () {
        const binding = yield* Dispatcher.readDispatcherTaskRoute({
          threadId: input.threadId,
          messageId: message.id,
        });
        const proof =
          Option.isSome(binding) && input.providerTurn.status === "completed"
            ? yield* verifiedSingleStartV2({
                environmentId,
                threadId: input.threadId,
                runId: input.runId!,
                messageId: message.id,
                providerTurnId: input.providerTurn.id,
                providerTurn: input.providerTurn,
                providerInstanceId: input.providerInstanceId,
                driver: input.driver,
                binding: binding.value,
              })
            : false;
        return yield* persistTurnOutcomeFromRuntimeEvent({
          environmentId,
          threadId: input.threadId,
          messageId: message.id,
          event,
          measurementEnabled: true,
          ...(proof ? { verifiedSingleStart: true as const } : {}),
        });
      }),
    )
    .pipe(Effect.provideService(SqlClient.SqlClient, sql.value));
  if (afterCommit !== undefined) yield* afterCommit;
});

const singleRun = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2Run)),
);
const singleAttempt = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2RunAttempt)),
);
const singleThread = Schema.decodeUnknownOption(
  Schema.fromJsonString(OrchestrationV2AppThreadJson),
);
const singleProviderThread = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2ProviderThread)),
);
const singleTurn = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2ProviderTurn)),
);
const singleNode = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2ExecutionNode)),
);
const singleMessage = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2ConversationMessage)),
);
const singleObservation = Schema.decodeUnknownOption(
  Schema.fromJsonString(TurnOutcomeObservationV0),
);
const isoTime = (value: DateTime.Utc | null | undefined) =>
  value == null ? null : DateTime.formatIso(value);

/** Empty bound routing history cannot certify execution. Read the physical execution chain instead. */
export const verifiedSingleStartV2 = Effect.fn("verifiedSingleStartV2")(
  function* (input: {
    environmentId: EnvironmentId;
    threadId: ThreadId;
    runId: RunId;
    messageId: MessageId;
    providerTurnId: string;
    providerTurn?: OrchestrationV2ProviderTurn;
    providerInstanceId: ProviderInstanceId;
    driver: ProviderDriverKind;
    binding: DispatcherTaskRouteBinding;
  }) {
    const sql = yield* SqlClient.SqlClient;
    const binding = input.binding;
    if (
      binding.modelRoute?.executionStatus !== "bound" ||
      binding.modelRoute.attempts?.length !== 0 ||
      binding.fallbackIndex !== 0 ||
      binding.target.instanceId !== input.providerInstanceId ||
      binding.driver !== input.driver ||
      binding.modelRoute.selected?.target.instanceId !== binding.target.instanceId ||
      binding.modelRoute.selected.target.model !== binding.target.model
    )
      return false;
    const threads = yield* sql<{
      thread_id: string;
      project_id: string;
      provider_instance_id: string;
      created_at: string;
      updated_at: string;
      payload_json: string;
    }>`
    SELECT t.thread_id,t.project_id,t.provider_instance_id,t.created_at,t.updated_at,t.payload_json FROM orchestration_v2_projection_threads t JOIN projection_projects p ON p.project_id=t.project_id
    WHERE t.thread_id=${input.threadId} AND t.archived_at IS NULL AND t.deleted_at IS NULL AND p.deleted_at IS NULL`;
    const tr = threads[0],
      decodedThread = tr ? singleThread(tr.payload_json) : Option.none();
    if (threads.length !== 1 || !tr || Option.isNone(decodedThread)) return false;
    const thread = decodedThread.value;
    if (
      thread.id !== tr.thread_id ||
      thread.projectId !== tr.project_id ||
      thread.providerInstanceId !== tr.provider_instance_id ||
      isoTime(thread.createdAt) !== tr.created_at ||
      isoTime(thread.updatedAt) !== tr.updated_at ||
      thread.taskGovernance !== "required" ||
      !thread.taskContract ||
      thread.creationSource === "provider" ||
      thread.lineage.rootThreadId !== thread.id ||
      thread.lineage.parentThreadId !== null ||
      thread.lineage.relationshipToParent !== null ||
      thread.forkedFrom !== null ||
      thread.archivedAt !== null ||
      thread.deletedAt !== null
    )
      return false;
    const runs = yield* sql<{
      run_id: string;
      thread_id: string;
      ordinal: number;
      provider_instance_id: string;
      provider_thread_id: string | null;
      status: string;
      requested_at: string;
      completed_at: string | null;
      payload_json: string;
    }>`
    SELECT run_id,thread_id,ordinal,provider_instance_id,provider_thread_id,status,requested_at,completed_at,payload_json FROM orchestration_v2_projection_runs WHERE thread_id=${input.threadId}`;
    const candidates: OrchestrationV2Run[] = [];
    for (const row of runs) {
      const parsed = singleRun(row.payload_json);
      if (Option.isNone(parsed)) return false;
      const r = parsed.value;
      if (
        r.id !== row.run_id ||
        r.threadId !== row.thread_id ||
        r.ordinal !== row.ordinal ||
        r.providerInstanceId !== row.provider_instance_id ||
        r.modelSelection.instanceId !== r.providerInstanceId ||
        r.providerThreadId !== row.provider_thread_id ||
        r.status !== row.status ||
        isoTime(r.requestedAt) !== row.requested_at ||
        isoTime(r.completedAt) !== row.completed_at
      )
        return false;
      if (r.userMessageId === input.messageId) candidates.push(r);
    }
    const run = candidates[0];
    if (
      candidates.length !== 1 ||
      !run ||
      run.id !== input.runId ||
      !run.activeAttemptId ||
      !run.rootNodeId ||
      !run.providerThreadId ||
      (run.status !== "running" && run.status !== "completed") ||
      run.providerInstanceId !== input.providerInstanceId ||
      run.modelSelection.instanceId !== binding.target.instanceId ||
      run.modelSelection.model !== binding.target.model
    )
      return false;
    const messages = yield* sql<{
      message_id: string;
      thread_id: string;
      run_id: string;
      role: string;
      payload_json: string;
    }>`SELECT message_id,thread_id,run_id,role,payload_json FROM orchestration_v2_projection_messages WHERE message_id=${input.messageId}`;
    const mr = messages[0],
      parsedMessage = mr ? singleMessage(mr.payload_json) : Option.none();
    if (
      messages.length !== 1 ||
      !mr ||
      Option.isNone(parsedMessage) ||
      mr.thread_id !== input.threadId ||
      mr.run_id !== run.id ||
      mr.role !== "user" ||
      parsedMessage.value.id !== mr.message_id ||
      parsedMessage.value.threadId !== input.threadId ||
      parsedMessage.value.runId !== run.id ||
      parsedMessage.value.role !== "user"
    )
      return false;
    const attempts = yield* sql<{
      attempt_id: string;
      thread_id: string;
      run_id: string;
      attempt_ordinal: number;
      root_node_id: string;
      provider_instance_id: string;
      provider_thread_id: string;
      provider_turn_id: string | null;
      status: string;
      payload_json: string;
    }>`
    SELECT attempt_id,thread_id,run_id,attempt_ordinal,root_node_id,provider_instance_id,provider_thread_id,provider_turn_id,status,payload_json FROM orchestration_v2_projection_run_attempts WHERE run_id=${run.id}`;
    const ar = attempts[0],
      parsedAttempt = ar ? singleAttempt(ar.payload_json) : Option.none();
    if (attempts.length !== 1 || !ar || Option.isNone(parsedAttempt)) return false;
    const attempt = parsedAttempt.value;
    if (
      ar.thread_id !== input.threadId ||
      attempt.id !== ar.attempt_id ||
      attempt.id !== run.activeAttemptId ||
      attempt.runId !== run.id ||
      ar.run_id !== run.id ||
      attempt.attemptOrdinal !== 1 ||
      ar.attempt_ordinal !== 1 ||
      attempt.reason !== "initial" ||
      attempt.rootNodeId !== run.rootNodeId ||
      ar.root_node_id !== run.rootNodeId ||
      attempt.providerInstanceId !== input.providerInstanceId ||
      ar.provider_instance_id !== input.providerInstanceId ||
      attempt.providerThreadId !== run.providerThreadId ||
      ar.provider_thread_id !== run.providerThreadId ||
      attempt.providerTurnId !== ar.provider_turn_id ||
      (attempt.providerTurnId !== null && attempt.providerTurnId !== input.providerTurnId) ||
      attempt.status !== ar.status ||
      (attempt.status !== "running" && attempt.status !== "completed")
    )
      return false;
    const providerThreads = yield* sql<{
      provider_thread_id: string;
      thread_id: string;
      provider_instance_id: string;
      driver: string;
      payload_json: string;
    }>`SELECT provider_thread_id,thread_id,provider_instance_id,driver,payload_json FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id=${run.providerThreadId}`;
    const pr = providerThreads[0],
      parsedProvider = pr ? singleProviderThread(pr.payload_json) : Option.none();
    if (
      providerThreads.length !== 1 ||
      !pr ||
      Option.isNone(parsedProvider) ||
      pr.thread_id !== input.threadId ||
      pr.provider_instance_id !== input.providerInstanceId ||
      pr.driver !== input.driver ||
      parsedProvider.value.id !== pr.provider_thread_id ||
      parsedProvider.value.appThreadId !== input.threadId ||
      parsedProvider.value.providerInstanceId !== input.providerInstanceId ||
      parsedProvider.value.driver !== input.driver
    )
      return false;
    const turns = yield* sql<{
      provider_turn_id: string;
      thread_id: string;
      provider_thread_id: string;
      node_id: string;
      run_attempt_id: string | null;
      ordinal: number;
      status: string;
      started_at: string | null;
      completed_at: string | null;
      payload_json: string;
    }>`
    SELECT provider_turn_id,thread_id,provider_thread_id,node_id,run_attempt_id,ordinal,status,started_at,completed_at,payload_json FROM orchestration_v2_projection_provider_turns
    WHERE run_attempt_id=${attempt.id} OR (thread_id=${input.threadId} AND node_id=${run.rootNodeId})`;
    const vr = turns[0],
      parsedTurn = vr ? singleTurn(vr.payload_json) : Option.none();
    if (turns.length !== 1 || !vr || Option.isNone(parsedTurn)) return false;
    const turn = parsedTurn.value;
    if (
      input.providerTurn !== undefined &&
      !Schema.toEquivalence(OrchestrationV2ProviderTurn)(input.providerTurn, turn)
    )
      return false;
    if (
      turn.id !== input.providerTurnId ||
      turn.id !== vr.provider_turn_id ||
      vr.thread_id !== input.threadId ||
      turn.providerThreadId !== run.providerThreadId ||
      vr.provider_thread_id !== run.providerThreadId ||
      turn.nodeId !== run.rootNodeId ||
      vr.node_id !== run.rootNodeId ||
      turn.runAttemptId !== attempt.id ||
      vr.run_attempt_id !== attempt.id ||
      turn.ordinal !== vr.ordinal ||
      turn.status !== "completed" ||
      vr.status !== "completed" ||
      !turn.startedAt ||
      !turn.completedAt ||
      isoTime(turn.startedAt) !== vr.started_at ||
      isoTime(turn.completedAt) !== vr.completed_at ||
      DateTime.toEpochMillis(turn.completedAt) < DateTime.toEpochMillis(turn.startedAt)
    )
      return false;
    const roots = yield* sql<{
      node_id: string;
      thread_id: string;
      run_id: string;
      parent_node_id: string | null;
      root_node_id: string;
      kind: string;
      status: string;
      provider_thread_id: string | null;
      provider_turn_id: string | null;
      started_at: string | null;
      completed_at: string | null;
      payload_json: string;
    }>`
    SELECT node_id,thread_id,run_id,parent_node_id,root_node_id,kind,status,provider_thread_id,provider_turn_id,started_at,completed_at,payload_json FROM orchestration_v2_projection_nodes WHERE node_id=${run.rootNodeId}`;
    const nr = roots[0],
      parsedRoot = nr ? singleNode(nr.payload_json) : Option.none();
    if (roots.length !== 1 || !nr || Option.isNone(parsedRoot)) return false;
    const root = parsedRoot.value;
    if (
      root.id !== nr.node_id ||
      root.threadId !== input.threadId ||
      nr.thread_id !== input.threadId ||
      root.runId !== run.id ||
      nr.run_id !== run.id ||
      root.parentNodeId !== null ||
      nr.parent_node_id !== null ||
      root.rootNodeId !== root.id ||
      nr.root_node_id !== root.id ||
      root.kind !== "root_turn" ||
      nr.kind !== root.kind ||
      !root.countsForRun ||
      !root.startedAt ||
      isoTime(root.startedAt) !== nr.started_at ||
      isoTime(root.completedAt) !== nr.completed_at ||
      DateTime.toEpochMillis(root.startedAt) > DateTime.toEpochMillis(turn.startedAt) ||
      (root.status !== "running" && root.status !== "completed") ||
      (root.status === "running" && root.completedAt !== null) ||
      (root.status === "completed" &&
        (root.completedAt === null ||
          DateTime.toEpochMillis(root.completedAt) < DateTime.toEpochMillis(turn.completedAt))) ||
      root.status !== nr.status ||
      root.providerThreadId !== nr.provider_thread_id ||
      root.providerTurnId !== nr.provider_turn_id ||
      (root.providerThreadId !== null && root.providerThreadId !== run.providerThreadId) ||
      (root.providerTurnId !== null && root.providerTurnId !== turn.id)
    )
      return false;
    const starts = yield* sql<{
      environment_id: string;
      root_thread_id: string;
      thread_id: string;
      run_id: string | null;
      message_id: string | null;
      provider_turn_id: string;
      provider_instance_id: string | null;
      contract_revision: number | null;
      status: string;
      attempt_role: string;
    }>`
    SELECT environment_id,root_thread_id,thread_id,run_id,message_id,provider_turn_id,provider_instance_id,contract_revision,status,attempt_role FROM task_usage_attempts
    WHERE provider_turn_id=${turn.id} OR (environment_id=${input.environmentId} AND root_thread_id=${input.threadId} AND (message_id=${input.messageId} OR run_id=${run.id} OR message_id IS NULL OR run_id IS NULL))`;
    const start = starts[0];
    if (
      starts.length !== 1 ||
      !start ||
      start.environment_id !== input.environmentId ||
      start.root_thread_id !== input.threadId ||
      start.thread_id !== input.threadId ||
      start.run_id !== run.id ||
      start.message_id !== input.messageId ||
      start.provider_turn_id !== turn.id ||
      start.provider_instance_id !== input.providerInstanceId ||
      start.contract_revision !== thread.taskContract.revision ||
      start.status !== "completed" ||
      start.attempt_role !== "primary"
    )
      return false;
    const previous = yield* sql<{
      observation_id: string;
      environment_id: string;
      thread_id: string;
      message_id: string;
      schema_version: string;
      recorded_at: string;
      payload_json: string;
    }>`
    SELECT observation_id,environment_id,thread_id,message_id,schema_version,recorded_at,payload_json FROM router_turn_observations WHERE (thread_id=${input.threadId} AND message_id=${input.messageId}) OR observation_id=${observationIdForTurn(input.environmentId, input.threadId, input.messageId)}`;
    if (previous.length > 1) return false;
    if (previous[0]) {
      const row = previous[0],
        obs = singleObservation(row.payload_json);
      if (
        Option.isNone(obs) ||
        row.thread_id !== input.threadId ||
        row.message_id !== input.messageId ||
        row.environment_id !== input.environmentId ||
        obs.value.environmentId !== row.environment_id ||
        obs.value.observationId !== row.observation_id ||
        obs.value.version !== row.schema_version ||
        obs.value.recordedAt !== row.recorded_at ||
        obs.value.providerAttempts !== 1 ||
        obs.value.fallbackCount !== 0 ||
        obs.value.terminalCategory !== "success" ||
        obs.value.model !== binding.target.model ||
        obs.value.instanceId !== binding.target.instanceId ||
        obs.value.driver !== binding.driver
      )
        return false;
    }
    return true;
  },
  Effect.orElseSucceed(() => false),
);
