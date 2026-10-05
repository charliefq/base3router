import {
  type ProviderRuntimeEvent,
  type ProviderTurnStartResult,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

/**
 * Foreground leases must outlive start-return adapters. Missing terminals
 * release after this bound so shutdown cannot wait forever.
 */
const FOREGROUND_TURN_TERMINAL_TIMEOUT: Duration.Input = "10 minutes";

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
 * aborts, then return. If the provider event stream ends without a terminal,
 * the wait completes as stream-ended and the lease releases. Timeout is an
 * explicit bounded release for never-ending live streams, not a hidden
 * start-call limit.
 */
export const sendTurnUntilTerminal = <A extends ProviderTurnStartResult, E, R, R2 = never>(
  send: Effect.Effect<A, E, R>,
  stream: Stream.Stream<ProviderRuntimeEvent>,
  options?: {
    readonly timeout?: Duration.Input;
    readonly afterStart?: (started: A) => Effect.Effect<void, never, R2>;
  },
): Effect.Effect<A, E, R | R2> =>
  Effect.scoped(
    Effect.gen(function* () {
      const terminals = yield* Queue.unbounded<
        Extract<ProviderRuntimeEvent, { type: "turn.completed" | "turn.aborted" }>,
        Cause.Done
      >();
      yield* Stream.runForEach(stream, (event) =>
        isTurnTerminalEvent(event) ? Queue.offer(terminals, event) : Effect.void,
      ).pipe(
        Effect.ensuring(Queue.end(terminals).pipe(Effect.asVoid, Effect.ignore)),
        Effect.forkScoped({ startImmediately: true }),
      );
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
          orElse: () => Effect.succeedNone,
        }),
      );
      return started;
    }),
  );
