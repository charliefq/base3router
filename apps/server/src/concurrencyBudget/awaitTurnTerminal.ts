import {
  type ProviderRuntimeEvent,
  type ProviderTurnStartResult,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

/**
 * Foreground leases must outlive start-return adapters. Missing terminals
 * release after this bound so shutdown cannot wait forever.
 */
export const FOREGROUND_TURN_TERMINAL_TIMEOUT: Duration.DurationInput = "10 minutes";

export type TurnTerminalOutcome = "completed" | "aborted" | "timeout" | "stream-ended";

const isTurnTerminalEvent = (
  event: ProviderRuntimeEvent,
): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" | "turn.aborted" }> =>
  event.type === "turn.completed" || event.type === "turn.aborted";

const matchesTurn = (
  event: Extract<ProviderRuntimeEvent, { type: "turn.completed" | "turn.aborted" }>,
  threadId: ThreadId,
  turnId: TurnId,
): boolean => event.threadId === threadId && event.turnId === turnId;

/**
 * Subscribe before `sendTurn`. Wait until the matching turn completes or
 * aborts, then return. Timeout is an explicit bounded release, not a hidden
 * start-call limit.
 */
export const sendTurnUntilTerminal = <A extends ProviderTurnStartResult, E, R, R2 = never>(
  send: Effect.Effect<A, E, R>,
  stream: Stream.Stream<ProviderRuntimeEvent>,
  options?: {
    readonly timeout?: Duration.DurationInput;
    readonly afterStart?: (started: A) => Effect.Effect<void, never, R2>;
  },
): Effect.Effect<A, E, R | R2> =>
  Effect.scoped(
    Effect.gen(function* () {
      const terminals =
        yield* Queue.unbounded<
          Extract<ProviderRuntimeEvent, { type: "turn.completed" | "turn.aborted" }>
        >();
      yield* Stream.runForEach(stream, (event) =>
        isTurnTerminalEvent(event) ? Queue.offer(terminals, event) : Effect.void,
      ).pipe(Effect.forkScoped({ startImmediately: true }));
      const started = yield* send;
      if (options?.afterStart !== undefined) {
        yield* options.afterStart(started);
      }
      yield* Stream.fromQueue(terminals).pipe(
        Stream.filter((event) => matchesTurn(event, started.threadId, started.turnId)),
        Stream.take(1),
        Stream.runHead,
        Effect.timeoutOrElse({
          duration: options?.timeout ?? FOREGROUND_TURN_TERMINAL_TIMEOUT,
          orElse: () => Effect.succeed(Option.none()),
        }),
      );
      return started;
    }),
  );
