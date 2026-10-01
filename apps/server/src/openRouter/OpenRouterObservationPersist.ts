import {
  type DispatcherTaskRouteBinding,
  type MessageId,
  type OpenRouterTeacherObservationV0,
  type ProviderRuntimeEvent,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as Dispatcher from "../dispatcher/Dispatcher.ts";

export const persistOpenRouterObservationOnBinding = Effect.fn(
  "persistOpenRouterObservationOnBinding",
)(function* (input: {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly observation: OpenRouterTeacherObservationV0;
}) {
  const existing = yield* Dispatcher.readDispatcherTaskRoute({
    threadId: input.threadId,
    messageId: input.messageId,
  });
  if (Option.isNone(existing)) return;
  const next: DispatcherTaskRouteBinding = {
    ...existing.value,
    openRouter: {
      ...existing.value.openRouter,
      ...input.observation,
      ...(existing.value.openRouter?.base3Selected !== undefined
        ? { base3Selected: existing.value.openRouter.base3Selected }
        : {}),
    },
  };
  yield* Dispatcher.updateDispatcherTaskRouteBinding({
    threadId: input.threadId,
    messageId: input.messageId,
    binding: next,
  });
});

export const persistOpenRouterObservationFromRuntimeEvent = Effect.fn(
  "persistOpenRouterObservationFromRuntimeEvent",
)(function* (input: {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly event: ProviderRuntimeEvent;
}) {
  if (input.event.type !== "turn.completed" || input.event.payload.openRouter === undefined) {
    return;
  }
  yield* persistOpenRouterObservationOnBinding({
    threadId: input.threadId,
    messageId: input.messageId,
    observation: input.event.payload.openRouter,
  });
});
