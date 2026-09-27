import {
  DISPATCHER_HANDOFF_MAX_PACKET_CHARS,
  DispatcherHandoffPacket,
  type DispatcherHandoffPreview,
  type DispatcherHandoffPreviewRequest,
  type DispatcherHandoffUnavailableReasonCode,
  DispatcherRouteTarget,
  DispatcherTaskHandoffSnapshot,
  type DispatcherTaskRouteBinding,
  type EnvironmentId,
  MessageId,
  ModelSelection,
  OrchestrationCheckpointFile,
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
  type ServerProvider,
  type TaskHandoffId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type ProjectionRepositoryError,
} from "../persistence/Errors.ts";
import {
  readDispatcherProjectedState,
  readDispatcherTaskRoute,
  resolveDispatcherRoute,
  taskRouteBindingFromDecision,
} from "./Dispatcher.ts";

const UNKNOWN = "Unknown";
const HANDOFF_FAILURE_REASON = "The selected provider could not start this handoff.";

const SourceRows = Schema.Array(
  Schema.Struct({
    threadId: ThreadId,
    sourceTurnId: TurnId,
    sourceMessageId: Schema.NullOr(MessageId),
    assistantMessageId: Schema.NullOr(MessageId),
    sourceText: Schema.NullOr(Schema.String),
    state: Schema.String,
    checkpointFiles: Schema.fromJsonString(Schema.Array(OrchestrationCheckpointFile)),
    branch: Schema.NullOr(Schema.String),
    worktreePath: Schema.NullOr(Schema.String),
    workspaceRoot: Schema.String,
    sessionStatus: Schema.NullOr(Schema.String),
  }),
);
const ObjectiveRows = Schema.Array(Schema.Struct({ text: Schema.String }));
const ExistingRows = Schema.Array(Schema.Struct({ handoffId: Schema.String }));
const HandoffRows = Schema.Array(
  Schema.Struct({
    handoffId: Schema.String,
    sourceTurnId: TurnId,
    destinationMessageId: MessageId,
    destinationTurnId: Schema.NullOr(TurnId),
    target: Schema.fromJsonString(DispatcherRouteTarget),
    status: Schema.Literals(["creating", "failed", "continued"]),
    failureReason: Schema.NullOr(Schema.String),
    createdAt: Schema.String,
    updatedAt: Schema.String,
  }),
);

const decodeSourceRows = Schema.decodeUnknownEffect(SourceRows);
const decodeObjectiveRows = Schema.decodeUnknownEffect(ObjectiveRows);
const decodeExistingRows = Schema.decodeUnknownEffect(ExistingRows);
const decodeHandoffRows = Schema.decodeUnknownEffect(HandoffRows);
const decodeHandoffSnapshot = Schema.decodeEffect(DispatcherTaskHandoffSnapshot);
const encodeTarget = Schema.encodeEffect(Schema.fromJsonString(DispatcherRouteTarget));

type Source = (typeof SourceRows.Type)[number];

const bounded = (value: string | null | undefined, max = 4_000): string => {
  const normalized = value?.trim();
  if (!normalized) return UNKNOWN;
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
};

const safeProjectRelativePath = (path: string): string | null => {
  const normalized = path.replaceAll("\\", "/").trim();
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    /^[a-z]:\//i.test(normalized) ||
    normalized.split("/").includes("..")
  ) {
    return null;
  }
  return bounded(normalized, 1_024);
};

const unavailable = (
  reasonCode: DispatcherHandoffUnavailableReasonCode,
  reason: string,
): DispatcherHandoffPreview["availability"] => ({ status: "unavailable", reasonCode, reason });

const readSource = Effect.fn("DispatcherHandoff.readSource")(function* (input: {
  readonly threadId: ThreadId;
  readonly sourceTurnId: TurnId;
}) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`
    SELECT
      t.thread_id AS "threadId",
      t.turn_id AS "sourceTurnId",
      t.pending_message_id AS "sourceMessageId",
      t.assistant_message_id AS "assistantMessageId",
      m.text AS "sourceText",
      t.state AS "state",
      t.checkpoint_files_json AS "checkpointFiles",
      th.branch AS "branch",
      th.worktree_path AS "worktreePath",
      p.workspace_root AS "workspaceRoot",
      s.status AS "sessionStatus"
    FROM projection_turns t
    JOIN projection_threads th ON th.thread_id = t.thread_id
    JOIN projection_projects p ON p.project_id = th.project_id
    LEFT JOIN projection_thread_messages m ON m.message_id = t.pending_message_id
    LEFT JOIN projection_thread_sessions s ON s.thread_id = t.thread_id
    WHERE t.thread_id = ${input.threadId}
      AND t.turn_id = ${input.sourceTurnId}
    LIMIT 1
  `;
  return (yield* decodeSourceRows(rows))[0] ?? null;
});

const readOriginalObjective = Effect.fn("DispatcherHandoff.readOriginalObjective")(function* (
  threadId: ThreadId,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`
    SELECT text
    FROM projection_thread_messages
    WHERE thread_id = ${threadId} AND role = 'user'
    ORDER BY created_at ASC, message_id ASC
    LIMIT 1
  `;
  return (yield* decodeObjectiveRows(rows))[0]?.text ?? null;
});

const hasExistingHandoff = Effect.fn("DispatcherHandoff.hasExisting")(function* (input: {
  readonly threadId: ThreadId;
  readonly sourceTurnId: TurnId;
  readonly handoffId?: TaskHandoffId;
}) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`
    SELECT handoff_id AS "handoffId"
    FROM projection_task_handoffs
    WHERE thread_id = ${input.threadId} AND source_turn_id = ${input.sourceTurnId}
    LIMIT 1
  `;
  const existing = (yield* decodeExistingRows(rows))[0]?.handoffId;
  return existing === undefined
    ? { exists: false as const }
    : { exists: true as const, sameId: existing === input.handoffId };
});

const sourceUnavailable = (source: Source | null) => {
  if (source === null) {
    return unavailable("SOURCE_TURN_NOT_FOUND", "The source turn is no longer available.");
  }
  if (!new Set(["completed", "interrupted", "error"]).has(source.state)) {
    return unavailable("SOURCE_TURN_NOT_SETTLED", "Wait for the source turn to finish first.");
  }
  if (source.sessionStatus === "starting" || source.sessionStatus === "running") {
    return unavailable("SOURCE_SESSION_ACTIVE", "Wait for the active provider turn to stop first.");
  }
  return null;
};

function candidateUnavailable(
  decision: ReturnType<typeof resolveDispatcherRoute>,
): DispatcherHandoffPreview["availability"] | null {
  const selected = decision.selected;
  if (decision.gate.decision === "ALLOW" && selected?.eligible === true) return null;
  const reason = decision.gate.reasonCodes[0];
  const message =
    reason === "PROVIDER_NOT_INSTALLED"
      ? "The selected provider runner is not installed on this environment."
      : reason === "PROVIDER_UNAUTHENTICATED"
        ? "The selected provider runner must be signed in first."
        : reason === "MODEL_NOT_FOUND"
          ? "The selected model is not available from this provider runner."
          : reason === "PROVIDER_DISABLED"
            ? "The selected provider runner is disabled."
            : "The selected provider runner is unavailable on this environment.";
  return unavailable("TARGET_RUNNER_UNAVAILABLE", message);
}

const packetText = (packet: typeof DispatcherHandoffPacket.Type): string =>
  [
    "# Task handoff",
    "",
    "Continue the same task using the verified context below. Treat unknown fields as unknown and inspect the referenced task history when needed.",
    "",
    "## Original objective",
    packet.originalObjective,
    "",
    "## Latest user instruction",
    packet.latestUserInstruction,
    "",
    "## Branch / commit",
    `- Branch: ${packet.branch}`,
    `- Commit: ${packet.commit}`,
    "",
    "## Completed work",
    packet.completedWork,
    "",
    "## Remaining steps",
    packet.remainingSteps,
    "",
    "## Test results",
    packet.testResults,
    "",
    "## References",
    ...(packet.references.length === 0
      ? ["Unknown"]
      : packet.references.map((reference) => `- ${reference.kind}: ${reference.value}`)),
  ].join("\n");

const readGitFacts = Effect.fn("DispatcherHandoff.readGitFacts")(function* (
  source: Source,
  git: GitVcsDriver["Service"],
) {
  const cwd = source.worktreePath ?? source.workspaceRoot;
  return yield* Effect.all({
    branch: git.statusDetailsLocal(cwd).pipe(
      Effect.map((status) => status.branch),
      Effect.orElseSucceed(() => source.branch),
    ),
    commit: git.resolveCommit({ cwd, revision: "HEAD" }).pipe(
      Effect.map((result) => result.commitSha),
      Effect.orElseSucceed(() => null),
    ),
  });
});

export const previewTaskHandoff = Effect.fn("DispatcherHandoff.preview")(function* (input: {
  readonly enabled: boolean;
  readonly handoffId: TaskHandoffId;
  readonly request: DispatcherHandoffPreviewRequest;
  readonly environmentId: EnvironmentId;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly environmentDefaultModelSelection: ModelSelection | null;
  readonly git: GitVcsDriver["Service"];
}) {
  const source = yield* readSource(input.request);
  const originalObjective = yield* readOriginalObjective(input.request.threadId);
  const gitFacts =
    source === null ? { branch: null, commit: null } : yield* readGitFacts(source, input.git);
  const references =
    source === null
      ? []
      : [
          ...(source.sourceMessageId === null
            ? []
            : [{ kind: "message" as const, value: source.sourceMessageId }]),
          ...(source.assistantMessageId === null
            ? []
            : [{ kind: "message" as const, value: source.assistantMessageId }]),
          ...source.checkpointFiles
            .map((file) => safeProjectRelativePath(file.path))
            .filter((path): path is string => path !== null)
            .slice(0, 30)
            .map((path) => ({ kind: "file" as const, value: path })),
        ].slice(0, 32);
  const packet = {
    originalObjective: bounded(originalObjective),
    latestUserInstruction: bounded(source?.sourceText),
    branch: bounded(gitFacts.branch),
    commit: bounded(gitFacts.commit),
    completedWork: UNKNOWN,
    remainingSteps: UNKNOWN,
    testResults: UNKNOWN,
    references,
  } satisfies typeof DispatcherHandoffPacket.Type;

  if (!input.enabled) {
    return {
      handoffId: input.handoffId,
      packet,
      packetText: packetText(packet),
      route: null,
      availability: unavailable("DISPATCHER_DISABLED", "Dispatcher handoff is disabled."),
    } satisfies DispatcherHandoffPreview;
  }

  const sourceBlock = sourceUnavailable(source);
  const existing = yield* hasExistingHandoff(input.request);
  const projected = yield* readDispatcherProjectedState({ threadId: input.request.threadId });
  const decision = resolveDispatcherRoute({
    environmentId: input.environmentId,
    request: {
      environmentId: input.request.environmentId,
      threadId: input.request.threadId,
      preferredRoute: input.request.target,
      actionKind: "workspace-write",
    },
    projected,
    message: null,
    providers: input.providers,
    environmentDefaultModelSelection: input.environmentDefaultModelSelection,
    candidateMode: "explicit-only",
  });
  const sourceRoute =
    source?.sourceMessageId === null || source?.sourceMessageId === undefined
      ? Option.none<DispatcherTaskRouteBinding>()
      : yield* readDispatcherTaskRoute({
          threadId: input.request.threadId,
          messageId: source.sourceMessageId,
        });
  const routeBlock = candidateUnavailable(decision);
  const availability =
    sourceBlock ??
    (existing.exists
      ? unavailable("HANDOFF_ALREADY_EXISTS", "This turn already has a handoff.")
      : Option.isNone(sourceRoute)
        ? unavailable("SOURCE_ROUTE_NOT_FOUND", "The source turn has no verified route binding.")
        : sourceRoute.value.target.instanceId === input.request.target.instanceId
          ? unavailable("TARGET_SAME_AS_SOURCE", "Choose a different provider instance.")
          : (routeBlock ?? { status: "ready" as const }));

  const text = packetText(packet);
  return {
    handoffId: input.handoffId,
    packet,
    packetText:
      text.length <= DISPATCHER_HANDOFF_MAX_PACKET_CHARS
        ? text
        : text.slice(0, DISPATCHER_HANDOFF_MAX_PACKET_CHARS),
    route: decision,
    availability,
  } satisfies DispatcherHandoffPreview;
});

export const bindTaskHandoffTurnStart = Effect.fn("DispatcherHandoff.bindTurnStart")(function* (
  command: OrchestrationCommand,
  dependencies: {
    readonly enabled: boolean;
    readonly environmentId: EnvironmentId;
    readonly providers: ReadonlyArray<ServerProvider>;
    readonly environmentDefaultModelSelection: ModelSelection | null;
  },
) {
  if (command.type !== "thread.turn.start" || command.handoffRequest === undefined) return command;
  if (!dependencies.enabled) {
    return yield* new OrchestrationDispatchCommandError({
      message: "Dispatcher handoff is disabled.",
    });
  }
  if (command.bootstrap !== undefined) {
    return yield* new OrchestrationDispatchCommandError({
      message: "A handoff cannot create a new thread.",
    });
  }
  const request = command.handoffRequest;
  const source = yield* readSource({
    threadId: command.threadId,
    sourceTurnId: request.sourceTurnId,
  });
  const sourceBlock = sourceUnavailable(source);
  if (sourceBlock?.status === "unavailable") {
    return yield* new OrchestrationDispatchCommandError({ message: sourceBlock.reason });
  }
  const existing = yield* hasExistingHandoff({
    threadId: command.threadId,
    sourceTurnId: request.sourceTurnId,
    handoffId: request.handoffId,
  });
  if (existing.exists) {
    return yield* new OrchestrationDispatchCommandError({
      message: existing.sameId
        ? "This handoff was already submitted."
        : "This turn already has a handoff.",
    });
  }
  const sourceMessageId = source?.sourceMessageId;
  if (sourceMessageId === null || sourceMessageId === undefined) {
    return yield* new OrchestrationDispatchCommandError({
      message: "The source turn has no verified route binding.",
    });
  }
  const sourceRoute = yield* readDispatcherTaskRoute({
    threadId: command.threadId,
    messageId: sourceMessageId,
  });
  if (Option.isNone(sourceRoute)) {
    return yield* new OrchestrationDispatchCommandError({
      message: "The source turn has no verified route binding.",
    });
  }
  if (sourceRoute.value.target.instanceId === request.target.instanceId) {
    return yield* new OrchestrationDispatchCommandError({
      message: "Choose a different provider instance.",
    });
  }
  const projected = yield* readDispatcherProjectedState({ threadId: command.threadId });
  const decision = resolveDispatcherRoute({
    environmentId: dependencies.environmentId,
    request: {
      environmentId: dependencies.environmentId,
      threadId: command.threadId,
      preferredRoute: request.target,
      actionKind: "workspace-write",
    },
    projected,
    message: null,
    providers: dependencies.providers,
    environmentDefaultModelSelection: dependencies.environmentDefaultModelSelection,
    candidateMode: "explicit-only",
  });
  const routeBinding = taskRouteBindingFromDecision(decision);
  if (routeBinding === null || candidateUnavailable(decision) !== null) {
    return yield* new OrchestrationDispatchCommandError({
      message: "The selected provider runner is unavailable on this environment.",
    });
  }
  const { handoffRequest: _, ...rest } = command;
  return {
    ...rest,
    message: { ...command.message, text: request.packetText },
    modelSelection: request.target,
    routeBinding,
    handoff: {
      handoffId: request.handoffId,
      sourceTurnId: request.sourceTurnId,
      target: request.target,
    },
  } satisfies OrchestrationCommand;
});

export const persistTaskHandoff = Effect.fn("DispatcherHandoff.persist")(function* (input: {
  readonly handoffId: TaskHandoffId;
  readonly threadId: ThreadId;
  readonly sourceTurnId: TurnId;
  readonly destinationMessageId: MessageId;
  readonly target: typeof DispatcherRouteTarget.Type;
  readonly createdAt: string;
}): Effect.fn.Return<void, ProjectionRepositoryError, SqlClient.SqlClient> {
  const sql = yield* SqlClient.SqlClient;
  const targetJson = yield* encodeTarget(input.target).pipe(
    Effect.mapError(toPersistenceDecodeError("DispatcherHandoff.persist:encodeTarget")),
  );
  yield* sql`
    INSERT OR IGNORE INTO projection_task_handoffs (
      handoff_id, thread_id, source_turn_id, destination_message_id,
      destination_turn_id, target_json, status, failure_reason,
      created_at, updated_at
    ) VALUES (
      ${input.handoffId}, ${input.threadId}, ${input.sourceTurnId}, ${input.destinationMessageId},
      NULL, ${targetJson}, 'creating', NULL,
      ${input.createdAt}, ${input.createdAt}
    )
  `.pipe(Effect.mapError(toPersistenceSqlError("DispatcherHandoff.persist:insert")));
});

export const markTaskHandoffContinued = Effect.fn("DispatcherHandoff.markContinued")(
  function* (input: {
    readonly threadId: ThreadId;
    readonly destinationMessageId: MessageId;
    readonly destinationTurnId: TurnId;
    readonly updatedAt: string;
  }): Effect.fn.Return<void, ProjectionRepositoryError, SqlClient.SqlClient> {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
    UPDATE projection_task_handoffs
    SET destination_turn_id = ${input.destinationTurnId}, status = 'continued',
        failure_reason = NULL, updated_at = ${input.updatedAt}
    WHERE thread_id = ${input.threadId}
      AND destination_message_id = ${input.destinationMessageId}
      AND status = 'creating'
  `.pipe(Effect.mapError(toPersistenceSqlError("DispatcherHandoff.markContinued:update")));
  },
);

export const markTaskHandoffFailed = Effect.fn("DispatcherHandoff.markFailed")(function* (input: {
  readonly threadId: ThreadId;
  readonly destinationMessageId: MessageId;
  readonly updatedAt: string;
}): Effect.fn.Return<void, ProjectionRepositoryError, SqlClient.SqlClient> {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE projection_task_handoffs
    SET status = 'failed', failure_reason = ${HANDOFF_FAILURE_REASON}, updated_at = ${input.updatedAt}
    WHERE thread_id = ${input.threadId}
      AND destination_message_id = ${input.destinationMessageId}
      AND status = 'creating'
  `.pipe(Effect.mapError(toPersistenceSqlError("DispatcherHandoff.markFailed:update")));
});

export const deleteTaskHandoffsByThread = Effect.fn("DispatcherHandoff.deleteByThread")(function* (
  threadId: ThreadId,
): Effect.fn.Return<void, ProjectionRepositoryError, SqlClient.SqlClient> {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM projection_task_handoffs WHERE thread_id = ${threadId}`.pipe(
    Effect.mapError(toPersistenceSqlError("DispatcherHandoff.deleteByThread:delete")),
  );
});

export const readLatestTaskHandoff = Effect.fn("DispatcherHandoff.readLatest")(function* (
  threadId: ThreadId,
): Effect.fn.Return<
  typeof DispatcherTaskHandoffSnapshot.Type | null,
  ProjectionRepositoryError,
  SqlClient.SqlClient
> {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`
    SELECT
      handoff_id AS "handoffId",
      source_turn_id AS "sourceTurnId",
      destination_message_id AS "destinationMessageId",
      destination_turn_id AS "destinationTurnId",
      target_json AS "target",
      status,
      failure_reason AS "failureReason",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM projection_task_handoffs
    WHERE thread_id = ${threadId}
    ORDER BY created_at DESC, handoff_id DESC
    LIMIT 1
  `.pipe(Effect.mapError(toPersistenceSqlError("DispatcherHandoff.readLatest:query")));
  const row = (yield* decodeHandoffRows(rows).pipe(
    Effect.mapError(toPersistenceDecodeError("DispatcherHandoff.readLatest:decodeRows")),
  ))[0];
  return row === undefined
    ? null
    : yield* decodeHandoffSnapshot(row).pipe(
        Effect.mapError(toPersistenceDecodeError("DispatcherHandoff.readLatest:decodeSnapshot")),
      );
});

export const readTaskHandoffByDestinationMessage = Effect.fn(
  "DispatcherHandoff.readByDestinationMessage",
)(function* (input: {
  readonly threadId: ThreadId;
  readonly destinationMessageId: MessageId;
}): Effect.fn.Return<
  typeof DispatcherTaskHandoffSnapshot.Type | null,
  ProjectionRepositoryError,
  SqlClient.SqlClient
> {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`
    SELECT
      handoff_id AS "handoffId",
      source_turn_id AS "sourceTurnId",
      destination_message_id AS "destinationMessageId",
      destination_turn_id AS "destinationTurnId",
      target_json AS "target",
      status,
      failure_reason AS "failureReason",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM projection_task_handoffs
    WHERE thread_id = ${input.threadId}
      AND destination_message_id = ${input.destinationMessageId}
    LIMIT 1
  `.pipe(Effect.mapError(toPersistenceSqlError("DispatcherHandoff.readByDestination:query")));
  const row = (yield* decodeHandoffRows(rows).pipe(
    Effect.mapError(toPersistenceDecodeError("DispatcherHandoff.readByDestination:decodeRows")),
  ))[0];
  return row === undefined
    ? null
    : yield* decodeHandoffSnapshot(row).pipe(
        Effect.mapError(
          toPersistenceDecodeError("DispatcherHandoff.readByDestination:decodeSnapshot"),
        ),
      );
});
