import {
  EnvironmentId,
  MessageId,
  ObservationId,
  TURN_OUTCOME_OBSERVATION_VERSION,
  UNKNOWN_TASK_PROFILE,
  emptyOutcomeEvidence,
  type DispatcherTaskRouteBinding,
  type ProviderRuntimeEvent,
  type TurnOutcomeObservationV0,
  type ThreadId,
} from "@t3tools/contracts";
import {
  costFromReportedAndEstimate,
  timingFromClock,
  usageFromOpenRouter,
} from "@t3tools/shared/turnOutcome";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as Dispatcher from "../dispatcher/Dispatcher.ts";
import { RouterEvaluationService } from "./RouterEvaluationService.ts";

export const persistTurnOutcomeFromRuntimeEvent = Effect.fn("persistTurnOutcomeFromRuntimeEvent")(
  function* (input: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
    readonly event: ProviderRuntimeEvent;
    readonly measurementEnabled: boolean;
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
    const binding: DispatcherTaskRouteBinding = existing.value;
    const nowMs = yield* Clock.currentTimeMillis;
    const now = DateTime.formatIso(DateTime.makeUnsafe(nowMs));
    const cancelled = input.event.type === "turn.aborted";
    const openRouter = binding.openRouter;
    const observation: TurnOutcomeObservationV0 = {
      version: TURN_OUTCOME_OBSERVATION_VERSION,
      observationId: ObservationId.make(
        `${input.environmentId}:${input.threadId}:${input.messageId}`,
      ),
      environmentId: input.environmentId,
      recordedAt: now,
      policyVersion:
        binding.modelRoute?.policyVersion ?? binding.hybrid?.policyVersion ?? "model-router.v0",
      routingMode: binding.modelRoute?.mode ?? "auto",
      model: binding.target.model,
      instanceId: binding.target.instanceId,
      driver: binding.driver,
      actualExecutionModel: openRouter?.actualExecutionModel ?? binding.target.model,
      taskProfile: openRouter?.taskProfile ?? UNKNOWN_TASK_PROFILE,
      timing: timingFromClock({
        terminalMs: nowMs,
        iso: (ms) => DateTime.formatIso(DateTime.makeUnsafe(ms)),
      }),
      usage: usageFromOpenRouter({
        observedAt: now,
        ...(openRouter?.promptTokens?.status === "known"
          ? { promptTokens: openRouter.promptTokens.value }
          : {}),
        ...(openRouter?.completionTokens?.status === "known"
          ? { completionTokens: openRouter.completionTokens.value }
          : {}),
        ...(openRouter?.totalTokens?.status === "known"
          ? { totalTokens: openRouter.totalTokens.value }
          : {}),
      }),
      cost: costFromReportedAndEstimate({
        observedAt: now,
        ...(openRouter?.reportedCostUsd?.status === "known"
          ? { reportedUsd: openRouter.reportedCostUsd.value }
          : {}),
      }),
      providerAttempts: binding.modelRoute?.attempts?.length ?? 1,
      fallbackCount: Math.max(0, (binding.modelRoute?.attempts?.length ?? 1) - 1),
      cancelled,
      timedOut: false,
      finishReason: cancelled ? "cancelled" : "stop",
      terminalCategory: cancelled
        ? "cancelled"
        : input.event.type === "turn.completed"
          ? "success"
          : "unknown",
      evidence: emptyOutcomeEvidence(),
      ...(binding.hybrid !== undefined ? { hybrid: binding.hybrid } : {}),
      ...(openRouter?.agreement !== undefined ? { openRouterAgreement: openRouter.agreement } : {}),
      eligibleCandidateCount: binding.modelRoute?.candidates.filter(
        (candidate) => candidate.eligible,
      ).length,
    };
    yield* evaluation.value.recordObservation(observation);
  },
);
