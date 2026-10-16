import {
  CommandId,
  MessageId,
  ScheduledTask,
  ScheduledTaskError,
  ScheduledTaskId,
  ScheduledTaskOccurrence,
  ThreadId,
  type ScheduledTaskDeleteInput,
  type ScheduledTaskDeleteResult,
  type ScheduledTaskListResult,
  type ScheduledTaskMutationResult,
  type ScheduledTaskRunNowInput,
  type ScheduledTaskRunNowResult,
  type ScheduledTaskSetEnabledInput,
  type ScheduledTaskUpsertInput,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as CommandReceipts from "../orchestration-v2/CommandReceiptStore.ts";
import { authorizeScheduleUpsert } from "../policy/Base3PolicyGate.ts";
import { PolicyExecutionContext } from "../policy/executionContext.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { isMissedFixedTimeRun, isSameSchedule, nextScheduledRunAt } from "./Schedule.ts";

const occurrenceJson = Schema.fromJsonString(ScheduledTaskOccurrence);
const encodeOccurrence = Schema.encodeSync(occurrenceJson);
const decodeOccurrence = Schema.decodeUnknownEffect(occurrenceJson);

const decodeTask = Schema.decodeUnknownEffect(ScheduledTask);
const decodeTaskId = Schema.decodeUnknownOption(ScheduledTaskId);
const decodeScheduleJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ScheduledTask.fields.schedule),
);
const decodeWorkspaceStrategyJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ScheduledTask.fields.workspaceStrategy),
);
const decodeModelSelectionJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ScheduledTask.fields.modelSelection),
);

interface ScheduledTaskRow {
  readonly task_id: string;
  readonly title: string;
  readonly prompt: string;
  readonly enabled: number;
  readonly schedule_json: string;
  readonly project_id: string;
  readonly thread_id: string | null;
  readonly workspace_strategy_json: string;
  readonly model_selection_json: string;
  readonly runtime_mode: string;
  readonly interaction_mode: string;
  readonly created_by: string;
  readonly creation_source: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly next_run_at: string | null;
  readonly last_run_at: string | null;
  readonly last_run_status: string;
  readonly last_run_error: string | null;
  readonly run_count: number;
  readonly last_occurrence_json: string | null;
}

export class ScheduledTaskService extends Context.Service<
  ScheduledTaskService,
  {
    readonly list: () => Effect.Effect<ScheduledTaskListResult, ScheduledTaskError>;
    /** Emits the full task list on subscribe and again after every change (CRUD, run transitions, reschedules). */
    readonly subscribeList: () => Stream.Stream<ScheduledTaskListResult, ScheduledTaskError>;
    readonly upsert: (
      input: ScheduledTaskUpsertInput,
    ) => Effect.Effect<ScheduledTaskMutationResult, ScheduledTaskError>;
    /** Partial update flipping only the enabled flag; never touches other fields. */
    readonly setEnabled: (
      input: ScheduledTaskSetEnabledInput,
    ) => Effect.Effect<ScheduledTaskMutationResult, ScheduledTaskError>;
    readonly delete: (
      input: ScheduledTaskDeleteInput,
    ) => Effect.Effect<ScheduledTaskDeleteResult, ScheduledTaskError>;
    readonly runNow: (
      input: ScheduledTaskRunNowInput,
    ) => Effect.Effect<ScheduledTaskRunNowResult, ScheduledTaskError>;
  }
>()("t3/scheduledTasks/ScheduledTaskService") {}

function taskError(message: string, input?: { taskId?: ScheduledTaskId; cause?: unknown }) {
  return new ScheduledTaskError({
    message,
    ...(input?.taskId === undefined ? {} : { taskId: input.taskId }),
    ...(input?.cause === undefined ? {} : { cause: input.cause }),
  });
}

function iso(value: DateTime.DateTime): string {
  return DateTime.formatIso(DateTime.toUtc(value));
}

const localNow = DateTime.withCurrentZoneLocal(DateTime.nowInCurrentZone);

function nextRunAt(
  task: Pick<ScheduledTask, "enabled" | "schedule">,
  from: DateTime.DateTime,
): string | null {
  if (!task.enabled) return null;
  // A stored interval can decode yet overflow the representable DateTime
  // range; an unrepresentable occurrence means the task has no next run.
  try {
    const next = nextScheduledRunAt(task.schedule, from);
    return next !== null && Number.isFinite(DateTime.toEpochMillis(next)) ? iso(next) : null;
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  if (Cause.isCause(error)) return Cause.pretty(error);
  if (error instanceof Error) return error.message;
  return String(error);
}

const decodeRow = (row: ScheduledTaskRow) =>
  Effect.gen(function* () {
    const schedule = yield* decodeScheduleJson(row.schedule_json);
    const workspaceStrategy = yield* decodeWorkspaceStrategyJson(row.workspace_strategy_json);
    const modelSelection = yield* decodeModelSelectionJson(row.model_selection_json);
    return yield* decodeTask({
      // The stored id decodes through the task schema so a corrupt value fails
      // as a typed parse error, not a `ScheduledTaskId.make` defect.
      id: row.task_id,
      title: row.title,
      prompt: row.prompt,
      enabled: row.enabled === 1,
      schedule,
      projectId: row.project_id,
      threadId: row.thread_id,
      workspaceStrategy,
      modelSelection,
      runtimeMode: row.runtime_mode,
      interactionMode: row.interaction_mode,
      createdBy: row.created_by,
      creationSource: row.creation_source,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      nextRunAt: row.next_run_at,
      lastRunAt: row.last_run_at,
      lastRunStatus: row.last_run_status,
      lastRunError: row.last_run_error,
      runCount: row.run_count,
      lastOccurrence:
        row.last_occurrence_json == null ? null : yield* decodeOccurrence(row.last_occurrence_json),
    });
  }).pipe(
    Effect.mapError((cause) => {
      // The typed diagnostic can only carry an id that itself decodes; a
      // corrupt stored id is omitted rather than re-thrown as a defect.
      const taskId = decodeTaskId(row.task_id);
      return taskError("Could not decode schedule task row.", {
        ...(Option.isSome(taskId) ? { taskId: taskId.value } : {}),
        cause,
      });
    }),
  );

/** Select poll candidates before decoding their schedules or other JSON payloads. */
export const listDueTasks = Effect.fn("ScheduledTaskService.listDueTasks")(function* (
  now: DateTime.DateTime,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<ScheduledTaskRow>`
    SELECT * FROM scheduled_tasks
    WHERE enabled = 1 AND next_run_at IS NOT NULL
      AND next_run_at <= ${iso(now)} AND last_run_status <> 'running'
    ORDER BY next_run_at ASC, task_id ASC
  `;
  const tasks: ScheduledTask[] = [];
  for (const row of rows) {
    const decoded = yield* Effect.result(decodeRow(row));
    if (Result.isSuccess(decoded)) {
      const task = decoded.success;
      // next_run_at is a freeform string at the schema level; a stored value
      // that cannot parse as a DateTime would defect the poll below, so the
      // row is skipped here like any other corrupt row.
      if (task.nextRunAt === null || Option.isSome(DateTime.make(task.nextRunAt))) {
        tasks.push(task);
      } else {
        yield* Effect.logWarning("Skipping schedule task row with invalid next_run_at", {
          taskId: row.task_id,
        });
      }
    } else {
      yield* Effect.logWarning("Skipping undecodable schedule task row", {
        taskId: row.task_id,
        cause: decoded.failure,
      });
    }
  }
  return tasks;
});

export const layer = Layer.effect(
  ScheduledTaskService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const crypto = yield* Crypto.Crypto;
    const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
    const threadManagement = yield* ThreadManagementService.ThreadManagementService;
    const scheduler = yield* Scheduler.Scheduler;
    const events = yield* EventStore.EventStoreV2;
    const receipts = yield* CommandReceipts.CommandReceiptStoreV2;
    const activeRuns = yield* Ref.make<ReadonlySet<ScheduledTaskId>>(new Set());
    // Sliding(1) coalesces the dirty-signal: every notification triggers a
    // full list() re-emit anyway, so a slow subscriber only ever needs the
    // latest signal — an unbounded backlog would just grow memory.
    const changesPubSub = yield* PubSub.sliding<void>(1);
    const notifyChanged = PubSub.publish(changesPubSub, undefined).pipe(Effect.asVoid);

    const selectAllRows = () => sql<ScheduledTaskRow>`
      SELECT
        task_id,
        title,
        prompt,
        enabled,
        schedule_json,
        project_id,
        thread_id,
        workspace_strategy_json,
        model_selection_json,
        runtime_mode,
        interaction_mode,
        created_by,
        creation_source,
        created_at,
        updated_at,
        next_run_at,
        last_run_at,
        last_run_status,
        last_run_error,
        run_count,
        last_occurrence_json
      FROM scheduled_tasks
      ORDER BY updated_at DESC, task_id ASC
    `;

    // Strict decode for the API surface: a corrupt row is a visible error.
    const listRows = Effect.fn("ScheduledTaskService.listRows")(function* () {
      const rows = yield* selectAllRows();
      return yield* Effect.forEach(rows, decodeRow, { concurrency: 1 });
    });

    const getRows = (id: ScheduledTaskId) => sql<ScheduledTaskRow>`
      SELECT
        task_id,
        title,
        prompt,
        enabled,
        schedule_json,
        project_id,
        thread_id,
        workspace_strategy_json,
        model_selection_json,
        runtime_mode,
        interaction_mode,
        created_by,
        creation_source,
        created_at,
        updated_at,
        next_run_at,
        last_run_at,
        last_run_status,
        last_run_error,
        run_count,
        last_occurrence_json
      FROM scheduled_tasks
      WHERE task_id = ${id}
    `;

    /** Load a task, returning `null` when it does not exist; real load/decode failures propagate. */
    const findTask = Effect.fn("ScheduledTaskService.findTask")(function* (id: ScheduledTaskId) {
      const rows = yield* getRows(id).pipe(
        Effect.mapError((cause) =>
          taskError("Could not load schedule task.", { taskId: id, cause }),
        ),
      );
      const row = rows[0];
      if (row === undefined) return null;
      return yield* decodeRow(row);
    });

    const loadTask = Effect.fn("ScheduledTaskService.loadTask")(function* (id: ScheduledTaskId) {
      const task = yield* findTask(id);
      if (task === null) {
        return yield* taskError("Schedule task not found.", { taskId: id });
      }
      return task;
    });

    // Run-state columns (last_run_*, run_count) are intentionally absent from
    // the conflict clause: they are owned by the run transitions below, and a
    // concurrent settings save must not overwrite an in-flight increment.
    // Check existence in the write itself so an edit cannot undo a deletion
    // that landed after upsert loaded the previous task.
    const saveTask = (task: ScheduledTask, requireExisting: boolean) =>
      sql<{ task_id: string }>`
        INSERT INTO scheduled_tasks (
          task_id,
          title,
          prompt,
          enabled,
          schedule_json,
          project_id,
          thread_id,
          workspace_strategy_json,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          created_by,
          creation_source,
          created_at,
          updated_at,
          next_run_at,
          last_run_at,
          last_run_status,
          last_run_error,
          run_count
        )
        SELECT
          ${task.id},
          ${task.title},
          ${task.prompt},
          ${task.enabled ? 1 : 0},
          ${JSON.stringify(task.schedule)},
          ${task.projectId},
          ${task.threadId},
          ${JSON.stringify(task.workspaceStrategy)},
          ${JSON.stringify(task.modelSelection)},
          ${task.runtimeMode},
          ${task.interactionMode},
          ${task.createdBy},
          ${task.creationSource},
          ${task.createdAt},
          ${task.updatedAt},
          ${task.nextRunAt},
          ${task.lastRunAt},
          ${task.lastRunStatus},
          ${task.lastRunError},
          ${task.runCount}
        WHERE ${requireExisting ? 0 : 1} = 1
           OR EXISTS (SELECT 1 FROM scheduled_tasks WHERE task_id = ${task.id})
        ON CONFLICT (task_id)
        DO UPDATE SET
          title = excluded.title,
          prompt = excluded.prompt,
          enabled = excluded.enabled,
          schedule_json = excluded.schedule_json,
          project_id = excluded.project_id,
          thread_id = excluded.thread_id,
          workspace_strategy_json = excluded.workspace_strategy_json,
          model_selection_json = excluded.model_selection_json,
          runtime_mode = excluded.runtime_mode,
          interaction_mode = excluded.interaction_mode,
          creation_source = excluded.creation_source,
          updated_at = excluded.updated_at,
          next_run_at = excluded.next_run_at
        RETURNING task_id
      `.pipe(
        Effect.mapError((cause) =>
          taskError("Could not save schedule task.", { taskId: task.id, cause }),
        ),
        Effect.flatMap((rows) =>
          rows.length > 0
            ? Effect.void
            : taskError("Schedule task not found.", { taskId: task.id }),
        ),
      );

    const deleteRow = (id: ScheduledTaskId) =>
      sql`DELETE FROM scheduled_tasks WHERE task_id = ${id}`.pipe(
        Effect.mapError((cause) =>
          taskError("Could not delete schedule task.", { taskId: id, cause }),
        ),
      );

    // Legacy status values remain compatible: unknown is nonterminal running,
    // cancellation is failed with a reason. lastOccurrence carries the precise
    // lifecycle state; runCount counts admitted occurrences, not successes.
    // Run-state transitions use targeted UPDATEs (never the full-row upsert) so
    // a completing run cannot resurrect a deleted task or clobber concurrent
    // edits to the task definition.
    const saveOccurrence = (task: ScheduledTask, occurrence: ScheduledTaskOccurrence) =>
      sql`
        UPDATE scheduled_tasks
        SET last_occurrence_json = ${encodeOccurrence(occurrence)},
            last_run_status = ${occurrence.status === "succeeded" ? "succeeded" : occurrence.status === "failed" || occurrence.status === "cancelled" ? "failed" : "running"},
            last_run_error = ${occurrence.blockedReason}
        WHERE task_id = ${task.id}
          AND json_extract(last_occurrence_json, '$.id') = ${occurrence.id}
          AND json_extract(last_occurrence_json, '$.status') NOT IN ('succeeded', 'failed', 'cancelled')
          AND json_extract(last_occurrence_json, '$.lastEventSequence') <= ${occurrence.lastEventSequence}
          AND last_occurrence_json <> ${encodeOccurrence(occurrence)}
        RETURNING task_id
      `.pipe(Effect.flatMap((rows) => (rows.length > 0 ? notifyChanged : Effect.void)));

    // Read durable run events, including events committed before dispatch returned.
    // Command receipts acknowledge admission only; the existing outbox owns provider execution.
    const reconcileOccurrence = Effect.fn("ScheduledTaskService.reconcileOccurrence")(function* (
      task: ScheduledTask,
    ) {
      let occurrence = task.lastOccurrence;
      if (occurrence == null || ["succeeded", "failed", "cancelled"].includes(occurrence.status))
        return;
      const messageCommandId = occurrence.commandId;
      const messageId = occurrence.messageId;
      const receipt = yield* receipts.getByCommandId(messageCommandId);
      const admitted = yield* events
        .readByCommandId({ commandId: messageCommandId })
        .pipe(Stream.runCollect);
      const admittedRun = admitted.findLast(
        (stored) =>
          (stored.event.type === "run.created" || stored.event.type === "run.updated") &&
          stored.event.payload.userMessageId === messageId,
      );
      if (
        admittedRun !== undefined &&
        (admittedRun.event.type === "run.created" || admittedRun.event.type === "run.updated")
      ) {
        occurrence = {
          ...occurrence,
          threadId: admittedRun.event.threadId,
          runId: admittedRun.event.payload.id,
        };
      }
      if (occurrence.threadId !== null && occurrence.runId !== null) {
        const updates = yield* events
          .read({
            threadId: occurrence.threadId,
            afterSequence: occurrence.lastEventSequence,
            eventType: "run.updated",
          })
          .pipe(Stream.runCollect);
        for (const stored of [...admitted, ...updates].sort(
          (left, right) => left.sequence - right.sequence,
        )) {
          if (
            stored.sequence <= occurrence.lastEventSequence ||
            (stored.event.type !== "run.created" && stored.event.type !== "run.updated") ||
            stored.event.payload.id !== occurrence.runId
          )
            continue;
          const run = stored.event.payload;
          const recovery = stored.commandId?.startsWith("command:runtime-reconcile:") === true;
          const status: ScheduledTaskOccurrence["status"] = recovery
            ? "unknown"
            : run.status === "completed"
              ? "succeeded"
              : run.status === "failed"
                ? "failed"
                : ["cancelled", "interrupted", "rolled_back"].includes(run.status)
                  ? "cancelled"
                  : occurrence.status === "unknown"
                    ? "unknown"
                    : "running";
          occurrence = {
            ...occurrence,
            status,
            lastEventSequence: stored.sequence,
            blockedReason:
              status === "unknown"
                ? "UNKNOWN: provider work lost during server recovery."
                : status === "cancelled"
                  ? "Run cancelled or interrupted."
                  : status === "failed"
                    ? "Run failed."
                    : null,
          };
          if (["succeeded", "failed", "cancelled"].includes(status)) break;
        }
      } else if (Option.isSome(receipt) && receipt.value.status === "rejected") {
        occurrence = {
          ...occurrence,
          status: "failed",
          blockedReason: receipt.value.error ?? "Dispatch rejected.",
        };
      }
      yield* saveOccurrence(task, occurrence);
    });

    const reconcileOccurrences = Effect.fn("ScheduledTaskService.reconcileOccurrences")(
      function* () {
        const rows =
          yield* sql<ScheduledTaskRow>`SELECT * FROM scheduled_tasks WHERE last_run_status = 'running' AND last_occurrence_json IS NOT NULL`;
        for (const row of rows) {
          const task = yield* Effect.result(decodeRow(row));
          if (Result.isSuccess(task)) yield* reconcileOccurrence(task.success);
        }
      },
    );

    const runTask = Effect.fn("ScheduledTaskService.runTask")(function* (
      task: ScheduledTask,
      trigger: "scheduled" | "manual",
    ) {
      const reserved = yield* Ref.modify(activeRuns, (active) => {
        if (active.has(task.id)) return [false, active] as const;
        const next = new Set(active);
        next.add(task.id);
        return [true, next] as const;
      });
      if (!reserved) {
        if (trigger === "manual") {
          return yield* taskError("Schedule task is already running.", { taskId: task.id });
        }
        return task;
      }

      return yield* Effect.gen(function* () {
        const startedAt = yield* localNow;
        const startedAtIso = iso(startedAt);

        // The in-memory snapshot may be stale: re-read before touching run
        // state. The task may have been deleted, paused, or postponed since
        // the poll loaded it — none of those may fire.
        const active = yield* findTask(task.id);
        if (active === null) {
          // A manual run on a just-deleted task must fail loudly, not report
          // a successful run that never dispatched.
          if (trigger === "manual") {
            return yield* taskError("Schedule task not found.", { taskId: task.id });
          }
          return task;
        }
        // A next_run_at corrupted between the poll read and this re-read must
        // not defect the poll; an unparseable value is treated as not due.
        const parsedNextRunAt =
          active.nextRunAt === null ? Option.none() : DateTime.make(active.nextRunAt);
        if (
          trigger === "scheduled" &&
          (!active.enabled ||
            Option.isNone(parsedNextRunAt) ||
            DateTime.toEpochMillis(parsedNextRunAt.value) > DateTime.toEpochMillis(startedAt))
        ) {
          return active;
        }

        if (active.lastRunStatus === "running" && active.lastOccurrence?.status !== "unknown") {
          return yield* taskError("Schedule task is already running.", { taskId: task.id });
        }
        const occurrenceId = yield* crypto.randomUUIDv4;
        const fireKey = `${active.id}:${occurrenceId}`;
        const commandId = CommandId.make(`scheduled-task:${fireKey}`);
        const messageId = MessageId.make(`scheduled-task-message:${fireKey}`);
        const occurrence: ScheduledTaskOccurrence = {
          id: occurrenceId,
          commandId:
            active.threadId === null ? CommandId.make(`${commandId}:initial-message`) : commandId,
          messageId,
          threadId: active.threadId,
          runId: null,
          status: "dispatching",
          lastEventSequence: 0,
          blockedReason: null,
        };
        // Persist identity before any external effect. A restart reconciles this
        // exact message and never sends it again with a fresh command id.
        const claimed = yield* sql<{ task_id: string }>`
          UPDATE scheduled_tasks SET last_occurrence_json = ${encodeOccurrence(occurrence)},
            last_run_at = ${startedAtIso}, last_run_status = 'running', last_run_error = NULL,
            updated_at = ${startedAtIso}, next_run_at = ${nextRunAt(active, startedAt)}, run_count = run_count + 1
          WHERE task_id = ${active.id} AND (${trigger} = 'manual' OR (enabled = 1 AND next_run_at IS ${active.nextRunAt}))
            AND last_occurrence_json IS ${active.lastOccurrence == null ? null : encodeOccurrence(active.lastOccurrence)}
          RETURNING task_id
        `;
        if (claimed.length === 0)
          return yield* taskError("Schedule occurrence changed before dispatch.", {
            taskId: active.id,
          });
        yield* notifyChanged;
        // Dispatch from the fresh row so prompt/model/binding edits made
        // after the poll read are honoured.
        const prompt = active.prompt;

        // Effect.exit (not Effect.result) so defects and interruptions in the
        // dispatch are also captured and recorded as a failed run instead of
        // aborting before markCompleted.
        const result =
          active.threadId === null
            ? yield* Effect.exit(
                threadLaunch
                  .launch({
                    commandId,
                    projectId: active.projectId,
                    title: active.title,
                    modelSelection: active.modelSelection,
                    runtimeMode: active.runtimeMode,
                    interactionMode: active.interactionMode,
                    workspaceStrategy: active.workspaceStrategy,
                    initialMessage: {
                      messageId,
                      scheduledTaskId: active.id,
                      text: prompt,
                      attachments: [],
                    },
                    createdBy: active.createdBy,
                    creationSource: active.creationSource,
                  })
                  .pipe(
                    Effect.provideService(PolicyExecutionContext, { kind: "server-continuation" }),
                  ),
              )
            : yield* Effect.exit(
                threadManagement
                  .sendToThread({
                    projectId: active.projectId,
                    commandId,
                    threadId: ThreadId.make(active.threadId),
                    messageId,
                    scheduledTaskId: active.id,
                    text: prompt,
                    attachments: [],
                    modelSelection: active.modelSelection,
                    mode: "auto",
                    createdBy: active.createdBy,
                    creationSource: active.creationSource,
                  })
                  .pipe(
                    Effect.provideService(PolicyExecutionContext, { kind: "server-continuation" }),
                  ),
              );

        const outcome: ScheduledTaskOccurrence = {
          ...occurrence,
          status: result._tag === "Success" ? "accepted" : "unknown",
          blockedReason:
            result._tag === "Success"
              ? null
              : `UNKNOWN dispatch outcome: ${errorMessage(result.cause)}`,
        };
        yield* saveOccurrence(active, outcome);
        yield* reconcileOccurrence({ ...active, lastOccurrence: outcome });
        yield* notifyChanged;
        return yield* loadTask(active.id);
      }).pipe(
        Effect.mapError((cause) =>
          taskError("Could not dispatch schedule occurrence.", { taskId: task.id, cause }),
        ),
        Effect.ensuring(
          Ref.update(activeRuns, (active) => {
            const next = new Set(active);
            next.delete(task.id);
            return next;
          }),
        ),
      );
    });

    // A due fixed-time run that is long past its slot (server was off or
    // asleep) is skipped and re-aimed at its next occurrence, not fired late.
    const rescheduleMissedRun = Effect.fn("ScheduledTaskService.rescheduleMissedRun")(function* (
      task: ScheduledTask,
      now: DateTime.DateTime,
    ) {
      const next = nextRunAt(task, now);
      yield* Effect.logInfo("Skipping missed schedule task run", {
        taskId: task.id,
        missedRunAt: task.nextRunAt,
        rescheduledTo: next,
      });
      yield* sql`
        UPDATE scheduled_tasks
        SET next_run_at = ${next},
            updated_at = ${iso(now)}
        WHERE task_id = ${task.id}
      `.pipe(
        Effect.mapError((cause) =>
          taskError("Could not reschedule missed schedule task run.", { taskId: task.id, cause }),
        ),
      );
      yield* notifyChanged;
    });

    const runDueTasks = Effect.fn("ScheduledTaskService.runDueTasks")(function* () {
      const now = yield* localNow;
      const tasks = yield* listDueTasks(now).pipe(
        Effect.mapError((cause) => taskError("Could not list schedule tasks.", { cause })),
      );
      const due = tasks.flatMap((task) =>
        task.nextRunAt === null ? [] : [{ task, dueAt: DateTime.makeUnsafe(task.nextRunAt) }],
      );
      yield* Effect.forEach(
        due,
        ({ task, dueAt }) =>
          (isMissedFixedTimeRun(task.schedule, dueAt, now)
            ? rescheduleMissedRun(task, now)
            : runTask(task, "scheduled")
          ).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Scheduled task run failed", { taskId: task.id, cause }),
            ),
          ),
        { concurrency: 1, discard: true },
      );
    });

    // Loss of a process is not proof of failure or success. Keep uncertain
    // legacy and current occurrences blocked; reconciliation never redispatches.
    yield* sql`
      UPDATE scheduled_tasks SET last_run_error = 'UNKNOWN: server restarted before an outcome was observed.',
        last_occurrence_json = CASE WHEN last_occurrence_json IS NULL THEN NULL
          WHEN json_valid(last_occurrence_json) = 0 THEN last_occurrence_json
          ELSE json_set(last_occurrence_json, '$.status', 'unknown', '$.blockedReason', 'UNKNOWN: server restarted before an outcome was observed.') END
      WHERE last_run_status = 'running'
    `;
    yield* reconcileOccurrences().pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not reconcile schedule outcomes", { cause }),
      ),
    );

    yield* scheduler.register(
      "scheduled-tasks",
      reconcileOccurrences().pipe(Effect.andThen(runDueTasks())),
    );

    const list: ScheduledTaskService["Service"]["list"] = () =>
      reconcileOccurrences().pipe(
        Effect.andThen(listRows()),
        Effect.map((tasks) => ({ tasks })),
        Effect.mapError((cause) => taskError("Could not list schedule tasks.", { cause })),
      );

    const subscribeList: ScheduledTaskService["Service"]["subscribeList"] = () =>
      Stream.unwrap(
        Effect.gen(function* () {
          // Subscribe before taking the snapshot so a change landing between
          // the two is buffered by the subscription rather than dropped.
          const subscription = yield* PubSub.subscribe(changesPubSub);
          return Stream.concat(
            Stream.fromEffect(list()),
            Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => list())),
          );
        }),
      );

    const upsert: ScheduledTaskService["Service"]["upsert"] = (input) =>
      Effect.gen(function* () {
        const now = yield* localNow;
        const uuid =
          input.commandId === undefined
            ? yield* crypto.randomUUIDv4.pipe(
                Effect.mapError((cause) =>
                  taskError("Could not generate schedule task id.", { cause }),
                ),
              )
            : null;
        const id =
          input.id ??
          ScheduledTaskId.make(
            input.commandId ? `scheduled-task:${input.commandId}` : `scheduled-task:${uuid}`,
          );
        // Look up by the *resolved* id so idempotent creates (commandId replays)
        // keep their run history, and so real load failures propagate instead
        // of silently resetting an existing row.
        const existingTask = yield* findTask(id);
        // Keep the existing next_run_at when the schedule itself is untouched:
        // editing a title or prompt must not postpone (or resurrect) a due
        // run — only schedule/enabled changes restart the clock.
        const scheduleUnchanged =
          existingTask !== null &&
          existingTask.enabled === input.enabled &&
          isSameSchedule(existingTask.schedule, input.schedule);
        const task: ScheduledTask = {
          id,
          title: input.title,
          prompt: input.prompt,
          enabled: input.enabled,
          schedule: input.schedule,
          projectId: input.projectId,
          threadId: input.threadId ?? null,
          workspaceStrategy: input.workspaceStrategy,
          modelSelection: input.modelSelection,
          runtimeMode: input.runtimeMode,
          interactionMode: input.interactionMode,
          createdBy: existingTask?.createdBy ?? input.createdBy ?? "user",
          creationSource: input.creationSource ?? "web",
          createdAt: existingTask?.createdAt ?? iso(now),
          updatedAt: iso(now),
          nextRunAt: scheduleUnchanged
            ? existingTask.nextRunAt
            : nextRunAt({ enabled: input.enabled, schedule: input.schedule }, now),
          lastRunAt: existingTask?.lastRunAt ?? null,
          lastOccurrence: existingTask?.lastOccurrence ?? null,
          lastRunStatus: existingTask?.lastRunStatus ?? "never",
          lastRunError: existingTask?.lastRunError ?? null,
          runCount: existingTask?.runCount ?? 0,
        };
        yield* authorizeScheduleUpsert({
          taskId: id,
          threadId: task.threadId,
          prompt: task.prompt,
          model: task.modelSelection?.model ?? null,
          instanceId: task.modelSelection?.instanceId ?? null,
          createdBy: task.createdBy,
          creationSource: task.creationSource,
        }).pipe(
          Effect.mapError((cause) =>
            taskError("Schedule task was not authorized.", { taskId: id, cause }),
          ),
        );
        yield* saveTask(task, input.requireExisting === true);
        yield* notifyChanged;
        return { task };
      });

    const setEnabled: ScheduledTaskService["Service"]["setEnabled"] = (input) =>
      Effect.gen(function* () {
        const existing = yield* loadTask(input.id);
        if (existing.enabled === input.enabled) return { task: existing };
        const now = yield* localNow;
        const next = nextRunAt({ enabled: input.enabled, schedule: existing.schedule }, now);
        // RETURNING so a task deleted between the load and this UPDATE is a
        // visible not-found error, not a false success.
        const updated = yield* sql<{ task_id: string }>`
          UPDATE scheduled_tasks
          SET enabled = ${input.enabled ? 1 : 0},
              next_run_at = ${next},
              updated_at = ${iso(now)}
          WHERE task_id = ${input.id}
          RETURNING task_id
        `.pipe(
          Effect.mapError((cause) =>
            taskError("Could not update schedule task.", { taskId: input.id, cause }),
          ),
        );
        if (updated.length === 0) {
          return yield* taskError("Schedule task not found.", { taskId: input.id });
        }
        yield* notifyChanged;
        return {
          task: { ...existing, enabled: input.enabled, nextRunAt: next, updatedAt: iso(now) },
        };
      });

    const deleteTask: ScheduledTaskService["Service"]["delete"] = (input) =>
      deleteRow(input.id).pipe(Effect.andThen(notifyChanged), Effect.as({ id: input.id }));

    const runNow: ScheduledTaskService["Service"]["runNow"] = (input: ScheduledTaskRunNowInput) =>
      Effect.gen(function* () {
        const snapshot = yield* loadTask(input.id);
        yield* reconcileOccurrence(snapshot).pipe(
          Effect.mapError((cause) =>
            taskError("Could not reconcile schedule task.", { taskId: input.id, cause }),
          ),
        );
        const task = yield* loadTask(input.id);
        const next = yield* runTask(task, "manual").pipe(
          Effect.mapError((cause) =>
            taskError("Could not run schedule task.", { taskId: input.id, cause }),
          ),
        );
        return { task: next };
      });

    return ScheduledTaskService.of({
      list,
      subscribeList,
      upsert,
      setEnabled,
      delete: deleteTask,
      runNow,
    });
  }),
).pipe(Layer.provide(Layer.mergeAll(EventStore.layer, CommandReceipts.layer)));
