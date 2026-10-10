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
  CommandId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  TaskContractFields,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  SqlitePersistenceMemory,
  makeSqlitePersistenceLive,
} from "../persistence/Layers/Sqlite.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import * as CheckpointRollbackService from "../orchestration-v2/CheckpointRollbackService.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ProviderTurnControlService from "../orchestration-v2/ProviderTurnControlService.ts";
import * as ProviderTurnStartService from "../orchestration-v2/ProviderTurnStartService.ts";
import * as RunFinalizationService from "../orchestration-v2/RunFinalizationService.ts";
import * as RuntimeRequestService from "../orchestration-v2/RuntimeRequestService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadTitleRegenerationService from "../orchestration-v2/ThreadTitleRegenerationService.ts";
import { makeSubagentChildThread } from "../orchestration-v2/SubagentProjection.ts";
import {
  authorizeDispatch,
  confirmProviderTermination,
  countOccupied,
  revalidateOutboxEffect,
} from "./Base3PolicyGate.ts";
import { PolicyExecutionContext } from "./executionContext.ts";
import {
  nextTaskContractThread,
  reserveGovernedStart,
  reserveProviderHandoff,
  retainGovernedTask,
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

it("keeps governed threads from becoming ordinary chat", () => {
  const governed = {
    id: "thread-root",
    taskGovernance: "required",
    taskContract: contract,
    taskContractPhase: "active",
    taskAcceptedRevision: null,
    lineage: { rootThreadId: "thread-root" },
  };
  const demoted = retainGovernedTask(governed, {
    ...governed,
    taskGovernance: "chat",
    taskContract: null,
  });
  expect(demoted.taskGovernance).toBe("required");
  expect(demoted.taskContract).toEqual(contract);
  const revised = retainGovernedTask(governed, {
    ...governed,
    taskGovernance: "required" as const,
    taskContract: { ...contract, revision: 2 },
  });
  expect(revised.taskContract.revision).toBe(2);
  const now = DateTime.makeUnsafe(Date.parse("2026-10-10T00:00:00.000Z"));
  const parent = Schema.decodeUnknownOption(OrchestrationV2AppThread)({
    createdBy: "user",
    creationSource: "web",
    id: "thread-root",
    projectId: "project-1",
    title: "Parent",
    providerInstanceId: "codex-work",
    modelSelection: { instanceId: "codex-work", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "thread-root" },
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
  expect(parent._tag).toBe("Some");
  if (parent._tag === "None") return;
  const child = makeSubagentChildThread({
    parentThread: parent.value,
    childThreadId: ThreadId.make("thread-child"),
    parentNodeId: "node-child" as never,
    activeProviderThreadId: null,
    providerInstanceId: ProviderInstanceId.make("codex-work"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex-work"), model: "gpt-5.4" },
    title: "Child",
    now,
    createdBy: "user",
    creationSource: "web",
  });
  expect(child.taskGovernance).toBe("required");
  expect(child.taskContract?.revision).toBe(1);
  expect(child.lineage.rootThreadId).toBe("thread-root");
  expect(taskStateFromUnknown(child.id, { ...child, taskGovernance: undefined }).governance).toBe(
    "chat",
  );
  expect(
    taskStateFromUnknown(child.id, retainGovernedTask(child, { id: child.id })).governance,
  ).toBe("required");
});

it.effect(
  "accept and redirect block later starts, and resume keeps the same revision and budget",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const limited = { ...contract, brake: { ...contract.brake, maxProviderStarts: 2 } };
      yield* insertThread(
        sql,
        "thread-human",
        payloadFor("thread-human", { taskContract: limited }),
      );
      yield* dispatchMessage("thread-human", "human-1", "message-human");
      yield* confirmProviderTermination({
        threadId: "thread-human",
        messageId: "message-human",
      });
      yield* sql`
        UPDATE orchestration_v2_projection_threads
        SET payload_json = ${payloadFor("thread-human", {
          taskContract: limited,
          taskAcceptedRevision: 1,
        })}
        WHERE thread_id = 'thread-human'
      `;
      const accepted = yield* Effect.flip(
        dispatchMessage("thread-human", "human-2", "message-human-2"),
      );
      expect(accepted.reason).toBe("task-contract");
      expect(accepted.message).toContain("already accepted");
      yield* sql`
        UPDATE orchestration_v2_projection_threads
        SET payload_json = ${payloadFor("thread-human", {
          taskContract: limited,
          taskContractPhase: "redirected",
          taskAcceptedRevision: null,
        })}
        WHERE thread_id = 'thread-human'
      `;
      const redirected = yield* Effect.flip(
        dispatchMessage("thread-human", "human-3", "message-human-3"),
      );
      expect(redirected.message).toContain("thread.task-contract.resume");
      const resumed = nextTaskContractThread({
        thread: {
          ...(yield* Effect.sync(() => {
            const decoded = Schema.decodeUnknownOption(OrchestrationV2AppThread)({
              createdBy: "user",
              creationSource: "web",
              id: "thread-human",
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
                rootThreadId: "thread-human",
              },
              forkedFrom: null,
              createdAt: DateTime.makeUnsafe(Date.parse("2026-10-10T00:00:00.000Z")),
              updatedAt: DateTime.makeUnsafe(Date.parse("2026-10-10T00:00:00.000Z")),
              archivedAt: null,
              deletedAt: null,
              taskGovernance: "required",
              taskContract: limited,
              taskContractPhase: "redirected",
              taskAcceptedRevision: null,
            });
            if (decoded._tag === "None") throw new Error("thread did not decode");
            return decoded.value;
          })),
        },
        actorId: "user-1",
        now: yield* DateTime.now,
        command: { type: "thread.task-contract.resume", revision: 1 },
      });
      expect("thread" in resumed).toBe(true);
      if (!("thread" in resumed)) return;
      expect(resumed.thread.taskContract?.revision).toBe(1);
      expect(resumed.thread.taskContractPhase).toBe("active");
      yield* sql`
        UPDATE orchestration_v2_projection_threads
        SET payload_json = ${payloadFor("thread-human", {
          taskContract: limited,
          taskContractPhase: "active",
          taskAcceptedRevision: null,
        })}
        WHERE thread_id = 'thread-human'
      `;
      yield* dispatchMessage("thread-human", "human-4", "message-human-4");
      expect(yield* countTable(sql, "admissions")).toBe(2);
      const exhausted = yield* Effect.flip(
        dispatchMessage("thread-human", "human-5", "message-human-5"),
      );
      expect(exhausted.message).toContain("Brake exhausted");
    }).pipe(Effect.provide(gateLayer)),
);

it.effect("a contract edit keeps prior reservations and stale queued starts fail closed", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* insertThread(
      sql,
      "thread-budget",
      payloadFor("thread-budget", {
        taskContract: { ...contract, brake: { ...contract.brake, maxProviderStarts: 1 } },
      }),
    );
    yield* dispatchMessage("thread-budget", "budget-1", "message-budget");
    yield* confirmProviderTermination({
      threadId: "thread-budget",
      messageId: "message-budget",
    });
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs (
        run_id, thread_id, ordinal, provider, status, requested_at, payload_json
      ) VALUES (
        'run-budget', 'thread-budget', 1, 'codex', 'running', '2026-10-10T00:00:00.000Z',
        '{"userMessageId":"message-budget"}'
      )
    `;
    const context = Effect.provideService(PolicyExecutionContext, session);
    yield* revalidateOutboxEffect({
      threadId: "thread-budget",
      commandId: "budget-1",
      attemptCount: 1,
      request: { type: "provider-turn.start", runId: "run-budget", messageId: "message-budget" },
    }).pipe(context);
    expect(yield* countTable(sql, "admissions")).toBe(1);
    const retry = yield* Effect.flip(
      revalidateOutboxEffect({
        threadId: "thread-budget",
        commandId: "budget-1",
        attemptCount: 2,
        request: { type: "provider-turn.start", runId: "run-budget", messageId: "message-budget" },
      }).pipe(context),
    );
    expect(retry.reason).toBe("task-contract");
    expect(retry.message).toContain("retry or failover");
    const failover = yield* Effect.flip(
      reserveProviderHandoff({
        sql,
        state: {
          governance: "required",
          contract: { ...contract, brake: { ...contract.brake, maxProviderStarts: 1 } },
          phase: "active",
          acceptedRevision: null,
          rootThreadId: "thread-budget",
        },
        commandId: "budget-restart",
        threadId: "thread-budget",
        messageId: "message-budget",
        effectType: "provider-turn.restart",
        attemptCount: 1,
      }),
    );
    expect(failover.message).toContain("retry or failover");
    yield* sql`
      UPDATE orchestration_v2_projection_threads
      SET payload_json = ${payloadFor("thread-budget", {
        taskContract: {
          ...contract,
          revision: 2,
          brake: { ...contract.brake, maxProviderStarts: 4 },
        },
      })}
      WHERE thread_id = 'thread-budget'
    `;
    expect(yield* countTable(sql, "admissions")).toBe(1);
    const queued = yield* Effect.flip(
      revalidateOutboxEffect({
        threadId: "thread-budget",
        commandId: "budget-1",
        attemptCount: 1,
        request: { type: "provider-turn.start", runId: "run-budget", messageId: "message-budget" },
      }).pipe(context),
    );
    expect(queued.reason).toBe("task-contract");
    expect(queued.message).toContain("revision 1");
    yield* revokeTaskContractGrants(sql, "thread-budget");
    const revoked = yield* Effect.flip(
      revalidateOutboxEffect({
        threadId: "thread-budget",
        commandId: "budget-1",
        attemptCount: 1,
        request: { type: "provider-turn.start", runId: "run-budget", messageId: "message-budget" },
      }).pipe(context),
    );
    expect(revoked.reason).toBe("grant-missing");
    yield* dispatchMessage("thread-budget", "budget-2", "message-budget-2");
    expect(yield* countTable(sql, "admissions")).toBe(2);
  }).pipe(Effect.provide(gateLayer)),
);

it.effect("brake exhaustion delivers a provider interrupt and keeps the lease", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* insertThread(
      sql,
      "thread-cancel",
      payloadFor("thread-cancel", {
        taskContract: { ...contract, brake: { ...contract.brake, maxProviderStarts: 1 } },
      }),
    );
    yield* sql`
      INSERT INTO orchestration_v2_projection_provider_threads (
        provider_thread_id, thread_id, provider, driver, provider_instance_id,
        provider_session_id, status, updated_at, payload_json
      ) VALUES (
        'pthread-cancel', 'thread-cancel', 'codex', 'codex', 'codex-work',
        'session-cancel', 'running', '2026-10-10T00:00:00.000Z', '{}'
      )
    `;
    yield* sql`
      INSERT INTO orchestration_v2_projection_provider_turns (
        provider_turn_id, thread_id, provider_thread_id, node_id, ordinal, status, payload_json
      ) VALUES (
        'pturn-cancel', 'thread-cancel', 'pthread-cancel', 'node-cancel', 1, 'running', '{}'
      )
    `;
    yield* dispatchMessage("thread-cancel", "cancel-1", "message-cancel");
    const denied = yield* Effect.flip(
      dispatchMessage("thread-cancel", "cancel-2", "message-cancel-2"),
    );
    expect(denied.message).toContain("asked to cancel");
    const effects = yield* sql<{
      readonly effect_type: string;
      readonly payload_json: string;
      readonly thread_id: string;
    }>`
      SELECT effect_type, payload_json, thread_id
      FROM orchestration_v2_effect_outbox
      WHERE effect_id = 'effect:task-contract-cancel:pturn-cancel'
    `;
    expect(effects[0]?.effect_type).toBe("provider-turn.interrupt");
    const request = JSON.parse(effects[0]?.payload_json ?? "{}") as {
      type?: string;
      providerSessionId?: string;
      providerThreadId?: string;
      providerTurnId?: string;
    };
    expect(request.type).toBe("provider-turn.interrupt");
    const interrupted = yield* Ref.make<string | null>(null);
    const now = DateTime.formatIso(yield* DateTime.now);
    const executorLayer = EffectWorker.executorLayer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(
            ProviderTurnControlService.ProviderTurnControlServiceV2,
            ProviderTurnControlService.ProviderTurnControlServiceV2.of({
              interrupt: (input) =>
                Ref.set(interrupted, `${input.providerSessionId}:${input.providerTurnId}`),
              steer: () => Effect.void,
              interruptAndAwaitTerminal: () => Effect.void,
            }),
          ),
          Layer.succeed(
            ProviderSessionManager.ProviderSessionManagerV2,
            ProviderSessionManager.ProviderSessionManagerV2.of({
              shutdown: Effect.void,
              open: () => Effect.die("unused"),
              get: () => Effect.succeed(Option.none()),
              close: () => Effect.void,
              closeInstance: () => Effect.void,
              release: () => Effect.void,
              detach: () => Effect.void,
            }),
          ),
          Layer.succeed(
            ProviderTurnStartService.ProviderTurnStartServiceV2,
            ProviderTurnStartService.ProviderTurnStartServiceV2.of({
              start: () => Effect.void,
            }),
          ),
          Layer.succeed(
            RunFinalizationService.RunFinalizationService,
            RunFinalizationService.RunFinalizationService.of({ finalize: () => Effect.void }),
          ),
          Layer.succeed(
            CheckpointRollbackService.CheckpointRollbackServiceV2,
            CheckpointRollbackService.CheckpointRollbackServiceV2.of({
              execute: () => Effect.void,
            }),
          ),
          Layer.succeed(
            RuntimeRequestService.RuntimeRequestServiceV2,
            RuntimeRequestService.RuntimeRequestServiceV2.of({ respond: () => Effect.void }),
          ),
          Layer.succeed(
            ThreadTitleRegenerationService.ThreadTitleRegenerationService,
            ThreadTitleRegenerationService.ThreadTitleRegenerationService.of({
              execute: () => Effect.void,
            }),
          ),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            dispatch: () => Effect.succeed({ sequence: 1, storedEvents: [] }),
          }),
          ServerSettings.layerTest(),
        ),
      ),
    );
    const executor = yield* EffectWorker.OrchestrationEffectExecutorV2.pipe(
      Effect.provide(executorLayer),
    );
    yield* executor
      .execute({
        id: "effect:task-contract-cancel:pturn-cancel",
        commandId: CommandId.make("task-contract-cancel:pturn-cancel"),
        threadId: ThreadId.make("thread-cancel"),
        request: {
          type: "provider-turn.interrupt",
          providerSessionId: ProviderSessionId.make(request.providerSessionId ?? ""),
          providerThreadId: ProviderThreadId.make(request.providerThreadId ?? ""),
          providerTurnId: ProviderTurnId.make(request.providerTurnId ?? ""),
        },
        status: "running",
        attemptCount: 1,
        availableAt: now,
        leaseOwner: "worker",
        leaseExpiresAt: now,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
        lastError: null,
      })
      .pipe(
        Effect.provide(executorLayer),
        Effect.provideService(PolicyExecutionContext, {
          kind: "kernel-test",
          actorId: "kernel-test",
          scopes: [AuthOrchestrationOperateScope],
        }),
      );
    expect(yield* Ref.get(interrupted)).toBe("session-cancel:pturn-cancel");
    expect(
      yield* countOccupied({
        sql,
        environmentId: EnvironmentId.make("local"),
        threadId: "thread-cancel",
      }),
    ).toBe(1);
    yield* confirmProviderTermination({ threadId: "thread-cancel", messageId: "message-cancel" });
    expect(
      yield* countOccupied({
        sql,
        environmentId: EnvironmentId.make("local"),
        threadId: "thread-cancel",
      }),
    ).toBe(0);
  }).pipe(Effect.provide(gateLayer)),
);
