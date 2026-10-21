import { ORCHESTRATION_V2_WS_METHODS, type ThreadId } from "@t3tools/contracts";
import { EnvironmentSupervisor } from "@t3tools/client-runtime/connection";
import {
  EnvironmentRpcSubscriptionObserver,
  subscribeDynamicWithSession,
} from "@t3tools/client-runtime/rpc";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

export type ComparisonObservation = "ready" | "changed" | "unavailable";
export interface ComparisonObservationInput {
  readonly threadId: ThreadId;
  readonly afterSequence: number;
  readonly signal: AbortSignal;
  readonly report: (state: ComparisonObservation) => void;
}

/** Raw frames only invalidate reads; they never supply output or mutation authority. */
export const observeTaskResultComparison = (input: ComparisonObservationInput) =>
  Effect.scoped(
    Effect.gen(function* () {
      let retired = false;
      const report = (value: ComparisonObservation) =>
        Effect.sync(() => {
          if (input.signal.aborted || retired) return;
          if (value !== "ready") retired = true;
          input.report(value);
        });
      const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
      const expected = yield* SubscriptionRef.get(supervisor.session);
      const supported =
        Option.isSome(expected) &&
        (yield* expected.value.initialConfig.pipe(
          Effect.map((config) => config.threadResumeCompletionMarker === true),
          Effect.orElseSucceed(() => false),
        ));
      if (!supported || Option.isNone(expected)) {
        yield* report("unavailable");
        return;
      }
      const session = expected.value;
      const original = yield* EnvironmentRpcSubscriptionObserver;
      yield* subscribeDynamicWithSession(
        ORCHESTRATION_V2_WS_METHODS.subscribeThread,
        (current) =>
          current === session
            ? Effect.succeed({
                threadId: input.threadId,
                afterSequence: input.afterSequence,
                requestCompletionMarker: true,
                acceptBoundedSnapshot: true,
              })
            : report("unavailable").pipe(Effect.andThen(Effect.never)),
        { onDefect: () => report("unavailable"), onExpectedFailure: () => report("unavailable") },
      ).pipe(
        Stream.runForEach(([current, frame]) => {
          if (current !== session) return report("unavailable");
          if (frame.kind === "synchronized") return report("ready");
          if (frame.kind === "snapshot" || frame.sequence > input.afterSequence)
            return report("changed");
          return Effect.void;
        }),
        Effect.provideService(EnvironmentRpcSubscriptionObserver, {
          observe: (observation) =>
            original
              .observe(observation)
              .pipe(Effect.map((complete) => complete.pipe(Effect.andThen(report("unavailable"))))),
        }),
        Effect.catchCause(() => report("unavailable")),
        Effect.forkScoped,
      );
      yield* SubscriptionRef.changes(supervisor.session).pipe(
        Stream.runForEach((current) =>
          Option.isSome(current) && current.value === session ? Effect.void : report("unavailable"),
        ),
        Effect.forkScoped,
      );
      yield* session.closed.pipe(
        Effect.catchCause(() => report("unavailable")),
        Effect.forkScoped,
      );
      yield* Effect.callback<void>((resume) => {
        const stop = () => resume(Effect.void);
        if (input.signal.aborted) stop();
        else input.signal.addEventListener("abort", stop, { once: true });
        return Effect.sync(() => input.signal.removeEventListener("abort", stop));
      });
    }),
  );
