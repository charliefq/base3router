import { validateHandoffFirstInput } from "../collaboration/FirstTaskLaunch.ts";
import * as FileSystem from "effect/FileSystem";
import * as ReferenceServerConfig from "../config.ts";
import { commitCapabilityStep } from "../collaboration/TaskCapabilityStep.ts";
import { commitResultContinuation } from "../collaboration/ResultContinuation.ts";
import { commitFirstTaskLaunch } from "../collaboration/FirstTaskLaunch.ts";
import {
  commitApprovedDelegation,
  commitMailboxAuthority,
  type ApprovedDelegation,
} from "../policy/DelegatedMailboxAuthority.ts";
import {
  CommandId,
  EventId,
  OrchestrationV2RunJson,
  OrchestrationV2AppThreadJson,
  type OrchestrationV2Subagent,
  OrchestrationV2ExecutionNodeJson,
  OrchestrationV2TurnItemJson,
  OrchestrationV2SubagentJson,
  OrchestrationV2RunAttemptJson,
  OrchestrationV2ProviderThreadJson,
  OrchestrationV2ProviderTurnJson,
  OrchestrationV2ProviderSessionJson,
  type ProviderInstanceId,
  type ProviderSessionId,
  type ProviderDriverKind,
  type ProviderTurnId,
  type OrchestrationV2Command,
  CollaborationCommand,
  type TaskEnrollmentOutcome,
  type TaskContractReviewReference,
  type TaskContractReviewAction,
  type OrchestrationV2Run,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderRef,
  OrchestrationV2DomainEvent,
  OrchestrationV2StoredEvent,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  NodeId,
  type ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  validateReviewedCreate,
  verifyReviewedCreateReplay,
  reviewedCreateMatchesThread,
  persistReviewedCreateRejection,
} from "../collaboration/governedCreation.ts";

import * as OwnedChat from "../collaboration/ownedChat.ts";
import {
  requestTaskCancellation,
  nextTaskContractThread,
  revokeTaskContractGrants,
} from "../policy/TaskContract.ts";
import {
  verifyActiveRunLease,
  confirmProviderTermination,
  admitDelegationCommit,
} from "../policy/Base3PolicyGate.ts";
import { PolicyExecutionContext } from "../policy/executionContext.ts";
import {
  enrollGovernedTask,
  validateTaskDecision,
  verifyTaskDecisionReplay,
} from "../collaboration/store.ts";

import { replayAndBufferProjectedLiveEvents } from "./LiveStreamBudget.ts";
import type { UnsequencedProjectEvent } from "../persistence/Services/OrchestrationEventStore.ts";
import { projectDomainEventForWire } from "./WireProjection.ts";

import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";

const decodeRun = Schema.decodeUnknownOption(Schema.fromJsonString(OrchestrationV2RunJson));
const decodeAttempt = Schema.decodeUnknownOption(
  Schema.fromJsonString(OrchestrationV2RunAttemptJson),
);
const decodeThread = Schema.decodeUnknownOption(
  Schema.fromJsonString(OrchestrationV2ProviderThreadJson),
);
const decodeProviderTurn = Schema.decodeUnknownOption(
  Schema.fromJsonString(OrchestrationV2ProviderTurnJson),
);

const decodeProviderSession = Schema.decodeUnknownOption(
  Schema.fromJsonString(OrchestrationV2ProviderSessionJson),
);

const decodeAppThread = Schema.decodeUnknownOption(
  Schema.fromJsonString(OrchestrationV2AppThreadJson),
);
const decodeNode = Schema.decodeUnknownOption(
  Schema.fromJsonString(OrchestrationV2ExecutionNodeJson),
);
const decodeItem = Schema.decodeUnknownOption(Schema.fromJsonString(OrchestrationV2TurnItemJson));
const decodeSubagent = Schema.decodeUnknownOption(
  Schema.fromJsonString(OrchestrationV2SubagentJson),
);
const sameRef = (a: OrchestrationV2ProviderRef | null, b: OrchestrationV2ProviderRef | null) =>
  a === null || b === null
    ? a === b
    : a.driver === b.driver &&
      a.nativeId === b.nativeId &&
      a.strength === b.strength &&
      a.fingerprint === b.fingerprint &&
      a.ordinal === b.ordinal;
const terminalWorkStatus = (status: string) =>
  status === "completed" ||
  status === "failed" ||
  status === "interrupted" ||
  status === "cancelled";

const decodeEnrollmentCommand = Schema.decodeUnknownOption(
  Schema.fromJsonString(CollaborationCommand),
);

/**
 * ERRORS
 */
export class EventSinkWriteError extends Schema.TaggedError<EventSinkWriteError>()(
  "EventSinkWriteError",
  {
    eventCount: Schema.Number,
    commandId: Schema.optional(CommandId),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to write ${this.eventCount} orchestration V2 event(s).`;
  }
}

export class EventSinkStreamError extends Schema.TaggedError<EventSinkStreamError>()(
  "EventSinkStreamError",
  {
    threadId: Schema.optional(ThreadId),
    afterSequence: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.threadId === undefined
      ? "Failed to stream orchestration V2 events."
      : `Failed to stream orchestration V2 events for thread ${this.threadId}.`;
  }
}

export const EventSinkV2Error = Schema.Union([EventSinkWriteError, EventSinkStreamError]);
export type EventSinkV2Error = typeof EventSinkV2Error.Type;

/**
 * SERVICE DEFINITION
 */
export interface EventSinkV2Shape {
  readonly write: (input: {
    readonly guardPendingUserInputCancellations?: boolean;
    readonly commandId?: CommandId;
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
  }) => Effect.Effect<ReadonlyArray<OrchestrationV2StoredEvent>, EventSinkV2Error>;
  readonly writeWithEffects: (input: {
    readonly guardPendingUserInputCancellations?: boolean;
    readonly commandId?: CommandId;
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
    readonly effects: ReadonlyArray<EffectOutbox.PendingOrchestrationEffectV2>;
  }) => Effect.Effect<ReadonlyArray<OrchestrationV2StoredEvent>, EventSinkV2Error>;
  readonly writeIfRunCurrent: (input: {
    readonly guardPendingUserInputCancellations?: boolean;
    readonly commandId?: CommandId;
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly activeAttemptId: RunAttemptId;
    readonly expectedStatus: OrchestrationV2Run["status"];
    /** Trusted start preflight settled this attempt without calling the provider. */
    readonly providerNotStarted?: boolean;
    readonly effects?: ReadonlyArray<EffectOutbox.PendingOrchestrationEffectV2>;
    readonly rootExecution?: {
      readonly rootThreadAlias?: OrchestrationV2ProviderThread;
      readonly rootNodeId: NodeId;
      readonly providerThreadId: ProviderThreadId;
      readonly providerSessionId: ProviderSessionId;
      readonly providerInstanceId: ProviderInstanceId;
      readonly driver: ProviderDriverKind;
      readonly runOrdinal: number;
      readonly providerTurnOrdinal: number;
      readonly providerTurnId?: ProviderTurnId;
      readonly terminalStatus?: "completed" | "failed" | "interrupted" | "cancelled";
    };
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
  }) => Effect.Effect<
    {
      readonly committed: boolean;
      readonly storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>;
    },
    EventSinkV2Error
  >;
  /**
   * Atomically commit only when the provider thread is still owned by the
   * expected run attempt and ordinal. Used for late post-terminal
   * provider_thread updates so a completed or superseded attempt cannot clobber
   * a newer attempt that already claimed the thread.
   */
  readonly writeIfProviderThreadOwner: (input: {
    readonly guardPendingUserInputCancellations?: boolean;
    readonly commandId?: CommandId;
    readonly providerThreadId: ProviderThreadId;
    readonly runId: RunId;
    readonly activeAttemptId: RunAttemptId;
    readonly expectedLastRunOrdinal: number;
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
  }) => Effect.Effect<
    {
      readonly committed: boolean;
      readonly storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>;
    },
    EventSinkV2Error
  >;
  readonly commitCommand: (input: {
    readonly commandId: CommandId;
    readonly threadId: ThreadId;
    readonly commandType: string;
    readonly approvedDelegation?: ApprovedDelegation;
    readonly capabilityCommand?: Extract<OrchestrationV2Command, { type: "message.dispatch" }>;
    readonly firstLaunchCommand?: Extract<OrchestrationV2Command, { type: "message.dispatch" }>;
    readonly resultContinuationCommand?: Extract<
      OrchestrationV2Command,
      { type: "message.dispatch" }
    >;
    readonly governedTaskOwner?: string;
    readonly ordinaryRootOwner?: string;
    readonly contractSetActor?: string;
    readonly reviewedSet?: Extract<OrchestrationV2Command, { type: "thread.task-contract.set" }>;
    readonly creationCommand?: Extract<OrchestrationV2Command, { type: "thread.create" }>;
    readonly taskContractDecision?: {
      readonly action: TaskContractReviewAction;
      readonly revision: number;
      readonly reviewTask?: TaskContractReviewReference;
    };
    readonly acceptedAt: DateTime.Utc;
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
    readonly effects: ReadonlyArray<EffectOutbox.PendingOrchestrationEffectV2>;
    readonly cancelUnsettledEffects?: {
      readonly effectTypes: ReadonlyArray<EffectOutbox.OrchestrationEffectRequestV2["type"]>;
      readonly reason: string;
    };
  }) => Effect.Effect<
    {
      readonly receipt: CommandReceiptStore.CommandReceiptV2;
      readonly storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>;
      readonly committed: boolean;
      readonly cancelledEffectCount: number;
      readonly taskEnrollment?: TaskEnrollmentOutcome;
    },
    EventSinkV2Error
  >;
  readonly commitRejectedCommand: (input: {
    readonly commandId: CommandId;
    readonly threadId: ThreadId;
    readonly commandType: string;
    readonly creationCommand?: Extract<OrchestrationV2Command, { type: "thread.create" }>;
    readonly rejectedAt: DateTime.Utc;
    readonly error: string;
  }) => Effect.Effect<CommandReceiptStore.CommandReceiptV2, EventSinkV2Error>;
  /**
   * Append a project event, fold it into its row and record the receipt in one
   * transaction. A reused command id commits nothing and returns its receipt.
   */
  readonly commitProjectCommand: (input: {
    readonly commandId: CommandId;
    readonly projectId: ProjectId;
    readonly commandType: string;
    readonly acceptedAt: DateTime.Utc;
    readonly event: UnsequencedProjectEvent;
  }) => Effect.Effect<
    { readonly receipt: CommandReceiptStore.ProjectCommandReceiptV2; readonly committed: boolean },
    EventSinkV2Error
  >;
  /** Record a rejected project command, or return the receipt its command id already has. */
  readonly commitRejectedProjectCommand: (input: {
    readonly commandId: CommandId;
    readonly projectId: ProjectId;
    readonly commandType: string;
    readonly rejectedAt: DateTime.Utc;
    readonly error: string;
  }) => Effect.Effect<CommandReceiptStore.ProjectCommandReceiptV2, EventSinkV2Error>;
  readonly stream: (input?: {
    readonly threadId?: ThreadId;
    readonly afterSequence?: number;
    /** Filter before queuing live events so a busy worker retains only the events it handles. */
    readonly eventType?: OrchestrationV2DomainEvent["type"];
    /** Bound RPC subscribers; internal workers must not drop their subscription under load. */
    readonly bounded?: boolean;
  }) => Stream.Stream<OrchestrationV2StoredEvent, EventSinkV2Error>;
  readonly latestSequence: (input?: {
    readonly threadId?: ThreadId;
  }) => Effect.Effect<number, EventSinkV2Error>;
  readonly readByCommandId: (input: {
    readonly commandId: CommandId;
  }) => Stream.Stream<OrchestrationV2StoredEvent, EventSinkV2Error>;
}

export class EventSinkV2 extends Context.Service<EventSinkV2, EventSinkV2Shape>()(
  "t3/orchestration-v2/EventSink/EventSinkV2",
) {}

/**
 * IMPLEMENTATIONS
 */
const baseLayer: Layer.Layer<
  EventSinkV2,
  never,
  | CommandReceiptStore.CommandReceiptStoreV2
  | EffectOutbox.EffectOutboxV2
  | EventStore.EventStoreV2
  | ProjectionStore.ProjectionStoreV2
  | ProjectStore.ProjectStoreV2
  | SqlClient.SqlClient
  | TurnItemPositionStore.TurnItemPositionStoreV2
> = Layer.effect(
  EventSinkV2,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const referenceConfig = yield* Effect.serviceOption(ReferenceServerConfig.ServerConfig);
    const referenceFs = yield* Effect.serviceOption(FileSystem.FileSystem);
    const withReferenceStore = <A, E>(effect: Effect.Effect<A, E>) => {
      return Option.isSome(referenceConfig) && Option.isSome(referenceFs)
        ? effect.pipe(
            Effect.provideService(ReferenceServerConfig.ServerConfig, referenceConfig.value),
            Effect.provideService(FileSystem.FileSystem, referenceFs.value),
          )
        : effect;
    };

    const commandReceipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
    const effectOutbox = yield* EffectOutbox.EffectOutboxV2;
    const eventStore = yield* EventStore.EventStoreV2;
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
    const projectStore = yield* ProjectStore.ProjectStoreV2;
    const turnItemPositions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;
    const liveEvents = yield* PubSub.unbounded<OrchestrationV2StoredEvent>();
    const liveEventsByType = new Map<
      OrchestrationV2DomainEvent["type"],
      PubSub.PubSub<OrchestrationV2StoredEvent>
    >();
    const publishLiveEvents = (events: ReadonlyArray<OrchestrationV2StoredEvent>) =>
      Effect.gen(function* () {
        yield* PubSub.publishAll(liveEvents, events);
        for (const [type, pubsub] of liveEventsByType) {
          yield* PubSub.publishAll(
            pubsub,
            events.filter((stored) => stored.event.type === type),
          );
        }
      });

    // A user can answer after terminal normalization reads the pending request.
    // Recheck inside the write transaction so stale cleanup cannot erase answers.
    const guardUserInputCancellations = (events: ReadonlyArray<OrchestrationV2DomainEvent>) =>
      Effect.gen(function* () {
        const staleRequests = new Set<RuntimeRequestId>();
        const staleNodes = new Set<NodeId>();
        for (const event of events) {
          if (
            event.type !== "runtime-request.updated" ||
            event.payload.kind !== "user_input" ||
            event.payload.status !== "cancelled"
          )
            continue;
          const current = yield* projectionStore.getRuntimeRequest(
            event.threadId,
            event.payload.id,
          );
          if (
            current?.status !== "pending" ||
            current.kind !== "user_input" ||
            current.providerTurnId !== event.payload.providerTurnId ||
            current.responseCapability.type === "message"
          ) {
            staleRequests.add(event.payload.id);
            staleNodes.add(event.payload.nodeId);
          }
        }
        return events.filter((event) => {
          switch (event.type) {
            case "runtime-request.updated":
              return event.payload.status !== "cancelled" || !staleRequests.has(event.payload.id);
            case "node.updated":
              return event.payload.status !== "cancelled" || !staleNodes.has(event.payload.id);
            case "turn-item.updated":
              return (
                event.payload.type !== "user_input_request" ||
                event.payload.status !== "cancelled" ||
                !staleRequests.has(event.payload.requestId)
              );
            default:
              return true;
          }
        });
      });

    const normalizeEvents = (events: ReadonlyArray<OrchestrationV2DomainEvent>) => {
      const runOrdinals = new Map(
        events.flatMap((event) =>
          event.type === "run.created" || event.type === "run.updated"
            ? [[event.payload.id, event.payload.ordinal] as const]
            : [],
        ),
      );
      return Effect.forEach(
        events,
        (event): Effect.Effect<OrchestrationV2DomainEvent, unknown> =>
          event.type === "turn-item.updated"
            ? turnItemPositions
                .normalize(
                  event.payload,
                  event.payload.runId === null ? undefined : runOrdinals.get(event.payload.runId),
                )
                .pipe(Effect.map((payload) => ({ ...event, payload })))
            : Effect.succeed(event),
        { concurrency: 1 },
      );
    };

    const applyStoredEvents = (storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>) =>
      Effect.gen(function* () {
        yield* Effect.forEach(storedEvents, (stored) => projectionStore.apply(stored.event), {
          concurrency: 1,
        });
        for (const stored of storedEvents) {
          const event = stored.event;
          if (
            event.type === "provider-turn.updated" &&
            event.runId !== undefined &&
            event.payload.terminationConfirmed === true &&
            terminalWorkStatus(event.payload.status)
          ) {
            if (event.payload.runAttemptId !== null) {
              yield* confirmProviderTermination({
                threadId: event.threadId,
                runId: event.runId,
                attemptId: event.payload.runAttemptId,
              }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
            } else {
              // Legacy runs without any attempt history have no newer attempt
              // to confuse with this native terminal. Keep their compatibility
              // path narrow; an unattributed event cannot release modern runs.
              const legacy = yield* sql`SELECT run_id FROM orchestration_v2_projection_runs AS run
                WHERE run.run_id=${event.runId} AND run.thread_id=${event.threadId}
                  AND json_extract(run.payload_json,'$.activeAttemptId') IS NULL
                  AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_run_attempts AS attempt
                    WHERE attempt.run_id=run.run_id)`;
              if (legacy.length === 1)
                yield* confirmProviderTermination({
                  threadId: event.threadId,
                  runId: event.runId,
                }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
            }
          }
        }
        const sequence = storedEvents.at(-1)?.sequence;
        if (sequence !== undefined) {
          const now = DateTime.formatIso(yield* DateTime.now);
          yield* sql`
            INSERT INTO orchestration_v2_projection_metadata (
              projection_name,
              schema_version,
              last_sequence,
              updated_at
            )
            VALUES (
              'thread-projections',
              ${ProjectionStore.ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION},
              ${sequence},
              ${now}
            )
            ON CONFLICT(projection_name)
            DO UPDATE SET
              schema_version = excluded.schema_version,
              last_sequence = excluded.last_sequence,
              updated_at = excluded.updated_at
          `;
        }
      });

    const writeEffect = Effect.fn("orchestrationV2.EventSink.write")(function* (
      input: Parameters<EventSinkV2Shape["writeWithEffects"]>[0],
    ) {
      yield* Effect.annotateCurrentSpan({
        "orchestration_v2.command_id": input.commandId ?? null,
        "orchestration_v2.event_count": input.events.length,
        "orchestration_v2.thread_id": input.events[0]?.threadId ?? null,
      });

      const storedEvents = yield* sql.withTransaction(
        Effect.gen(function* () {
          const normalized = yield* normalizeEvents(
            input.guardPendingUserInputCancellations === true
              ? yield* guardUserInputCancellations(input.events)
              : input.events,
          );
          const committed = yield* eventStore.append({
            ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
            events: normalized,
          });
          yield* applyStoredEvents(committed);
          yield* effectOutbox.enqueue(input.effects);
          return committed;
        }),
      );
      if (input.effects.length > 0) {
        yield* effectOutbox.notifyAvailable(input.effects.length);
      }
      yield* eventStore.publishCommitted(storedEvents);
      yield* publishLiveEvents(storedEvents);
      return storedEvents;
    });

    const retiredRootObservation = Effect.fn("orchestrationV2.EventSink.retiredRootObservation")(
      function* (input: Parameters<EventSinkV2Shape["writeIfRunCurrent"]>[0]) {
        const owner = input.rootExecution;
        const event =
          input.events.find((e) => e.type === "provider-turn.updated") ?? input.events[0];
        if (
          owner === undefined ||
          input.effects !== undefined ||
          (event?.type !== "provider-turn.updated" && input.events.length !== 1) ||
          event === undefined ||
          ![
            "provider-turn.updated",
            "node.updated",
            "turn-item.updated",
            "subagent.updated",
          ].includes(event.type) ||
          event.threadId !== input.threadId ||
          event.runId !== input.runId ||
          event.driver !== owner.driver ||
          event.providerInstanceId !== owner.providerInstanceId
        )
          return [];
        const rows = yield* sql<{
          run_ordinal: number;
          attempt_payload: string;
          attempt_status: string;
          turn_payload: string;
          session_payload: string;
          attempt_run: string;
          attempt_root: string;
          attempt_thread: string;
          attempt_instance: string;
          attempt_turn: string | null;
          turn_attempt: string | null;
          turn_root: string;
          turn_thread: string;
          turn_status: string;
          turn_ordinal: number;
          session_instance: string;
          session_driver: string;
        }>`SELECT r.ordinal AS run_ordinal,a.payload_json AS attempt_payload,a.status AS attempt_status,t.payload_json AS turn_payload,s.payload_json AS session_payload,
          a.run_id AS attempt_run,a.root_node_id AS attempt_root,a.provider_thread_id AS attempt_thread,a.provider_instance_id AS attempt_instance,
          a.provider_turn_id AS attempt_turn,t.run_attempt_id AS turn_attempt,t.node_id AS turn_root,t.provider_thread_id AS turn_thread,t.status AS turn_status,t.ordinal AS turn_ordinal,
          s.provider_instance_id AS session_instance,s.driver AS session_driver
          FROM orchestration_v2_projection_run_attempts a
          JOIN orchestration_v2_projection_runs r ON r.run_id=a.run_id AND r.thread_id=a.thread_id
          JOIN orchestration_v2_projection_provider_turns t ON t.provider_turn_id=a.provider_turn_id AND t.thread_id=a.thread_id
          JOIN orchestration_v2_projection_provider_sessions s ON s.provider_session_id=${owner.providerSessionId}
          WHERE a.attempt_id=${input.activeAttemptId} AND a.thread_id=${input.threadId} AND a.run_id=${input.runId} LIMIT 1`;
        const row = rows[0];
        if (row === undefined) return [];
        const attempt = decodeAttempt(row.attempt_payload),
          previous = decodeProviderTurn(row.turn_payload),
          session = decodeProviderSession(row.session_payload);
        if (Option.isNone(attempt) || Option.isNone(previous) || Option.isNone(session)) return [];
        const a = attempt.value,
          t = previous.value,
          s = session.value;
        const turn = event.type === "provider-turn.updated" ? event.payload : t;
        if (
          row.run_ordinal !== owner.runOrdinal ||
          a.id !== input.activeAttemptId ||
          a.runId !== input.runId ||
          a.rootNodeId !== owner.rootNodeId ||
          a.providerInstanceId !== owner.providerInstanceId ||
          a.providerThreadId !== owner.providerThreadId ||
          a.providerTurnId !== turn.id ||
          a.status === "pending" ||
          row.attempt_status !== a.status ||
          row.attempt_run !== a.runId ||
          row.attempt_root !== a.rootNodeId ||
          row.attempt_thread !== a.providerThreadId ||
          row.attempt_instance !== a.providerInstanceId ||
          row.attempt_turn !== a.providerTurnId ||
          t.id !== turn.id ||
          t.runAttemptId !== a.id ||
          t.nodeId !== owner.rootNodeId ||
          t.providerThreadId !== owner.providerThreadId ||
          t.ordinal !== owner.providerTurnOrdinal ||
          row.turn_attempt !== t.runAttemptId ||
          row.turn_root !== t.nodeId ||
          row.turn_thread !== t.providerThreadId ||
          row.turn_status !== t.status ||
          row.turn_ordinal !== t.ordinal ||
          (t.status !== "running" && t.status !== "pending" && t.status !== turn.status) ||
          s.id !== owner.providerSessionId ||
          s.providerInstanceId !== owner.providerInstanceId ||
          s.driver !== owner.driver ||
          row.session_instance !== s.providerInstanceId ||
          row.session_driver !== s.driver
        )
          return [];
        if (event.type === "provider-turn.updated") {
          if (
            owner.providerTurnId !== turn.id ||
            turn.runAttemptId !== a.id ||
            turn.nodeId !== owner.rootNodeId ||
            turn.providerThreadId !== owner.providerThreadId ||
            turn.ordinal !== owner.providerTurnOrdinal ||
            !terminalWorkStatus(turn.status)
          )
            return [];
          if (turn.terminationConfirmed === true && a.status === "running") {
            const roots = yield* sql<{ payload_json: string }>`SELECT payload_json
              FROM orchestration_v2_projection_nodes WHERE node_id=${owner.rootNodeId}
                AND thread_id=${input.threadId} AND run_id=${input.runId} LIMIT 1`;
            const root = roots[0] === undefined ? Option.none() : decodeNode(roots[0].payload_json);
            return [
              event,
              {
                ...event,
                id: EventId.make(`${event.id}:retired-attempt`),
                type: "run-attempt.updated" as const,
                payload: {
                  ...a,
                  status: turn.status,
                  completedAt: turn.completedAt ?? event.occurredAt,
                },
              },
              ...(Option.isNone(root)
                ? []
                : [
                    {
                      ...event,
                      id: EventId.make(`${event.id}:retired-root`),
                      type: "node.updated" as const,
                      payload: {
                        ...root.value,
                        status: turn.status,
                        completedAt: turn.completedAt ?? event.occurredAt,
                      },
                    },
                  ]),
            ];
          }
          return [event];
        }
        // A terminal root observation authorizes only lifecycle cleanup of its
        // already persisted direct work. Never create work or touch the new root.
        const nodeId =
          event.type === "node.updated" || event.type === "subagent.updated"
            ? event.payload.id
            : event.type === "turn-item.updated"
              ? event.payload.nodeId
              : null;
        if (nodeId === null || nodeId === owner.rootNodeId) return [];
        const nodes = yield* sql<{
          payload_json: string;
          provider_thread_id: string | null;
        }>`SELECT payload_json,provider_thread_id FROM orchestration_v2_projection_nodes
          WHERE node_id=${nodeId} AND thread_id=${input.threadId} AND run_id=${input.runId}
          AND root_node_id=${owner.rootNodeId} AND parent_node_id=${owner.rootNodeId}
          AND provider_turn_id=${t.id} LIMIT 1`;
        const node = nodes[0] === undefined ? Option.none() : decodeNode(nodes[0].payload_json);
        if (Option.isNone(node)) return [];
        const n = node.value;
        if (
          n.id !== nodeId ||
          n.threadId !== input.threadId ||
          n.runId !== input.runId ||
          n.rootNodeId !== owner.rootNodeId ||
          n.parentNodeId !== owner.rootNodeId ||
          n.providerThreadId === null ||
          n.providerThreadId !== nodes[0]!.provider_thread_id ||
          n.providerTurnId !== t.id
        )
          return [];
        let nativeChildAgent: OrchestrationV2Subagent | undefined;
        let permitsToolToTaskRef = false;
        if (n.providerThreadId !== owner.providerThreadId) {
          if (n.kind !== "subagent") return [];
          const children = yield* sql<{
            agent_payload: string;
            provider_payload: string;
            child_payload: string;
            parent_payload: string;
            child_id: string;
            project_id: string;
          }>`SELECT a.payload_json AS agent_payload,p.payload_json AS provider_payload,c.payload_json AS child_payload,parent.payload_json AS parent_payload,c.thread_id AS child_id,c.project_id AS project_id
            FROM orchestration_v2_projection_subagents a
            JOIN orchestration_v2_projection_provider_threads p ON p.provider_thread_id=a.provider_thread_id AND p.thread_id=a.child_thread_id
            JOIN orchestration_v2_projection_threads c ON c.thread_id=a.child_thread_id AND c.active_provider_thread_id=p.provider_thread_id
            JOIN orchestration_v2_projection_threads parent ON parent.thread_id=a.thread_id AND parent.project_id=c.project_id
            WHERE a.subagent_id=${n.id} AND a.thread_id=${input.threadId} AND a.run_id=${input.runId}
              AND a.parent_node_id=${owner.rootNodeId} AND a.provider_thread_id=${n.providerThreadId}
              AND a.driver=${owner.driver} AND a.provider_instance_id=${owner.providerInstanceId}
              AND p.driver=${owner.driver} AND p.provider_instance_id=${owner.providerInstanceId} AND p.provider_session_id=${owner.providerSessionId}
              AND c.provider_instance_id=${owner.providerInstanceId} LIMIT 1`;
          const childRow = children[0];
          if (childRow === undefined) return [];
          const agent = decodeSubagent(childRow.agent_payload),
            provider = decodeThread(childRow.provider_payload),
            child = decodeAppThread(childRow.child_payload),
            parent = decodeAppThread(childRow.parent_payload);
          if (
            Option.isNone(agent) ||
            Option.isNone(provider) ||
            Option.isNone(child) ||
            Option.isNone(parent)
          )
            return [];
          const task = agent.value,
            p = provider.value,
            c = child.value,
            app = parent.value;
          if (
            task.id !== n.id ||
            task.threadId !== input.threadId ||
            task.runId !== input.runId ||
            task.parentNodeId !== owner.rootNodeId ||
            task.providerThreadId !== n.providerThreadId ||
            task.childThreadId !== c.id ||
            task.origin !== "provider_native" ||
            task.driver !== owner.driver ||
            task.providerInstanceId !== owner.providerInstanceId ||
            p.id !== n.providerThreadId ||
            p.appThreadId !== c.id ||
            p.providerSessionId !== owner.providerSessionId ||
            p.driver !== owner.driver ||
            p.providerInstanceId !== owner.providerInstanceId ||
            p.ownerNodeId !== null ||
            p.nativeThreadRef?.strength !== "strong" ||
            p.nativeThreadRef.nativeId === null ||
            p.nativeThreadRef.driver !== owner.driver ||
            p.forkedFrom?.providerThreadId !== owner.providerThreadId ||
            p.forkedFrom.providerTurnId !== t.id ||
            app.id !== input.threadId ||
            c.id !== childRow.child_id ||
            c.projectId !== childRow.project_id ||
            c.projectId !== app.projectId ||
            c.providerInstanceId !== owner.providerInstanceId ||
            c.activeProviderThreadId !== p.id ||
            c.lineage.parentThreadId !== input.threadId ||
            c.lineage.relationshipToParent !== "subagent" ||
            c.lineage.rootThreadId !== app.lineage.rootThreadId ||
            c.forkedFrom?.type !== "node" ||
            c.forkedFrom.nodeId !== n.id
          )
            return [];
          nativeChildAgent = task;
          // Codex launches the parent node under its tool-call reference, then
          // terminalizes it under the recorded tool-call:child-thread task ref.
          permitsToolToTaskRef =
            owner.driver === "codex" &&
            n.nativeItemRef?.driver === owner.driver &&
            n.nativeItemRef.strength === "strong" &&
            n.nativeItemRef.nativeId !== null &&
            task.nativeTaskRef?.driver === owner.driver &&
            task.nativeTaskRef.strength === "strong" &&
            task.nativeTaskRef.nativeId ===
              `${n.nativeItemRef.nativeId}:${p.nativeThreadRef.nativeId}`;
        }
        // A superseded Codex child can finish before its parent completion.
        // Its existing, independently proven child work may settle; the running
        // parent turn, root, attempt link and successor remain untouched.
        if (
          !terminalWorkStatus(t.status) &&
          !(
            nativeChildAgent !== undefined &&
            owner.driver === "codex" &&
            a.status === "superseded" &&
            t.status === "running"
          )
        )
          return [];
        const canSettle = (old: string, next: string) =>
          terminalWorkStatus(next) &&
          (old === "pending" || old === "running" || old === "waiting" || old === next);
        if (event.type === "node.updated") {
          const next = event.payload;
          if (
            next.threadId !== n.threadId ||
            next.runId !== n.runId ||
            next.rootNodeId !== n.rootNodeId ||
            next.parentNodeId !== n.parentNodeId ||
            next.providerThreadId !== n.providerThreadId ||
            next.providerTurnId !== n.providerTurnId ||
            next.kind !== n.kind ||
            (!sameRef(next.nativeItemRef, n.nativeItemRef) &&
              !(
                permitsToolToTaskRef &&
                nativeChildAgent !== undefined &&
                sameRef(next.nativeItemRef, nativeChildAgent.nativeTaskRef)
              )) ||
            !canSettle(n.status, next.status)
          )
            return [];
          return [
            {
              ...event,
              payload: {
                ...n,
                status: next.status,
                completedAt: next.completedAt,
                nativeItemRef: next.nativeItemRef,
              },
            },
          ];
        }
        if (event.type === "turn-item.updated") {
          const next = event.payload;
          const items = yield* sql<{
            payload_json: string;
          }>`SELECT payload_json FROM orchestration_v2_projection_turn_items
            WHERE turn_item_id=${next.id} AND thread_id=${input.threadId} AND run_id=${input.runId}
            AND node_id=${nodeId} AND provider_thread_id=${n.providerThreadId} AND provider_turn_id=${t.id} LIMIT 1`;
          const item = items[0] === undefined ? Option.none() : decodeItem(items[0].payload_json);
          if (Option.isNone(item)) return [];
          const old = item.value;
          if (
            nativeChildAgent !== undefined &&
            (old.type !== "subagent" ||
              old.subagentId !== nativeChildAgent.id ||
              old.childThreadId !== nativeChildAgent.childThreadId ||
              old.driver !== owner.driver ||
              old.providerInstanceId !== owner.providerInstanceId ||
              !sameRef(old.nativeItemRef, nativeChildAgent.nativeTaskRef))
          )
            return [];
          if (
            old.id !== next.id ||
            old.threadId !== next.threadId ||
            old.runId !== next.runId ||
            old.nodeId !== next.nodeId ||
            old.providerThreadId !== next.providerThreadId ||
            old.providerTurnId !== next.providerTurnId ||
            old.type !== next.type ||
            old.parentItemId !== next.parentItemId ||
            !sameRef(old.nativeItemRef, next.nativeItemRef) ||
            !canSettle(old.status, next.status)
          )
            return [];
          return [
            {
              ...event,
              payload: {
                ...old,
                status: next.status,
                completedAt: next.completedAt,
                updatedAt: next.updatedAt,
              },
            },
          ];
        }
        if (event.type === "subagent.updated") {
          const next = event.payload;
          const agents = yield* sql<{
            payload_json: string;
          }>`SELECT payload_json FROM orchestration_v2_projection_subagents
            WHERE subagent_id=${next.id} AND thread_id=${input.threadId} AND run_id=${input.runId}
            AND parent_node_id=${owner.rootNodeId} AND provider_thread_id=${n.providerThreadId} LIMIT 1`;
          const agent =
            agents[0] === undefined ? Option.none() : decodeSubagent(agents[0].payload_json);
          if (Option.isNone(agent)) return [];
          const old = agent.value;
          if (
            old.id !== next.id ||
            old.threadId !== next.threadId ||
            old.runId !== next.runId ||
            old.parentNodeId !== next.parentNodeId ||
            old.providerThreadId !== next.providerThreadId ||
            old.driver !== next.driver ||
            old.providerInstanceId !== next.providerInstanceId ||
            old.childThreadId !== next.childThreadId ||
            !sameRef(old.nativeTaskRef, next.nativeTaskRef) ||
            !canSettle(old.status, next.status)
          )
            return [];
          return [
            {
              ...event,
              payload: {
                ...old,
                status: next.status,
                result: next.result,
                completedAt: next.completedAt,
                updatedAt: next.updatedAt,
              },
            },
          ];
        }
        return [];
      },
    );

    const writeIfRunCurrentEffect = Effect.fn("orchestrationV2.EventSink.writeIfRunCurrent")(
      function* (input: Parameters<EventSinkV2Shape["writeIfRunCurrent"]>[0]) {
        yield* Effect.annotateCurrentSpan({
          "orchestration_v2.command_id": input.commandId ?? null,
          "orchestration_v2.event_count": input.events.length,
          "orchestration_v2.run_id": input.runId,
          "orchestration_v2.thread_id": input.threadId,
        });

        const result = yield* sql.withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<{
              readonly status: string;
              readonly active_attempt_id: string | null;
            }>`
            SELECT
              status,
              json_extract(payload_json, '$.activeAttemptId') AS active_attempt_id
            FROM orchestration_v2_projection_runs
            WHERE run_id = ${input.runId}
              AND thread_id = ${input.threadId}
            LIMIT 1
          `;
            const current = rows[0];
            if (
              current === undefined ||
              current.status !== input.expectedStatus ||
              current.active_attempt_id !== input.activeAttemptId
            ) {
              const retired = yield* retiredRootObservation(input);
              if (retired.length === 0)
                return {
                  committed: false as const,
                  storedEvents: [] as ReadonlyArray<OrchestrationV2StoredEvent>,
                };
              const storedEvents = yield* eventStore.append({
                ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
                events: yield* normalizeEvents(retired),
              });
              yield* applyStoredEvents(storedEvents);
              return { committed: true as const, storedEvents };
            }

            let events = input.events;
            if (input.rootExecution !== undefined) {
              // Re-read ownership and link under the same transaction as the event batch.
              // A routed event is only a proposal until this compare-and-commit succeeds.
              const owner = input.rootExecution;
              const rows = yield* sql<{
                run_payload: string;
                run_instance: string;
                run_thread: string | null;
                attempt_payload: string;
                thread_payload: string;
                attempt_run: string;
                attempt_root: string;
                attempt_instance: string;
                attempt_thread: string;
                attempt_turn: string | null;
                attempt_status: string;
                thread_instance: string;
                thread_session: string | null;
                thread_driver: string;
                last_run_ordinal: number | null;
              }>`SELECT r.payload_json AS run_payload,a.payload_json AS attempt_payload,
                p.payload_json AS thread_payload,r.provider_instance_id AS run_instance,r.provider_thread_id AS run_thread,a.run_id AS attempt_run,a.root_node_id AS attempt_root,
                a.provider_instance_id AS attempt_instance,a.provider_thread_id AS attempt_thread,
                a.provider_turn_id AS attempt_turn,a.status AS attempt_status,
                p.provider_instance_id AS thread_instance,p.provider_session_id AS thread_session,p.driver AS thread_driver,p.last_run_ordinal
                FROM orchestration_v2_projection_runs r
                JOIN orchestration_v2_projection_run_attempts a ON a.attempt_id=${input.activeAttemptId} AND a.thread_id=r.thread_id
                JOIN orchestration_v2_projection_provider_threads p ON p.provider_thread_id=${owner.providerThreadId} AND p.thread_id=r.thread_id
                WHERE r.run_id=${input.runId} AND r.thread_id=${input.threadId} LIMIT 1`;
              const row = rows[0];
              const run = row === undefined ? Option.none() : decodeRun(row.run_payload);
              const attempt =
                row === undefined ? Option.none() : decodeAttempt(row.attempt_payload);
              const thread = row === undefined ? Option.none() : decodeThread(row.thread_payload);
              const reject = {
                committed: false as const,
                storedEvents: [] as ReadonlyArray<OrchestrationV2StoredEvent>,
              };
              if (
                row === undefined ||
                Option.isNone(run) ||
                Option.isNone(attempt) ||
                Option.isNone(thread)
              )
                return reject;
              const r = run.value,
                a = attempt.value,
                p = thread.value;
              if (
                r.id !== input.runId ||
                r.threadId !== input.threadId ||
                r.status !== input.expectedStatus ||
                r.activeAttemptId !== input.activeAttemptId ||
                r.rootNodeId !== owner.rootNodeId ||
                r.providerThreadId !== owner.providerThreadId ||
                r.providerInstanceId !== owner.providerInstanceId ||
                r.ordinal !== owner.runOrdinal ||
                row.run_instance !== r.providerInstanceId ||
                row.run_thread !== r.providerThreadId ||
                a.id !== input.activeAttemptId ||
                a.runId !== r.id ||
                a.rootNodeId !== owner.rootNodeId ||
                a.providerInstanceId !== owner.providerInstanceId ||
                a.providerThreadId !== owner.providerThreadId ||
                a.status !== "running" ||
                row.attempt_run !== a.runId ||
                row.attempt_root !== a.rootNodeId ||
                row.attempt_instance !== a.providerInstanceId ||
                row.attempt_thread !== a.providerThreadId ||
                row.attempt_turn !== a.providerTurnId ||
                row.attempt_status !== a.status ||
                p.id !== owner.providerThreadId ||
                p.appThreadId !== input.threadId ||
                p.providerSessionId !== owner.providerSessionId ||
                p.providerInstanceId !== owner.providerInstanceId ||
                p.driver !== owner.driver ||
                row.thread_instance !== p.providerInstanceId ||
                row.thread_session !== p.providerSessionId ||
                row.thread_driver !== p.driver ||
                p.lastRunOrdinal !== owner.runOrdinal ||
                row.last_run_ordinal !== owner.runOrdinal
              )
                return reject;
              for (const event of input.effects === undefined ? events : []) {
                if (
                  event.type === "node.updated" &&
                  event.payload.threadId === input.threadId &&
                  event.payload.runId === input.runId &&
                  event.payload.providerTurnId === null &&
                  event.payload.rootNodeId !== owner.rootNodeId
                )
                  return reject;
                if (
                  (event.type === "node.updated" || event.type === "turn-item.updated") &&
                  event.payload.threadId === input.threadId &&
                  event.payload.runId === input.runId &&
                  event.payload.providerTurnId !== null &&
                  event.payload.providerTurnId !== a.providerTurnId
                )
                  return reject;
                if (
                  event.type === "subagent.updated" &&
                  event.payload.threadId === input.threadId &&
                  event.payload.runId === input.runId &&
                  event.payload.parentNodeId !== owner.rootNodeId
                ) {
                  const anchors = yield* sql`SELECT node_id FROM orchestration_v2_projection_nodes
                    WHERE node_id=${event.payload.id} AND thread_id=${input.threadId} AND run_id=${input.runId}
                    AND provider_turn_id=${a.providerTurnId} AND provider_thread_id=${owner.providerThreadId} LIMIT 1`;
                  if (anchors.length !== 1) return reject;
                }
              }
              const alias = owner.rootThreadAlias;
              if (
                alias !== undefined &&
                (alias.id === p.id ||
                  alias.appThreadId !== p.appThreadId ||
                  alias.driver !== p.driver ||
                  alias.providerSessionId !== p.providerSessionId ||
                  alias.providerInstanceId !== p.providerInstanceId ||
                  alias.ownerNodeId !== p.ownerNodeId ||
                  alias.lastRunOrdinal !== owner.runOrdinal ||
                  p.nativeThreadRef?.strength !== "strong" ||
                  p.nativeThreadRef.nativeId === null ||
                  alias.nativeThreadRef?.strength !== "strong" ||
                  !sameRef(p.nativeThreadRef, alias.nativeThreadRef) ||
                  p.forkedFrom === null ||
                  alias.forkedFrom === null ||
                  p.forkedFrom.providerThreadId !== alias.forkedFrom.providerThreadId ||
                  p.forkedFrom.providerTurnId !== alias.forkedFrom.providerTurnId ||
                  p.forkedFrom.checkpointId !== alias.forkedFrom.checkpointId)
              )
                return reject;
              const observed = events.find(
                (event) =>
                  event.type === "provider-turn.updated" && event.payload.runAttemptId === a.id,
              );
              const turnId = owner.providerTurnId;
              if (turnId !== undefined) {
                if (a.providerTurnId !== null && a.providerTurnId !== turnId) return reject;
                const previousRows = yield* sql<{
                  thread_id: string;
                  payload_json: string;
                  provider_thread_id: string;
                  run_attempt_id: string | null;
                  node_id: string;
                  status: string;
                  ordinal: number;
                }>`
                  SELECT thread_id,payload_json,provider_thread_id,run_attempt_id,node_id,status,ordinal FROM orchestration_v2_projection_provider_turns WHERE provider_turn_id=${turnId} LIMIT 1`;
                const previousRow = previousRows[0];
                const previous =
                  previousRow === undefined
                    ? undefined
                    : decodeProviderTurn(previousRow.payload_json);
                if (
                  previousRow !== undefined &&
                  (previousRow.thread_id !== input.threadId ||
                    previous === undefined ||
                    Option.isNone(previous))
                )
                  return reject;
                const existing =
                  previous !== undefined && Option.isSome(previous) ? previous.value : undefined;
                const turn =
                  observed?.type === "provider-turn.updated" ? observed.payload : existing;
                if (
                  turn === undefined ||
                  turn.id !== turnId ||
                  turn.runAttemptId !== a.id ||
                  turn.nodeId !== owner.rootNodeId ||
                  turn.providerThreadId !== owner.providerThreadId ||
                  turn.ordinal !== owner.providerTurnOrdinal
                )
                  return reject;
                if (
                  existing !== undefined &&
                  (previousRow?.provider_thread_id !== existing.providerThreadId ||
                    previousRow.run_attempt_id !== existing.runAttemptId ||
                    previousRow.node_id !== existing.nodeId ||
                    previousRow.status !== existing.status ||
                    previousRow.ordinal !== existing.ordinal ||
                    existing.id !== turnId ||
                    existing.runAttemptId !== a.id ||
                    existing.nodeId !== owner.rootNodeId ||
                    existing.providerThreadId !== owner.providerThreadId ||
                    existing.ordinal !== owner.providerTurnOrdinal ||
                    (existing.status !== "running" &&
                      existing.status !== "pending" &&
                      turn.status !== existing.status))
                )
                  return reject;
                if (
                  observed !== undefined &&
                  (observed.threadId !== input.threadId ||
                    observed.runId !== r.id ||
                    observed.driver !== owner.driver)
                )
                  return reject;
                if (
                  owner.terminalStatus !== undefined &&
                  (a.providerTurnId !== turnId || existing?.status !== owner.terminalStatus)
                )
                  return reject;
                if (observed !== undefined && a.providerTurnId === null) {
                  events = [
                    ...events,
                    {
                      id: EventId.make(`${observed.id}:attempt-link`),
                      type: "run-attempt.updated",
                      threadId: input.threadId,
                      runId: r.id,
                      nodeId: owner.rootNodeId,
                      providerInstanceId: owner.providerInstanceId,
                      occurredAt: observed.occurredAt,
                      payload: { ...a, providerTurnId: turnId },
                    },
                  ];
                }
              }
              // Terminal snapshots captured at start must never erase the committed link.
              events = events.map((event) =>
                event.type === "run-attempt.updated" && event.payload.id === a.id
                  ? {
                      ...event,
                      payload: {
                        ...a,
                        providerTurnId: turnId ?? a.providerTurnId,
                        status: event.payload.status,
                        completedAt: event.payload.completedAt,
                      },
                    }
                  : event,
              );
            }
            const neverStarted =
              input.providerNotStarted === true && current.status === "starting"
                ? yield* sql`SELECT attempt_id FROM orchestration_v2_projection_run_attempts
                  WHERE attempt_id=${input.activeAttemptId} AND run_id=${input.runId}
                    AND thread_id=${input.threadId} AND status='pending' AND provider_turn_id IS NULL`
                : [];
            const normalized = yield* normalizeEvents(
              input.guardPendingUserInputCancellations === true
                ? yield* guardUserInputCancellations(events)
                : events,
            );
            const storedEvents = yield* eventStore.append({
              ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
              events: normalized,
            });
            yield* applyStoredEvents(storedEvents);
            if (neverStarted.length === 1) {
              const now = DateTime.formatIso(yield* DateTime.now);
              yield* sql`UPDATE base3_capacity_leases SET status='released',released_at=${now}
                WHERE thread_id=${input.threadId} AND run_id=${input.runId} AND released_at IS NULL
                  AND EXISTS (SELECT 1 FROM orchestration_v2_projection_runs AS run
                    WHERE run.run_id=${input.runId} AND run.thread_id=${input.threadId}
                      AND json_extract(run.payload_json,'$.activeAttemptId')=${input.activeAttemptId}
                      AND run.status IN ('completed','failed','cancelled','interrupted','rolled_back'))
                  AND NOT EXISTS (
                    SELECT 1 FROM orchestration_v2_projection_provider_turns AS native
                    JOIN orchestration_v2_projection_run_attempts AS attempt ON attempt.attempt_id=native.run_attempt_id
                    WHERE attempt.run_id=${input.runId} AND attempt.thread_id=${input.threadId}
                      AND (native.status IN ('pending','running') OR COALESCE(json_extract(native.payload_json,'$.terminationConfirmed'),0)<>1)
                  )`;
            }
            yield* effectOutbox.enqueue(input.effects ?? []);
            return { committed: true as const, storedEvents };
          }),
        );
        if (result.committed) {
          if (input.effects !== undefined && input.effects.length > 0)
            yield* effectOutbox.notifyAvailable(input.effects.length);
          yield* eventStore.publishCommitted(result.storedEvents);
          yield* publishLiveEvents(result.storedEvents);
        }
        return result;
      },
    );

    const writeIfProviderThreadOwnerEffect = Effect.fn(
      "orchestrationV2.EventSink.writeIfProviderThreadOwner",
    )(function* (input: Parameters<EventSinkV2Shape["writeIfProviderThreadOwner"]>[0]) {
      yield* Effect.annotateCurrentSpan({
        "orchestration_v2.command_id": input.commandId ?? null,
        "orchestration_v2.event_count": input.events.length,
        "orchestration_v2.provider_thread_id": input.providerThreadId,
        "orchestration_v2.run_id": input.runId,
        "orchestration_v2.active_attempt_id": input.activeAttemptId,
        "orchestration_v2.expected_last_run_ordinal": input.expectedLastRunOrdinal,
      });

      const result = yield* sql.withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{
            readonly active_attempt_id: string | null;
            readonly last_run_ordinal: number | null;
          }>`
            SELECT
              json_extract(r.payload_json, '$.activeAttemptId') AS active_attempt_id,
              p.last_run_ordinal
            FROM orchestration_v2_projection_provider_threads p
            JOIN orchestration_v2_projection_runs r
              ON r.run_id = ${input.runId}
             AND r.thread_id = p.thread_id
            WHERE p.provider_thread_id = ${input.providerThreadId}
            LIMIT 1
          `;
          const current = rows[0];
          if (
            current === undefined ||
            current.active_attempt_id !== input.activeAttemptId ||
            current.last_run_ordinal !== input.expectedLastRunOrdinal
          ) {
            return {
              committed: false as const,
              storedEvents: [] as ReadonlyArray<OrchestrationV2StoredEvent>,
            };
          }

          const normalized = yield* normalizeEvents(
            input.guardPendingUserInputCancellations === true
              ? yield* guardUserInputCancellations(input.events)
              : input.events,
          );
          const storedEvents = yield* eventStore.append({
            ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
            events: normalized,
          });
          yield* applyStoredEvents(storedEvents);
          return { committed: true as const, storedEvents };
        }),
      );
      if (result.committed) {
        yield* eventStore.publishCommitted(result.storedEvents);
        yield* publishLiveEvents(result.storedEvents);
      }
      return result;
    });

    const existingCommandResult = (commandId: CommandId) =>
      Effect.gen(function* () {
        const existing = yield* commandReceipts.getByCommandId(commandId);
        if (Option.isNone(existing)) {
          return yield* Effect.die(
            new Error(`Command receipt ${commandId} disappeared during its transaction.`),
          );
        }
        const storedEvents = yield* eventStore.readByCommandId({ commandId }).pipe(
          Stream.runCollect,
          Effect.map((events): ReadonlyArray<OrchestrationV2StoredEvent> => Array.from(events)),
        );
        return { receipt: existing.value, storedEvents };
      });

    const commitCommandEffect = Effect.fn("orchestrationV2.EventSink.commitCommand")(function* (
      input: Parameters<EventSinkV2Shape["commitCommand"]>[0],
    ) {
      const result = yield* sql.withTransaction(
        Effect.gen(function* () {
          const reserved = yield* commandReceipts.insertIfAbsent({
            commandId: input.commandId,
            threadId: input.threadId,
            commandType: input.commandType,
            acceptedAt: input.acceptedAt,
            resultSequence: 0,
            status: "accepted",
            error: null,
          });
          if (!reserved) {
            const existing = yield* existingCommandResult(input.commandId);
            const refuse = () =>
              new EventSinkWriteError({
                commandId: input.commandId,
                eventCount: input.events.length,
              });
            if (
              existing.receipt.threadId !== input.threadId ||
              existing.receipt.commandType !== input.commandType
            )
              return yield* refuse();
            if (
              [
                "thread.task-contract.accept",
                "thread.task-contract.redirect",
                "thread.task-contract.resume",
              ].includes(existing.receipt.commandType) &&
              input.taskContractDecision === undefined
            )
              return yield* refuse();
            if (input.taskContractDecision !== undefined)
              yield* verifyTaskDecisionReplay(sql, {
                ...input.taskContractDecision,
                commandId: input.commandId,
                threadId: input.threadId,
              });
            if (existing.receipt.commandType === "thread.task-contract.set")
              yield* verifyTaskDecisionReplay(sql, {
                commandId: input.commandId,
                threadId: input.threadId,
                action: "set",
                ...(input.reviewedSet === undefined ? {} : { reviewedSet: input.reviewedSet }),
              });
            let taskEnrollment: TaskEnrollmentOutcome | undefined;
            if (
              existing.receipt.commandType === "thread.create" ||
              existing.receipt.commandType === "thread.task-contract.set"
            ) {
              const context = yield* PolicyExecutionContext;
              const actorId = context.kind === "session" ? context.actorId : "";
              if (existing.receipt.commandType === "thread.create")
                yield* OwnedChat.verifyOriginReplay(sql, {
                  threadId: existing.receipt.threadId,
                  commandId: existing.receipt.commandId,
                  actorId,
                });
              else
                taskEnrollment = yield* OwnedChat.readOutcome(sql, {
                  threadId: existing.receipt.threadId,
                  commandId: existing.receipt.commandId,
                  actorId,
                });
            }
            if (existing.receipt.commandType === "thread.create") {
              if (input.creationCommand !== undefined) {
                if (
                  input.creationCommand.commandId !== input.commandId ||
                  input.creationCommand.threadId !== input.threadId
                )
                  return yield* refuse();
                yield* verifyReviewedCreateReplay(sql, input.creationCommand);
              } else {
                const original = existing.storedEvents.find(
                  (stored) => stored.event.type === "thread.created",
                );
                if (
                  original?.event.type === "thread.created" &&
                  original.event.payload.agentsTaskCreation !== undefined
                )
                  return yield* refuse();
              }
              const rows = yield* sql<{
                payload_json: string;
              }>`SELECT payload_json FROM collaboration_commands WHERE command_id=${`task:enroll:${existing.receipt.commandId}`} LIMIT 1`;
              if (rows[0] !== undefined || input.governedTaskOwner !== undefined) {
                const enrollment =
                  rows[0] === undefined ? undefined : decodeEnrollmentCommand(rows[0].payload_json);
                const context = yield* PolicyExecutionContext;
                if (
                  enrollment?._tag !== "Some" ||
                  enrollment.value.type !== "task.enroll" ||
                  enrollment.value.admissionSource !== "server" ||
                  enrollment.value.threadId !== input.threadId ||
                  context.kind !== "session" ||
                  enrollment.value.admittedBy !== context.actorId ||
                  (input.governedTaskOwner !== undefined &&
                    enrollment.value.admittedBy !== input.governedTaskOwner)
                )
                  return yield* refuse();
              }
            }
            return {
              ...existing,
              committed: false as const,
              cancelledEffectIds: [],
              ...(taskEnrollment === undefined ? {} : { taskEnrollment }),
            };
          }

          if (
            input.commandType === "delegated_task.request" &&
            (yield* PolicyExecutionContext).kind !== "kernel-test" &&
            input.approvedDelegation === undefined
          )
            return yield* new EventSinkWriteError({
              commandId: input.commandId,
              eventCount: input.events.length,
            });
          if (
            input.events.some(
              (event) =>
                event.type === "message.updated" && event.payload.capabilityStep !== undefined,
            ) &&
            input.capabilityCommand?.capabilityStep === undefined
          )
            return yield* new EventSinkWriteError({
              commandId: input.commandId,
              eventCount: input.events.length,
            });
          if (input.capabilityCommand !== undefined) {
            if (
              input.commandType !== "message.dispatch" ||
              input.capabilityCommand.commandId !== input.commandId ||
              input.capabilityCommand.threadId !== input.threadId
            )
              return yield* new EventSinkWriteError({
                commandId: input.commandId,
                eventCount: input.events.length,
              });
            yield* commitCapabilityStep(sql, input.capabilityCommand, input.events);
          }
          if (
            input.events.some(
              (e) => e.type === "message.updated" && e.payload.taskFirstLaunch !== undefined,
            ) &&
            !input.firstLaunchCommand?.taskFirstLaunch
          )
            return yield* new EventSinkWriteError({
              commandId: input.commandId,
              eventCount: input.events.length,
            });
          if (input.commandType === "message.dispatch")
            yield* validateHandoffFirstInput(
              sql,
              input.threadId,
              input.firstLaunchCommand?.taskFirstLaunch,
            );
          if (input.firstLaunchCommand) {
            if (
              input.firstLaunchCommand.commandId !== input.commandId ||
              input.firstLaunchCommand.threadId !== input.threadId ||
              input.commandType !== "message.dispatch"
            )
              return yield* new EventSinkWriteError({
                commandId: input.commandId,
                eventCount: input.events.length,
              });
            yield* withReferenceStore(
              commitFirstTaskLaunch(sql, input.firstLaunchCommand, input.events, (id) =>
                projectionStore.getThreadProjection(id),
              ),
            );
          }
          if (
            input.events.some(
              (e) => e.type === "message.updated" && e.payload.taskResultContinuation !== undefined,
            ) &&
            !input.resultContinuationCommand?.taskResultContinuation
          )
            return yield* new EventSinkWriteError({
              commandId: input.commandId,
              eventCount: input.events.length,
            });
          if (input.resultContinuationCommand) {
            if (
              input.resultContinuationCommand.commandId !== input.commandId ||
              input.resultContinuationCommand.threadId !== input.threadId ||
              input.commandType !== "message.dispatch"
            )
              return yield* new EventSinkWriteError({
                commandId: input.commandId,
                eventCount: input.events.length,
              });
            yield* commitResultContinuation(
              sql,
              input.resultContinuationCommand,
              input.events,
              (id) => projectionStore.getThreadProjection(id),
            );
          }
          if (input.approvedDelegation !== undefined) {
            if (
              input.commandType !== "delegated_task.request" ||
              input.commandId !== input.approvedDelegation.command.commandId ||
              input.threadId !== input.approvedDelegation.command.parentThreadId
            )
              return yield* new EventSinkWriteError({
                commandId: input.commandId,
                eventCount: input.events.length,
              });
            yield* admitDelegationCommit(sql, input.approvedDelegation.command);
            yield* commitApprovedDelegation(sql, input.approvedDelegation, input.events);
          }
          if (
            input.commandType === "message.dispatch" &&
            (yield* PolicyExecutionContext).kind !== "kernel-test"
          ) {
            for (const event of input.events) {
              if (
                event.type === "message.updated" &&
                event.payload.delegatedCompletion !== undefined
              )
                yield* commitMailboxAuthority(sql, event.payload);
            }
          }

          // Native completion does not take the command lock. Validate the old
          // attempt and slot again inside this transaction before replacing it.
          if (
            input.commandType === "message.dispatch" &&
            (yield* PolicyExecutionContext).kind !== "kernel-test"
          ) {
            for (const effect of input.effects) {
              const request = effect.request;
              if (
                request.type !== "provider-turn.restart" &&
                request.type !== "provider-turn.steer"
              )
                continue;
              const turns = yield* sql<{ run_id: string; attempt_id: string }>`
                SELECT attempt.run_id, attempt.attempt_id
                FROM orchestration_v2_projection_provider_turns AS turn
                JOIN orchestration_v2_projection_run_attempts AS attempt
                  ON attempt.attempt_id=turn.run_attempt_id
                WHERE turn.provider_turn_id=${request.providerTurnId}
                  AND turn.thread_id=${input.threadId} AND turn.status='running'
              `;
              const target = turns[0];
              if (target === undefined)
                return yield* new EventSinkWriteError({
                  commandId: input.commandId,
                  eventCount: input.events.length,
                });
              yield* verifyActiveRunLease({
                sql,
                threadId: input.threadId,
                runId: target.run_id,
                attemptId: target.attempt_id,
                commandType: input.commandType,
              });
            }
          }

          if (
            input.commandType === "thread.create" ||
            input.governedTaskOwner !== undefined ||
            input.ordinaryRootOwner !== undefined
          ) {
            const existing =
              yield* sql`SELECT thread_id FROM orchestration_v2_projection_threads WHERE thread_id=${input.threadId}`;
            const enrollment = yield* sql`SELECT command_id FROM collaboration_commands
              WHERE CASE WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.type')='task.enroll'
                AND json_extract(payload_json,'$.threadId')=${input.threadId} ELSE 0 END LIMIT 1`;
            if (
              input.commandType !== "thread.create" ||
              enrollment.length > 0 ||
              (yield* OwnedChat.hasOrigin(sql, input.threadId)) ||
              (existing.length > 0 &&
                (input.governedTaskOwner !== undefined || input.ordinaryRootOwner !== undefined))
            )
              return yield* new EventSinkWriteError({
                commandId: input.commandId,
                eventCount: input.events.length,
              });
          }
          const context = yield* PolicyExecutionContext;
          if (input.commandType === "thread.create") {
            const created = input.events.find((event) => event.type === "thread.created");
            const reviewed = input.creationCommand?.taskCreationReview !== undefined;
            if (
              created?.type === "thread.created" &&
              (reviewed || created.payload.agentsTaskCreation !== undefined)
            ) {
              if (
                !input.creationCommand ||
                input.creationCommand.threadId !== input.threadId ||
                input.creationCommand.commandId !== input.commandId
              )
                return yield* new EventSinkWriteError({
                  commandId: input.commandId,
                  eventCount: input.events.length,
                });
              const proof = yield* validateReviewedCreate(sql, input.creationCommand, (id) =>
                projectionStore.getThreadProjection(id),
              );
              if (
                proof === undefined ||
                input.events.length !== 1 ||
                input.effects.length !== 0 ||
                !reviewedCreateMatchesThread(input.creationCommand, created.payload) ||
                context.kind !== "session" ||
                input.governedTaskOwner !== context.actorId ||
                created.payload.agentsTaskCreation?.actorId !== proof.actorId ||
                created.payload.agentsTaskCreation?.commandId !== proof.commandId
              )
                return yield* new EventSinkWriteError({
                  commandId: input.commandId,
                  eventCount: input.events.length,
                });
            }
          }
          if (
            input.contractSetActor !== undefined &&
            (input.commandType !== "thread.task-contract.set" ||
              context.kind !== "session" ||
              context.actorId !== input.contractSetActor)
          )
            return yield* new EventSinkWriteError({
              commandId: input.commandId,
              eventCount: input.events.length,
            });
          if (input.commandType === "thread.task-contract.set")
            yield* validateTaskDecision(sql, {
              threadId: input.threadId,
              action: "set",
              ...(input.reviewedSet?.expectedRevision === undefined
                ? {}
                : { expectedRevision: input.reviewedSet.expectedRevision }),
              ...(input.reviewedSet?.reviewTask === undefined
                ? {}
                : { reviewTask: input.reviewedSet.reviewTask }),
            });
          const upgrade =
            input.contractSetActor === undefined
              ? undefined
              : yield* OwnedChat.upgradeEligibility(sql, {
                  threadId: input.threadId,
                  actorId: input.contractSetActor,
                });
          if (
            [
              "thread.task-contract.accept",
              "thread.task-contract.redirect",
              "thread.task-contract.resume",
            ].includes(input.commandType) &&
            input.taskContractDecision === undefined
          )
            return yield* new EventSinkWriteError({
              commandId: input.commandId,
              eventCount: input.events.length,
            });
          let decisionEvents = input.events;
          if (input.commandType === "thread.task-contract.set") {
            const current = yield* projectionStore.getThread(input.threadId);
            const event = input.events.find(
              (item) => item.type === "thread.metadata-updated" && item.threadId === input.threadId,
            );
            if (
              input.events.length !== 1 ||
              event?.type !== "thread.metadata-updated" ||
              context.kind !== "session" ||
              event.payload.taskDecisions?.at(-1)?.kind !== "set" ||
              event.payload.taskDecisions?.at(-1)?.actorId !== context.actorId ||
              event.payload.projectId !== current.projectId ||
              event.payload.lineage.rootThreadId !== current.lineage.rootThreadId ||
              event.payload.lineage.parentThreadId !== current.lineage.parentThreadId ||
              event.payload.lineage.relationshipToParent !== current.lineage.relationshipToParent ||
              event.payload.taskContract == null
            )
              return yield* new EventSinkWriteError({
                commandId: input.commandId,
                eventCount: input.events.length,
              });
            const plannedSet = event.payload.taskDecisions?.at(-1);
            if (
              input.reviewedSet === undefined &&
              (plannedSet?.reviewTask !== undefined || plannedSet?.expectedRevision !== undefined)
            )
              return yield* new EventSinkWriteError({
                commandId: input.commandId,
                eventCount: input.events.length,
              });
            if (
              input.reviewedSet !== undefined &&
              (input.reviewedSet.commandId !== input.commandId ||
                input.reviewedSet.threadId !== input.threadId)
            )
              return yield* new EventSinkWriteError({
                commandId: input.commandId,
                eventCount: input.events.length,
              });
            const next = nextTaskContractThread({
              thread: current,
              actorId: context.actorId,
              now: event.occurredAt,
              command: input.reviewedSet ?? {
                type: "thread.task-contract.set",
                goal: event.payload.taskContract.goal,
                redirect: event.payload.taskContract.redirect,
                acceptance: event.payload.taskContract.acceptance,
                brake: event.payload.taskContract.brake,
              },
            });
            if ("error" in next)
              return yield* new EventSinkWriteError({
                commandId: input.commandId,
                eventCount: input.events.length,
              });
            decisionEvents = [{ ...event, payload: next.thread }];
            yield* revokeTaskContractGrants(sql, current.lineage.rootThreadId);
          }
          if (input.taskContractDecision !== undefined) {
            if (input.commandType !== `thread.task-contract.${input.taskContractDecision.action}`)
              return yield* new EventSinkWriteError({
                commandId: input.commandId,
                eventCount: input.events.length,
              });
            yield* validateTaskDecision(sql, {
              ...input.taskContractDecision,
              threadId: input.threadId,
            });
            const event = input.events.find(
              (item) => item.type === "thread.metadata-updated" && item.threadId === input.threadId,
            );
            const decision =
              event?.type === "thread.metadata-updated"
                ? event.payload.taskDecisions?.at(-1)
                : undefined;
            if (
              !decision ||
              decision.kind !== input.taskContractDecision.action ||
              decision.revision !== input.taskContractDecision.revision ||
              context.kind !== "session" ||
              decision.actorId !== context.actorId
            )
              return yield* new EventSinkWriteError({
                commandId: input.commandId,
                eventCount: input.events.length,
              });
            {
              if (input.events.length !== 1 || event?.type !== "thread.metadata-updated")
                return yield* new EventSinkWriteError({
                  commandId: input.commandId,
                  eventCount: input.events.length,
                });
              const current = yield* projectionStore.getThread(input.threadId);
              if (
                event.payload.projectId !== current.projectId ||
                event.payload.lineage.rootThreadId !== current.lineage.rootThreadId ||
                event.payload.lineage.parentThreadId !== current.lineage.parentThreadId ||
                event.payload.lineage.relationshipToParent !== current.lineage.relationshipToParent
              )
                return yield* new EventSinkWriteError({
                  commandId: input.commandId,
                  eventCount: input.events.length,
                });
              const next = nextTaskContractThread({
                thread: current,
                actorId: context.actorId,
                now: event.occurredAt,
                command: {
                  type: input.commandType as
                    | "thread.task-contract.accept"
                    | "thread.task-contract.redirect"
                    | "thread.task-contract.resume",
                  revision: input.taskContractDecision.revision,
                  ...(input.taskContractDecision.reviewTask === undefined
                    ? {}
                    : { reviewTask: input.taskContractDecision.reviewTask }),
                },
              });
              if ("error" in next)
                return yield* new EventSinkWriteError({
                  commandId: input.commandId,
                  eventCount: input.events.length,
                });
              decisionEvents = [{ ...event, payload: next.thread }];
            }
            if (input.taskContractDecision.action === "redirect") {
              const current = yield* projectionStore.getThread(input.threadId);
              yield* requestTaskCancellation(sql, current.lineage.rootThreadId, input.threadId);
            }
          }
          const normalized = yield* normalizeEvents(decisionEvents);
          const storedEvents = yield* eventStore.append({
            commandId: input.commandId,
            events: normalized,
          });
          const sequence = storedEvents.at(-1)?.sequence;
          if (sequence === undefined) {
            return yield* Effect.die(
              new Error(`Command ${input.commandId} produced no orchestration events.`),
            );
          }
          yield* applyStoredEvents(storedEvents);
          // A cancelled pending replacement has no native event of its own.
          // Release only if its immediately preceding attempt has persisted
          // native termination proof; a recovery projection alone is not proof.
          yield* sql`
            UPDATE base3_capacity_leases SET status='released', released_at=${DateTime.formatIso(input.acceptedAt)}
            WHERE thread_id=${input.threadId} AND released_at IS NULL AND EXISTS (
              SELECT 1 FROM orchestration_v2_projection_runs AS run
              JOIN orchestration_v2_projection_run_attempts AS current
                ON current.attempt_id=json_extract(run.payload_json,'$.activeAttemptId')
              JOIN orchestration_v2_projection_run_attempts AS old
                ON old.run_id=run.run_id AND old.attempt_ordinal=current.attempt_ordinal-1
              JOIN orchestration_v2_projection_provider_turns AS native ON native.provider_turn_id=old.provider_turn_id
              WHERE run.run_id=base3_capacity_leases.run_id AND run.thread_id=${input.threadId}
                AND run.status IN ('completed','failed','cancelled','interrupted','rolled_back')
                AND current.provider_turn_id IS NULL
                AND json_extract(current.payload_json,'$.startedAt') IS NULL
                AND native.status IN ('completed','failed','cancelled','interrupted')
                AND json_extract(native.payload_json,'$.terminationConfirmed')=1
            )
          `;
          if (input.governedTaskOwner !== undefined)
            yield* enrollGovernedTask(sql, {
              principalId: input.governedTaskOwner,
              threadId: input.threadId,
              creationCommandId: input.commandId,
            });
          if (input.ordinaryRootOwner !== undefined)
            yield* OwnedChat.captureOrigin(sql, {
              threadId: input.threadId,
              creationCommandId: input.commandId,
              actorId: input.ordinaryRootOwner,
            });
          let taskEnrollment: TaskEnrollmentOutcome | undefined;
          if (input.contractSetActor !== undefined && upgrade !== undefined) {
            if ("origin" in upgrade && upgrade.origin !== undefined) {
              const event = storedEvents.find(
                (stored) =>
                  stored.event.type === "thread.metadata-updated" &&
                  stored.event.threadId === input.threadId,
              )?.event;
              if (
                !event ||
                event.type !== "thread.metadata-updated" ||
                event.payload.taskContract == null ||
                event.payload.taskDecisions?.at(-1)?.actorId !== input.contractSetActor
              )
                return yield* new EventSinkWriteError({
                  commandId: input.commandId,
                  eventCount: input.events.length,
                });
              yield* enrollGovernedTask(sql, {
                principalId: input.contractSetActor,
                threadId: input.threadId,
                creationCommandId: input.commandId,
                originCommandId: upgrade.origin.creationCommandId,
                upgradeCommandId: input.commandId,
                upgradeEventId: event.id,
              });
              taskEnrollment = {
                status: "enrolled",
                taskId: `task:governed:thread:${input.threadId}`,
              };
            } else taskEnrollment = upgrade.outcome;
            if (taskEnrollment === undefined)
              return yield* new EventSinkWriteError({
                commandId: input.commandId,
                eventCount: input.events.length,
              });
            yield* OwnedChat.recordOutcome(sql, {
              commandId: input.commandId,
              threadId: input.threadId,
              actorId: input.contractSetActor,
              taskEnrollment,
            });
          }
          yield* effectOutbox.enqueue(input.effects);
          const receipt: CommandReceiptStore.CommandReceiptV2 = {
            commandId: input.commandId,
            threadId: input.threadId,
            commandType: input.commandType,
            acceptedAt: input.acceptedAt,
            resultSequence: sequence,
            status: "accepted",
            error: null,
          };
          yield* commandReceipts.upsert(receipt);
          if (taskEnrollment?.status === "enrolled" && input.contractSetActor !== undefined)
            yield* OwnedChat.verifyCommittedUpgrade(sql, {
              commandId: input.commandId,
              threadId: input.threadId,
              actorId: input.contractSetActor,
            });
          const cancelledEffectIds =
            input.cancelUnsettledEffects === undefined
              ? []
              : yield* effectOutbox.cancelUnsettled({
                  threadId: input.threadId,
                  ...input.cancelUnsettledEffects,
                });
          return {
            receipt,
            storedEvents,
            committed: true as const,
            cancelledEffectIds,
            ...(taskEnrollment === undefined ? {} : { taskEnrollment }),
          };
        }),
      );
      yield* effectOutbox.signalCancellations(result.cancelledEffectIds);
      if (result.committed && input.effects.length > 0) {
        yield* effectOutbox.notifyAvailable(input.effects.length);
      }
      if (result.committed) {
        yield* eventStore.publishCommitted(result.storedEvents);
        yield* publishLiveEvents(result.storedEvents);
      }
      return {
        receipt: result.receipt,
        storedEvents: result.storedEvents,
        committed: result.committed,
        cancelledEffectCount: result.cancelledEffectIds.length,
        ...(result.taskEnrollment === undefined ? {} : { taskEnrollment: result.taskEnrollment }),
      };
    });

    const commitRejectedCommandEffect = Effect.fn(
      "orchestrationV2.EventSink.commitRejectedCommand",
    )(function* (input: Parameters<EventSinkV2Shape["commitRejectedCommand"]>[0]) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const sequence = yield* eventStore.latestSequence({ threadId: input.threadId });
          const receipt: CommandReceiptStore.CommandReceiptV2 = {
            commandId: input.commandId,
            threadId: input.threadId,
            commandType: input.commandType,
            acceptedAt: input.rejectedAt,
            resultSequence: sequence,
            status: "rejected",
            error: input.error,
          };
          const inserted = yield* commandReceipts.insertIfAbsent(receipt);
          if (inserted) {
            if (
              input.creationCommand !== undefined &&
              input.commandType === "thread.create" &&
              input.creationCommand.commandId === input.commandId &&
              input.creationCommand.threadId === input.threadId
            )
              yield* persistReviewedCreateRejection(
                sql,
                input.creationCommand,
                DateTime.formatIso(input.rejectedAt),
                sequence,
              );
            return receipt;
          }
          const existing = yield* commandReceipts.getByCommandId(input.commandId);
          return Option.getOrElse(existing, () => receipt);
        }),
      );
    });

    const existingProjectReceipt = (commandId: CommandId) =>
      commandReceipts.getProjectByCommandId(commandId).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(`Command ${commandId} was already used by a thread command.` as const),
            onSome: Effect.succeed,
          }),
        ),
      );

    const commitProjectCommandEffect = Effect.fn("orchestrationV2.EventSink.commitProjectCommand")(
      function* (input: Parameters<EventSinkV2Shape["commitProjectCommand"]>[0]) {
        const result = yield* sql.withTransaction(
          Effect.gen(function* () {
            const reserved: CommandReceiptStore.ProjectCommandReceiptV2 = {
              commandId: input.commandId,
              projectId: input.projectId,
              commandType: input.commandType,
              acceptedAt: input.acceptedAt,
              resultSequence: 0,
              status: "accepted",
              error: null,
            };
            if (!(yield* commandReceipts.insertIfAbsent(reserved))) {
              return { receipt: yield* existingProjectReceipt(input.commandId), event: undefined };
            }
            const event = yield* eventStore.appendProjectEvent(input.event);
            yield* projectStore.apply(event);
            const receipt = { ...reserved, resultSequence: event.sequence };
            yield* commandReceipts.upsert(receipt);
            return { receipt, event };
          }),
        );
        if (result.event !== undefined) {
          yield* eventStore.publishCommitted([result.event]);
        }
        return { receipt: result.receipt, committed: result.event !== undefined };
      },
    );

    const commitRejectedProjectCommandEffect = Effect.fn(
      "orchestrationV2.EventSink.commitRejectedProjectCommand",
    )(function* (input: Parameters<EventSinkV2Shape["commitRejectedProjectCommand"]>[0]) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const receipt: CommandReceiptStore.ProjectCommandReceiptV2 = {
            commandId: input.commandId,
            projectId: input.projectId,
            commandType: input.commandType,
            acceptedAt: input.rejectedAt,
            resultSequence: yield* eventStore.latestApplicationSequence,
            status: "rejected",
            error: input.error,
          };
          return (yield* commandReceipts.insertIfAbsent(receipt))
            ? receipt
            : yield* existingProjectReceipt(input.commandId);
        }),
      );
    });

    const catchUp = (input: {
      readonly afterSequence: number;
      readonly throughSequence: number;
      readonly threadId?: ThreadId;
      readonly eventType?: OrchestrationV2DomainEvent["type"];
    }): Stream.Stream<OrchestrationV2StoredEvent, unknown> => {
      const pageSize = 256;
      const loop = (afterSequence: number): Stream.Stream<OrchestrationV2StoredEvent, unknown> =>
        Stream.unwrap(
          eventStore
            .read({
              afterSequence,
              throughSequence: input.throughSequence,
              ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
              ...(input.eventType === undefined ? {} : { eventType: input.eventType }),
              limit: pageSize,
            })
            .pipe(
              Stream.runCollect,
              Effect.map((chunk) => Array.from(chunk)),
              Effect.map((events) => {
                if (events.length === 0) {
                  return Stream.empty;
                }
                const current = Stream.fromIterable(events);
                const last = events.at(-1)?.sequence ?? input.throughSequence;
                return events.length < pageSize || last >= input.throughSequence
                  ? current
                  : Stream.concat(current, loop(last));
              }),
            ),
        );
      return loop(input.afterSequence);
    };

    const stream = (input?: Parameters<EventSinkV2Shape["stream"]>[0]) => {
      const afterSequence = input?.afterSequence ?? 0;
      const matches = (stored: OrchestrationV2StoredEvent) =>
        (input?.threadId === undefined || stored.event.threadId === input.threadId) &&
        (input?.eventType === undefined || stored.event.type === input.eventType);
      const replay = (throughSequence: number) =>
        catchUp({
          afterSequence,
          throughSequence,
          ...(input?.threadId === undefined ? {} : { threadId: input.threadId }),
          ...(input?.eventType === undefined ? {} : { eventType: input.eventType }),
        }).pipe(Stream.filter(matches));
      return Stream.unwrap(
        Effect.gen(function* () {
          let pubsub = liveEvents;
          if (input?.eventType !== undefined) {
            const existing = liveEventsByType.get(input.eventType);
            if (existing !== undefined) {
              pubsub = existing;
            } else {
              const created = yield* PubSub.unbounded<OrchestrationV2StoredEvent>();
              pubsub = liveEventsByType.get(input.eventType) ?? created;
              liveEventsByType.set(input.eventType, pubsub);
            }
          }
          if (input?.bounded === true) {
            return replayAndBufferProjectedLiveEvents({
              subscribe: PubSub.subscribe(pubsub),
              latestSequence: eventStore.latestSequence(),
              afterSequence,
              filter: matches,
              replay,
              project: (stored) => ({ ...stored, event: projectDomainEventForWire(stored.event) }),
            });
          }
          const subscription = yield* PubSub.subscribe(pubsub);
          const highWater = yield* eventStore.latestSequence();
          const live = Stream.fromSubscription(subscription).pipe(
            Stream.filter((stored) => stored.sequence > Math.max(highWater, afterSequence)),
            Stream.filter(matches),
          );
          return Stream.concat(replay(highWater), live);
        }),
      );
    };

    return EventSinkV2.of({
      write: (input) =>
        writeEffect({ ...input, effects: [] }).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                eventCount: input.events.length,
                ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
                cause,
              }),
          ),
        ),
      writeWithEffects: (input) =>
        writeEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                eventCount: input.events.length,
                ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
                cause,
              }),
          ),
        ),
      writeIfRunCurrent: (input) =>
        writeIfRunCurrentEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                eventCount: input.events.length,
                ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
                cause,
              }),
          ),
        ),
      writeIfProviderThreadOwner: (input) =>
        writeIfProviderThreadOwnerEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                eventCount: input.events.length,
                ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
                cause,
              }),
          ),
        ),
      commitCommand: (input) =>
        commitCommandEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                commandId: input.commandId,
                eventCount: input.events.length,
                cause,
              }),
          ),
        ),
      commitRejectedCommand: (input) =>
        commitRejectedCommandEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                commandId: input.commandId,
                eventCount: 0,
                cause,
              }),
          ),
        ),
      commitProjectCommand: (input) =>
        commitProjectCommandEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({ commandId: input.commandId, eventCount: 1, cause }),
          ),
        ),
      commitRejectedProjectCommand: (input) =>
        commitRejectedProjectCommandEffect(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({ commandId: input.commandId, eventCount: 0, cause }),
          ),
        ),
      stream: (input) =>
        stream(input).pipe(
          Stream.mapError(
            (cause) =>
              new EventSinkStreamError({
                ...(input?.threadId === undefined ? {} : { threadId: input.threadId }),
                ...(input?.afterSequence === undefined
                  ? {}
                  : { afterSequence: input.afterSequence }),
                cause,
              }),
          ),
        ),
      latestSequence: (input) =>
        eventStore.latestSequence(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkStreamError({
                ...(input?.threadId === undefined ? {} : { threadId: input.threadId }),
                cause,
              }),
          ),
        ),
      readByCommandId: (input) =>
        eventStore.readByCommandId(input).pipe(
          Stream.mapError(
            (cause) =>
              new EventSinkStreamError({
                cause,
              }),
          ),
        ),
    } satisfies EventSinkV2Shape);
  }),
);

/**
 * Event sink layer for application compositions that already own the
 * persistence services. Keeping the outbox instance shared with the worker is
 * important because enqueue notifications are in-memory wakeups backed by the
 * durable SQL queue.
 */
export const layerFromStores = baseLayer;

export const layer: Layer.Layer<
  EventSinkV2,
  never,
  EventStore.EventStoreV2 | ProjectionStore.ProjectionStoreV2 | SqlClient.SqlClient
> = baseLayer.pipe(
  Layer.provide(
    Layer.mergeAll(
      CommandReceiptStore.layer,
      EffectOutbox.layer,
      ProjectStore.layer,
      TurnItemPositionStore.layer,
    ),
  ),
);
