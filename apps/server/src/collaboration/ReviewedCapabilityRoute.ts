// These digests compare persisted authority, not transport encodings.
// @effect-diagnostics preferSchemaOverJson:off
import { classifyLocalTask } from "@t3tools/shared/routerEvaluation";
import { modelRouterCatalogFromProviders } from "@t3tools/shared/modelRouter";
import {
  EnvironmentId,
  MessageId,
  ThreadId,
  MODEL_ROUTER_POLICY_VERSION,
  TaskCapabilityStep,
  type ModelSelection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  bindDispatcherTurnStartCommand,
  persistDispatcherTaskRoute,
  readDispatcherTaskRoute,
  readDispatcherProjectedState,
} from "../dispatcher/Dispatcher.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import * as RouterEvaluation from "../routerEvaluation/RouterEvaluationService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { argumentHash } from "../policy/grantArguments.ts";
import { Base3PolicyDeniedError } from "../policy/Base3PolicyDeniedError.ts";
import { PolicyExecutionContext } from "../policy/executionContext.ts";

const denied = () =>
  new Base3PolicyDeniedError({
    reason: "reviewed-route",
    commandType: "message.dispatch",
    detail:
      "Reviewed route changed or is unavailable. Review the instructions again; no fallback was sent.",
  });
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(TaskCapabilityStep));

const savedPrSubject =
  /(?:the\s+)?(?:(?:saved|persisted|thread[- ]linked)\s+(?:pull requests?|prs?)(?:\s+(?:linked to (?:this|the) (?:task|thread)|for (?:this|the) (?:task|thread)|in (?:this|the) thread))?|(?:pull requests?|prs?)\s+linked to (?:this|the) (?:task|thread))/
    .source;
const summaryQuestion = new RegExp(
  `^(?:please\\s+)?(?:summari[sz]e|(?:give me )?a summary of|summary of)\\s+${savedPrSubject}[.!?]?$`,
  "i",
);
const statusQuestion = new RegExp(
  `^(?:please\\s+)?which\\s+${savedPrSubject}\\s+(?:are(?:\\s+still)?|remain)\\s+(open|drafts?)[.!?]?$`,
  "i",
);

/** Deliberately narrow: saved state and draft flags cannot prove live or merge-ready status. */
export function parseSavedPrQuestion(text: string): "summary" | "open" | "draft" | null {
  const normalized = text.trim();
  if (summaryQuestion.test(normalized)) return "summary";
  const match = statusQuestion.exec(normalized);
  return match ? (match[1]!.toLowerCase() === "open" ? "open" : "draft") : null;
}

/** The existing dispatcher calculates the route; the review does not initialize policy or execute. */
export const calculateReviewedCapabilityRoute = Effect.fn("calculateReviewedCapabilityRoute")(
  function* (
    sql: SqlClient.SqlClient,
    input: {
      readonly environmentId: string;
      readonly threadId: string;
      readonly messageId: string;
      readonly text: string;
    },
  ) {
    const registry = yield* Effect.serviceOption(ProviderRegistry);
    if (Option.isNone(registry)) return yield* denied();
    const providers = yield* registry.value.getProviders.pipe(Effect.mapError(() => denied()));
    const projected = yield* readDispatcherProjectedState({
      threadId: ThreadId.make(input.threadId),
    }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
    const projectId = projected.threads.find((t) => t.id === input.threadId)?.projectId;
    const projectDefault =
      projected.projects.find((p) => p.id === projectId)?.defaultModelSelection ?? null;
    const profile = classifyLocalTask(input.text);
    const evaluation = yield* Effect.serviceOption(RouterEvaluation.RouterEvaluationService);
    const snapshot = yield* (
      Option.isSome(evaluation)
        ? evaluation.value.existingRoutingSnapshot(EnvironmentId.make(input.environmentId), profile)
        : RouterEvaluation.RouterEvaluationService.use((service) =>
            service.existingRoutingSnapshot(EnvironmentId.make(input.environmentId), profile),
          ).pipe(
            Effect.provide(RouterEvaluation.layer),
            Effect.provideService(SqlClient.SqlClient, sql),
          )
    ).pipe(Effect.mapError(() => denied()));
    const hybrid = Option.isSome(snapshot)
      ? RouterEvaluation.routingPolicyInput(snapshot.value)
      : {
          activePolicyVersion: MODEL_ROUTER_POLICY_VERSION,
          challengerEnabled: false,
          evidenceByTarget: new Map(),
        };
    const settings = yield* Effect.serviceOption(ServerSettingsService);
    const defaultSelection = Option.isNone(settings)
      ? null
      : yield* settings.value.getSettings.pipe(
          Effect.map((s) => s.defaultModelSelection),
          Effect.mapError(() => denied()),
        );
    const bound = yield* bindDispatcherTurnStartCommand(
      {
        type: "thread.turn.start",
        threadId: ThreadId.make(input.threadId),
        message: { messageId: MessageId.make(input.messageId), text: input.text },
        routingMode: "auto",
      },
      {
        enabled: true,
        environmentId: Effect.succeed(EnvironmentId.make(input.environmentId)),
        providers: Effect.succeed(providers),
        environmentDefaultModelSelection: Effect.succeed(defaultSelection),
        sql,
        hybrid,
        localTaskProfile: profile,
      },
    ).pipe(Effect.mapError(() => denied()));
    const route = bound.routeBinding;
    if (!route || !bound.modelSelection || !route.modelRoute?.selected) return yield* denied();
    // Phase-12 advisory metadata includes a creation timestamp. Compare the actual model
    // selector inputs/output, then persist the exact originally displayed binding at admission.
    const routingBasisDigest = argumentHash({
      target: route.target,
      driver: route.driver,
      source: route.source,
      modelRoute: route.modelRoute,
      hybrid: route.hybrid,
      profile,
      catalog: modelRouterCatalogFromProviders(providers),
      projectDefault,
      environmentDefault: defaultSelection,
    });
    return { route, routingBasisDigest, modelSelection: bound.modelSelection };
  },
);

export const validateReviewedCapabilityRoute = Effect.fn("validateReviewedCapabilityRoute")(
  function* (sql: SqlClient.SqlClient, review: TaskCapabilityStep, admitted = false) {
    const intent = review.reviewedIntent;
    if (!intent) return;
    if (
      parseSavedPrQuestion(intent.text) !== (intent.question ?? "summary") ||
      argumentHash(intent.text) !== review.promptDigest
    )
      return yield* denied();
    const current = yield* calculateReviewedCapabilityRoute(sql, {
      ...review,
      text: intent.text,
    });
    if (
      current.routingBasisDigest !== intent.routingBasisDigest ||
      argumentHash(current.modelSelection) !== argumentHash(review.modelSelection)
    )
      return yield* denied();
    if (admitted) {
      const route = yield* readDispatcherTaskRoute({
        threadId: ThreadId.make(review.threadId),
        messageId: MessageId.make(review.messageId),
      }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
      if (Option.isNone(route) || argumentHash(route.value) !== argumentHash(intent.route))
        return yield* denied();
    }
  },
);

/** Policy consumes only a server-persisted review, never a client-supplied target alone. */
export const bindReviewedCapabilityRoute = Effect.fn("bindReviewedCapabilityRoute")(function* (
  sql: SqlClient.SqlClient,
  command: {
    readonly capabilityStep: TaskCapabilityStep;
    readonly threadId?: string;
    readonly messageId?: string;
    readonly commandId: string;
    readonly text?: string;
    readonly modelSelection?: ModelSelection;
  },
) {
  const review = command.capabilityStep;
  const context = yield* PolicyExecutionContext;
  const rows = yield* sql<{ review_json: string; status: string }>`
      SELECT review_json,status FROM base3_capability_steps WHERE review_id=${review.reviewId}`;
  if (
    !rows[0] ||
    rows[0].status !== "reviewed" ||
    context.kind !== "session" ||
    context.actorId !== review.actorId ||
    !review.reviewedIntent ||
    review.commandId !== command.commandId ||
    review.threadId !== command.threadId ||
    review.messageId !== command.messageId ||
    review.promptDigest !== argumentHash(command.text) ||
    argumentHash(command.modelSelection) !== argumentHash(review.modelSelection) ||
    argumentHash(yield* decode(rows[0].review_json)) !== argumentHash(review)
  )
    return yield* denied();
  yield* validateReviewedCapabilityRoute(sql, review);
  yield* persistDispatcherTaskRoute({
    threadId: ThreadId.make(review.threadId),
    messageId: MessageId.make(review.messageId),
    binding: review.reviewedIntent.route,
    createdAt: DateTime.formatIso(yield* DateTime.now),
  }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
  return review.modelSelection;
});
