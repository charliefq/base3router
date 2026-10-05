// Disposable synthetic databases live under the OS temp directory.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import {
  ActionApprovalId,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ActionGateService, layer as actionGateLayer } from "../actionGate/ActionGateService.ts";
import {
  SqlitePersistenceMemory,
  makeSqlitePersistenceLive,
} from "../persistence/Layers/Sqlite.ts";
import { backupAndCheck, importBase3Policy } from "../persistence/Base3SchemaImport.ts";
import { initializeV2Database } from "../persistence/initializeV2Database.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import {
  authorizeDispatch,
  confirmProviderTermination,
  countOccupied,
  noteInterrupt,
  noteUnconfirmedDisconnect,
} from "./Base3PolicyGate.ts";
import { PolicyExecutionContext } from "./executionContext.ts";

const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex-work"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-05T00:00:00.000Z",
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

const message = {
  type: "message.dispatch",
  commandId: "command-1",
  threadId: "thread-1",
  messageId: "message-1",
  text: "Ship the migration.",
  ...(provider.models[0] === undefined
    ? {}
    : { modelSelection: { instanceId: provider.instanceId, model: provider.models[0].slug } }),
  routingMode: "manual" as const,
  attachments: [],
  dispatchMode: { type: "start_immediately" },
};

it.effect("fresh V2 initialization creates the Base3 policy ledger", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly migration_id: string }>`
      SELECT migration_id FROM base3_policy_migrations ORDER BY migration_id
    `;
    expect(rows.map((row) => row.migration_id)).toContain("b3-066");
    expect(rows.some((row) => row.migration_id === "054")).toBe(false);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("authenticated execution is denied without operate scope and absent context", () =>
  Effect.gen(function* () {
    const absent = yield* Effect.flip(
      authorizeDispatch(message).pipe(
        Effect.provideService(PolicyExecutionContext, { kind: "absent" }),
      ),
    );
    expect(absent.reason).toBe("unauthenticated");
    const denied = yield* Effect.flip(
      authorizeDispatch(message).pipe(Effect.provideService(PolicyExecutionContext, readOnly)),
    );
    expect(denied.reason).toBe("missing-operate-scope");
    const sql = yield* SqlClient.SqlClient;
    const attempts = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM base3_execution_attempts
    `;
    expect(attempts[0]?.count).toBe(0);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("manual dispatch binds a route and admits one foreground lease", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* authorizeDispatch(message).pipe(Effect.provideService(PolicyExecutionContext, session));
    const routes = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM projection_dispatcher_task_routes
    `;
    expect(routes[0]?.count).toBe(1);
    const occupied = yield* countOccupied({
      sql,
      environmentId: EnvironmentId.make("local"),
      threadId: "thread-1",
    });
    expect(occupied).toBe(1);
    yield* noteInterrupt({ threadId: "thread-1", runId: "run-1" });
    const flags = yield* sql<{ readonly interrupt_requested: number }>`
      SELECT interrupt_requested FROM base3_capacity_leases WHERE thread_id = 'thread-1'
    `;
    expect(flags[0]?.interrupt_requested).toBe(1);
    expect(
      yield* countOccupied({
        sql,
        environmentId: EnvironmentId.make("local"),
        threadId: "thread-1",
      }),
    ).toBe(1);
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs (
        run_id, thread_id, ordinal, provider, status, requested_at, payload_json
      ) VALUES ('run-1', 'thread-1', 1, 'codex', 'running', '2026-10-05T00:00:00.000Z', '{}')
    `;
    yield* sql`UPDATE base3_capacity_leases SET run_id = 'run-1' WHERE thread_id = 'thread-1'`;
    expect(
      yield* countOccupied({
        sql,
        environmentId: EnvironmentId.make("local"),
        threadId: "thread-1",
      }),
    ).toBe(1);
    yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'completed' WHERE run_id = 'run-1'`;
    expect(
      yield* countOccupied({
        sql,
        environmentId: EnvironmentId.make("local"),
        threadId: "thread-1",
      }),
    ).toBe(1);
    yield* confirmProviderTermination({ threadId: "thread-1", runId: "run-1" });
    expect(
      yield* countOccupied({
        sql,
        environmentId: EnvironmentId.make("local"),
        threadId: "thread-1",
      }),
    ).toBe(0);
    yield* confirmProviderTermination({ threadId: "thread-1", runId: "run-1" });
    expect(
      yield* countOccupied({
        sql,
        environmentId: EnvironmentId.make("local"),
        threadId: "thread-1",
      }),
    ).toBe(0);
  }).pipe(Effect.provide(Layer.mergeAll(SqlitePersistenceMemory, providerLayer))),
);

it.effect("an unconfirmed disconnect keeps the lease occupied", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* authorizeDispatch({ ...message, commandId: "command-2", messageId: "message-2" }).pipe(
      Effect.provideService(PolicyExecutionContext, session),
    );
    yield* noteUnconfirmedDisconnect({ threadId: "thread-1" });
    const rows = yield* sql<{ readonly disconnect_unconfirmed: number }>`
      SELECT disconnect_unconfirmed FROM base3_capacity_leases WHERE message_id = 'message-2'
    `;
    expect(rows[0]?.disconnect_unconfirmed).toBe(1);
    expect(
      yield* countOccupied({
        sql,
        environmentId: EnvironmentId.make("local"),
        threadId: "thread-1",
      }),
    ).toBe(1);
  }).pipe(Effect.provide(Layer.mergeAll(SqlitePersistenceMemory, providerLayer))),
);

it.effect("delegation without a grant executes zero times", () =>
  Effect.gen(function* () {
    const denied = yield* Effect.flip(
      authorizeDispatch({
        type: "delegated_task.request",
        commandId: "delegate-1",
        parentThreadId: "thread-1",
        task: "Investigate the failure.",
      }).pipe(Effect.provideService(PolicyExecutionContext, session)),
    );
    expect(
      denied.reason === "action-gate-unavailable" || denied.reason === "approval-required",
    ).toBe(true);
    const sql = yield* SqlClient.SqlClient;
    const attempts = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM base3_execution_attempts WHERE operation = 'delegation'
    `;
    expect(attempts[0]?.count).toBe(0);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

const gateLayer = actionGateLayer.pipe(Layer.provideMerge(SqlitePersistenceMemory));

it.effect("ASK grant executes once and deny, cancel, and expiry execute zero times", () =>
  Effect.gen(function* () {
    const gate = yield* ActionGateService;
    const sql = yield* SqlClient.SqlClient;
    const ask = {
      type: "delegated_task.request",
      commandId: "delegate-ask",
      parentThreadId: "thread-ask",
      task: "inspect the lease",
    };
    const pending = yield* Effect.flip(
      authorizeDispatch(ask).pipe(Effect.provideService(PolicyExecutionContext, session)),
    );
    expect(pending.reason).toBe("approval-required");
    const count = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM base3_execution_attempts WHERE thread_id = 'thread-ask'
    `;
    expect(count[0]?.count).toBe(0);
    const rows = yield* sql<{ readonly approval_id: string }>`
      SELECT approval_id FROM action_gate_approvals
    `;
    const approvalId = ActionApprovalId.make(rows[0]?.approval_id ?? "missing");
    const now = yield* Effect.map(DateTime.now, DateTime.formatIso);
    yield* gate.respond({ approvalId, decision: "grant" }, now);
    yield* authorizeDispatch(ask).pipe(Effect.provideService(PolicyExecutionContext, session));
    const granted = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM base3_execution_attempts WHERE thread_id = 'thread-ask'
    `;
    expect(granted[0]?.count).toBe(1);
    const replay = yield* Effect.flip(
      authorizeDispatch({ ...ask, commandId: "delegate-ask-replay" }).pipe(
        Effect.provideService(PolicyExecutionContext, session),
      ),
    );
    expect(["approval-required", "action-denied", "action-gate"]).toContain(replay.reason);
    const deniedAsk = { ...ask, commandId: "delegate-deny", task: "deny this" };
    yield* Effect.flip(
      authorizeDispatch(deniedAsk).pipe(Effect.provideService(PolicyExecutionContext, session)),
    );
    const deniedRow = yield* sql<{ readonly approval_id: string }>`
      SELECT approval_id FROM action_gate_approvals WHERE status = 'pending' ORDER BY created_at DESC LIMIT 1
    `;
    yield* gate.respond(
      {
        approvalId: ActionApprovalId.make(deniedRow[0]?.approval_id ?? "missing"),
        decision: "deny",
      },
      now,
    );
    const denied = yield* Effect.flip(
      authorizeDispatch(deniedAsk).pipe(Effect.provideService(PolicyExecutionContext, session)),
    );
    expect(["approval-required", "action-denied", "action-gate"]).toContain(denied.reason);
    const cancelledAsk = { ...ask, commandId: "delegate-cancel", task: "cancel this" };
    yield* Effect.flip(
      authorizeDispatch(cancelledAsk).pipe(Effect.provideService(PolicyExecutionContext, session)),
    );
    const cancelledRow = yield* sql<{ readonly approval_id: string }>`
      SELECT approval_id FROM action_gate_approvals WHERE status = 'pending' ORDER BY created_at DESC LIMIT 1
    `;
    yield* gate.respond(
      {
        approvalId: ActionApprovalId.make(cancelledRow[0]?.approval_id ?? "missing"),
        decision: "cancel",
      },
      now,
    );
    const cancelled = yield* Effect.flip(
      authorizeDispatch(cancelledAsk).pipe(Effect.provideService(PolicyExecutionContext, session)),
    );
    expect(["approval-required", "action-denied", "action-gate"]).toContain(cancelled.reason);
    const expiredAsk = { ...ask, commandId: "delegate-expire", task: "expire this" };
    yield* Effect.flip(
      authorizeDispatch(expiredAsk).pipe(Effect.provideService(PolicyExecutionContext, session)),
    );
    const expiredRow = yield* sql<{ readonly approval_id: string }>`
      SELECT approval_id FROM action_gate_approvals WHERE status = 'pending' ORDER BY created_at DESC LIMIT 1
    `;
    const expiredApproval = yield* gate.getApproval(
      ActionApprovalId.make(expiredRow[0]?.approval_id ?? "missing"),
    );
    const expiredConsume = yield* gate
      .consume(
        ActionApprovalId.make(expiredRow[0]?.approval_id ?? "missing"),
        expiredApproval.pipe(
          Option.match({
            onNone: () => {
              throw new Error("missing expiry approval");
            },
            onSome: (record) => record.fingerprint,
          }),
        ),
        "2099-01-01T00:00:00.000Z",
      )
      .pipe(Effect.exit);
    expect(expiredConsume._tag).toBe("Failure");
    const expired = yield* Effect.flip(
      authorizeDispatch(expiredAsk).pipe(Effect.provideService(PolicyExecutionContext, session)),
    );
    expect(["approval-required", "action-denied", "action-gate"]).toContain(expired.reason);
    const attempts = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM base3_execution_attempts WHERE thread_id = 'thread-ask'
    `;
    expect(attempts[0]?.count).toBe(1);
  }).pipe(Effect.provide(Layer.mergeAll(gateLayer, providerLayer))),
);

it.effect("a second foreground turn waits for capacity and a queued edit is revalidated", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* authorizeDispatch(message).pipe(Effect.provideService(PolicyExecutionContext, session));
    const blocked = yield* Effect.flip(
      authorizeDispatch({
        ...message,
        commandId: "command-capacity",
        messageId: "message-capacity",
      }).pipe(Effect.provideService(PolicyExecutionContext, session)),
    );
    expect(blocked.reason).toBe("capacity");
    expect(
      yield* countOccupied({
        sql,
        environmentId: EnvironmentId.make("local"),
        threadId: "thread-1",
      }),
    ).toBe(1);
    const edited = yield* Effect.flip(
      authorizeDispatch({
        type: "queued-run.edit",
        commandId: "edit-1",
        threadId: "thread-1",
        messageId: "message-1",
        text: "changed after the queue delay",
      }).pipe(Effect.provideService(PolicyExecutionContext, session)),
    );
    expect(edited.reason).toBe("argument-mismatch");
  }).pipe(Effect.provide(Layer.mergeAll(SqlitePersistenceMemory, providerLayer))),
);

it.effect("provider.switch is denied for an authenticated session", () =>
  Effect.gen(function* () {
    const denied = yield* Effect.flip(
      authorizeDispatch({
        type: "provider.switch",
        commandId: "switch-1",
        threadId: "thread-1",
      }).pipe(Effect.provideService(PolicyExecutionContext, session)),
    );
    expect(denied.reason).toBe("provider-switch-requires-explicit-handoff");
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("imports a representative schema 065 database without granting approvals", () =>
  Effect.gen(function* () {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "base3-import-"));
    const sourcePath = NodePath.join(directory, "source.sqlite");
    const destinationPath = NodePath.join(directory, "statev2.sqlite");
    const backupPath = NodePath.join(directory, "backup.sqlite");
    const source = new NodeSqlite.DatabaseSync(sourcePath);
    source.exec(`
      CREATE TABLE action_gate_approvals (
        approval_id TEXT PRIMARY KEY, environment_id TEXT, fingerprint TEXT, status TEXT,
        idempotency_key TEXT, created_at TEXT, expires_at TEXT, consumed_at TEXT, payload_json TEXT
      );
      CREATE TABLE dream_memories (
        memory_id TEXT PRIMARY KEY, environment_id TEXT, actor_id TEXT, project_id TEXT,
        thread_id TEXT, scope_kind TEXT, status TEXT, source_fingerprint TEXT,
        content_present INTEGER, payload_json TEXT, created_at TEXT, updated_at TEXT
      );
      CREATE TABLE dream_deleted_sources (
        source_fingerprint TEXT PRIMARY KEY, environment_id TEXT, deleted_at TEXT
      );
      CREATE TABLE cursor_cloud_operations (
        command_id TEXT PRIMARY KEY, state TEXT
      );
      INSERT INTO action_gate_approvals VALUES
        ('pending-1','env','fp-1','pending',NULL,'2026-10-05T00:00:00.000Z','2026-10-06T00:00:00.000Z',NULL,'{}'),
        ('consumed-1','env','fp-2','consumed',NULL,'2026-10-05T00:00:00.000Z','2026-10-06T00:00:00.000Z','2026-10-05T01:00:00.000Z','{}');
      INSERT INTO dream_memories VALUES
        ('memory-1','env','actor',NULL,NULL,'thread','deleted','src-1',0,'{}','2026-10-05T00:00:00.000Z','2026-10-05T00:00:00.000Z');
      INSERT INTO dream_deleted_sources VALUES ('src-1','env','2026-10-05T00:00:00.000Z');
      INSERT INTO cursor_cloud_operations VALUES ('cloud-1','ambiguous');
    `);
    source.close();
    const databaseLayer = makeSqlitePersistenceLive(destinationPath).pipe(
      Layer.provide(NodeServices.layer),
    );
    const first = yield* importBase3Policy({ sourcePath, destinationPath }).pipe(
      Effect.provide(databaseLayer),
    );
    expect(first.copied).toBeGreaterThan(0);
    expect(first.held).toBe(1);
    const destination = new NodeSqlite.DatabaseSync(destinationPath, { readOnly: true });
    const statuses = destination
      .prepare(`SELECT status FROM action_gate_approvals ORDER BY approval_id`)
      .all() as { status: string }[];
    expect(statuses.map((row) => row.status)).toEqual(["consumed", "pending"]);
    const memory = destination.prepare(`SELECT status FROM dream_memories`).get() as {
      status: string;
    };
    expect(memory.status).toBe("deleted");
    const tombstone = destination
      .prepare(`SELECT COUNT(*) AS count FROM dream_deleted_sources`)
      .get() as {
      count: number;
    };
    expect(tombstone.count).toBe(1);
    const cloud = destination
      .prepare(`SELECT COUNT(*) AS count FROM cursor_cloud_operations`)
      .get() as {
      count: number;
    };
    expect(cloud.count).toBe(0);
    destination.close();
    const marker = new NodeSqlite.DatabaseSync(destinationPath);
    marker
      .prepare(
        `UPDATE base3_import_batches SET status = 'running', finished_at = NULL WHERE batch_id = ?`,
      )
      .run(first.batchId);
    marker.close();
    const retried = yield* importBase3Policy({ sourcePath, destinationPath }).pipe(
      Effect.provide(Layer.mergeAll(databaseLayer, NodeServices.layer)),
    );
    expect(retried.resumed).toBe(true);
    const after = new NodeSqlite.DatabaseSync(destinationPath, { readOnly: true });
    const approvalCount = after
      .prepare(`SELECT COUNT(*) AS count FROM action_gate_approvals`)
      .get() as {
      count: number;
    };
    expect(approvalCount.count).toBe(2);
    after.close();
    yield* backupAndCheck({ sourcePath: destinationPath, backupPath });
  }),
);

it.effect("does not copy a Base3 policy database into a fresh V2 file", () =>
  Effect.gen(function* () {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "base3-skip-"));
    const sourcePath = NodePath.join(directory, "state.sqlite");
    const destinationPath = NodePath.join(directory, "statev2.sqlite");
    const source = new NodeSqlite.DatabaseSync(sourcePath);
    source.exec(`CREATE TABLE dream_memories (memory_id TEXT PRIMARY KEY);`);
    source.close();
    yield* initializeV2Database(destinationPath);
    expect(NodeFS.existsSync(destinationPath)).toBe(false);
  }).pipe(Effect.provide(NodeServices.layer)),
);
