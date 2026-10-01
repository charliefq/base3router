import {
  EventId,
  OPENROUTER_AUTO_SLUG,
  OPENROUTER_DEFAULT_COST_TIER,
  OPENROUTER_DRIVER_KIND,
  OPENROUTER_OBSERVATION_VERSION,
  OPENROUTER_GUIDANCE_POLICY_VERSION,
  OPENROUTER_PHASE10_PRIVACY_POLICY,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  type OpenRouterCostTier,
  type OpenRouterTeacherObservationV0,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderTurnStartResult,
  TurnId,
  emptyOpenRouterObservation,
} from "@t3tools/contracts";
import {
  extractOpenRouterTaskType,
  taskProfileFromOpenRouterTag,
} from "@t3tools/shared/openRouterTaskProfile";
import { actualModelIsAllowed } from "@t3tools/shared/openRouterIdentity";
import { normalizeOpenRouterHttpStatus } from "@t3tools/shared/openRouterErrors";
import { summarizeOpenRouterMetadata } from "@t3tools/shared/openRouterMetadata";
import { knownOrUnknown } from "@t3tools/shared/openRouterMarketPriors";
import { openRouterAgreement } from "@t3tools/shared/openRouterGuidance";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import {
  createOpenRouterClient,
  type OpenRouterChatResult,
  type OpenRouterClient,
} from "../../openRouter/OpenRouterClient.ts";
import type { OpenRouterTransport } from "../../openRouter/OpenRouterTransport.ts";

const DRIVER = ProviderDriverKind.make(OPENROUTER_DRIVER_KIND);

type SessionRecord = {
  readonly session: ProviderSession;
  abort?: AbortController;
};

export type OpenRouterAdapterOptions = {
  readonly instanceId: ProviderInstanceId;
  readonly apiKey: string | undefined;
  readonly baseUrl?: string;
  readonly transport?: OpenRouterTransport;
  readonly costTier?: OpenRouterCostTier;
  readonly allowedModels?: ReadonlyArray<string>;
};

const nowIso = DateTime.now.pipe(
  Effect.map(DateTime.formatIso),
  Effect.mapError(
    (cause) =>
      new ProviderAdapterRequestError({
        provider: DRIVER,
        method: "clock/now",
        detail: "Could not read the current time.",
        cause,
      }),
  ),
);

const observationFromChat = (input: {
  readonly result: OpenRouterChatResult;
  readonly allowedModels: ReadonlyArray<string>;
  readonly costTier: OpenRouterCostTier;
  readonly observedAt: string;
}): OpenRouterTeacherObservationV0 => {
  const actual = input.result.model;
  const metadata = summarizeOpenRouterMetadata(input.result.metadata);
  const taskType = extractOpenRouterTaskType(input.result.metadata);
  return {
    version: OPENROUTER_OBSERVATION_VERSION,
    policyVersion: OPENROUTER_GUIDANCE_POLICY_VERSION,
    guidanceMode: "teacher",
    status: "observed",
    observedAt: input.observedAt,
    taskProfile: taskProfileFromOpenRouterTag({ tag: taskType }),
    ...(actual !== undefined ? { openRouterSuggested: actual, actualExecutionModel: actual } : {}),
    requestedRouterTarget: OPENROUTER_AUTO_SLUG,
    allowedModels: [...input.allowedModels],
    costTier: input.costTier,
    privacyPolicy: OPENROUTER_PHASE10_PRIVACY_POLICY,
    agreement: "inapplicable",
    ...(metadata !== undefined ? { routingMetadata: metadata } : {}),
    nestedFallbacks: metadata?.nestedAttempts ?? [],
    promptTokens: knownOrUnknown(input.result.usage?.promptTokens),
    completionTokens: knownOrUnknown(input.result.usage?.completionTokens),
    totalTokens: knownOrUnknown(input.result.usage?.totalTokens),
    reportedCostUsd: knownOrUnknown(input.result.usage?.cost),
  };
};

export const makeOpenRouterAdapter = Effect.fn("makeOpenRouterAdapter")(function* (
  options: OpenRouterAdapterOptions,
) {
  const crypto = yield* Crypto.Crypto;
  const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const sessions = yield* Ref.make(new Map<string, SessionRecord>());
  const client: OpenRouterClient | null =
    options.apiKey === undefined
      ? null
      : createOpenRouterClient({
          apiKey: options.apiKey,
          ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
          ...(options.transport !== undefined ? { transport: options.transport } : {}),
        });

  const newId = crypto.randomUUIDv4.pipe(
    Effect.mapError(
      (cause) =>
        new ProviderAdapterRequestError({
          provider: DRIVER,
          method: "crypto/randomUUIDv4",
          detail: "Could not create an OpenRouter runtime identifier.",
          cause,
        }),
    ),
  );
  const emit = (event: ProviderRuntimeEvent) => PubSub.publish(events, event).pipe(Effect.asVoid);

  const failMissingKey = (method: string) =>
    new ProviderAdapterRequestError({
      provider: DRIVER,
      method,
      detail: "OpenRouter API key is not configured.",
      failureCategory: "authentication_failed",
      failureScope: "provider_instance",
    });

  const adapter: ProviderAdapterShape<
    | ProviderAdapterRequestError
    | ProviderAdapterSessionNotFoundError
    | ProviderAdapterValidationError
  > = {
    provider: DRIVER,
    capabilities: {
      sessionModelSwitch: "in-session",
      supportsConversationRollback: false,
    },
    startSession: (input) =>
      Effect.gen(function* () {
        const createdAt = yield* nowIso;
        const session: ProviderSession = {
          provider: DRIVER,
          providerInstanceId: options.instanceId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          threadId: input.threadId,
          createdAt,
          updatedAt: createdAt,
          ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
          ...(input.modelSelection?.model !== undefined
            ? { model: input.modelSelection.model }
            : {}),
        };
        yield* Ref.update(sessions, (current) => {
          const next = new Map(current);
          next.set(input.threadId, { session });
          return next;
        });
        return session;
      }),
    sendTurn: (input) =>
      Effect.gen(function* () {
        if (client === null) return yield* failMissingKey("sendTurn");
        const current = yield* Ref.get(sessions);
        const record = current.get(input.threadId);
        if (record === undefined) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: DRIVER,
            threadId: input.threadId,
          });
        }
        const turnId = TurnId.make(yield* newId);
        const itemId = RuntimeItemId.make(yield* newId);
        const createdAt = yield* nowIso;
        const allowedModels = input.openRouter?.allowedModels ?? options.allowedModels ?? [];
        const costTier =
          input.openRouter?.costTier ?? options.costTier ?? OPENROUTER_DEFAULT_COST_TIER;
        const abort = new AbortController();
        const prompt = input.input ?? "";
        let deltaSeq = 0;

        const base = {
          eventId: EventId.make(yield* newId),
          provider: DRIVER,
          providerInstanceId: options.instanceId,
          threadId: input.threadId,
          createdAt,
          turnId,
        };

        yield* Ref.update(sessions, (map) => {
          const next = new Map(map);
          next.set(input.threadId, { ...record, abort });
          return next;
        });

        yield* emit({ ...base, type: "turn.started", payload: {} });
        yield* emit({
          ...base,
          eventId: EventId.make(yield* newId),
          itemId,
          type: "item.started",
          payload: { itemType: "assistant_message", status: "inProgress" },
        });

        const result = yield* Effect.tryPromise({
          try: () =>
            client.chat({
              prompt,
              allowedModels,
              costTier,
              stream: true,
              shadow: false,
              signal: abort.signal,
              onDelta: (delta) => {
                deltaSeq += 1;
                void Effect.runPromise(
                  emit({
                    ...base,
                    eventId: EventId.make(`${turnId}-delta-${deltaSeq}`),
                    itemId,
                    createdAt,
                    type: "content.delta",
                    payload: { streamKind: "assistant_text", delta },
                  }).pipe(Effect.ignore),
                );
              },
            }),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: DRIVER,
              method: "sendTurn",
              detail: cause instanceof Error ? cause.message : "OpenRouter request failed.",
              failureCategory: "transient_transport",
              failureScope: "provider_instance",
            }),
        }).pipe(
          Effect.catch((error) => {
            const requestError = Schema.is(ProviderAdapterRequestError)(error) ? error : undefined;
            return Effect.succeed({
              status: 0,
              content: "",
              requestError,
            } as const);
          }),
        );

        if ("requestError" in result || result.status >= 400) {
          const normalized =
            result.status >= 400
              ? normalizeOpenRouterHttpStatus(result.status)
              : {
                  category: "transient_transport" as const,
                  failureCategory: "transient_transport" as const,
                  failureScope: "provider_instance" as const,
                };
          yield* emit({
            ...base,
            eventId: EventId.make(yield* newId),
            type: "turn.completed",
            payload: {
              state: "failed",
              errorMessage: "OpenRouter request failed.",
              failureCategory: normalized.failureCategory,
              failureScope: normalized.failureScope,
              openRouter: emptyOpenRouterObservation({
                guidanceMode: "teacher",
                status: "failed",
                errorCategory: normalized.category,
                allowedModels,
                costTier,
                detail: "OpenRouter request failed.",
              }),
            },
          });
          return { threadId: input.threadId, turnId } satisfies ProviderTurnStartResult;
        }
        const actual = result.model ?? OPENROUTER_AUTO_SLUG;
        if (allowedModels.length > 0 && !actualModelIsAllowed(actual, allowedModels)) {
          yield* emit({
            ...base,
            eventId: EventId.make(yield* newId),
            type: "turn.completed",
            payload: {
              state: "failed",
              errorMessage: "OpenRouter returned a model outside the allowed set.",
              failureCategory: "non_retryable_request",
              failureScope: "global",
              openRouter: {
                ...emptyOpenRouterObservation({
                  guidanceMode: "teacher",
                  status: "policy_violation",
                  errorCategory: "policy_violation",
                  allowedModels,
                  costTier,
                  detail: "Returned model was outside the Base3Router allowlist.",
                }),
                actualExecutionModel: actual,
                requestedRouterTarget: OPENROUTER_AUTO_SLUG,
                agreement: openRouterAgreement({
                  base3Model: OPENROUTER_AUTO_SLUG,
                  openRouterModel: actual,
                }),
              },
            },
          });
          return { threadId: input.threadId, turnId } satisfies ProviderTurnStartResult;
        }
        if (actual !== OPENROUTER_AUTO_SLUG) {
          yield* emit({
            ...base,
            eventId: EventId.make(yield* newId),
            type: "model.rerouted",
            payload: {
              fromModel: OPENROUTER_AUTO_SLUG,
              toModel: actual,
              reason: "OpenRouter Auto selected an eligible model.",
            },
          });
        }
        const observation = observationFromChat({
          result,
          allowedModels,
          costTier,
          observedAt: createdAt,
        });
        yield* emit({
          ...base,
          eventId: EventId.make(yield* newId),
          itemId,
          type: "item.completed",
          payload: { itemType: "assistant_message", status: "completed" },
        });
        yield* emit({
          ...base,
          eventId: EventId.make(yield* newId),
          type: "turn.completed",
          payload: {
            state: "completed",
            ...(result.usage?.cost !== undefined ? { totalCostUsd: result.usage.cost } : {}),
            openRouter: observation,
          },
        });
        return { threadId: input.threadId, turnId } satisfies ProviderTurnStartResult;
      }),
    interruptTurn: (threadId) =>
      Effect.gen(function* () {
        const record = (yield* Ref.get(sessions)).get(threadId);
        record?.abort?.abort("cancelled");
      }),
    respondToRequest: () =>
      Effect.fail(
        new ProviderAdapterValidationError({
          provider: DRIVER,
          operation: "respondToRequest",
          issue: "OpenRouter Phase 10 does not execute tools.",
        }),
      ),
    respondToUserInput: () =>
      Effect.fail(
        new ProviderAdapterValidationError({
          provider: DRIVER,
          operation: "respondToUserInput",
          issue: "OpenRouter Phase 10 does not execute tools.",
        }),
      ),
    stopSession: (threadId) =>
      Ref.update(sessions, (map) => {
        const next = new Map(map);
        next.get(threadId)?.abort?.abort("cancelled");
        next.delete(threadId);
        return next;
      }),
    listSessions: () =>
      Effect.map(Ref.get(sessions), (map) => [...map.values()].map((entry) => entry.session)),
    hasSession: (threadId) => Effect.map(Ref.get(sessions), (map) => map.has(threadId)),
    readThread: (threadId) => Effect.succeed({ threadId, turns: [] }),
    rollbackThread: () =>
      Effect.fail(
        new ProviderAdapterValidationError({
          provider: DRIVER,
          operation: "rollbackThread",
          issue: "OpenRouter sessions do not support rollback.",
        }),
      ),
    stopAll: () =>
      Ref.update(sessions, (map) => {
        for (const record of map.values()) record.abort?.abort("cancelled");
        return new Map();
      }),
    streamEvents: Stream.fromPubSub(events),
  };

  return adapter;
});
