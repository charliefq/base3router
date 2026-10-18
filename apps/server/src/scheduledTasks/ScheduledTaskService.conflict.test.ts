import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { ScheduledTaskUpsertInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Launch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Management from "../orchestration-v2/ThreadManagementService.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ActionGate from "../actionGate/ActionGateService.ts";
import { PolicyExecutionContext } from "../policy/executionContext.ts";
import * as Schedules from "./ScheduledTaskService.ts";

const dependencies = Layer.mergeAll(
  NodeCrypto.layer,
  Layer.succeed(Scheduler.Scheduler, { register: () => Effect.void }),
  Layer.mock(Launch.ThreadLaunchService)({}),
  Layer.mock(Management.ThreadManagementService)({}),
);
const layer = Schedules.layer.pipe(
  Layer.provide(dependencies),
  Layer.provideMerge(SqlitePersistenceMemory),
);
const decodeInput = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);
const input = Schema.decodeUnknownSync(ScheduledTaskUpsertInput)({
  id: "schedule:conflict",
  title: "Original",
  prompt: "Original prompt",
  enabled: true,
  schedule: { type: "interval", everyMs: 60_000 },
  projectId: "project:conflict",
  workspaceStrategy: { type: "root" },
  modelSelection: {
    instanceId: "codex",
    model: "fake",
    options: [{ id: "effort", value: "high" }],
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  creationSource: "web",
});

it.effect.each(["pause", "prompt", "options", "schedule"] as const)(
  "rejects a stale definition after %s without changing grants or another task",
  (change) =>
    Effect.gen(function* () {
      const service = yield* Schedules.ScheduledTaskService;
      const sql = yield* SqlClient.SqlClient;
      const opened = (yield* service.upsert(input)).task;
      const other = (yield* service.upsert(
        yield* decodeInput({
          ...input,
          id: "schedule:other",
        }),
      )).task;
      if (change === "pause") yield* service.setEnabled({ id: opened.id, enabled: false });
      else
        yield* service.upsert({
          ...input,
          ...(change === "prompt" ? { prompt: "New prompt" } : {}),
          ...(change === "options"
            ? {
                modelSelection: {
                  ...input.modelSelection,
                  options: [{ id: "effort", value: "low" }],
                },
              }
            : {}),
          ...(change === "schedule" ? { schedule: { type: "interval", everyMs: 120_000 } } : {}),
        });
      const before = (yield* service.list()).tasks;
      const grants = yield* sql`SELECT * FROM base3_execution_grants ORDER BY grant_id`;
      const failure = yield* service
        .upsert({
          ...input,
          requireExisting: true,
          expectedDefinitionToken: opened.definitionToken,
          title: "My retained draft",
          prompt: "Stale new prompt",
        })
        .pipe(Effect.flip);
      expect(failure.message).toContain("changed");
      expect(failure.message).toContain("reopen");
      expect((yield* service.list()).tasks).toEqual(before);
      expect(yield* sql`SELECT * FROM base3_execution_grants ORDER BY grant_id`).toEqual(grants);
      expect(before.find((task) => task.id === other.id)).toEqual(other);
    }).pipe(Effect.provide(layer)),
);

it.effect("guards the actual write after its read and rolls back grant replacement", () =>
  Effect.gen(function* () {
    const service = yield* Schedules.ScheduledTaskService;
    const sql = yield* SqlClient.SqlClient;
    const opened = (yield* service.upsert(input)).task;
    const grants = yield* sql`SELECT * FROM base3_execution_grants`;
    // Deterministically inject a definition change during authorization, after
    // upsert's read, on the real SQLite connection rather than mocking saveTask.
    yield* sql`CREATE TEMP TRIGGER change_before_save AFTER INSERT ON base3_execution_grants
      BEGIN UPDATE scheduled_tasks SET prompt = 'Changed after read' WHERE task_id = 'schedule:conflict'; END`;
    const result = yield* service
      .upsert({
        ...input,
        requireExisting: true,
        expectedDefinitionToken: opened.definitionToken,
        title: "Racing edit",
        prompt: "Racing grant",
      })
      .pipe(Effect.result);
    expect(result._tag).toBe("Failure");
    expect(yield* sql`SELECT * FROM base3_execution_grants`).toEqual(grants);
    expect((yield* service.list()).tasks[0]).toEqual(opened);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "ignores run-state writes and preserves current timing, options and occurrence on title save",
  () =>
    Effect.gen(function* () {
      const service = yield* Schedules.ScheduledTaskService;
      const sql = yield* SqlClient.SqlClient;
      const opened = (yield* service.upsert(input)).task;
      const next = "2030-01-01T00:00:00.000Z";
      const occurrence = {
        id: "occurrence:preserved",
        commandId: "command:preserved",
        messageId: "message:preserved",
        threadId: null,
        runId: null,
        status: "succeeded",
        lastEventSequence: 4,
        blockedReason: null,
      };
      // A scheduler transition lands after upsert reads the row, during grant creation.
      yield* sql`CREATE TEMP TRIGGER progress_before_save AFTER INSERT ON base3_execution_grants
      BEGIN UPDATE scheduled_tasks SET updated_at = '2027-01-01T00:00:00.000Z',
        next_run_at = '2030-01-01T00:00:00.000Z', run_count = 3, last_run_status = 'succeeded',
        last_occurrence_json = '{"id":"occurrence:preserved","commandId":"command:preserved","messageId":"message:preserved","threadId":null,"runId":null,"status":"succeeded","lastEventSequence":4,"blockedReason":null}'
        WHERE task_id = 'schedule:conflict'; END`;
      const updated = (yield* service.upsert({
        ...input,
        requireExisting: true,
        expectedDefinitionToken: opened.definitionToken,
        title: "Title only",
      })).task;
      expect(updated.title).toBe("Title only");
      expect(updated.nextRunAt).toBe(next);
      expect(updated.runCount).toBe(3);
      expect(updated.lastRunStatus).toBe("succeeded");
      expect(updated.modelSelection).toEqual(opened.modelSelection);
      expect(updated.lastOccurrence).toEqual(occurrence);
    }).pipe(Effect.provide(layer)),
);

it.effect("keeps a pending ASK after denial without creating a schedule or grant", () =>
  Effect.gen(function* () {
    const service = yield* Schedules.ScheduledTaskService;
    const sql = yield* SqlClient.SqlClient;
    const failure = yield* service
      .upsert({ ...input, createdBy: "agent", creationSource: "mcp" })
      .pipe(
        Effect.provideService(PolicyExecutionContext, {
          kind: "session",
          actorId: "user",
          sessionId: "session",
          scopes: ["orchestration:operate"],
        }),
        Effect.flip,
      );
    expect(failure.message).toBe("Schedule task was not authorized.");
    expect((yield* service.list()).tasks).toEqual([]);
    expect(yield* sql`SELECT * FROM base3_execution_grants`).toEqual([]);
    expect(
      yield* sql`SELECT approval_id FROM action_gate_approvals WHERE status = 'pending'`,
    ).toHaveLength(1);
  }).pipe(
    Effect.provide(
      Schedules.layer.pipe(
        Layer.provide(dependencies),
        Layer.provideMerge(ActionGate.layer),
        Layer.provideMerge(SqlitePersistenceMemory),
      ),
    ),
  ),
);

it.effect("round-trips definition tokens with escaped text and binds them to the task", () =>
  Effect.gen(function* () {
    const service = yield* Schedules.ScheduledTaskService;
    const special = { ...input, prompt: 'Review "quoted" \\ paths\nand 台😀' };
    const opened = (yield* service.upsert(special)).task;
    const other = (yield* service.upsert(yield* decodeInput({ ...input, id: "schedule:other" })))
      .task;
    const rejected = yield* service
      .upsert({
        ...special,
        expectedDefinitionToken: other.definitionToken,
        title: "Wrong task token",
      })
      .pipe(Effect.result);
    expect(rejected._tag).toBe("Failure");
    const updated = (yield* service.upsert({
      ...special,
      expectedDefinitionToken: opened.definitionToken,
      title: "Quoted title",
    })).task;
    expect(updated.prompt).toBe(opened.prompt);
    expect(updated.title).toBe("Quoted title");
    expect((yield* service.list()).tasks.find((task) => task.id === other.id)).toEqual(other);
  }).pipe(Effect.provide(layer)),
);
