import {
  type ProviderRuntimeEvent,
  type ProviderTurnStartResult,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

/**
 * Foreground leases must outlive start-return adapters. A live stream without
 * a terminal is interrupted at this bound; the lease is not released while
 * execution is still running.
 */
const FOREGROUND_TURN_TERMINAL_TIMEOUT: Duration.Input = "10 minutes";

/** Wait this long after interrupt for `turn.aborted` / `turn.completed`. */
const INTERRUPT_ACK_TIMEOUT: Duration.Input = "5 seconds";

export type TerminalWaitCleanupReason = "timeout" | "stream-ended";

export type TerminalWaitCleanupResult = {
  /**
   * True when the adapter confirmed that underlying execution stopped.
   * False when a fake (or live) provider remains active after disconnect or
   * interrupt — the wait must keep the lease.
   */
  readonly executionStopped: boolean;
};

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
 * aborts, then return.
 *
 * Timeout (live stream) and stream-end without a terminal both invoke
 * `onCleanup` (PCR maps this to `interruptTurn`). `interruptTurn` requests
 * cancellation; it does not confirm that the provider process stopped.
 * Capacity is released only when a terminal arrives or cleanup reports
 * `executionStopped: true`. Otherwise the lease stays occupied (`onUnresolved`)
 * so a later admission cannot exceed the limit while work continues.
 */
export const sendTurnUntilTerminal = <A extends ProviderTurnStartResult, E, R, R2 = never>(
  send: Effect.Effect<A, E, R>,
  stream: Stream.Stream<ProviderRuntimeEvent>,
  options?: {
    readonly timeout?: Duration.Input;
    readonly interruptAckTimeout?: Duration.Input;
    readonly afterStart?: (started: A) => Effect.Effect<void, never, R2>;
    readonly onCleanup?: (
      started: A,
      reason: TerminalWaitCleanupReason,
    ) => Effect.Effect<TerminalWaitCleanupResult, never, R2>;
    readonly onUnresolved?: (
      started: A,
      reason: TerminalWaitCleanupReason,
    ) => Effect.Effect<void, never, R2>;
  },
): Effect.Effect<A, E, R | R2> =>
  Effect.scoped(
    Effect.gen(function* () {
      const streamEnded = yield* Ref.make(false);
      const terminals = yield* Queue.unbounded<
        Extract<ProviderRuntimeEvent, { type: "turn.completed" | "turn.aborted" }>,
        Cause.Done
      >();
      yield* Stream.runForEach(stream, (event) =>
        isTurnTerminalEvent(event) ? Queue.offer(terminals, event) : Effect.void,
      ).pipe(
        Effect.ensuring(
          Ref.set(streamEnded, true).pipe(
            Effect.andThen(Queue.end(terminals).pipe(Effect.asVoid, Effect.ignore)),
          ),
        ),
        Effect.forkScoped({ startImmediately: true }),
      );
      const started = yield* send;
      if (options?.afterStart !== undefined) {
        yield* options.afterStart(started);
      }
      const waitMatching = (duration?: Duration.Input) => {
        const head = Stream.fromQueue(terminals).pipe(
          Stream.filter((event) => matchesTurn(event, started.threadId, started.turnId)),
          Stream.take(1),
          Stream.runHead,
        );
        return duration === undefined
          ? head
          : head.pipe(
              Effect.timeoutOrElse({
                duration,
                orElse: () => Effect.succeedNone,
              }),
            );
      };
      const first = yield* waitMatching(options?.timeout ?? FOREGROUND_TURN_TERMINAL_TIMEOUT);
      if (Option.isSome(first)) {
        return started;
      }
      const ended = yield* Ref.get(streamEnded);
      const reason: TerminalWaitCleanupReason = ended ? "stream-ended" : "timeout";
      const cleanup =
        options?.onCleanup !== undefined
          ? yield* options.onCleanup(started, reason)
          : { executionStopped: false };
      if (cleanup.executionStopped) {
        return started;
      }
      const ack = yield* waitMatching(options?.interruptAckTimeout ?? INTERRUPT_ACK_TIMEOUT);
      if (Option.isSome(ack)) {
        return started;
      }
      if (options?.onUnresolved !== undefined) {
        yield* options.onUnresolved(started, reason);
      }
      if (ended) {
        // Stream closed and stop was not confirmed. Keep the lease occupied.
        return yield* Effect.never;
      }
      yield* waitMatching();
      return started;
    }),
  );
