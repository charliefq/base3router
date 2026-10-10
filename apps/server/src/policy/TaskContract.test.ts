// Disposable SQLite files live under the OS temp directory.
// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentId,
  OrchestrationV2AppThread,
  ProviderDriverKind,
  ProviderInstanceId,
  TaskContractFields,
  type ServerProvider,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  SqlitePersistenceMemory,
  makeSqlitePersistenceLive,
} from "../persistence/Layers/Sqlite.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { authorizeDispatch, confirmProviderTermination, countOccupied } from "./Base3PolicyGate.ts";
import { PolicyExecutionContext } from "./executionContext.ts";
import {
  nextTaskContractThread,
  reserveGovernedStart,
  revokeTaskContractGrants,
  taskStateFromUnknown,
} from "./TaskContract.ts";

const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex-work"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-10T00:00:00.000Z",
  models: [{ slug: "gpt-5.4", name: "GPT", isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
};

const session = {
  kind: "session" as const,
  actorId: "user-1",
  sessionId: "session-1",
  scopes: [AuthOrchestrationOperateScope],
};

const readOnly = { ...session, scopes: [AuthOrchestrationReadScope] };

const providerLayer = Layer.mock(ProviderRegistry)({
  getProviders: Effect.succeed([provider]),
  refresh: () => Effect.succeed([provider]),
  refreshInstance: () => Effect.succeed([provider]),
  refreshWorkspaceSnapshot: () => Effect.succeed([provider]),
  getProviderMaintenanceCapabilitiesForInstance: () => Effect.die("unused"),
  setProviderMaintenanceActionState: () => Effect.succeed([provider]),
  streamChanges: Stream.empty,
});

const gateLayer = Layer.mergeAll(SqlitePersistenceMemory, providerLayer);

const fields = {
  goal: "Ship the slice",
  redirect: "Pause when the plan changes",
  acceptance: "The focused tests pass",
  brake: { maxProviderStarts: 2, stopConditions: "Stop after the start budget" },
};

const contract = { revision: 1, ...fields };

const payloadFor = (threadId: string, patch: Record<string, unknown> = {}) =>
  JSON.stringify({
    taskGovernance: "required",
    taskContract: contract,
    taskContractPhase: "active",
    taskAcceptedRevision: null,
    lineage: { rootThreadId: threadId },
    ...patch,
  });

const insertThread = (sql: SqlClient.SqlClient, threadId: string, payload: string) =>
  sql`
    INSERT INTO orchestration_v2_projection_threads (
      thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
      created_at, updated_at, payload_json
    ) VALUES (
      ${threadId}, 'project-1', 'Task', 'codex', 'full-access', 'default',
      '2026-10-10T00:00:00.000Z', '2026-10-10T00:00:00.000Z', ${payload}
    )
  `;

const dispatchMessage = (threadId: string, commandId: string, messageId: string) =>
  authorizeDispatch({
    type: "message.dispatch",
    commandId,
    threadId,
    messageId,
    text: "Ship the migration.",
    modelSelection: { instanceId: provider.instanceId, model: "gpt-5.4" },
    routingMode: "manual",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
  }).pipe(Effect.provideService(PolicyExecutionContext, session));

const countTable = (
  sql: SqlClient.SqlClient,
  table: "leases" | "grants" | "admissions" | "attempts",
) => {
  const query =
    table === "leases"
      ? sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM base3_capacity_leases`
      : table === "grants"
        ? sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM base3_execution_grants`
        : table === "admissions"
          ? sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM task_contract_admissions`
          : sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM base3_execution_attempts`;
  return query.pipe(Effect.map((rows) => Number(rows[0]?.count ?? 0)));
};

it("rejects a blank contract and does not invent defaults", () => {
  const decoded = Schema.decodeUnknownOption(TaskContractFields)({
    goal: "  ",
    redirect: "",
    acceptance: "done",
    brake: { maxProviderStarts: 0, stopConditions: " " },
  });
  expect(decoded._tag).toBe("None");
  const now = DateTime.makeUnsafe(Date.parse("2026-10-10T00:00:00.000Z"));
  const historical = Schema.decodeUnknownOption(OrchestrationV2AppThread)({
    createdBy: "user",
    creationSource: "web",
    id: "thread-legacy",
    projectId: "project-1",
    title: "Old chat",
    providerInstanceId: "codex-work",
    modelSelection: { instanceId: "codex-work", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "thread-legacy" },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
  });
  expect(historical._tag).toBe("Some");
  if (historical._tag === "Some") {
    expect(historical.value.taskGovernance).toBeUndefined();
  }
  expect(taskStateFromUnknown("thread-legacy", {}).governance).toBe("chat");
});

it.effect("an incomplete governed task starts zero providers", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* insertThread(sql, "thread-paused", payloadFor("thread-paused", { taskContract: null }));
    const denied = yield* Effect.flip(
      dispatchMessage("thread-paused", "paused-1", "message-paused"),
    );
    expect(denied.reason).toBe("task-contract");
    expect(denied.message).toContain("thread.task-contract.set");
    expect(yield* countTable(sql, "leases")).toBe(0);
    expect(yield* countTable(sql, "grants")).toBe(0);
    expect(yield* countTable(sql, "admissions")).toBe(0);
    expect(yield* countTable(sql, "attempts")).toBe(0);
  }).pipe(Effect.provide(gateLayer)),
);

it.effect("a complete contract admits one governed start", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* insertThread(sql, "thread-ready", payloadFor("thread-ready"));
    yield* dispatchMessage("thread-ready", "ready-1", "message-ready");
    expect(yield* countTable(sql, "admissions")).toBe(1);
    expect(yield* countTable(sql, "leases")).toBe(1);
    expect(yield* countTable(sql, "attempts")).toBe(1);
    const state = taskStateFromUnknown("thread-ready", JSON.parse(payloadFor("thread-ready")));
    yield* reserveGovernedStart({
      sql,
      state,
      commandType: "message.dispatch",
      commandId: "ready-1",
      threadId: "thread-ready",
    });
    expect(yield* countTable(sql, "admissions")).toBe(1);
  }).pipe(Effect.provide(gateLayer)),
);

it.effect("preserves the contract across a file-backed reopen", () =>
  Effect.gen(function* () {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "task-contract-"));
    const dbPath = NodePath.join(directory, "statev2.sqlite");
    const databaseLayer = makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer));
    const layer = Layer.mergeAll(databaseLayer, providerLayer);
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* insertThread(sql, "thread-file", payloadFor("thread-file"));
      yield* dispatchMessage("thread-file", "file-1", "message-file");
    }).pipe(Effect.provide(layer));
    const reopened = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly payload_json: string }>`
        SELECT payload_json FROM orchestration_v2_projection_threads
        WHERE thread_id = 'thread-file'
      `;
      return {
        payload: JSON.parse(rows[0]?.payload_json ?? "{}") as {
          taskContract?: { goal?: string; revision?: number };
        },
        admissions: yield* countTable(sql, "admissions"),
      };
    }).pipe(Effect.provide(layer));
    expect(reopened.payload.taskContract?.goal).toBe(fields.goal);
    expect(reopened.payload.taskContract?.revision).toBe(1);
    expect(reopened.admissions).toBe(1);
  }),
);

it.effect("child work cannot loosen or replace parent constraints", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* insertThread(sql, "thread-parent", payloadFor("thread-parent"));
    const state = taskStateFromUnknown("thread-parent", JSON.parse(payloadFor("thread-parent")));
    const widened = yield* Effect.flip(
      authorizeDispatch({
        type: "delegated_task.request",
        commandId: "child-widen",
        parentThreadId: "thread-parent",
        task: "Widen the brake",
        taskContract: {
          ...fields,
          brake: { maxProviderStarts: 9, stopConditions: fields.brake.stopConditions },
        },
      }).pipe(Effect.provideService(PolicyExecutionContext, session)),
    );
    expect(widened.reason).toBe("task-contract");
    expect(widened.message).toContain("cannot raise maxProviderStarts");
    const replaced = yield* Effect.flip(
      reserveGovernedStart({
        sql,
        state,
        commandType: "delegated_task.request",
        commandId: "child-tighter",
        threadId: "thread-parent",
        proposed: {
          ...fields,
          brake: { maxProviderStarts: 1, stopConditions: fields.brake.stopConditions },
        },
      }),
    );
    expect(replaced.message).toContain("cannot replace");
    const invented = yield* Effect.flip(
      reserveGovernedStart({
        sql,
        state: taskStateFromUnknown("thread-chat", {}),
        commandType: "delegated_task.request",
        commandId: "child-chat",
        threadId: "thread-chat",
        proposed: fields,
      }),
    );
    expect(invented.message).toContain("Ordinary chat cannot delegate");
    expect(yield* countTable(sql, "leases")).toBe(0);
    expect(yield* countTable(sql, "admissions")).toBe(0);
    yield* reserveGovernedStart({
      sql,
      state,
      commandType: "delegated_task.request",
      commandId: "child-inherit",
      threadId: "thread-parent",
    });
    expect(yield* countTable(sql, "admissions")).toBe(1);
  }).pipe(Effect.provide(gateLayer)),
);

it.effect("brake exhaustion blocks concurrent starts and keeps the lease until termination", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const limited = payloadFor("thread-brake", {
      taskContract: { ...contract, brake: { ...contract.brake, maxProviderStarts: 1 } },
    });
    yield* insertThread(sql, "thread-brake", limited);
    const raced = yield* Effect.all(
      [
        Effect.result(dispatchMessage("thread-brake", "brake-a", "message-a")),
        Effect.result(dispatchMessage("thread-brake", "brake-b", "message-b")),
      ],
      { concurrency: 2 },
    );
    const denied = raced.filter((result) => result._tag === "Failure");
    const admitted = raced.filter((result) => result._tag === "Success");
    expect(admitted).toHaveLength(1);
    expect(denied).toHaveLength(1);
    const failure = denied[0];
    if (failure?._tag === "Failure") {
      const reason = failure.failure;
      expect(reason).toMatchObject({ reason: "task-contract" });
      expect(String(reason)).toContain("Brake exhausted");
    }
    expect(yield* countTable(sql, "admissions")).toBe(1);
    const flags = yield* sql<{
      readonly interrupt_requested: number;
      readonly released_at: string | null;
    }>`
      SELECT interrupt_requested, released_at FROM base3_capacity_leases WHERE thread_id = 'thread-brake'
    `;
    expect(flags[0]?.interrupt_requested).toBe(1);
    expect(flags[0]?.released_at).toBeNull();
    expect(
      yield* countOccupied({
        sql,
        environmentId: EnvironmentId.make("local"),
        threadId: "thread-brake",
      }),
    ).toBe(1);
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs (
        run_id, thread_id, ordinal, provider, status, requested_at, payload_json
      ) VALUES (
        'run-brake', 'thread-brake', 1, 'codex', 'interrupted', '2026-10-10T00:00:00.000Z', '{}'
      )
    `;
    yield* sql`UPDATE base3_capacity_leases SET run_id = 'run-brake' WHERE thread_id = 'thread-brake'`;
    expect(
      yield* countOccupied({
        sql,
        environmentId: EnvironmentId.make("local"),
        threadId: "thread-brake",
      }),
    ).toBe(1);
    yield* confirmProviderTermination({ threadId: "thread-brake", runId: "run-brake" });
    expect(
      yield* countOccupied({
        sql,
        environmentId: EnvironmentId.make("local"),
        threadId: "thread-brake",
      }),
    ).toBe(0);
    const accepted = JSON.parse(limited) as { taskAcceptedRevision: number | null };
    const stored = yield* sql<{ readonly payload_json: string }>`
      SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id = 'thread-brake'
    `;
    const after = JSON.parse(stored[0]?.payload_json ?? "{}") as {
      taskAcceptedRevision: number | null;
    };
    expect(after.taskAcceptedRevision).toBe(accepted.taskAcceptedRevision);
  }).pipe(Effect.provide(gateLayer)),
);

it.effect(
  "acceptance is an authorized human decision and a revision change drops the old grant",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* insertThread(
        sql,
        "thread-decide",
        payloadFor("thread-decide", {
          taskContract: { ...contract, brake: { ...contract.brake, maxProviderStarts: 4 } },
        }),
      );
      const kernel = yield* Effect.flip(
        authorizeDispatch({
          type: "thread.task-contract.accept",
          commandId: "accept-kernel",
          threadId: "thread-decide",
        }).pipe(
          Effect.provideService(PolicyExecutionContext, {
            kind: "kernel-test",
            actorId: "kernel-test",
            scopes: ["orchestration:operate"],
          }),
        ),
      );
      expect(kernel.reason).toBe("unauthenticated");
      const reader = yield* Effect.flip(
        authorizeDispatch({
          type: "thread.task-contract.accept",
          commandId: "accept-read",
          threadId: "thread-decide",
        }).pipe(Effect.provideService(PolicyExecutionContext, readOnly)),
      );
      expect(reader.reason).toBe("missing-operate-scope");
      yield* authorizeDispatch({
        type: "message.dispatch",
        commandId: "decide-start",
        threadId: "thread-decide",
        messageId: "message-decide",
        text: "Continue where you left off.",
        modelSelection: { instanceId: provider.instanceId, model: "gpt-5.4" },
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        runId: "run-decide",
      }).pipe(Effect.provideService(PolicyExecutionContext, session));
      yield* sql`
      UPDATE orchestration_v2_projection_threads
      SET payload_json = ${payloadFor("thread-decide", {
        taskContract: {
          ...contract,
          revision: 2,
          brake: { ...contract.brake, maxProviderStarts: 4 },
        },
      })}
      WHERE thread_id = 'thread-decide'
    `;
      const mismatched = yield* Effect.flip(
        authorizeDispatch({
          type: "message.dispatch",
          commandId: "decide-continue",
          threadId: "thread-decide",
          messageId: "message-decide-next",
          text: "Continue where you left off.",
          modelSelection: { instanceId: provider.instanceId, model: "gpt-5.4" },
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          usageLimitContinuationOfRunId: "run-decide",
        }).pipe(Effect.provideService(PolicyExecutionContext, session)),
      );
      expect(mismatched.reason).toBe("argument-mismatch");
      yield* revokeTaskContractGrants(sql, "thread-decide");
      const revoked = yield* Effect.flip(
        authorizeDispatch({
          type: "message.dispatch",
          commandId: "decide-revoked",
          threadId: "thread-decide",
          messageId: "message-decide-next",
          text: "Continue where you left off.",
          modelSelection: { instanceId: provider.instanceId, model: "gpt-5.4" },
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          usageLimitContinuationOfRunId: "run-decide",
        }).pipe(Effect.provideService(PolicyExecutionContext, session)),
      );
      expect(revoked.reason).toBe("grant-revoked");
      const now = DateTime.makeUnsafe(Date.parse("2026-10-10T00:00:00.000Z"));
      const decodedThread = Schema.decodeUnknownOption(OrchestrationV2AppThread)({
        createdBy: "user",
        creationSource: "web",
        id: "thread-decide",
        projectId: "project-1",
        title: "Task",
        providerInstanceId: "codex-work",
        modelSelection: { instanceId: "codex-work", model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: "thread-decide",
        },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        deletedAt: null,
        taskGovernance: "required",
        taskContract: contract,
        taskContractPhase: "active",
        taskAcceptedRevision: null,
      });
      expect(decodedThread._tag).toBe("Some");
      if (decodedThread._tag === "None") return;
      const thread = decodedThread.value;
      const accepted = nextTaskContractThread({
        thread,
        actorId: "user-1",
        now: yield* DateTime.now,
        command: { type: "thread.task-contract.accept", revision: 1 },
      });
      expect("error" in accepted).toBe(false);
      if (!("error" in accepted)) {
        expect(accepted.thread.taskAcceptedRevision).toBe(1);
        expect(accepted.thread.taskDecisions?.at(-1)?.kind).toBe("accept");
      }
      const blocked = yield* Effect.flip(
        reserveGovernedStart({
          sql,
          state: {
            governance: "required",
            contract,
            phase: "active",
            acceptedRevision: 1,
            rootThreadId: "thread-decide",
          },
          commandType: "message.dispatch",
          commandId: "after-accept",
          threadId: "thread-decide",
        }),
      );
      expect(blocked.message).toContain("already accepted");
    }).pipe(Effect.provide(gateLayer)),
);
