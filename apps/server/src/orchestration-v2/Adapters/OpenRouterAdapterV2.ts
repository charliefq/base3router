import {
  NodeId,
  ProviderDriverKind,
  ProviderThreadId,
  ProviderTurnId,
  TurnItemId,
  MessageId,
  type ProviderInstanceId,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2TurnItem,
  type OrchestrationV2ExecutionNode,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as P from "../ProviderAdapter.ts";
import { makeProviderFailure } from "../ProviderFailure.ts";
import { OpenRouterTransportError, streamOpenRouter } from "./OpenRouterTransport.ts";

export const OPENROUTER_DRIVER = ProviderDriverKind.make("openrouter");
const capabilities: OrchestrationV2ProviderCapabilities = {
  runtimePolicy: { enforcement: "client-boundary" },
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: true,
    supportsRuntimeModeSwitchInSession: true,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: false,
    canRollbackThread: false,
    canForkThread: false,
    canForkFromTurn: false,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: false,
  },
  turns: {
    exposesNativeTurnId: true,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: false,
    supportsSteeringByInterruptRestart: false,
    supportsQueuedMessages: true,
    terminalStatusQuality: "weak",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: false,
    streamsToolOutput: false,
    streamsPlanText: false,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: false,
    emitsToolStarted: false,
    emitsToolCompleted: false,
    emitsToolOutput: false,
    supportsMcpTools: false,
    supportsDynamicToolCallbacks: false,
  },
  approvals: {
    supportsCommandApproval: false,
    supportsFileReadApproval: false,
    supportsFileChangeApproval: false,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: false,
    approvalCallbacksAreLiveOnly: false,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: false,
    emitsTodoList: false,
    emitsProposedPlan: false,
    supportsStructuredQuestions: false,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: false,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: false,
    canWaitForSubagents: false,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: true,
    canGenerateSummaries: false,
    canConsumeHandoffSummaries: true,
    supportsDeltaHandoff: false,
    supportsFullThreadHandoff: true,
    maxRecommendedHandoffChars: 100_000,
  },
  checkpointing: {
    appCanCheckpointFilesystem: true,
    supportsNestedCheckpointScopes: false,
    providerCanRollbackConversation: false,
    providerRollbackReturnsSnapshot: false,
    providerCanReadConversationSnapshot: false,
  },
  identity: {
    nativeThreadIds: "none",
    nativeTurnIds: "strong",
    nativeItemIds: "none",
    nativeRequestIds: "none",
  },
};

/** Transport and credential access are captured per instance; tests inject only these boundaries. */
export function makeOpenRouterAdapter(input: {
  readonly instanceId: ProviderInstanceId;
  readonly enabled: boolean;
  readonly models: ReadonlyArray<string>;
  readonly apiKey: Effect.Effect<string | null>;
  readonly fetch?: typeof globalThis.fetch;
}): P.ProviderAdapterV2Shape {
  const driver = OPENROUTER_DRIVER;
  const unsupported = (detail: string) => new P.ProviderAdapterProtocolError({ driver, detail });
  // Survives session idle release within this instance. Durable replay admission remains engine-owned.
  const attempts = new Set<string>();
  return {
    instanceId: input.instanceId,
    driver,
    getCapabilities: () => Effect.succeed(capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (sessionInput) =>
      Effect.gen(function* () {
        const scope = yield* Scope.Scope;
        const events = yield* Queue.unbounded<P.ProviderAdapterV2Event>();
        const now = yield* DateTime.now;
        const active = new Map<
          string,
          { controller: AbortController; cancel: () => Effect.Effect<void> }
        >();
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            for (const item of active.values()) item.controller.abort();
          }),
        );
        const emit = (event: P.ProviderAdapterV2Event) =>
          Queue.offer(events, event).pipe(Effect.asVoid);
        return {
          instanceId: input.instanceId,
          driver,
          providerSessionId: sessionInput.providerSessionId,
          requiresConversationHistory: true,
          providerSession: {
            id: sessionInput.providerSessionId,
            driver,
            providerInstanceId: input.instanceId,
            status: "ready",
            cwd: sessionInput.runtimePolicy.cwd ?? "/",
            model: sessionInput.modelSelection.model,
            capabilities,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.fromQueue(events),
          ensureThread: (value) =>
            Effect.gen(function* () {
              const at = yield* DateTime.now;
              return {
                id: ProviderThreadId.make(`openrouter:${value.threadId}`),
                driver,
                providerInstanceId: input.instanceId,
                providerSessionId: sessionInput.providerSessionId,
                appThreadId: value.threadId,
                ownerNodeId: null,
                nativeThreadRef: null,
                nativeConversationHeadRef: null,
                status: "idle" as const,
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                createdAt: at,
                updatedAt: at,
              };
            }),
          resumeThread: ({ providerThread }) =>
            Effect.succeed({
              ...providerThread,
              providerSessionId: sessionInput.providerSessionId,
            }),
          startTurn: (turn) =>
            Effect.gen(function* () {
              if (attempts.has(turn.attemptId)) return;
              if (!input.enabled || !input.models.includes(turn.modelSelection.model))
                return yield* unsupported(
                  "Enable OpenRouter text execution and select a configured model in Settings > Providers",
                );
              if (
                turn.message.attachments.length ||
                turn.runtimePolicy.interactionMode !== "default" ||
                (turn.modelSelection.options?.length ?? 0)
              )
                return yield* unsupported(
                  "OpenRouter execution supports plain text only; images, tools, planning and model options are unsupported",
                );
              const history = turn.conversationHistory ?? [];
              const messages = [
                ...history.map((item) => ({ role: item.role, content: item.text })),
                { role: "user" as const, content: turn.message.text },
              ];
              if (messages.reduce((n, item) => n + item.content.length, 0) > 100_000)
                return yield* unsupported(
                  "OpenRouter text history exceeds the supported 100000 character limit; start a new task",
                );
              // Reserve before the credential read can yield, so concurrent replays cannot both start.
              attempts.add(turn.attemptId);
              const apiKey = yield* input.apiKey;
              if (!apiKey) {
                attempts.delete(turn.attemptId);
                return yield* unsupported(
                  "Save an OpenRouter API key in Settings > Providers before execution",
                );
              }

              const controller = new AbortController();
              const startedAt = yield* DateTime.now;
              const providerTurnId = ProviderTurnId.make(`openrouter:${turn.attemptId}`);
              const nodeId = NodeId.make(`openrouter:answer:${turn.attemptId}`);
              let providerTurn: OrchestrationV2ProviderTurn = {
                id: providerTurnId,
                providerThreadId: turn.providerThread.id,
                nodeId: turn.rootNodeId,
                runAttemptId: turn.attemptId,
                nativeTurnRef: null,
                ordinal: turn.providerTurnOrdinal,
                status: "running",
                startedAt,
                completedAt: null,
                modelIdentity: { requested: turn.modelSelection.model },
              };
              let text = "";
              let settled = false;
              const publishTurn = () =>
                emit({
                  type: "provider_turn.updated",
                  driver,
                  threadId: turn.threadId,
                  providerTurn,
                });
              const publishText = (status: "running" | "completed" | "failed") =>
                Effect.gen(function* () {
                  const at = yield* DateTime.now;
                  const node: OrchestrationV2ExecutionNode = {
                    id: nodeId,
                    threadId: turn.threadId,
                    runId: turn.runId,
                    parentNodeId: turn.rootNodeId,
                    rootNodeId: turn.rootNodeId,
                    kind: "assistant_message",
                    status,
                    countsForRun: false,
                    providerThreadId: turn.providerThread.id,
                    providerTurnId,
                    nativeItemRef: null,
                    runtimeRequestId: null,
                    checkpointScopeId: null,
                    startedAt,
                    completedAt: status === "running" ? null : at,
                  };
                  const turnItem: OrchestrationV2TurnItem = {
                    id: TurnItemId.make(`openrouter:answer:${turn.attemptId}`),
                    messageId: MessageId.make(`openrouter:answer:${turn.attemptId}`),
                    threadId: turn.threadId,
                    runId: turn.runId,
                    nodeId,
                    providerThreadId: turn.providerThread.id,
                    providerTurnId,
                    nativeItemRef: null,
                    parentItemId: null,
                    ordinal: 1,
                    type: "assistant_message",
                    status,
                    title: null,
                    startedAt,
                    completedAt: status === "running" ? null : at,
                    updatedAt: at,
                    text,
                    streaming: status === "running",
                  };
                  yield* emit({ type: "node.updated", driver, node });
                  yield* emit({ type: "turn_item.updated", driver, turnItem });
                });
              const fail = (code: string) =>
                Effect.gen(function* () {
                  if (settled) return;
                  settled = true;
                  active.delete(providerTurnId);
                  const completedAt = yield* DateTime.now;
                  if (text !== "") yield* publishText("failed");
                  providerTurn = {
                    ...providerTurn,
                    status: "failed",
                    completedAt,
                    terminationConfirmed: false,
                  };
                  yield* publishTurn();
                  yield* emit({
                    type: "turn.terminal",
                    driver,
                    providerThreadId: turn.providerThread.id,
                    providerTurnId,
                    runOrdinal: turn.runOrdinal,
                    failureItemOrdinal: 2,
                    status: "failed",
                    failure: makeProviderFailure({
                      class: "unknown",
                      retryable: false,
                      code: `openrouter_${code}`,
                      message: `OpenRouter ${code}. Remote completion and billing are unknown. No automatic retry was made.`,
                    }),
                    threadDisposition: "broken",
                  });
                });
              active.set(providerTurnId, {
                controller,
                cancel: () => fail("cancelled_termination_unknown"),
              });
              yield* publishTurn();
              const run = Stream.fromAsyncIterable(
                streamOpenRouter({
                  fetch: input.fetch ?? globalThis.fetch,
                  apiKey,
                  model: turn.modelSelection.model,
                  messages,
                  signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]),
                }),
                (cause) =>
                  cause instanceof OpenRouterTransportError
                    ? cause
                    : new OpenRouterTransportError("interrupted"),
              ).pipe(
                Stream.runForEach((chunk) =>
                  Effect.gen(function* () {
                    if (settled) return;
                    const resolvedModel =
                      chunk.model === "openrouter/auto" || chunk.model === "openrouter/auto-beta"
                        ? undefined
                        : chunk.model;
                    if (
                      resolvedModel &&
                      providerTurn.modelIdentity?.resolved &&
                      resolvedModel !== providerTurn.modelIdentity.resolved
                    )
                      return yield* Effect.fail(new OpenRouterTransportError("protocol"));
                    providerTurn = {
                      ...providerTurn,
                      ...(resolvedModel
                        ? {
                            modelIdentity: {
                              requested: turn.modelSelection.model,
                              resolved: resolvedModel,
                            },
                          }
                        : {}),
                      ...(chunk.id
                        ? {
                            nativeTurnRef: {
                              driver,
                              nativeId: chunk.id,
                              strength: "strong" as const,
                            },
                          }
                        : {}),
                      ...(chunk.usage
                        ? {
                            turnTokenUsage: {
                              usageScope: "main_agent" as const,
                              hasSubagents: false,
                              usageStatus: "complete" as const,
                              inputTokens: chunk.usage.input,
                              outputTokens: chunk.usage.output,
                            },
                            ...(chunk.usage.cost === undefined
                              ? {}
                              : { reportedCostUsd: chunk.usage.cost }),
                          }
                        : {}),
                    };
                    yield* publishTurn();
                    text += chunk.text;
                    if (chunk.text) yield* publishText("running");
                  }),
                ),
                Effect.flatMap(() =>
                  Effect.gen(function* () {
                    if (settled) return;
                    settled = true;
                    active.delete(providerTurnId);
                    yield* publishText("completed");
                    providerTurn = {
                      ...providerTurn,
                      status: "completed",
                      terminationConfirmed: true,
                      completedAt: yield* DateTime.now,
                    };
                    yield* publishTurn();
                    yield* emit({
                      type: "turn.terminal",
                      driver,
                      providerThreadId: turn.providerThread.id,
                      providerTurnId,
                      runOrdinal: turn.runOrdinal,
                      status: "completed",
                      failure: null,
                      threadDisposition: "reusable",
                    });
                  }),
                ),
                Effect.catch((error) => fail(error.code)),
                Effect.ensuring(Effect.sync(() => controller.abort())),
              );
              yield* run.pipe(Effect.forkIn(scope));
            }),
          steerTurn: ({ providerThread }) =>
            Effect.fail(
              new P.ProviderAdapterSteerRunUnsupportedError({
                driver,
                providerThreadId: providerThread.id,
              }),
            ),
          interruptTurn: ({ providerTurnId }) =>
            Effect.gen(function* () {
              const item = active.get(providerTurnId);
              if (item) {
                item.controller.abort();
                yield* item.cancel();
              }
            }),
          respondToRuntimeRequest: () =>
            Effect.fail(unsupported("OpenRouter text execution has no tool or approval callbacks")),
          readThreadSnapshot: () =>
            Effect.fail(
              unsupported(
                "OpenRouter has no native conversation snapshot; use persisted app history",
              ),
            ),
          rollbackThread: () =>
            Effect.fail(unsupported("OpenRouter native rollback is unsupported")),
          forkThread: () => Effect.fail(unsupported("OpenRouter native fork is unsupported")),
        } satisfies P.ProviderAdapterV2SessionRuntime;
      }),
  };
}
