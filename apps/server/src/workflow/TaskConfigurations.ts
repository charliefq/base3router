import {
  AuthOrchestrationOperateScope,
  WorkflowOperationError,
  type AgentProfile,
  type WorkflowActionInput,
  type WorkflowCatalog,
  isProviderAvailable,
  isProviderTaskExecutionCapable,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { PolicyExecutionContext } from "../policy/executionContext.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
const denied = () =>
  new WorkflowOperationError({
    message:
      "Saved configuration authority, scope, revision or exact model is unavailable. Refresh and review.",
  });
export const visibleConfiguration = Effect.fn("TaskConfigurations.visible")(function* (
  profile: AgentProfile,
) {
  if (!profile.taskConfiguration) return true;
  const actor = yield* PolicyExecutionContext;
  const env = yield* Effect.serviceOption(ServerEnvironment);
  return (
    actor.kind === "session" &&
    actor.actorId === profile.taskConfiguration.ownerId &&
    Option.isSome(env) &&
    (yield* env.value.getEnvironmentId) === profile.taskConfiguration.environmentId
  );
});
export const authorizeProfileAction = Effect.fn("TaskConfigurations.authorize")(function* (
  input: WorkflowActionInput,
  stored: WorkflowCatalog,
  recovery = false,
) {
  if (
    input.type !== "profile.save" &&
    input.type !== "profile.archive" &&
    input.type !== "profile.restore"
  )
    return;
  const id = input.type === "profile.save" ? input.draft.id : input.profileId;
  const prior = stored.profiles
    .filter((p) => p.id === id)
    .toSorted((a, b) => b.version - a.version)[0];
  const requested = input.type === "profile.save" ? input.draft.taskConfiguration : undefined;
  if (!requested && !prior?.taskConfiguration) return;
  const actor = yield* PolicyExecutionContext;
  if (
    actor.kind !== "session" ||
    !actor.actorId.trim() ||
    !actor.sessionId.trim() ||
    !actor.scopes.includes(AuthOrchestrationOperateScope) ||
    (actor.expiresAt !== undefined &&
      (!Number.isFinite(Date.parse(actor.expiresAt)) ||
        actor.expiresAt <= DateTime.formatIso(yield* DateTime.now)))
  )
    return yield* denied();
  if (prior && (!prior.taskConfiguration || prior.taskConfiguration.ownerId !== actor.actorId))
    return yield* denied();
  if (input.type === "profile.save" && !requested) return yield* denied();
  const binding = requested ?? prior!.taskConfiguration!;
  const env = yield* Effect.serviceOption(ServerEnvironment);
  if (
    Option.isNone(env) ||
    (yield* env.value.getEnvironmentId) !== binding.environmentId ||
    (prior?.taskConfiguration && prior.taskConfiguration.environmentId !== binding.environmentId)
  )
    return yield* denied();
  if (input.type !== "profile.save") {
    // Retry identity is reconciled before applying a mutation; archive still requires its selected revision.
    if (!recovery && input.expectedVersion !== prior?.version) return yield* denied();
    return;
  }
  if (recovery) return { ...binding, ownerId: actor.actorId, commandId: input.commandId };
  const registry = yield* Effect.serviceOption(ProviderRegistry);
  const provider = Option.isSome(registry)
    ? (yield* registry.value.getProviders).find(
        (p) => p.instanceId === binding.modelSelection.instanceId,
      )
    : undefined;
  if (
    binding.modelSelection.options !== undefined ||
    !provider ||
    !provider.enabled ||
    !provider.installed ||
    provider.status !== "ready" ||
    provider.auth.status === "unauthenticated" ||
    !isProviderAvailable(provider) ||
    !isProviderTaskExecutionCapable(provider) ||
    !provider.models.some((m) => m.slug === binding.modelSelection.model)
  )
    return yield* denied();
  return { ...binding, ownerId: actor.actorId, commandId: input.commandId };
});
