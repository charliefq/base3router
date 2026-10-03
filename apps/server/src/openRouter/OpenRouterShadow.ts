import {
  type OpenRouterCostTier,
  type OpenRouterTeacherObservationV0,
  OPENROUTER_DEFAULT_COST_TIER,
  emptyOpenRouterObservation,
} from "@t3tools/contracts";
import {
  extractOpenRouterTaskType,
  taskProfileFromOpenRouterTag,
} from "@t3tools/shared/openRouterTaskProfile";
import { openRouterAgreement } from "@t3tools/shared/openRouterGuidance";
import {
  normalizeOpenRouterHttpStatus,
  normalizeOpenRouterTransportFailure,
} from "@t3tools/shared/openRouterErrors";
import { knownOrUnknown } from "@t3tools/shared/openRouterMarketPriors";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { createOpenRouterClient, type OpenRouterChatResult } from "./OpenRouterClient.ts";
import type { OpenRouterTransport } from "./OpenRouterTransport.ts";

type ShadowAbortReason = "cancelled" | "timeout" | "invalid_response";
type ShadowChatOutcome =
  | OpenRouterChatResult
  | { readonly status: 0; readonly content: ""; readonly skip: "cancelled" | "timeout" }
  | {
      readonly status: 0;
      readonly content: "";
      readonly category: ReturnType<typeof normalizeOpenRouterTransportFailure>["category"];
    };

const shadowAbortReason = (cause: unknown, signal?: AbortSignal): ShadowAbortReason => {
  const message = cause instanceof Error ? cause.message : String(cause);
  const name = cause instanceof Error ? cause.name : "";
  if (/timeout/i.test(message) || /timeout/i.test(name)) return "timeout";
  if (/abort|cancel/i.test(message) || /abort|cancel/i.test(name) || signal?.aborted === true) {
    return "cancelled";
  }
  return "invalid_response";
};

export const runOpenRouterShadowObservation = Effect.fn("runOpenRouterShadowObservation")(
  function* (input: {
    readonly apiKey: string;
    readonly prompt: string;
    readonly allowedModels: ReadonlyArray<string>;
    readonly costTier?: OpenRouterCostTier;
    readonly base3Model?: string;
    readonly transport?: OpenRouterTransport;
    readonly baseUrl?: string;
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
  }): Effect.fn.Return<OpenRouterTeacherObservationV0> {
    const client = createOpenRouterClient({
      apiKey: input.apiKey,
      ...(input.transport !== undefined ? { transport: input.transport } : {}),
      ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    });
    const started = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const costTier = input.costTier ?? OPENROUTER_DEFAULT_COST_TIER;
    const result: ShadowChatOutcome = yield* Effect.tryPromise({
      try: () =>
        client.chat({
          prompt: input.prompt,
          allowedModels: input.allowedModels,
          costTier,
          stream: false,
          shadow: true,
          ...(input.signal !== undefined ? { signal: input.signal } : {}),
        }),
      catch: (cause): ShadowAbortReason => shadowAbortReason(cause, input.signal),
    }).pipe(
      Effect.catch((reason): Effect.Effect<ShadowChatOutcome> => {
        if (reason === "cancelled" || reason === "timeout") {
          return Effect.succeed({
            status: 0,
            content: "",
            skip: reason,
          });
        }
        return Effect.succeed({
          status: 0,
          content: "",
          category: normalizeOpenRouterTransportFailure(reason).category,
        });
      }),
    );
    if ("skip" in result) {
      return emptyOpenRouterObservation({
        guidanceMode: "shadow",
        status: "skipped",
        skipReason: result.skip,
        errorCategory: result.skip,
        allowedModels: input.allowedModels,
        costTier,
        detail:
          result.skip === "cancelled"
            ? "Shadow observation cancelled with the turn."
            : "Shadow observation timed out.",
      });
    }
    if ("category" in result) {
      return emptyOpenRouterObservation({
        guidanceMode: "shadow",
        status: "failed",
        errorCategory: result.category,
        allowedModels: input.allowedModels,
        costTier,
        detail: "Shadow observation failed.",
      });
    }
    if (result.status >= 400) {
      const normalized = normalizeOpenRouterHttpStatus(result.status);
      return emptyOpenRouterObservation({
        guidanceMode: "shadow",
        status: "failed",
        errorCategory: normalized.category,
        allowedModels: input.allowedModels,
        costTier,
        detail: "Shadow observation failed.",
      });
    }
    const actual = result.model;
    const taskType = extractOpenRouterTaskType(result.metadata);
    return {
      ...emptyOpenRouterObservation({
        guidanceMode: "shadow",
        status: "observed",
        allowedModels: input.allowedModels,
        costTier,
      }),
      observedAt: started,
      taskProfile: taskProfileFromOpenRouterTag({ tag: taskType }),
      ...(actual !== undefined
        ? { openRouterSuggested: actual, actualExecutionModel: actual }
        : {}),
      ...(input.base3Model !== undefined && actual !== undefined
        ? {
            agreement: openRouterAgreement({
              base3Model: input.base3Model,
              openRouterModel: actual,
            }),
          }
        : {}),
      promptTokens: knownOrUnknown(result.usage?.promptTokens),
      completionTokens: knownOrUnknown(result.usage?.completionTokens),
      totalTokens: knownOrUnknown(result.usage?.totalTokens),
      reportedCostUsd: knownOrUnknown(result.usage?.cost),
    } satisfies OpenRouterTeacherObservationV0;
  },
);
