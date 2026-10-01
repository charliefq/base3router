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

import { createOpenRouterClient } from "./OpenRouterClient.ts";
import type { OpenRouterTransport } from "./OpenRouterTransport.ts";

export const runOpenRouterShadowObservation = Effect.fn("runOpenRouterShadowObservation")(
  function* (input: {
    readonly apiKey: string;
    readonly prompt: string;
    readonly allowedModels: ReadonlyArray<string>;
    readonly costTier?: OpenRouterCostTier;
    readonly base3Model?: string;
    readonly transport?: OpenRouterTransport;
    readonly baseUrl?: string;
  }) {
    const client = createOpenRouterClient({
      apiKey: input.apiKey,
      ...(input.transport !== undefined ? { transport: input.transport } : {}),
      ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
    });
    const started = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const costTier = input.costTier ?? OPENROUTER_DEFAULT_COST_TIER;
    const result = yield* Effect.tryPromise({
      try: () =>
        client.chat({
          prompt: input.prompt,
          allowedModels: input.allowedModels,
          costTier,
          stream: false,
          shadow: true,
        }),
      catch: (cause) => {
        const message = cause instanceof Error ? cause.message : String(cause);
        return /timeout/i.test(message)
          ? ("timeout" as const)
          : /abort|cancel/i.test(message)
            ? ("cancelled" as const)
            : ("invalid_response" as const);
      },
    }).pipe(
      Effect.catch((reason) => {
        const normalized = normalizeOpenRouterTransportFailure(reason);
        return Effect.succeed({
          status: 0,
          content: "",
          category: normalized.category,
        });
      }),
    );
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
