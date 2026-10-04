import {
  EnvironmentId,
  MessageId,
  ObservationId,
  TURN_OUTCOME_OBSERVATION_VERSION,
  UNKNOWN_TASK_PROFILE,
  emptyOutcomeEvidence,
  type DispatcherTaskRouteBinding,
  type ProviderRuntimeEvent,
  type ReworkSignalV0,
  type TurnOutcomeObservationV0,
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

import * as Dispatcher from "../dispatcher/Dispatcher.ts";
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
    providerAttempts: binding.modelRoute?.attempts?.length ?? 1,
    fallbackCount: Math.max(0, (binding.modelRoute?.attempts?.length ?? 1) - 1),
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

export const persistTurnOutcomeFromRuntimeEvent = Effect.fn("persistTurnOutcomeFromRuntimeEvent")(
  function* (input: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
    readonly event: ProviderRuntimeEvent;
    readonly measurementEnabled: boolean;
    readonly timing?: TurnTimingSnapshot;
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
    });
    yield* evaluation.value.recordObservation(observation, {
      threadId: input.threadId,
      messageId: input.messageId,
    });
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
        viewer: viewerFromSubject(input.environmentId, undefined),
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
  },
);
