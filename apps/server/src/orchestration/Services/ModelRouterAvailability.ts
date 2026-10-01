import type {
  ModelRouterAvailabilityCooldown,
  ModelRouterTarget,
  ModelSelection,
} from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import type { ModelRouterFailureClassification } from "@t3tools/shared/modelRouterFailover";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export type ModelRouterPendingExecution = {
  readonly threadId: ThreadId;
  readonly messageId: string;
  readonly messageText: string;
  readonly attemptCount: number;
  readonly attemptedInstanceIds: ReadonlySet<string>;
  readonly attemptedTargetKeys: ReadonlySet<string>;
  readonly currentTarget: ModelRouterTarget;
  readonly routingMode: "auto" | "manual";
  sideEffectsStarted: boolean;
  retry: ((next: ModelSelection) => Effect.Effect<void>) | null;
  onRuntimeFailure: (input: {
    readonly classification: ModelRouterFailureClassification;
    readonly detail: string;
  }) => Effect.Effect<boolean>;
};

export interface ModelRouterAvailabilityShape {
  readonly recordCooldown: (cooldown: ModelRouterAvailabilityCooldown) => Effect.Effect<void>;
  readonly snapshot: (
    nowMs: number,
  ) => Effect.Effect<ReadonlyArray<ModelRouterAvailabilityCooldown>>;
  readonly markSideEffects: (threadId: ThreadId) => Effect.Effect<void>;
  readonly hasSideEffects: (threadId: ThreadId) => Effect.Effect<boolean>;
  readonly registerPending: (pending: ModelRouterPendingExecution) => Effect.Effect<void>;
  readonly getPending: (
    threadId: ThreadId,
  ) => Effect.Effect<ModelRouterPendingExecution | undefined>;
  readonly clearPending: (threadId: ThreadId) => Effect.Effect<void>;
}

export class ModelRouterAvailability extends Context.Service<
  ModelRouterAvailability,
  ModelRouterAvailabilityShape
>()("t3/orchestration/Services/ModelRouterAvailability") {}

export const ModelRouterAvailabilityLive = Layer.sync(ModelRouterAvailability, () => {
  const cooldowns: Array<ModelRouterAvailabilityCooldown> = [];
  const sideEffects = new Set<string>();
  const pending = new Map<string, ModelRouterPendingExecution>();

  return {
    recordCooldown: (cooldown) =>
      Effect.sync(() => {
        const next = cooldowns.filter(
          (existing) =>
            !(
              existing.instanceId === cooldown.instanceId &&
              existing.scope === cooldown.scope &&
              existing.model === cooldown.model
            ),
        );
        cooldowns.splice(0, cooldowns.length, ...next, cooldown);
      }),
    snapshot: (nowMs) =>
      Effect.sync(() => cooldowns.filter((cooldown) => Date.parse(cooldown.until) > nowMs)),
    markSideEffects: (threadId) =>
      Effect.sync(() => {
        sideEffects.add(threadId);
        const current = pending.get(threadId);
        if (current) current.sideEffectsStarted = true;
      }),
    hasSideEffects: (threadId) => Effect.sync(() => sideEffects.has(threadId)),
    registerPending: (entry) =>
      Effect.sync(() => {
        pending.set(entry.threadId, entry);
      }),
    getPending: (threadId) => Effect.sync(() => pending.get(threadId)),
    clearPending: (threadId) =>
      Effect.sync(() => {
        pending.delete(threadId);
        sideEffects.delete(threadId);
      }),
  } satisfies ModelRouterAvailabilityShape;
});
